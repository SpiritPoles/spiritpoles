// functions/api/so/[soNumber].js
// Cloudflare Pages Function — fetches Sales Order data from NetSuite via TBA OAuth 1.0a

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
};

// ── OAuth 1.0a helpers ─────────────────────────────────────────────────────────

function pct(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

// oauthHeader: signs method + base URL (no query string in URL arg).
// extraParams: any query-string key/value pairs to merge into the OAuth
// normalized-parameters string (required by OAuth 1.0a for GET requests).
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

// ── SuiteQL helper ─────────────────────────────────────────────────────────────

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

// ── REST Record API GET helper ─────────────────────────────────────────────────
// Per OAuth 1.0a spec, query-string params must be included in the signature
// base string alongside the oauth_* params. We split the URL, parse query
// params, pass them to oauthHeader as extraParams, then fetch the full URL.

async function nsGet(fullUrl, env, retries = 2) {
  const qIdx    = fullUrl.indexOf('?');
  const baseUrl = qIdx >= 0 ? fullUrl.slice(0, qIdx) : fullUrl;
  const qs      = qIdx >= 0 ? fullUrl.slice(qIdx + 1) : '';

  // Parse query string into key/value pairs for OAuth signature
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

// ── Parse model number from item code like "SP490/82" or display name ─────────

function parseModelNum(str) {
  const m = String(str || '').match(/(\d{3,})\//);
  return m ? parseInt(m[1]) : null;
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function onRequestGet({ params, env }) {
  const raw    = (params.soNumber || '').trim();
  const tranid = raw.toUpperCase().startsWith('SO') ? raw.toUpperCase() : `SO${raw}`;

  try {
    // 1. Header via SuiteQL — finds SO internal ID, customer, ship address
    // Note: ship address component fields are NOT_EXPOSED in SuiteQL; use t.shipaddress only.
    const hdr = await suiteQL(`
      SELECT
        t.id,
        t.entity,
        t.tranid,
        t.trandate,
        c.companyname,
        t.shipaddress
      FROM transaction t
      LEFT JOIN customer c ON c.id = t.entity
      WHERE t.recordtype = 'salesorder'
      AND   t.tranid = '${tranid}'
      FETCH FIRST 1 ROWS ONLY
    `, env);

    const rows = hdr.items || [];
    if (!rows.length) {
      return new Response(
        JSON.stringify({ error: `Sales Order "${tranid}" not found in NetSuite.` }),
        { status: 404, headers: CORS }
      );
    }

    const so = rows[0];
    const shipAddr = (so.shipaddress || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

    // 1b. Look up linked Item Fulfillment number (non-fatal — IF may not exist yet)
    // NS SuiteQL: createdfrom on transaction table triggers UNEXPECTED_ERROR in both
    // WHERE and SELECT on broad queries. Use entity-scoped list + parallel REST checks.
    let ifNumber = '';
    try {
      const ifList = await suiteQL(
        `SELECT t.id, t.tranid FROM transaction t
         WHERE t.recordtype = 'itemfulfillment' AND t.entity = ${so.entity}
         ORDER BY t.trandate DESC FETCH FIRST 10 ROWS ONLY`,
        env
      );
      const soIdStr  = String(so.id);
      const restBase = `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/record/v1/itemfulfillment`;
      // Sequential (not parallel) — parallel calls hit NS 429 concurrency limit
      for (const c of (ifList.items || [])) {
        try {
          const rec = await nsGet(`${restBase}/${c.id}`, env, 1);
          if (String(rec.createdFrom?.id || '') === soIdStr) { ifNumber = c.tranid; break; }
        } catch (_) { /* skip */ }
      }
    } catch (_) { /* non-fatal */ }

    // 2. REST Record API — gets subtotal + full line items with custom fields & serials
    // expandSubResources=true inlines inventoryDetail subrecords per line.
    const recUrl  = `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/record/v1/salesorder/${so.id}?expandSubResources=true`;
    const rec     = await nsGet(recUrl, env);
    const subtotal = parseFloat(rec.subtotal ?? rec.total ?? 0);

    // Parse individual pole lines from item sublist
    const rawItems = rec.item?.items || rec.item || [];
    const lineItems = [];

    for (const li of rawItems) {
      // item field may be object {id, refName} or a string
      const itemRef  = typeof li.item === 'object' ? (li.item?.refName || '') : String(li.item || '');
      const dispName = typeof li.custcol_ucs_display_name === 'string' ? li.custcol_ucs_display_name : '';

      // Only include actual pole items (model number parseable)
      const model = parseModelNum(itemRef) || parseModelNum(dispName);
      if (!model) continue;

      // CrossFlex flex memo (absent on standard poles)
      const flexMemo = li.custcol_ucs_flex_memo?.refName
        ?? (typeof li.custcol_ucs_flex_memo === 'string' ? li.custcol_ucs_flex_memo : '')
        ?? '';

      // Special instructions (line-item note field)
      const note = typeof li.custcol_nssc_notes === 'string' ? li.custcol_nssc_notes.trim() : '';

      // Serial numbers from inventory detail
      const invDetail  = li.inventoryDetail  || li.inventorydetail;
      const invAssign  = invDetail?.inventoryAssignment || invDetail?.inventoryassignment;
      const assignments = invAssign?.items || [];
      const serials    = assignments
        .map(a => a.issueInventoryNumber?.refName || a.inventorynumber?.refName || '')
        .filter(Boolean);

      // qty on SOs is typically 1 per serialized pole; normalize and expand
      const qty = Math.max(1, Math.abs(Math.round(parseFloat(li.quantity) || 1)));
      const rate = parseFloat(li.rate) || 0;

      for (let i = 0; i < qty; i++) {
        lineItems.push({
          item_code:  itemRef,
          item_name:  dispName || itemRef,
          flex_memo:  flexMemo,
          serial:     serials[i] || '',
          note:       note,
          qty:        1,
          rate:       rate,
        });
      }
    }

    return new Response(JSON.stringify({
      so_number:      so.tranid,
      if_number:      ifNumber,
      internal_id:    so.id,
      date:           so.trandate,
      customer:       so.companyname || '',
      ship_address:   shipAddr,
      declared_value: Math.round(subtotal * 100) / 100,
      lines:          lineItems,
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
