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

  // Signature base string — sorted, percent-encoded
  const normalized = Object.entries(p)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${pct(k)}=${pct(v)}`)
    .join('&');

  const base   = `${method.toUpperCase()}&${pct(url)}&${pct(normalized)}`;
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

async function suiteQL(q, env, retries = 2) {
  const url = `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const auth = await oauthHeader('POST', url, env);  // fresh ts + nonce each attempt
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
    // On 401, wait and retry with a fresh signature (clock drift fix)
    if (resp.status === 401 && attempt < retries) {
      await new Promise(r => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }
    throw new Error(`NS ${resp.status}: ${txt.substring(0, 600)}`);
  }
}

// ── Handler ────────────────────────────────────────────────────────────────────

export async function onRequestGet({ params, env }) {
  const raw    = (params.soNumber || '').trim();
  const tranid = raw.toUpperCase().startsWith('SO') ? raw.toUpperCase() : `SO${raw}`;

  try {
    // 1. Header — get transaction record
    // Note: JOIN entity fails in SuiteQL; use LEFT JOIN customer instead.
    // Note: ship address component fields (shipaddr1/2, shipcity, etc.) are NOT_EXPOSED
    //       in SuiteQL search — use only the pre-formatted t.shipaddress field.
    const hdr = await suiteQL(`
      SELECT
        t.id,
        t.tranid,
        t.trandate,
        c.companyname,
        t.total,
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

    // shipaddress is the pre-formatted multi-line field; strip any HTML tags
    const shipAddr = (so.shipaddress || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();

    // 2. Line items
    // Note: SuiteQL returns SO line quantities as negative — use Math.abs().
    // Omit quantity > 0 filter (all item lines have qty < 0 in SuiteQL for SOs).
    const lines = await suiteQL(`
      SELECT
        tl.item,
        i.itemid,
        i.displayname,
        tl.quantity,
        tl.rate
      FROM transactionline tl
      JOIN item i ON i.id = tl.item
      WHERE tl.transaction = ${so.id}
      AND   tl.mainline    = 'F'
      AND   tl.taxline     = 'F'
      AND   tl.item        IS NOT NULL
      ORDER BY tl.linesequencenumber
      FETCH FIRST 200 ROWS ONLY
    `, env);

    const lineItems = (lines.items || []).map(l => ({
      item_id:   l.item,
      item_code: l.itemid   || '',
      item_name: l.displayname || l.itemid || '',
      qty:       Math.abs(Math.round(parseFloat(l.quantity) || 0)),
      rate:      parseFloat(l.rate) || 0,
    }));

    return new Response(JSON.stringify({
      so_number:      so.tranid,
      internal_id:    so.id,
      date:           so.trandate,
      customer:       so.companyname || '',
      ship_address:   shipAddr,
      declared_value: Math.round((parseFloat(so.total) || 0) * 100) / 100,
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
