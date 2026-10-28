const API = (window.BCC_API_BASE || "__API_BASE_URL__").replace(/\/$/, "");
const $ = id => document.getElementById(id);
let lastToken = "";
const sectionTargets = ["bots", "errors", "checks", "activity"];
function setCollapsed(id, collapsed) {
  const el = $(id); if (!el) return;
  el.classList.toggle("is-collapsed", collapsed);
  document.querySelectorAll(`.section-toggle[data-target="${id}"]`).forEach(b => b.textContent = collapsed ? "Expand" : "Collapse");
}
$("collapseAll").addEventListener("click", () => {
  const collapse = $("collapseAll").dataset.mode !== "collapsed";
  sectionTargets.forEach(id => setCollapsed(id, collapse));
  $("collapseAll").dataset.mode = collapse ? "collapsed" : "expanded";
  $("collapseAll").textContent = collapse ? "+ Expand all" : "− Minimize all";
});
document.querySelectorAll(".section-toggle").forEach(btn => btn.addEventListener("click", () => {
  const id = btn.dataset.target; setCollapsed(id, !$(id).classList.contains("is-collapsed"));
}));
async function api(path, options = {}) {
  const res = await fetch(API + path, { credentials: "include", ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg) { $("toast").textContent = msg; $("toast").classList.add("show"); setTimeout(() => $("toast").classList.remove("show"), 2600); }
function time(v) { if (!v) return "Never"; const d = new Date(v.includes("T") ? v : v.replace(" ", "T") + "Z"); return Number.isNaN(d.getTime()) ? v : d.toLocaleString(); }
function esc(v) { return String(v ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function showApp(on) { $("loginView").classList.toggle("hidden", on); $("appView").classList.toggle("hidden", !on); $("logout").classList.toggle("hidden", !on); }
async function init() { try { await api("/api/me"); showApp(true); await refresh(); } catch { showApp(false); } }
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault(); $("loginError").textContent = "";
  try { await api("/api/login", { method: "POST", body: JSON.stringify({ username: $("username").value, password: $("password").value }) }); showApp(true); await refresh(); }
  catch (err) { $("loginError").textContent = err.message; }
});
$("logout").addEventListener("click", async () => { try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {} showApp(false); });
$("refresh").addEventListener("click", refresh);
$("addOpen").addEventListener("click", () => { $("modal").classList.remove("hidden"); $("botError").textContent = ""; $("tokenResult").classList.add("hidden"); });
$("closeModal").addEventListener("click", () => $("modal").classList.add("hidden"));
$("modal").addEventListener("click", e => { if (e.target === $("modal")) $("modal").classList.add("hidden"); });
$("botForm").addEventListener("submit", async e => {
  e.preventDefault(); $("botError").textContent = "";
  try {
    const d = await api("/api/bots", { method: "POST", body: JSON.stringify({ name: $("botName").value, health_url: $("healthUrl").value }) });
    lastToken = d.telemetry_token; $("tokenText").textContent = lastToken; $("tokenResult").classList.remove("hidden"); $("botForm").classList.add("hidden");
    toast("Bot registered"); await refresh();
  } catch (err) { $("botError").textContent = err.message; }
});
$("copyToken").addEventListener("click", async () => { try { await navigator.clipboard.writeText(lastToken); toast("Token copied"); } catch { toast("Copy failed — select token manually"); } });
async function refresh() {
  try {
    const d = await api("/api/dashboard"), c = d.counts || {};
    $("total").textContent = c.total || 0; $("healthy").textContent = c.healthy || 0; $("issues").textContent = c.issues || 0; $("eventCount").textContent = (d.errors || []).length;
    $("bots").innerHTML = d.bots.length ? d.bots.map(b => `<article class="bot-card"><div class="bot-main"><div class="bot-name">${esc(b.name)}</div><div class="bot-url">${esc(b.health_url || "Telemetry only — no health URL")}</div><div class="bot-meta">Heartbeat: ${esc(time(b.last_heartbeat_at))} · Last check: ${esc(time(b.last_health_at))}</div>${b.last_error ? `<div class="bot-meta" style="color:var(--red)">${esc(b.last_error)}</div>` : ""}</div><span class="status ${esc(b.status)}">${esc(b.status.toUpperCase())}</span><button class="remove" title="Remove monitor registration" data-remove="${esc(b.id)}">×</button></article>`).join("") : '<div class="empty">No bots registered yet. Select “Add bot” to begin.</div>';
    $("errors").innerHTML = d.errors.length ? d.errors.map(e => `<div class="event"><div class="eventtop"><span class="eventname">${esc(e.bot_name)} · ${esc(e.event)}</span><span class="sev ${esc(e.severity)}">${esc(e.severity)}</span></div><div class="eventmsg">${esc(e.message)}${e.group_id ? ` <span class="muted">· group ${esc(e.group_id)}</span>` : ""}</div><div class="eventtime">${esc(time(e.created_at))} · ${esc(e.source || "worker")}</div></div>`).join("") : '<div class="empty">No warnings or errors recorded.</div>';
    $("checks").innerHTML = d.checks.length ? d.checks.map(c => `<div class="event"><div class="eventtop"><span class="eventname">${esc(c.bot_name)}</span><span class="sev ${c.ok ? "" : "error"}">${c.ok ? "OK" : "FAILED"}</span></div><div class="eventmsg">${esc(c.detail)}${c.latency_ms != null ? ` · ${esc(c.latency_ms)} ms` : ""}</div><div class="eventtime">${esc(time(c.created_at))}</div></div>`).join("") : '<div class="empty">Health checks will appear after the first scheduled run.</div>';
    const activity = d.activities || [];
    $("activity").innerHTML = activity.length ? activity.map(a => `<div class="event"><div class="eventtop"><span class="eventname">${esc(a.bot_name)} · ${esc(a.event)}</span><span class="sev ${esc(a.severity)}">${esc(a.severity)}</span></div><div class="eventmsg">${esc(a.message)}${a.group_id ? ` <span class="muted">· group ${esc(a.group_id)}</span>` : ""}</div><div class="eventtime">${esc(time(a.created_at))} · ${esc(a.source || "worker")}</div></div>`).join("") : '<div class="empty">No activity reported yet. Add telemetry to a bot to see its events here.</div>';
    document.querySelectorAll("[data-remove]").forEach(btn => btn.addEventListener("click", async () => { if (!confirm("Remove this bot from monitoring? Existing bot will not be affected.")) return; try { await api("/api/bots/" + encodeURIComponent(btn.dataset.remove), { method: "DELETE" }); toast("Removed from monitoring"); await refresh(); } catch(e) { toast(e.message); } }));
  } catch (e) { if (e.message === "Unauthorized") showApp(false); else toast(e.message); }
}
init();
setInterval(() => { if (!$("appView").classList.contains("hidden")) refresh(); }, 60000);
