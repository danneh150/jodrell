#!/usr/bin/env node
// jodrell: an API client you and your agent share, installed in your project.
import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { line, detail, dim, bold, red, green, yellow, safe } from "../src/term.mjs";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`jodrell needs Node 22.13 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { _: [], spec: [] };
  const FLAGS = ["no-open", "quiet", "detail", "help", "browser", "open", "force", "no-guard", "no-rules"];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s);
    const flag = FLAGS.includes(k) || (k === "pixel" && !["right", "left", "down", "up"].includes(argv[i + 1]));
    const next = inline ?? (!flag && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true);
    if (k === "spec") out.spec.push(next); else out[k] = next;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || "gui";
const { findRoot, createCore, ensureGui, runningGui, ensureGitignore, removeOldGitignore, loadConfig, dataDir, describeSpecs, specSources } = await import("../src/project.mjs");
const root = findRoot();

const AGENT_RULES = `
<!-- jodrell:start -->
## API requests: use jodrell

This project uses [jodrell](https://www.npmjs.com/package/jodrell) so the user can see every API request you make.

- Make every HTTP request through jodrell's MCP tools, not curl, wget, HTTPie or an inline fetch:
  - \`send_request\` for any URL, including third-party APIs
  - \`call_operation\` for this project's own APIs (from its OpenAPI specs; see \`list_operations\`)
  - \`run_request\` / \`run_collection\` for saved and imported Postman requests
- Use a \`session\` for cookies and logins, and \`{{variables}}\` from the active environment for secrets, rather than pasting tokens into requests.
- Add a short \`note\` saying why you're making each call.
- When the user wants to see what happened, use \`show_history\` or \`show_request\`. Use \`save_request\` to keep a useful request in a collection.
- Downloading files, install scripts (\`curl -o …\`, \`curl … | sh\`) and reading documentation on the web are fine as usual.
<!-- jodrell:end -->
`;

const HELP = `
${bold("jodrell")}: an API client you and your agent share

${bold("Set up in a project")}
  npm i -D jodrell && npx jodrell init     Registers jodrell with your agent (.mcp.json) and ignores .jodrell/

${bold("Commands")}
  jodrell gui            Open the GUI (browser, or --pixel for a terminal split). Default command
  jodrell report         Write the request history to a self-contained HTML file   --since 24h  --out file  --open
  jodrell import <file>  Import a Postman collection or environment (file or URL)
  jodrell watch          Stream requests into this terminal as they happen          --detail for bodies
  jodrell show <n>       Print request n in full
  jodrell trust [name]   Allow this project's sign-in settings ("auth" in jodrell.config.json). No name: list them
  jodrell open           Show the GUI in this terminal pane (Pixel)
  jodrell mcp            Run as an MCP server over stdio (what your agent starts)
  jodrell init           Set up the current project (--no-guard, --no-rules to skip parts)
  jodrell guard          The Claude Code hook that redirects direct HTTP calls to jodrell

${bold("Options")}
  --spec <file|url>      OpenAPI spec for your own APIs (repeatable). Or set "specs" in jodrell.config.json
  --base-url <url>       Override every spec's base URL
  --app-url <url>        init: your running app's URL (finds a spec it serves, and fills in missing base URLs)
  --port <n>             GUI port (default 4545; another is used if it's taken)
  --pixel [right|down]   gui: open in a terminal split next to your agent
  --no-open              gui: start without opening anything

Data lives in ${dim(path.relative(process.cwd(), dataDir(root)) || ".jodrell")} (history, collections, environments).
`;

const core = () => createCore({ root, specs: args.spec, baseUrl: args["base-url"], db: args.db });
const guiUrl = async () => (await runningGui(root, args.db ? path.resolve(args.db) : undefined)) || null;

/* ---------------- init ---------------- */
async function init() {
  const changes = [];
  const mergeJson = (file, key, entry) => {
    let cur = {};
    if (fs.existsSync(file)) { try { cur = JSON.parse(fs.readFileSync(file, "utf8")); } catch { console.log(yellow(`  Skipped ${path.relative(root, file)}: it isn't valid JSON`)); return; } }
    cur[key] = cur[key] || {};
    if (cur[key].jodrell && !args.force) return changes.push(`${path.relative(root, file)} already has jodrell`);
    const existed = fs.existsSync(file);
    cur[key].jodrell = entry;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cur, null, 2) + "\n");
    changes.push(`${existed ? "Updated" : "Created"} ${path.relative(root, file)}`);
  };
  const stdio = { command: "npx", args: ["jodrell", "mcp"] };
  // Replace the entry from before the rename, so the agent doesn't start both.
  for (const [file, key] of [[".mcp.json", "mcpServers"], [".cursor/mcp.json", "mcpServers"], [".vscode/mcp.json", "servers"]]) {
    const f = path.join(root, file);
    try {
      const cur = JSON.parse(fs.readFileSync(f, "utf8"));
      let touched = false;
      for (const old of ["apiscope", "capcom"]) {
        const e = cur[key]?.[old];
        // only our own old entries ("npx apiscope mcp" / "npx capcom mcp"), never another tool's
        if (e && (e.args || []).join(" ") === `${old} mcp`) { delete cur[key][old]; touched = true; changes.push(`Removed the old "${old}" entry from ${file}`); }
      }
      if (touched) fs.writeFileSync(f, JSON.stringify(cur, null, 2) + "\n");
    } catch {}
  }
  mergeJson(path.join(root, ".mcp.json"), "mcpServers", { type: "stdio", ...stdio }); // Claude Code (project scope)
  if (fs.existsSync(path.join(root, ".cursor"))) mergeJson(path.join(root, ".cursor", "mcp.json"), "mcpServers", stdio);
  if (fs.existsSync(path.join(root, ".vscode"))) mergeJson(path.join(root, ".vscode", "mcp.json"), "servers", { type: "stdio", ...stdio });
  if (removeOldGitignore(root)) changes.push("Removed the old .capcom/ line from .gitignore");
  if (ensureGitignore(root)) changes.push("Added .jodrell/ to .gitignore");

  // Layer 1: tell the agent to use jodrell for HTTP requests.
  if (!args["no-rules"]) {
    const block = AGENT_RULES.trim();
    const upsert = (file, { create = false, wrap = (b) => b } = {}) => {
      const f = path.join(root, file);
      if (!fs.existsSync(f) && !create) return;
      const cur = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
      const marked = /<!-- (?:jodrell|capcom):start -->[\s\S]*?<!-- (?:jodrell|capcom):end -->/; // ours, under either name
      const next = marked.test(cur) ? cur.replace(marked, block) : (cur ? cur.replace(/\s*$/, "\n\n") : "") + wrap(block) + "\n";
      if (next !== cur) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, next); changes.push(`${cur ? "Updated" : "Created"} ${file} (use jodrell for API requests)`); }
    };
    upsert("CLAUDE.md", { create: true });
    upsert("AGENTS.md");
    upsert(".github/copilot-instructions.md");
    const oldRule = path.join(root, ".cursor", "rules", "capcom.mdc");
    if (fs.existsSync(oldRule) && fs.readFileSync(oldRule, "utf8").includes("<!-- capcom:start -->")) { fs.unlinkSync(oldRule); changes.push("Removed the old .cursor/rules/capcom.mdc"); }
    if (fs.existsSync(path.join(root, ".cursor"))) upsert(".cursor/rules/jodrell.mdc", { create: true, wrap: (b) => `---\ndescription: Make API requests through jodrell\nalwaysApply: true\n---\n\n${b}` });
  }

  // Layers 2 and 3 (Claude Code): pre-approve jodrell's tools, and guard against direct HTTP calls.
  {
    const f = path.join(root, ".claude", "settings.json");
    let cur = {};
    if (fs.existsSync(f)) { try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch { console.log(yellow(`  Skipped .claude/settings.json: it isn't valid JSON`)); cur = null; } }
    if (cur) {
      const before = JSON.stringify(cur);
      cur.permissions ??= {}; cur.permissions.allow ??= [];
      // our old name's permission and guard hook; another tool's hooks are left alone
      cur.permissions.allow = cur.permissions.allow.filter((r) => r !== "mcp__capcom");
      if (cur.hooks?.PreToolUse) {
        cur.hooks.PreToolUse = cur.hooks.PreToolUse.map((g) => ({ ...g, hooks: (g.hooks || []).filter((x) => !/capcom\/bin\/guard\.mjs|capcom guard/.test(x.command || "")) })).filter((g) => g.hooks.length);
      }
      if (!cur.permissions.allow.includes("mcp__jodrell")) cur.permissions.allow.push("mcp__jodrell");
      if (!args["no-guard"]) {
        cur.hooks ??= {}; cur.hooks.PreToolUse ??= [];
        const has = cur.hooks.PreToolUse.some((e) => (e.hooks || []).some((x) => /jodrell.*guard/.test(x.command || "")));
        const local = fs.existsSync(path.join(root, "node_modules", "jodrell", "bin", "guard.mjs"));
        if (!has) cur.hooks.PreToolUse.push({ matcher: "Bash|WebFetch", hooks: [{ type: "command", command: local ? 'node "$CLAUDE_PROJECT_DIR/node_modules/jodrell/bin/guard.mjs"' : "npx --no-install jodrell guard", timeout: 10 }] });
      }
      if (JSON.stringify(cur) !== before) {
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, JSON.stringify(cur, null, 2) + "\n");
        changes.push(`Updated .claude/settings.json (jodrell's tools pre-approved${args["no-guard"] ? "" : "; direct curl/wget/fetch API calls are redirected to jodrell"})`);
      }
    }
  }

  const cfg = loadConfig(root);
  if (args["app-url"] && !cfg._from) {
    fs.writeFileSync(path.join(root, "jodrell.config.json"), JSON.stringify({ appUrl: args["app-url"] }, null, 2) + "\n");
    changes.push(`Created jodrell.config.json (appUrl: ${args["app-url"]})`);
  }
  const { SpecIndex } = await import("../src/spec.mjs");
  const cfgNow = loadConfig(root);
  const { sources, duplicates } = await specSources(root, cfgNow, args.spec);
  const idx = new SpecIndex(sources, args["base-url"], { fallbackBaseUrl: cfgNow.baseUrl || [].concat(cfgNow.appUrl || [])[0] });
  await idx.load(); idx.duplicates = duplicates;

  console.log(`\n${bold("jodrell")} is set up in ${root}\n`);
  for (const c of changes) console.log(`  ${green("✓")} ${c}`);
  console.log(`\n${bold("API specs")} ${dim("(found automatically, and kept up to date as they change)")}`);
  for (const l of describeSpecs(idx, root)) console.log("  " + l);
  if (!cfgNow.appUrl && (!idx.specs.length || idx.specs.some((x) => !x.error && !x.baseUrl))) console.log(dim(`  If your app serves its spec or runs locally, add its URL:  npx jodrell init --app-url http://localhost:3000`));
  console.log(`
${bold("Next")}
  Restart your agent (or reload its MCP servers) and approve "jodrell" when asked.

  Your agent is told to make API requests through jodrell (CLAUDE.md), and in
  Claude Code a guard redirects direct curl/wget/fetch API calls to jodrell.
  Set "guard": "ask" in jodrell.config.json to be asked instead, or "off" to stop it.
  Then ask it things like:
    ${dim('"Import ./postman/shop.json and run the Orders folder"')}
    ${dim('"Call GET https://api.github.com/repos/vercel/next.js and show me the response"')}
    ${dim('"Show me the request history for today"')}

  The full GUI any time:   npx jodrell gui     (or --pixel for a terminal split)
  History as an HTML file: npx jodrell report --open
  Other agents: point them at the command "npx jodrell mcp" (stdio).
`);
}

/* ---------------- mcp (stdio) ---------------- */
async function mcp() {
  // stdout belongs to the MCP protocol: everything else goes to stderr.
  console.log = (...a) => process.stderr.write(a.join(" ") + "\n");
  let c;
  try { c = await core(); } catch (e) { process.stderr.write(`jodrell: ${e.message}\n`); process.exit(1); }
  const gui = () => ensureGui(c);
  // Start or find the GUI in the background so links in replies work straight away.
  gui().catch((e) => process.stderr.write(`jodrell: GUI not started (${e.message})\n`));
  const { startStdio } = await import("../src/mcp.mjs");
  await startStdio({ ...c, uiBase: () => c.gui?.url || "", gui });
  c.watchSpecs(() => c.gui?.broadcast?.("specs", {}));
  setInterval(async () => { if (c.gui?.external && !(await runningGui(root, c.store.file))) { c.gui = null; gui().catch(() => {}); } }, 15000).unref();
}

/* ---------------- gui ---------------- */
async function gui() {
  const existing = await guiUrl();
  if (existing) {
    console.log(`jodrell is already running for this project at ${bold(existing)}`);
    return openIt(existing, false);
  }
  let c;
  try { c = await core(); } catch (e) { console.error(red(e.message)); process.exit(1); }
  const { clearValidationCache } = await import("../src/checks.mjs");
  let g;
  try { g = await ensureGui(c, { port: args.port ? Number(args.port) : undefined }); } catch (e) { console.error(red(e.message)); process.exit(1); }
  c.watchSpecs((specs, err) => { if (err) console.log(red(`Spec reload failed: ${err.message}`)); else { console.log(dim(`Specs reloaded: ${specs.list().length} operations`)); g.broadcast?.("specs", {}); } });

  console.log(`\n${bold("jodrell")} for ${bold(c.project)}\n`);
  for (const l of describeSpecs(c.specs, root)) console.log("  " + (l.startsWith("●") ? green("●") + l.slice(1) : l.startsWith("✗") ? red(l) : dim(l)));
  const cols = c.collections.list();
  console.log(dim(`  ${cols.length} collection(s)${c.collections.activeEnv() ? `, environment ${c.collections.activeEnv().name}` : ""}`));
  console.log(`\n  GUI      ${bold(g.url)}`);
  console.log(`  History  ${dim(path.relative(process.cwd(), c.store.file))}`);
  if (!fs.existsSync(path.join(root, ".mcp.json"))) console.log(dim(`\n  Tip: run "npx jodrell init" so your agent can use jodrell too.`));
  console.log("");
  if (!args.quiet) c.store.on("call", (x) => console.log(line(x)));
  await openIt(g.url, true);
}

async function openIt(url, keepAlive) {
  const { openGui, openBrowser } = await import("../src/open.mjs");
  if (args["no-open"]) return;
  if (args.pixel) console.log(dim(await openGui(url, { split: args.pixel === true ? "right" : args.pixel })));
  else if (process.stdout.isTTY || args.browser) openBrowser(url);
  if (!keepAlive) process.exit(0);
}

/* ---------------- report ---------------- */
async function report() {
  const { buildReport, parseSince } = await import("../src/html.mjs");
  const c = await core();
  const since = parseSince(args.since || "all");
  const out = path.resolve(args.out || path.join(dataDir(root), "reports", `history-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.html`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buildReport(c.store, { since, runId: args.run, project: c.project }));
  const n = c.store.listCalls({ limit: 100000 }).filter((x) => !since || new Date(x.ts) >= since).length;
  console.log(`${green("✓")} Wrote ${Math.min(n, 500)} request(s) to ${path.relative(process.cwd(), out)}`);
  if (args.open) (await import("../src/open.mjs")).openBrowser("file://" + out);
}

/* ---------------- import ---------------- */
async function importCmd() {
  const src = args._[1];
  if (!src) { console.error("Usage: jodrell import <postman-collection.json | url>"); process.exit(1); }
  const text = /^https?:/.test(src) ? await (await fetch(src)).text() : fs.readFileSync(path.resolve(src), "utf8");
  let summary;
  const running = await guiUrl();
  try {
    if (running) {
      const r = await fetch(`${running}/api/import`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: JSON.parse(text) }) });
      summary = await r.json();
      if (!r.ok) throw new Error(summary.error);
    } else summary = (await core()).collections.importPostman(text);
  } catch (e) { console.error(red(e.message)); process.exit(1); }
  if (summary.kind === "environment") return console.log(green(`Imported environment "${safe(summary.environment)}" (${summary.variables} variables)`));
  console.log(green(`Imported "${safe(summary.collection)}": ${summary.requests} requests in ${summary.folders} folders`));
  if (summary.capturesFromScripts) console.log(dim(`  ${summary.capturesFromScripts} script line(s) converted into captures or status checks`));
  for (const n of summary.notes) console.log(yellow("  " + safe(n)));
}

/* ---------------- watch / show / open ---------------- */
async function watch() {
  const connect = async () => {
    const base = await guiUrl();
    try {
      if (!base) throw new Error("not running");
      const res = await fetch(`${base}/api/events`);
      console.log(dim(`Watching ${base}, Ctrl+C to stop`));
      const dec = new TextDecoder(); let buf = "";
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = block.match(/^event: (.+)$/m)?.[1], data = block.match(/^data: (.+)$/m)?.[1];
          if (ev === "call" && data) {
            const c = JSON.parse(data);
            if (args.detail) console.log(detail(await (await fetch(`${base}/api/calls/${c.id}`)).json())); else console.log(line(c));
          } else if (ev === "run" && data) console.log(bold(`\n── ${safe(JSON.parse(data).name)} ──`));
        }
      }
      throw new Error("connection closed");
    } catch (e) {
      console.log(dim(`jodrell isn't running for this project yet (${e.message}). Waiting… It starts with your agent, or run "npx jodrell gui".`));
      setTimeout(connect, 3000);
    }
  };
  connect();
}

async function show() {
  const id = args._[1];
  if (!id) { console.error("Usage: jodrell show <request number>"); process.exit(1); }
  const c = await core();
  const call = c.store.getCall(Number(id));
  if (!call) { console.error(red(`No request #${id}`)); process.exit(1); }
  console.log(detail(call));
}

async function open() {
  const { pixel, openBrowser } = await import("../src/open.mjs");
  let url = await guiUrl();
  if (!url) url = (await ensureGui(await core())).url;
  const px = await pixel();
  if (!px) { console.log(yellow("Pixel isn't installed, so opening the browser instead.")); openBrowser(url); return; }
  const [cmd0, ...rest] = px.command(url);
  spawn(cmd0, rest, { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
}

// A project's auth profiles can send secrets and run commands, so each one is
// only used once you allow it here or in the GUI. Approvals are stored outside
// the project (see trustFile in src/auth.mjs), keyed to the exact settings.
async function trust() {
  const c = await core();
  const name = args._[1];
  const all = c.auth.statuses();
  if (!all.length) return console.log('No auth profiles. Add "auth" to jodrell.config.json to have jodrell sign in for you.');
  if (!name) {
    for (const a of all) console.log(`${a.state === "untrusted" ? yellow("Not allowed yet") : green("Allowed")}  ${bold(safe(a.name))}: it ${safe(c.auth.describe(c.auth.profile(a.name)))}.`);
    if (all.some((a) => a.state === "untrusted")) console.log(dim("\nTo allow one: npx jodrell trust <name>"));
    return;
  }
  const p = c.auth.profile(name);
  if (!p) { console.error(red(`No auth profile called "${safe(name)}".`)); process.exit(1); }
  c.auth.trust(name);
  console.log(green(`Allowed "${safe(name)}".`) + ` It ${safe(c.auth.describe(p))}.\n` + dim("If its settings change, jodrell will ask again."));
}

const guard = async () => { await import("./guard.mjs"); };
const commands = { guard, gui, dev: gui, report, import: importCmd, watch, show, open, mcp, init, trust, help: () => console.log(HELP),
  "mcp-config": () => console.log(`Command for any MCP client (stdio):  npx jodrell mcp\nClaude Code:  claude mcp add jodrell -- npx jodrell mcp\nOr run "npx jodrell init" to write .mcp.json for this project.`) };
if (args.help || args.h) console.log(HELP);
else if (!commands[cmd]) { console.error(`Unknown command "${cmd}".\n${HELP}`); process.exit(1); }
else await commands[cmd]();
