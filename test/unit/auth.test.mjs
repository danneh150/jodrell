// Auth profiles: signing in automatically, refreshing, and showing the state.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { fakeApi, makeCore, oas, startGui } from "../helpers.mjs";
import { readDotEnv } from "../../src/auth.mjs";
import { redactBody } from "../../src/checks.mjs";

let api;
before(async () => { api = await fakeApi(); });
after(async () => { await api.close(); });

const ok = { 200: { description: "ok" } };
const shopSpec = (extra = {}) => oas("Shop", {
  "/login": { post: { operationId: "login", security: [], responses: ok } },
  "/me": { get: { operationId: "me", responses: ok } },
  "/echo": { get: { operationId: "publicEcho", security: [], responses: ok } },
  "/echo/private": { get: { operationId: "privateEcho", responses: ok } },
}, { servers: [{ url: api.url }], components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } }, security: [{ bearer: [] }], ...extra });

// Allow every profile, as you would in the GUI or with npx jodrell trust.
const allowAll = (core) => { for (const n of core.auth.names()) if (!core.auth.status(n).problems) core.auth.trust(n); return core; };
// A project with the shop spec and the given auth profiles, allowed.
const project = async (auth, files = {}) => allowAll(await makeCore({
  "openapi.json": shopSpec(),
  "jodrell.config.json": { specs: ["openapi.json"], auth },
  ...files,
}));
const loginProfile = { shop: { login: { op: "login", body: { password: "{{env.SHOP_PASS}}" } } } };
const logins = () => api.requests.filter((r) => r.path === "/login").length;

describe("signing in automatically", () => {
  test("signs in on the first request, then reuses the token", async () => {
    const { runner, store, auth } = await project(loginProfile, { ".env": "SHOP_PASS=secret\n" });
    const before = logins();
    const op = runner.fromOperation("me");
    const c = await runner.send({ ...op });
    assert.equal(c.status, 200);
    assert.equal(logins() - before, 1);
    assert.match(c.auth.note, /signed in for "shop"/);
    const again = await runner.send({ ...runner.fromOperation("me") });
    assert.equal(again.status, 200);
    assert.equal(logins() - before, 1, "no second sign-in while the token is valid");
    assert.equal(auth.status("shop").state, "valid");
    assert.ok(auth.status("shop").expiresAt, "expires_in is read from the response");

    // The sign-in call is in the history, with the password and token masked.
    const login = store.getCall(auth.status("shop").loginCallId);
    assert.match(login.note, /signed in for "shop"/);
    assert.ok(!login.req_body.includes("secret"), "the password isn't stored");
    assert.ok(!login.res_body.includes(api.token), "the token isn't stored");
    assert.ok(!JSON.stringify(store.getCall(c.id)).includes(api.token));
  });

  test("signs in again when the token has expired", async () => {
    const { runner, store, auth } = await project(loginProfile, { ".env": "SHOP_PASS=secret" });
    await runner.send({ ...runner.fromOperation("me") });
    store.saveAuthState({ ...store.getAuthState("shop"), expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(auth.status("shop").state, "expired");
    const before = logins();
    const c = await runner.send({ ...runner.fromOperation("me") });
    assert.equal(c.status, 200);
    assert.equal(logins() - before, 1);
  });

  test("on a 401, signs in again and sends the request once more", async () => {
    const { runner, auth } = await project(loginProfile, { ".env": "SHOP_PASS=secret" });
    await runner.send({ ...runner.fromOperation("me") });
    api.rotate(); // the API forgets the old token
    const c = await runner.send({ ...runner.fromOperation("me") });
    assert.equal(c.status, 200);
    assert.ok(c.retriedFrom, "points back to the rejected call");
    assert.match(c.note, /sent again after jodrell signed in/);
    assert.equal(auth.status("shop").state, "valid");
  });

  test("explains what's wrong instead of sending, and the GUI state says so", async () => {
    const { runner, auth } = await project(loginProfile);
    delete process.env.SHOP_PASS;
    let c = await runner.send({ ...runner.fromOperation("me") });
    assert.match(c.error, /^Not sent: couldn't sign in for "shop"\. SHOP_PASS isn't set\. Add it to \.env/);
    assert.equal(auth.status("shop").state, "failed");
    assert.equal(auth.status("shop").needsAction, true);

    const bad = await project(loginProfile, { ".env": "SHOP_PASS=wrong" });
    c = await bad.runner.send({ ...bad.runner.fromOperation("me") });
    assert.match(c.error, /Signing in failed: HTTP 401 \(Wrong password\)/);
  });

  test("leaves explicit auth, auth: false and public operations alone", async () => {
    const { runner } = await project(loginProfile, { ".env": "SHOP_PASS=secret" });
    const echo = (c) => JSON.parse(c.res_body);
    let c = await runner.send({ method: "GET", url: `${api.url}/echo/private`, headers: { Authorization: "Bearer mine" } });
    assert.equal(echo(c).headers.authorization, "Bearer mine");
    c = await runner.send({ method: "GET", url: `${api.url}/echo/private`, auth: false });
    assert.equal(echo(c).headers.authorization, undefined);
    c = await runner.send({ ...runner.fromOperation("publicEcho") });
    assert.equal(echo(c).headers.authorization, undefined, "security: [] means no auth");
    c = await runner.send({ method: "GET", url: `${api.url}/echo/private` });
    assert.equal(echo(c).headers.authorization, `Bearer ${api.token}`, "raw URLs under the spec's base URL get the token too");
    c = await runner.send({ method: "GET", url: "http://localhost:1/elsewhere", auth: true }).catch((e) => e);
    assert.ok(!JSON.stringify(c).includes(api.token), "other hosts never get it");
  });

  test("signing in by hand (the GUI's login request) updates the token", async () => {
    const { runner, auth } = await project(loginProfile, { ".env": "SHOP_PASS=secret" });
    const draft = auth.loginDraft("shop");
    assert.equal(draft.method, "POST");
    assert.match(draft.body.raw, /\{\{env\.SHOP_PASS\}\}/, "secrets stay as variables in the draft");
    const c = await runner.sendRequest(draft, {});
    assert.equal(c.status, 200);
    assert.equal(c.auth.ok, true);
    assert.equal(auth.status("shop").state, "valid");
  });

  test("replay uses the current token, not the one in the original request", async () => {
    const { runner } = await project(loginProfile, { ".env": "SHOP_PASS=secret" });
    const first = await runner.send({ ...runner.fromOperation("me") });
    api.rotate();
    const r = await runner.replay(first.id);
    assert.equal(r.status, 200);
  });
});

describe("secrets from .env stay in sign-in requests", () => {
  test("ordinary requests can't use {{env.NAME}}, from the agent or the GUI", async () => {
    const { runner, store } = await project(loginProfile, { ".env": "SHOP_PASS=secret\nOTHER=topsecretvalue" });
    process.env.JODRELL_TEST_SECRET = "process-env-secret";
    try {
      await assert.rejects(runner.send({ method: "GET", url: `${api.url}/echo?k={{env.JODRELL_TEST_SECRET}}` }), /unresolved variables/);
      const c = await runner.send({ method: "POST", url: `${api.url}/echo`, body: { k: "{{env.OTHER}}" }, auth: false });
      assert.equal(JSON.parse(JSON.parse(c.res_body).body).k, "{{env.OTHER}}", "left as written, not filled");
      await assert.rejects(runner.sendRequest({ method: "POST", url: `${api.url}/echo`, body: { mode: "text", raw: "{{env.OTHER}}" } }, {}), /can only be used in an auth profile's sign-in request/);
      assert.ok(!JSON.stringify(store.listCalls({ limit: 100 })).includes("process-env-secret"));
    } finally { delete process.env.JODRELL_TEST_SECRET; }
  });

  test("filled-in secrets are masked in history, whatever the field is called", async () => {
    const { runner, store, auth } = await project({ shop: { login: { url: "/login", body: { password: "{{env.SHOP_PASS}}", note: "pw={{env.SHOP_PASS}}" } } } }, { ".env": "SHOP_PASS=secret" });
    await runner.send({ ...runner.fromOperation("me") });
    const login = store.getCall(auth.status("shop").loginCallId);
    assert.ok(!login.req_body.includes("secret"), login.req_body);
  });
});

describe("sign-in responses", () => {
  test("the token is masked in history whatever it's called", async () => {
    // /echo replies with the path, so the "token" is in a field called "path".
    const { runner, store, auth } = await project({ shop: { login: { url: "/echo/handle-abcdef123456" }, token: "body.path" } });
    await runner.send({ ...runner.fromOperation("me") });
    const login = store.getCall(auth.status("shop").loginCallId);
    assert.ok(auth.status("shop").loginCallId, "it signed in");
    assert.ok(!login.res_body.includes("handle-abcdef123456"), login.res_body);
  });
});

describe("other ways to sign in", () => {
  test("OAuth 2 client credentials, with the token URL from the spec", async () => {
    const spec = shopSpec({ components: { securitySchemes: { oauth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: `${api.url}/oauth/token`, scopes: {} } } } } } });
    const { runner, auth } = allowAll(await makeCore({ "openapi.json": spec, "jodrell.config.json": { specs: ["openapi.json"], auth: { shop: { clientCredentials: { clientId: "{{env.CID}}", clientSecret: "{{env.CSECRET}}" } } } }, ".env": "CID=cid\nCSECRET=csecret" }));
    const c = await runner.send({ ...runner.fromOperation("me") });
    assert.equal(c.status, 200);
    assert.equal(auth.status("shop").how, "OAuth 2 client credentials");
  });

  test("an API key in the query string, as the spec says, masked in the history", async () => {
    const spec = oas("Keyed", { "/keyed": { get: { operationId: "keyed", responses: ok } } }, { servers: [{ url: api.url }], components: { securitySchemes: { k: { type: "apiKey", in: "query", name: "key" } } } });
    const { runner, store } = allowAll(await makeCore({ "openapi.json": spec, "jodrell.config.json": { specs: ["openapi.json"], auth: { keyed: { command: `echo ${api.token}` } } } }));
    const c = await runner.send({ ...runner.fromOperation("keyed") });
    assert.equal(c.status, 200);
    assert.ok(!store.getCall(c.id).url.includes(api.token));
    assert.match(store.getCall(c.id).url, /key=.*%E2%80%A2|key=.*••••/);
  });

  test("session cookies from a sign-in response", async () => {
    const { runner, auth } = await project({ shop: { login: { url: "/cookie-login" } } });
    const c = await runner.send({ ...runner.fromOperation("me") });
    assert.equal(c.status, 200);
    assert.equal(auth.status("shop").placement, "cookies from the sign-in response");
  });

  test("a fixed token from the environment", async () => {
    const { runner } = await project({ shop: { value: "{{env.SHOP_TOKEN}}" } }, { ".env": `SHOP_TOKEN=${api.token}` });
    assert.equal((await runner.send({ ...runner.fromOperation("me") })).status, 200);
  });

  test("profiles that can't work say why", async () => {
    const { auth } = await makeCore({ "a.json": shopSpec(), "b.json": oas("Other", {}, { servers: [{ url: "http://other.test" }] }), "jodrell.config.json": { specs: ["a.json", "b.json"], auth: { x: { value: "t" }, y: { login: { op: "nope" } } } } });
    assert.equal(auth.status("x").state, "misconfigured");
    assert.match(auth.status("x").message, /add "spec"/);
    assert.match(auth.status("y").message, /"nope" isn't in any spec/);
  });

  test("a missing secret shows as needing you before any request is sent", async () => {
    const { auth } = await project({ shop: { value: "{{env.JODRELL_TEST_UNSET}}" } });
    const st = auth.status("shop");
    assert.equal(st.state, "failed"); assert.equal(st.needsAction, true);
    assert.match(st.message, /^JODRELL_TEST_UNSET isn't set/);
  });
});

describe("a project's sign-in settings need your approval", () => {
  test("nothing is sent or run until you allow it, and changes need allowing again", async () => {
    const core = await makeCore({ "openapi.json": shopSpec(), "jodrell.config.json": { specs: ["openapi.json"], auth: loginProfile }, ".env": "SHOP_PASS=secret" });
    const before = logins();
    let st = core.auth.status("shop");
    assert.equal(st.state, "untrusted"); assert.equal(st.needsAction, true);
    assert.match(st.message, /sends a sign-in request to POST http:\/\/127\.0\.0\.1:\d+\/login, using SHOP_PASS/);
    const c = await core.runner.send({ ...core.runner.fromOperation("me") });
    assert.match(c.error, /hasn't been allowed yet/);
    assert.equal(logins(), before, "no sign-in request was sent");
    core.auth.trust("shop");
    assert.equal((await core.runner.send({ ...core.runner.fromOperation("me") })).status, 200);
    // The same project with a different command: asked again.
    const fsx = await import("node:fs");
    fsx.writeFileSync(`${core.root}/jodrell.config.json`, JSON.stringify({ specs: ["openapi.json"], auth: { shop: { ...loginProfile.shop, hosts: ["127.0.0.1"] } } }));
    assert.equal(core.auth.status("shop").state, "untrusted");
  });

  test("a command never runs before it's allowed, and values can't add shell syntax", async () => {
    const fsx = await import("node:fs");
    const core = await makeCore({ "openapi.json": shopSpec(), "jodrell.config.json": { specs: ["openapi.json"], auth: { shop: { command: "echo {{env.JT_VAL}} > out.txt" } } }, ".env": "JT_VAL=x; touch pwned" });
    await core.runner.send({ ...core.runner.fromOperation("me") });
    assert.ok(!fsx.existsSync(`${core.root}/out.txt`), "not run before approval");
    core.auth.trust("shop");
    await core.runner.send({ ...core.runner.fromOperation("me") });
    assert.equal(fsx.readFileSync(`${core.root}/out.txt`, "utf8").trim(), "x; touch pwned");
    assert.ok(!fsx.existsSync(`${core.root}/pwned`), "the value stayed one argument");
  });
});

describe("tokens only go where they belong", () => {
  test("lookalike hosts and ports don't match the spec's base URL", async () => {
    const { runner } = await project({ shop: { value: "TOKEN-123456789" } });
    const echo = (c) => JSON.parse(c.res_body);
    const port = new URL(api.url).port;
    for (const url of [`http://127.0.0.1:${port}0/x`, `http://localhost:${port}/echo`]) {
      const c = await runner.send({ method: "GET", url, auth: true });
      assert.ok(!Object.keys(c.req_headers || {}).some((k) => /^authorization$/i.test(k)), `no token for ${url}`);
    }
    const ok = await runner.send({ method: "GET", url: `${api.url}/echo/x` });
    assert.equal(echo(ok).headers.authorization, "Bearer TOKEN-123456789");
  });
  test("bare top-level domains aren't accepted as hosts", async () => {
    const { auth } = await project({ x: { value: "t", hosts: ["com"] } });
    assert.match(auth.status("x").message, /"com" would match every site/);
  });
  test("a cookie can't pollute objects, and can't be planted for other hosts", async () => {
    const http = await import("node:http");
    const srv = http.createServer((req, res) => { res.writeHead(200, { "set-cookie": ["command=id; Domain=__proto__", "force=1; Domain=constructor", "fixed=1; Domain=127.0.0.2", "ok=1"] }); res.end("{}"); });
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    try {
      const { runner, store } = await makeCore();
      await runner.send({ method: "GET", url: `http://127.0.0.1:${srv.address().port}/`, session: "s" });
      assert.equal(({}).command, undefined); assert.equal(({}).force, undefined);
      const jar = store.getSession("s").cookies;
      assert.deepEqual(Object.keys(jar), ["127.0.0.1"]);
    } finally { srv.close(); }
  });
});

describe("in the GUI", () => {
  test("lists profiles, signs in on request, signs out and gives the login request", async () => {
    const core = await project(loginProfile, { ".env": "SHOP_PASS=secret" });
    const gui = await startGui(core);
    try {
      const j = (p, o = {}) => fetch(gui.url + p, { ...o, headers: { "content-type": "application/json" } }).then((r) => r.json());
      let list = await j("/api/auth");
      assert.equal(list[0].name, "shop"); assert.equal(list[0].state, "none");
      assert.equal(list[0].login.opId, "login");
      const r = await j("/api/auth/shop/signin", { method: "POST" });
      assert.equal(r.ok, true); assert.equal(r.state, "valid");
      assert.ok(!JSON.stringify(r).includes(api.token), "the token is masked");
      assert.equal((await j("/api/auth/shop/request")).method, "POST");
      await j("/api/auth/shop", { method: "DELETE" });
      list = await j("/api/auth");
      assert.equal(list[0].state, "none");
    } finally { await gui.close(); }
  });
});

describe("helpers", () => {
  test(".env files", async () => {
    const { root } = await makeCore({ ".env": `A=1\nexport B="two words"\nC='x#y'\nD=3 # comment\n# E=no\n` });
    assert.deepEqual(readDotEnv(root), { A: "1", B: "two words", C: "x#y", D: "3" });
  });
  test("sign-in bodies are masked", () => {
    assert.equal(JSON.parse(redactBody('{"username":"ada","password":"hunter2hunter2"}')).username, "ada");
    assert.ok(!redactBody('{"password":"hunter2hunter2"}').includes("hunter2hunter2"));
    assert.ok(!redactBody("grant_type=client_credentials&client_secret=abcdefghijk").includes("abcdefghijk"));
    assert.equal(redactBody("not a form"), "not a form");
  });
});
