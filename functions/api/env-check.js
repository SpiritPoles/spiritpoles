// functions/api/env-check.js
// Confirms which env vars are present (values NOT exposed — only presence)
export async function onRequestGet({ env }) {
  const keys = ['NS_ACCOUNT_ID', 'NS_CONSUMER_KEY', 'NS_CONSUMER_SECRET', 'NS_TOKEN_ID', 'NS_TOKEN_SECRET'];
  const result = {};
  for (const k of keys) {
    result[k] = env[k] ? `set (${env[k].length} chars)` : 'MISSING';
  }
  return new Response(JSON.stringify(result, null, 2), {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
