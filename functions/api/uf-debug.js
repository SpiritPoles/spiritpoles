// Diagnostic endpoint: /api/uf-debug
import crypto from 'node:crypto';

const NS_BASE  = 'https://6849768.suitelets.api.netsuite.com';
const NS_REALM = '6849768';

function oauthHeader(method, url, env) {
  const tk = env.NS_TOKEN, ts = env.NS_TOKEN_SECRET;
  const ck = env.NS_KEY,   cs = env.NS_KEY_SECRET;
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
  return `OAuth realm="${NS_REALM}", ` +
    [...params, ['oauth_signature', sig]]
      .map(([k,v])=>`${k}="${encodeURIComponent(v)}"`)
      .join(', ');
}

function withTimeout(ms, promise) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

async function runQuery(sql, env) {
  const url = `${NS_BASE}/services/rest/query/v1/suiteql?limit=100`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': oauthHeader('POST', url.split('?')[0], env),
      'Content-Type': 'application/json',
      'prefer': 'transient',
    },
    body: JSON.stringify({ q: sql }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    return { error: `HTTP ${resp.status}`, detail: t.substring(0, 500) };
  }
  const d = await resp.json();
  return d.items ?? d;
}

export async function onRequestGet({ env }) {
  const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };

  const [itemTable, lotRecords, itemType] = await Promise.allSettled([
    // 1. item table — all quantity fields for UF445
    withTimeout(20000, runQuery(`
      SELECT itemid, displayname, itemtype, subtype,
             NVL(quantityonhand, 0)    AS qoh,
             NVL(quantityavailable, 0) AS avail,
             NVL(quantitycommitted, 0) AS committed,
             NVL(quantitybackordered, 0) AS backordered
      FROM item
      WHERE itemid LIKE 'UF445/%'
        AND isinactive = 'F'
      ORDER BY itemid
    `, env)),

    // 2. inventoryNumber — lot-level quantities for UF445
    withTimeout(20000, runQuery(`
      SELECT i.itemid,
             inv.inventorynumber,
             NVL(inv.quantityonhand,    0) AS lot_qoh,
             NVL(inv.quantityavailable, 0) AS lot_avail,
             NVL(inv.quantityintransit, 0) AS lot_intransit
      FROM inventoryNumber inv
      JOIN item i ON i.id = inv.item
      WHERE i.itemid LIKE 'UF445/%'
        AND i.isinactive = 'F'
      ORDER BY i.itemid, inv.inventorynumber
    `, env)),

    // 3. Check if there are assembly component records (assemblyItem)
    withTimeout(20000, runQuery(`
      SELECT i.itemid,
             NVL(i.quantityonhand, 0)    AS qoh,
             NVL(i.quantitycommitted, 0) AS committed,
             i.itemtype,
             i.subtype,
             i.isphantom,
             i.isbomitem
      FROM item i
      WHERE i.itemid LIKE 'UF445/%'
        AND i.isinactive = 'F'
      ORDER BY i.itemid
    `, env)),
  ]);

  return new Response(JSON.stringify({
    itemTable:  itemTable.status  === 'fulfilled' ? itemTable.value  : { error: itemTable.reason?.message },
    lotRecords: lotRecords.status === 'fulfilled' ? lotRecords.value : { error: lotRecords.reason?.message },
    itemType:   itemType.status   === 'fulfilled' ? itemType.value   : { error: itemType.reason?.message },
  }, null, 2), { headers: CORS });
}
