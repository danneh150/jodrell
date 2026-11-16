// Finding the project, reading config, the data folder, and spec sources.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { findRoot, loadConfig, dataDir, ensureGitignore, removeOldGitignore, isOurOldFolder, specSources, createCore, describeSpecs, runningGui, recordGui } from "../../src/project.mjs";
import { tmpProject, oas, fakeApi, waitFor } from "../helpers.mjs";

describe("the project", () => {
  test("is the nearest folder with a package.json or .git", () => {
    const root = tmpProject({ "src/deep/x.txt": "x" });
    assert.equal(findRoot(path.join(root, "src", "deep")), root);
    const gitOnly = tmpProject({ ".git/HEAD": "ref" }, { pkg: false });
    assert.equal(findRoot(gitOnly), gitOnly);
  });
  test("config: jodrell.config.json, then the old capcom and apiscope files, then package.json", () => {
    const root = tmpProject();
    const pkg = (o) => fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", ...o }));
    assert.deepEqual(loadConfig(root), {});
    pkg({ apiscope: { port: 1 } }); assert.equal(loadConfig(root).port, 1);
    pkg({ jodrell: { port: 2 }, apiscope: { port: 1 } }); assert.equal(loadConfig(root).port, 2);
    fs.writeFileSync(path.join(root, "apiscope.config.json"), '{"port":3}'); assert.equal(loadConfig(root).port, 3);
    fs.writeFileSync(path.join(root, "capcom.config.json"), '{"port":5}'); assert.equal(loadConfig(root).port, 5);
    fs.writeFileSync(path.join(root, "jodrell.config.json"), '{"port":4}'); assert.equal(loadConfig(root).port, 4);
    fs.writeFileSync(path.join(root, "jodrell.config.json"), "{oops"); assert.throws(() => loadConfig(root), /jodrell.config.json isn't valid JSON/);
  });
  test("an old .apiscope folder is moved to .jodrell, once", () => {
    const root = tmpProject({ ".apiscope/history.db": "data" });
    assert.equal(dataDir(root), path.join(root, ".jodrell"));
    assert.equal(fs.readFileSync(path.join(root, ".jodrell/history.db"), "utf8"), "data");
    assert.ok(!fs.existsSync(path.join(root, ".apiscope")));
    const both = tmpProject({ ".apiscope/a": "old", ".jodrell/b": "new" });
    dataDir(both);
    assert.ok(fs.existsSync(path.join(both, ".apiscope/a")), "never overwrites existing data");
  });
  test("our old .capcom folder is moved to .jodrell", () => {
    const root = tmpProject({ ".capcom/history.db": "ours", ".capcom/reports/r.html": "x", ".capcom/server.json": "{}" });
    assert.equal(dataDir(root), path.join(root, ".jodrell"));
    assert.equal(fs.readFileSync(path.join(root, ".jodrell/history.db"), "utf8"), "ours");
    assert.ok(!fs.existsSync(path.join(root, ".capcom")));
  });
  test("a .capcom folder belonging to the other capcom tool is never touched", () => {
    const root = tmpProject({ ".capcom/issues/login-bug.md": "# an issue", ".capcom/config.yaml": "statuses: []" });
    assert.equal(isOurOldFolder(path.join(root, ".capcom")), false);
    assert.equal(dataDir(root), path.join(root, ".jodrell"));
    assert.ok(fs.existsSync(path.join(root, ".capcom/issues/login-bug.md")));
    const mixed = tmpProject({ ".capcom/history.db": "ours?", ".capcom/issues/x.md": "theirs" });
    dataDir(mixed);
    assert.ok(fs.existsSync(path.join(mixed, ".capcom/issues/x.md")), "anything not ours means hands off");
  });
  test("the old .capcom/ line we added to .gitignore is removed, and only that", () => {
    const root = tmpProject({ ".gitignore": "node_modules\n\n# capcom request history and local data\n.capcom/\n\ndist\n" });
    assert.equal(removeOldGitignore(root), true);
    assert.equal(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), "node_modules\n\ndist\n");
    assert.equal(removeOldGitignore(root), false);
    const theirs = tmpProject({ ".gitignore": ".capcom/index/\n" });
    assert.equal(removeOldGitignore(theirs), false);
  });
  test(".gitignore gets .jodrell/ once, on its own line", () => {
    const root = tmpProject({ ".gitignore": "node_modules" });
    assert.equal(ensureGitignore(root), true); assert.equal(ensureGitignore(root), false);
    assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^node_modules\n\n# jodrell[^\n]*\n\.jodrell\/\n$/);
  });
});

describe("spec sources", () => {
  test("--spec flags win; listed specs turn discovery off unless asked", async () => {
    const root = tmpProject({ "a/openapi.json": oas("A"), "b/openapi.json": oas("B") });
    assert.equal((await specSources(root, {})).sources.length, 2);
    assert.deepEqual((await specSources(root, {}, [path.join(root, "a/openapi.json")])).sources.map((x) => x.origin), ["flag"]);
    const listed = await specSources(root, { specs: [{ path: "a/openapi.json", baseUrl: "http://x" }] });
    assert.deepEqual(listed.sources.map((x) => [x.origin, x.baseUrl]), [["config", "http://x"]]);
    assert.equal((await specSources(root, { specs: ["a/openapi.json"], discover: true })).sources.length, 2);
  });
  test("asks the running app for its spec when appUrl is set", async () => {
    const api = await fakeApi();
    try {
      const core = await createCore({ root: tmpProject({ "jodrell.config.json": { appUrl: api.url } }) });
      assert.deepEqual(core.specs.specs.map((s) => [s.title, s.origin, s.baseUrl]), [["Served by the app", "app", api.url]]);
    } finally { await api.close(); }
  });
  test("describes what it found, including problems and duplicates", async () => {
    const root = tmpProject({ "x/openapi.json": oas("Shop", { "/a": { get: { operationId: "a", responses: {} } } }), "old/openapi.json": oas("Shop"), "bad.yaml": "openapi: 3.0.0\ninfo: {title: [\n" });
    fs.utimesSync(path.join(root, "old/openapi.json"), new Date(0), new Date(0));
    const core = await createCore({ root });
    const lines = describeSpecs(core.specs, root).join("\n");
    assert.match(lines, /● Shop 1: 1 operations, no base URL \(found at x\/openapi.json\)/);
    assert.match(lines, /⚠ No base URL/);
    assert.match(lines, /✗ bad.yaml: couldn't load/);
    assert.match(lines, /1 older copy of the same spec ignored: old\/openapi.json/);
    assert.deepEqual(describeSpecs({ specs: [] }, root), ["No OpenAPI or Swagger specs found in this project."]);
  });
  test("refreshes only when something changed, and picks up regenerated specs", async () => {
    const root = tmpProject({ "gen/openapi.json": oas("Gen", { "/a": { get: { operationId: "a", responses: {} } } }) });
    const core = await createCore({ root });
    assert.equal(await core.refreshSpecs(), false);
    const f = path.join(root, "gen/openapi.json");
    fs.writeFileSync(f, JSON.stringify(oas("Gen", { "/a": { get: { operationId: "a", responses: {} } }, "/b": { get: { operationId: "b", responses: {} } } })));
    assert.equal(await core.refreshSpecs(), true);
    assert.ok(core.specs.get("b"));
  });
  test("the watcher notices a regenerated spec within a few seconds", async () => {
    const root = tmpProject({ "gen/openapi.json": oas("Gen", { "/a": { get: { operationId: "a", responses: {} } } }) });
    const core = await createCore({ root });
    let changes = 0;
    core.watchSpecs(() => changes++);
    await new Promise((r) => setTimeout(r, 50));
    fs.writeFileSync(path.join(root, "gen/openapi.json"), JSON.stringify(oas("Gen", { "/c": { get: { operationId: "c", responses: {} } } })));
    await waitFor(() => core.specs.get("c"), { timeout: 6000, what: "the spec to reload" });
    assert.ok(changes >= 1);
  });
});

describe("the running GUI", () => {
  test("is found through .jodrell/server.json, and a stale record is ignored", async () => {
    const root = tmpProject();
    assert.equal(await runningGui(root), null);
    fs.mkdirSync(path.join(root, ".jodrell"), { recursive: true });
    fs.writeFileSync(path.join(root, ".jodrell/server.json"), JSON.stringify({ url: "http://127.0.0.1:1", pid: 1 }));
    assert.equal(await runningGui(root), null);
    recordGui(root, "http://127.0.0.1:2");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".jodrell/server.json"), "utf8")).pid, process.pid);
  });
});

test("a server.json that points elsewhere, or at another project's jodrell, is ignored", async () => {
  const { runningGui, dataDir } = await import("../../src/project.mjs");
  const { makeCore, startGui } = await import("../helpers.mjs");
  const fsx = await import("node:fs"); const px = await import("node:path");
  const core = await makeCore();
  const gui = await startGui(core);
  const info = px.join(dataDir(core.root), "server.json");
  try {
    fsx.writeFileSync(info, JSON.stringify({ url: gui.url }));
    assert.equal(await runningGui(core.root, core.store.file), gui.url, "our own server is found");
    assert.equal(await runningGui(core.root, "/somewhere/else/history.db"), null, "another project's database");
    for (const url of ["http://evil.example:80", "https://127.0.0.1:1", `${gui.url}/?&calc.exe&`, "http://127.0.0.1.evil.example:4545"]) {
      fsx.writeFileSync(info, JSON.stringify({ url }));
      assert.equal(await runningGui(core.root, core.store.file), null, url);
    }
  } finally { await gui.close(); }
});

test("only jodrell's own local pages are opened in the browser", async () => {
  const { openBrowser } = await import("../../src/open.mjs");
  for (const url of ["https://evil.example", "file:///etc/passwd", "http://127.0.0.1.evil.example/", "javascript:alert(1)"]) assert.equal(openBrowser(url), false, url);
});
