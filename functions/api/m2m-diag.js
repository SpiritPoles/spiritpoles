// functions/api/m2m-diag.js
// Diagnostic for the NEW OAuth 2.0 Client Credentials (Machine-to-Machine) auth
// path — a completely separate authentication mechanism from the OAuth 1.0a
// Token-Based Authentication (TBA) used everywhere else in this backend.
//
// Why this exists: TBA showed an account-side bug this session where REST
// Record API list/search (and SuiteQL) intermittently returned "does not have
// permission" even after the "Perform Search" permission fix — same token,
// same role, no config changes, flipping between success and failure on
// immediate retries. M2M uses short-lived (60-min) tokens signed fresh via a
// private-key JWT assertion instead of a long-lived Access Token record, which
// may sidestep whatever permission-snapshot/caching issue TBA is hitting.
//
// This does NOT touch TBA credentials or any production endpoint. It only
// reads via a brand-new NetSuite integration auth path (Client Credentials
// grant, role "UCS Spirit - AI Apps Connector", certificate mapping created
// 2026-08-20). Safe to delete once we've learned what we need.
//
// Required Cloudflare Pages Secrets (Production), NOT yet set as of writing:
//   NETSUITE_M2M_CLIENT_ID   - the integration's "Consumer Key / Client ID"
//                              (same value shown once on the Integration
//                              record's Client Credentials section)
//   NETSUITE_M2M_CERT_ID     - the Certificate ID from the OAuth 2.0 Client
//                              Credentials (M2M) Setup mapping (the `kid`)
//   NETSUITE_M2M_PRIVATE_KEY - the PEM private key matching the certificate
//                              uploaded to that mapping (RSA-4096, PSS)
// Reuses the existing NETSUITE_ACCOUNT_ID secret.

const CORS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
};

function base64urlFromBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlFromString(str) {
  return base64urlFromBytes(new TextEncoder().encode(str));
}

function pemToDer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importM2MPrivateKey(env) {
  const der = pemToDer(env.NETSUITE_M2M_PRIVATE_KEY);
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSA-PSS', hash: 'SHA-256' },
    false,
    ['sign']
  );
}

// Builds the client_assertion JWT per NetSuite's "The Request Token
// Structure" spec: header {typ, alg: PS256, kid: <Certificate ID>},
// payload {iss: <Client ID>, scope: [...], aud: <token endpoint>, exp, iat}.
async function buildM2MAssertion(env, tokenUrl) {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: 'JWT', alg: 'PS256', kid: env.NETSUITE_M2M_CERT_ID };
  const payload = {
    iss: env.NETSUITE_M2M_CLIENT_ID,
    scope: ['rest_webservices'],
    aud: tokenUrl,
    exp: now + 3300, // 55 min — must be < 60 min past iat per spec
    iat: now,
  };
  const encHeader = base64urlFromString(JSON.stringify(header));
  const encPayload = base64urlFromString(JSON.stringify(payload));
  const signingInput = `${encHeader}.${encPayload}`;
  const key = await importM2MPrivateKey(env);
  const sig = await crypto.subtle.sign(
    { name: 'RSA-PSS', saltLength: 32 },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${base64urlFromBytes(new Uint8Array(sig))}`;
}

async function getM2MAccessToken(env) {
  const acct = env.NETSUITE_ACCOUNT_ID;
  const tokenUrl = `https://${acct}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`;
  const assertion = await buildM2MAssertion(env, tokenUrl);
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: assertion,
  });
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status} ${text.substring(0, 800)}`);
  const json = JSON.parse(text);
  return json.access_token;
}

async function tryFetch(label, url, method, accessToken, body) {
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${accessToken}`,
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

  if (!env.NETSUITE_M2M_PRIVATE_KEY || !env.NETSUITE_M2M_CERT_ID || !env.NETSUITE_M2M_CLIENT_ID) {
    return new Response(JSON.stringify({
      error: 'Missing NETSUITE_M2M_PRIVATE_KEY / NETSUITE_M2M_CERT_ID / NETSUITE_M2M_CLIENT_ID ' +
        'Cloudflare Pages Secrets (Production). Add them and redeploy.',
    }), { status: 500, headers: CORS });
  }

  const results = [];
  let accessToken;
  try {
    accessToken = await getM2MAccessToken(env);
    results.push({ label: 'token_request', status: 'OK', body: `access token acquired (len ${accessToken.length})` });
  } catch (err) {
    results.push({ label: 'token_request', status: 'ERROR', body: String((err && err.message) || err) });
    return new Response(JSON.stringify({ account: acct, results }, null, 2), { status: 200, headers: CORS });
  }

  // Repeat the bare list call 3x in a row — this is the exact request that
  // flipped between 200 and "does not have permission" under TBA with zero
  // config changes in between. If M2M is genuinely more reliable, all 3
  // should succeed identically.
  for (let i = 1; i <= 3; i++) {
    results.push(await tryFetch(
      `salesorder_bare_list__m2m_attempt${i}`,
      `${host}/services/rest/record/v1/salesorder?limit=3`,
      'GET', accessToken
    ));
  }

  results.push(await tryFetch(
    'inventoryitem_bare_list__m2m',
    `${host}/services/rest/record/v1/inventoryitem?limit=3`,
    'GET', accessToken
  ));

  results.push(await tryFetch(
    'salesorder_get_by_id__m2m',
    `${host}/services/rest/record/v1/salesorder/198361`,
    'GET', accessToken
  ));

  results.push(await tryFetch(
    'suiteql_dual__m2m',
    `${host}/services/rest/query/v1/suiteql?limit=1&offset=0`,
    'POST', accessToken,
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
