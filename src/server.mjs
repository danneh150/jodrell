// Local server: web UI at /, JSON API at /api, live events at /api/events, MCP at /mcp.
import http from "node:http";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createMcpHandler } from "./mcp.mjs";
import { mask } from "./checks.mjs";
import { buildReport, parseSince } from "./html.mjs";

const uiFile = (f) => fileURLToPath(new URL(`../ui/${f}`, import.meta.url));
const UI = uiFile("index.html");
const STATIC = { "/view.js": ["view.js", "text/javascript; charset=utf-8"], "/view.css": ["view.css", "text/css; charset=utf-8"], "/tokens.css": ["tokens.css", "text/css; charset=utf-8"],
  "/fonts/PixelifySans.ttf": ["fonts/PixelifySans.ttf", "font/ttf"], "/favicon.ico": ["favicon.ico", "image/x-icon"], "/icons/jodrell.svg": ["icons/jodrell.svg", "image/svg+xml"],
  ...Object.fromEntries([16, 32, 64, 128, 256, 512].map((n) => [`/icons/jodrell-${n}.png`, [`icons/jodrell-${n}.png`, "image/png"]])), "/fonts/OFL.txt": ["fonts/OFL.txt", "text/plain; charset=utf-8"] };
const MAX_BODY = 50 * 1024 * 1024; // imports can be large

async function readJson(req) {
  const chunks = []; let n = 0;
  for await (const ch of req) { n += ch.length; if (n > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 }); chunks.push(ch); }
  if (!chunks.length) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Object.assign(new Error("Request body is not valid JSON"), { status: 400 }); }
}

const send = (res, status, data) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
};
const clean = (call) => { if (!call) return call; const { ctx, ...rest } = call; return rest; };

export const publicSession = (s) => ({
  name: s.name,
  headers: Object.fromEntries(Object.entries(s.headers || {}).map(([k, v]) => [k, typeof v === "object" ? `${mask(v.value)} (${v.host} only)` : mask(v)])),
  vars: s.vars,
  cookies: Object.entries(s.cookies || {}).filter(([, v]) => typeof v === "object").flatMap(([dom, c]) => Object.keys(c).map((n) => `${n} (${dom})`)),
  updated_at: s.updated_at,
});

export async function startServer({ store, specs, runner, collections, auth, port, host = "127.0.0.1", fallbackPort = false, project = "", root, refreshSpecs }) {
  let uiBase = "";
  let mcp;
  const clients = new Set();
  let uiRun = null;
  const uiRunId = () => (uiRun ??= store.createRun("Your requests", "ui").id);

  const broadcast = (type, data) => {
    const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  let lastCallId = store.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM calls").get().m;
  let lastRunId = store.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM runs").get().m;
  store.on("call", (c) => { lastCallId = Math.max(lastCallId, c.id); broadcast("call", { ...c, req_body: undefined, res_body: undefined }); });
  store.on("run", (r) => { lastRunId = Math.max(lastRunId, r.id); });
  store.on("run", (r) => broadcast("run", r));
  store.on("rundone", (r) => broadcast("rundone", r));
  store.on("session", (s) => broadcast("session", s.deleted ? s : publicSession(s)));
  store.on("collections", () => broadcast("collections", {}));
  store.on("auth", (a) => broadcast("auth", a));
  store.on("environments", () => broadcast("environments", {}));
  store.on("cleared", () => { uiRun = null; broadcast("cleared", {}); });

  const routes = [
    ["GET", /^\/api\/info$/, () => ({ specs: specs.specs, operations: specs.list().length, loadedAt: specs.loadedAt, db: store.file, mcpUrl: `${uiBase}/mcp`, project })],
    ["GET", /^\/api\/timeline$/, (m, b, url) => {
      const runs = {}; for (const r of store.runs(1000)) runs[r.id] = { name: r.name, source: r.source };
      return { calls: store.listCalls({ limit: Number(url.searchParams.get("limit")) || 2000 }), runs };
    }],
    ["GET", /^\/api\/specs$/, () => specs.specs.map(({ source, origin, title, version, kind, baseUrl, operations, warnings, error }) => ({ source: root && !/^https?:/.test(source) ? source.replace(root + "/", "") : source, origin, title, version, kind, baseUrl, operations, warnings, error }))],
    ["POST", /^\/api\/specs\/reload$/, async () => { if (refreshSpecs) await refreshSpecs({ force: true }); else await specs.load(); broadcast("specs", {}); return { ok: true }; }],
    ["GET", /^\/api\/operations$/, () => specs.list().map((o) => ({ id: o.id, spec: o.spec, method: o.method, path: o.path, summary: o.summary, tags: o.tags, baseUrl: o.baseUrl, params: o.params, requestBody: o.requestBody, security: o.security }))],
    ["GET", /^\/api\/runs$/, () => store.runs()],
    ["GET", /^\/api\/calls$/, (m, b, url) => { const q = Object.fromEntries(url.searchParams); return store.listCalls({ ...q, limit: Number(q.limit) || 500 }); }],
    ["DELETE", /^\/api\/calls$/, () => { store.clearHistory(); return { ok: true }; }],
    ["GET", /^\/api\/calls\/(\d+)$/, (m) => { const c = store.getCall(+m[1]); if (!c) throw Object.assign(new Error("Call not found"), { status: 404 }); return { ...c, previous: store.previousOf(c)?.id ?? null }; }],
    ["POST", /^\/api\/calls\/(\d+)\/replay$/, async (m, b) => clean(await runner.replay(+m[1], b || {}, uiRunId()))],

    // Send from the request builder: { request, itemId?, collectionId?, session? }
    ["POST", /^\/api\/send$/, async (m, b) => {
      if (b.operationId) return clean(await runner.send({ ...runner.fromOperation(b.operationId, b, b.session || undefined), session: b.session || undefined, note: b.note, source: "ui", runId: uiRunId() }));
      return clean(await runner.sendRequest(b.request, { itemId: b.itemId, collectionId: b.collectionId, session: b.session || undefined, source: "ui", runId: uiRunId() }));
    }],

    ["GET", /^\/api\/collections$/, () => collections.list()],
    ["POST", /^\/api\/collections$/, (m, b) => collections.createCollection({ name: b?.name || "New collection" })],
    ["PATCH", /^\/api\/collections\/(\d+)$/, (m, b) => collections.updateCollection(+m[1], b || {})],
    ["DELETE", /^\/api\/collections\/(\d+)$/, (m) => { collections.deleteCollection(+m[1]); return { ok: true }; }],
    ["POST", /^\/api\/collections\/(\d+)\/run$/, (m, b) => {
      // Runs in the background; results stream as calls and a final rundone event.
      runner.runCollection(+m[1], { folderId: b?.folderId, session: b?.session || undefined, source: "ui" }).catch((e) => broadcast("runerror", { error: e.message }));
      return { started: true };
    }],
    ["POST", /^\/api\/items$/, (m, b) => collections.createItem(b)],
    ["PATCH", /^\/api\/items\/(\d+)$/, (m, b) => collections.updateItem(+m[1], b || {})],
    ["DELETE", /^\/api\/items\/(\d+)$/, (m) => { collections.deleteItem(+m[1]); return { ok: true }; }],
    ["POST", /^\/api\/report$/, async (m, b) => {
      const fsx = await import("node:fs"); const pathx = await import("node:path");
      const dir = pathx.join(pathx.dirname(store.file), "reports");
      fsx.mkdirSync(dir, { recursive: true });
      const file = pathx.join(dir, `history-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.html`);
      fsx.writeFileSync(file, buildReport(store, { since: parseSince(b?.since || "all"), project }));
      return { file };
    }],
    ["POST", /^\/api\/import$/, (m, b) => collections.importPostman(b?.data ?? b)],

    ["GET", /^\/api\/environments$/, () => collections.environments()],
    ["POST", /^\/api\/environments$/, (m, b) => collections.createEnv({ name: b?.name || "New environment", vars: b?.vars || [] })],
    ["PUT", /^\/api\/environments\/active$/, (m, b) => { collections.setActiveEnv(b?.id || null); return { ok: true }; }],
    ["PATCH", /^\/api\/environments\/(\d+)$/, (m, b) => collections.updateEnv(+m[1], b || {})],
    ["DELETE", /^\/api\/environments\/(\d+)$/, (m) => { collections.deleteEnv(+m[1]); return { ok: true }; }],

    ["GET", /^\/api\/sessions$/, () => store.sessions().map(publicSession)],
    ["PATCH", /^\/api\/sessions\/([^/]+)$/, (m, b = {}) => {
      const s = store.getSession(decodeURIComponent(m[1]));
      if (b.clearCookies) s.cookies = {};
      for (const [k, v] of Object.entries(b.headers || {})) v === "" ? delete s.headers[k] : (s.headers[k] = v);
      Object.assign(s.vars, b.vars || {});
      return publicSession(store.saveSession(s));
    }],
    ["DELETE", /^\/api\/sessions\/([^/]+)$/, (m) => { store.deleteSession(decodeURIComponent(m[1])); return { ok: true }; }],

    // Auth profiles from jodrell.config.json: status, sign in now, sign out, and
    // the sign-in request for trying it by hand.
    ["GET", /^\/api\/auth$/, () => (auth ? auth.statuses() : [])],
    ["POST", /^\/api\/auth\/([^/]+)\/signin$/, async (m) => {
      const name = decodeURIComponent(m[1]);
      const p = auth?.profile(name);
      if (!p) throw Object.assign(new Error(`No auth profile called "${name}"`), { status: 404 });
      try { await auth.ensure(p, runner, { force: true, source: "ui", runId: uiRunId() }); }
      catch (e) { return { ...auth.status(name), ok: false, error: e.message }; }
      return { ...auth.status(name), ok: true };
    }],
    ["DELETE", /^\/api\/auth\/([^/]+)$/, (m) => { auth?.signOut(decodeURIComponent(m[1])); return { ok: true }; }],
    ["GET", /^\/api\/auth\/([^/]+)\/request$/, (m) => {
      const d = auth?.loginDraft(decodeURIComponent(m[1]));
      if (!d) throw Object.assign(new Error("This profile doesn't sign in with a request"), { status: 404 });
      return d;
    }],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, uiBase);
    const p = url.pathname;
    // No framing (clickjacking), no MIME sniffing, no referrers.
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "frame-ancestors 'none'");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    try {
      // Only this server's own pages and local tools may use it:
      // - Host must name this server, which stops DNS rebinding (a website
      //   whose domain is re-pointed at 127.0.0.1).
      // - Origin, when a browser sends one, must be this server itself, not
      //   another site or another local app's page.
      // - Writes must be JSON, which browsers can't send cross-site without a
      //   preflight that this server never approves.
      const hostOk = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`, `[::1]:${actual}`]);
      if (!hostOk.has(String(req.headers.host || "").toLowerCase())) return send(res, 403, { error: "This request isn't addressed to jodrell's own server" });
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${actual}` && origin !== `http://localhost:${actual}`) return send(res, 403, { error: "Cross-origin requests are not allowed" });
      if (p.startsWith("/api/") && !["GET", "HEAD"].includes(req.method) && !/^application\/json\b/i.test(req.headers["content-type"] || "")) return send(res, 415, { error: "Send JSON, with Content-Type: application/json" });
      if (p === "/mcp") return mcp(req, res, req.method === "POST" ? await readJson(req) : undefined);
      if (STATIC[p]) {
        res.writeHead(200, { "content-type": STATIC[p][1], "cache-control": /^\/(fonts|icons)\/|^\/favicon/.test(p) ? "max-age=86400" : "no-store" });
        return res.end(fs.readFileSync(uiFile(STATIC[p][0])));
      }
      if (p === "/api/report" && req.method === "GET") {
        const since = parseSince(url.searchParams.get("since") || "all");
        const html = buildReport(store, { since, runId: url.searchParams.get("run") || undefined, project });
        const name = `jodrell-history-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.html`;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="${name}"`, "cache-control": "no-store" });
        return res.end(html);
      }
      if (p === "/" || p === "/index.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return res.end(fs.readFileSync(UI));
      }
      if (p === "/api/events") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(": connected\n\n");
        clients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 20000);
        req.on("close", () => { clearInterval(ping); clients.delete(res); });
        return;
      }
      for (const [method, re, fn] of routes) {
        const m = req.method === method && p.match(re);
        if (m) return send(res, 200, await fn(m, ["POST", "PATCH", "PUT"].includes(method) ? await readJson(req) : undefined, url));
      }
      send(res, 404, { error: `Nothing at ${req.method} ${p}` });
    } catch (e) {
      if (!res.headersSent) send(res, e.status || (e instanceof SyntaxError ? 400 : 500), { error: e.message });
    }
  });

  const listen = (p) => new Promise((resolve, reject) => {
    const onErr = (e) => { server.off("listening", onOk); reject(e); };
    const onOk = () => { server.off("error", onErr); resolve(server.address().port); };
    server.once("error", onErr); server.once("listening", onOk);
    server.listen(p, host);
  });
  let actual;
  try { actual = await listen(port); }
  catch (e) {
    if (e.code !== "EADDRINUSE") throw e;
    if (!fallbackPort) throw new Error(`Port ${port} is in use. Is jodrell already running? Try --port ${port + 1}.`);
    actual = await listen(0);
  }
  // 127.0.0.1 rather than localhost: localhost can resolve to ::1 first, where
  // another local user could be listening on the same port.
  uiBase = `http://127.0.0.1:${actual}`;
  mcp = createMcpHandler({ store, specs, runner, collections, auth, uiBase: () => uiBase, project, root, refreshSpecs });

  // Another process (usually the agent's own jodrell) may write to the same
  // project database. Pick its changes up and push them to open GUIs.
  let version = store.db.prepare("PRAGMA data_version").get().data_version;
  const poll = setInterval(() => {
    try {
      const v = store.db.prepare("PRAGMA data_version").get().data_version;
      if (v === version) return;
      version = v;
      for (const r of store.db.prepare("SELECT * FROM runs WHERE id > ? ORDER BY id").all(lastRunId)) { lastRunId = r.id; broadcast("run", r); }
      for (const row of store.db.prepare("SELECT id FROM calls WHERE id > ? ORDER BY id").all(lastCallId)) {
        lastCallId = row.id;
        const c = store.getCall(row.id);
        broadcast("call", { ...c, req_body: undefined, res_body: undefined });
      }
      broadcast("collections", {}); broadcast("environments", {}); broadcast("session", {}); broadcast("auth", {});
    } catch {}
  }, 700);
  poll.unref();
  return { server, uiBase, broadcast };
}
