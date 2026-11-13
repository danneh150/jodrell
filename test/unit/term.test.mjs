// The coloured one-line summaries in the terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { line, detail, size } from "../../src/term.mjs";

const call = { id: 7, ts: "2026-11-12T10:00:00Z", source: "agent", method: "POST", url: "https://a.test/orders?x=1", op_id: "createOrder", status: 201, duration_ms: 42, res_size: 2048, validation: { checked: true, valid: false, errors: [{ path: "/id", message: "must be string" }] }, req_headers: { a: "1" }, res_headers: {}, res_body: '{"id":1}' };

test("one line: number, method, status, path, operation, timing, size and schema result", () => {
  const l = line(call).replace(/\x1b\[[0-9;]*m/g, "");
  for (const bit of ["#7", "POST", "201", "/orders?x=1", "createOrder", "42 ms", "2.0 kB", "✗ schema (1)"]) assert.ok(l.includes(bit), bit);
  assert.match(line({ ...call, error: "Connection refused", status: null }).replace(/\x1b\[[0-9;]*m/g, ""), /ERR .* Connection refused/);
});
test("detail shows headers, the pretty body and schema problems", () => {
  const d = detail(call).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(d, /Request[\s\S]*a: 1[\s\S]*Response[\s\S]*"id": 1[\s\S]*Schema mismatches[\s\S]*\/id must be string/);
});
test("sizes are human-readable", () => {
  assert.deepEqual([size(10), size(2048), size(3 * 1024 * 1024), size(null)], ["10 B", "2.0 kB", "3.0 MB", ""]);
});
