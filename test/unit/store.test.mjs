// The project database: runs, calls, sessions, and upgrading older databases.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../src/store.mjs";
import { tmpDb } from "../helpers.mjs";

const call = (over = {}) => ({ ts: new Date().toISOString(), source: "agent", method: "GET", url: "https://a.test/x", status: 200, duration_ms: 5, req_headers: { a: "1" }, res_headers: { b: "2" }, res_body: "{}", ...over });

describe("calls and runs", () => {
  test("stores a call and reads it back with its JSON fields", () => {
    const s = new Store(tmpDb());
    const run = s.createRun("claude-code", "agent");
    const c = s.addCall(call({ run_id: run.id, validation: { checked: true, valid: false, errors: [] }, item_id: 3, item_name: "C / R", expect_status: 201 }));
    const back = s.getCall(c.id);
    assert.deepEqual(back.req_headers, { a: "1" });
    assert.equal(back.validation.valid, false);
    assert.deepEqual([back.item_id, back.item_name, back.expect_status, back.truncated], [3, "C / R", 201, false]);
    assert.equal(s.runs()[0].calls, 1);
  });
  test("lists newest first, with filters for status, operation, run and text", () => {
    const s = new Store(tmpDb());
    const r = s.createRun("x");
    s.addCall(call({ status: 200, op_id: "list" }));
    s.addCall(call({ status: 404, note: "find the missing one" }));
    s.addCall(call({ status: 500, run_id: r.id }));
    s.addCall(call({ status: null, error: "Connection refused" }));
    s.addCall(call({ status: 201, item_name: "Shop / Create order" }));
    assert.equal(s.listCalls()[0].status, 201);
    assert.equal(s.listCalls({ status: "2xx" }).length, 2);
    assert.equal(s.listCalls({ status: "error" }).length, 3);
    assert.equal(s.listCalls({ status: "404" }).length, 1);
    assert.equal(s.listCalls({ op: "list" }).length, 1);
    assert.equal(s.listCalls({ run: r.id }).length, 1);
    assert.equal(s.listCalls({ q: "missing" }).length, 1);
    assert.equal(s.listCalls({ q: "create order" }).length, 1);
    assert.equal(s.listCalls({ limit: 2 }).length, 2);
    assert.equal(s.listCalls()[0].res_body, undefined, "lists don't carry bodies");
  });
  test("finds the previous call of the same request, operation or URL", () => {
    const s = new Store(tmpDb());
    const a = s.addCall(call({ item_id: 7 })), b = s.addCall(call({ item_id: 7 }));
    assert.equal(s.previousOf(b).id, a.id);
    const c = s.addCall(call({ op_id: "op" })), d = s.addCall(call({ op_id: "op" }));
    assert.equal(s.previousOf(d).id, c.id);
    const e = s.addCall(call({ url: "https://u.test/1" })), f = s.addCall(call({ url: "https://u.test/1" }));
    assert.equal(s.previousOf(f).id, e.id);
    assert.equal(s.previousOf(a), null);
  });
  test("announces new calls and cleared history", () => {
    const s = new Store(tmpDb());
    const seen = [];
    s.on("call", (c) => seen.push(c.id)); s.on("cleared", () => seen.push("cleared"));
    s.addCall(call()); s.clearHistory();
    assert.deepEqual(seen, [1, "cleared"]);
    assert.equal(s.listCalls().length, 0);
  });
});

describe("sessions", () => {
  test("an unknown session is empty; saved ones round-trip and can be deleted", () => {
    const s = new Store(tmpDb());
    assert.deepEqual(s.getSession("new"), { name: "new", headers: {}, vars: {}, cookies: {}, updated_at: null });
    s.saveSession({ name: "dev", headers: { A: "1" }, vars: { id: 5 }, cookies: { "a.test": { sid: "x" } } });
    assert.deepEqual(s.getSession("dev").cookies, { "a.test": { sid: "x" } });
    assert.deepEqual(s.sessions().map((x) => x.name), ["dev"]);
    s.deleteSession("dev");
    assert.equal(s.sessions().length, 0);
  });
});

describe("upgrading", () => {
  test("a database from an older version gains the new columns", async () => {
    const file = tmpDb();
    process.emitWarning = () => {};
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER, ts TEXT NOT NULL, source TEXT NOT NULL, op_id TEXT, method TEXT NOT NULL, url TEXT NOT NULL, session TEXT, note TEXT, req_headers TEXT, req_body TEXT, status INTEGER, res_headers TEXT, res_body TEXT, res_size INTEGER, res_type TEXT, truncated INTEGER DEFAULT 0, duration_ms INTEGER, validation TEXT, error TEXT, replay_of INTEGER)");
    old.prepare("INSERT INTO calls (ts, source, method, url) VALUES (?, 'agent', 'GET', 'https://old.test')").run(new Date().toISOString());
    old.close();
    const s = new Store(file);
    assert.equal(s.listCalls()[0].url, "https://old.test");
    const c = s.addCall(call({ item_name: "new column" }));
    assert.equal(s.getCall(c.id).item_name, "new column");
  });
});
