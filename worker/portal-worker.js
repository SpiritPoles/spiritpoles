/**
 * UCS Spirit Portal — Cloudflare Worker
 * ─────────────────────────────────────
 * Serves a personalized portal page based on the authenticated user's
 * email address (passed by Cloudflare Access via the Cf-Access-Jwt-Assertion header).
 *
 * ACCESS TIERS
 * ────────────
 * Add email addresses to the appropriate tier below.
 * Users not listed in any tier are denied access.
 *
 * Tier 1 — Admin    : All apps + admin tools
 * Tier 2 — Coach    : Coaching tools (flex lookup, sizing guide, inventory)
 * Tier 3 — Staff    : Limited access (e.g. order tracker only)
 */

// ── Access tiers ──────────────────────────────────────────────────────────────
const ACCESS = {
  admin: [
    'chrischappell@ucsspirit.com',
    'think4sport@gmail.com',
  ],
  coach: [
    // Add coach email addresses here
    // 'coach1@email.com',
    // 'coach2@email.com',
  ],
  staff: [
    // Add staff email addresses here
    // 'staff1@email.com',
  ],
};

// ── App definitions ───────────────────────────────────────────────────────────
// visibleTo: array of tiers that can see this tile
const APPS = [
  {
    id: 'flex-lookup',
    name: 'Pole Flex Lookup',
    desc: 'Look up model, weight rating, and tip size for any pole length and flex number.',
    icon: '🏋️',
    href: '/apps/flex-lookup/',
    status: 'live',
    visibleTo: ['admin', 'coach', 'staff'],
  },
  {
    id: 'inventory',
    name: 'Inventory Lookup',
    desc: 'Check live pole availability by length, flex, and weight rating.',
    icon: '📦',
    href: '/apps/inventory/',
    status: 'soon',
    visibleTo: ['admin', 'coach'],
  },
  {
    id: 'order-tracker',
    name: 'Order Tracker',
    desc: 'Track inbound orders and shipment status for your account.',
    icon: '📋',
    href: '/apps/order-tracker/',
    status: 'soon',
    visibleTo: ['admin', 'staff'],
  },
  {
    id: 'sizing-guide',
    name: 'Pole Sizing Guide',
    desc: 'Recommended pole specs based on athlete weight and PR height.',
    icon: '📐',
    href: '/apps/sizing-guide/',
    status: 'soon',
    visibleTo: ['admin', 'coach'],
  },
];

// ── Worker entry ──────────────────────────────────────────────────────────────
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Only intercept the portal root — pass everything else through
    if (url.pathname !== '/' && url.pathname !== '/index.html') {
      return fetch(request);
    }

    // Get authenticated email from Cloudflare Access JWT
    const email = getEmailFromJWT(request);
    if (!email) {
      return new Response('Unauthorized', { status: 401 });
    }

    const tier = getTier(email);
    if (!tier) {
      return new Response('Access denied.', { status: 403 });
    }

    const visibleApps = APPS.filter(app => app.visibleTo.includes(tier));
    return new Response(buildPortalHTML(email, tier, visibleApps), {
      headers: { 'Content-Type': 'text/html;charset=UTF-8' },
    });
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function getTier(email) {
  for (const [tier, emails] of Object.entries(ACCESS)) {
    if (emails.includes(email.toLowerCase())) return tier;
  }
  return null;
}

function getEmailFromJWT(request) {
  // Cloudflare Access passes the JWT in this header
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!jwt) return null;
  try {
    const payload = JSON.parse(atob(jwt.split('.')[1]));
    return payload.email || null;
  } catch {
    return null;
  }
}

function buildPortalHTML(email, tier, apps) {
  const tileSections = apps.map(app => {
    const soon = app.status === 'soon';
    return `
    <a class="tile${soon ? ' soon' : ''}" ${soon ? '' : `href="${app.href}"`}>
      <span class="tile-shine"></span>
      <span class="tile-icon">${app.icon}</span>
      ${soon ? '<div class="tile-badge">Coming Soon</div>' : ''}
      <div class="tile-name">${app.name}</div>
      <div class="tile-desc">${app.desc}</div>
    </a>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>UCS Spirit — Coach Portal</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{min-height:100%;font-family:system-ui,-apple-system,sans-serif;background:#0e0b12;color:#e8e0d0}
#portal{max-width:900px;margin:0 auto;padding:40px 20px 60px}
.portal-hdr{text-align:center;margin-bottom:40px}
#portal-logo{display:block;margin:0 auto 16px;width:240px;height:auto}
.portal-rule{height:1px;background:linear-gradient(90deg,transparent,#E8127D,transparent);margin:0 auto 12px;max-width:300px}
.portal-title{font-size:11px;font-weight:800;letter-spacing:.25em;text-transform:uppercase;color:rgba(232,18,125,0.5)}
.user-chip{display:inline-block;margin-top:10px;font-size:11px;font-weight:700;color:rgba(255,255,255,0.3);background:rgba(255,255,255,0.05);border-radius:20px;padding:4px 12px}
.section-label{font-size:10px;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:rgba(255,255,255,0.25);margin-bottom:14px;padding-left:2px}
.tile-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:16px;margin-bottom:40px}
.tile{background:#141117;border:1px solid rgba(255,255,255,0.07);border-top-color:rgba(255,255,255,0.13);border-radius:16px;padding:24px 20px 20px;cursor:pointer;text-decoration:none;display:block;transition:all .18s;position:relative;overflow:hidden}
.tile:hover{border-color:rgba(232,18,125,0.35);transform:translateY(-2px);box-shadow:0 8px 32px rgba(232,18,125,0.1)}
.tile-icon{font-size:28px;margin-bottom:14px;display:block}
.tile-name{font-size:14px;font-weight:800;color:#ede6d8;margin-bottom:6px}
.tile-desc{font-size:12px;font-weight:600;color:rgba(255,255,255,0.35);line-height:1.45}
.tile-badge{position:absolute;top:14px;right:14px;font-size:9px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;background:rgba(232,18,125,0.12);color:rgba(232,18,125,0.7);border:1px solid rgba(232,18,125,0.2);border-radius:20px;padding:3px 8px}
.tile-shine{position:absolute;top:0;left:-80%;width:50%;height:100%;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.035),transparent);animation:sh 4s infinite}
@keyframes sh{0%{left:-80%}40%{left:130%}100%{left:130%}}
.tile.soon{cursor:default;opacity:.5}
.tile.soon:hover{border-color:rgba(255,255,255,0.07);transform:none;box-shadow:none}
.footer{text-align:center;font-size:10px;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:rgba(255,255,255,0.15);padding-top:24px;border-top:1px solid rgba(255,255,255,0.05)}
</style>
</head>
<body>
<div id="portal">
  <div class="portal-hdr">
    <img id="portal-logo" src="/apps/flex-lookup/ucs-spirit-logo.png" alt="UCS Spirit">
    <div class="portal-rule"></div>
    <div class="portal-title">Coach Portal</div>
    <div class="user-chip">${email}</div>
  </div>
  <div class="section-label">Your Tools</div>
  <div class="tile-grid">${tileSections}</div>
  <div class="footer">UCS Spirit &nbsp;◆&nbsp; Trusted &nbsp;◆&nbsp; Dependable &nbsp;◆&nbsp; Proven</div>
</div>
</body>
</html>`;
}
