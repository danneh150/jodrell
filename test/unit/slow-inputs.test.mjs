// Hostile files and commands can't make jodrell (or the guard) hang. Each of
// these took seconds to minutes before; they must now be near-instant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkBash } from "../../bin/guard.mjs";
import { convertScript } from "../../src/collections.mjs";
import { SpecIndex } from "../../src/spec.mjs";
import { readDotEnv } from "../../src/auth.mjs";
import { tmpProject } from "../helpers.mjs";

const quick = (what, fn, ms = 500) => { const t = Date.now(); const out = fn(); assert.ok(Date.now() - t < ms, `${what} took ${Date.now() - t} ms`); return out; };

test("the guard with a long run of VAR=value prefixes", () => {
  assert.ok(quick("guard", () => checkBash("a=b ".repeat(40) + "true; curl http://127.0.0.1:9/api")), "and it still blocks");
});

test("a Postman script line full of spaces", () => {
  quick("convertScript", () => convertScript(`pm.environment.set("x",${" ".repeat(20000)}y`));
  quick("convertScript, just under the cap", () => convertScript(`pm.environment.set("x",${" ".repeat(990)}y`));
});

test("a .env line full of spaces", () => {
  const root = tmpProject({ ".env": "A=" + " ".repeat(50000) + "x\n" });
  assert.equal(quick("readDotEnv", () => readDotEnv(root)).A, "x");
});

test("a spec whose schemas each refer to the next one twice, and paths full of parameters", async () => {
  const schemas = {};
  for (let i = 0; i < 40; i++) schemas[`S${i}`] = { type: "object", properties: { a: { $ref: `#/components/schemas/S${i + 1}` }, b: { $ref: `#/components/schemas/S${i + 1}` } } };
  schemas.S40 = { type: "string" };
  const many = "/" + Array.from({ length: 14 }, (_, i) => `{p${i}}`).join("");
  const doc = { openapi: "3.0.0", info: { title: "Deep", version: "1" }, servers: [{ url: "http://api.test" }], components: { schemas },
    paths: { "/x": { get: { operationId: "x", responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/S0" } } } } } } }, [many]: { get: { operationId: "many", responses: {} } } } };
  const t = Date.now();
  const idx = await new SpecIndex([{ source: "deep.json", text: JSON.stringify(doc) }]).load();
  assert.ok(Date.now() - t < 1000, `loading took ${Date.now() - t} ms`);
  assert.equal(quick("match", () => idx.match("GET", "http://api.test/" + "a".repeat(40) + "!")).id, "many");
  assert.equal(idx.match("GET", "http://api.test/x").id, "x");
});
