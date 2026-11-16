// Collections, folders, saved requests, environments and Postman import.
import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Store } from "../../src/store.mjs";
import { Collections, blankRequest, convertScript } from "../../src/collections.mjs";
import { tmpDb, example } from "../helpers.mjs";

let cols;
beforeEach(() => { cols = new Collections(new Store(tmpDb())); });
const pm = (item, extra = {}) => ({ info: { name: "T", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" }, item, ...extra });

describe("Postman import", () => {
  test("the example collection: folders, auth, path variables, bodies and scripts", () => {
    const s = cols.importPostman(fs.readFileSync(example("demo-shop.postman_collection.json"), "utf8"));
    assert.equal(s.kind, "collection");
    assert.deepEqual([s.requests, s.folders, s.capturesFromScripts, s.scriptLinesSkipped], [5, 1, 4, 2]);
    const [c] = cols.list();
    assert.equal(c.auth.type, "bearer");
    assert.equal(c.variables.find((v) => v.key === "baseUrl").value, "http://localhost:4600");
    const login = cols.findRequest("Log in");
    assert.equal(login.request.auth.type, "none");
    assert.equal(login.request.body.mode, "json");
    assert.equal(login.request.expectStatus, "200");
    assert.deepEqual(login.request.captures.map((x) => [x.key, x.value]), [["token", "body.access_token"]]);
    assert.deepEqual(cols.findRequest("Orders / Get order").request.pathVars, [{ key: "orderId", value: "{{firstOrder}}" }]);
    const echo = cols.findRequest("Third party echo").request;
    assert.equal(echo.body.mode, "urlencoded");
    assert.equal(echo.body.fields.find((f) => f.key === "skip").enabled, false);
  });
  test("collection v2.0 auth objects, API keys in the query, basic and unsupported auth", () => {
    const s = cols.importPostman(pm([
      { name: "v20", request: { method: "GET", url: "https://a.test/x", auth: { type: "bearer", bearer: { token: "T0" } } } },
      { name: "key", request: { method: "GET", url: "https://a.test/y", auth: { type: "apikey", apikey: [{ key: "key", value: "api_key" }, { key: "value", value: "K1" }, { key: "in", value: "query" }] } } },
      { name: "basic", request: { method: "GET", url: "https://a.test/z", auth: { type: "basic", basic: [{ key: "username", value: "u" }, { key: "password", value: "p" }] } } },
      { name: "oauth", request: { method: "GET", url: "https://a.test/o", auth: { type: "oauth2", oauth2: [] } } },
    ]));
    assert.deepEqual(cols.findRequest("v20").request.auth, { type: "bearer", token: "T0" });
    assert.deepEqual(cols.findRequest("key").request.auth, { type: "apikey", key: "api_key", value: "K1", in: "query" });
    assert.deepEqual(cols.findRequest("basic").request.auth, { type: "basic", username: "u", password: "p" });
    assert.equal(cols.findRequest("oauth").request.auth.type, "unsupported");
    assert.ok(s.notes.some((n) => /oauth2 auth, which isn't supported/.test(n)));
  });
  test("URLs given as objects without raw, string requests, GraphQL, files and disabled bodies", () => {
    const s = cols.importPostman(pm([
      { name: "obj", request: { method: "GET", url: { protocol: "https", host: ["api", "example", "com"], path: ["v1", "things"], query: [{ key: "a", value: "1" }, { key: "off", value: "x", disabled: true }] } } },
      { name: "str", request: "https://example.com/plain" },
      { name: "gql", request: { method: "POST", url: "https://g.test/graphql", body: { mode: "graphql", graphql: { query: "{ me { id } }", variables: '{"a":1}' } } } },
      { name: "upload", request: { method: "POST", url: "https://u.test/up", body: { mode: "formdata", formdata: [{ key: "file", type: "file", src: "/x.png" }, { key: "caption", value: "hi", type: "text" }] } } },
      { name: "bin", request: { method: "POST", url: "https://u.test/bin", body: { mode: "file", file: { src: "/x" } } } },
      { name: "off", request: { method: "POST", url: "https://u.test/off", body: { mode: "raw", raw: "{}", disabled: true } } },
    ], { event: [{ listen: "prerequest", script: { exec: ["console.log(1)"] } }] }));
    assert.equal(cols.findRequest("obj").request.url, "https://api.example.com/v1/things?a=1");
    assert.equal(cols.findRequest("str").request.method, "GET");
    assert.deepEqual(cols.findRequest("gql").request.body.graphql, { query: "{ me { id } }", variables: '{"a":1}' });
    assert.equal(cols.findRequest("upload").request.body.fields[0].type, "file");
    assert.equal(cols.findRequest("off").request.body.mode, "none");
    assert.ok(s.notes.some((n) => /file fields/.test(n)));
    assert.ok(s.notes.some((n) => /binary file body/.test(n)));
    assert.ok(s.notes.some((n) => /collection has its own scripts/.test(n)));
  });
  test("nested folders keep their order and their own auth", () => {
    cols.importPostman(pm([{ name: "A", auth: { type: "noauth" }, item: [{ name: "B", item: [{ name: "C", item: [{ name: "deep", request: { method: "GET", url: "https://d.test/" } }] }] }, { name: "second", request: "https://d.test/2" }] }]));
    const deep = cols.findRequest("A / B / C / deep");
    assert.deepEqual(cols.ancestors(deep).map((f) => f.name), ["A", "B", "C"]);
    assert.equal(cols.ancestors(deep)[0].auth.type, "none");
    assert.equal(cols.pathOf(deep), "T / A / B / C / deep");
    assert.deepEqual(cols.requestsIn(cols.list()[0].id).map((r) => r.name), ["deep", "second"]);
  });
  test("accepts the Postman API's wrapped export, and rejects other files clearly", () => {
    assert.equal(cols.importPostman({ collection: pm([{ name: "w", request: "https://w.test" }]) }).requests, 1);
    assert.throws(() => cols.importPostman({ hello: 1 }), /doesn't look like a Postman collection/);
    assert.throws(() => cols.importPostman("not json"), /isn't valid JSON/);
  });
  test("environments: imported, and re-importing updates rather than duplicates", () => {
    const env = JSON.parse(fs.readFileSync(example("demo-shop.postman_environment.json"), "utf8"));
    assert.equal(cols.importPostman(env).variables, 3);
    env.values.push({ key: "extra", value: "1", enabled: true });
    cols.importPostman(env);
    assert.equal(cols.environments().length, 1);
    assert.equal(cols.environments()[0].vars.length, 4);
  });
});

describe("collections, folders and requests", () => {
  test("create, rename, move and delete (folders delete their contents)", () => {
    const c = cols.createCollection({ name: "Mine" });
    const f = cols.createItem({ collectionId: c.id, kind: "folder", name: "F" });
    const r = cols.createItem({ collectionId: c.id, parentId: f.id, name: "R", request: blankRequest({ url: "https://x.test" }) });
    assert.equal(cols.updateItem(r.id, { name: "R2" }).name, "R2");
    assert.equal(cols.updateCollection(c.id, { name: "Renamed" }).name, "Renamed");
    cols.updateItem(r.id, { parentId: null });
    assert.equal(cols.getItem(r.id).parentId, null);
    cols.updateItem(r.id, { parentId: f.id });
    cols.deleteItem(f.id);
    assert.equal(cols.getItem(r.id), null);
    cols.deleteCollection(c.id);
    assert.equal(cols.list().length, 0);
  });
  test("finds requests by id, by path, by partial name, and says when a name is ambiguous", () => {
    cols.importPostman(fs.readFileSync(example("demo-shop.postman_collection.json"), "utf8"));
    const id = cols.findRequest("Get order").id;
    assert.equal(cols.findRequest(String(id)).name, "Get order");
    assert.equal(cols.findRequest("demo shop (postman) / orders / get order").id, id);
    assert.equal(cols.findRequest("Create").name, "Create order");
    assert.throws(() => cols.findRequest("order"), /matches 3 requests/);
    assert.equal(cols.findRequest("nothing like this"), null);
  });
  test("changes are announced so GUIs can refresh", () => {
    let n = 0;
    cols.store.on("collections", () => n++);
    cols.createCollection({ name: "x" });
    assert.ok(n >= 1);
  });
});

describe("environments and variables", () => {
  test("one active environment at a time; deleting it clears the selection", () => {
    const a = cols.createEnv({ name: "Local", vars: [{ key: "base", value: "http://localhost", enabled: true }] });
    const b = cols.createEnv({ name: "Staging" });
    cols.setActiveEnv(a.id);
    assert.equal(cols.activeEnv().name, "Local");
    cols.setActiveEnv(b.id);
    assert.deepEqual(cols.environments().filter((e) => e.active).map((e) => e.name), ["Staging"]);
    assert.equal(cols.findEnv("staging").id, b.id);
    cols.deleteEnv(b.id);
    assert.equal(cols.activeEnv(), null);
  });
  test("saving a variable goes where Postman would put it", () => {
    const c = cols.createCollection({ name: "C" });
    assert.match(cols.setVariable("x", "1", { collectionId: c.id }), /collection "C"/);
    assert.equal(cols.getCollection(c.id).variables.find((v) => v.key === "x").value, "1");
    const e = cols.createEnv({ name: "Dev" }); cols.setActiveEnv(e.id);
    assert.match(cols.setVariable("x", "2", { collectionId: c.id }), /environment "Dev"/);
    cols.setVariable("x", "3");
    assert.equal(cols.activeEnv().vars.filter((v) => v.key === "x").length, 1, "updated, not duplicated");
    cols.setActiveEnv(null);
    assert.throws(() => cols.setVariable("y", "1", { scope: "environment" }), /No active environment/);
  });
  test("with nowhere else to put it, creates a Local environment", () => {
    assert.match(cols.setVariable("token", "abc"), /new environment "Local"/);
    assert.equal(cols.activeEnv().name, "Local");
  });
});

describe("converting Postman test scripts", () => {
  test("captures from the body, headers and status, with aliases and brackets", () => {
    const r = convertScript([
      "const data = JSON.parse(responseBody);",
      'pm.environment.set("a", data.items[0]["id"]);',
      'pm.globals.set("b", pm.response.json().user.id);',
      'pm.variables.set("c", pm.response.headers.get("X-Request-Id"));',
      'postman.setEnvironmentVariable("d", data.token);',
      'pm.environment.set("e", pm.response.code);',
    ].join("\n"));
    assert.deepEqual(r.captures.map((c) => [c.key, c.value]), [["a", "body.items.0.id"], ["b", "body.user.id"], ["c", "header.x-request-id"], ["d", "body.token"], ["e", "status"]]);
    assert.equal(r.remaining, 0);
  });
  test("status checks in each common style", () => {
    assert.equal(convertScript("pm.response.to.have.status(201);").expectStatus, "201");
    assert.equal(convertScript("pm.expect(pm.response.code).to.eql(204);").expectStatus, "204");
    assert.equal(convertScript('tests["ok"] = responseCode.code === 200;').expectStatus, "200");
  });
  test("counts what it couldn't convert, ignoring comments and structure", () => {
    const r = convertScript(["// a comment", 'pm.test("x", function () {', "  pm.expect(pm.response.json().a).to.be.ok;", "});", "", "postman.setNextRequest(null);"].join("\n"));
    assert.equal(r.converted, 0);
    assert.equal(r.remaining, 2);
    assert.deepEqual(convertScript(""), { captures: [], expectStatus: "", converted: 0, remaining: 0 });
  });
});
