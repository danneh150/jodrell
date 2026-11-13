// Every agent tool, through a real MCP client.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fakeApi, makeCore, startGui, example, oas } from "../helpers.mjs";

let api, core, gui, client;
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { ...r, text: r.content?.[0]?.text || "" };
};
before(async () => {
  api = await fakeApi();
  core = await makeCore({ "openapi.json": oas("Fake", { "/users/{id}": { get: { operationId: "getUser", summary: "Get a user", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { 200: { description: "ok" } } } } }) });
  core.specs.list()[0].baseUrl = api.url;
  gui = await startGui(core);
  client = new Client({ name: "test-agent", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${gui.url}/mcp`)));
});
after(async () => { await client.close(); await gui.close(); await api.close(); });

describe("the tools on offer", () => {
  test("every tool is there, with the in-reply view on the right ones", async () => {
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    for (const n of ["send_request", "call_operation", "run_request", "run_collection", "show_history", "show_request", "export_report", "open_gui", "import_collection", "list_collections", "describe_request", "save_request", "list_environments", "use_environment", "set_variable", "set_session", "list_sessions", "get_history", "get_call", "start_run", "list_operations", "describe_operation", "list_specs", "reload_specs", "get_call_view"]) assert.ok(names.includes(n), n);
    const ui = tools.filter((t) => t._meta?.ui?.resourceUri).map((t) => t.name);
    for (const n of ["send_request", "call_operation", "run_request", "run_collection", "show_history", "show_request"]) assert.ok(ui.includes(n), `${n} shows a view`);
    assert.deepEqual(tools.find((t) => t.name === "get_call_view")._meta.ui.visibility, ["app"], "the detail loader is for the view only");
    const res = await client.readResource({ uri: "ui://jodrell/view.html" });
    assert.equal(res.contents[0].mimeType, "text/html;profile=mcp-app");
  });
});

describe("making requests", () => {
  test("send_request: text for the model, a view for the user", async () => {
    const r = await call("send_request", { method: "GET", url: `${api.url}/users/5`, note: "checking a user" });
    assert.match(r.text, /HTTP 200 in \d+ ms/); assert.match(r.text, /"name": "Ada"/); assert.match(r.text, /#call-\d+/);
    assert.equal(r.structuredContent.view, "call"); assert.equal(r.structuredContent.call.note, "checking a user");
    assert.ok(r.structuredContent.guiUrl.startsWith("http://localhost:"));
  });
  test("relative URLs use the first spec's base URL", async () => {
    const r = await call("send_request", { url: "/users/rel" });
    assert.match(r.text, /\/users\/rel/); assert.match(r.text, /HTTP 200/);
  });
  test("call_operation and describe_operation; unknown operations get suggestions", async () => {
    assert.match((await call("describe_operation", { operationId: "getUser" })).text, /id \(path, required\)/);
    const r = await call("call_operation", { operationId: "getUser", pathParams: { id: "7" } });
    assert.match(r.text, /GET .*\/users\/7/); assert.match(r.text, /Response matches the spec/);
    const bad = await call("call_operation", { operationId: "getUsr" });
    assert.equal(bad.isError, true); assert.match(bad.text, /Did you mean: getUser/);
    assert.match((await call("list_operations")).text, /getUser {2}GET \/users\/\{id\}/);
    assert.match((await call("list_specs")).text, /● Fake 1: 1 operations/);
    assert.match((await call("reload_specs")).text, /Reloaded/);
  });
  test("sessions: log in with a capture, the token is masked and tied to the host", async () => {
    const login = await call("send_request", { method: "POST", url: `${api.url}/login`, body: { password: "secret" }, session: "agent", capture: { "header:Authorization": "Bearer {{body.access_token}}" } });
    assert.match(login.text, /Saved to session: header:Authorization = Bearer ••••.* \(sent to 127\.0\.0\.1 only\)/);
    assert.ok(!login.text.includes("Bearer tok-"));
    assert.match((await call("send_request", { url: `${api.url}/me`, session: "agent" })).text, /HTTP 200/);
    assert.match((await call("list_sessions")).text, /agent: headers \{Authorization: Bearer ••••.*\(127\.0\.0\.1 only\)\}/);
    await call("set_session", { name: "manual", headers: { "X-Key": "abcdefghijk123" }, host: "api.example.com" });
    assert.match((await call("list_sessions")).text, /manual: headers \{X-Key: abc••••k123 \(api\.example\.com only\)\}/);
  });
});

describe("collections and environments", () => {
  test("import, list, describe, run a request and a whole collection", async () => {
    await api.close(); api = await fakeApi(); // fresh token
    const imp = await call("import_collection", { path: example("demo-shop.postman_collection.json") });
    assert.match(imp.text, /Imported "Demo shop \(Postman\)".*5 requests in 1 folders/);
    assert.match((await call("import_collection", { path: example("demo-shop.postman_environment.json") })).text, /Imported environment "Demo local"/);
    assert.match((await call("use_environment", { name: "demo local" })).text, /"Demo local" is now active/);
    // point the collection at the fake API
    const col = core.collections.list().find((c) => c.name === "Demo shop (Postman)");
    core.collections.updateCollection(col.id, { variables: [{ key: "baseUrl", value: api.url, enabled: true }] });
    assert.match((await call("list_collections")).text, /📁 Orders \(folder #\d+\)/);
    assert.match((await call("describe_request", { request: "Log in" })).text, /After response, saves: token ← body\.access_token/);
    const one = await call("run_request", { request: "Log in" });
    assert.match(one.text, /Saved request: Demo shop \(Postman\) \/ Log in/); assert.match(one.text, /Expected status 200: passed/);
    const amb = await call("run_request", { request: "order" });
    assert.equal(amb.isError, true); assert.match(amb.text, /matches 3 requests/);
    const run = await call("run_collection", { collection: "Demo shop (Postman)", folder: "Orders" });
    assert.match(run.text, /Run: Demo shop \(Postman\) \/ Orders: \d of 3 passed/);
    assert.equal(run.structuredContent.view, "run"); assert.equal(run.structuredContent.summary.total, 3);
  });
  test("save a request the agent made, and set variables", async () => {
    const sent = await call("send_request", { url: `${api.url}/users/1` });
    const id = Number(sent.text.match(/Call #(\d+)/)[1]);
    assert.match((await call("save_request", { collection: "Agent finds", folder: "Users", name: "User 1", fromCall: id })).text, /Saved as #\d+ Agent finds \/ Users \/ User 1/);
    assert.match((await call("save_request", { collection: "Agent finds", name: "Plain", url: `${api.url}/echo`, method: "POST", body: { a: 1 } })).text, /Saved as/);
    assert.match((await call("set_variable", { name: "apiToken", value: "abcdefghijklmnop" })).text, /environment "Demo local"/);
    const envs = (await call("list_environments")).text;
    assert.match(envs, /● Demo local/); assert.match(envs, /apiToken=abc••••mnop/); assert.ok(!envs.includes("abcdefghijklmnop"));
  });
});

describe("history, views and reports", () => {
  test("get_history, get_call with paging, show_history, show_request and the view's loader", async () => {
    const big = await call("send_request", { url: `${api.url}/big?kb=20` });
    const id = Number(big.text.match(/Call #(\d+)/)[1]);
    assert.match(big.text, /truncated \(\d+ characters\)\. Use get_call with offset/);
    const page2 = await call("get_call", { callId: id, offset: 8000 });
    assert.match(page2.text, /Response body \(characters 8000–16000 of/);
    assert.match((await call("get_history", { limit: 3 })).text, /^#\d+ GET 200/m);
    assert.match((await call("get_history", { status: "5xx" })).text, /No calls match|500/);
    const hist = await call("show_history", { since: "1h" });
    assert.equal(hist.structuredContent.view, "timeline"); assert.ok(hist.structuredContent.calls.length > 5);
    assert.equal((await call("show_request", { callId: id })).structuredContent.view, "call");
    assert.equal((await call("get_call_view", { callId: id })).structuredContent.call.id, id);
    assert.equal((await call("show_request", { callId: 999999 })).isError, true);
  });
  test("export_report writes the file and says where", async () => {
    const r = await call("export_report", { since: "all" });
    const file = r.text.match(/Saved the report to (\S+)/)[1];
    assert.ok(fs.existsSync(file));
  });
  test("start_run groups the following calls", async () => {
    await call("start_run", { name: "checkout flow" });
    await call("send_request", { url: `${api.url}/echo/a` });
    const runs = core.store.runs();
    assert.equal(runs[0].name, "checkout flow"); assert.equal(runs[0].calls, 1);
  });
});
