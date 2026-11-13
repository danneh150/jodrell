// Loading OpenAPI 3 and Swagger 2 specs into an index of operations.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { SpecIndex, findSpecs } from "../../src/spec.mjs";
import { tmpProject, oas, example } from "../helpers.mjs";

const write = (files) => { const root = tmpProject(files); return (f) => path.join(root, f); };

describe("OpenAPI 3", () => {
  test("loads JSON and YAML, resolves $refs, and lists operations", async () => {
    const idx = await new SpecIndex([example("openapi.yaml")]).load();
    assert.deepEqual(idx.list().map((o) => o.id).sort(), ["createOrder", "getOrder", "listOrders", "login"]);
    const get = idx.get("getOrder");
    assert.equal(get.method, "GET"); assert.equal(get.path, "/orders/{orderId}");
    assert.equal(get.params[0].name, "orderId");
    assert.equal(get.responses["200"].content["application/json"].schema.type, "object", "the $ref was resolved");
    assert.equal(idx.specs[0].baseUrl, "http://localhost:4600");
  });
  test("makes ids for operations without operationId", async () => {
    const f = write({ "a.json": oas("A", { "/orders/{id}/items": { get: { responses: { 200: { description: "ok" } } } } }) });
    const idx = await new SpecIndex([f("a.json")]).load();
    assert.equal(idx.list()[0].id, "get_orders_by_id_items");
  });
  test("survives circular references", async () => {
    const f = write({ "c.json": oas("C", { "/n": { get: { operationId: "node", responses: { 200: { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/Node" } } } } } } } }, { components: { schemas: { Node: { type: "object", properties: { child: { $ref: "#/components/schemas/Node" } } } } } }) });
    const idx = await new SpecIndex([f("c.json")]).load();
    assert.equal(idx.specs[0].error, undefined);
    assert.match(JSON.stringify(idx.get("node").responses), /circular reference/);
  });
  test("works out base URLs: server variables, relative servers, overrides", async () => {
    const f = write({
      "vars.json": oas("Vars", { "/a": { get: { operationId: "a", responses: {} } } }, { servers: [{ url: "https://{env}.example.com/v{ver}", variables: { env: { default: "api" }, ver: { default: "2" } } }] }),
      "rel.json": oas("Rel", { "/b": { get: { operationId: "b", responses: {} } } }, { servers: [{ url: "/api" }] }),
    });
    const idx = await new SpecIndex([f("vars.json"), f("rel.json")], undefined, { fallbackBaseUrl: "http://localhost:3000" }).load();
    const by = Object.fromEntries(idx.specs.map((s) => [s.title, s.baseUrl]));
    assert.equal(by.Vars, "https://api.example.com/v2");
    assert.equal(by.Rel, "http://localhost:3000/api");
    const forced = await new SpecIndex([f("vars.json")], "http://override:1").load();
    assert.equal(forced.specs[0].baseUrl, "http://override:1");
    const per = await new SpecIndex([{ source: f("rel.json"), baseUrl: "http://per-spec:9" }]).load();
    assert.equal(per.specs[0].baseUrl, "http://per-spec:9");
  });
  test("operation ids that clash across specs are prefixed with the spec", async () => {
    const f = write({ "x.json": oas("Billing", { "/a": { get: { operationId: "list", responses: {} } } }), "y.json": oas("Users", { "/b": { get: { operationId: "list", responses: {} } } }) });
    const idx = await new SpecIndex([f("x.json"), f("y.json")]).load();
    assert.deepEqual(idx.list().map((o) => o.id).sort(), ["Users.list", "list"]);
  });
  test("a spec that won't load is reported on one line, and the rest still load", async () => {
    const f = write({ "ok.json": oas("Ok", { "/a": { get: { operationId: "a", responses: {} } } }), "bad.yaml": "openapi: 3.0.0\ninfo: {title: [\n", "notspec.json": { hello: "world" } });
    const idx = await new SpecIndex([f("ok.json"), f("bad.yaml"), f("notspec.json"), f("missing.json")]).load();
    assert.equal(idx.get("a").spec, "Ok");
    const errors = idx.specs.filter((s) => s.error);
    assert.equal(errors.length, 3);
    assert.ok(errors.every((e) => !e.error.includes("\n")));
  });
  test("loads a spec given as text (as fetched from a running app)", async () => {
    const idx = await new SpecIndex([{ source: "http://app.test/openapi.json", text: JSON.stringify(oas("T", { "/z": { get: { operationId: "z", responses: {} } } }, { servers: [{ url: "/v1" }] })) }]).load();
    assert.equal(idx.specs[0].baseUrl, "http://app.test/v1");
  });
});

describe("Swagger 2.0", () => {
  test("converts host, base path, body, form and response schemas", async () => {
    const f = write({ "s.yaml": `swagger: "2.0"
info: { title: Legacy, version: "1" }
host: api.example.com
basePath: /v2
schemes: [http, https]
paths:
  /pets/{id}:
    parameters: [{ name: id, in: path, required: true, type: string }]
    get:
      operationId: getPet
      responses: { "200": { description: ok, schema: { $ref: "#/definitions/Pet" } } }
  /pets:
    post:
      operationId: addPet
      parameters: [{ in: body, name: body, required: true, schema: { $ref: "#/definitions/Pet" } }]
      responses: { "201": { description: created } }
  /upload:
    post:
      operationId: upload
      consumes: [multipart/form-data]
      parameters: [{ in: formData, name: file, type: file, required: true }, { in: formData, name: caption, type: string }]
      responses: { "200": { description: ok } }
  /login:
    post:
      operationId: formLogin
      parameters: [{ in: formData, name: user, type: string, required: true }]
      responses: { "200": { description: ok } }
definitions:
  Pet: { type: object, required: [name], properties: { name: { type: string } } }
` });
    const idx = await new SpecIndex([f("s.yaml")]).load();
    assert.equal(idx.specs[0].kind, "Swagger 2.0");
    assert.equal(idx.specs[0].baseUrl, "https://api.example.com/v2", "prefers https");
    assert.equal(idx.get("getPet").params[0].name, "id", "path-level parameters are kept");
    assert.equal(idx.get("getPet").responses["200"].content["application/json"].schema.properties.name.type, "string");
    assert.deepEqual(idx.get("addPet").requestBody.schema.required, ["name"]);
    assert.ok(idx.get("upload").requestBody);
    assert.deepEqual(idx.get("formLogin").requestBody.schema.required, ["user"]);
  });
});

describe("matching a URL to an operation", () => {
  test("matches by method, path parameters and base path, but not on another host", async () => {
    const idx = await new SpecIndex([example("openapi.yaml")]).load();
    assert.equal(idx.match("GET", "http://localhost:4600/orders/o-9")?.id, "getOrder");
    assert.equal(idx.match("POST", "http://localhost:4600/orders")?.id, "createOrder");
    assert.equal(idx.match("DELETE", "http://localhost:4600/orders/o-9"), null);
    assert.equal(idx.match("GET", "https://api.thirdparty.example/orders/o-9"), null, "same path on a third-party host");
  });
  test("findSpecs returns the spec files in a project", () => {
    const root = tmpProject({ "dist/openapi.json": oas("D") });
    assert.deepEqual(findSpecs(root), [path.join(root, "dist/openapi.json")]);
    assert.ok(fs.existsSync(findSpecs(root)[0]));
  });
});
