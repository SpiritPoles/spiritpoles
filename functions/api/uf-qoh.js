// functions/api/uf-qoh.js
// Diagnostic: test UF inventory data sources directly (no query param routing)
// Hit /api/uf-qoh to see which approach works for UF On Hand.

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

function pct(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g,'%21').replace(/'/g,'%27')
    .replace(/\(/g,'%28').replace(/\)/g,'%29')
    .replace(/\*/g,'%2A');
}

async function oauthHeader(method, baseUrl, env, extraParams = {}) {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g,'');
  const p = { ...extraParams, oauth_consumer_key: env.NETSUITE_CONSUMER_KEY, oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA256', oauth_timestamp: ts,
    oauth_token: env.NETSUITE_TOKEN_ID, oauth_version: '1.0' };
  const normalized = Object.entries(p).sort(([a],[b]) => pct(a)<pct(b)?-1:1)
    .map(([k,v]) => `${pct(k)}=${pct(v)}`).join('&');
  const base   = `${method.toUpperCase()}&${pct(baseUrl)}&${pct(normalized)}`;
  const sigKey = `${pct(env.NETSUITE_CONSUMER_SECRET)}&${pct(env.NETSUITE_TOKEN_SECRET)}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(sigKey),
    { name:'HMAC', hash:'SHA-256' }, false, ['sign']);
  const raw = await crypto.subtle.sign('HMAC', key, enc.encode(base));
  const sig = btoa(String.fromCharCode(...new Uint8Array(raw)));
  return [`OAuth realm="${env.NETSUITE_ACCOUNT_ID}"`,
    `oauth_consumer_key="${env.NETSUITE_CONSUMER_KEY}"`,
    `oauth_token="${env.NETSUITE_TOKEN_ID}"`,
    `oauth_signature_method="HMAC-SHA256"`,
    `oauth_timestamp="${ts}"`, `oauth_nonce="${nonce}"`,
    `oauth_version="1.0"`, `oauth_signature="${sig}"`].join(', ');
}

async function suiteQLOnce(q, env) {
  const base = `https://${env.NETSUITE_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const url  = `${base}?limit=100&offset=0`;
  const auth = await oauthHeader('POST', base, env, { limit:'100', offset:'0' });
  const resp = await fetch(url, {
    method:'POST',
    headers:{ 'Authorization':auth, 'Content-Type':'application/json', 'prefer':'transient' },
    body: JSON.stringify({ q }),
  });
  const txt = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status}: ${txt.substring(0,300)}`);
  return JSON.parse(txt);
}

async function testLocations(id, env) {
  const results = [];
  for (const recType of ['inventoryitem','assemblyitem']) {
    const url  = `https://${env.NETSUITE_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/record/v1/${recType}/${id}/locations`;
    const auth = await oauthHeader('GET', url, env);
    const resp = await fetch(url, { method:'GET', headers:{ 'Authorization':auth, 'Content-Type':'application/json' } });
    const txt  = await resp.text();
    results.push({ recType, status: resp.status, preview: txt.substring(0,200) });
    if (resp.ok) break;
  }
  return results;
}

export async function onRequestGet({ env, request }) {
  if (!env.NETSUITE_ACCOUNT_ID) {
    return new Response(JSON.stringify({ error:'NS env vars missing' }), { status:500, headers:CORS });
  }

  const results = {};

  // 1. Direct item.quantityonhand for UF445
  try {
    const r1 = await suiteQLOnce(
      `SELECT i.itemid, i.quantityonhand, i.quantityavailable FROM item i WHERE i.itemid LIKE 'UF445%' AND i.isinactive = 'F' ORDER BY i.itemid`,
      env
    );
    results.direct_qoh = { ok: true, rows: r1.items };
  } catch (e) {
    results.direct_qoh = { ok: false, error: e.message };
  }

  // 2. inventoryBalance table
  try {
    const r2 = await suiteQLOnce(
      `SELECT i.itemid, SUM(ib.quantityonhand) AS onhand FROM inventoryBalance ib JOIN item i ON i.id = ib.item WHERE i.itemid LIKE 'UF%' AND i.isinactive = 'F' GROUP BY i.itemid ORDER BY i.itemid`,
      env
    );
    results.inv_balance = { ok: true, count: r2.items.length, sample: r2.items.slice(0,5) };
  } catch (e) {
    results.inv_balance = { ok: false, error: e.message };
  }

  // 3. REST locations for first UF445 item
  try {
    const idRes = await suiteQLOnce(
      `SELECT i.id, i.itemid FROM item i WHERE i.itemid LIKE 'UF445%' AND i.isinactive = 'F' ORDER BY i.itemid`,
      env
    );
    const first = (idRes.items || [])[0];
    if (first) {
      const locTest = await testLocations(first.id, env);
      results.rest_locations = { item: first.itemid, id: first.id, tests: locTest };
    } else {
      results.rest_locations = { error: 'no UF445 items found' };
    }
  } catch (e) {
    results.rest_locations = { ok: false, error: e.message };
  }

  results.request_url = request.url;
  results.timestamp = new Date().toISOString();

  return new Response(JSON.stringify(results, null, 2), { status:200, headers:CORS });
}

export async function onRequestOptions() {
  return new Response(null, { headers:{
    'Access-Control-Allow-Origin':'*',
    'Access-Control-Allow-Methods':'GET, OPTIONS',
    'Access-Control-Allow-Headers':'Content-Type',
  }});
}
