// functions/api/if/[ifNumber].js
// Cloudflare Pages Function — fetches Item Fulfillment data from NetSuite via TBA OAuth 1.0a

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

async function oauthHeader(method, url, env) {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, '');

  const p = {
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

  const base = `${method.toUpperCase()}&${pct(url)}&${pct(normalized)}`;
  const sigKey = `${pct(env.NS_CONSUMER_SECRET)}&${pct(env.NS_TOKEN_SECRET)}`;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(sigKey),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const raw = await crypto.subtle.sign('HMAC', key, enc.encode(base));
  const sig = btoa(String.fromCharCode(...new Uint8Array(raw)));

  // Authorization header — values are quoted strings, NOT percent-encoded
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

async function suiteQL(q, env) {
  const url  = `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
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

  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`NS ${resp.status}: ${txt.substring(0, 600)}`);
  }
  return resp.json();
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function onRequestGet({ params, env }) {
  const raw    = (params.ifNumber || '').trim();
  // IF numbers in NetSuite are typically like "IF123456" or just numeric
  const tranid = raw.toUpperCase().startsWith('IF') ? raw.toUpperCase() : raw;

  try {
    // 1. Header
    // Note: JOIN entity fails in SuiteQL; use LEFT JOIN customer instead.
    // Note: ship address component fields are NOT_EXPOSED — use only t.shipaddress.
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

    // shipaddress is the pre-formatted multi-line field; strip any HTML tags
    const shipAddr = (ifRec.shipaddress || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

    // Resolve linked SO number from createdfrom (internal ID of parent SO)
    let soNumber = '';
    if (ifRec.createdfrom) {
      try {
        const soRes = await suiteQL(`
          SELECT tranid FROM transaction WHERE id = ${ifRec.createdfrom} FETCH FIRST 1 ROWS ONLY
        `, env);
        soNumber = ((soRes.items || [])[0] || {}).tranid || '';
      } catch (_) { /* non-fatal */ }
    }

    // 2. Line items
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

    // Note: SuiteQL returns IF line quantities as negative — use Math.abs()
    const lineItems = (lines.items || []).map(l => ({
      line_id:   l.line_id,
      item_id:   l.item,
      item_code: l.itemid    || '',
      item_name: l.displayname || l.itemid || '',
      qty:       Math.abs(Math.round(parseFloat(l.quantity) || 0)),
      serials:   [],   // populated below if available
    }));

    // 3. Serial numbers — attempt via inventorynumber join
    //    (If this query fails due to schema differences, we skip gracefully)
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
