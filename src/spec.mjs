// Loads OpenAPI 3.x and Swagger 2.0 specs (files, URLs or text fetched from the
// running app) and builds a flat index of operations callable by operationId.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { discoverSpecs } from "./discover.mjs";

const METHODS = ["get", "put", "post", "delete", "patch", "head", "options"];

// Kept for callers that want the quick root-level check.
export function findSpecs(root) { return discoverSpecs(root).specs.map((s) => s.path); }

async function readSource(src) {
  if (src.text != null) return src.text;
  if (/^https?:\/\//.test(src.source)) {
    const res = await fetch(src.source, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  return fs.readFileSync(src.source, "utf8");
}

function parse(text) {
  const t = text.replace(/^\uFEFF/, "").trim();
  return t.startsWith("{") ? JSON.parse(t) : YAML.parse(t);
}

// Resolve internal $refs ("#/components/..." or "#/definitions/...") in place.
function deref(doc) {
  const lookup = (ref) => ref.slice(2).split("/").reduce((o, k) => (o == null ? o : o[decodeURIComponent(k).replace(/~1/g, "/").replace(/~0/g, "~")]), doc);
  const walk = (node, stack) => {
    if (Array.isArray(node)) return node.map((n) => walk(n, stack));
    if (!node || typeof node !== "object") return node;
    if (typeof node.$ref === "string" && node.$ref.startsWith("#/")) {
      if (stack.includes(node.$ref)) return { description: `circular reference to ${node.$ref}` };
      const target = lookup(node.$ref);
      return target === undefined ? node : walk(target, [...stack, node.$ref]);
    }
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, stack);
    return out;
  };
  return walk(doc, []);
}

// Swagger 2.0 -> the OpenAPI 3 shape the rest of jodrell expects.
function fromSwagger2(d) {
  const scheme = (d.schemes || []).includes("https") ? "https" : d.schemes?.[0] || "https";
  const servers = d.host ? [{ url: `${scheme}://${d.host}${d.basePath || ""}` }] : d.basePath && d.basePath !== "/" ? [{ url: d.basePath }] : [];
  const media = (list) => (list || d.consumes || d.produces || ["application/json"]).find((m) => /json/.test(m)) || (list || ["application/json"])[0];
  const schemaOf = (p) => p.schema || Object.fromEntries(Object.entries(p).filter(([k]) => ["type", "format", "items", "enum", "default", "minimum", "maximum", "pattern"].includes(k)));
  const paths = {};
  for (const [p, item] of Object.entries(d.paths || {})) {
    paths[p] = {};
    for (const [k, v] of Object.entries(item)) {
      if (!METHODS.includes(k)) { if (k === "parameters") paths[p].parameters = v.filter((x) => x.in !== "body" && x.in !== "formData").map((x) => ({ ...x, schema: schemaOf(x) })); continue; }
      const params = [...(item.parameters || []), ...(v.parameters || [])];
      const body = params.find((x) => x.in === "body");
      const form = params.filter((x) => x.in === "formData");
      const op = { ...v, parameters: params.filter((x) => x.in !== "body" && x.in !== "formData").map((x) => ({ ...x, schema: schemaOf(x) })) };
      if (body) op.requestBody = { required: !!body.required, content: { [media(v.consumes)]: { schema: body.schema } } };
      else if (form.length) op.requestBody = { content: { [form.some((f) => f.type === "file") ? "multipart/form-data" : "application/x-www-form-urlencoded"]: { schema: { type: "object", required: form.filter((f) => f.required).map((f) => f.name), properties: Object.fromEntries(form.map((f) => [f.name, schemaOf(f)])) } } } };
      op.responses = Object.fromEntries(Object.entries(v.responses || {}).map(([code, r]) => [code, { description: r.description, ...(r.schema ? { content: { [media(v.produces)]: { schema: r.schema } } } : {}) }]));
      paths[p][k] = op;
    }
  }
  return { openapi: "3.0.0", info: d.info, servers, paths, security: d.security, components: { schemas: d.definitions || {}, securitySchemes: securityFromSwagger2(d.securityDefinitions) } };
}

// Swagger 2.0 securityDefinitions -> OpenAPI 3 securitySchemes.
function securityFromSwagger2(defs = {}) {
  const out = {};
  for (const [name, d] of Object.entries(defs || {})) {
    if (d.type === "basic") out[name] = { type: "http", scheme: "basic" };
    else if (d.type === "apiKey") out[name] = { type: "apiKey", in: d.in, name: d.name };
    else if (d.type === "oauth2") {
      const flow = { application: "clientCredentials", password: "password", accessCode: "authorizationCode", implicit: "implicit" }[d.flow] || d.flow;
      out[name] = { type: "oauth2", flows: { [flow]: { tokenUrl: d.tokenUrl, authorizationUrl: d.authorizationUrl, scopes: d.scopes || {} } } };
    }
  }
  return out;
}

function serverUrl(doc) {
  const s = doc.servers?.[0];
  if (!s?.url) return "";
  return s.url.replace(/\{([^}]+)\}/g, (m, k) => s.variables?.[k]?.default ?? m);
}

function slug(method, p) {
  return (method + p.replace(/\{([^}]+)\}/g, "by_$1")).replace(/[^a-zA-Z0-9]+/g, "_").replace(/_+$/, "");
}

function buildOps(doc, specName, baseUrl) {
  const ops = [];
  for (const [p, item] of Object.entries(doc.paths || {})) {
    const shared = item.parameters || [];
    for (const m of METHODS) {
      const op = item[m];
      if (!op) continue;
      const params = [...shared, ...(op.parameters || [])];
      const json = op.requestBody?.content?.["application/json"] || Object.values(op.requestBody?.content || {})[0];
      ops.push({
        id: op.operationId || slug(m, p), spec: specName, method: m.toUpperCase(), path: p,
        summary: op.summary || op.description?.split("\n")[0] || "", tags: op.tags || [],
        params: params.map((x) => ({ name: x.name, in: x.in, required: !!x.required, schema: x.schema, description: x.description })),
        requestBody: op.requestBody ? { required: !!op.requestBody.required, schema: json?.schema } : null,
        responses: op.responses || {}, baseUrl,
        // null: the spec doesn't say; []: no auth needed (a public endpoint)
        security: op.security ?? doc.security ?? null,
      });
    }
  }
  return ops;
}

const norm = (s) => (typeof s === "string" ? { source: s } : s);

export class SpecIndex {
  // sources: paths, URLs, or { source, text?, baseUrl?, origin? }
  // opts: { baseUrlOverride (applies to all), fallbackBaseUrl (for specs without a usable server URL) }
  constructor(sources = [], baseUrlOverride, opts = {}) {
    this.sources = sources.map(norm);
    this.baseUrlOverride = baseUrlOverride;
    this.fallbackBaseUrl = opts.fallbackBaseUrl;
    this.ops = new Map();
    this.specs = [];
    this.loadedAt = null;
  }

  setSources(sources) { this.sources = sources.map(norm); }

  // Loads every source; a broken spec is reported, not fatal.
  async load() {
    const ops = new Map();
    const specs = [];
    for (const src of this.sources) {
      const entry = { source: src.source, origin: src.origin || "config", title: "", version: "", baseUrl: "", operations: 0, warnings: [] };
      try {
        let raw = parse(await readSource(src));
        if (!raw || typeof raw !== "object") throw new Error("empty document");
        const swagger = !!raw.swagger;
        if (swagger) raw = fromSwagger2(deref(raw));
        else if (!raw.openapi) throw new Error("not an OpenAPI or Swagger document");
        const doc = swagger ? raw : deref(raw);
        entry.title = doc.info?.title || path.basename(src.source);
        entry.version = doc.info?.version || "";
        entry.kind = swagger ? "Swagger 2.0" : `OpenAPI ${String(raw.openapi)}`;
        entry.servers = doc.servers || [];
        entry.securitySchemes = doc.components?.securitySchemes || {};
        entry.security = doc.security || null;

        // Base URL: explicit > override > absolute server URL > relative server
        // URL joined to the app URL (or the URL the spec came from) > fallback.
        const appBase = src.appUrl || (/^https?:/.test(src.source) ? new URL(src.source).origin : "") || this.fallbackBaseUrl || "";
        let base = src.baseUrl || this.baseUrlOverride || "";
        if (!base) {
          const s = serverUrl(doc);
          if (/^https?:\/\//.test(s)) base = s;
          else if (s && appBase) base = new URL(s, appBase.replace(/\/?$/, "/")).toString().replace(/\/$/, "");
          else base = appBase;
        }
        entry.baseUrl = base.replace(/\/$/, "");
        if (!entry.baseUrl) entry.warnings.push(`No base URL: the spec has ${serverUrl(doc) ? `only a relative server URL (${serverUrl(doc)})` : "no servers"}. Set "appUrl" or a per-spec "baseUrl" in jodrell.config.json.`);
        else if (/\{[^}]+\}/.test(entry.baseUrl)) entry.warnings.push(`The base URL still has a placeholder: ${entry.baseUrl}. Set a "baseUrl" for this spec in jodrell.config.json.`);

        const list = buildOps(doc, entry.title, entry.baseUrl);
        for (const op of list) {
          const id = ops.has(op.id) ? `${entry.title.replace(/\W+/g, "_")}.${op.id}` : op.id;
          ops.set(id, { ...op, id });
        }
        entry.operations = list.length;
      } catch (e) {
        entry.error = String(e.message).split("\n")[0].replace(/:$/, "");
      }
      specs.push(entry);
    }
    this.ops = ops;
    this.specs = specs;
    this.loadedAt = new Date().toISOString();
    return this;
  }

  // Per-file watching for explicitly configured specs (discovery has its own loop).
  watch(onReload) {
    for (const src of this.sources) {
      if (/^https?:/.test(src.source) || src.text != null || !fs.existsSync(src.source)) continue;
      let timer;
      fs.watch(src.source, () => {
        clearTimeout(timer);
        timer = setTimeout(async () => { try { await this.load(); onReload?.(null); } catch (e) { onReload?.(e); } }, 200);
      });
    }
  }

  get(id) { return this.ops.get(id); }
  list() { return [...this.ops.values()]; }

  // Best-effort match of a raw method + URL to an operation, for send_request.
  match(method, url) {
    let pathname, origin;
    try { const u = new URL(url); pathname = u.pathname; origin = u.origin; } catch { pathname = url.split("?")[0]; }
    for (const op of this.ops.values()) {
      if (op.method !== method.toUpperCase()) continue;
      let basePath = "", baseOrigin = "";
      try { const b = new URL(op.baseUrl); basePath = b.pathname.replace(/\/$/, ""); baseOrigin = b.origin; } catch {}
      if (origin && baseOrigin && origin !== baseOrigin) continue; // a third-party URL that happens to share a path
      const re = new RegExp("^" + basePath + op.path.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{[^}]+\}/g, "[^/]+") + "/?$");
      if (re.test(pathname)) return op;
    }
    return null;
  }
}
