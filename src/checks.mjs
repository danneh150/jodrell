// Secret masking and response validation against the spec.
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

const Ajv = AjvModule.default || AjvModule;
const addFormats = addFormatsModule.default || addFormatsModule;

const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$|token|secret|password|session/i;

export function mask(value) {
  const s = String(value ?? "");
  if (s.length <= 8) return "••••";
  return s.slice(0, Math.min(7, s.indexOf(" ") > 0 ? s.indexOf(" ") + 1 : 3)) + "••••" + s.slice(-4);
}

// Cookies keep their names and attributes (Path, HttpOnly, Max-Age...), but not one character of their values.
function maskCookie(header, value) {
  const s = String(value ?? "");
  if (/^set-cookie$/i.test(header)) { const [pair, ...attrs] = s.split(";"); const eq = pair.indexOf("="); return [eq > 0 ? `${pair.slice(0, eq).trim()}=••••` : "••••", ...attrs.map((a) => a.trim())].join("; "); }
  return s.split(";").map((p) => { const eq = p.indexOf("="); return eq > 0 ? `${p.slice(0, eq).trim()}=••••` : "••••"; }).join("; ");
}

export function redactHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const m = /^(set-)?cookie$/i.test(k) ? (x) => maskCookie(k, x) : mask;
    out[k] = SECRET_HEADER.test(k) ? (Array.isArray(v) ? v.map(m) : m(v)) : v;
  }
  return out;
}

export function isSecretHeader(name) { return SECRET_HEADER.test(name); }

// OpenAPI 3.0 schemas are close to JSON Schema but not identical. Convert the
// common differences so Ajv can check them; unknown keywords are ignored.
function toJsonSchema(s) {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== "object") return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (["nullable", "example", "examples", "xml", "externalDocs", "discriminator", "deprecated", "readOnly", "writeOnly"].includes(k)) continue;
    out[k] = k === "properties" || k === "patternProperties"
      ? Object.fromEntries(Object.entries(v || {}).map(([pk, pv]) => [pk, toJsonSchema(pv)]))
      : toJsonSchema(v);
  }
  if (s.nullable === true) {
    if (typeof out.type === "string") out.type = [out.type, "null"];
    else if (out.enum) out.enum = [...out.enum, null];
    else if (out.anyOf || out.oneOf || out.allOf || out.$ref) return { anyOf: [out, { type: "null" }] };
  }
  return out;
}

const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
const cache = new Map();

function pickResponse(op, status) {
  const r = op.responses || {};
  return r[String(status)] || r[`${String(status)[0]}XX`] || r[`${String(status)[0]}xx`] || r.default || null;
}

// Returns { checked, valid, errors[], note }
export function validateResponse(op, status, contentType, body) {
  if (!op) return null; // not one of your spec's operations (e.g. a third-party API)
  const resp = pickResponse(op, status);
  if (!resp) return { checked: true, valid: false, errors: [{ path: "", message: `Status ${status} is not documented for ${op.id}` }] };
  const content = resp.content || {};
  const types = Object.keys(content);
  if (!types.length) return { checked: true, valid: true, errors: [], note: "No response body documented" };
  const isJson = /json/i.test(contentType || "");
  const media = content[(contentType || "").split(";")[0].trim()] || (isJson ? content["application/json"] || content[types.find((t) => /json/.test(t))] : null);
  const sent = (contentType || "").split(";")[0].trim();
  if (!media && sent && !types.some((t) => t === sent || t === "*/*" || (t.endsWith("/*") && sent.startsWith(t.slice(0, -1))))) {
    // e.g. an HTML error page from a proxy, where the spec promises JSON
    return { checked: true, valid: false, errors: [{ path: "", message: `Returned ${sent}, but the spec documents ${types.join(" or ")}` }] };
  }
  if (!media?.schema) return { checked: true, valid: true, errors: [], note: `No schema for ${contentType || "unknown content type"}` };
  if (!isJson) return { checked: false, note: "Response is not JSON; schema not checked" };
  let data;
  try { data = JSON.parse(body); } catch { return { checked: true, valid: false, errors: [{ path: "", message: "Body is not valid JSON" }] }; }
  const key = `${op.spec}|${op.id}|${status}|${contentType}`;
  let fn = cache.get(key);
  if (!fn) {
    try { fn = ajv.compile(toJsonSchema(media.schema)); } catch (e) { return { checked: false, note: `Schema could not be compiled: ${e.message}` }; }
    cache.set(key, fn);
  }
  const valid = fn(data);
  return {
    checked: true,
    valid,
    errors: valid ? [] : (fn.errors || []).slice(0, 20).map((e) => {
      const extra = e.params?.additionalProperty;
      const missing = e.params?.missingProperty;
      return {
        path: extra ? `${e.instancePath}/${extra}` : e.instancePath || "/",
        message: extra ? "is not in the spec (unexpected property)"
          : missing ? `is missing required property "${missing}"`
          : e.message + (e.params?.allowedValues ? `: ${e.params.allowedValues.join(", ")}` : ""),
      };
    }),
  };
}

export function clearValidationCache() { cache.clear(); }

// Sign-in requests and responses carry passwords, client secrets and tokens in
// their bodies. Mask those fields (JSON or form-encoded) before they're stored.
const SECRET_FIELD = /pass(word)?|secret|token|api[-_]?key|credential|^code$|assertion/i;
export function redactBody(text) {
  if (typeof text !== "string" || !text) return text;
  try {
    const walk = (v, k) => {
      if (k && SECRET_FIELD.test(k) && v !== null && typeof v !== "object") return mask(v);
      if (Array.isArray(v)) return v.map((x) => walk(x));
      if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, walk(vv, kk)]));
      return v;
    };
    return JSON.stringify(walk(JSON.parse(text)));
  } catch {}
  if (/^[^\s=&]+=[^\s&]*(&[^\s=&]+=[^\s&]*)*$/.test(text.trim())) {
    const p = new URLSearchParams(text.trim());
    for (const [k, v] of [...p.entries()]) if (SECRET_FIELD.test(k)) p.set(k, mask(v));
    return p.toString().replace(/%E2%80%A2/g, "•");
  }
  return text;
}
