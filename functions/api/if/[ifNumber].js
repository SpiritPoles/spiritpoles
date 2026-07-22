// functions/api/if/[ifNumber].js
// Cloudflare Pages Function — fetches Item Fulfillment data from NetSuite via TBA OAuth 1.0a
// Accepts: IF number (IF4160, 4160) OR Sales Order number (SO33870)
// OAuth + SuiteQL implementation is an exact copy of /api/so/[soNumber].js (which is confirmed working)

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// ── OAuth 1.0a helpers — verbatim copy from [soNumber].js ─────────────────────

function pct(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

async function oauthHeader(method, baseUrl, env, extraParams = {}) {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, '');

  // Merge oauth_ params with any request query params — all get sorted together
  const p = {
    ...extraParams,
    oauth_consumer_key:     env.NS_CONSUMER_KEY,
    oauth_nonce:            nonce,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp:        ts,
    oauth_token:            env.NS_TOKEN_ID,
    oauth_version:          '1.0',
  };

  const normalized = Object.entries(p)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${pct(k)}=${pct(v)}`)
    .join('&');

  const base   = `${method.toUpperCase()}&${pct(baseUrl)}&${pct(normalized)}`;
  const sigKey = `${pct(env.NS_CONSUMER_SECRET)}&${pct(env.NS_TOKEN_SECRET)}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(sigKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const raw = await crypto.subtle.sign('HMAC', key, enc.encode(base));
  const sig = btoa(String.fromCharCode(...new Uint8Array(raw)));

  return [
    `OAuth realm="${env.NS_ACCOUNT_ID}"`,
    `oauth_consumer_key="${env.NS_CONSUMER_KEY}"`,
    `oauth_token="${env.NS_TOKEN_ID}"`,
    `oauth_signature_method="HMAC-SHA256"`,
    `oauth_timestamp="${ts}"`,
    `oauth_nonce="${nonce}"`,
    `oauth_version="1.0"`,
    `oauth_signature="${sig}"`,
  ].join(', ');
}

// ── SuiteQL helper — verbatim copy from [soNumber].js ─────────────────────────

async function suiteQL(q, env, retries = 3) {
  const url = `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const auth = await oauthHeader('POST', url, env);
    const resp = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': auth,
        'Content-Type':  'application/json',
        'prefer':        'transient',
      },
      body: JSON.stringify({ q }),
    });

    if (resp.ok) return resp.json();

    const txt = await resp.text();
    if (resp.status === 401 && attempt < retries) {
      const wait = 600 * (attempt + 1);
      console.warn(`NS 401 on attempt ${attempt + 1} — retrying in ${wait}ms`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }
    throw new Error(`NS ${resp.status}: ${txt.substring(0, 600)}`);
  }
}

// ── REST Record API GET helper — verbatim copy from [soNumber].js ─────────────
// Query-string params are included in the OAuth signature base string.

async function nsGet(fullUrl, env, retries = 2) {
  const qIdx    = fullUrl.indexOf('?');
  const baseUrl = qIdx >= 0 ? fullUrl.slice(0, qIdx) : fullUrl;
  const qs      = qIdx >= 0 ? fullUrl.slice(qIdx + 1) : '';

  const queryParams = {};
  if (qs) {
    for (const pair of qs.split('&')) {
      const eq = pair.indexOf('=');
      const k  = eq >= 0 ? decodeURIComponent(pair.slice(0, eq)) : decodeURIComponent(pair);
      const v  = eq >= 0 ? decodeURIComponent(pair.slice(eq + 1)) : '';
      if (k) queryParams[k] = v;
    }
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    const auth = await oauthHeader('GET', baseUrl, env, queryParams);
    const resp = await fetch(fullUrl, {
      method:  'GET',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    });

    if (resp.ok) return resp.json();

    const txt = await resp.text();
    if (resp.status === 401 && attempt < retries) {
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      continue;
    }
    throw new Error(`NS REST ${resp.status}: ${txt.substring(0, 400)}`);
  }
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function onRequestGet({ params, env }) {
  const raw   = (params.ifNumber || '').trim();
  const upper = raw.toUpperCase();

  try {
    let tranid;
    let resolvedFromSO = null;
    let multipleIFs    = 0;
    let allIFs         = [];

    // ── Resolve tranid ──────────────────────────────────────────────────────
    if (upper.startsWith('SO')) {
      // Step 1: get the SO internal ID + entity (entity needed to scope IF search in Step 2)
      const soRes = await suiteQL(`
        SELECT id, entity FROM transaction
        WHERE tranid = '${upper}' AND recordtype = 'salesorder'
        FETCH FIRST 1 ROWS ONLY
      `, env);

      const soRow = (soRes.items || [])[0];
      if (!soRow) {
        return new Response(
          JSON.stringify({ error: `Sales Order "${upper}" not found in NetSuite.` }),
          { status: 404, headers: CORS }
        );
      }

      // Step 2: Get recent IFs for this entity.
      // Cannot use createdfrom in SuiteQL at all (self-join 500 in both WHERE and SELECT
      // on broad queries). Get IFs by entity only, then check createdFrom via REST.
      const ifList = await suiteQL(`
        SELECT t.id, t.tranid, t.trandate
        FROM transaction t
        WHERE t.recordtype = 'itemfulfillment'
        AND   t.entity = ${soRow.entity}
        ORDER BY t.trandate DESC
        FETCH FIRST 10 ROWS ONLY
      `, env);

      const candidates = ifList.items || [];
      if (!candidates.length) {
        return new Response(
          JSON.stringify({ error: `No Item Fulfillment found for ${upper} — order may not have shipped yet.` }),
          { status: 404, headers: CORS }
        );
      }

      // Step 3: Sequential REST calls to check createdFrom on each candidate.
      // Sequential (not parallel) to stay under NS concurrency limits (parallel → 429).
      // Sorted newest-first so the match is typically found on the first call.
      const soIdStr  = String(soRow.id);
      const restBase = `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/record/v1/itemfulfillment`;
      const ifRows   = [];

      for (const c of candidates) {
        try {
          // ?fields=createdFrom returns ~100 bytes instead of the full IF record
          const rec = await nsGet(`${restBase}/${c.id}?fields=createdFrom`, env, 1);
          if (String(rec.createdFrom?.id || '') === soIdStr) {
            ifRows.push({ id: c.id, tranid: c.tranid, trandate: c.trandate });
          }
        } catch (_) { /* skip this candidate */ }
      }

      if (!ifRows.length) {
        return new Response(
          JSON.stringify({ error: `No Item Fulfillment found for ${upper} — order may not have shipped yet.` }),
          { status: 404, headers: CORS }
        );
      }

      tranid         = ifRows[0].tranid;
      resolvedFromSO = upper;
      multipleIFs    = ifRows.length;
      allIFs         = ifRows.map(r => ({ tranid: r.tranid, date: r.trandate || '' }));

    } else if (upper.startsWith('IF')) {
      tranid = upper;
    } else {
      // Bare number — assume IF prefix
      tranid = `IF${upper}`;
    }

    // ── 1. Header ───────────────────────────────────────────────────────────
    // Note: createdfrom is deliberately excluded — ANY reference to createdfrom in
    // SuiteQL on the transaction table (WHERE or SELECT) triggers NS UNEXPECTED_ERROR.
    const hdr = await suiteQL(`
      SELECT
        t.id,
        t.tranid,
        t.trandate,
        c.companyname,
        t.shipaddress,
        t.shipemail
      FROM transaction t
      LEFT JOIN customer c ON c.id = t.entity
      WHERE t.recordtype = 'itemfulfillment'
      AND   t.tranid = '${tranid}'
      FETCH FIRST 1 ROWS ONLY
    `, env);

    const rows = hdr.items || [];
    if (!rows.length) {
      return new Response(
        JSON.stringify({ error: `Item Fulfillment "${tranid}" not found in NetSuite.` }),
        { status: 404, headers: CORS }
      );
    }

    const ifRec = rows[0];
    const shipAddr = (ifRec.shipaddress || '')
      .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

    // ── Resolve linked SO number ─────────────────────────────────────────────
    // For SO# entry: already known from resolvedFromSO.
    // For IF# direct entry: get createdFrom.refName via REST Record API.
    // Cannot use SuiteQL at all — createdfrom triggers UNEXPECTED_ERROR everywhere.
    let soNumber = resolvedFromSO || '';
    if (!soNumber) {
      try {
        const ifRestRec = await nsGet(
          `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/record/v1/itemfulfillment/${ifRec.id}?fields=createdFrom`,
          env, 1
        );
        // refName is e.g. "Sales Order #SO33870"
        const refName = ifRestRec.createdFrom?.refName || '';
        soNumber = refName.replace(/^Sales Order #/i, '').trim();
      } catch (_) { /* non-fatal */ }
    }

    // ── 2 & 3. Line items + serial numbers via REST (mirrors Phase 1 SO handler) ──
    // SuiteQL returns internal bin-transfer lines (mixed +/- qty) and can't access
    // serial numbers (inventorynumberitem table is invalid). REST expandSubResources
    // gives clean user-facing item lines with inventoryDetail serials in one call.
    const ifRestUrl = `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/record/v1/itemfulfillment/${ifRec.id}?expandSubResources=true`;
    const ifRest    = await nsGet(ifRestUrl, env);

    const rawItems  = ifRest.item?.items || [];
    const lineItems = [];

    for (const li of rawItems) {
      // On IFs, item.refName is an internal numeric ID ("1773") — not useful.
      // itemName contains the model/flex code ("350/50") that parseFlex/parseModel need.
      const itemCode = li.itemName || '';
      const dispName = typeof li.custcol_ucs_display_name === 'string'
        ? li.custcol_ucs_display_name
        : (li.custcol_ucs_display_name?.refName || li.displayName || itemCode);

      if (!itemCode) continue;

      const qty = Math.abs(Math.round(parseFloat(li.quantity) || 0));
      if (!qty) continue;

      // Serial numbers from inventoryDetail subrecord (issueInventoryNumber = outgoing)
      const invDetail  = li.inventoryDetail  || li.inventorydetail;
      const invAssign  = invDetail?.inventoryAssignment || invDetail?.inventoryassignment;
      const assignments = invAssign?.items || [];
      const serials = assignments
        .map(a => a.issueInventoryNumber?.refName || a.inventorynumber?.refName || '')
        .filter(Boolean);

      lineItems.push({
        item_code: itemCode,
        item_name: dispName || itemCode,
        qty,
        serials,
      });
    }

    return new Response(JSON.stringify({
      if_number:    ifRec.tranid,
      internal_id:  ifRec.id,
      so_number:    soNumber,
      date:         ifRec.trandate,
      customer:     ifRec.companyname || '',
      ship_address: shipAddr,
      ship_email:   (ifRec.shipemail || '').trim(),
      lines:        lineItems,
      multiple_ifs: multipleIFs,
      all_ifs:      allIFs,
    }), { status: 200, headers: CORS });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: CORS }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin':  '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
