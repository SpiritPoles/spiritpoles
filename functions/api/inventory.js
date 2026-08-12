// functions/api/inventory.js
// Cloudflare Pages Function — on-demand UCS Spirit inventory snapshot from NetSuite (TBA OAuth 1.0a)
// Replaces the Claude scheduled task 'spiritpoles-inventory-refresh'.
// Mirrors the payload shape expected by apps/inventory-lookup/index.html:
//   { models, orders, catalog: {}, refreshedAt }

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
};

// ── OAuth 1.0a helpers ────────────────────────────────────────────────────────

function pct(str) {
  return encodeURIComponent(String(str))
    .replace(/!/g, '%21').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29')
    .replace(/\*/g, '%2A');
}

async function oauthHeader(method, baseUrl, env, extraParams = {}) {
  const ts    = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomUUID().replace(/-/g, '');

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
    .sort(([a], [b]) => (pct(a) < pct(b) ? -1 : 1))
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

// ── SuiteQL (paginated) ───────────────────────────────────────────────────────

async function suiteQLPage(q, env, offset, limit, retries = 3) {
  const base = `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const url  = `${base}?limit=${limit}&offset=${offset}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const auth = await oauthHeader('POST', base, env, {
      limit:  String(limit),
      offset: String(offset),
    });
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
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
      continue;
    }
    throw new Error(`SuiteQL ${resp.status} (offset=${offset}): ${txt.substring(0, 500)}`);
  }
}

async function suiteQLAll(q, env) {
  const rows  = [];
  let offset  = 0;
  const limit = 1000;
  for (let page = 0; page < 50; page++) {   // safety cap
    let result;
    try {
      result = await suiteQLPage(q, env, offset, limit);
    } catch (e) {
      if (offset === 0) throw e;             // first page failure is fatal
      console.warn(`suiteQLAll stopping early at offset=${offset}: ${e.message}`);
      break;                                 // mid-pagination failure — use rows collected so far
    }
    const items = result.items || [];
    rows.push(...items);
    if (!result.hasMore || items.length === 0) break;
    offset += limit;
  }
  return rows;
}

// ── SuiteQL queries ───────────────────────────────────────────────────────────

// Q_ITEMS: model catalog — item names + display names only.
// item.quantityonhand is always 0 in SuiteQL (quantities live in inventoryBalance).
// Real quantities come from Q_BALANCE below; flex poles are further overridden by Q_FLEXES.
const Q_ITEMS = `
  SELECT
    i.itemid      AS name,
    i.displayname AS displayname,
    0             AS onhand,
    0             AS committed,
    0             AS available
  FROM item i
  WHERE i.isinactive = 'F'
    AND i.itemid LIKE '%/%'
  ORDER BY i.itemid
`;

// Fallback if Q_ITEMS fails — identical, kept for symmetry.
const Q_ITEMS_FALLBACK = `
  SELECT
    i.itemid      AS name,
    i.displayname AS displayname,
    0             AS onhand,
    0             AS committed,
    0             AS available
  FROM item i
  WHERE i.isinactive = 'F'
    AND i.itemid LIKE '%/%'
  ORDER BY i.itemid
`;

// Q_BALANCE: per-location on-hand quantities from inventoryBalance.
// Returns one row per item per warehouse location — aggregated in JS (no GROUP BY/SUM
// because those caused UNEXPECTED_ERROR 500 from NetSuite's SuiteQL engine).
// Flex poles are still overridden below by Q_FLEXES lot-sum. This fixes UF + Kids poles.
// Fails gracefully — if inventoryBalance is inaccessible, UF/Kids show 0 (non-fatal).
const Q_BALANCE = `
  SELECT
    i.itemid                     AS name,
    NVL(ib.quantityonhand,    0) AS onhand,
    NVL(ib.quantitycommitted, 0) AS committed,
    NVL(ib.quantityavailable, 0) AS available
  FROM inventoryBalance ib
  JOIN item i ON i.id = ib.inventoryitem
  WHERE i.isinactive = 'F'
    AND i.itemid LIKE '%/%'
    AND ib.quantityonhand > 0
  ORDER BY i.itemid
`;

// Replaces SS2827 — individual lot numbers (each pole's flex is encoded in the
// lot number string: "flex|model|date|time"  e.g. "37.0|370|24-06-03|9:49")
const Q_FLEXES = `
  SELECT
    i.itemid            AS modelname,
    i.displayname       AS displayname,
    inv.inventorynumber AS lotnumber,
    NVL(inv.quantityonhand,    0) AS lotonhand,
    NVL(inv.quantityavailable, 0) AS lotavailable
  FROM inventoryNumber inv
  JOIN item i ON i.id = inv.item
  WHERE inv.quantityonhand > 0
    AND i.isinactive = 'F'
  ORDER BY i.itemid, inv.inventorynumber
`;

// Replaces SS2491 — open SO lines (item, SO number, open qty).
// Replaces the PreviousTransactionLineLink join (which caused 16k+ row explosion) with the
// direct quantityshiprecv column on transactionLine (quantity already shipped on this line).
// openqty = ordered - shipped. Line-level filters exclude fully-shipped/closed lines.
const Q_ORDERS = `
  SELECT
    i.itemid                                                        AS name,
    i.displayname                                                   AS displayname,
    i.description                                                   AS description,
    t.tranid                                                        AS sonumber,
    ABS(NVL(tl.quantity, 0)) - NVL(tl.quantityshiprecv, 0)         AS openqty
  FROM transaction t
  JOIN transactionLine tl ON tl.transaction = t.id
  JOIN item i              ON i.id = tl.item
  WHERE t.type            = 'SalesOrd'
    AND tl.isfullyshipped = 'F'
    AND tl.isclosed       = 'F'
    AND tl.fulfillable    = 'T'
    AND tl.item           IS NOT NULL
    AND i.isinactive      = 'F'
    AND i.itemid          LIKE '%/%'
    AND ABS(NVL(tl.quantity, 0)) - NVL(tl.quantityshiprecv, 0) > 0
  ORDER BY i.itemid, t.tranid
`;


// ── Aggregation ───────────────────────────────────────────────────────────────

function parseDisplay(displayname) {
  // "370/40 | 12'1\" - 90lb"  →  { length: "12'1\"", weight: "90lb" }
  if (!displayname || !displayname.includes(' | ')) return { length: '', weight: '' };
  const rest    = displayname.split(' | ')[1] || '';
  const dashIdx = rest.lastIndexOf(' - ');
  if (dashIdx >= 0) {
    return { length: rest.slice(0, dashIdx).trim(), weight: rest.slice(dashIdx + 3).trim() };
  }
  return { length: rest.trim(), weight: '' };
}

function toInt(v)   { const n = parseInt(v,  10); return isNaN(n) ? 0    : n; }
function toFloat(v) { const n = parseFloat(v);    return isNaN(n) ? null : n; }

function buildPayload(itemRows, balanceRows, flexRows, orderRows) {

  // models — catalog from item table (quantities all 0 at this stage)
  const models = {};
  for (const row of itemRows) {
    const name = (row.name || '').trim();
    if (!name || !name.includes('/')) continue;
    const { length, weight } = parseDisplay(row.displayname || '');
    models[name] = {
      length,
      weight,
      onHand:    0,
      available: 0,
      committed: 0,
      flexes:    [],
    };
  }

  // Overlay real quantities from inventoryBalance (per-location rows, sum in JS).
  // Runs before the lot-sum override so flex poles are still corrected by Q_FLEXES.
  const balAgg = {};
  for (const row of (balanceRows || [])) {
    const name = (row.name || '').trim();
    if (!name) continue;
    if (!balAgg[name]) balAgg[name] = { onhand: 0, committed: 0, available: 0 };
    balAgg[name].onhand    += toInt(row.onhand);
    balAgg[name].committed += toInt(row.committed);
    balAgg[name].available += toInt(row.available);
  }
  for (const [name, agg] of Object.entries(balAgg)) {
    if (models[name]) {
      models[name].onHand    = agg.onhand;
      models[name].committed = agg.committed;
      models[name].available = agg.available;
    }
  }

  // flexes (Q_FLEXES) — attach to parent model + derive on-hand from lot quantities
  // lot number format: "37.0|370|24-06-03|9:49" — flex is first segment
  // lotOnHandSum overrides the inventoryBalance value for flex-tracked poles.
  const lotOnHandSum = {};  // modelName → sum of lot quantityonhand
  for (const row of flexRows) {
    const modelName = (row.modelname || '').trim();
    if (!models[modelName]) continue;
    const lot   = (row.lotnumber || '').trim();
    const flex  = toFloat(lot.split('|')[0]);
    if (flex === null) continue;
    const avail = toInt(row.lotavailable) > 0;
    models[modelName].flexes.push({ f: Math.round(flex * 10) / 10, a: avail });
    lotOnHandSum[modelName] = (lotOnHandSum[modelName] || 0) + toInt(row.lotonhand);
  }

  // Override onHand for flex-tracked models with the sum of lot quantities.
  // Non-flex models (kids poles, etc.) keep the inventoryBalance value from Q_ITEMS.
  for (const [name, sum] of Object.entries(lotOnHandSum)) {
    if (models[name]) models[name].onHand = sum;
  }

  // sort flexes smallest → largest within each model
  for (const m of Object.values(models)) {
    m.flexes.sort((a, b) => a.f - b.f);
  }

  // orders (SS2491) — group by item name
  // Also create stub model entries for back-ordered items not in Q_ITEMS (zero stock).
  const orders = {};
  for (const row of orderRows) {
    const name    = (row.name || '').trim();
    if (!name || !/^\d+S?\//.test(name)) continue;     // poles only
    const openQty = Math.round(parseFloat(row.openqty) || 0);
    if (openQty <= 0) continue;
    const soNum = (row.sonumber || '').trim() || null;

    if (!orders[name]) {
      orders[name] = {
        openQty:     0,
        committed:   0,
        available:   0,
        onHand:      0,
        display:     row.displayname || name,
        description: row.description || '',
        soLines:     [],
      };
    }
    orders[name].openQty += openQty;
    orders[name].soLines.push({ soNum, qty: openQty, flex: null, bo: false });

    // If this ordered item has no inventory entry (true back-order with 0 stock),
    // create a stub model so it appears in the Back Ordered tab.
    if (!models[name]) {
      const { length, weight } = parseDisplay(row.displayname || '');
      models[name] = { length, weight, onHand: 0, available: 0, committed: 0, flexes: [] };
    }
  }

  return {
    models,
    orders,
    catalog:     {},   // dashboard renders from models; catalog zero-fill omitted for simplicity
    refreshedAt: new Date().toISOString(),
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequestGet({ env }) {
  if (!env.NS_ACCOUNT_ID || !env.NS_CONSUMER_KEY || !env.NS_TOKEN_ID) {
    return new Response(
      JSON.stringify({ error: 'NetSuite credentials not configured in CF Pages environment.' }),
      { status: 500, headers: CORS }
    );
  }

  // Run all three queries in parallel — they are independent of each other.
  // Q_ITEMS falls back to 0 on-hand on any error (flex poles still get correct
  // counts from Q_FLEXES lot-sum override, so the main tabs remain accurate).
  let itemsWarning = null;
  try {
    const itemsPromise = suiteQLAll(Q_ITEMS, env).catch(async (e) => {
      itemsWarning = 'Item qty fallback (0 on-hand for non-flex items): ' + e.message.substring(0, 300);
      console.warn('[inventory]', itemsWarning);
      return suiteQLAll(Q_ITEMS_FALLBACK, env);   // fallback also runs in parallel slot
    });

    // Q_BALANCE: graceful failure — UF/Kids show 0 if inventoryBalance is inaccessible
    const balPromise = suiteQLAll(Q_BALANCE, env).catch(e => {
      console.warn('[inventory] Q_BALANCE failed (UF/Kids will show 0):', e.message.substring(0, 200));
      return [];
    });

    const [itemRows, balanceRows, flexRows, orderRows] = await Promise.all([
      itemsPromise,
      balPromise,
      suiteQLAll(Q_FLEXES,  env).catch(e => { throw new Error('Q_FLEXES: '  + e.message); }),
      suiteQLAll(Q_ORDERS,  env).catch(e => { throw new Error('Q_ORDERS: '  + e.message); }),
    ]);

    const payload = buildPayload(itemRows, balanceRows, flexRows, orderRows);
    if (itemsWarning) payload.warning = itemsWarning;
    return new Response(JSON.stringify(payload), { status: 200, headers: CORS });

  } catch (err) {
    console.error('[inventory] error:', err.message);
    return new Response(JSON.stringify({ error: err.message }), { status: 502, headers: CORS });
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
