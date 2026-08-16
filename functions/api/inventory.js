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
        headers: { 'Authorization': auth, 'Content-Type': 'application/json', 'prefer': 'transient' },
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
    // Do NOT retry 401 — repeated failed attempts lock the NetSuite token via Login Audit Trail.
    throw new Error(`SuiteQL ${resp.status} (offset=${offset}): ${txt.substring(0, 500)}`);
  }
}

async function suiteQLAll(q, env) {
  const rows  = [];
  let offset  = 0;
  const limit = 1000;
  for (let page = 0; page < 50; page++) {
    let result;
    try {
      result = await suiteQLPage(q, env, offset, limit);
    } catch (e) {
      if (offset === 0) throw e;
      console.warn(`suiteQLAll stopping early at offset=${offset}: ${e.message}`);
      break;
    }
    const items = result.items || [];
    rows.push(...items);
    if (!result.hasMore || items.length === 0) break;
    offset += limit;
  }
  return rows;
}

// ── SuiteQL queries ───────────────────────────────────────────────────────────

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

// Q_UF_ITEMS: internal IDs for UF blanks.
// item.quantityonhand = 0 for multi-location items; per-location qty via REST Records API.
// NOTE: i.type is not a valid SuiteQL column — causes 500. Item type inferred at fetch time.
const Q_UF_ITEMS = `
  SELECT i.id, i.itemid
  FROM item i
  WHERE i.itemid LIKE 'UF%'
    AND i.isinactive = 'F'
  ORDER BY i.itemid
`;

// Q_UF_BALANCE_ALT: SuiteQL-only alternative using inventoryBalance.
// Requires "Inventory Register" permission on the CEO role — currently returns 401.
// Kept here for future use if the role permission is added.
const Q_UF_BALANCE_ALT = `
  SELECT i.itemid, SUM(ib.quantityonhand) AS quantityonhand,
         SUM(ib.quantityavailable) AS quantityavailable,
         SUM(ib.quantitycommitted) AS quantitycommitted
  FROM inventoryBalance ib
  JOIN item i ON i.id = ib.item
  WHERE i.itemid LIKE 'UF%'
    AND i.isinactive = 'F'
  GROUP BY i.itemid
  ORDER BY i.itemid
`;


// ── Aggregation ───────────────────────────────────────────────────────────────

function parseDisplay(displayname) {
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

  if (balanceRows && balanceRows.length > 0) {
    console.log('[inventory] UF balanceRows count:', balanceRows.length);
  }
  for (const row of (balanceRows || [])) {
    const name = (row.itemid || '').trim();
    if (!name || !models[name]) continue;
    models[name].onHand    = toInt(row.quantityonhand  ?? 0);
    models[name].committed = toInt(row.quantitycommitted ?? 0);
    models[name].available = toInt(row.quantityavailable ?? 0);
  }

  const lotOnHandSum = {};
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

  for (const [name, sum] of Object.entries(lotOnHandSum)) {
    if (models[name] && !name.startsWith('UF')) models[name].onHand = sum;
  }

  for (const m of Object.values(models)) {
    m.flexes.sort((a, b) => a.f - b.f);
  }

  const orders = {};
  for (const row of orderRows) {
    const name    = (row.name || '').trim();
    if (!name || !/^\d+S?\//.test(name)) continue;
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

// ── UF balance via REST Records API locations sublist ─────────────────────────
// item.quantityonhand = 0 for UF blanks (multi-location, non-lot-tracked).
// inventoryBalance SuiteQL table returns 401 (CEO role needs "Inventory Register" permission).
// Fix: GET /record/v1/{recType}/{id}/locations — try inventoryitem first, assemblyitem on 400.
// CEO role also needs "REST Web Services" setup permission for the Records API.

// Try /inventoryitem/{id}/locations first; if 400 (wrong record type), retry with /assemblyitem/.
// 401 = CEO role missing "REST Web Services" setup permission — throw immediately (no retry).
async function fetchItemLocations(id, env) {
  let lastErr;
  for (const recType of ['inventoryitem', 'assemblyitem']) {
    const url  = `https://${env.NS_ACCOUNT_ID}.suitetalk.api.netsuite.com/services/rest/record/v1/${recType}/${id}/locations`;
    const auth = await oauthHeader('GET', url, env);
    const resp = await fetch(url, {
      method:  'GET',
      headers: { 'Authorization': auth, 'Content-Type': 'application/json' },
    });
    if (resp.ok) {
      const data = await resp.json();
      let onhand = 0, available = 0, committed = 0;
      for (const loc of (data.items || [])) {
        onhand    += Number(loc.quantityOnHand)    || 0;
        available += Number(loc.quantityAvailable) || 0;
        committed += Number(loc.quantityCommitted) || 0;
      }
      return { onhand, available, committed };
    }
    const txt = await resp.text();
    if (resp.status === 400) {
      lastErr = new Error(`locations 400/${recType}: ${txt.substring(0, 100)}`);
      continue;
    }
    throw new Error(`locations ${resp.status}/${recType}: ${txt.substring(0, 200)}`);
  }
  throw lastErr || new Error('locations: exhausted record types');
}

// Run async tasks with limited concurrency to avoid overwhelming NetSuite auth.
async function runBatched(items, fn, concurrency = 8) {
  const results = [];
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    results.push(...await Promise.all(batch.map(fn)));
  }
  return results;
}

async function fetchUFBalance(env) {
  try {
    const itemRows = await suiteQLAll(Q_UF_ITEMS, env);
    if (!itemRows.length) { console.log('[inventory] Q_UF_ITEMS: no rows'); return []; }
    const results = await runBatched(itemRows, async row => {
      const itemid = (row.itemid || '').trim();
      const id     = row.id;
      if (!itemid || !id) return null;
      try {
        const { onhand, available, committed } = await fetchItemLocations(id, env);
        return { itemid, quantityonhand: onhand, quantityavailable: available, quantitycommitted: committed };
      } catch (e) {
        console.warn('[inventory] locations failed for', itemid, ':', e.message.substring(0, 100));
        return { itemid, quantityonhand: 0, quantityavailable: 0, quantitycommitted: 0 };
      }
    }, 8);
    const filtered = results.filter(r => r && r.itemid);
    const nonzero  = filtered.filter(r => r.quantityonhand > 0).length;
    console.log('[inventory] REST locations UF items=', filtered.length, 'nonzero=', nonzero);
    return filtered;
  } catch (e) {
    console.warn('[inventory] fetchUFBalance failed:', e.message.substring(0, 300));
    return [];
  }
}

// ── Handler ───────────────────────────────────────────────────────────────────

export async function onRequestGet({ env, request }) {
  if (!env.NS_ACCOUNT_ID || !env.NS_CONSUMER_KEY || !env.NS_TOKEN_ID) {
    return new Response(
      JSON.stringify({ error: 'NetSuite credentials not configured in CF Pages environment.' }),
      { status: 500, headers: CORS }
    );
  }

  // ── Debug mode: ?debug=uf ─────────────────────────────────────────────────
  const url = new URL(request.url);
  if (url.searchParams.get('debug') === 'uf') {
    try {
      const ufItems = await suiteQLAll(Q_UF_ITEMS, env).catch(e => ({ error: e.message }));
      const uf445   = Array.isArray(ufItems)
        ? ufItems.filter(r => (r.itemid || '').includes('445')).slice(0, 6)
        : [];

      // Serialized (one at a time) to isolate concurrent-auth issues
      const locationResults = [];
      for (const row of uf445) {
        try {
          const qty = await fetchItemLocations(row.id, env);
          locationResults.push({ id: row.id, itemid: row.itemid, ...qty });
        } catch (e) {
          locationResults.push({ id: row.id, itemid: row.itemid, error: e.message });
        }
      }

      // Test inventoryBalance SuiteQL (requires "Inventory Register" on CEO role — currently 401)
      const ibTest = await suiteQLAll(Q_UF_BALANCE_ALT, env)
        .then(rows => ({ ok: true, count: rows.length, sample: rows.slice(0, 4) }))
        .catch(e => ({ ok: false, error: e.message.substring(0, 300) }));

      return new Response(JSON.stringify({
        uf_items: Array.isArray(ufItems) ? { count: ufItems.length } : ufItems,
        uf445_locations: locationResults,
        inventoryBalance_test: ibTest,
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
