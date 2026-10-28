const enc = new TextEncoder();
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });

function cors(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = origin && origin === (env.PANEL_ORIGIN || "");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Vary": "Origin"
  };
}
function response(data, request, env, status = 200, extra = {}) {
  return json(data, status, { ...cors(request, env), ...extra });
}
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(value));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
}
function cookieValue(request, name) {
  const raw = request.headers.get("Cookie") || "";
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}
function cookie(token, maxAge) {
  return `bcc_session=${token}; HttpOnly; Secure; SameSite=None; Path=/; Max-Age=${maxAge}`;
}
async function session(request, env) {
  const token = cookieValue(request, "bcc_session");
  if (!token) return false;
  const hash = await sha256(token);
  const row = await env.DB.prepare("SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > datetime('now')").bind(hash).first();
  return !!row;
}
async function requireSession(request, env) {
  return await session(request, env);
}
async function alert(env, message) {
  if (!env.ALERT_BOT_TOKEN || !env.ALERT_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.ALERT_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.ALERT_CHAT_ID, text: message.slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000)
    });
  } catch { /* alert failures must not break monitoring */ }
}
async function incident(env, bot, status, detail) {
  const previous = await env.DB.prepare("SELECT last_alert_status FROM alert_state WHERE bot_id = ?").bind(bot.id).first();
  if (previous?.last_alert_status !== status) {
    await alert(env, `${status === "healthy" ? "✅ RECOVERED" : "🚨 BOT ALERT"}\nBot: ${bot.name}\nStatus: ${status}\nDetail: ${String(detail || "").slice(0, 700)}\nAt: ${new Date().toISOString()}`);
    await env.DB.prepare(`INSERT INTO alert_state (bot_id,last_alert_status,last_alert_at) VALUES (?,?,datetime('now'))
      ON CONFLICT(bot_id) DO UPDATE SET last_alert_status=excluded.last_alert_status,last_alert_at=excluded.last_alert_at`)
      .bind(bot.id, status).run();
  }
}
async function handleTelemetry(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token.length < 32) return json({ ok: false, error: "Unauthorized" }, 401);
  const hash = await sha256(token);
  const bot = await env.DB.prepare("SELECT id,name,status FROM bots WHERE telemetry_token_hash = ? AND enabled = 1").bind(hash).first();
  if (!bot) return json({ ok: false, error: "Unauthorized" }, 401);
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }
  const event = String(body.event || "heartbeat").slice(0, 80);
  const severity = ["info", "warning", "error", "critical"].includes(body.severity) ? body.severity : "info";
  const message = String(body.message || event).slice(0, 1000);
  const source = String(body.source || "worker").slice(0, 100);
  const groupId = body.group_id == null ? null : String(body.group_id).slice(0, 100);
  const metadata = JSON.stringify(body.metadata && typeof body.metadata === "object" ? body.metadata : {}).slice(0, 2000);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO telemetry_events (bot_id,event,severity,message,source,group_id,metadata_json) VALUES (?,?,?,?,?,?,?)").bind(bot.id,event,severity,message,source,groupId,metadata),
    env.DB.prepare("UPDATE bots SET last_heartbeat_at=datetime('now'), status=?, last_error=? WHERE id=?").bind(
      severity === "error" || severity === "critical" ? "degraded" : "healthy",
      severity === "error" || severity === "critical" ? message : null,
      bot.id
    )
  ]);
  if (severity === "error" || severity === "critical") await incident(env, bot, "degraded", message);
  else if (bot.status !== "healthy") await incident(env, bot, "healthy", "Telemetry received successfully");
  return json({ ok: true });
}
async function scheduledChecks(env) {
  const { results: bots } = await env.DB.prepare("SELECT id,name,health_url,status,last_heartbeat_at FROM bots WHERE enabled=1").all();
  const now = Date.now();
  for (const bot of bots) {
    let status = "unknown", detail = "No health URL configured", code = null, latency = null, ok = false;
    if (bot.health_url) {
      const start = Date.now();
      try {
        const url = new URL(bot.health_url);
        if (url.protocol !== "https:") throw new Error("Health URL must use HTTPS");
        const res = await fetch(url.toString(), { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8000) });
        code = res.status;
        latency = Date.now() - start;
        ok = res.status >= 200 && res.status < 300;
        status = ok ? "healthy" : "degraded";
        detail = `HTTP ${res.status}, ${latency} ms`;
        await res.body?.cancel();
      } catch (e) {
        latency = Date.now() - start;
        status = "degraded";
        detail = String(e?.message || "Health check failed").slice(0, 500);
      }
      await env.DB.prepare("INSERT INTO health_checks (bot_id,ok,status_code,latency_ms,detail) VALUES (?,?,?,?,?)")
        .bind(bot.id, ok ? 1 : 0, code, latency, detail).run();
      await env.DB.prepare("UPDATE bots SET last_health_at=datetime('now'),last_health_code=?,status=?,last_error=? WHERE id=?")
        .bind(code, status, ok ? null : detail, bot.id).run();
      await incident(env, bot, status, detail);
    }
    const fresh = await env.DB.prepare("SELECT last_heartbeat_at FROM bots WHERE id=?").bind(bot.id).first();
    if (fresh?.last_heartbeat_at) {
      const hb = Date.parse(fresh.last_heartbeat_at.replace(" ", "T") + "Z");
      if (Number.isFinite(hb) && now - hb > 30 * 60 * 1000) {
        await env.DB.prepare("UPDATE bots SET status='stale',last_error='No heartbeat received for more than 30 minutes' WHERE id=?").bind(bot.id).run();
        await incident(env, bot, "stale", "No heartbeat received for more than 30 minutes");
      }
    } else if (!bot.health_url) {
      await env.DB.prepare("UPDATE bots SET status='unknown' WHERE id=?").bind(bot.id).run();
    }
  }
}
async function handle(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(request, env) });
  if (request.method === "GET" && (path === "/" || path === "/health")) {
    return response({ ok: true, service: "Telegram Bot Control Center API", health: "online", timestamp: new Date().toISOString() }, request, env);
  }
  if (path === "/api/telemetry" && request.method === "POST") return handleTelemetry(request, env);

  if (path === "/api/login" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return response({ error: "Invalid JSON" }, request, env, 400); }
    if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD || body.username !== env.ADMIN_USERNAME || body.password !== env.ADMIN_PASSWORD) {
      return response({ error: "Username atau password salah" }, request, env, 401);
    }
    const token = randomToken();
    const hash = await sha256(token);
    await env.DB.prepare("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')").run();
    await env.DB.prepare("INSERT INTO admin_sessions (token_hash,expires_at) VALUES (?,datetime('now','+12 hours'))").bind(hash).run();
    return response({ ok: true }, request, env, 200, { "Set-Cookie": cookie(token, 43200) });
  }
  if (path === "/api/logout" && request.method === "POST") {
    const token = cookieValue(request, "bcc_session");
    if (token) await env.DB.prepare("DELETE FROM admin_sessions WHERE token_hash=?").bind(await sha256(token)).run();
    return response({ ok: true }, request, env, 200, { "Set-Cookie": cookie("", 0) });
  }
  if (path === "/api/me" && request.method === "GET") {
    const ok = await requireSession(request, env);
    return response({ authenticated: ok }, request, env, ok ? 200 : 401);
  }
  if (!(await requireSession(request, env))) return response({ error: "Unauthorized" }, request, env, 401);

  if (path === "/api/dashboard" && request.method === "GET") {
    const [counts, bots, errors, checks, activities] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) total, SUM(CASE WHEN status='healthy' THEN 1 ELSE 0 END) healthy, SUM(CASE WHEN status IN ('degraded','stale') THEN 1 ELSE 0 END) issues FROM bots WHERE enabled=1").first(),
      env.DB.prepare("SELECT id,name,health_url,enabled,created_at,last_heartbeat_at,last_health_at,last_health_code,status,last_error FROM bots ORDER BY name").all(),
      env.DB.prepare("SELECT e.id,e.bot_id,b.name bot_name,e.event,e.severity,e.message,e.source,e.group_id,e.created_at FROM telemetry_events e JOIN bots b ON b.id=e.bot_id WHERE e.severity IN ('error','critical','warning') ORDER BY e.id DESC LIMIT 30").all(),
      env.DB.prepare("SELECT h.id,h.bot_id,b.name bot_name,h.ok,h.status_code,h.latency_ms,h.detail,h.created_at FROM health_checks h JOIN bots b ON b.id=h.bot_id ORDER BY h.id DESC LIMIT 30").all(),
      env.DB.prepare("SELECT e.id,e.bot_id,b.name bot_name,e.event,e.severity,e.message,e.source,e.group_id,e.created_at FROM telemetry_events e JOIN bots b ON b.id=e.bot_id ORDER BY e.id DESC LIMIT 30").all()
    ]);
    return response({ counts, bots: bots.results, errors: errors.results, checks: checks.results, activities: activities.results }, request, env);
  }
  if (path === "/api/bots" && request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return response({ error: "Invalid JSON" }, request, env, 400); }
    const name = String(body.name || "").trim().slice(0, 100);
    const healthUrl = String(body.health_url || "").trim();
    if (!name) return response({ error: "Nama bot wajib diisi" }, request, env, 400);
    if (healthUrl) {
      try { const u = new URL(healthUrl); if (u.protocol !== "https:") throw new Error(); }
      catch { return response({ error: "Health URL harus HTTPS yang valid" }, request, env, 400); }
    }
    const id = crypto.randomUUID();
    const token = randomToken();
    await env.DB.prepare("INSERT INTO bots (id,name,health_url,telemetry_token_hash) VALUES (?,?,?,?)")
      .bind(id, name, healthUrl || null, await sha256(token)).run();
    return response({ ok: true, bot: { id, name, health_url: healthUrl || null }, telemetry_token: token }, request, env, 201);
  }
  if (path.startsWith("/api/bots/") && request.method === "DELETE") {
    const id = decodeURIComponent(path.slice("/api/bots/".length));
    await env.DB.prepare("DELETE FROM bots WHERE id=?").bind(id).run();
    return response({ ok: true }, request, env);
  }
  if (path === "/api/events" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT e.*,b.name bot_name FROM telemetry_events e JOIN bots b ON b.id=e.bot_id ORDER BY e.id DESC LIMIT 100").all();
    return response({ events: rows.results }, request, env);
  }
  return response({ error: "Not found" }, request, env, 404);
}
export default {
  async fetch(request, env) {
    try { return await handle(request, env); }
    catch (e) {
      // Never expose stack traces or secret values to clients.
      return json({ error: "Internal server error" }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduledChecks(env));
  }
};
