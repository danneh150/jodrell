// Shared helpers for jodrell's tests. Everything runs locally: temporary
// projects on disk and a small fake API, so no network is needed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";

// Approvals of auth profiles go to a temporary folder, never the real ~/.config.
process.env.JODRELL_HOME ??= fs.mkdtempSync(path.join(os.tmpdir(), "jodrell-home-"));

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const BIN = path.join(ROOT, "bin", "jodrell.mjs");
export const GUARD = path.join(ROOT, "bin", "guard.mjs");
export const example = (f) => path.join(ROOT, "examples", f);

// A temporary project folder with the given files ({ "path/in/project": contents }).
export function tmpProject(files = {}, { pkg = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jodrell-test-"));
  if (pkg) fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "test-project", private: true }));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), typeof body === "string" ? body : JSON.stringify(body, null, 2));
  }
  return root;
}
export const tmpDb = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "jodrell-db-")), "history.db");

// A minimal OpenAPI 3 document.
export const oas = (title, paths = {}, extra = {}) => ({ openapi: "3.0.3", info: { title, version: "1" }, paths, ...extra });

// A local port with nothing listening on it.
export async function closedPort() {
  const srv = http.createServer();
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r));
  return port;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Wait for a condition, polling. Fails the test with a clear message on timeout.
export async function waitFor(fn, { timeout = 4000, every = 50, what = "condition" } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await sleep(every);
  }
}

// The fake API. Returns { url, port, close, requests }.
// Routes:
//   ANY  /echo[...]          echoes method, path, query, headers and body
//   POST /login              {password:"secret"} -> token + session cookie
//   GET  /me                 needs the bearer token or the cookie
//   GET  /logout             expires the cookie
//   GET  /status/:code       responds with that status
//   GET  /redirect           302 to /echo
//   GET  /slow?ms=           waits, then 200
//   GET  /big?kb=            a large JSON body
//   GET  /binary             application/octet-stream
//   GET  /html               hostile HTML
//   GET  /users/:id          {id, name}
//   GET  /v3/api-docs        an OpenAPI spec (as a framework would serve it)
//   POST /oauth/token        client credentials (cid / csecret) -> the token
//   GET  /keyed?key=         needs ?key=<token>
//   POST /cookie-login       sets only the session cookie
// rotate() issues a new token, so the old one gets 401 (an expired session).
export async function fakeApi() {
  const requests = [];
  let TOKEN = "tok-" + Math.random().toString(36).slice(2, 12);
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    let body = "";
    for await (const c of req) body += c;
    requests.push({ method: req.method, path: u.pathname, headers: req.headers, body });
    const json = (status, data, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(data)); };
    const authed = req.headers.authorization === `Bearer ${TOKEN}` || (req.headers.cookie || "").includes(`sid=${TOKEN}`);
    if (u.pathname.startsWith("/echo")) return json(200, { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body });
    if (u.pathname === "/login" && req.method === "POST") {
      let b = {}; try { b = JSON.parse(body); } catch {}
      if (b.password !== "secret") return json(401, { error: "Wrong password" });
      return json(200, { access_token: TOKEN, expires_in: 3600, user: { id: "u1" } }, { "set-cookie": `sid=${TOKEN}; HttpOnly; Path=/`, "x-request-id": "req-123" });
    }
    if (u.pathname === "/oauth/token" && req.method === "POST") {
      const f = new URLSearchParams(body);
      if (f.get("grant_type") !== "client_credentials" || f.get("client_id") !== "cid" || f.get("client_secret") !== "csecret") return json(401, { error: "invalid_client", error_description: "Unknown client" });
      return json(200, { access_token: TOKEN, token_type: "Bearer", expires_in: 600 });
    }
    if (u.pathname === "/cookie-login" && req.method === "POST") return json(200, { ok: true }, { "set-cookie": `sid=${TOKEN}; HttpOnly; Path=/` });
    if (u.pathname === "/keyed") return u.searchParams.get("key") === TOKEN ? json(200, { ok: true }) : json(401, { error: "Bad key" });
    if (u.pathname === "/me") return authed ? json(200, { id: "u1", name: "Ada" }) : json(401, { error: "Log in first" });
    if (u.pathname === "/logout") return json(200, { ok: true }, { "set-cookie": "sid=; Max-Age=0; Path=/" });
    const st = u.pathname.match(/^\/status\/(\d{3})$/);
    if (st) return json(Number(st[1]), { status: Number(st[1]) });
    if (u.pathname === "/redirect") { res.writeHead(302, { location: "/echo" }); return res.end(); }
    if (u.pathname === "/slow") { await sleep(Number(u.searchParams.get("ms") || 300)); return json(200, { slow: true }); }
    if (u.pathname === "/big") return json(200, { data: "x".repeat(Number(u.searchParams.get("kb") || 10) * 1024) });
    if (u.pathname === "/binary") { res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(Buffer.from([0, 1, 2, 3, 255])); }
    if (u.pathname === "/html") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<script>window.pwned=1</script><img src=x onerror=alert(1)>'); }
    const user = u.pathname.match(/^\/users\/([^/]+)$/);
    if (user) return json(200, { id: decodeURIComponent(user[1]), name: "Ada" });
    if (u.pathname === "/v3/api-docs") return json(200, oas("Served by the app", { "/users/{id}": { get: { operationId: "getUser", responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } } } } } } } } }, { servers: [{ url: "/" }] }));
    json(404, { error: "Not found" });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  return { url: `http://127.0.0.1:${port}`, localhost: `http://localhost:${port}`, port, get token() { return TOKEN; }, requests,
    rotate: () => { TOKEN = "tok-" + Math.random().toString(36).slice(2, 12); return TOKEN; },
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(() => r()); }) };
}

// A jodrell core for a test, in its own project. Returns the core plus a cleanup.
export async function makeCore(files = {}, opts = {}) {
  const { createCore } = await import("../src/project.mjs");
  const root = tmpProject(files);
  const core = await createCore({ root, ...opts });
  return core;
}

// Start jodrell's GUI server for a core on a free port. Returns { url, close, broadcast }.
export async function startGui(core) {
  const { startServer } = await import("../src/server.mjs");
  const ui = await startServer({ ...core, port: 0, fallbackPort: true });
  return { url: ui.uiBase, broadcast: ui.broadcast, close: () => new Promise((r) => { ui.server.closeAllConnections?.(); ui.server.close(() => r()); }) };
}

// Read server-sent events until `match(event, data)` returns true.
export async function nextEvent(url, match, { timeout = 5000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${url}/api/events`, { signal: ctrl.signal });
    const dec = new TextDecoder(); let buf = "";
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = block.match(/^event: (.+)$/m)?.[1];
        const data = block.match(/^data: (.+)$/m)?.[1];
        if (ev && match(ev, data ? JSON.parse(data) : null)) return { event: ev, data: data ? JSON.parse(data) : null };
      }
    }
  } catch (e) { if (e.name === "AbortError") throw new Error("Timed out waiting for a server event"); throw e; }
  finally { clearTimeout(t); ctrl.abort(); }
}
