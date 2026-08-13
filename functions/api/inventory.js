// functions/api/inventory.js
// Cloudflare Pages Function — on-demand UCS Spirit inventory snapshot from NetSuite (TBA OAuth 1.0a)
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

async function suiteQLPage(q, env, offset, limit, retries = 3, timeoutMs = 20000) {
  const base = `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql`;
  const url  = `${base}?limit=${limit}&offset=${offset}`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const auth = await oauthHeader('POST', base, env, {
      limit:  String(limit),
      offset: String(offset),
    });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(url, {
        method:  'POST',
        headers: {
          'Authorization': auth,
          'Content-Type':  'application/json',
          'prefer':        'transient',
        },
        body: JSON.stringify({ q }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new Error(`SuiteQL timeout after ${timeoutMs}ms (offset=${offset})`);
      throw e;
    }
    clearTimeout(timer);

    if (resp.ok) return resp.json();

    const txt = await resp.text();
    if (resp.status === 401 && attempt < retries) {
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
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

// Q_ITEMS: model catalog — item names + display names only (quantities always 0 here).
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

// Q_FLEXES: individual lot numbers — flex is encoded in the lot number string
// ("flex|model|date|time"  e.g. "37.0|370|24-06-03|9:49")
// Also provides onHand counts for finished (lot-tracked) poles.
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

// Q_ORDERS: open SO lines (item, SO number, open qty).
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

// Q_UF_IDS: get internal IDs for all active UF items.
// Used as step 1 of the two-step balance fetch — avoids JOIN on inventoryBalance
// (which fails with 500 in NS SuiteQL when combined with GROUP BY).
const Q_UF_IDS = `
  SELECT id, itemid
  FROM item
  WHERE itemid LIKE 'UF%'
    AND isinactive = 'F'
  ORDER BY itemid
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

  // Overlay UF on-hand quantities from inventoryBalance (two-step fetch).
  if (balanceRows && balanceRows.length > 0) {
    console.log('[inventory] balanceRows[0] keys:', JSON.stringify(Object.keys(balanceRows[0])));
  }
  for (const row of (balanceRows || [])) {
    const name = (row.itemid || '').trim();
    if (!name || !models[name]) continue;
    const oh = toInt(row.quantityonhand  ?? 0);
    const cm = toInt(row.quantitycommitted ?? 0);
    const av = toInt(row.quantityavailable ?? 0);
    if (oh > 0 || cm > 0) {
      models[name].onHand    = oh;
      models[name].committed = cm;
      models[name].available = av;
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
  for (const [name, sum] of Object.entries(lotOnHandSum)) {
    if (models[name]) models[name].onHand = sum;
  }

  // sort flexes smallest → largest within each model
  for (const m of Object.values(models)) {
    m.flexes.sort((a, b) => a.f - b.f);
  }

  // orders (Q_ORDERS) — group by item name
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

    // Stub model for back-ordered items with no inventory entry.
    if (!models[name]) {
      const { length, weight } = parseDisplay(row.displayname || '');
      models[name] = { length, weight, onHand: 0, available: 0, committed: 0, flexes: [] };
    }
  }

  return {
    models,
    orders,
    catalog:     {},
    refreshedAt: new Date().toISOString(),
  };
}

// ── UF balance: two-step fetch ────────────────────────────────────────────────
// Step 1: get UF item internal IDs from item table (always works).
// Step 2: query inventoryBalance filtered by those IDs — no JOIN, no GROUP BY
//         on a virtual table (which causes NS 500). Aggregate in JS instead.

async function fetchUFBalance(env) {
  // Step 1
  const ufItems = await suiteQLAll(Q_UF_IDS, env);
  if (!ufItems.length) return [];

  const idMap = {};  // internal_id (string) → itemid name
  for (const r of ufItems) idMap[String(r.id)] = (r.itemid || '').trim();
  const idList = Object.keys(idMap).join(', ');

  // Step 2 — query inventoryBalance filtered to our UF items.
  // Column names: onHand / available / committed (no "quantity" prefix in inventoryBalance).
  // Avoid large IN clause — use WHERE onHand > 0 and filter to UF in JS instead.
  let ibRows;
  let colWarning = null;
  try {
    ibRows = await suiteQLAll(
      `SELECT item, onHand, available, committed
       FROM inventoryBalance
       WHERE onHand > 0`,
      env
    );
  } catch (e1) {
    const err1 = e1.message.substring(0, 150);
    // Fallback: try with quantityOnHand column name (older NS versions)
    try {
      ibRows = await suiteQLAll(
        `SELECT item, quantityOnHand AS onHand, quantityAvailable AS available, quantityCommitted AS committed
         FROM inventoryBalance
         WHERE quantityOnHand > 0`,
        env
      );
      colWarning = `inventoryBalance(alt-cols-ok): first: ${err1}`;
    } catch (e2) {
      throw new Error(`inventoryBalance failed — onHand: ${err1} | quantityOnHand: ${e2.message.substring(0, 150)}`);
    }
  }

  // Aggregate across locations in JS, map internal ID → itemid name
  // Log first row keys so we can see what column names NS actually returns
  if (ibRows.length > 0) {
    console.log('[inventory] inventoryBalance row keys:', JSON.stringify(Object.keys(ibRows[0])));
    console.log('[inventory] inventoryBalance row[0]:', JSON.stringify(ibRows[0]));
  }
  const agg = {};
  for (const r of ibRows) {
    const name = idMap[String(r.item)];
    if (!name) continue;
    if (!agg[name]) agg[name] = { itemid: name, quantityonhand: 0, quantityavailable: 0, quantitycommitted: 0 };
    // Handle both column-name conventions: onHand (inventoryBalance) and quantityOnHand (fallback)
    agg[name].quantityonhand   += Number(r.onHand    || r.onhand    || r.quantityOnHand  || r.quantityonhand  || 0);
    agg[name].quantityavailable += Number(r.available  || r.Available  || r.quantityAvailable || r.quantityavailable || 0);
    agg[name].quantitycommitted += Number(r.committed  || r.Committed  || r.quantityCommitted || r.quantitycommitted || 0);
  }

  const result = Object.values(agg);
  if (colWarning) result._warning = colWarning;
  return result;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequestGet({ env }) {
  if (!env.NS_ACCOUNT_ID || !env.NS_CONSUMER_KEY || !env.NS_TOKEN_ID) {
    return new Response(
      JSON.stringify({ error: 'NetSuite credentials not configured in CF Pages environment.' }),
      { status: 500, headers: CORS }
    );
  }

  let itemsWarning   = null;
  let balanceWarning = null;
  let flexWarning    = null;
  let orderWarning   = null;

  try {
    // ── Phase 1: catalog + flex numbers (2 concurrent queries) ───────────────
    const [itemRows, flexRows] = await Promise.all([
      suiteQLAll(Q_ITEMS, env).catch(e => {
        itemsWarning = 'Q_ITEMS: ' + e.message.substring(0, 200);
        console.warn('[inventory]', itemsWarning);
        return [];
      }),
      suiteQLAll(Q_FLEXES, env).catch(e => {
        flexWarning = 'Q_FLEXES: ' + e.message.substring(0, 200);
        console.warn('[inventory]', flexWarning);
        return [];
      }),
    ]);

    // ── Phase 2: orders + UF balance (2 concurrent; balance runs 2 sequential sub-queries) ──
    // ufBalancePromise starts immediately so Step A overlaps with Q_ORDERS.
    // Step B (inventoryBalance) starts after Step A — still ≤2 concurrent NS queries total.
    const ufBalancePromise = fetchUFBalance(env).then(rows => {
      if (rows._warning) {
        balanceWarning = rows._warning;
        delete rows._warning;
      }
      return rows;
    }).catch(e => {
      balanceWarning = 'Q_BALANCE: ' + e.message.substring(0, 300);
      console.warn('[inventory]', balanceWarning);
      return [];
    });

    const [orderRows, balanceRows] = await Promise.all([
      suiteQLAll(Q_ORDERS, env).catch(e => {
        orderWarning = 'Q_ORDERS: ' + e.message.substring(0, 200);
        console.warn('[inventory]', orderWarning);
        return [];
      }),
      ufBalancePromise,
    ]);

    const payload  = buildPayload(itemRows, balanceRows, flexRows, orderRows);
    const warnings = [itemsWarning, balanceWarning, flexWarning, orderWarning].filter(Boolean);
    if (warnings.length) payload.warning = warnings.join(' | ');
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
