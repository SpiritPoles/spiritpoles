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

  // 1. Does a plain list of inventoryitem work, and what shape does
  //    expandSubResources give us for per-location quantities?
  results.push(await tryFetch(
    env, 'inventoryitem_list_expand',
    `${host}/services/rest/record/v1/inventoryitem?limit=2&expandSubResources=true`,
    'GET'
  ));

  // 2. Does the "inventorynumber" (serial/lot/flex #) record type exist as
  //    a top-level REST resource at all?
  results.push(await tryFetch(
    env, 'inventorynumber_list',
    `${host}/services/rest/record/v1/inventorynumber?limit=2`,
    'GET'
  ));

  // 3. Does the REST Record API's simple query language (q=) work for
  //    salesorder, independent of the blocked SuiteQL endpoint?
  results.push(await tryFetch(
    env, 'salesorder_q_filter',
    `${host}/services/rest/record/v1/salesorder?limit=2&q=status IS "SalesOrd:B"`,
    'GET'
  ));

  // 4. Does a list-level expandSubResources inline the "item" sublist
  //    (line items) for salesorder, or only expand simple sub-objects?
  results.push(await tryFetch(
    env, 'salesorder_list_expand',
    `${host}/services/rest/record/v1/salesorder?limit=1&expandSubResources=true`,
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
