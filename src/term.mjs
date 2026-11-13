// Plain coloured terminal output. Works anywhere: SSH, CI, any terminal.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const dim = c("2"), bold = c("1"), red = c("31"), green = c("32"), yellow = c("33"), blue = c("34"), magenta = c("35"), cyan = c("36");

const METHOD_COLOUR = { GET: blue, POST: green, PUT: yellow, PATCH: yellow, DELETE: red };

export function size(n) {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function statusText(call) {
  if (call.error) return red("ERR");
  const s = call.status;
  return s >= 500 ? red(s) : s >= 400 ? yellow(s) : s >= 300 ? cyan(s) : green(s);
}

function shortUrl(url) {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

export function line(call) {
  const time = new Date(call.ts).toLocaleTimeString("en-GB", { hour12: false });
  const m = (METHOD_COLOUR[call.method] || ((x) => x))(call.method.padEnd(6));
  const v = call.validation;
  const schema = v?.checked === false || !v ? "" : v.valid ? dim(" ✓ schema") : magenta(` ✗ schema (${v.errors.length})`);
  const op = call.op_id ? dim(` ${call.op_id}`) : "";
  const who = call.source === "agent" ? "" : dim(` [${call.source}]`);
  const tail = call.error ? red(` ${call.error}`) : dim(` ${String(call.duration_ms).padStart(5)} ms  ${size(call.res_size)}`);
  return `${dim(time)} ${dim("#" + String(call.id).padEnd(4))} ${m} ${statusText(call)} ${shortUrl(call.url)}${op}${tail}${schema}${who}`;
}

function pretty(body, max = 4000) {
  if (body == null) return dim("(empty)");
  let out = body;
  try { out = JSON.stringify(JSON.parse(body), null, 2); } catch {}
  return out.length > max ? out.slice(0, max) + dim(`\n… ${out.length - max} more characters (open the web UI for the rest)`) : out;
}

export function detail(call) {
  const parts = [line(call)];
  const hdr = (h) => Object.entries(h || {}).map(([k, v]) => `  ${dim(k + ":")} ${Array.isArray(v) ? v.join(", ") : v}`).join("\n");
  parts.push(bold("  Request"), hdr(call.req_headers));
  if (call.req_body) parts.push(indent(pretty(call.req_body, 1500)));
  if (!call.error) {
    parts.push(bold("  Response"), hdr(call.res_headers), indent(pretty(call.res_body)));
  }
  if (call.validation?.errors?.length) {
    parts.push(magenta("  Schema mismatches"), ...call.validation.errors.map((e) => magenta(`  ${e.path} ${e.message}`)));
  }
  return parts.join("\n") + "\n";
}

const indent = (s) => s.split("\n").map((l) => "  " + l).join("\n");
