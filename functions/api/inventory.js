// functions/api/inventory.js
//
// Cloudflare Pages Function — standalone NetSuite backend for the
// UCS Spirit Inventory Lookup app. No Claude account involved at runtime.
//
// Auth: NetSuite Token-Based Authentication (TBA / OAuth 1.0a, HMAC-SHA256),
// signed here with the Workers-native Web Crypto API. This is deliberately
// NOT the OAuth2 flow Claude's own MCP connector uses — TBA needs no
// interactive browser consent, so it works from an unattended server.
//
// Required Cloudflare Pages environment variables (set as encrypted
// "Secrets" in the Pages project settings, never committed to the repo):
//   NETSUITE_ACCOUNT_ID       e.g. "1234567" or "1234567-sb1" for sandbox
//   NETSUITE_CONSUMER_KEY
//   NETSUITE_CONSUMER_SECRET
//   NETSUITE_TOKEN_ID
//   NETSUITE_TOKEN_SECRET
//
// NetSuite-side prerequisites — all done as of this version:
//   1. [DONE] Transactions > Find Transaction (View) added to the
//      "UCS Spirit - AI Apps Connector" role — confirmed live via SuiteQL
//      that `transaction` / `transactionline` are unblocked.
//   2. [DONE] "Log in using Access Tokens" (Full) added under the same
//      role's Setup tab, alongside its existing OAuth2 permissions.
//   3. [DONE] "UCS Spirit Inventory App (TBA)" Integration record,
//      configured for Token-based Authentication only (OAuth2 left off —
//      kept separate from the OAuth2 integration Claude's own connector
//      uses). Consumer Key/Secret generated from it.
//   4. [DONE] Access Token generated (Setup > Users/Roles > Access
//      Tokens), tied to the employee + the role above + that integration
//      record. Token ID/Secret generated from it.
//
// Superseded from the earlier standalone attempt (functions/api/inventory.js,
// pre-rewrite): that version relied on `inventoryBalance` SuiteQL 401ing
// under the OLD role and worked around it with a NetSuite-side RESTlet
// (spiritpoles_inventory_restlet.js) plus a REST Records API /locations
// fallback for UF blanks. Verified live under the NEW role that
// `inventorybalance` is NOT actually restricted — it 401'd before purely
// because the old role lacked the right permissions, not because the table
// itself is off-limits. That whole RESTlet/locations-fallback layer (and
// its NetSuite-side deployment dependency) is removed here in favor of
// querying `inventorybalance` directly, which is confirmed to cover both
// lot-tracked finished poles AND multi-location UF blanks correctly. The
// `Q_ORDERS` line-filtering logic (isfullyshipped/isclosed/fulfillable) is
// carried over from that version — it's more accurate than a status-code
// guess and was already working once Find Transaction was granted.

const CORS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  // no-store: the frontend already does its own 6h localStorage caching
  // and expects a manual "Refresh" click to hit real data — an HTTP-level
  // cache here would silently defeat that.
  'cache-control': 'no-store',
};

export async function onRequestGet(context) {
  const { env } = context;

  if (!env.NETSUITE_ACCOUNT_ID || !env.NETSUITE_CONSUMER_KEY || !env.NETSUITE_TOKEN_ID) {
    return new Response(
      JSON.stringify({ error: 'NetSuite credentials not configured in Cloudflare Pages environment variables.' }),
      { status: 500, headers: CORS }
    );
  }

  try {
    // Sequential, not parallel — NetSuite TBA rejects concurrent requests
    // that share the same OAuth timestamp/nonce window closely enough,
    // surfacing as intermittent 401s. Confirmed against this account
    // during the standalone-backend build; not worth re-triggering.
    const [models, catalog] = await buildModelsAndCatalog(env);
    const orders = await buildOrders(env);

    const ordersWarning = orders.__warning;
    delete orders.__warning;

    // Fill in committed/available/onHand at the order level from the same
    // model data, so the fields are consistent wherever the frontend reads
    // them from either object.
    for (const [itemid, o] of Object.entries(orders)) {
      const m = models[itemid];
      if (m) {
        o.committed = m.committed;
        o.available = m.available;
        o.onHand = m.onHand;
      }
    }

    const payload = {
      models,
      orders,
      catalog,
      refreshedAt: new Date().toISOString(),
    };
    if (ordersWarning) payload.warning = ordersWarning;

    return new Response(JSON.stringify(payload), { status: 200, headers: CORS });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String((err && err.message) || err) }),
      { status: 502, headers: CORS }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, OPTIONS',
      'access-control-allow-headers': 'Content-Type',
    },
  });
}

// ---------------------------------------------------------------------
// Data assembly
// ---------------------------------------------------------------------

async function buildModelsAndCatalog(env) {
  const models = {};
  const catalog = {};

  // Pole models/blanks all have a "/" in their item id, e.g. "430/68" or
  // "UF430/68". This mirrors the frontend's own POLE_RE (/^\d+S?\//) plus
  // the UF-prefixed blanks, without pulling every unrelated item in NetSuite.
  let items;
  try {
    items = await suiteQLAll(env, `
      SELECT id, itemid, displayname
      FROM item
      WHERE isinactive = 'F'
        AND (itemid LIKE '%/%')
    `);
  } catch (err) {
    throw new Error(`Q_ITEMS: ${String((err && err.message) || err)}`);
  }

  const itemIdByInternalId = {};
  for (const row of items) {
    catalog[row.itemid] = row.displayname || row.itemid;
    itemIdByInternalId[row.id] = row.itemid;
    models[row.itemid] = { onHand: 0, available: 0, committed: 0, flexes: [] };
  }

  // Per-flex-number (per-inventory-number) balances, joined back to the
  // item and to the inventory number's label (the "Flex #" string, e.g.
  // "20.1|430|26-04-08|8:51"). `inventorybalance` is location-level, so an
  // item can have multiple rows per location/flex combination.
  let balances;
  try {
    balances = await suiteQLAll(env, `
      SELECT
        ib.item AS item_internal_id,
        ib.quantityonhand,
        ib.quantityavailable,
        ib.committedqtyperlocation,
        ib.committedqtyperseriallotnumberlocation,
        invnum.inventorynumber AS flex_label
      FROM inventorybalance ib
      LEFT JOIN inventorynumber invnum ON invnum.id = ib.inventorynumber
    `);
  } catch (err) {
    throw new Error(`Q_BALANCES: ${String((err && err.message) || err)}`);
  }

  // Track committed-per-location once per (item, location) pair so we
  // don't double-count it across every flex row at that location.
  const committedSeen = new Set();

  for (const row of balances) {
    const itemid = itemIdByInternalId[row.item_internal_id];
    if (!itemid || !models[itemid]) continue; // not a pole model we're tracking
    const m = models[itemid];

    m.onHand += Number(row.quantityonhand) || 0;
    m.available += Number(row.quantityavailable) || 0;

    const commitKey = `${row.item_internal_id}`;
    // committedqtyperlocation repeats on every row for the same
    // item/location — only add it in the first time we see this item.
    if (!committedSeen.has(commitKey)) {
      committedSeen.add(commitKey);
      m.committed += Number(row.committedqtyperlocation) || 0;
    }

    if (row.flex_label) {
      m.flexes.push({
        f: row.flex_label,
        // "a" = available. A flex number specifically committed to a sales
        // order (committedqtyperseriallotnumberlocation > 0) shows as
        // unavailable even if the row's overall quantityavailable is > 0.
        a: (Number(row.committedqtyperseriallotnumberlocation) || 0) === 0
          && (Number(row.quantityavailable) || 0) > 0,
      });
    }
  }

  return [models, catalog];
}

async function buildOrders(env) {
  const orders = {};

  // Line-status filtering (isfullyshipped / isclosed / fulfillable) rather
  // than a t.status code guess — carried over from the earlier standalone
  // attempt's inventory.js, where it was already correct once the "Find
  // Transaction" permission was granted. openqty nets out already-shipped
  // quantity via quantityshiprecv, so it reflects what's truly still
  // pending, not just "any status that sounds open."
  let lines;
  try {
    lines = await suiteQLAll(env, `
      SELECT
        i.itemid,
        i.displayname,
        t.tranid AS so_num,
        ABS(NVL(tl.quantity, 0)) - NVL(tl.quantityshiprecv, 0) AS openqty,
        NVL(tl.quantitybackordered, 0) AS backordered
      FROM transactionline tl
      JOIN transaction t ON t.id = tl.transaction
      JOIN item i ON i.id = tl.item
      WHERE t.type = 'SalesOrd'
        AND tl.isfullyshipped = 'F'
        AND tl.isclosed = 'F'
        AND tl.fulfillable = 'T'
        AND tl.item IS NOT NULL
        AND i.isinactive = 'F'
        AND i.itemid LIKE '%/%'
    `);
  } catch (err) {
    // Surfaces as a top-level `warning` in the payload rather than failing
    // the whole request — the Available/Need-to-Make tabs still work off
    // `models` alone if this query breaks for some reason.
    orders.__warning = `orders query failed: ${String((err && err.message) || err)}`;
    return orders;
  }

  for (const row of lines) {
    const itemid = row.itemid;
    if (!itemid) continue;
    const openQty = Math.round(parseFloat(row.openqty) || 0);
    if (openQty <= 0) continue; // fully netted out — nothing actually pending

    if (!orders[itemid]) {
      orders[itemid] = {
        openQty: 0,
        committed: 0,
        available: 0,
        onHand: 0,
        display: row.displayname || itemid,
        description: '',
        soLines: [],
      };
    }
    const o = orders[itemid];
    const bo = Number(row.backordered) || 0;
    o.openQty += openQty;
    o.soLines.push({
      soNum: row.so_num,
      flex: null, // flex-number-to-SO-line assignment needs a separate
                  // inventory detail lookup; left blank until that's wired up
      qty: openQty,
      bo: bo > 0,
    });
  }

  return orders;
}

// ---------------------------------------------------------------------
// SuiteQL helper (handles pagination automatically)
// ---------------------------------------------------------------------

async function suiteQLAll(env, sql) {
  const pageSize = 1000;
  let pageIndex = 0;
  let all = [];
  for (;;) {
    const page = await suiteQLPage(env, sql, pageIndex, pageSize);
    all = all.concat(page.items);
    if (pageIndex + 1 >= page.totalPages || page.items.length === 0) break;
    pageIndex += 1;
  }
  return all;
}

async function suiteQLPage(env, sql, pageIndex, pageSize) {
  const accountId = env.NETSUITE_ACCOUNT_ID;
  const host = accountId.toLowerCase().replace(/_/g, '-');
  const url =
    `https://${host}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql` +
    `?limit=${pageSize}&offset=${pageIndex * pageSize}`;

  const authHeader = await buildOAuth1Header(env, 'POST', url);

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'prefer': 'transient',
      authorization: authHeader,
    },
    body: JSON.stringify({ q: sql }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`SuiteQL request failed (${resp.status}): ${text}`);
  }

  const json = await resp.json();
  const totalResults = json.totalResults ?? (json.items || []).length;
  const totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
  return { items: json.items || [], totalPages };
}

// ---------------------------------------------------------------------
// NetSuite Token-Based Authentication (OAuth 1.0a, HMAC-SHA256)
// ---------------------------------------------------------------------

async function buildOAuth1Header(env, method, url) {
  const accountId = env.NETSUITE_ACCOUNT_ID;
  const oauthParams = {
    oauth_consumer_key: env.NETSUITE_CONSUMER_KEY,
    oauth_token: env.NETSUITE_TOKEN_ID,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: cryptoRandomNonce(),
    oauth_version: '1.0',
  };

  const { baseUrl, queryParams } = splitUrl(url);
  const allParams = { ...oauthParams, ...queryParams };

  const baseString = buildSignatureBaseString(method, baseUrl, allParams);
  const signingKey =
    `${percentEncode(env.NETSUITE_CONSUMER_SECRET)}&${percentEncode(env.NETSUITE_TOKEN_SECRET)}`;
  const signature = await hmacSha256Base64(signingKey, baseString);

  const headerParams = {
    ...oauthParams,
    oauth_signature: signature,
    realm: accountId.toUpperCase(),
  };

  const headerStr = Object.entries(headerParams)
    .map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`)
    .join(', ');

  return `OAuth ${headerStr}`;
}

function splitUrl(url) {
  const u = new URL(url);
  const queryParams = {};
  for (const [k, v] of u.searchParams.entries()) queryParams[k] = v;
  u.search = '';
  return { baseUrl: u.toString(), queryParams };
}

function buildSignatureBaseString(method, baseUrl, params) {
  // OAuth 1.0a requires sorting by the percent-ENCODED key (byte-wise), not
  // the raw key — harmless here since none of our param names contain
  // characters that encoding would change, but doing it correctly in case
  // that ever changes.
  const encodedParams = Object.entries(params)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : (ak < bk ? -1 : 1)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return [
    method.toUpperCase(),
    percentEncode(baseUrl),
    percentEncode(encodedParams),
  ].join('&');
}

function percentEncode(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function cryptoRandomNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Base64(key, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return base64FromArrayBuffer(sig);
}

function base64FromArrayBuffer(buf) {
  let binary = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
