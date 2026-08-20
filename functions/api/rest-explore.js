// functions/api/rest-explore.js
// Temporary diagnostic — probes what the plain REST Record API (NOT SuiteQL)
// can give us, since SuiteQL is blocked account-wide for TBA regardless of
// role (confirmed: custom role, CEO, and Production Manager Power User all
// fail identically on a zero-dependency `SELECT 1 FROM DUAL`).
//
// Goal: figure out if we can rebuild the inventory app's data feed using
// only REST Record API list/expand calls, bypassing SuiteQL entirely.
// Safe to delete once we've learned what we need.
//
// ROUND 4: uses a SEPARATE, test-only Access Token (TEST_NETSUITE_TOKEN_ID /
// TEST_NETSUITE_TOKEN_SECRET) issued under the "Versapay Integration Role" —
// a role with a real, working REST Web Services + Log in using Access Tokens
// grant on this account — instead of our own role. Same Integration record
// (same NETSUITE_ACCOUNT_ID / NETSUITE_CONSUMER_KEY / NETSUITE_CONSUMER_SECRET),
// only the token+role differs. Deliberately does NOT touch the production
// NETSUITE_TOKEN_ID/SECRET so the live single-record GET calls used by
// so/[soNumber].js and if/[ifNumber].js keep working during this test.

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
  // Uses the TEST token (Versapay Integration Role) — NOT the production
  // NETSUITE_TOKEN_ID/SECRET — so this diagnostic can't affect the live
  // single-record GET calls other endpoints depend on.
  const tokenId = env.TEST_NETSUITE_TOKEN_ID;
  const tokenSecret = env.TEST_NETSUITE_TOKEN_SECRET;
  const oauthParams = {
    oauth_consumer_key: env.NETSUITE_CONSUMER_KEY,
    oauth_token: tokenId,
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
  const signingKey = `${percentEncode(env.NETSUITE_CONSUMER_SECRET)}&${percentEncode(tokenSecret)}`;
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

  if (!env.TEST_NETSUITE_TOKEN_ID || !env.TEST_NETSUITE_TOKEN_SECRET) {
    return new Response(JSON.stringify({
      error: 'TEST_NETSUITE_TOKEN_ID / TEST_NETSUITE_TOKEN_SECRET not set. Add them as ' +
        'Cloudflare Pages Secrets (Production) with the Versapay-Integration-Role access ' +
        "token's values, then redeploy.",
    }), { status: 500, headers: CORS });
  }

  const results = [];

  // ROUNDS 1-3 findings (bare list, q= filter, single-record GET) are
  // covered in prior commits of this file — see git history. Every
  // collection LIST/SEARCH failed with "does not have permission" under
  // our own role, CEO, and Production Manager Power User; single-record
  // GET by known ID always succeeded.
  //
  // ROUND 4: same two tests (single-record GET + bare list), but signed
  // with a token issued under the "Versapay Integration Role" — a role
  // with a genuinely working REST Web Services grant on this account —
  // instead of any of our own roles. If salesorder_bare_list succeeds
  // here, the block is role-specific after all. If it still fails, the
  // restriction is tied to something else entirely (the Integration
  // record, or truly account-wide for TBA).

  results.push(await tryFetch(
    env, 'salesorder_get_by_id__versapay_role',
    `${host}/services/rest/record/v1/salesorder/198361`,
    'GET'
  ));

  results.push(await tryFetch(
    env, 'salesorder_bare_list__versapay_role',
    `${host}/services/rest/record/v1/salesorder?limit=3`,
    'GET'
  ));

  results.push(await tryFetch(
    env, 'inventoryitem_bare_list__versapay_role',
    `${host}/services/rest/record/v1/inventoryitem?limit=3`,
    'GET'
  ));

  // ROUND 5: TEST_NETSUITE_TOKEN_ID/SECRET now point at the reissued
  // production-role token (Perform Search added, fresh token = confirmed
  // fixed for bare list). Two open questions left:
  //  (a) Does the `q=` filter work now too, not just bare/unfiltered list?
  //      This is what we need to fetch only OPEN sales orders instead of
  //      paging through all ~3000.
  //  (b) Is SuiteQL still blocked even for this now-working token/role, or
  //      did fixing search fix SuiteQL too?
  results.push(await tryFetch(
    env, 'salesorder_q_filter__fixed_role',
    `${host}/services/rest/record/v1/salesorder?limit=3&q=mainline IS "T" AND status IS "SalesOrd:B"`,
    'GET'
  ));

  results.push(await tryFetch(
    env, 'suiteql_dual__fixed_role',
    `${host}/services/rest/query/v1/suiteql?limit=1&offset=0`,
    'POST',
    { q: 'SELECT 1 AS one FROM DUAL' }
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
