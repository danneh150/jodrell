// Self-contained HTML: the history report (a file you can open or share) and
// the MCP App view the agent's reply renders. Both reuse ui/view.js.
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ui = (f) => fs.readFileSync(fileURLToPath(new URL(`../ui/${f}`, import.meta.url)), "utf8");
// The pixel font used for headings, embedded so reports and agent views work offline.
let fontCss;
const pixelFont = () => (fontCss ??= `@font-face { font-family: "Pixelify Sans"; src: url(data:font/ttf;base64,${fs.readFileSync(fileURLToPath(new URL("../ui/fonts/PixelifySans.ttf", import.meta.url))).toString("base64")}) format("truetype"); font-weight: 400 700; font-display: swap; }`);
const iconData = (n) => `data:image/png;base64,${fs.readFileSync(fileURLToPath(new URL(`../ui/icons/jodrell-${n}.png`, import.meta.url))).toString("base64")}`;
const BODY_LIMIT = 16_000; // characters of each body kept in reports and agent views

// JSON that is safe inside <script type="application/json">.
const embed = (data) => JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

export function summarise(c) {
  if (!c) return c;
  const { req_body, res_body, req_headers, res_headers, ctx, ...rest } = c;
  const v = c.validation;
  return { ...rest, validation: v ? { checked: v.checked, valid: v.valid, errors: (v.errors || []).slice(0, 20) } : null };
}

export function forView(c) {
  if (!c) return c;
  const cut = (s) => (s && s.length > BODY_LIMIT ? s.slice(0, BODY_LIMIT) : s);
  const { ctx, ...rest } = c;
  return { ...rest, req_body: cut(c.req_body), res_body: cut(c.res_body), truncated: c.truncated || (c.res_body?.length ?? 0) > BODY_LIMIT };
}

// What the timeline needs: call summaries plus run names.
export function timelineData(store, { since, runId, limit = 500, failedOnly } = {}) {
  let calls = store.listCalls({ limit, run: runId, status: failedOnly ? "error" : undefined });
  if (since) calls = calls.filter((c) => new Date(c.ts) >= since);
  const runs = {};
  for (const r of store.runs(1000)) runs[r.id] = { name: r.name, source: r.source };
  return { calls: calls.map(summarise), runs };
}

export function parseSince(s) {
  if (!s || s === "all") return null;
  const m = String(s).match(/^(\d+)\s*(m|h|d|w)$/);
  if (!m) { const d = new Date(s); if (!isNaN(d)) return d; throw new Error(`Couldn't read "${s}". Use 30m, 24h, 7d, 2w, all or a date.`); }
  return new Date(Date.now() - Number(m[1]) * { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2]]);
}

/* ---------------- HTML report ---------------- */

export function buildReport(store, { since, runId, limit = 500, title = "jodrell request history", project = "" } = {}) {
  const data = timelineData(store, { since, runId, limit });
  const details = {};
  for (const c of data.calls) details[c.id] = forView(store.getCall(c.id));
  const generated = new Date();
  const payload = { ...data, details, generatedAt: generated.toISOString(), project };
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}${project ? " – " + escHtml(project) : ""}</title>
<link rel="icon" type="image/png" href="${iconData(32)}">
<style>
${pixelFont()}
${ui("tokens.css")}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink); font: 13.5px/1.45 var(--ui); }
.wrap { max-width: 1180px; margin: 0 auto; }
.top { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; padding: 18px 18px 0; color: var(--muted); font-size: 12.5px; }
.top strong { color: var(--ink); font-size: 14px; }
.top button { margin-left: auto; border: 1px solid var(--line); background: var(--raised); color: var(--ink); border-radius: 6px; padding: 3px 10px; cursor: pointer; font: inherit; }
.foot { padding: 0 18px 30px; color: var(--faint); font-size: 12px; }
${ui("view.css")}
</style>
</head>
<body>
<div class="wrap">
  <div class="top"><img src="${iconData(32)}" width="24" height="24" alt="" style="image-rendering:pixelated;align-self:center"><strong>jodrell</strong><span>${project ? escHtml(project) + ", " : ""}generated ${escHtml(generated.toLocaleString("en-GB"))}</span><button id="theme" type="button">Theme: auto</button></div>
  <main id="tl"></main>
  <p class="foot">Secret headers are masked. Bodies over ${BODY_LIMIT / 1000} kB are shortened. Open the full GUI with "npx jodrell gui".</p>
</div>
<script type="application/json" id="data">${embed(payload)}</script>
<script>
${ui("view.js")}
(function () {
  var data = JSON.parse(document.getElementById("data").textContent);
  var el = document.getElementById("tl");
  JodrellView.timeline(el, data, {
    title: ${JSON.stringify(runId ? "Run history" : "Request history")},
    onSelect: function (id, row, det) { JodrellView.toggleInline(row, det, data.details[id]); }
  });
  var modes = ["auto", "dark", "light"], i = 0, btn = document.getElementById("theme");
  btn.onclick = function () { i = (i + 1) % 3; if (modes[i] === "auto") document.documentElement.removeAttribute("data-theme"); else document.documentElement.dataset.theme = modes[i]; btn.textContent = "Theme: " + modes[i]; };
})();
</script>
</body>
</html>`;
}

function escHtml(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

/* ---------------- MCP App view (rendered inside the agent's reply) ---------------- */

let appBundle;
function mcpAppsBundle() {
  if (appBundle) return appBundle;
  const src = fs.readFileSync(require.resolve("@modelcontextprotocol/ext-apps/app-with-deps"), "utf8");
  const m = src.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  if (!m) throw new Error("Unexpected @modelcontextprotocol/ext-apps bundle format");
  const exports = Object.fromEntries(m[1].split(",").map((p) => p.trim().split(/\s+as\s+/)).map(([local, name]) => [name || local, local]));
  appBundle = src.slice(0, m.index) + `;window.McpApps={App:${exports.App}};`;
  return appBundle;
}

export const APP_URI = "ui://jodrell/view.html";
export const APP_MIME = "text/html;profile=mcp-app";

export function buildAppHtml() {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>jodrell</title>
<style>
${pixelFont()}
${ui("tokens.css")}
* { box-sizing: border-box; }
html, body { margin: 0; background: transparent; color: var(--ink); font: 13.5px/1.45 var(--ui); }
body { padding: 2px; }
.shell { background: var(--bg); border-radius: 10px; overflow: hidden; }
.bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--line); background: var(--surface); font-size: 12.5px; color: var(--muted); }
.bar strong { color: var(--ink); }
.bar button { margin-left: auto; border: 1px solid var(--line); background: var(--raised); color: var(--ink); border-radius: 6px; padding: 2px 9px; cursor: pointer; font: inherit; }
.single { padding: 10px; }
.single .av-detail { margin: 0; }
.waiting { padding: 18px; color: var(--muted); }
.av-line { max-height: 620px; overflow: auto; }
${ui("view.css")}
</style>
</head>
<body>
<div class="shell">
  <div class="bar"><img src="${iconData(16)}" width="16" height="16" alt="" style="image-rendering:pixelated"><strong>jodrell</strong><span id="sub">Waiting for the result…</span><button id="gui" type="button" hidden>Open full GUI</button></div>
  <div id="root"><div class="waiting">Waiting for the result…</div></div>
</div>
<script>
${mcpAppsBundle()}
${ui("view.js")}
(function () {
  var root = document.getElementById("root"), sub = document.getElementById("sub"), guiBtn = document.getElementById("gui");
  var app = new McpApps.App({ name: "jodrell", version: "0.3.0" }, {}, { autoResize: true });
  var data = null;
  function applyTheme(ctx) { if (ctx && ctx.theme) document.documentElement.dataset.theme = ctx.theme; }
  function openGui(hash) { if (data && data.guiUrl) app.openLink({ url: data.guiUrl + (hash || "") }).catch(function () {}); }
  async function detailFor(id) {
    if (data.details && data.details[id]) return data.details[id];
    try {
      var r = await app.callServerTool({ name: "get_call_view", arguments: { callId: id } });
      var c = r && r.structuredContent && r.structuredContent.call;
      if (c) { (data.details = data.details || {})[id] = c; return c; }
    } catch (e) {}
    return null;
  }
  async function onSelect(id, row, det) {
    if (!det.hidden) return JodrellView.toggleInline(row, det, null);
    det.hidden = false; det.innerHTML = '<div class="waiting">Loading…</div>'; row.setAttribute("aria-expanded", "true");
    var c = await detailFor(id);
    if (c) JodrellView.detail(det, c, data.guiUrl ? { onOpenGui: function (x) { openGui("#call-" + x.id); } } : {});
    else det.innerHTML = '<div class="waiting">Details aren\\'t available here. ' + (data.guiUrl ? "Open the full GUI to see them." : "") + "</div>";
  }
  function render(d) {
    data = d || {};
    guiBtn.hidden = !data.guiUrl;
    if (data.view === "call" && data.call) {
      sub.textContent = data.call.item_name || "Request";
      root.className = "single";
      JodrellView.detail(root, data.call, data.guiUrl ? { onOpenGui: function (x) { openGui("#call-" + x.id); } } : {});
    } else if (data.view === "run" && data.summary) {
      sub.textContent = "Collection run";
      root.className = "";
      JodrellView.runSummary(root, data, { onSelect: onSelect });
    } else if (data.view === "timeline") {
      sub.textContent = "";
      root.className = "";
      JodrellView.timeline(root, data, { title: data.title || "Request history", range: data.range || "all", rowsPerSession: 6, onSelect: onSelect });
    } else {
      root.innerHTML = '<div class="waiting">Nothing to show.</div>';
    }
  }
  guiBtn.onclick = function () { openGui(data && data.view === "call" && data.call ? "#call-" + data.call.id : ""); };
  app.ontoolresult = function (r) { render(r && r.structuredContent); };
  app.onhostcontextchanged = function (ctx) { applyTheme(ctx); };
  app.connect().then(function () { applyTheme(app.getHostContext && app.getHostContext()); }).catch(function (e) { root.innerHTML = '<div class="waiting">This host couldn\\'t start the jodrell view.</div>'; });
})();
</script>
</body>
</html>`;
}
