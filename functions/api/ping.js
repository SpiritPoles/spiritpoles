// functions/api/ping.js
// Health check — confirms Cloudflare Pages Functions are active
export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
