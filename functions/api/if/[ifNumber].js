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

// ── Handler ────────────────────────────────────────────────────────────────────

export async function onRequestGet({ params, env }) {
  const raw   = (params.ifNumber || '').trim();
  const upper = raw.toUpperCase();

  try {
    let tranid;
    let resolvedFromSO = null;
    let multipleIFs    = 0;

    // ── Resolve tranid ──────────────────────────────────────────────────────
    if (upper.startsWith('SO')) {
      // Input is a Sales Order number — find the linked Item Fulfillment(s)
      const ifSearch = await suiteQL(`
        SELECT t.id, t.tranid, t.trandate
        FROM transaction t
        INNER JOIN transaction so ON so.id = t.createdfrom
        WHERE t.recordtype = 'itemfulfillment'
        AND   so.tranid    = '${upper}'
        AND   so.recordtype = 'salesorder'
        ORDER BY t.trandate DESC, t.id DESC
        FETCH FIRST 5 ROWS ONLY
      `, env);

      const ifRows = ifSearch.items || [];
      if (!ifRows.length) {
        return new Response(
          JSON.stringify({ error: `No Item Fulfillment found for ${upper} in NetSuite.` }),
          { status: 404, headers: CORS }
        );
      }

      tranid         = ifRows[0].tranid;
      resolvedFromSO = upper;
      multipleIFs    = ifRows.length;

    } else if (upper.startsWith('IF')) {
      tranid = upper;
    } else {
      // Bare number — assume IF prefix
      tranid = `IF${upper}`;
    }

    // ── 1. Header ───────────────────────────────────────────────────────────
    const hdr = await suiteQL(`
      SELECT
        t.id,
        t.tranid,
        t.trandate,
        c.companyname,
        t.createdfrom,
        t.shipaddress
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
    let soNumber = resolvedFromSO || '';
    if (!soNumber && ifRec.createdfrom) {
      try {
        const soRes = await suiteQL(`
          SELECT tranid FROM transaction WHERE id = ${ifRec.createdfrom} FETCH FIRST 1 ROWS ONLY
        `, env);
        soNumber = ((soRes.items || [])[0] || {}).tranid || '';
      } catch (_) { /* non-fatal */ }
    }

    // ── 2. Line items ────────────────────────────────────────────────────────
    const lines = await suiteQL(`
      SELECT
        tl.id        AS line_id,
        tl.item,
        i.itemid,
        i.displayname,
        tl.quantity
      FROM transactionline tl
      JOIN item i ON i.id = tl.item
      WHERE tl.transaction = ${ifRec.id}
      AND   tl.mainline    = 'F'
      AND   tl.taxline     = 'F'
      AND   tl.item        IS NOT NULL
      ORDER BY tl.linesequencenumber
      FETCH FIRST 200 ROWS ONLY
    `, env);

    // SuiteQL returns IF line quantities as negative — use Math.abs()
    const lineItems = (lines.items || []).map(l => ({
      line_id:   l.line_id,
      item_id:   l.item,
      item_code: l.itemid      || '',
      item_name: l.displayname || l.itemid || '',
      qty:       Math.abs(Math.round(parseFloat(l.quantity) || 0)),
      serials:   [],
    }));

    // ── 3. Serial numbers ────────────────────────────────────────────────────
    try {
      const snRes = await suiteQL(`
        SELECT
          invn.transactionline,
          invn.inventorynumber
        FROM inventorynumberitem invn
        JOIN inventorynumber sn ON sn.id = invn.inventorynumber
        WHERE invn.transaction = ${ifRec.id}
        ORDER BY invn.transactionline, sn.inventorynumber
        FETCH FIRST 500 ROWS ONLY
      `, env);

      const snMap = {};
      for (const r of (snRes.items || [])) {
        const lid = String(r.transactionline);
        if (!snMap[lid]) snMap[lid] = [];
        snMap[lid].push(r.inventorynumber);
      }
      for (const li of lineItems) {
        li.serials = snMap[String(li.line_id)] || [];
      }
    } catch (_) {
      // Serial number query failed — proceed without them
    }

    return new Response(JSON.stringify({
      if_number:    ifRec.tranid,
      internal_id:  ifRec.id,
      so_number:    soNumber,
      date:         ifRec.trandate,
      customer:     ifRec.companyname || '',
      ship_address: shipAddr,
      lines:        lineItems,
      multiple_ifs: multipleIFs,
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
