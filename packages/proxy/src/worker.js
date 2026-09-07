const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const CORS_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";

function corsHeaders(request) {
  const origin = request?.headers.get("Origin") || "*";
  const requested = request?.headers.get("Access-Control-Request-Headers");
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": CORS_METHODS,
    "Access-Control-Allow-Headers": requested || "*",
    "Access-Control-Expose-Headers": "*",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function parseAllowed(env, key) {
  const raw = env?.[key];
  if (!raw) return null;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function targetAllowed(targetUrl, allowedTargets) {
  if (!allowedTargets || allowedTargets.length === 0) return true;
  let host;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowedTargets.some((t) => host === t || host.endsWith(`.${t}`));
}

function originAllowed(request, allowedOrigins) {
  if (!allowedOrigins || allowedOrigins.length === 0) return true;
  const origin = (request.headers.get("Origin") || "").toLowerCase();
  if (!origin) return true;
  return allowedOrigins.includes(origin);
}

function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}

async function deviceHash(request) {
  const ip =
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Real-IP") ||
    "unknown";
  const ua = request.headers.get("User-Agent") || "unknown";
  const data = new TextEncoder().encode(ip + "|" + ua);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extractModel(request) {
  try {
    const ct = request.headers.get("Content-Type") || "";
    if (!ct.includes("json")) return null;
    // Can't read body twice, so we clone and parse
    return null; // Will be handled in the main flow where we have body access
  } catch {
    return null;
  }
}

async function parseModelFromBody(body) {
  try {
    const text = typeof body === "string" ? body : await body.text();
    const parsed = JSON.parse(text);
    return parsed.model || null;
  } catch {
    return null;
  }
}

// ─── Dashboard HTML ───────────────────────────────────────────

function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Office Agents — Analytics Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0d1117;color:#c9d1d9;padding:20px}
.login{max-width:400px;margin:80px auto;background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px}
.login h1{color:#58a6ff;font-size:1.4em;margin-bottom:16px;text-align:center}
.login input{width:100%;padding:12px;border-radius:8px;border:1px solid #30363d;background:#0d1117;color:#c9d1d9;font-size:1em;margin-bottom:12px}
.login button{width:100%;padding:12px;border-radius:8px;border:none;background:#238636;color:#fff;font-size:1em;font-weight:600;cursor:pointer}
.login button:hover{background:#2ea043}
.login .err{color:#f85149;font-size:0.85em;text-align:center;margin-top:8px;display:none}
.dashboard{display:none;max-width:1200px;margin:0 auto}
.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:24px}
.header h1{color:#58a6ff;font-size:1.6em}
.header .logout{background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:8px 16px;cursor:pointer;font-size:0.85em}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:20px}
.card .label{color:#8b949e;font-size:0.8em;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.card .value{color:#f0f6fc;font-size:2em;font-weight:700}
.card .sub{color:#8b949e;font-size:0.8em;margin-top:4px}
.chart-box{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:24px}
.chart-box h2{color:#f0f6fc;font-size:1.1em;margin-bottom:16px}
table{width:100%;border-collapse:collapse;font-size:0.85em}
th{text-align:left;padding:10px 12px;color:#8b949e;border-bottom:1px solid #30363d;text-transform:uppercase;font-size:0.75em;letter-spacing:1px}
td{padding:10px 12px;border-bottom:1px solid #21262d;color:#c9d1d9}
tr:hover td{background:#161b22}
.section{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:24px;margin-bottom:24px;overflow-x:auto}
.section h2{color:#f0f6fc;font-size:1.1em;margin-bottom:16px}
.pill{display:inline-block;padding:2px 10px;border-radius:12px;font-size:0.75em;font-weight:600}
.pill-green{background:#23863633;color:#3fb950}
.pill-red{background:#f8514933;color:#f85149}
.pill-blue{background:#1f6feb33;color:#58a6ff}
</style>
</head>
<body>
<div class="login" id="login">
<h1>Analytics Dashboard</h1>
<input type="password" id="pw" placeholder="Enter password" onkeydown="if(event.key==='Enter')doLogin()">
<button onclick="doLogin()">Login</button>
<div class="err" id="err">Wrong password</div>
</div>
<div class="dashboard" id="dash">
<div class="header">
<h1>Office Agents — Analytics</h1>
<div style="display:flex;align-items:center;gap:12px"><span id="lastUpdate" style="color:#8b949e;font-size:0.8em"></span><button class="logout" onclick="logout()">Logout</button></div>
</div>
<div class="cards" id="cards"></div>
<div class="chart-box">
<h2>Requests (last 14 days)</h2>
<canvas id="chart" height="80"></canvas>
</div>
<div class="section">
<h2>Devices</h2>
<table id="devicesTable"><thead><tr><th>Device</th><th>First Seen (GMT+7)</th><th>Last Seen (GMT+7)</th><th>Proxy Requests</th><th>Targets</th><th>Models</th><th>Visits</th><th>Downloads</th></tr></thead><tbody></tbody></table>
</div>
<div class="section">
<h2>Recent Proxy Requests (GMT+7)</h2>
<table id="proxyTable"><thead><tr><th>Time</th><th>Device</th><th>Target</th><th>Model</th><th>Status</th><th>Method</th></tr></thead><tbody></tbody></table>
</div>
<div class="section">
<h2>Recent Events — visits & downloads (GMT+7)</h2>
<table id="eventsTable"><thead><tr><th>Time</th><th>Type</th><th>Device</th><th>Detail</th></tr></thead><tbody></tbody></table>
</div>
</div>
<script>
let token=localStorage.getItem('oa_token');
if(token)showDash();

async function doLogin(){
const pw=document.getElementById('pw').value;
const r=await fetch('/dashboard/api',{headers:{'X-Auth':pw}});
if(r.ok){token=pw;localStorage.setItem('oa_token',token);showDash();}
else{document.getElementById('err').style.display='block';}
}

function logout(){localStorage.removeItem('oa_token');location.reload();}

let refreshTimer=null;
async function showDash(){
document.getElementById('login').style.display='none';
document.getElementById('dash').style.display='block';
await loadData();
if(refreshTimer)clearInterval(refreshTimer);
refreshTimer=setInterval(loadData,10000);
}

async function loadData(){
const r=await fetch('/dashboard/api',{headers:{'X-Auth':token}});
if(!r.ok){logout();return;}
const d=await r.json();
renderCards(d.summary);
renderChart(d.daily);
renderDevicesTable(d.devices);
renderProxyTable(d.recentProxy);
renderEventsTable(d.recentEvents);
const el=document.getElementById('lastUpdate');
if(el)el.textContent='Updated: '+new Date().toLocaleTimeString('en-GB',{timeZone:'Asia/Bangkok'});
}

function renderCards(s){
const cards=[
{label:'Total Proxy Requests',value:s.totalProxy,sub:'All time'},
{label:'Unique Devices',value:s.uniqueDevices,sub:'By device hash'},
{label:'Today\\'s Requests',value:s.todayProxy,sub:'Last 24h'},
{label:'Page Visits',value:s.visits,sub:'install.html views'},
{label:'Downloads',value:s.downloads,sub:'Installer downloads'},
];
document.getElementById('cards').innerHTML=cards.map(c=>
'<div class="card"><div class="label">'+c.label+'</div><div class="value">'+c.value+'</div><div class="sub">'+c.sub+'</div></div>'
).join('');
}

let chartInstance=null;
function renderChart(daily){
const ctx=document.getElementById('chart');
if(chartInstance)chartInstance.destroy();
chartInstance=new Chart(ctx,{type:'line',data:{
labels:daily.map(d=>d.date),
datasets:[{label:'Proxy Requests',data:daily.map(d=>d.count),borderColor:'#58a6ff',backgroundColor:'#58a6ff22',fill:true,tension:0.3}]
},options:{responsive:true,plugins:{legend:{labels:{color:'#c9d1d9'}}},scales:{x:{ticks:{color:'#8b949e'},grid:{color:'#21262d'}},y:{ticks:{color:'#8b949e'},grid:{color:'#21262d'},beginAtZero:true}}}});
}

function renderProxyTable(rows){
const tb=document.querySelector('#proxyTable tbody');
tb.innerHTML=rows.map(r=>
'<tr><td>'+r.ts+'</td><td title="'+r.device_hash+'">'+r.device_hash.slice(0,8)+'…</td><td>'+r.target_host+'</td><td>'+(r.model||'—')+'</td><td><span class="pill '+(r.status<400?'pill-green':'pill-red')+'">'+r.status+'</span></td><td>'+r.method+'</td></tr>'
).join('');
}

function renderDevicesTable(rows){
const tb=document.querySelector('#devicesTable tbody');
if(!rows.length){tb.innerHTML='<tr><td colspan=8 style="color:#8b949e;text-align:center">No devices yet</td></tr>';return;}
tb.innerHTML=rows.map(r=>
'<tr><td title="'+r.device_hash+'">'+r.device_hash.slice(0,12)+'…</td><td>'+r.first_seen+'</td><td>'+r.last_seen+'</td><td><strong>'+r.proxy_count+'</strong></td><td>'+r.targets+'</td><td>'+(r.models||'—')+'</td><td>'+(r.visits||0)+'</td><td>'+(r.downloads||0)+'</td></tr>'
).join('');
}

function renderEventsTable(rows){
const tb=document.querySelector('#eventsTable tbody');
tb.innerHTML=rows.map(r=>
'<tr><td>'+r.ts+'</td><td><span class="pill pill-blue">'+r.type+'</span></td><td title="'+(r.device_hash||'')+'">'+(r.device_hash||'—').slice(0,8)+'…</td><td>'+(r.detail||'—')+'</td></tr>'
).join('');
}
</script>
</body>
</html>`;
}

// ─── Dashboard API ────────────────────────────────────────────

async function dashboardAPI(request, env) {
  const auth = request.headers.get("X-Auth");
  const expected = env.DASHBOARD_PASSWORD || "";
  if (!expected || auth !== expected) {
    return json(401, { error: "Unauthorized" });
  }

  const db = env.ANALYTICS;
  if (!db) {
    return json(500, { error: "D1 not bound" });
  }

  const [
    totalProxyRes,
    uniqueDevicesRes,
    todayProxyRes,
    visitsRes,
    downloadsRes,
    dailyRes,
    recentProxyRes,
    recentEventsRes,
    devicesRes,
  ] = await Promise.all([
    db.prepare("SELECT COUNT(*) as c FROM proxy_requests").first(),
    db
      .prepare("SELECT COUNT(DISTINCT device_hash) as c FROM proxy_requests")
      .first(),
    db
      .prepare(
        "SELECT COUNT(*) as c FROM proxy_requests WHERE ts >= datetime('now', '-1 day', '+7 hours')",
      )
      .first(),
    db.prepare("SELECT COUNT(*) as c FROM events WHERE type='visit'").first(),
    db
      .prepare("SELECT COUNT(*) as c FROM events WHERE type='download'")
      .first(),
    db
      .prepare(
        `SELECT DATE(ts, '+7 hours') as date, COUNT(*) as count
         FROM proxy_requests
         WHERE ts >= datetime('now', '-14 days', '+7 hours')
         GROUP BY DATE(ts, '+7 hours') ORDER BY date`,
      )
      .all(),
    db
      .prepare(
        `SELECT datetime(ts, '+7 hours') as ts, device_hash, target_host, model, status, method
         FROM proxy_requests ORDER BY ts DESC LIMIT 50`,
      )
      .all(),
    db
      .prepare(
        `SELECT datetime(ts, '+7 hours') as ts, type, device_hash, detail
         FROM events ORDER BY ts DESC LIMIT 50`,
      )
      .all(),
    db
      .prepare(
        `SELECT
           pr.device_hash,
           MIN(datetime(pr.ts, '+7 hours')) as first_seen,
           MAX(datetime(pr.ts, '+7 hours')) as last_seen,
           COUNT(pr.id) as proxy_count,
           COUNT(DISTINCT pr.target_host) as targets,
           GROUP_CONCAT(DISTINCT pr.model) as models,
           ev.visits,
           ev.downloads
         FROM proxy_requests pr
         LEFT JOIN (
           SELECT device_hash,
             SUM(CASE WHEN type='visit' THEN 1 ELSE 0 END) as visits,
             SUM(CASE WHEN type='download' THEN 1 ELSE 0 END) as downloads
           FROM events GROUP BY device_hash
         ) ev ON ev.device_hash = pr.device_hash
         GROUP BY pr.device_hash
         ORDER BY last_seen DESC`,
      )
      .all(),
  ]);

  return json(200, {
    summary: {
      totalProxy: totalProxyRes?.c || 0,
      uniqueDevices: uniqueDevicesRes?.c || 0,
      todayProxy: todayProxyRes?.c || 0,
      visits: visitsRes?.c || 0,
      downloads: downloadsRes?.c || 0,
    },
    daily: dailyRes.results || [],
    recentProxy: recentProxyRes.results || [],
    recentEvents: recentEventsRes.results || [],
    devices: devicesRes.results || [],
  });
}

// ─── Track endpoint ───────────────────────────────────────────

async function trackEndpoint(request, env) {
  const url = new URL(request.url);
  const type = url.searchParams.get("type") || "unknown";
  const detail = url.searchParams.get("detail") || url.searchParams.get("file") || null;
  const dh = await deviceHash(request);

  try {
    await env.ANALYTICS.prepare(
      "INSERT INTO events (type, device_hash, detail) VALUES (?, ?, ?)",
    )
      .bind(type, dh, detail)
      .run();
  } catch {}

  return new Response(null, { status: 204 });
}

// ─── Main Worker ──────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Dashboard routes
    if (url.pathname === "/dashboard") {
      return new Response(dashboardHTML(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    if (url.pathname === "/dashboard/api") {
      return dashboardAPI(request, env);
    }

    // Tracking beacon
    if (url.pathname === "/track") {
      const cors = corsHeaders(request);
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors });
      }
      return trackEndpoint(request, env);
    }

    // CORS proxy
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    const allowedOrigins = parseAllowed(env, "ALLOWED_ORIGINS");
    if (!originAllowed(request, allowedOrigins)) {
      return json(403, { error: "Origin not allowed" }, cors);
    }

    let target = url.searchParams.get("url");
    if (!target && url.pathname.length > 1) {
      target = decodeURIComponent(url.pathname.slice(1));
    }

    if (!target) {
      return json(400, { error: "Missing target URL. Pass ?url=<encoded>" }, cors);
    }

    try {
      new URL(target);
    } catch {
      return json(400, { error: "Invalid target URL" }, cors);
    }

    if (!/^https?:\/\//i.test(target)) {
      return json(400, { error: "Only http(s) targets are supported" }, cors);
    }

    const allowedTargets = parseAllowed(env, "ALLOWED_TARGETS");
    if (!targetAllowed(target, allowedTargets)) {
      return json(403, { error: "Target host not allowed" }, cors);
    }

    const targetUrl = new URL(target);

    // Parse model from request body for logging
    let model = null;
    let bodyClone = null;
    if (request.method === "POST") {
      try {
        bodyClone = await request.clone().text();
        const parsed = JSON.parse(bodyClone);
        model = parsed.model || null;
      } catch {}
    }

    const forwardHeaders = new Headers();
    for (const [key, value] of request.headers.entries()) {
      if (HOP_BY_HOP.has(key.toLowerCase())) continue;
      const lower = key.toLowerCase();
      if (lower === "authorization") {
        const v = value.trim();
        if (
          !v ||
          v === "Bearer" ||
          v === "Bearer undefined" ||
          v === "Bearer null" ||
          v === "Bearer " ||
          v === "Bearer __free_no_key__"
        )
          continue;
        if (/^Bearer\s*$/i.test(v)) continue;
        if (v.includes("__free_no_key__")) continue;
      }
      if (lower === "x-api-key" && !value.trim()) continue;
      forwardHeaders.set(key, value);
    }
    forwardHeaders.set("Host", targetUrl.host);

    const init = {
      method: request.method,
      headers: forwardHeaders,
      redirect: "follow",
    };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = bodyClone || request.body;
    }

    let status = 0;
    try {
      const upstream = await fetch(target, init);
      status = upstream.status;

      // Log to D1 (fire and forget)
      const dh = await deviceHash(request);
      const targetHost = targetUrl.hostname;
      try {
        await env.ANALYTICS.prepare(
          "INSERT INTO proxy_requests (device_hash, target_host, model, status, method) VALUES (?, ?, ?, ?, ?)",
        )
          .bind(dh, targetHost, model, status, request.method)
          .run();
      } catch {}

      const responseHeaders = new Headers(upstream.headers);
      for (const [key, value] of Object.entries(cors)) {
        responseHeaders.set(key, value);
      }

      const contentType = upstream.headers.get("Content-Type") || "";
      const isSSE = contentType.includes("text/event-stream");

      if (isSSE && upstream.body) {
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders,
        });
      }

      return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: responseHeaders,
      });
    } catch (err) {
      // Log error to D1
      const dh = await deviceHash(request);
      try {
        await env.ANALYTICS.prepare(
          "INSERT INTO proxy_requests (device_hash, target_host, model, status, method) VALUES (?, ?, ?, ?, ?)",
        )
          .bind(dh, targetUrl.hostname, model, 502, request.method)
          .run();
      } catch {}

      return json(
        502,
        { error: "Upstream fetch failed", detail: String(err?.message || err) },
        cors,
      );
    }
  },
};
