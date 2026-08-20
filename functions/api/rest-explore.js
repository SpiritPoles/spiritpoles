// functions/api/rest-explore.js
// Temporary diagnostic — probes what the plain REST Record API (NOT SuiteQL)
// can give us, since SuiteQL is blocked account-wide for TBA regardless of
// role (confirmed: custom role, CEO, and Production Manager Power User all
// fail identically on a zero-dependency `SELECT 1 FROM DUAL`).
//
// Goal: figure out if we can rebuild the inventory app's data feed using
// only REST Record API list/expand calls, bypassing SuiteQL entirely.
// Safe to delete once we've learned what we need.

const CORS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

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
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  let binary = '';
  const bytes = new Uint8Array(sig);
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function splitUrl(url) {
  const u = new URL(url);
  const queryParams = {};
  for (const [k, v] of u.searchParams.entries()) queryParams[k] = v;
  u.search = '';
  return { baseUrl: u.toString(), queryParams };
}

async function buildOAuth1Header(env, method, url) {
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
  const encodedParams = Object.entries(allParams)
    .map(([k, v]) => [percentEncode(k), percentEncode(v)])
    .sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : (ak < bk ? -1 : 1)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const baseString = [method.toUpperCase(), percentEncode(baseUrl), percentEncode(encodedParams)].join('&');
  const signingKey = `${percentEncode(env.NETSUITE_CONSUMER_SECRET)}&${percentEncode(env.NETSUITE_TOKEN_SECRET)}`;
  const signature = await hmacSha256Base64(signingKey, baseString);
  const headerParams = { ...oauthParams, oauth_signature: signature, realm: env.NETSUITE_ACCOUNT_ID };
  return 'OAuth ' + Object.entries(headerParams).map(([k, v]) => `${percentEncode(k)}="${percentEncode(v)}"`).join(', ');
}

async function tryFetch(env, label, url, method, body) {
  try {
    const auth = await buildOAuth1Header(env, method, url);
    const resp = await fetch(url, {
      method,
      headers: {
        authorization: auth,
        'content-type': 'application/json',
        ...(method === 'POST' ? { prefer: 'transient' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text();
    return { label, status: resp.status, body: text.substring(0, 1500) };
  } catch (err) {
    return { label, status: 'EXCEPTION', body: String((err && err.message) || err) };
  }
}

export async function onRequestGet({ env }) {
  const acct = env.NETSUITE_ACCOUNT_ID;
  const host = `https://${acct}.suitetalk.api.netsuite.com`;
  const results = [];

  // ROUND 1 FINDINGS (kept as comments for reference, not re-tested):
  //  - Collection LIST endpoints (?limit=, ?q=) fail with the SAME
  //    "does not have permission" error as SuiteQL — for BOTH
  //    inventorynumber (no explicit permission granted) AND salesorder
  //    (which DOES have View permission granted on the role). This means
  //    LIST/SEARCH-style REST calls are blocked account-wide, same as
  //    SuiteQL — not just a missing role permission.
  //  - expandSubResources is invalid on collection endpoints (only valid
  //    on a single-record GET by ID) — that was a test-writing mistake,
  //    not a real signal.
  //
  // ROUND 2: test single-record GET BY KNOWN INTERNAL ID — the one
  // pattern used by so/[soNumber].js and if/[ifNumber].js's REST calls,
  // which has NEVER actually been proven to work under the new role
  // (earlier "success" was a 404 on an invalid generic type name, not a
  // real record). IDs below pulled via the working Claude-connected
  // NetSuite tool: item 235/25 = internal id 2260, SO33963 = internal id
  // 198361.

  results.push(await tryFetch(
    env, 'inventoryitem_get_by_id',
    `${host}/services/rest/record/v1/inventoryitem/2260`,
    'GET'
  ));

  results.push(await tryFetch(
    env, 'inventoryitem_get_by_id_expand',
    `${host}/services/rest/record/v1/inventoryitem/2260?expandSubResources=true`,
    'GET'
  ));

  results.push(await tryFetch(
    env, 'salesorder_get_by_id',
    `${host}/services/rest/record/v1/salesorder/198361`,
    'GET'
  ));

  results.push(await tryFetch(
    env, 'salesorder_get_by_id_expand',
    `${host}/services/rest/record/v1/salesorder/198361?expandSubResources=true`,
    'GET'
  ));

  return new Response(JSON.stringify({ account: acct, results }, null, 2), { status: 200, headers: CORS });
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
