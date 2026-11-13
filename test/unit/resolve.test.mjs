// Turning a saved request into what is actually sent: variables, auth and bodies.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { blankRequest, makeVars, interpolate, effectiveAuth, resolveRequest } from "../../src/collections.mjs";

describe("variables", () => {
  test("later layers win, and disabled variables are ignored", () => {
    const v = makeVars([{ key: "a", value: "col" }, { key: "b", value: "col" }], [{ key: "a", value: "env" }, { key: "c", value: "off", enabled: false }], { b: "session" });
    assert.deepEqual(v, { a: "env", b: "session" });
  });
  test("fills {{names}}, generates dynamic values, and reports what's missing", () => {
    const missing = new Set();
    const out = interpolate("{{a}}-{{ a }}-{{obj}}-{{nope}}", { a: "1", obj: { x: 1 } }, missing);
    assert.equal(out, '1-1-{"x":1}-{{nope}}');
    assert.deepEqual([...missing], ["nope"]);
    assert.match(interpolate("{{$guid}}", {}), /^[0-9a-f-]{36}$/);
    assert.match(interpolate("{{$timestamp}}", {}), /^\d{10}$/);
    assert.match(interpolate("{{$isoTimestamp}}", {}), /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(Number(interpolate("{{$randomInt}}", {})) <= 1000);
  });
});

describe("which auth applies", () => {
  test("the request's own, else the nearest folder's, else the collection's", () => {
    const col = { auth: { type: "bearer", token: "col" } };
    const folders = [{ auth: { type: "basic", username: "outer" } }, { auth: { type: "inherit" } }];
    assert.equal(effectiveAuth({ auth: { type: "apikey" } }, folders, col).type, "apikey");
    assert.equal(effectiveAuth({ auth: { type: "inherit" } }, folders, col).username, "outer");
    assert.equal(effectiveAuth({ auth: { type: "inherit" } }, [], col).token, "col");
    assert.equal(effectiveAuth({ auth: { type: "inherit" } }, [], null).type, "none");
  });
});

describe("resolving a request", () => {
  const req = (over) => blankRequest({ url: "https://api.test/x", ...over });
  test("URL variables, encoded path variables, enabled headers only, and a default scheme", () => {
    const r = resolveRequest(req({ method: "post", url: "{{base}}/orders/:id/items?x={{x}}", pathVars: [{ key: "id", value: "{{oid}}" }],
      headers: [{ key: "X-A", value: "{{x}}", enabled: true }, { key: "X-Off", value: "1", enabled: false }, { key: "", value: "ignored" }] }), { vars: { base: "https://api.test", x: "7", oid: "o 1/2" } });
    assert.equal(r.method, "POST");
    assert.equal(r.url, "https://api.test/orders/o%201%2F2/items?x=7");
    assert.deepEqual(r.headers, { "X-A": "7" });
    assert.equal(resolveRequest(req({ url: "api.test/y" })).url, "https://api.test/y");
    assert.equal(resolveRequest(req({ url: "http://host:8080/:id", pathVars: [{ key: "id", value: "5" }] })).url, "http://host:8080/5", "a port isn't a path variable");
  });
  test("bearer, basic and API key auth, without overriding a header you set yourself", () => {
    assert.equal(resolveRequest(req({}), { vars: { t: "T" }, auth: { type: "bearer", token: "{{t}}" } }).headers.Authorization, "Bearer T");
    assert.equal(resolveRequest(req({}), { auth: { type: "basic", username: "u", password: "p" } }).headers.Authorization, "Basic " + Buffer.from("u:p").toString("base64"));
    assert.equal(resolveRequest(req({}), { auth: { type: "apikey", key: "X-Key", value: "K", in: "header" } }).headers["X-Key"], "K");
    assert.equal(resolveRequest(req({ url: "https://api.test/x?a=1" }), { auth: { type: "apikey", key: "key", value: "K", in: "query" } }).url, "https://api.test/x?a=1&key=K");
    const own = resolveRequest(req({ headers: [{ key: "authorization", value: "Custom 1", enabled: true }] }), { auth: { type: "bearer", token: "T" } });
    assert.equal(own.headers.authorization, "Custom 1"); assert.equal(own.headers.Authorization, undefined);
  });
  test("each body type gets the right content and Content-Type", () => {
    const body = (b, headers = []) => resolveRequest(req({ method: "POST", body: { mode: "none", raw: "", fields: [], graphql: { query: "", variables: "" }, ...b }, headers }), { vars: { v: "V" } });
    let r = body({ mode: "json", raw: '{"a":"{{v}}"}' }); assert.equal(r.body, '{"a":"V"}'); assert.equal(r.headers["Content-Type"], "application/json");
    r = body({ mode: "xml", raw: "<a/>" }); assert.equal(r.headers["Content-Type"], "application/xml");
    r = body({ mode: "text", raw: "hi" }); assert.equal(r.headers["Content-Type"], "text/plain");
    r = body({ mode: "urlencoded", fields: [{ key: "a", value: "{{v}}", enabled: true }, { key: "b", value: "x", enabled: false }] }); assert.equal(r.body.toString(), "a=V");
    r = body({ mode: "formdata", fields: [{ key: "a", value: "1", enabled: true }, { key: "f", type: "file", src: "/x" }] }); assert.deepEqual([...r.body.keys()], ["a"]); assert.equal(r.headers["Content-Type"], undefined, "fetch sets the multipart boundary");
    r = body({ mode: "graphql", graphql: { query: "{ me }", variables: '{"id":"{{v}}"}' } }); assert.deepEqual(JSON.parse(r.body), { query: "{ me }", variables: { id: "V" } });
    r = body({ mode: "graphql", graphql: { query: "{ me }", variables: "not json" } }); assert.equal(JSON.parse(r.body).variables, undefined);
    r = body({ mode: "json", raw: "{}" }, [{ key: "Content-Type", value: "application/vnd.api+json", enabled: true }]); assert.equal(r.headers["Content-Type"], "application/vnd.api+json");
    assert.equal(body({ mode: "none" }).body, undefined);
  });
  test("lists unresolved variables instead of guessing", () => {
    assert.deepEqual(resolveRequest(req({ url: "{{base}}/x", headers: [{ key: "A", value: "{{tok}}", enabled: true }] })).unresolved.sort(), ["base", "tok"]);
  });
});
