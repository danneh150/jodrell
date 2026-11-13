// Secret masking and response validation against OpenAPI schemas.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mask, redactHeaders, isSecretHeader, validateResponse, clearValidationCache } from "../../src/checks.mjs";

describe("masking secrets", () => {
  test("short values are hidden entirely, long ones keep a hint", () => {
    assert.equal(mask("abc"), "••••");
    assert.equal(mask(""), "••••");
    const m = mask("Bearer abcdefghijkl1234");
    assert.ok(m.startsWith("Bearer ") && m.endsWith("1234") && !m.includes("abcdefghijkl"));
  });
  test("secret-looking headers are masked, others are kept", () => {
    const h = redactHeaders({ Authorization: "Bearer abcdefghijkl1234", Cookie: "sid=abcdefghijkl", "set-cookie": ["a=1234567890123", "b=1234567890456"], "X-API-Key": "k-1234567890", "x-auth-token": "zzzzzzzzzzzz9999", "X-Session-Id": "s-123456789", "content-type": "application/json", Accept: "*/*" });
    assert.equal(h["content-type"], "application/json");
    assert.equal(h.Accept, "*/*");
    for (const k of ["Authorization", "Cookie", "X-API-Key", "x-auth-token", "X-Session-Id"]) assert.ok(String(h[k]).includes("••••"), k);
    assert.ok(h["set-cookie"].every((v) => v.includes("••••")));
  });
  test("cookies keep their names and attributes but no part of their values", () => {
    const h = redactHeaders({ "set-cookie": ["sid=tok-abcdef123456; HttpOnly; Path=/; Max-Age=3600"], cookie: "sid=tok-abcdef123456; theme=dark" });
    assert.deepEqual(h["set-cookie"], ["sid=••••; HttpOnly; Path=/; Max-Age=3600"]);
    assert.equal(h.cookie, "sid=••••; theme=••••");
  });
  test("recognises secret header names", () => {
    for (const n of ["authorization", "Proxy-Authorization", "cookie", "x-api-key", "api-key", "X-CSRF-Token", "client_secret", "password"]) assert.ok(isSecretHeader(n), n);
    for (const n of ["content-type", "accept", "user-agent", "x-request-id"]) assert.ok(!isSecretHeader(n), n);
  });
});

const op = (responses) => ({ id: "op" + Math.random(), spec: "s", responses });
const jsonResp = (schema) => ({ description: "ok", content: { "application/json": { schema } } });

describe("validating responses", () => {
  test("no operation means no check (e.g. a third-party API)", () => {
    assert.equal(validateResponse(null, 200, "application/json", "{}"), null);
  });
  test("an undocumented status is a mismatch; ranges and default are honoured", () => {
    assert.equal(validateResponse(op({ 200: jsonResp({ type: "object" }) }), 418, "application/json", "{}").valid, false);
    assert.equal(validateResponse(op({ "4XX": jsonResp({ type: "object" }) }), 404, "application/json", "{}").valid, true);
    assert.equal(validateResponse(op({ default: jsonResp({ type: "object" }) }), 503, "application/json", "{}").valid, true);
  });
  test("no documented body, or a non-JSON body, is handled gracefully", () => {
    const r = validateResponse(op({ 204: { description: "none" } }), 204, "", "");
    assert.equal(r.valid, true); assert.match(r.note, /No response body/);
    const html = validateResponse(op({ 200: jsonResp({ type: "object" }) }), 200, "text/html", "<p>Bad gateway</p>");
    assert.equal(html.valid, false, "an HTML page where the spec promises JSON is a mismatch");
    assert.match(html.errors[0].message, /Returned text\/html, but the spec documents application\/json/);
    assert.equal(validateResponse(op({ 200: { description: "ok", content: { "text/csv": { schema: { type: "string" } } } } }), 200, "text/csv", "a,b").checked, false, "documented non-JSON isn't schema-checked");
    assert.equal(validateResponse(op({ 200: jsonResp({ type: "object" }) }), 200, "application/json", "{nope").valid, false);
  });
  test("reports the exact field, with readable messages", () => {
    const schema = { type: "object", required: ["id", "total"], additionalProperties: false, properties: { id: { type: "string" }, total: { type: "number" }, status: { type: "string", enum: ["open", "shipped"] }, email: { type: "string", format: "email" } } };
    const r = validateResponse(op({ 200: jsonResp(schema) }), 200, "application/json; charset=utf-8", JSON.stringify({ id: 1, status: "lost", email: "nope", extra: true }));
    assert.equal(r.valid, false);
    const byPath = Object.fromEntries(r.errors.map((e) => [e.path, e.message]));
    assert.match(byPath["/extra"], /not in the spec/);
    assert.match(byPath["/id"], /string/);
    assert.match(byPath["/status"], /open, shipped/);
    assert.match(byPath["/email"], /format/);
    assert.ok(r.errors.some((e) => /missing required property "total"/.test(e.message)));
  });
  test("understands OpenAPI 3.0 nullable", () => {
    const o = op({ 200: jsonResp({ type: "object", properties: { note: { type: "string", nullable: true }, kind: { enum: ["a", "b"], nullable: true }, ref: { allOf: [{ type: "object" }], nullable: true } } }) });
    assert.equal(validateResponse(o, 200, "application/json", JSON.stringify({ note: null, kind: null, ref: null })).valid, true);
    assert.equal(validateResponse(o, 200, "application/json", JSON.stringify({ note: 5 })).valid, false);
  });
  test("compiled schemas are cached, and the cache can be cleared", () => {
    const o = op({ 200: jsonResp({ type: "object", required: ["a"] }) });
    assert.equal(validateResponse(o, 200, "application/json", "{}").valid, false);
    o.responses[200] = jsonResp({ type: "object" });
    assert.equal(validateResponse(o, 200, "application/json", "{}").valid, false, "still the cached schema");
    clearValidationCache();
    assert.equal(validateResponse(o, 200, "application/json", "{}").valid, true);
  });
});
