// Diagnostic endpoint: /api/uf-debug
// Queries several approaches to find where UF445 quantities live in NetSuite.
import crypto from 'node:crypto';

const NS_BASE   = 'https://6849768.suitelets.api.netsuite.com';
const NS_REALM  = '6849768';

function oauthHeader(method, url, env) {
  const tk  = env.NS_TOKEN,  ts = env.NS_TOKEN_SECRET;
  const ck  = env.NS_KEY,    cs = env.NS_KEY_SECRET;
  const ts2 = String(Math.floor(Date.now()/1000));
  const nonce = crypto.randomBytes(8).toString('hex');
  const params = [
    ['oauth_consumer_key',     ck],
    ['oauth_nonce',            nonce],
    ['oauth_signature_method', 'HMAC-SHA256'],
    ['oauth_timestamp',        ts2],
    ['oauth_token',            tk],
    ['oauth_version',          '1.0'],
  ];
  const base = [method, encodeURIComponent(url),
    encodeURIComponent(params.map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&'))
  ].join('&');
  const sig = crypto.createHmac('sha256', `${encodeURIComponent(cs)}&${encodeURIComponent(ts)}`)
                    .update(base).digest('base64');
  const hdr = `OAuth realm="${NS_REALM}", ` +
    [...params, ['oauth_signature', sig]]
      .map(([k,v])=>`${k}="${encodeURIComponent(v)}"`)
      .join(', ');
  return hdr;
}

async function runQuery(sql, env) {
  const url = `${NS_BASE}/services/rest/query/v1/suiteql?limit=100`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization':  oauthHeader('POST', url.split('?')[0], env),
      'Content-Type':   'application/json',
      'prefer':         'transient',
    },
    body: JSON.stringify({ q: sql }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    return { error: `HTTP ${resp.status}`, detail: t.substring(0, 300) };
  }
  const d = await resp.json();
  return d.items ?? d;
}

export async function onRequestGet({ env }) {
  const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const results = {};

  // 1. item table — quantityonhand for UF445 items
  results.itemTable = await runQuery(`
    SELECT itemid, displayname,
           NVL(quantityonhand, 0)    AS qoh,
           NVL(quantityavailable, 0) AS avail,
           NVL(quantitycommitted, 0) AS committed
    FROM item
    WHERE itemid LIKE 'UF445/%'
      AND isinactive = 'F'
    ORDER BY itemid
  `, env).catch(e => ({ error: e.message }));

  // 2. inventoryNumber (lot records) for UF445 items
  results.lotRecords = await runQuery(`
    SELECT i.itemid,
           inv.inventorynumber,
           NVL(inv.quantityonhand,    0) AS lot_qoh,
           NVL(inv.quantityavailable, 0) AS lot_avail
    FROM inventoryNumber inv
    JOIN item i ON i.id = inv.item
    WHERE i.itemid LIKE 'UF445/%'
      AND i.isinactive = 'F'
    ORDER BY i.itemid, inv.inventorynumber
  `, env).catch(e => ({ error: e.message }));

  // 3. Try locationInventory — only list available fields to see if it works at all
  results.locationInventory = await runQuery(`
    SELECT i.itemid,
           NVL(li.quantityonhand, 0)    AS loc_qoh,
           NVL(li.quantityavailable, 0) AS loc_avail
    FROM locationInventory li
    JOIN item i ON i.id = li.item
    WHERE i.itemid LIKE 'UF445/%'
      AND i.isinactive = 'F'
    ORDER BY i.itemid
  `, env).catch(e => ({ error: e.message }));

  // 4. Check if item type matters — what type are UF445 items?
  results.itemType = await runQuery(`
    SELECT itemid, itemtype, subtype, isphantom, isbomitem,
           NVL(quantityonhand, 0) AS qoh
    FROM item
    WHERE itemid LIKE 'UF445/%'
      AND isinactive = 'F'
    ORDER BY itemid
  `, env).catch(e => ({ error: e.message }));

  return new Response(JSON.stringify(results, null, 2), { headers: CORS });
}
