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

// Q_ITEMS: model catalog + on-hand quantities from item table.
// NOTE: item.quantityonhand returns 0 for UF items — UF On Hand comes from Q_SS2471_UF.
// Lot-tracked finished poles will have their onHand overridden later by lotOnHandSum (Q_FLEXES).
const Q_ITEMS = `
  SELECT
    i.itemid      AS name,
    i.displayname AS displayname,
    NVL(i.quantityonhand,    0) AS onhand,
    NVL(i.quantitycommitted,  0) AS committed,
    NVL(i.quantityavailable, 0) AS available
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

// Q_SS2471_UF: query saved search 2471 as a SuiteQL virtual table to get REAL UF On Hand.
// SS 2471 uses NetSuite's built-in On Hand formula which correctly handles all item types,
// including those where item.quantityonhand returns 0 (UF blanks with multi-location tracking).
// Column names in a SuiteQL virtual table match the saved search's column internal names.
// We SELECT * and then pick columns defensively since exact names depend on SS config.
const Q_SS2471_UF = `
  SELECT *
  FROM customsearch2471
  WHERE name LIKE 'UF%'
`;

// Fallback queries for UF items (both currently return 0 for UF items but kept as safety net).
const Q_UF_BALANCE = `
  SELECT itemid,
         NVL(quantityonhand,    0) AS quantityonhand,
         NVL(quantityavailable, 0) AS quantityavailable,
         NVL(quantitycommitted,  0) AS quantitycommitted
  FROM item
  WHERE itemid LIKE 'UF%'
    AND isinactive = 'F'
  ORDER BY itemid
`;

const Q_UF_LOTS = `
  SELECT i.itemid,
         NVL(SUM(inv.quantityonhand),    0) AS quantityonhand,
         NVL(SUM(inv.quantityavailable), 0) AS quantityavailable
  FROM inventoryNumber inv
  JOIN item i ON i.id = inv.item
  WHERE i.itemid LIKE 'UF%'
    AND i.isinactive = 'F'
  GROUP BY i.itemid
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

  // models — catalog from item table (UF quantities are 0 here; overridden below by balanceRows)
  const models = {};
  for (const row of itemRows) {
    const name = (row.name || '').trim();
    if (!name || !name.includes('/')) continue;
    const { length, weight } = parseDisplay(row.displayname || '');
    models[name] = {
      length,
      weight,
      onHand:    toInt(row.onhand),
      available: toInt(row.available),
      committed: toInt(row.committed),
      flexes:    [],
    };
  }

  // Overlay UF on-hand quantities from SS 2471 (fetchUFBalance).
  if (balanceRows && balanceRows.length > 0) {
    console.log('[inventory] UF balanceRows count:', balanceRows.length);
  }
  for (const row of (balanceRows || [])) {
    const name = (row.itemid || '').trim();
    if (!name || !models[name]) continue;
    const oh = toInt(row.quantityonhand  ?? 0);
    const cm = toInt(row.quantitycommitted ?? 0);
    const av = toInt(row.quantityavailable ?? 0);
    // Always apply the overlay from SS 2471 — even if 0, it's more authoritative.
    models[name].onHand    = oh;
    models[name].committed = cm;
    models[name].available = av;
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

  // Override onHand for flex-tracked finished poles with the sum of lot quantities.
  // Do NOT override UF items — their quantities came from SS 2471.
  for (const [name, sum] of Object.entries(lotOnHandSum)) {
    if (models[name] && !name.startsWith('UF')) models[name].onHand = sum;
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

// ── UF balance via SS 2471 virtual table ─────────────────────────────────────
// PRIMARY: query saved search 2471 as a SuiteQL virtual table.
// SS 2471 returns real On Hand for UF items where item.quantityonhand = 0.
// FALLBACK: item table + inventoryNumber (both return 0 currently, but harmless).

function parseSSRow(row) {
  // Column names in a SuiteQL virtual table depend on the saved search configuration.
  // Try all known variants defensively.
  const oh = Number(
    row.onhand          ??
    row['on hand']      ??
    row.on_hand         ??
    row.quantityonhand  ??
    0
  );
  const cm = Number(
    row.committed            ??
    row.quantitycommitted    ??
    0
  );
  const av = Number(
    row.available            ??
    row.quantityavailable    ??
    0
  );
  return { oh, cm, av };
}

async function fetchUFBalance(env) {
  // ── PRIMARY: SS 2471 virtual table ──
  try {
    const ssResult = await suiteQLPage(Q_SS2471_UF, env, 0, 500, 1, 20000);
    const ssRows   = ssResult.items || [];
    const { oh: sampleOh } = ssRows.length > 0 ? parseSSRow(ssRows[0]) : { oh: 0 };
    const ssNonzero = ssRows.filter(r => parseSSRow(r).oh > 0).length;
    console.log('[inventory] SS2471 UF rows=', ssRows.length,
                'nonzero=', ssNonzero,
                'columns=', ssRows.length > 0 ? Object.keys(ssRows[0]).join(',') : 'none');

    if (ssRows.length > 0) {
      // Return SS 2471 data regardless of nonzero count — it's authoritative.
      return ssRows
        .filter(r => r.name && String(r.name).includes('/'))
        .map(r => {
          const { oh, cm, av } = parseSSRow(r);
          return {
            itemid:            String(r.name).trim(),
            quantityonhand:    oh,
            quantityavailable: av,
            quantitycommitted: cm,
          };
        });
    }
    console.warn('[inventory] SS2471 returned 0 rows — falling back to item/lot queries');
  } catch (e) {
    console.warn('[inventory] SS2471 virtual table failed:', e.message.substring(0, 300));
    // Fall through to legacy approach
  }

  // ── FALLBACK: item table + inventoryNumber ──
  // Both currently return 0 for UF items but kept as a safety net.
  const [lotRows, itemRows] = await Promise.all([
    suiteQLAll(Q_UF_LOTS,    env).catch(e => { console.warn('[inventory] Q_UF_LOTS err:',    e.message); return []; }),
    suiteQLAll(Q_UF_BALANCE, env).catch(e => { console.warn('[inventory] Q_UF_BALANCE err:', e.message); return []; }),
  ]);

  const lotNonzero  = lotRows.filter( r => Number(r.quantityonhand) > 0).length;
  const itemNonzero = itemRows.filter(r => Number(r.quantityonhand) > 0).length;
  console.log('[inventory] UF lot rows=', lotRows.length, 'nonzero=', lotNonzero,
              '| item rows=', itemRows.length, 'nonzero=', itemNonzero);

  const source   = lotNonzero > 0 ? lotRows : itemRows;
  const isLotSrc = source === lotRows;

  return source.map(r => ({
    itemid:            (r.itemid || '').trim(),
    quantityonhand:    Number(r.quantityonhand)    || 0,
    quantityavailable: Number(r.quantityavailable) || 0,
    quantitycommitted: isLotSrc ? 0 : (Number(r.quantitycommitted) || 0),
  })).filter(r => r.itemid);
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequestGet({ env, request }) {
  if (!env.NS_ACCOUNT_ID || !env.NS_CONSUMER_KEY || !env.NS_TOKEN_ID) {
    return new Response(
      JSON.stringify({ error: 'NetSuite credentials not configured in CF Pages environment.' }),
      { status: 500, headers: CORS }
    );
  }

  // ── Debug mode: ?debug=uf — tests SS 2471 virtual table + legacy queries ──
  const url = new URL(request.url);
  if (url.searchParams.get('debug') === 'uf') {
    try {
      const [ssResult, lotRows, itemRows, uf445Rows] = await Promise.all([
        suiteQLPage(Q_SS2471_UF, env, 0, 500, 1, 20000)
          .then(r => r.items || [])
          .catch(e => ({ error: e.message })),
        suiteQLAll(Q_UF_LOTS,    env).catch(e => ({ error: e.message })),
        suiteQLAll(Q_UF_BALANCE, env).catch(e => ({ error: e.message })),
        suiteQLAll(
          `SELECT i.itemid, NVL(i.quantityonhand,0) AS onhand, NVL(i.quantityavailable,0) AS avail, NVL(i.quantitycommitted,0) AS committed FROM item i WHERE i.itemid LIKE 'UF445/%' AND i.isinactive = 'F' ORDER BY i.itemid`,
          env
        ).catch(e => ({ error: e.message })),
      ]);

      const ssRows    = Array.isArray(ssResult) ? ssResult : [];
      const ssError   = Array.isArray(ssResult) ? null : ssResult;
      const ssNonzero = ssRows.filter(r => parseSSRow(r).oh > 0).length;

      return new Response(JSON.stringify({
        SS2471: {
          error:    ssError,
          count:    ssRows.length,
          nonzero:  ssNonzero,
          columns:  ssRows.length > 0 ? Object.keys(ssRows[0]) : [],
          uf445_sample: ssRows.filter(r => String(r.name || '').includes('445')).slice(0, 10),
        },
        Q_UF_LOTS: {
          count:   Array.isArray(lotRows)  ? lotRows.length  : 'error',
          nonzero: Array.isArray(lotRows)  ? lotRows.filter(r => Number(r.quantityonhand) > 0).length : 'error',
          uf445:   Array.isArray(lotRows)  ? lotRows.filter(r => (r.itemid || '').includes('445')).slice(0, 10) : lotRows,
        },
        Q_UF_BALANCE: {
          count:   Array.isArray(itemRows) ? itemRows.length : 'error',
          nonzero: Array.isArray(itemRows) ? itemRows.filter(r => Number(r.quantityonhand) > 0).length : 'error',
          uf445:   Array.isArray(itemRows) ? itemRows.filter(r => (r.itemid || '').includes('445')).slice(0, 10) : itemRows,
        },
        Q_ITEMS_UF445: uf445Rows,
      }, null, 2), { status: 200, headers: CORS });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: CORS });
    }
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

    // ── Phase 2: orders + UF balance (2 concurrent) ──────────────────────────
    const ufBalancePromise = fetchUFBalance(env).catch(e => {
      balanceWarning = 'UF balance: ' + e.message.substring(0, 200);
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
