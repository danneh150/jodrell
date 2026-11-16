// The command line, run as a separate process in temporary projects.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { BIN, tmpProject, example, oas } from "../helpers.mjs";

const run = (cwd, ...args) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 30000 });
const read = (root, f) => fs.readFileSync(path.join(root, f), "utf8");
const json = (root, f) => JSON.parse(read(root, f));

describe("jodrell init", () => {
  test("sets up the agent, the instructions, the guard and .gitignore", () => {
    const root = tmpProject({ "openapi.json": oas("Mine"), ".vscode/settings.json": "{}", ".cursor/x": "" });
    const r = run(root, "init");
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(json(root, ".mcp.json").mcpServers.jodrell, { type: "stdio", command: "npx", args: ["jodrell", "mcp"] });
    assert.deepEqual(json(root, ".vscode/mcp.json").servers.jodrell.args, ["jodrell", "mcp"]);
    assert.ok(json(root, ".cursor/mcp.json").mcpServers.jodrell);
    assert.match(read(root, "CLAUDE.md"), /<!-- jodrell:start -->[\s\S]*send_request[\s\S]*<!-- jodrell:end -->/);
    assert.match(read(root, ".cursor/rules/jodrell.mdc"), /^---\ndescription: Make API requests through jodrell\nalwaysApply: true\n---/);
    const settings = json(root, ".claude/settings.json");
    assert.ok(settings.permissions.allow.includes("mcp__jodrell"));
    assert.equal(settings.hooks.PreToolUse[0].matcher, "Bash|WebFetch");
    assert.match(settings.hooks.PreToolUse[0].hooks[0].command, /jodrell.*guard/);
    assert.match(read(root, ".gitignore"), /^\.jodrell\/$/m);
    assert.match(r.stdout, /● Mine 1: 0 operations/);
  });
  test("is safe to run again, and keeps your own content", () => {
    const root = tmpProject({ "CLAUDE.md": "# My notes\n\nKeep this.\n", ".claude/settings.json": { permissions: { allow: ["Bash(npm test)"] }, hooks: { PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "my-hook" }] }] } } });
    run(root, "init"); const once = [read(root, "CLAUDE.md"), read(root, ".claude/settings.json")];
    run(root, "init"); const twice = [read(root, "CLAUDE.md"), read(root, ".claude/settings.json")];
    assert.deepEqual(twice, once);
    assert.match(once[0], /^# My notes\n\nKeep this\.\n\n<!-- jodrell:start -->/);
    const s = json(root, ".claude/settings.json");
    assert.deepEqual(s.permissions.allow, ["Bash(npm test)", "mcp__jodrell"]);
    assert.equal(s.hooks.PreToolUse.length, 2);
  });
  test("replaces the old apiscope entry, and --no-guard / --no-rules skip those parts", () => {
    const root = tmpProject({ ".mcp.json": { mcpServers: { apiscope: { command: "npx", args: ["apiscope", "mcp"] }, other: { command: "x" } } } });
    const r = run(root, "init", "--no-guard", "--no-rules");
    assert.match(r.stdout, /Removed the old "apiscope" entry/);
    assert.deepEqual(Object.keys(json(root, ".mcp.json").mcpServers).sort(), ["jodrell", "other"]);
    assert.ok(!fs.existsSync(path.join(root, "CLAUDE.md")));
    assert.equal(json(root, ".claude/settings.json").hooks, undefined);
  });
  test("cleans up what the capcom name left behind, but not the other capcom tool's things", () => {
    const root = tmpProject({
      ".gitignore": "node_modules\n\n# capcom request history and local data\n.capcom/\n",
      ".mcp.json": { mcpServers: { capcom: { type: "stdio", command: "npx", args: ["capcom", "mcp"] } } },
      "CLAUDE.md": "# Notes\n\n<!-- capcom:start -->\nold instructions\n<!-- capcom:end -->\n",
      "AGENTS.md": "<!-- BEGIN CAPCOM -->\nthe other tool's block\n<!-- END CAPCOM -->\n",
      ".cursor/rules/capcom.mdc": "---\n---\n<!-- capcom:start -->\nold\n<!-- capcom:end -->\n",
      ".claude/settings.json": { permissions: { allow: ["mcp__capcom"] }, hooks: {
        PreToolUse: [{ matcher: "Bash|WebFetch", hooks: [{ type: "command", command: 'node "$CLAUDE_PROJECT_DIR/node_modules/capcom/bin/guard.mjs"' }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "capcom prime" }] }] } },
    });
    const r = run(root, "init");
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!/^\.capcom\/$/m.test(read(root, ".gitignore")), "our old ignore line is gone");
    assert.deepEqual(Object.keys(json(root, ".mcp.json").mcpServers), ["jodrell"]);
    assert.ok(!read(root, "CLAUDE.md").includes("old instructions")); assert.match(read(root, "CLAUDE.md"), /^# Notes\n\n<!-- jodrell:start -->/);
    assert.match(read(root, "AGENTS.md"), /<!-- BEGIN CAPCOM -->\nthe other tool's block/, "the other tool's block is kept");
    assert.ok(!fs.existsSync(path.join(root, ".cursor/rules/capcom.mdc"))); assert.ok(fs.existsSync(path.join(root, ".cursor/rules/jodrell.mdc")));
    const s = json(root, ".claude/settings.json");
    assert.deepEqual(s.permissions.allow, ["mcp__jodrell"]);
    assert.equal(s.hooks.PreToolUse.length, 1); assert.match(s.hooks.PreToolUse[0].hooks[0].command, /jodrell/);
    assert.equal(s.hooks.SessionStart[0].hooks[0].command, "capcom prime", "the other tool's hook is kept");
  });
  test("--app-url writes the config", () => {
    const root = tmpProject();
    run(root, "init", "--app-url", "http://localhost:3999");
    assert.equal(json(root, "jodrell.config.json").appUrl, "http://localhost:3999");
  });
});

describe("other commands", () => {
  test("import, then show and report", () => {
    const root = tmpProject();
    const imp = run(root, "import", example("demo-shop.postman_collection.json"));
    assert.equal(imp.status, 0, imp.stderr); assert.match(imp.stdout, /Imported "Demo shop \(Postman\)": 5 requests in 1 folders/);
    assert.match(run(root, "import", example("demo-shop.postman_environment.json")).stdout, /Imported environment "Demo local"/);
    const bad = run(root, "import", path.join(root, "package.json"));
    assert.notEqual(bad.status, 0); assert.match(bad.stderr, /doesn't look like a Postman collection/);
    const rep = run(root, "report", "--out", path.join(root, "r.html"));
    assert.equal(rep.status, 0); assert.match(rep.stdout, /Wrote 0 request\(s\)/); assert.ok(fs.existsSync(path.join(root, "r.html")));
    assert.notEqual(run(root, "show", "1").status, 0);
  });
  test("help, mcp-config and unknown commands", () => {
    const root = tmpProject();
    assert.match(run(root, "help").stdout, /jodrell.*an API client you and your agent share/);
    assert.match(run(root, "mcp-config").stdout, /npx jodrell mcp/);
    const u = run(root, "frobnicate");
    assert.equal(u.status, 1); assert.match(u.stderr, /Unknown command "frobnicate"/);
  });
  test("an old project is migrated to .jodrell", () => {
    const root = tmpProject({ ".apiscope/marker.txt": "kept" });
    run(root, "report", "--out", path.join(root, "r.html"));
    assert.equal(read(root, ".jodrell/marker.txt"), "kept");
  });
});

test("init won't write through a symbolic link", async () => {
  const fsx = await import("node:fs"); const px = await import("node:path"); const os = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const { BIN, tmpProject } = await import("../helpers.mjs");
  const outside = px.join(fsx.mkdtempSync(px.join(os.tmpdir(), "jodrell-victim-")), "victim.md");
  fsx.writeFileSync(outside, "untouched\n");
  const root = tmpProject();
  fsx.symlinkSync(outside, px.join(root, "CLAUDE.md"));
  const out = execFileSync(process.execPath, [BIN, "init"], { cwd: root }).toString();
  assert.equal(fsx.readFileSync(outside, "utf8"), "untouched\n");
  assert.match(out, /Skipped CLAUDE\.md: CLAUDE\.md is a symbolic link/);
});
