// functions/api/env-check.js
// Confirms which env vars are present — shows length + first 8 chars of token vars for debugging
export async function onRequestGet({ env }) {
  const keys = ['NS_ACCOUNT_ID', 'NS_CONSUMER_KEY', 'NS_CONSUMER_SECRET', 'NS_TOKEN_ID', 'NS_TOKEN_SECRET'];
  const result = {};
  for (const k of keys) {
    if (!env[k]) { result[k] = 'MISSING'; continue; }
    const showPrefix = ['NS_TOKEN_ID', 'NS_TOKEN_SECRET', 'NS_CONSUMER_KEY'].includes(k);
    const preview = showPrefix
      ? `set (${env[k].length} chars, starts: ${env[k].substring(0, 8)}...)`
      : `set (${env[k].length} chars)`;
    result[k] = preview;
  }
  return new Response(JSON.stringify(result, null, 2), {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
