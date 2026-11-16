// Finds the project jodrell is installed in, reads its config, and builds the
// shared core (store, specs, collections, runner) used by every entry point.
import fs from "node:fs";
import path from "node:path";
import { SpecIndex } from "./spec.mjs";
import { discoverSpecs, probeApp } from "./discover.mjs";
import { clearValidationCache } from "./checks.mjs";
import { Store } from "./store.mjs";
import { Collections } from "./collections.mjs";
import { Runner } from "./runner.mjs";
import { Auth } from "./auth.mjs";
import { safe } from "./term.mjs";

export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, "package.json")) || fs.existsSync(path.join(dir, ".git"))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.resolve(start);
    dir = up;
  }
}

// Config lives in jodrell.config.json, or under "jodrell" in package.json. All optional:
// {
//   "appUrl": "http://localhost:3000",       // your running app: base URL for specs without one, and where to look for a served spec
//   "specs": ["openapi.yaml", { "path": "services/billing/openapi.json", "baseUrl": "http://localhost:4000" }],
//   "discover": true,                       // also search the project for specs (default: true unless "specs" is set)
//   "baseUrl": "http://localhost:3000",     // fallback base URL (same as appUrl if that's set)
//   "auth": { "shop": { "login": { "op": "login", "body": { ... } } } },  // sign-in per API: see auth.mjs
//   "port": 4545
// }
export function loadConfig(root) {
  // jodrell.config.json, or the config file from an earlier name (capcom, apiscope)
  for (const name of ["jodrell.config.json", "capcom.config.json", "apiscope.config.json"]) {
    const file = path.join(root, name);
    if (!fs.existsSync(file)) continue;
    try { return { ...JSON.parse(fs.readFileSync(file, "utf8")), _from: file }; }
    catch (e) { throw new Error(`${name} isn't valid JSON: ${e.message}`); }
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const cfg = pkg.jodrell || pkg.capcom || pkg.apiscope;
    if (cfg) return { ...cfg, _from: "package.json" };
  } catch {}
  return {};
}

// Project data lives in .jodrell/. A .apiscope/ folder from before the rename is
// moved across the first time, so history, collections and environments carry on.
// Project data lives in .jodrell/. Data from an earlier name is moved across the
// first time. A .capcom/ folder is only moved if it holds nothing but our files:
// an unrelated tool also called capcom keeps its issues in .capcom/.
const OUR_FILES = new Set(["history.db", "history.db-wal", "history.db-shm", "server.json", "reports"]);
export function isOurOldFolder(dir) {
  try { const names = fs.readdirSync(dir); return names.includes("history.db") && names.every((n) => OUR_FILES.has(n)); }
  catch { return false; }
}
export const dataDir = (root) => {
  const dir = path.join(root, ".jodrell");
  if (fs.existsSync(dir)) return dir;
  for (const [name, ours] of [[".capcom", isOurOldFolder], [".apiscope", () => true]]) {
    const old = path.join(root, name);
    if (!fs.existsSync(old) || !ours(old)) continue;
    try { fs.renameSync(old, dir); process.stderr.write(`jodrell: moved your history from ${name}/ to .jodrell/\n`); return dir; }
    catch { return old; } // still in use by an old process: keep using it for now
  }
  return dir;
};

const appUrls = (config) => [].concat(config.appUrl || []).filter(Boolean);

// Work out every spec source: --spec flags, configured specs, specs found in
// the project, and specs served by the running app.
export async function specSources(root, config, specArgs = []) {
  if (specArgs.length) return { sources: specArgs.map((s) => ({ source: /^https?:/.test(s) ? s : path.resolve(s), origin: "flag" })), duplicates: [] };
  const app = appUrls(config)[0];
  const sources = [];
  for (const s of config.specs || []) {
    const e = typeof s === "string" ? { path: s } : s;
    const ref = e.url || e.path;
    if (!ref) continue;
    sources.push({ source: /^https?:/.test(ref) ? ref : path.resolve(root, ref), baseUrl: e.baseUrl, appUrl: app, origin: "config" });
  }
  let duplicates = [];
  const discover = config.discover ?? !(config.specs || []).length;
  if (discover) {
    const found = discoverSpecs(root);
    duplicates = found.duplicates;
    for (const f of found.specs) if (!sources.some((x) => x.source === f.path)) sources.push({ source: f.path, appUrl: app, origin: "discovered", mtime: f.mtime });
  }
  for (const url of appUrls(config)) {
    // Only your own machine is checked automatically: a config from a cloned
    // repository shouldn't make jodrell contact other hosts on start-up.
    if (!/^https?:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?(\/|$)/i.test(url)) continue;
    for (const hit of await probeApp(url)) sources.push({ source: hit.url, text: hit.text, appUrl: url, origin: "app" });
  }
  return { sources, duplicates };
}

export async function createCore({ root = findRoot(), specs: specArgs = [], baseUrl, db } = {}) {
  const config = loadConfig(root);
  const { sources, duplicates } = await specSources(root, config, specArgs);
  const specs = new SpecIndex(sources, baseUrl, { fallbackBaseUrl: config.baseUrl || appUrls(config)[0] });
  await specs.load();
  specs.duplicates = duplicates;
  const store = new Store(path.resolve(db || path.join(dataDir(root), "history.db")));
  const collections = new Collections(store);
  const core = { root, config, specs, store, collections, project: path.basename(root), specArgs };
  // Auth reads the config fresh, so edits to "auth" apply without a restart.
  core.auth = new Auth({ store, specs, root, config: () => { try { return loadConfig(root); } catch { return core.config; } } });
  core.runner = new Runner({ store, specs, collections, auth: core.auth });

  // Re-find specs now (e.g. the agent asks), reloading only if something changed.
  core.refreshSpecs = async ({ force = false } = {}) => {
    const cfg = loadConfig(root);
    const next = await specSources(root, cfg, specArgs);
    const sig = (list) => list.map((x) => `${x.source}|${x.text ? x.text.length + ":" + x.text.slice(-64) : ""}|${fileStamp(x.source)}`).sort().join("\n");
    if (!force && sig(next.sources) === core._sig) return false;
    core.config = cfg;
    specs.setSources(next.sources);
    specs.fallbackBaseUrl = cfg.baseUrl || appUrls(cfg)[0];
    await specs.load();
    specs.duplicates = next.duplicates;
    core._sig = sig(next.sources);
    clearValidationCache();
    return true;
  };
  core._sig = sources.map((x) => `${x.source}|${x.text ? x.text.length + ":" + x.text.slice(-64) : ""}|${fileStamp(x.source)}`).sort().join("\n");

  // Keep specs current: quick checks of known files, and a full re-scan less often.
  core.watchSpecs = (onChange) => {
    let busy = false;
    const run = async (full) => {
      if (busy) return; busy = true;
      try {
        let changed = false;
        if (full) changed = await core.refreshSpecs();
        else if (specs.sources.some((x) => x.text == null && !/^https?:/.test(x.source) && fileStamp(x.source) !== x._stamp)) changed = await core.refreshSpecs({ force: true });
        for (const x of specs.sources) x._stamp = fileStamp(x.source);
        if (changed) onChange?.(specs);
      } catch (e) { onChange?.(specs, e); }
      busy = false;
    };
    for (const x of specs.sources) x._stamp = fileStamp(x.source);
    const quick = setInterval(() => run(false), 2000); quick.unref();
    const full = setInterval(() => run(true), 30000); full.unref();
  };
  return core;
}

function fileStamp(file) {
  if (/^https?:/.test(file)) return "";
  try { const st = fs.statSync(file); return `${st.mtimeMs}:${st.size}`; } catch { return "missing"; }
}

// One line per spec, for terminals and tool replies.
export function describeSpecs(specs, root) {
  const rel = (s) => (/^https?:/.test(s) ? s : path.relative(root, s) || s);
  if (!specs.specs.length) return ["No OpenAPI or Swagger specs found in this project."];
  const out = specs.specs.map((s) => s.error
    ? `✗ ${rel(s.source)}: couldn't load (${s.error})`
    : `● ${s.title}${s.version ? " " + s.version : ""}: ${s.operations} operations, ${s.baseUrl || "no base URL"} (${s.origin === "app" ? "served by your app at " : s.origin === "discovered" ? "found at " : ""}${rel(s.source)})${s.warnings.length ? "\n    ⚠ " + s.warnings.join("\n    ⚠ ") : ""}`);
  for (let i = 0; i < out.length; i++) out[i] = out[i].split("\n").map(safe).join("\n"); // titles and errors come from spec files
  if (specs.duplicates?.length) out.push(`(${specs.duplicates.length} older cop${specs.duplicates.length === 1 ? "y" : "ies"} of the same spec ignored: ${specs.duplicates.map((d) => rel(d.path)).join(", ")})`);
  return out;
}

/* ---- the GUI server for this project (one at a time, shared by processes) ---- */

const infoFile = (root) => path.join(dataDir(root), "server.json");

// server.json could be stale, or committed to a repository by someone else.
// Only trust a jodrell on this machine that is using this project's database.
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
const realpath = (f) => { try { return fs.realpathSync(f); } catch { return path.resolve(f); } };
export async function runningGui(root, dbFile = path.join(dataDir(root), "history.db")) {
  try {
    const info = JSON.parse(fs.readFileSync(infoFile(root), "utf8"));
    if (typeof info.url !== "string" || !LOOPBACK_URL.test(info.url)) return null;
    const r = await fetch(`${info.url}/api/info`, { signal: AbortSignal.timeout(800), redirect: "error" });
    if (!r.ok) return null;
    const live = await r.json();
    if (typeof live.db !== "string" || !path.isAbsolute(live.db) || realpath(live.db) !== realpath(dbFile)) return null;
    return info.url;
  } catch { return null; }
}

export function recordGui(root, url) {
  fs.mkdirSync(dataDir(root), { recursive: true });
  fs.writeFileSync(infoFile(root), JSON.stringify({ url, pid: process.pid, startedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  const clear = () => {
    try { const cur = JSON.parse(fs.readFileSync(infoFile(root), "utf8")); if (cur.pid === process.pid) fs.unlinkSync(infoFile(root)); } catch {}
  };
  process.on("exit", clear);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(sig, () => { clear(); process.exit(0); });
}

// Reuse this project's running GUI, or start one in this process.
export async function ensureGui(core, { port, quiet = true } = {}) {
  if (core.gui) return core.gui;
  const existing = await runningGui(core.root, core.store.file);
  if (existing) return (core.gui = { url: existing, external: true });
  const { startServer } = await import("./server.mjs");
  const ui = await startServer({ ...core, port: port ?? core.config.port ?? 4545, fallbackPort: true });
  recordGui(core.root, ui.uiBase);
  if (!quiet) process.stderr.write(`jodrell GUI at ${ui.uiBase}\n`);
  return (core.gui = { url: ui.uiBase, server: ui.server, external: false, broadcast: ui.broadcast });
}

// Earlier versions added ".capcom/" to .gitignore. Remove exactly that, so a
// different tool's committed .capcom/ folder isn't hidden from git.
export function removeOldGitignore(root) {
  const gi = path.join(root, ".gitignore");
  if (!fs.existsSync(gi)) return false;
  const cur = fs.readFileSync(gi, "utf8");
  const next = cur.replace(/\n?# capcom request history and local data\n\.capcom\/\n?/, "\n");
  if (next === cur) return false;
  fs.writeFileSync(gi, next.replace(/\n{3,}/g, "\n\n"));
  return true;
}

export function ensureGitignore(root) {
  const gi = path.join(root, ".gitignore");
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, "utf8") : "";
  if (/^\/?\.jodrell\/?\s*$/m.test(cur)) return false;
  fs.writeFileSync(gi, cur + (cur && !cur.endsWith("\n") ? "\n" : "") + "\n# jodrell request history and local data\n.jodrell/\n");
  return true;
}
