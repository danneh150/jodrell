// Auth profiles. Describe how to sign in to an API once, in jodrell.config.json,
// and jodrell signs in when a request needs it, adds the token, and signs in
// again when the token expires or the API rejects it.
//
// "auth": {
//   "shop": {
//     "login": { "op": "login", "body": { "username": "{{env.SHOP_USER}}", "password": "{{env.SHOP_PASS}}" } },
//     "token": "body.access_token"          // optional: common places are tried
//   },
//   "billing": { "clientCredentials": { "clientId": "{{env.BILLING_ID}}", "clientSecret": "{{env.BILLING_SECRET}}" } },
//   "cloud":   { "command": "gcloud auth print-access-token", "hosts": ["example.googleapis.com"] },
//   "search":  { "value": "{{env.SEARCH_KEY}}" }
// }
//
// Optional on any profile: "spec" (the spec title it applies to), "hosts",
// "apply" ({ "header", "prefix" } | { "query" } | { "cookie" }), "expiresIn"
// (a response path, in seconds) and "ttl" (seconds).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { exec } from "node:child_process";
import { mask } from "./checks.mjs";

const MARGIN_MS = 30_000;          // treat a token as expired this long before it really is
const SOON_MS = 2 * 60_000;        // "expires soon" in the GUI
const COMMAND_TTL_S = 300;         // tokens from a command are fetched again after this long
const TOKEN_PATHS = ["body.access_token", "body.accessToken", "body.token", "body.id_token", "body.jwt", "body.data.token", "body.data.access_token", "body.data.accessToken"];

// Config copied onto objects with no prototype, so nothing inherited (or
// polluted) can ever be read as a setting like "command".
function plain(v) {
  if (Array.isArray(v)) return v.map(plain);
  if (!v || typeof v !== "object") return v;
  return Object.setPrototypeOf(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])), null);
}
const stable = (v) => (Array.isArray(v) ? `[${v.map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}` : JSON.stringify(v));
const shellQuote = (v) => (process.platform === "win32" ? `"${String(v).replace(/"/g, '""')}"` : `'${String(v).replace(/'/g, "'\\''")}'`);
const ENV_REF = /\{\{\s*env\.([\w.-]+)\s*\}\}/g;

// Approvals live outside the project, so a cloned repository can't approve itself.
export function trustFile() {
  if (process.env.JODRELL_HOME) return path.join(process.env.JODRELL_HOME, "trust.json");
  const base = process.platform === "win32" ? process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming") : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "jodrell", "trust.json");
}

const get = (obj, p) => p.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };
const domainMatch = (host, domain) => host === domain || host.endsWith("." + domain);
const isAbs = (u) => /^https?:\/\//i.test(u || "");
// Same scheme, host and port, and a path at or under the base path (on a "/"
// boundary): http://api.test isn't a prefix of http://api.test.evil.example.
const underBase = (url, base) => {
  try {
    const u = new URL(url), b = new URL(base);
    if (u.origin !== b.origin) return false;
    const bp = b.pathname.replace(/\/$/, "");
    return !bp || u.pathname === bp || u.pathname.startsWith(bp + "/");
  } catch { return false; }
};
const sameUrl = (a, b) => { try { const x = new URL(a), y = new URL(b); return x.origin === y.origin && x.pathname.replace(/\/$/, "") === y.pathname.replace(/\/$/, ""); } catch { return false; } };

// .env in the project root: KEY=value lines. The real environment wins.
export function readDotEnv(root) {
  const out = {};
  let text = "";
  try { text = fs.readFileSync(path.join(root, ".env"), "utf8"); } catch { return out; }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][\w.]*)\s*=(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (/^".*"$/.test(v)) v = v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"');
    else if (/^'.*'$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, "");
    out[m[1]] = v;
  }
  return out;
}

// JWTs carry their own expiry. Anything else returns null.
function jwtExpiry(token) {
  const parts = String(token).replace(/^Bearer\s+/i, "").split(".");
  if (parts.length !== 3) return null;
  try { const exp = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).exp; return typeof exp === "number" ? exp * 1000 : null; } catch { return null; }
}

// Variables in sign-in details: {{env.NAME}} (environment and .env) and the
// active environment's own variables.
// used collects the {{env.*}} values filled in, so they can be masked in
// history. wrap, if given, quotes each value (for shell commands).
function fillTemplate(value, vars, missing, used = [], wrap = (x) => x) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k) => {
      if (Object.hasOwn(vars, k) && vars[k] !== undefined && vars[k] !== null) { if (k.startsWith("env.")) used.push(String(vars[k])); return wrap(String(vars[k])); }
      missing.add(k); return m;
    });
  }
  if (Array.isArray(value)) return value.map((v) => fillTemplate(v, vars, missing, used, wrap));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars, missing, used, wrap)]));
  return value;
}

export class Auth {
  constructor({ store, specs, root, config }) {
    this.store = store;
    this.specs = specs;
    this.root = root;
    this.config = config;          // () => the current config
    this.pending = new Map();      // name -> promise, so parallel requests sign in once
  }

  env() {
    const all = { ...readDotEnv(this.root), ...process.env };
    return Object.fromEntries(Object.entries(all).map(([k, v]) => [`env.${k}`, v]));
  }

  /* ---- profiles ---- */

  raw() { const a = this.config()?.auth; return a && typeof a === "object" && !Array.isArray(a) ? plain(a) : Object.create(null); }
  names() { return Object.keys(this.raw()); }

  profile(name) {
    const raw = this.raw()[name];
    if (!raw || typeof raw !== "object") return null;
    const kind = raw.command ? "command" : raw.clientCredentials ? "clientCredentials" : raw.login ? "login" : raw.value !== undefined ? "static" : null;
    const p = { name, raw, kind, problems: [] };
    if (!kind) p.problems.push(`Say how to sign in: add "login", "clientCredentials", "command" or "value".`);
    const loginOp = raw.login?.op ? this.specs.get(raw.login.op) : null;
    if (raw.login?.op && !loginOp) p.problems.push(`The login operation "${raw.login.op}" isn't in any spec.`);
    const loaded = this.specs.specs.filter((s) => !s.error);
    p.spec = raw.spec || loginOp?.spec || (!raw.hosts && loaded.length === 1 ? loaded[0].title : undefined);
    const named = p.spec ? loaded.filter((s) => s.title === p.spec) : [];
    p.specEntry = loginOp ? loaded.find((s) => s.source === loginOp.specSource) || named[0] : named[0] || null;
    if (raw.spec && !named.length) p.problems.push(`No loaded spec is called "${raw.spec}".`);
    else if (named.length > 1 && !loginOp) p.problems.push(`Several specs are called "${p.spec}", so it's not clear which one this is for. Give "hosts" instead.`);
    p.hosts = [].concat(raw.hosts || []).map((h) => String(h).toLowerCase());
    const broad = p.hosts.filter((h) => !h.includes(".") && h !== "localhost");
    if (broad.length) p.problems.push(`"hosts" needs full host names, like api.example.com: "${broad[0]}" would match every site under it.`);
    if (!p.hosts.length && !p.specEntry && kind === "login" && isAbs(raw.login.url)) p.hosts = [hostOf(raw.login.url)];
    if (!p.hosts.length && !p.specEntry) p.problems.push(`Say which API this is for: add "spec" (a spec's title) or "hosts".`);
    p.apply = this.placement(p);
    p.trusted = this.isTrusted(p);
    return p;
  }

  /* ---- approval: a project's sign-in settings are only used once you allow them ---- */

  fingerprint(p) {
    let root = this.root; try { root = fs.realpathSync(root); } catch {}
    return crypto.createHash("sha256").update(stable({ root, name: p.name, raw: p.raw })).digest("hex");
  }
  readTrust() { try { const t = JSON.parse(fs.readFileSync(trustFile(), "utf8")); return Array.isArray(t.allowed) ? t.allowed : []; } catch { return []; } }
  isTrusted(p) { return this.readTrust().includes(this.fingerprint(p)); }
  trust(name) {
    const p = this.profile(name);
    if (!p) throw new Error(`No auth profile called "${name}"`);
    const list = this.readTrust();
    const fp = this.fingerprint(p);
    if (!list.includes(fp)) {
      fs.mkdirSync(path.dirname(trustFile()), { recursive: true });
      fs.writeFileSync(trustFile(), JSON.stringify({ allowed: [...list, fp] }, null, 2), { mode: 0o600 });
    }
    this.store.emit("auth", { name });
    return this.status(name);
  }
  // What a profile will do, in words, so you can decide whether to allow it.
  describe(p) {
    const t = p.kind ? this.loginTemplate(p) : null;
    const env = [...new Set([...JSON.stringify(p.raw).matchAll(ENV_REF)].map((m) => m[1]))];
    const parts = [];
    if (p.kind === "command") parts.push(`runs this command on your computer: ${p.raw.command}`);
    else if (t) parts.push(`sends a sign-in request to ${t.method} ${t.url}`);
    else if (p.kind === "static") parts.push("uses a fixed token");
    if (env.length) parts.push(`using ${env.join(", ")} from .env or your environment`);
    parts.push(`and adds the token to requests for ${[p.specEntry && `${p.specEntry.title}${p.specEntry.baseUrl ? ` (${p.specEntry.baseUrl})` : ""}`, ...p.hosts].filter(Boolean).join(", ") || "nothing yet"}`);
    return parts.join(", ");
  }
  // The {{env.*}} names a profile itself uses: only these go into its sign-in request.
  envNames(p) { return [...new Set([...JSON.stringify(p.raw).matchAll(ENV_REF)].map((m) => `env.${m[1]}`))]; }

  profiles() { return this.names().map((n) => this.profile(n)); }

  // Where the token goes: the profile's "apply", else what the spec's
  // securitySchemes say, else a bearer token in Authorization.
  placement(p) {
    const a = p.raw.apply;
    if (a?.header) return { in: "header", name: a.header, prefix: a.prefix ?? (/^authorization$/i.test(a.header) ? "Bearer " : "") };
    if (a?.query) return { in: "query", name: a.query, prefix: "" };
    if (a?.cookie) return { in: "cookie", name: a.cookie, prefix: "" };
    const schemes = p.specEntry?.securitySchemes || {};
    const used = (p.specEntry?.security || []).flatMap((r) => Object.keys(r || {}));
    const pick = [...used, ...Object.keys(schemes)].map((n) => schemes[n]).find((s) => s && (s.type === "apiKey" || s.type === "oauth2" || s.type === "openIdConnect" || (s.type === "http" && /bearer/i.test(s.scheme || ""))));
    if (pick?.type === "apiKey") return { in: pick.in || "header", name: pick.name, prefix: "" };
    return { in: "header", name: "Authorization", prefix: "Bearer " };
  }

  // The sign-in request, with {{variables}} left in (the GUI shows this).
  loginTemplate(p) {
    const raw = p.raw;
    if (p.kind === "clientCredentials") {
      const cc = raw.clientCredentials;
      const schemes = Object.values(p.specEntry?.securitySchemes || {});
      const tokenUrl = cc.tokenUrl || schemes.map((s) => s.flows?.clientCredentials?.tokenUrl).find(Boolean);
      if (!tokenUrl) return null;
      const fields = { grant_type: "client_credentials", client_id: cc.clientId, client_secret: cc.clientSecret };
      if (cc.scope) fields.scope = cc.scope;
      if (cc.audience) fields.audience = cc.audience;
      return { method: "POST", url: isAbs(tokenUrl) ? tokenUrl : this.joinBase(p, tokenUrl), headers: {}, body: fields, form: true };
    }
    if (p.kind !== "login") return null;
    const l = raw.login;
    if (l.op) {
      const op = this.specs.get(l.op);
      if (!op) return null;
      const pathPart = op.path.replace(/\{([^}]+)\}/g, (m, k) => (l.pathParams?.[k] !== undefined ? String(l.pathParams[k]) : m));
      let url = (op.baseUrl || "").replace(/\/$/, "") + pathPart;
      if (l.query) { const q = new URLSearchParams(l.query).toString(); if (q) url += "?" + q; }
      return { method: op.method, url, headers: l.headers || {}, body: l.body, form: !!l.form, op };
    }
    if (!l.url) return null;
    return { method: (l.method || "POST").toUpperCase(), url: isAbs(l.url) ? l.url : this.joinBase(p, l.url), headers: l.headers || {}, body: l.body, form: !!l.form };
  }

  joinBase(p, rel) {
    const base = p.specEntry?.baseUrl;
    return base ? base.replace(/\/$/, "") + "/" + rel.replace(/^\//, "") : rel;
  }

  // Which profile, if any, signs in a request.
  forRequest(method, url, op) {
    if (op && Array.isArray(op.security) && op.security.length === 0) return null; // the spec says no auth
    const host = hostOf(url);
    for (const p of this.profiles()) {
      if (!p.kind || this.isLogin(p, method, url)) continue;
      if (p.hosts.length && p.hosts.some((h) => domainMatch(host, h))) return p;
      if (p.specEntry) {
        if (op && op.specSource === p.specEntry.source) return p;
        if (!op && p.specEntry.baseUrl && underBase(url, p.specEntry.baseUrl)) return p;
      }
    }
    return null;
  }

  isLogin(p, method, url) {
    const t = this.loginTemplate(p);
    return !!t && t.method === String(method).toUpperCase() && sameUrl(t.url.split("?")[0], String(url).split("?")[0]);
  }

  // A request that is some profile's sign-in request (sent by jodrell, or by
  // you from the GUI), so a successful one updates the token.
  loginFor(method, url) { return this.profiles().find((p) => p.kind && this.isLogin(p, method, url)) || null; }

  /* ---- state ---- */

  state(name) { return this.store.getAuthState(name); }
  hasToken(st) { return !!(st.token || (st.cookies && Object.keys(st.cookies).length)); }
  fresh(st) { return this.hasToken(st) && (!st.expiresAt || Date.parse(st.expiresAt) - MARGIN_MS > Date.now()); }

  signOut(name) { this.store.deleteAuthState(name); }

  markRejected(p, status) {
    const st = this.state(p.name);
    this.store.saveAuthState({ ...st, token: undefined, cookies: undefined, rejectedAt: new Date().toISOString(), rejectedStatus: status });
  }

  // Where the token is in a sign-in response: the profile's "token" path, the
  // usual places, or the session cookies it set. Also used to keep it out of history.
  extractToken(p, ctx, setCookies = []) {
    const tokenPath = p.raw.token || (p.kind === "clientCredentials" ? "body.access_token" : null);
    let token = tokenPath ? get(ctx, tokenPath) : TOKEN_PATHS.map((x) => get(ctx, x)).find((v) => typeof v === "string" && v);
    let cookies;
    if ((token === undefined || token === null || token === "") && setCookies.length && !p.raw.token) {
      cookies = {};
      for (const line of setCookies) { const pair = line.split(";")[0]; const eq = pair.indexOf("="); if (eq > 0 && pair.slice(eq + 1).trim()) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim(); }
      token = undefined;
    }
    if (token !== undefined && token !== null && typeof token !== "string") token = String(token);
    return { token, cookies };
  }

  // Read the token from a sign-in response. Returns a short description.
  acceptLogin(p, { ctx, setCookies = [], host, callId }) {
    const now = new Date().toISOString();
    const prev = this.state(p.name);
    const base = { ...prev, loginCallId: callId, attemptedAt: now };
    if (!ctx || ctx.status < 200 || ctx.status >= 300) {
      const why = ctx?.body && typeof ctx.body === "object" ? ctx.body.error_description || ctx.body.message || ctx.body.error || "" : "";
      const error = `Signing in failed: HTTP ${ctx?.status ?? "no response"}${why && typeof why === "string" ? ` (${why.slice(0, 120)})` : ""}.`;
      this.store.saveAuthState({ ...base, token: undefined, cookies: undefined, error });
      return { ok: false, error };
    }
    const tokenPath = p.raw.token || (p.kind === "clientCredentials" ? "body.access_token" : null);
    let { token, cookies } = this.extractToken(p, ctx, setCookies);
    if ((token === undefined || token === null || token === "") && !(cookies && Object.keys(cookies).length)) {
      const error = `Signed in (HTTP ${ctx.status}), but couldn't find a token in the response${tokenPath ? ` at "${tokenPath}"` : ""}. Set "token" in the auth profile to where it is, like "body.access_token".`;
      this.store.saveAuthState({ ...base, token: undefined, cookies: undefined, error });
      return { ok: false, error };
    }
    const secs = Number(p.raw.expiresIn ? get(ctx, p.raw.expiresIn) : get(ctx, "body.expires_in"));
    const expMs = secs > 0 ? Date.now() + secs * 1000 : (token && jwtExpiry(token)) || (p.raw.ttl ? Date.now() + p.raw.ttl * 1000 : null);
    this.store.saveAuthState({ name: p.name, token: token != null ? String(token) : undefined, cookies, cookieHost: cookies ? host : undefined, obtainedAt: now, expiresAt: expMs ? new Date(expMs).toISOString() : undefined, loginCallId: callId, attemptedAt: now });
    return { ok: true };
  }

  // Make sure a profile has a usable token, signing in if needed.
  // runner sends the sign-in request, so it's recorded like any other.
  async ensure(p, runner, opts = {}) {
    const force = Object.hasOwn(opts, "force") && opts.force === true;
    const { source, runId } = opts;
    if (!p.trusted) throw new Error(`"${p.name}" hasn't been allowed yet. Open it in jodrell's GUI (Sign-in) and choose Allow, or run npx jodrell trust ${p.name}. It ${this.describe(p)}.`);
    if (!force) { const st = this.state(p.name); if (this.fresh(st)) return { st, signedIn: false }; }
    if (this.pending.has(p.name)) return this.pending.get(p.name);
    const job = this.signIn(p, runner, { source, runId }).finally(() => this.pending.delete(p.name));
    this.pending.set(p.name, job);
    return job;
  }

  async signIn(p, runner, { source = "agent", runId } = {}) {
    if (p.problems.length) throw new Error(p.problems[0]);
    if (!p.trusted) throw new Error(`"${p.name}" hasn't been allowed yet. Open it in jodrell's GUI (Sign-in) and choose Allow, or run npx jodrell trust ${p.name}. It ${this.describe(p)}.`);
    const vars = { ...(runner?.envVars?.() || {}), ...this.env() };
    const missing = new Set();
    const now = new Date().toISOString();
    const fail = (error) => { this.store.saveAuthState({ ...this.state(p.name), token: undefined, cookies: undefined, error, attemptedAt: now }); throw new Error(error); };
    const missingMsg = () => `${[...missing].map((m) => m.replace(/^env\./, "")).join(", ")} ${missing.size === 1 ? "isn't" : "aren't"} set. Add ${missing.size === 1 ? "it" : "them"} to .env in the project, or to your environment.`;

    if (p.kind === "static") {
      const value = fillTemplate(String(p.raw.value), vars, missing);
      if (missing.size) fail(missingMsg());
      const st = this.store.saveAuthState({ name: p.name, token: value, obtainedAt: now, attemptedAt: now, expiresAt: p.raw.ttl ? new Date(Date.now() + p.raw.ttl * 1000).toISOString() : undefined });
      return { st, signedIn: true };
    }
    if (p.kind === "command") {
      // Only {{env.*}} goes into a command, quoted, so no value can add shell syntax.
      const cmd = fillTemplate(String(p.raw.command), this.env(), missing, [], shellQuote);
      if (missing.size) fail(missingMsg());
      let out;
      try {
        out = await new Promise((resolve, reject) => exec(cmd, { cwd: this.root, timeout: 30_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().split("\n").pop())) : resolve(stdout))));
      } catch (e) { fail(`The token command failed: ${e.message}`); }
      const token = String(out).trim().split(/\r?\n/).pop()?.trim();
      if (!token) fail("The token command printed nothing.");
      const ttl = p.raw.ttl ?? COMMAND_TTL_S;
      const exp = jwtExpiry(token);
      const st = this.store.saveAuthState({ name: p.name, token, obtainedAt: now, attemptedAt: now, expiresAt: new Date(Math.min(exp || Infinity, Date.now() + ttl * 1000)).toISOString() });
      return { st, signedIn: true };
    }

    const t = this.loginTemplate(p);
    if (!t) fail(p.kind === "clientCredentials" ? `No token URL: add "tokenUrl" to clientCredentials, or an oauth2 clientCredentials flow to the spec.` : "The sign-in request is incomplete: give \"op\", or \"url\" and \"method\".");
    const used = [];
    const req = fillTemplate({ url: t.url, headers: t.headers, body: t.body }, vars, missing, used);
    if (missing.size) fail(missingMsg());
    const body = t.form && req.body && typeof req.body === "object" ? new URLSearchParams(Object.entries(req.body).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])) : req.body;
    const call = await runner.send({ op: t.op, method: t.method, url: req.url, headers: req.headers, body, source, runId, note: `jodrell signed in for "${p.name}"`, auth: false, authLogin: p.name, secrets: used });
    if (call.error) fail(`Couldn't reach the sign-in endpoint: ${call.error}`);
    const st = this.state(p.name);
    if (!this.fresh(st)) throw new Error(st.error || "Signing in didn't produce a usable token.");
    return { st, signedIn: true, callId: call.id };
  }

  // Add the token to a request. Explicit auth on the request always wins.
  applyTo(p, st, headers, url) {
    const has = (n) => Object.keys(headers).find((k) => k.toLowerCase() === n.toLowerCase());
    if (st.cookies && Object.keys(st.cookies).length) {
      const existing = has("cookie");
      const add = Object.entries(st.cookies).filter(([n]) => !(existing && new RegExp(`(^|;\\s*)${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`).test(headers[existing])));
      if (!add.length) return { url, applied: false };
      const s = add.map(([k, v]) => `${k}=${v}`).join("; ");
      if (existing) headers[existing] += "; " + s; else headers.cookie = s;
      return { url, applied: true };
    }
    const a = p.apply;
    const value = (a.prefix || "") + st.token;
    if (a.in === "header") { if (has(a.name)) return { url, applied: false }; headers[a.name] = value; return { url, applied: true, header: a.name }; }
    if (a.in === "cookie") {
      const existing = has("cookie");
      if (existing && new RegExp(`(^|;\\s*)${a.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=`).test(headers[existing])) return { url, applied: false };
      if (existing) headers[existing] += `; ${a.name}=${st.token}`; else headers.cookie = `${a.name}=${st.token}`;
      return { url, applied: true };
    }
    try {
      const u = new URL(url);
      if (u.searchParams.has(a.name) && !u.searchParams.get(a.name).includes("••••")) return { url, applied: false };
      u.searchParams.set(a.name, st.token);
      const shown = new URL(url); shown.searchParams.set(a.name, mask(st.token));
      return { url: u.toString(), shownUrl: shown.toString(), applied: true };
    } catch { return { url, applied: false }; }
  }

  /* ---- status, for the GUI and the agent ---- */

  status(name) {
    const p = this.profile(name);
    if (!p) return null;
    const st = this.state(name);
    const t = p.kind ? this.loginTemplate(p) : null;
    const now = Date.now();
    const exp = st.expiresAt ? Date.parse(st.expiresAt) : null;
    let state, message;
    if (p.problems.length) { state = "misconfigured"; message = p.problems[0]; }
    else if (!p.trusted) { state = "untrusted"; message = `Waiting for you to allow it. It ${this.describe(p)}. A project's settings could send your secrets anywhere or run commands, so jodrell asks once, and again if they change.`; }
    else if (this.hasToken(st) && exp && exp - MARGIN_MS <= now) { state = "expired"; message = "The token has expired. jodrell signs in again on the next request."; }
    else if (this.hasToken(st) && exp && exp - SOON_MS <= now) { state = "expiring"; message = "Signed in. The token expires soon, and jodrell will sign in again when it does."; }
    else if (this.hasToken(st)) { state = "valid"; message = exp ? "jodrell adds this token to requests for this API, and signs in again before it expires." : "jodrell adds this token to requests for this API. The API didn't say when it expires, so jodrell signs in again if it's rejected."; }
    else if (st.error) { state = "failed"; message = st.error; }
    else if (this.missingVars(p).length) { const m = this.missingVars(p); state = "failed"; message = `${m.join(", ")} ${m.length === 1 ? "isn't" : "aren't"} set, so jodrell can't sign in. Add ${m.length === 1 ? "it" : "them"} to .env in the project, or to your environment.`; }
    else if (st.rejectedAt) { state = "rejected"; message = `The API rejected the token (HTTP ${st.rejectedStatus || 401}). jodrell signs in again on the next request.`; }
    else { state = "none"; message = "Not signed in yet. jodrell signs in on the first request that needs it."; }
    const where = p.apply.in === "header" ? `${p.apply.name} header${p.apply.prefix ? ` (${p.apply.prefix.trim()})` : ""}` : p.apply.in === "query" ? `${p.apply.name} query parameter` : `${p.apply.name} cookie`;
    return {
      name, kind: p.kind, state, message,
      needsAction: state === "failed" || state === "misconfigured" || state === "untrusted",
      how: { login: "a sign-in request", clientCredentials: "OAuth 2 client credentials", command: "a command", static: "a fixed token" }[p.kind] || "not set",
      spec: p.specEntry?.title || null, baseUrl: p.specEntry?.baseUrl || null, hosts: p.hosts,
      placement: st.cookies ? "cookies from the sign-in response" : where,
      token: st.token ? mask((p.apply.prefix || "") + st.token) : st.cookies ? Object.keys(st.cookies).map((n) => `${n}=••••`).join("; ") : null,
      obtainedAt: st.obtainedAt || null, expiresAt: st.expiresAt || null, attemptedAt: st.attemptedAt || null,
      loginCallId: st.loginCallId || null,
      login: t ? { method: t.method, url: t.url, opId: t.op?.id || null } : null,
      command: p.kind === "command" ? p.raw.command : null,
    };
  }

  // {{env.NAME}} variables the profile uses that aren't set anywhere.
  missingVars(p) {
    const raw = JSON.stringify([p.raw.login, p.raw.clientCredentials, p.raw.value, p.raw.command]);
    const env = this.env();
    return [...new Set([...raw.matchAll(/\{\{\s*env\.([\w.-]+)\s*\}\}/g)].map((m) => m[1]))].filter((n) => env[`env.${n}`] === undefined || env[`env.${n}`] === "");
  }

  statuses() { return this.names().map((n) => this.status(n)); }

  // The sign-in request as a GUI request draft, {{variables}} left in.
  loginDraft(name) {
    const p = this.profile(name);
    const t = p?.kind ? this.loginTemplate(p) : null;
    if (!t) return null;
    const headers = Object.entries(t.headers || {}).map(([key, value]) => ({ key, value: String(value), enabled: true }));
    let body = { mode: "none" };
    if (t.form && t.body && typeof t.body === "object") body = { mode: "urlencoded", fields: Object.entries(t.body).filter(([, v]) => v !== undefined).map(([key, value]) => ({ key, value: String(value), enabled: true })) };
    else if (t.body !== undefined && t.body !== null) body = typeof t.body === "string" ? { mode: "text", raw: t.body } : { mode: "json", raw: JSON.stringify(t.body, null, 2) };
    return { method: t.method, url: t.url, headers, body, auth: { type: "none" }, description: `Signs in for "${name}". When this succeeds, jodrell keeps the token and uses it for "${name}" requests.` };
  }
}
