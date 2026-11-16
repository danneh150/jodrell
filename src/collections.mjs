// Collections, folders, saved requests and environments, plus Postman import
// and the resolver that turns a saved request into something sendable.
import { randomUUID } from "node:crypto";

const J = (v) => JSON.stringify(v ?? null);
const P = (v, d) => { try { return v == null ? d : JSON.parse(v); } catch { return d; } };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
  variables TEXT NOT NULL DEFAULT '[]', auth TEXT, source TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, collection_id INTEGER NOT NULL, parent_id INTEGER,
  kind TEXT NOT NULL, name TEXT NOT NULL, sort REAL NOT NULL DEFAULT 0, request TEXT, auth TEXT
);
CREATE INDEX IF NOT EXISTS items_coll ON items(collection_id);
CREATE TABLE IF NOT EXISTS environments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, vars TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
`;

// The request shape used everywhere (close to Bruno's, easy to map from Postman):
// { method, url, pathVars: [{key,value}], headers: [{key,value,enabled}],
//   body: { mode: none|json|text|xml|urlencoded|formdata|graphql, raw, fields: [...], graphql: {query, variables} },
//   auth: { type: inherit|none|bearer|basic|apikey, token, username, password, key, value, in },
//   captures: [{key, value, enabled}],   // after the response: save value (body.x, header.y, status) into variable key
//   expectStatus, scripts: { pre, test }, description }
export function blankRequest(over = {}) {
  return {
    method: "GET", url: "", pathVars: [], headers: [], body: { mode: "none", raw: "", fields: [], graphql: { query: "", variables: "" } },
    auth: { type: "inherit" }, captures: [], expectStatus: "", scripts: { pre: "", test: "" }, description: "", ...over,
  };
}

/* ---------------- Postman import ---------------- */

const joined = (exec) => (Array.isArray(exec) ? exec.join("\n") : exec || "");
const kv = (list = []) => (Array.isArray(list) ? list : []).filter((x) => x && x.key !== undefined)
  .map((x) => ({ key: String(x.key), value: x.value == null ? "" : String(x.value), enabled: !x.disabled, ...(x.type === "file" ? { type: "file", src: x.src } : {}) }));

function postmanAuth(a) {
  if (!a) return { type: "inherit" };
  const t = a.type;
  const get = (k) => {
    const v = a[t];
    if (Array.isArray(v)) return v.find((x) => x.key === k)?.value ?? "";
    return v?.[k] ?? "";
  };
  if (t === "noauth") return { type: "none" };
  if (t === "bearer") return { type: "bearer", token: String(get("token")) };
  if (t === "basic") return { type: "basic", username: String(get("username")), password: String(get("password")) };
  if (t === "apikey") return { type: "apikey", key: String(get("key")), value: String(get("value")), in: get("in") === "query" ? "query" : "header" };
  return { type: "unsupported", original: t };
}

function postmanUrl(u) {
  if (!u) return { url: "", pathVars: [] };
  if (typeof u === "string") return { url: u, pathVars: [] };
  let url = u.raw;
  if (!url) {
    const host = Array.isArray(u.host) ? u.host.join(".") : u.host || "";
    const path = Array.isArray(u.path) ? u.path.join("/") : u.path || "";
    const q = kv(u.query).filter((x) => x.enabled).map((x) => `${x.key}=${x.value}`).join("&");
    url = `${u.protocol ? u.protocol + "://" : ""}${host}${u.port ? ":" + u.port : ""}${path ? "/" + path : ""}${q ? "?" + q : ""}`;
  }
  return { url, pathVars: kv(u.variable).map(({ key, value }) => ({ key, value })) };
}

function postmanBody(b) {
  const body = { mode: "none", raw: "", fields: [], graphql: { query: "", variables: "" } };
  if (!b || b.disabled) return { body, notes: [] };
  const notes = [];
  if (b.mode === "raw") {
    const lang = b.options?.raw?.language;
    const raw = b.raw || "";
    body.raw = raw;
    body.mode = lang === "json" || (!lang && /^\s*[[{]/.test(raw)) ? "json" : lang === "xml" ? "xml" : "text";
  } else if (b.mode === "urlencoded") { body.mode = "urlencoded"; body.fields = kv(b.urlencoded); }
  else if (b.mode === "formdata") {
    body.mode = "formdata"; body.fields = kv(b.formdata);
    if (body.fields.some((f) => f.type === "file")) notes.push("has file fields, which aren't sent yet");
  } else if (b.mode === "graphql") { body.mode = "graphql"; body.graphql = { query: b.graphql?.query || "", variables: b.graphql?.variables || "" }; }
  else if (b.mode === "file") notes.push("uses a binary file body, which isn't supported yet");
  return { body, notes };
}

// Turn the common Postman test-script patterns into declarative captures and a
// status check. Nothing in the script is executed.
export function convertScript(script) {
  const captures = [];
  let expectStatus = "";
  if (!script) return { captures, expectStatus, converted: 0, remaining: 0 };
  const lines = script.split("\n");
  const aliases = new Set();
  for (const l of lines) {
    const m = l.match(/(?:var|let|const)\s+(\w+)\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse\(\s*(?:responseBody|pm\.response\.text\(\))\s*\))/);
    if (m) aliases.add(m[1]);
  }
  const toPath = (expr) => {
    expr = expr.trim();
    let rest = null;
    const pj = expr.match(/^pm\.response\.json\(\)(.*)$/);
    if (pj) rest = pj[1];
    else { const a = expr.match(/^(\w+)(.*)$/); if (a && aliases.has(a[1])) rest = a[2]; }
    if (rest !== null) {
      const parts = [...rest.matchAll(/\.(\w+)|\[\s*["']?([\w-]+)["']?\s*\]/g)].map((x) => x[1] ?? x[2]);
      if (parts.join("").length === rest.replace(/[\s.[\]"']/g, "").length) return parts.length ? "body." + parts.join(".") : "body";
    }
    const h = expr.match(/^pm\.response\.headers\.get\(\s*["']([^"']+)["']\s*\)$/);
    if (h) return "header." + h[1].toLowerCase();
    if (/^pm\.response\.code$/.test(expr)) return "status";
    return null;
  };
  let converted = 0, meaningful = 0;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || l.startsWith("//") || /^[{}()[\];,]+$/.test(l) || /^pm\.test\(.*function\s*\(\)\s*\{$/.test(l) || /^pm\.test\(.*=>\s*\{$/.test(l) || /^\}\s*\)\s*;?$/.test(l)) continue;
    if (/(?:var|let|const)\s+\w+\s*=\s*(?:pm\.response\.json\(\)|JSON\.parse)/.test(l)) continue;
    meaningful++;
    const set = l.match(/pm\.(?:environment|collectionVariables|globals|variables)\.set\(\s*["'`]([\w.-]+)["'`]\s*,\s*(.+?)\s*\)\s*;?\s*$/)
      || l.match(/postman\.setEnvironmentVariable\(\s*["'`]([\w.-]+)["'`]\s*,\s*(.+?)\s*\)\s*;?\s*$/);
    if (set) { const p = toPath(set[2]); if (p) { captures.push({ key: set[1], value: p, enabled: true }); converted++; continue; } }
    const st = l.match(/pm\.response\.to\.have\.status\(\s*(\d{3})\s*\)/) || l.match(/pm\.expect\(\s*pm\.response\.code\s*\)\.to\.(?:eql|equal|be\.equal)\(\s*(\d{3})\s*\)/)
      || l.match(/tests\[.*\]\s*=\s*responseCode\.code\s*===\s*(\d{3})/);
    if (st) { expectStatus = st[1]; converted++; continue; }
  }
  return { captures, expectStatus, converted, remaining: meaningful - converted };
}

function scriptsOf(events = []) {
  const pre = joined(events.find((e) => e.listen === "prerequest")?.script?.exec);
  const test = joined(events.find((e) => e.listen === "test")?.script?.exec);
  return { pre, test };
}

/* ---------------- Store ---------------- */

export class Collections {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(SCHEMA);
  }
  now() { return new Date().toISOString(); }
  changed(kind = "collections") { this.store.emit(kind); }

  // ---- collections
  list() {
    const cols = this.db.prepare("SELECT * FROM collections ORDER BY name COLLATE NOCASE").all();
    const items = this.db.prepare("SELECT * FROM items ORDER BY sort, id").all();
    return cols.map((c) => ({ ...this.hydrateCol(c), items: this.tree(items.filter((i) => i.collection_id === c.id)) }));
  }
  hydrateCol(c) { return !c ? null : { id: c.id, name: c.name, description: c.description || "", variables: P(c.variables, []), auth: P(c.auth, { type: "none" }), source: c.source }; }
  hydrateItem(i) { return !i ? null : { id: i.id, collectionId: i.collection_id, parentId: i.parent_id, kind: i.kind, name: i.name, sort: i.sort, request: P(i.request, null), auth: P(i.auth, { type: "inherit" }) }; }
  tree(rows, parent = null) {
    return rows.filter((r) => (r.parent_id ?? null) === parent).map((r) => {
      const it = this.hydrateItem(r);
      return it.kind === "folder" ? { ...it, items: this.tree(rows, r.id) } : it;
    });
  }
  getCollection(id) { return this.hydrateCol(this.db.prepare("SELECT * FROM collections WHERE id = ?").get(Number(id))); }
  findCollection(nameOrId) {
    if (/^\d+$/.test(String(nameOrId))) return this.getCollection(nameOrId);
    return this.hydrateCol(this.db.prepare("SELECT * FROM collections WHERE name = ? COLLATE NOCASE").get(String(nameOrId)));
  }
  createCollection({ name, description = "", variables = [], auth = { type: "none" }, source = "jodrell" }) {
    const t = this.now();
    const r = this.db.prepare("INSERT INTO collections (name, description, variables, auth, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(name, description, J(variables), J(auth), source, t, t);
    this.changed();
    return this.getCollection(r.lastInsertRowid);
  }
  updateCollection(id, patch) {
    const c = this.getCollection(id);
    if (!c) throw new Error(`No collection ${id}`);
    const n = { ...c, ...patch };
    this.db.prepare("UPDATE collections SET name = ?, description = ?, variables = ?, auth = ?, updated_at = ? WHERE id = ?")
      .run(n.name, n.description, J(n.variables), J(n.auth), this.now(), c.id);
    this.changed();
    return this.getCollection(c.id);
  }
  deleteCollection(id) {
    this.db.prepare("DELETE FROM items WHERE collection_id = ?").run(Number(id));
    this.db.prepare("DELETE FROM collections WHERE id = ?").run(Number(id));
    this.changed();
  }

  // ---- items
  getItem(id) { return this.hydrateItem(this.db.prepare("SELECT * FROM items WHERE id = ?").get(Number(id))); }
  createItem({ collectionId, parentId = null, kind = "request", name, request, auth }) {
    const max = this.db.prepare("SELECT COALESCE(MAX(sort), 0) AS m FROM items WHERE collection_id = ? AND parent_id IS ?").get(Number(collectionId), parentId).m;
    const r = this.db.prepare("INSERT INTO items (collection_id, parent_id, kind, name, sort, request, auth) VALUES (?,?,?,?,?,?,?)")
      .run(Number(collectionId), parentId, kind, name, max + 1, kind === "request" ? J(request || blankRequest()) : null, J(auth || { type: "inherit" }));
    this.changed();
    return this.getItem(r.lastInsertRowid);
  }
  updateItem(id, patch) {
    const it = this.getItem(id);
    if (!it) throw new Error(`No request or folder ${id}`);
    const n = { ...it, ...patch };
    this.db.prepare("UPDATE items SET name = ?, parent_id = ?, request = ?, auth = ? WHERE id = ?")
      .run(n.name, n.parentId ?? null, n.kind === "request" ? J(n.request) : null, J(n.auth), it.id);
    this.changed();
    return this.getItem(it.id);
  }
  deleteItem(id) {
    const kids = this.db.prepare("SELECT id FROM items WHERE parent_id = ?").all(Number(id));
    for (const k of kids) this.deleteItem(k.id);
    this.db.prepare("DELETE FROM items WHERE id = ?").run(Number(id));
    this.changed();
  }
  ancestors(item) {
    const out = [];
    let p = item?.parentId;
    while (p) { const f = this.getItem(p); if (!f) break; out.unshift(f); p = f.parentId; }
    return out;
  }
  pathOf(item) {
    const c = this.getCollection(item.collectionId);
    return [c?.name, ...this.ancestors(item).map((f) => f.name), item.name].join(" / ");
  }
  // Requests in run order, optionally inside one folder.
  requestsIn(collectionId, folderId = null) {
    const rows = this.db.prepare("SELECT * FROM items WHERE collection_id = ? ORDER BY sort, id").all(Number(collectionId));
    const walk = (parent) => rows.filter((r) => (r.parent_id ?? null) === parent).flatMap((r) => (r.kind === "folder" ? walk(r.id) : [this.hydrateItem(r)]));
    return walk(folderId ? Number(folderId) : null);
  }
  // Find by id or by "Collection / Folder / Request" path (case-insensitive, partial last part allowed).
  findRequest(ref) {
    if (/^\d+$/.test(String(ref))) { const it = this.getItem(ref); return it?.kind === "request" ? it : null; }
    const want = String(ref).toLowerCase().split("/").map((s) => s.trim()).filter(Boolean);
    const all = this.db.prepare("SELECT * FROM items WHERE kind = 'request'").all().map((r) => this.hydrateItem(r));
    const scored = all.map((it) => ({ it, path: this.pathOf(it).toLowerCase().split(" / ") })).filter(({ path }) => {
      if (want.length > path.length) return false;
      const tail = path.slice(path.length - want.length);
      return tail.every((p, i) => (i === want.length - 1 ? p.includes(want[i]) : p === want[i]));
    });
    if (scored.length === 1) return scored[0].it;
    const exact = scored.filter(({ path }) => path[path.length - 1] === want[want.length - 1]);
    if (exact.length === 1) return exact[0].it;
    if (scored.length > 1) throw new Error(`"${ref}" matches ${scored.length} requests: ${scored.slice(0, 6).map(({ it }) => `#${it.id} ${this.pathOf(it)}`).join("; ")}. Use the id or a longer path.`);
    return null;
  }

  // ---- environments
  environments() {
    const active = this.activeEnvId();
    return this.db.prepare("SELECT * FROM environments ORDER BY name COLLATE NOCASE").all().map((e) => ({ id: e.id, name: e.name, vars: P(e.vars, []), active: e.id === active }));
  }
  getEnv(id) { return this.environments().find((e) => e.id === Number(id)) || null; }
  findEnv(nameOrId) { return this.environments().find((e) => e.id === Number(nameOrId) || e.name.toLowerCase() === String(nameOrId).toLowerCase()) || null; }
  createEnv({ name, vars = [] }) {
    const r = this.db.prepare("INSERT INTO environments (name, vars, updated_at) VALUES (?,?,?)").run(name, J(vars), this.now());
    this.changed("environments");
    return this.getEnv(r.lastInsertRowid);
  }
  updateEnv(id, patch) {
    const e = this.getEnv(id);
    if (!e) throw new Error(`No environment ${id}`);
    const n = { ...e, ...patch };
    this.db.prepare("UPDATE environments SET name = ?, vars = ?, updated_at = ? WHERE id = ?").run(n.name, J(n.vars), this.now(), e.id);
    this.changed("environments");
    return this.getEnv(e.id);
  }
  deleteEnv(id) {
    if (this.activeEnvId() === Number(id)) this.setActiveEnv(null);
    this.db.prepare("DELETE FROM environments WHERE id = ?").run(Number(id));
    this.changed("environments");
  }
  activeEnvId() { const v = this.db.prepare("SELECT value FROM settings WHERE key = 'active_env'").get()?.value; return v ? Number(v) : null; }
  activeEnv() { const id = this.activeEnvId(); return id ? this.getEnv(id) : null; }
  setActiveEnv(id) {
    this.db.prepare("INSERT INTO settings (key, value) VALUES ('active_env', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(id ? String(id) : null);
    this.changed("environments");
  }

  // Save a variable where Postman would put it: the active environment if there
  // is one, otherwise the collection.
  setVariable(name, value, { collectionId, scope } = {}) {
    const env = this.activeEnv();
    const upsert = (vars) => {
      const v = vars.find((x) => x.key === name);
      if (v) { v.value = String(value); v.enabled = true; } else vars.push({ key: name, value: String(value), enabled: true });
      return vars;
    };
    if ((scope === "environment" || !scope) && env) { this.updateEnv(env.id, { vars: upsert(env.vars) }); return `environment "${env.name}"`; }
    if (collectionId) { const c = this.getCollection(collectionId); this.updateCollection(c.id, { variables: upsert(c.variables) }); return `collection "${c.name}"`; }
    if (scope === "environment") throw new Error("No active environment. Select one first.");
    const e = this.createEnv({ name: "Local", vars: [{ key: name, value: String(value), enabled: true }] });
    this.setActiveEnv(e.id);
    return `new environment "Local"`;
  }

  // ---- Postman import (collection v2.0/v2.1, or an environment file)
  importPostman(input) {
    let data = input;
    if (typeof input === "string") { try { data = JSON.parse(input); } catch { throw Object.assign(new Error("That isn't valid JSON. Export the collection from Postman as Collection v2.1, or the environment as JSON."), { status: 400 }); } }
    if (data?.values && (data._postman_variable_scope || data.name) && !data.item) {
      const vars = kv(data.values);
      const existing = this.findEnv(data.name);
      const env = existing ? this.updateEnv(existing.id, { vars }) : this.createEnv({ name: data.name || "Imported environment", vars });
      return { kind: "environment", environment: env.name, variables: vars.length, notes: [] };
    }
    const col = data?.collection || data; // Postman API export wraps it
    if (!col?.info || !Array.isArray(col.item)) throw new Error("This doesn't look like a Postman collection (v2.0 or v2.1) or environment export.");
    const notes = [];
    const stats = { requests: 0, folders: 0, capturesFromScripts: 0, scriptLinesSkipped: 0 };
    const c = this.createCollection({
      name: col.info.name || "Imported collection",
      description: typeof col.info.description === "string" ? col.info.description : col.info.description?.content || "",
      variables: kv(col.variable).map(({ key, value, enabled }) => ({ key, value, enabled })),
      auth: col.auth ? postmanAuth(col.auth) : { type: "none" },
      source: "postman",
    });
    const colScripts = scriptsOf(col.event);
    if (colScripts.pre || colScripts.test) notes.push("The collection has its own scripts, which aren't run.");
    const add = (items, parentId, trail) => {
      for (const it of items) {
        if (Array.isArray(it.item)) {
          stats.folders++;
          const f = this.createItem({ collectionId: c.id, parentId, kind: "folder", name: it.name || "Folder", auth: it.auth ? postmanAuth(it.auth) : { type: "inherit" } });
          add(it.item, f.id, [...trail, it.name]);
          continue;
        }
        stats.requests++;
        const r = typeof it.request === "string" ? { url: it.request, method: "GET" } : it.request || {};
        const { url, pathVars } = postmanUrl(r.url);
        const { body, notes: bodyNotes } = postmanBody(r.body);
        const scripts = scriptsOf(it.event);
        const conv = convertScript(scripts.test);
        stats.capturesFromScripts += conv.converted;
        stats.scriptLinesSkipped += conv.remaining;
        const preLines = scripts.pre.split("\n").filter((l) => l.trim() && !l.trim().startsWith("//")).length;
        stats.scriptLinesSkipped += preLines;
        const where = [...trail, it.name].join(" / ");
        for (const n of bodyNotes) notes.push(`${where} ${n}.`);
        const auth = r.auth ? postmanAuth(r.auth) : { type: "inherit" };
        if (auth.type === "unsupported") notes.push(`${where} uses ${auth.original} auth, which isn't supported yet.`);
        this.createItem({
          collectionId: c.id, parentId, kind: "request", name: it.name || url || "Request",
          request: blankRequest({
            method: (r.method || "GET").toUpperCase(), url, pathVars, headers: kv(r.header), body, auth,
            captures: conv.captures, expectStatus: conv.expectStatus, scripts,
            description: typeof r.description === "string" ? r.description : r.description?.content || "",
          }),
        });
      }
    };
    add(col.item, null, []);
    if (stats.scriptLinesSkipped) notes.push(`${stats.scriptLinesSkipped} script line(s) weren't converted and won't run. Check the After response tab of those requests.`);
    return { kind: "collection", collection: c.name, id: c.id, ...stats, notes };
  }
}

/* ---------------- Resolving variables and auth ---------------- */

const DYNAMIC = {
  $guid: () => randomUUID(), $randomUUID: () => randomUUID(),
  $timestamp: () => String(Math.floor(Date.now() / 1000)), $isoTimestamp: () => new Date().toISOString(),
  $randomInt: () => String(Math.floor(Math.random() * 1001)),
};

export function makeVars(...layers) {
  const vars = {};
  for (const layer of layers) {
    if (!layer) continue;
    if (Array.isArray(layer)) for (const v of layer) { if (v && v.enabled !== false && v.key) vars[v.key] = v.value; }
    else Object.assign(vars, layer);
  }
  return vars;
}

export function interpolate(str, vars, unresolved) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{\s*([$\w.\-]+)\s*\}\}/g, (m, k) => {
    if (DYNAMIC[k]) return DYNAMIC[k]();
    if (vars[k] !== undefined && vars[k] !== null) return typeof vars[k] === "object" ? JSON.stringify(vars[k]) : String(vars[k]);
    unresolved?.add(k);
    return m;
  });
}

// Pick the auth that applies: the request's own, else the nearest folder's, else the collection's.
export function effectiveAuth(request, ancestors = [], collection) {
  if (request?.auth && request.auth.type !== "inherit") return request.auth;
  for (const f of [...ancestors].reverse()) if (f.auth && f.auth.type !== "inherit") return f.auth;
  return collection?.auth || { type: "none" };
}

// Request -> { method, url, headers, body, unresolved[] } ready for the runner.
export function resolveRequest(request, { vars = {}, auth } = {}) {
  const un = new Set();
  const I = (s) => interpolate(s, vars, un);
  let url = I(request.url || "").trim();
  for (const pv of request.pathVars || []) {
    if (!pv.key) continue;
    url = url.replace(new RegExp(`/:${pv.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=/|\\?|#|$)`, "g"), "/" + encodeURIComponent(I(pv.value ?? "")));
  }
  if (url && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !url.includes("{{")) url = "https://" + url;
  const headers = {};
  for (const h of request.headers || []) if (h.enabled !== false && h.key) headers[I(h.key)] = I(h.value ?? "");
  const has = (n) => Object.keys(headers).some((k) => k.toLowerCase() === n);

  const a = auth || { type: "none" };
  let authQuery = null;
  if (a.type === "bearer" && a.token && !has("authorization")) headers.Authorization = `Bearer ${I(a.token)}`;
  if (a.type === "basic" && (a.username || a.password) && !has("authorization")) headers.Authorization = "Basic " + Buffer.from(`${I(a.username || "")}:${I(a.password || "")}`).toString("base64");
  if (a.type === "apikey" && a.key) { if (a.in === "query") authQuery = [I(a.key), I(a.value || "")]; else if (!has(a.key.toLowerCase())) headers[I(a.key)] = I(a.value || ""); }
  if (authQuery) {
    try { const u = new URL(url); u.searchParams.set(authQuery[0], authQuery[1]); url = u.toString(); } catch {}
  }

  const b = request.body || { mode: "none" };
  let body;
  const ctype = (t) => { if (!has("content-type")) headers["Content-Type"] = t; };
  if (b.mode === "json") { body = I(b.raw || ""); ctype("application/json"); }
  else if (b.mode === "text") { body = I(b.raw || ""); ctype("text/plain"); }
  else if (b.mode === "xml") { body = I(b.raw || ""); ctype("application/xml"); }
  else if (b.mode === "urlencoded") {
    const p = new URLSearchParams();
    for (const f of b.fields || []) if (f.enabled !== false && f.key) p.append(I(f.key), I(f.value ?? ""));
    body = p; ctype("application/x-www-form-urlencoded");
  } else if (b.mode === "formdata") {
    const fd = new FormData();
    for (const f of b.fields || []) if (f.enabled !== false && f.key && f.type !== "file") fd.append(I(f.key), I(f.value ?? ""));
    body = fd;
  } else if (b.mode === "graphql") {
    let variables;
    try { variables = b.graphql?.variables ? JSON.parse(I(b.graphql.variables)) : undefined; } catch { variables = undefined; }
    body = JSON.stringify({ query: I(b.graphql?.query || ""), variables });
    ctype("application/json");
  }
  return { method: (request.method || "GET").toUpperCase(), url, headers, body, unresolved: [...un] };
}
