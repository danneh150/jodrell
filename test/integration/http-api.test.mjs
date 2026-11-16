// The GUI's HTTP API, end to end against the fake API.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { blankRequest } from "../../src/collections.mjs";
import { fakeApi, makeCore, startGui, nextEvent, sleep, example, oas } from "../helpers.mjs";

let api, core, gui;
const j = async (path, opts = {}) => {
  const r = await fetch(gui.url + path, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) }, body: opts.body && typeof opts.body !== "string" ? JSON.stringify(opts.body) : opts.body });
  return { status: r.status, type: r.headers.get("content-type"), data: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text(), headers: r.headers };
};
before(async () => {
  api = await fakeApi();
  core = await makeCore({ "openapi.json": oas("Fake", { "/users/{id}": { get: { operationId: "getUser", responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "object", required: ["id"] } } } } } } } }) });
  core.specs.list()[0].baseUrl = api.url;
  gui = await startGui(core);
});
after(async () => { await gui.close(); await api.close(); });

describe("serving the GUI", () => {
  test("the page, its shared files, the font and the icons", async () => {
    const page = await j("/");
    assert.equal(page.status, 200); assert.match(page.data, /<title>jodrell<\/title>/); assert.match(page.data, /href="\/favicon.ico"/);
    for (const [p, type] of [["/view.js", "javascript"], ["/view.css", "css"], ["/tokens.css", "css"], ["/fonts/PixelifySans.ttf", "font/ttf"], ["/favicon.ico", "image/x-icon"], ["/icons/jodrell-32.png", "image/png"], ["/icons/jodrell.svg", "svg"]]) {
      const r = await fetch(gui.url + p);
      assert.equal(r.status, 200, p); assert.match(r.headers.get("content-type"), new RegExp(type), p);
    }
  });
  test("refuses requests from other websites, and explains bad input", async () => {
    assert.equal((await j("/api/calls", { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal((await j("/api/calls", { headers: { origin: gui.url } })).status, 200);
    const bad = await j("/api/send", { method: "POST", body: "{not json" });
    assert.equal(bad.status, 400); assert.match(bad.data.error, /not valid JSON/);
    assert.equal((await j("/api/nothing")).status, 404);
  });
  test("info and spec endpoints", async () => {
    const info = (await j("/api/info")).data;
    assert.equal(info.operations, 1); assert.match(info.mcpUrl, /\/mcp$/);
    assert.equal((await j("/api/specs")).data[0].title, "Fake");
    assert.equal((await j("/api/operations")).data[0].id, "getUser");
    assert.equal((await j("/api/specs/reload", { method: "POST" })).data.ok, true);
  });
});

describe("sending and history", () => {
  test("send a request from the builder; it's recorded and announced", async () => {
    const ev = nextEvent(gui.url, (e, d) => e === "call" && d.url.endsWith("/users/9"));
    await sleep(100);
    const sent = await j("/api/send", { method: "POST", body: { request: blankRequest({ url: `${api.url}/users/9` }), session: "default" } });
    assert.equal(sent.data.status, 200); assert.equal(sent.data.source, "ui");
    assert.equal(sent.data.op_id, "getUser", "matched to the spec"); assert.equal(sent.data.validation.valid, true);
    assert.equal(sent.data.ctx, undefined, "internal fields aren't sent to the browser");
    const { data } = await ev;
    assert.equal(data.res_body, undefined, "events carry no bodies");
  });
  test("unresolved variables are a 400 with the names", async () => {
    const r = await j("/api/send", { method: "POST", body: { request: blankRequest({ url: "{{missing}}/x" }) } });
    assert.equal(r.status, 400); assert.match(r.data.error, /\{\{missing\}\}/);
  });
  test("history, one call with its previous, replay, and clearing", async () => {
    const a = (await j("/api/send", { method: "POST", body: { request: blankRequest({ url: `${api.url}/echo/r` }) } })).data;
    const b = (await j(`/api/calls/${a.id}/replay`, { method: "POST", body: {} })).data;
    assert.equal(b.replay_of, a.id);
    assert.equal((await j(`/api/calls/${b.id}`)).data.previous, a.id, "the same request sent earlier");
    const edited = (await j(`/api/calls/${a.id}/replay`, { method: "POST", body: { method: "POST", body: '{"x":1}' } })).data;
    assert.equal(JSON.parse(edited.res_body).method, "POST"); assert.equal(JSON.parse(edited.res_body).body, '{"x":1}');
    assert.ok((await j("/api/calls?status=2xx")).data.length >= 2);
    assert.equal((await j("/api/calls/99999")).status, 404);
    const tl = (await j("/api/timeline")).data;
    assert.ok(tl.calls.length >= 2 && Object.keys(tl.runs).length >= 1);
  });
});

describe("collections, environments and runs", () => {
  test("import a Postman collection and environment over HTTP", async () => {
    const col = await j("/api/import", { method: "POST", body: { data: JSON.parse(fs.readFileSync(example("demo-shop.postman_collection.json"), "utf8")) } });
    assert.equal(col.data.requests, 5);
    const env = await j("/api/import", { method: "POST", body: { data: JSON.parse(fs.readFileSync(example("demo-shop.postman_environment.json"), "utf8")) } });
    assert.equal(env.data.kind, "environment");
    const bad = await j("/api/import", { method: "POST", body: { data: { nope: 1 } } });
    assert.equal(bad.status, 500); assert.match(bad.data.error, /Postman collection/);
  });
  test("create, edit and delete collections, folders, requests and environments", async () => {
    const c = (await j("/api/collections", { method: "POST", body: { name: "Made here" } })).data;
    const f = (await j("/api/items", { method: "POST", body: { collectionId: c.id, kind: "folder", name: "F" } })).data;
    const r = (await j("/api/items", { method: "POST", body: { collectionId: c.id, parentId: f.id, name: "R", request: blankRequest({ url: `${api.url}/echo` }) } })).data;
    assert.equal((await j(`/api/items/${r.id}`, { method: "PATCH", body: { name: "R2" } })).data.name, "R2");
    assert.equal((await j(`/api/collections/${c.id}`, { method: "PATCH", body: { variables: [{ key: "v", value: "1", enabled: true }] } })).data.variables[0].key, "v");
    const tree = (await j("/api/collections")).data.find((x) => x.id === c.id);
    assert.equal(tree.items[0].items[0].name, "R2");
    const e = (await j("/api/environments", { method: "POST", body: { name: "Tmp" } })).data;
    await j("/api/environments/active", { method: "PUT", body: { id: e.id } });
    assert.ok((await j("/api/environments")).data.find((x) => x.id === e.id).active);
    await j(`/api/environments/${e.id}`, { method: "DELETE" });
    await j(`/api/items/${f.id}`, { method: "DELETE" });
    await j(`/api/collections/${c.id}`, { method: "DELETE" });
    assert.ok(!(await j("/api/collections")).data.some((x) => x.id === c.id));
  });
  test("run a collection in the background; the result arrives as an event", async () => {
    const c = (await j("/api/collections", { method: "POST", body: { name: "Runner" } })).data;
    for (const p of ["/status/200", "/status/500"]) await j("/api/items", { method: "POST", body: { collectionId: c.id, name: p, request: blankRequest({ url: api.url + p }) } });
    const done = nextEvent(gui.url, (e, d) => e === "rundone" && d.name === "Run: Runner");
    await sleep(100);
    assert.equal((await j(`/api/collections/${c.id}/run`, { method: "POST", body: {} })).data.started, true);
    const { data } = await done;
    assert.deepEqual([data.total, data.passed], [2, 1]);
  });
  test("sessions: listed with masked values, cookies can be cleared", async () => {
    await j("/api/send", { method: "POST", body: { request: blankRequest({ method: "POST", url: `${api.url}/login`, body: { mode: "json", raw: '{"password":"secret"}', fields: [], graphql: {} } }), session: "web" } });
    let s = (await j("/api/sessions")).data.find((x) => x.name === "web");
    assert.deepEqual(s.cookies, ["sid (127.0.0.1)"]);
    s = (await j("/api/sessions/web", { method: "PATCH", body: { clearCookies: true } })).data;
    assert.deepEqual(s.cookies, []);
  });
});

describe("reports", () => {
  test("download as HTML, or save to the project", async () => {
    const r = await fetch(`${gui.url}/api/report?since=24h`);
    assert.equal(r.status, 200); assert.match(r.headers.get("content-disposition"), /attachment; filename="jodrell-history-/);
    assert.match(await r.text(), /<script type="application\/json" id="data">/);
    const saved = (await j("/api/report", { method: "POST", body: { since: "all" } })).data;
    assert.ok(fs.existsSync(saved.file)); assert.match(saved.file, /\.jodrell\/reports\/history-.*\.html$/);
  });
});

describe("ports", () => {
  test("uses another port when the preferred one is taken", async () => {
    const blocker = http.createServer(); await new Promise((r) => blocker.listen(0, "127.0.0.1", r));
    const taken = blocker.address().port;
    const { startServer } = await import("../../src/server.mjs");
    const ui = await startServer({ ...core, port: taken, fallbackPort: true });
    assert.notEqual(new URL(ui.uiBase).port, String(taken));
    await assert.rejects(startServer({ ...core, port: taken }), /Port \d+ is in use/);
    ui.server.closeAllConnections(); ui.server.close(); blocker.close();
  });
});

describe("only jodrell's own pages and local tools can use the server", () => {
  test("DNS rebinding, other sites, other local apps and cross-site form posts are refused", async () => {
    const { makeCore, startGui } = await import("../helpers.mjs");
    const core = await makeCore();
    const gui = await startGui(core);
    const port = new URL(gui.url).port;
    const http = await import("node:http");
    // fetch won't let us set Host, so use node:http directly.
    const raw = (path, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
      const r = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d })); });
      r.on("error", reject); if (body) r.write(body); r.end();
    });
    try {
      assert.equal((await raw("/api/environments", { headers: { host: `rebind.attacker.example:${port}` } })).status, 403, "rebinding");
      assert.equal((await raw("/api/environments", { headers: { host: `127.0.0.1:${port}` } })).status, 200, "the CLI and agent, with no Origin");
      assert.equal((await raw("/api/environments", { headers: { host: `localhost:${port}`, origin: `http://localhost:${port}` } })).status, 200, "the GUI itself");
      assert.equal((await raw("/api/environments", { headers: { host: `127.0.0.1:${port}`, origin: "http://localhost:3000" } })).status, 403, "another local app's page");
      assert.equal((await raw("/api/environments", { headers: { host: `127.0.0.1:${port}`, origin: "https://evil.example" } })).status, 403, "another website");
      const form = await raw("/api/send", { method: "POST", headers: { host: `127.0.0.1:${port}`, "content-type": "text/plain;charset=UTF-8" }, body: JSON.stringify({ request: { method: "GET", url: "http://127.0.0.1:1/" } }) });
      assert.equal(form.status, 415, "simple (no-preflight) posts are refused");
      const page = await raw("/", { headers: { host: `127.0.0.1:${port}` } });
      assert.equal(page.headers["x-frame-options"], "DENY");
      assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);
      assert.equal(page.headers["x-content-type-options"], "nosniff");
    } finally { await gui.close(); }
  });
});
