// Plain coloured terminal output. Works anywhere: SSH, CI, any terminal.
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const dim = c("2"), bold = c("1"), red = c("31"), green = c("32"), yellow = c("33"), blue = c("34"), magenta = c("35"), cyan = c("36");

// Control characters from API responses, specs or collections could move the
// cursor, retitle the window or write to the clipboard. Show them as \xNN instead.
export const safe = (s) => String(s ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (ch) => "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0"));

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
  try { const u = new URL(url); return safe(u.pathname + u.search); } catch { return safe(url); }
}

export function line(call) {
  const time = new Date(call.ts).toLocaleTimeString("en-GB", { hour12: false });
  const m = (METHOD_COLOUR[call.method] || ((x) => x))(safe(call.method).padEnd(6));
  const v = call.validation;
  const schema = v?.checked === false || !v ? "" : v.valid ? dim(" ✓ schema") : magenta(` ✗ schema (${v.errors.length})`);
  const op = call.op_id ? dim(` ${safe(call.op_id)}`) : "";
  const who = call.source === "agent" ? "" : dim(` [${safe(call.source)}]`);
  const tail = call.error ? red(` ${safe(call.error)}`) : dim(` ${String(call.duration_ms).padStart(5)} ms  ${size(call.res_size)}`);
  return `${dim(time)} ${dim("#" + String(call.id).padEnd(4))} ${m} ${statusText(call)} ${shortUrl(call.url)}${op}${tail}${schema}${who}`;
}

function pretty(body, max = 4000) {
  if (body == null) return dim("(empty)");
  let out = body;
  try { out = JSON.stringify(JSON.parse(body), null, 2); } catch { out = safe(body); }
  return out.length > max ? out.slice(0, max) + dim(`\n… ${out.length - max} more characters (open the web UI for the rest)`) : out;
}

export function detail(call) {
  const parts = [line(call)];
  const hdr = (h) => Object.entries(h || {}).map(([k, v]) => `  ${dim(safe(k) + ":")} ${safe(Array.isArray(v) ? v.join(", ") : v)}`).join("\n");
  parts.push(bold("  Request"), hdr(call.req_headers));
  if (call.req_body) parts.push(indent(pretty(call.req_body, 1500)));
  if (!call.error) {
    parts.push(bold("  Response"), hdr(call.res_headers), indent(pretty(call.res_body)));
  }
  if (call.validation?.errors?.length) {
    parts.push(magenta("  Schema mismatches"), ...call.validation.errors.map((e) => magenta(`  ${safe(e.path)} ${safe(e.message)}`)));
  }
  return parts.join("\n") + "\n";
}

const indent = (s) => s.split("\n").map((l) => "  " + l).join("\n");
