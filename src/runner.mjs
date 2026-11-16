// Builds and sends requests, applies sessions, validates against the spec and
// records every call. Used by the MCP tools, the web UI and collection runs.
import { createRequire } from "node:module";
import { redactHeaders, redactBody, validateResponse, isSecretHeader, mask } from "./checks.mjs";
import { makeVars, resolveRequest, effectiveAuth } from "./collections.mjs";

const VERSION = createRequire(import.meta.url)("../package.json").version;
const STORE_BODY_LIMIT = 1_000_000; // bytes kept in history per response
const TIMEOUT_MS = 30_000;

// Raw secret headers from direct calls (by database and call id), kept in memory only so replay works
// without writing secrets to disk.
const rawSecrets = new Map();

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };
const domainMatch = (host, domain) => host === domain || host.endsWith("." + domain);

// "{{vars.userId}}" or "{{userId}}" -> session variable (agent-side templating)
function fill(value, vars) {
  if (typeof value === "string") {
    const whole = value.match(/^\{\{\s*(?:vars\.)?([\w.-]+)\s*\}\}$/);
    if (whole && vars[whole[1]] !== undefined) return vars[whole[1]];
    return value.replace(/\{\{\s*(?:vars\.)?([\w.-]+)\s*\}\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value && typeof value === "object" && value.constructor === Object) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
}

function joinUrl(base, p) {
  if (/^https?:\/\//.test(p)) return p;
  if (!base) throw new Error(`No base URL for "${p}". Start with --base-url, or add servers[0].url to the spec.`);
  return base.replace(/\/$/, "") + "/" + p.replace(/^\//, "");
}

// Cookie jar: { domain: { name: value } }. Cookies only go back to matching hosts.
function storeCookies(list, jar, host) {
  for (const line of list) {
    const [pair, ...attrs] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq < 1) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const a = attrs.map((x) => x.trim());
    const dom = (a.find((x) => /^domain=/i.test(x))?.slice(7) || host).replace(/^\./, "").toLowerCase();
    const expired = a.some((x) => /^max-age=0$/i.test(x) || (/^expires=/i.test(x) && Date.parse(x.slice(8)) < Date.now()));
    jar[dom] ??= {};
    if (expired || value === "") delete jar[dom][name]; else jar[dom][name] = value;
    if (!Object.keys(jar[dom]).length) delete jar[dom];
  }
  return jar;
}
function cookiesFor(jar, host) {
  const out = {};
  for (const [dom, cookies] of Object.entries(jar || {})) {
    if (typeof cookies !== "object") continue; // old flat format: drop rather than leak
    if (domainMatch(host, dom)) Object.assign(out, cookies);
  }
  return out;
}

// Session headers are { name: "value" } (sent everywhere, set explicitly) or
// { name: { value, host } } (captured from a response: only sent to that host).
function sessionHeadersFor(headers, host) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (v && typeof v === "object") { if (v.host && domainMatch(host, v.host)) out[k] = v.value; }
    else out[k] = v;
  }
  return out;
}

function bodyText(body) {
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (typeof FormData !== "undefined" && body instanceof FormData) return [...body.entries()].map(([k, v]) => `${k}: ${typeof v === "string" ? v : "[file]"}`).join("\n");
  return JSON.stringify(body);
}

export class Runner {
  constructor({ store, specs, collections, auth }) {
    this.store = store;
    this.specs = specs;
    this.collections = collections;
    this.auth = auth;
  }

  // Build a request from an operation and its arguments.
  fromOperation(opId, args = {}, session) {
    const vars = { ...this.envVars(), ...(session ? this.store.getSession(session).vars : {}) };
    const { pathParams = {}, query = {}, headers = {}, body } = fill(args, vars);
    const op = this.specs.get(opId);
    if (!op) {
      const near = this.specs.list().filter((o) => o.id.toLowerCase().includes(opId.toLowerCase().slice(0, 4))).slice(0, 5).map((o) => o.id);
      throw new Error(`Unknown operation "${opId}".${near.length ? " Did you mean: " + near.join(", ") + "?" : " Use list_operations to see them."}`);
    }
    // Required path parameters: the declared ones, plus any {name} in the path (specs often forget to declare them).
    const pathNames = new Set([...op.params.filter((p) => p.in === "path").map((p) => p.name), ...[...op.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])]);
    const missing = [...pathNames].filter((n) => pathParams[n] === undefined || pathParams[n] === null || pathParams[n] === "");
    if (missing.length) throw new Error(`Missing path parameter(s) for ${op.id}: ${missing.join(", ")}`);
    const p = op.path.replace(/\{([^}]+)\}/g, (_, k) => encodeURIComponent(String(pathParams[k])));
    const url = new URL(joinUrl(op.baseUrl, p));
    for (const [k, v] of Object.entries(query || {})) {
      if (v === undefined || v === null) continue;
      for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, String(item));
    }
    return { op, method: op.method, url: url.toString(), headers, body };
  }

  // {{env.NAME}} (your environment and .env), then the active environment.
  envVars() { return makeVars(this.auth?.env(), this.collections?.activeEnv()?.vars); }

  // auth: false skips auth profiles. authLogin names the profile this request
  // signs in for (set by jodrell's own sign-in).
  async send(args) {
    let { op, method, url, headers = {}, body, session, note, source = "agent", runId, capture, replayOf, itemId, itemName, expectStatus, auth: useAuth = true, authLogin, authRetry } = args;
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(String(method || ""))) throw new Error(`"${String(method).slice(0, 40)}" isn't a valid HTTP method.`);
    const sess = session ? this.store.getSession(session) : null;
    const vars = { ...this.envVars(), ...(sess?.vars || {}) };
    url = fill(url, vars);
    if (typeof body === "string" || (body && body.constructor === Object) || Array.isArray(body)) body = fill(body, vars);
    headers = fill(headers, vars);
    if (/\{\{/.test(url)) throw new Error(`The URL still has unresolved variables: ${url.match(/\{\{[^}]+\}\}/g).join(", ")}. Set them in the environment or collection variables.`);
    if (!/^https?:\/\//i.test(url)) throw new Error(`"${url}" isn't a full http(s) URL.`);
    op = op || this.specs.match(method, url);
    const host = hostOf(url);
    const loginProfile = this.auth ? (authLogin ? this.auth.profile(authLogin) : this.auth.loginFor(method, url)) : null;

    const h = { ...(sess ? sessionHeadersFor(sess.headers, host) : {}), ...headers };
    const lower = (n) => Object.keys(h).some((k) => k.toLowerCase() === n);
    if (sess && !lower("cookie")) {
      const jar = cookiesFor(sess.cookies, host);
      if (Object.keys(jar).length) h.cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
    }
    let reqBody;
    if (body !== undefined && body !== null && body !== "" && !["GET", "HEAD"].includes(method)) {
      if (typeof body === "string" || body instanceof URLSearchParams || body instanceof FormData) reqBody = body;
      else { reqBody = JSON.stringify(body); if (!lower("content-type")) h["content-type"] = "application/json"; }
    }
    if (!lower("accept")) h.accept = "application/json, */*";
    if (!lower("user-agent")) h["user-agent"] = `jodrell/${VERSION}`;

    // Auth profiles: sign in if needed, then add the token. A request that
    // already has its own auth header is left alone.
    let authProfile = null, authApplied = false, shownUrl = url, authNote = null, autoHeader = null;
    if (this.auth && useAuth !== false && !loginProfile) {
      authProfile = this.auth.forRequest(method, url, op);
      if (authProfile) {
        let got;
        try { got = await this.auth.ensure(authProfile, this, { source, runId }); }
        catch (e) {
          const error = `Not sent: couldn't sign in for "${authProfile.name}". ${e.message} Fix that, or send with auth turned off.`;
          return this.store.addCall({ run_id: runId, ts: new Date().toISOString(), source, op_id: op?.id, method, url, session, note, req_headers: redactHeaders(h), req_body: bodyText(reqBody), replay_of: replayOf, item_id: itemId, item_name: itemName, expect_status: expectStatus ? Number(expectStatus) : null, duration_ms: 0, error });
        }
        const r = this.auth.applyTo(authProfile, got.st, h, url);
        authApplied = r.applied; url = r.url; shownUrl = r.shownUrl || url; autoHeader = r.header;
        if (got.signedIn) authNote = `jodrell signed in for "${authProfile.name}"`;
      }
    }

    const started = Date.now();
    const record = {
      run_id: runId, ts: new Date().toISOString(), source, op_id: op?.id, method, url: shownUrl, session, note,
      req_headers: redactHeaders(h), req_body: loginProfile ? redactBody(bodyText(reqBody)) : bodyText(reqBody), replay_of: replayOf,
      item_id: itemId, item_name: itemName, expect_status: expectStatus ? Number(expectStatus) : null,
    };

    let call;
    try {
      const res = await fetch(url, { method, headers: h, body: reqBody, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
      const buf = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get("content-type") || "";
      const textual = /json|text|xml|html|javascript|csv|yaml|form/i.test(type) || type === "";
      const text = textual ? buf.toString("utf8") : null;
      const resHeaders = Object.fromEntries(res.headers.entries());
      const setCookies = res.headers.getSetCookie?.() || [];
      if (setCookies.length) resHeaders["set-cookie"] = setCookies;
      if (sess && setCookies.length) { sess.cookies = storeCookies(setCookies, sess.cookies || {}, host); this.store.saveSession(sess); }

      Object.assign(record, {
        status: res.status,
        res_headers: redactHeaders(resHeaders),
        res_body: text === null ? `[${buf.length} bytes of ${type || "binary data"}]` : loginProfile ? redactBody(text.slice(0, STORE_BODY_LIMIT)) : text.slice(0, STORE_BODY_LIMIT),
        res_size: buf.length,
        res_type: type,
        truncated: text !== null && text.length > STORE_BODY_LIMIT,
        duration_ms: Date.now() - started,
        validation: validateResponse(op, res.status, type, text),
      });
      call = this.store.addCall(record);
      call.ctx = { body: (() => { try { return JSON.parse(text); } catch { return text; } })(), header: Object.fromEntries(Object.entries(resHeaders).map(([k, v]) => [k.toLowerCase(), v])), headers: resHeaders, status: res.status };
      if (capture && session) call.captured = this.applyCapture(session, capture, call.ctx, host);
      if (loginProfile) call.auth = { profile: loginProfile.name, ...this.auth.acceptLogin(loginProfile, { ctx: call.ctx, setCookies, host, callId: call.id }) };
      else if (authProfile) call.auth = { profile: authProfile.name, applied: authApplied, note: authNote };
    } catch (e) {
      const cause = e.cause?.errors?.[0] || e.cause;
      const reason = e.name === "TimeoutError" ? `Timed out after ${TIMEOUT_MS / 1000}s`
        : cause?.code === "ECONNREFUSED" ? `Connection refused at ${new URL(url).host}. Is the API running?`
        : cause?.code === "ENOTFOUND" ? `Host not found: ${new URL(url).host}`
        : cause?.code ? `${cause.code}: ${cause.message || e.message}`
        : cause?.message ? `Request failed: ${cause.message}` : e.message;
      call = this.store.addCall({ ...record, duration_ms: Date.now() - started, error: reason });
    }
    // Kept for replay. A token jodrell added itself isn't: replay adds the current one.
    const secrets = Object.fromEntries(Object.entries(h).filter(([k]) => isSecretHeader(k) && k.toLowerCase() !== "cookie" && k !== autoHeader));
    if (Object.keys(secrets).length) rawSecrets.set(`${this.store.file}#${call.id}`, secrets);

    // The API rejected jodrell's token: sign in again and send once more.
    if (authApplied && call.status === 401) {
      this.auth.markRejected(authProfile, call.status);
      if (!authRetry) {
        try { await this.auth.ensure(authProfile, this, { force: true, source, runId }); }
        catch { return call; }
        const again = await this.send({ ...args, authRetry: true, note: [note, `sent again after jodrell signed in for "${authProfile.name}"`].filter(Boolean).join(". ") });
        again.retriedFrom = call.id;
        return again;
      }
    }
    return call;
  }

  // Agent-style capture into a session:
  // { "header:Authorization": "Bearer {{body.access_token}}", "var:orderId": "{{body.id}}" }
  // Captured headers are tied to the host that issued them.
  applyCapture(sessionName, capture, ctx, host) {
    const sess = this.store.getSession(sessionName);
    const out = {};
    for (const [target, template] of Object.entries(capture)) {
      const whole = String(template).match(/^\{\{\s*([\w.\-]+)\s*\}\}$/);
      const value = whole ? get(ctx, whole[1]) : String(template).replace(/\{\{\s*([\w.\-]+)\s*\}\}/g, (_, p) => String(get(ctx, p) ?? ""));
      if (value === undefined) { out[target] = "not found"; continue; }
      const [kind, name] = target.includes(":") ? target.split(/:(.*)/s) : ["var", target];
      if (kind === "header") { sess.headers[name] = { value: String(value), host }; out[target] = `${mask(value)} (sent to ${host} only)`; }
      else { sess.vars[name] = value; out[target] = isSecretHeader(name) ? mask(value) : value; }
    }
    this.store.saveSession(sess);
    return out;
  }

  // Saved-request captures: [{ key: "token", value: "body.access_token" }] into
  // the active environment (or the collection), the way Postman scripts would.
  applyRequestCaptures(captures, ctx, collectionId) {
    const out = {};
    for (const c of captures || []) {
      if (c.enabled === false || !c.key || !c.value) continue;
      const v = get(ctx, c.value.trim());
      if (v === undefined) { out[c.key] = "not found"; continue; }
      const where = this.collections.setVariable(c.key, typeof v === "object" ? JSON.stringify(v) : v, { collectionId });
      out[c.key] = `${isSecretHeader(c.key) ? mask(v) : String(v).slice(0, 60)} → ${where}`;
    }
    return out;
  }

  // Send a request from the builder or a saved item. collectionId (and the
  // item's folders) supply variables and inherited auth.
  async sendRequest(request, { itemId, collectionId, session, vars: extra, note, source = "ui", runId } = {}) {
    const item = itemId ? this.collections.getItem(itemId) : null;
    const colId = item?.collectionId ?? collectionId;
    const col = colId ? this.collections.getCollection(colId) : null;
    const ancestors = item ? this.collections.ancestors(item) : [];
    const sess = session ? this.store.getSession(session) : null;
    const vars = makeVars(this.auth?.env(), col?.variables, this.collections.activeEnv()?.vars, sess?.vars, extra);
    const r = resolveRequest(request, { vars, auth: effectiveAuth(request, ancestors, col) });
    if (r.unresolved.length) throw Object.assign(new Error(`Unresolved variables: ${r.unresolved.map((v) => `{{${v}}}`).join(", ")}. Set them in the environment or the collection's variables.`), { status: 400 });
    const call = await this.send({
      method: r.method, url: r.url, headers: r.headers, body: r.body, session, note, source, runId,
      itemId: item?.id, itemName: item ? this.collections.pathOf(item) : null, expectStatus: request.expectStatus,
    });
    if (!call.error && request.captures?.length) call.captured = this.applyRequestCaptures(request.captures, call.ctx, colId);
    return call;
  }

  async runItem(itemId, opts = {}) {
    const item = this.collections.getItem(itemId);
    if (!item || item.kind !== "request") throw new Error(`No saved request ${itemId}`);
    return this.sendRequest(item.request, { ...opts, itemId: item.id });
  }

  // Run every request in a collection (or folder) in order.
  async runCollection(collectionId, { folderId, session, source = "ui", stopOnFailure = false, onCall } = {}) {
    const col = this.collections.getCollection(collectionId);
    if (!col) throw new Error(`No collection ${collectionId}`);
    const folder = folderId ? this.collections.getItem(folderId) : null;
    const run = this.store.createRun(`Run: ${col.name}${folder ? " / " + folder.name : ""}`, source);
    const results = [];
    for (const item of this.collections.requestsIn(col.id, folder?.id)) {
      let call, error;
      try { call = await this.runItem(item.id, { session, source, runId: run.id }); } catch (e) { error = e.message; }
      const passed = !error && !call.error && (call.expect_status ? call.status === call.expect_status : call.status < 400);
      const res = { item: this.collections.pathOf(item), itemId: item.id, callId: call?.id, status: call?.status, error: error || call?.error, expected: call?.expect_status, passed, captured: call?.captured, ms: call?.duration_ms };
      results.push(res);
      onCall?.(res);
      if (!passed && stopOnFailure) break;
    }
    const summary = { runId: run.id, name: run.name, total: results.length, passed: results.filter((r) => r.passed).length, results };
    this.store.emit("rundone", summary);
    return summary;
  }

  // Re-send a stored call, optionally edited. Secrets come from the session
  // (or memory, for this process), never from the redacted history.
  async replay(id, edits = {}, runId) {
    const orig = this.store.getCall(id);
    if (!orig) throw new Error(`No call with id ${id}`);
    const headers = { ...(edits.headers ?? orig.req_headers), ...(rawSecrets.get(`${this.store.file}#${orig.id}`) || {}) };
    for (const [k, v] of Object.entries(headers)) if (String(v).includes("••••")) delete headers[k];
    const body = edits.body !== undefined ? edits.body : orig.req_body;
    return this.send({
      op: orig.op_id ? this.specs.get(orig.op_id) : null,
      method: edits.method || orig.method, url: edits.url || orig.url, headers, body: body ?? undefined,
      session: edits.session !== undefined ? edits.session || undefined : orig.session || undefined,
      note: edits.note || undefined, source: "ui", runId, replayOf: orig.id, itemId: orig.item_id, itemName: orig.item_name, expectStatus: orig.expect_status,
    });
  }
}
