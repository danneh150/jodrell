// Finds OpenAPI (3.x) and Swagger (2.0) specs anywhere in a project by looking
// at file contents, not names, so generated specs are found wherever they land.
import fs from "node:fs";
import path from "node:path";

// Folders that never hold the project's own specs, or are too big to walk.
const SKIP = new Set([
  "node_modules", ".git", ".hg", ".svn", ".jodrell", ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache",
  ".vercel", ".netlify", "coverage", ".nyc_output", ".venv", "venv", "env", "__pycache__", ".mypy_cache", ".pytest_cache",
  ".tox", ".idea", ".vscode", ".gradle", ".m2", "Pods", "DerivedData", "vendor", "bower_components", "jspm_packages",
]);
const EXT = /\.(json|ya?ml)$/i;
const NOT_SPECS = /^(package(-lock)?|tsconfig.*|jsconfig|composer(\.lock)?|\.eslintrc.*|\.prettierrc.*|renovate|turbo|nx|lerna|vercel|netlify|app|manifest|docker-compose.*|pnpm-lock|pnpm-workspace|\.?babelrc|cspell)\.(json|ya?ml)$/i;
const MAX_BYTES = 25 * 1024 * 1024;
const HEAD = 64 * 1024;

// A spec says what it is near the top: openapi: 3.x or swagger: "2.0".
export function sniff(text) {
  const m = text.match(/^\s*["']?(openapi|swagger)["']?\s*:\s*["']?(\d+(?:\.\d+)*)/m) || text.match(/"(openapi|swagger)"\s*:\s*"(\d+(?:\.\d+)*)"/);
  if (!m) return null;
  if (m[1] === "openapi" && m[2].startsWith("3")) return "openapi3";
  if (m[1] === "swagger" && m[2].startsWith("2")) return "swagger2";
  return null;
}

function readHead(file) {
  const fd = fs.openSync(file, "r");
  try { const buf = Buffer.alloc(HEAD); const n = fs.readSync(fd, buf, 0, HEAD, 0); return buf.toString("utf8", 0, n); }
  finally { fs.closeSync(fd); }
}

const titleOf = (head) => head.match(/"title"\s*:\s*"([^"]+)"/)?.[1] || head.match(/^\s+title\s*:\s*['"]?([^'"\n]+)/m)?.[1]?.trim() || "";
const versionOf = (head) => head.match(/"info"\s*:\s*\{[^}]*?"version"\s*:\s*"([^"]+)"/s)?.[1] || head.match(/^info:\s*\n(?:\s+.*\n)*?\s+version\s*:\s*['"]?([^'"\n]+)/m)?.[1]?.trim() || "";

// Walk the project. Returns one entry per distinct spec; when the same spec
// (same title and version) exists in several places, the newest file wins.
export function discoverSpecs(root, { maxDepth = 10, maxEntries = 50000 } = {}) {
  const found = [];
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || seen > maxEntries) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > maxEntries) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP.has(e.name) && !e.name.startsWith(".")) walk(full, depth + 1); continue; }
      if (!e.isFile() || !EXT.test(e.name) || NOT_SPECS.test(e.name)) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size > MAX_BYTES || st.size < 20) continue;
      let head;
      try { head = readHead(full); } catch { continue; }
      const kind = sniff(head);
      if (!kind) continue;
      found.push({ path: full, kind, title: titleOf(head), version: versionOf(head), mtime: st.mtimeMs, size: st.size });
    }
  };
  walk(root, 0);
  const byKey = new Map();
  const duplicates = [];
  for (const f of found.sort((a, b) => b.mtime - a.mtime)) {
    const key = f.title ? `${f.title}@${f.version}` : f.path;
    if (byKey.has(key)) duplicates.push({ path: f.path, sameAs: byKey.get(key).path });
    else byKey.set(key, f);
  }
  return { specs: [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path)), duplicates, scanned: seen };
}

// Paths where common frameworks serve their spec at runtime.
export const SPEC_PATHS = [
  "/openapi.json", "/openapi.yaml", "/swagger.json", "/api/openapi.json", "/api-json", "/api/docs-json", "/docs-json",
  "/v3/api-docs", "/v2/api-docs", "/api-docs", "/api/swagger.json", "/swagger/v1/swagger.json", "/api/schema/",
  "/openapi", "/docs/openapi.json",
];

// Ask the running app for its spec. Returns [{ url, kind, text }].
export async function probeApp(appUrl, { timeout = 1200 } = {}) {
  const base = appUrl.replace(/\/$/, "");
  const hits = await Promise.all(SPEC_PATHS.map(async (p) => {
    try {
      const r = await fetch(base + p, { signal: AbortSignal.timeout(timeout), headers: { accept: "application/json, application/yaml;q=0.9, */*;q=0.5" } });
      if (!r.ok) return null;
      const text = await r.text();
      const kind = sniff(text.slice(0, HEAD));
      return kind ? { url: base + p, kind, text } : null;
    } catch { return null; }
  }));
  // Several paths often serve the same document; keep one per content.
  const seen = new Set();
  return hits.filter((h) => h && !seen.has(h.text.length + h.text.slice(0, 200)) && seen.add(h.text.length + h.text.slice(0, 200)));
}
