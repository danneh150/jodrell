// Finding specs in a project by their contents, and asking a running app for one.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discoverSpecs, sniff, probeApp, SPEC_PATHS } from "../../src/discover.mjs";
import { tmpProject, oas, fakeApi } from "../helpers.mjs";

describe("recognising a spec", () => {
  test("by its openapi or swagger key, in JSON or YAML", () => {
    assert.equal(sniff('{"openapi":"3.1.0","info":{}}'), "openapi3");
    assert.equal(sniff("openapi: 3.0.3\ninfo: {}"), "openapi3");
    assert.equal(sniff("swagger: '2.0'\ninfo: {}"), "swagger2");
    assert.equal(sniff('{\n  "swagger": "2.0"\n}'), "swagger2");
  });
  test("but not things that merely mention it", () => {
    assert.equal(sniff('{"name":"x","openapi-tools":"1"}'), null);
    assert.equal(sniff("openapi: 2.0"), null);
    assert.equal(sniff("title: notes about openapi"), null);
  });
});

describe("searching a project", () => {
  test("finds specs anywhere, by content, and ignores dependencies, caches and configs", () => {
    const root = tmpProject({
      "apps/api/dist/generated.json": oas("Shop"), "services/billing/contract.yaml": "swagger: '2.0'\ninfo: {title: Billing, version: '1'}\npaths: {}\n",
      "node_modules/sdk/openapi.json": oas("SDK"), ".next/cache/openapi.json": oas("Cache"), ".venv/lib/openapi.json": oas("Venv"), "coverage/openapi.json": oas("Cov"),
      "tsconfig.json": { compilerOptions: {} }, "notes/readme.yaml": "title: not a spec\n", "tiny.json": "{}",
    });
    const r = discoverSpecs(root);
    assert.deepEqual(r.specs.map((s) => path.relative(root, s.path)).sort(), ["apps/api/dist/generated.json", "services/billing/contract.yaml"]);
    assert.deepEqual(r.specs.map((s) => s.kind).sort(), ["openapi3", "swagger2"]);
    assert.equal(r.specs.find((s) => s.kind === "openapi3").title, "Shop");
  });
  test("keeps only the newest copy when the same spec is in several places", () => {
    const root = tmpProject({ "dist/openapi.json": oas("Shop"), "docs/old/openapi.json": oas("Shop") });
    const old = path.join(root, "docs/old/openapi.json");
    fs.utimesSync(old, new Date(Date.now() - 864e5), new Date(Date.now() - 864e5));
    const r = discoverSpecs(root);
    assert.equal(r.specs.length, 1);
    assert.equal(path.relative(root, r.specs[0].path), "dist/openapi.json");
    assert.deepEqual(r.duplicates.map((d) => path.relative(root, d.path)), ["docs/old/openapi.json"]);
  });
  test("respects the depth limit", () => {
    const root = tmpProject({ "a/b/c/d/openapi.json": oas("Deep") });
    assert.equal(discoverSpecs(root, { maxDepth: 2 }).specs.length, 0);
    assert.equal(discoverSpecs(root).specs.length, 1);
  });
  test("copes with an empty project", () => {
    assert.deepEqual(discoverSpecs(tmpProject()).specs, []);
  });
});

describe("asking the running app", () => {
  test("fetches a spec from the usual framework paths", async () => {
    const api = await fakeApi();
    try {
      assert.ok(SPEC_PATHS.includes("/v3/api-docs"));
      const hits = await probeApp(api.url);
      assert.equal(hits.length, 1);
      assert.equal(hits[0].url, `${api.url}/v3/api-docs`);
      assert.equal(hits[0].kind, "openapi3");
    } finally { await api.close(); }
  });
  test("returns nothing, quickly, when the app isn't running", async () => {
    const started = Date.now();
    assert.deepEqual(await probeApp("http://127.0.0.1:9"), []);
    assert.ok(Date.now() - started < 3000);
  });
});
