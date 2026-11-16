// Sending requests: bodies, sessions and cookies, captures, collections, replay.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { blankRequest } from "../../src/collections.mjs";
import { fakeApi, makeCore, oas, closedPort } from "../helpers.mjs";

let api;
before(async () => { api = await fakeApi(); });
after(async () => { await api.close(); });
const echo = (c) => JSON.parse(c.res_body);

describe("sending", () => {
  test("JSON, text, form and multipart bodies; default headers; GET has no body", async () => {
    const { runner } = await makeCore();
    let c = await runner.send({ method: "POST", url: `${api.url}/echo`, body: { a: 1 } });
    assert.equal(echo(c).headers["content-type"], "application/json"); assert.equal(echo(c).body, '{"a":1}');
    assert.match(echo(c).headers["user-agent"], /^apiscope|^jodrell/); assert.match(echo(c).headers.accept, /application\/json/);
    c = await runner.send({ method: "PUT", url: `${api.url}/echo`, body: "plain" }); assert.equal(echo(c).body, "plain");
    c = await runner.send({ method: "POST", url: `${api.url}/echo`, body: new URLSearchParams({ q: "dwarf 3" }) }); assert.equal(echo(c).body, "q=dwarf+3");
    const fd = new FormData(); fd.append("caption", "hi");
    c = await runner.send({ method: "POST", url: `${api.url}/echo`, body: fd }); assert.match(echo(c).headers["content-type"], /^multipart\/form-data; boundary=/);
    assert.equal(c.req_body, "caption: hi", "multipart is recorded readably");
    c = await runner.send({ method: "GET", url: `${api.url}/echo`, body: { ignored: true } }); assert.equal(echo(c).body, "");
  });
  test("records the response, masks secrets, and handles redirects, binary and large bodies", async () => {
    const { runner, store } = await makeCore();
    let c = await runner.send({ method: "GET", url: `${api.url}/status/200`, headers: { Authorization: "Bearer supersecrettoken123" } });
    assert.equal(c.status, 200); assert.ok(c.duration_ms >= 0); assert.match(c.res_type, /json/);
    assert.ok(!JSON.stringify(store.getCall(c.id)).includes("supersecrettoken123"), "the token isn't stored");
    assert.match(store.getCall(c.id).req_headers.Authorization, /^Bearer ••••3123$|••••/);
    c = await runner.send({ method: "GET", url: `${api.url}/redirect` }); assert.equal(c.status, 302); assert.equal(c.res_headers.location, "/echo");
    c = await runner.send({ method: "GET", url: `${api.url}/binary` }); assert.match(c.res_body, /^\[5 bytes of application\/octet-stream\]$/);
    c = await runner.send({ method: "GET", url: `${api.url}/big?kb=1100` }); assert.equal(c.truncated, true); assert.equal(c.res_body.length, 1_000_000);
  });
  test("refuses a method that isn't an HTTP token, before anything is stored", async () => {
    const { runner, store } = await makeCore();
    await assert.rejects(runner.send({ method: "GET;echo hi;", url: `${api.url}/echo` }), /isn't a valid HTTP method/);
    assert.equal(store.listCalls({}).length, 0);
  });
  test("history keeps no secrets from URLs or bodies, but replay still sends the real ones", async () => {
    const { runner, store } = await makeCore();
    const c = await runner.send({ method: "POST", url: `${api.url}/echo?api_key=QUERY-SECRET-123456`, body: { user: "ada", password: "PlainPassword123" } });
    const saved = store.getCall(c.id);
    assert.ok(!saved.url.includes("QUERY-SECRET")); assert.ok(!saved.req_body.includes("PlainPassword123")); assert.match(saved.req_body, /"user":"ada"/);
    const r = await runner.replay(c.id);
    const sent = JSON.parse(r.res_body);
    assert.equal(sent.query.api_key, "QUERY-SECRET-123456"); assert.match(sent.body, /PlainPassword123/);
  });
  test("replay never sends a request's secret headers to a different host", async () => {
    const { runner } = await makeCore();
    const c = await runner.send({ method: "GET", url: `${api.url}/echo`, headers: { "X-Token": "host-a-secret-value" } });
    const other = await runner.replay(c.id, { url: `${api.localhost}/echo` });
    assert.equal(JSON.parse(other.res_body).headers["x-token"], undefined);
    const same = await runner.replay(c.id);
    assert.equal(JSON.parse(same.res_body).headers["x-token"], "host-a-secret-value");
  });
  test("explains failures in plain words", async () => {
    const { runner } = await makeCore();
    const port = await closedPort();
    const c = await runner.send({ method: "GET", url: `http://127.0.0.1:${port}/nothing` });
    assert.equal(c.error, `Connection refused at 127.0.0.1:${port}. Is the API running?`);
    assert.ok(c.id, "failures are recorded in the history too");
    await assert.rejects(runner.send({ method: "GET", url: "{{base}}/x" }), /unresolved variables: \{\{base\}\}/);
    await assert.rejects(runner.send({ method: "GET", url: "ftp://x" }), /isn't a full http\(s\) URL/);
  });
  test("uses the active environment's variables", async () => {
    const { runner, collections } = await makeCore();
    const e = collections.createEnv({ name: "Local", vars: [{ key: "base", value: api.url, enabled: true }] });
    collections.setActiveEnv(e.id);
    const c = await runner.send({ method: "GET", url: "{{base}}/users/42" });
    assert.equal(c.status, 200);
    assert.equal(c.url, `${api.url}/users/42`);
  });
});

describe("sessions and cookies", () => {
  test("cookies go back only to the host that set them, and expire when told", async () => {
    const { runner } = await makeCore();
    await runner.send({ method: "POST", url: `${api.url}/login`, body: { password: "secret" }, session: "s" });
    assert.equal((await runner.send({ method: "GET", url: `${api.url}/me`, session: "s" })).status, 200);
    assert.equal((await runner.send({ method: "GET", url: `${api.localhost}/me`, session: "s" })).status, 401, "localhost is a different host");
    await runner.send({ method: "GET", url: `${api.url}/logout`, session: "s" });
    assert.equal((await runner.send({ method: "GET", url: `${api.url}/me`, session: "s" })).status, 401);
  });
  test("captured auth headers are tied to their host; variables can be reused", async () => {
    const { runner, store } = await makeCore();
    const login = await runner.send({ method: "POST", url: `${api.url}/login`, body: { password: "secret" }, session: "t", capture: { "header:Authorization": "Bearer {{body.access_token}}", "var:userId": "{{body.user.id}}", "var:rid": "{{header.x-request-id}}", "var:none": "{{body.nope}}" } });
    assert.match(login.captured["header:Authorization"], /sent to 127\.0\.0\.1 only/);
    assert.equal(login.captured["var:userId"], "u1"); assert.equal(login.captured["var:rid"], "req-123"); assert.equal(login.captured["var:none"], "not found");
    store.saveSession({ ...store.getSession("t"), cookies: {} }); // prove it's the header, not the cookie
    assert.equal((await runner.send({ method: "GET", url: `${api.url}/me`, session: "t" })).status, 200);
    const other = await runner.send({ method: "GET", url: `${api.localhost}/echo`, session: "t" });
    assert.equal(echo(other).headers.authorization, undefined);
    assert.equal(echo(await runner.send({ method: "GET", url: `${api.url}/echo/{{userId}}`, session: "t" })).path, "/echo/u1");
  });
});

describe("saved requests and collections", () => {
  async function shop() {
    const core = await makeCore();
    const { collections } = core;
    const env = collections.createEnv({ name: "Local", vars: [{ key: "base", value: api.url, enabled: true }, { key: "password", value: "secret", enabled: true }] });
    collections.setActiveEnv(env.id);
    const c = collections.createCollection({ name: "Shop", auth: { type: "bearer", token: "{{token}}" } });
    const add = (name, request, parentId = null) => collections.createItem({ collectionId: c.id, parentId, name, request: blankRequest(request) });
    add("Log in", { method: "POST", url: "{{base}}/login", auth: { type: "none" }, body: { mode: "json", raw: '{"password":"{{password}}"}', fields: [], graphql: {} }, captures: [{ key: "token", value: "body.access_token" }], expectStatus: "200" });
    const f = collections.createItem({ collectionId: c.id, kind: "folder", name: "Account" });
    add("Me", { url: "{{base}}/me", expectStatus: "200" }, f.id);
    add("Teapot", { url: "{{base}}/status/418", expectStatus: "200" }, f.id);
    add("Last", { url: "{{base}}/echo" });
    return { ...core, colId: c.id, folderId: f.id };
  }
  test("a collection run: in order, with captures feeding inherited auth, and pass/fail per request", async () => {
    const { runner, store, collections, colId } = await shop();
    let done; store.on("rundone", (r) => (done = r));
    const r = await runner.runCollection(colId);
    assert.deepEqual(r.results.map((x) => [x.item, x.status, x.passed]), [["Shop / Log in", 200, true], ["Shop / Account / Me", 200, true], ["Shop / Account / Teapot", 418, false], ["Shop / Last", 200, true]]);
    assert.equal(r.passed, 3); assert.equal(done.runId, r.runId);
    assert.match(collections.activeEnv().vars.find((v) => v.key === "token").value, /^tok-/);
    assert.equal(store.listCalls({ run: r.runId }).length, 4);
  });
  test("stop on failure, and run just one folder", async () => {
    const { runner, colId, folderId } = await shop();
    await runner.runCollection(colId, { folderId });
    const r = await runner.runCollection(colId, { stopOnFailure: true });
    assert.equal(r.results.length, 3);
    const f = await runner.runCollection(colId, { folderId });
    assert.deepEqual(f.results.map((x) => x.item.split(" / ").pop()), ["Me", "Teapot"]);
  });
  test("a missing variable stops a saved request with a clear message", async () => {
    const { runner, collections } = await makeCore();
    const c = collections.createCollection({ name: "C" });
    const it = collections.createItem({ collectionId: c.id, name: "R", request: blankRequest({ url: "{{nowhere}}/x" }) });
    await assert.rejects(runner.runItem(it.id), /Unresolved variables: \{\{nowhere\}\}/);
  });
});

describe("replaying", () => {
  test("re-sends with edits, keeps secret headers out of the history but still sends them", async () => {
    const { runner, store } = await makeCore();
    const first = await runner.send({ method: "GET", url: `${api.url}/me`, headers: { Authorization: `Bearer ${api.token}` } });
    assert.equal(first.status, 200);
    const again = await runner.replay(first.id);
    assert.equal(again.status, 200, "the token was replayed from memory");
    assert.equal(again.replay_of, first.id);
    const edited = await runner.replay(first.id, { url: `${api.url}/echo`, method: "POST", body: '{"x":1}' });
    assert.equal(echo(edited).method, "POST"); assert.equal(echo(edited).body, '{"x":1}');
    assert.ok(!JSON.stringify(store.listCalls()).includes(api.token));
    await assert.rejects(runner.replay(9999), /No call with id 9999/);
  });
});

describe("operations from the spec", () => {
  test("builds the URL, checks path parameters, and suggests near misses", async () => {
    const core = await makeCore({ "openapi.json": oas("Users", { "/users/{id}": { get: { operationId: "getUser", responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id", "email"] } } } } } } } }, { servers: [{ url: "PLACEHOLDER" }] }) });
    core.specs.list()[0].baseUrl = api.url;
    const r = core.runner.fromOperation("getUser", { pathParams: { id: "a b" }, query: { tag: ["x", "y"] } });
    assert.equal(r.url, `${api.url}/users/a%20b?tag=x&tag=y`);
    assert.throws(() => core.runner.fromOperation("getUser", {}), /Missing path parameter\(s\) for getUser: id/);
    assert.throws(() => core.runner.fromOperation("getUsr", {}), /Did you mean: getUser/);
    const c = await core.runner.send(r);
    assert.equal(c.validation.valid, false, "the fake API doesn't return email");
  });
});
