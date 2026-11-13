// One SQLite file holds everything: runs, calls and sessions. The CLI watch
// view, the web UI and the MCP tools all read from here, so they always agree.
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";

// node:sqlite is built in from Node 22.13; silence its experimental warning.
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...rest));
const { DatabaseSync } = await import("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  started_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  ts TEXT NOT NULL,
  source TEXT NOT NULL,
  op_id TEXT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  session TEXT,
  note TEXT,
  req_headers TEXT,
  req_body TEXT,
  status INTEGER,
  res_headers TEXT,
  res_body TEXT,
  res_size INTEGER,
  res_type TEXT,
  truncated INTEGER DEFAULT 0,
  duration_ms INTEGER,
  validation TEXT,
  error TEXT,
  replay_of INTEGER
);
CREATE INDEX IF NOT EXISTS calls_run ON calls(run_id);
CREATE INDEX IF NOT EXISTS calls_op ON calls(op_id);
CREATE TABLE IF NOT EXISTS sessions (
  name TEXT PRIMARY KEY,
  headers TEXT NOT NULL DEFAULT '{}',
  vars TEXT NOT NULL DEFAULT '{}',
  cookies TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
`;

const J = (v) => (v == null ? null : JSON.stringify(v));
const P = (v, d = null) => { if (v == null) return d; try { return JSON.parse(v); } catch { return d; } };

export class Store extends EventEmitter {
  constructor(file) {
    super();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    // Columns added after the first version.
    for (const col of ["item_id INTEGER", "item_name TEXT", "expect_status INTEGER"]) {
      try { this.db.exec(`ALTER TABLE calls ADD COLUMN ${col}`); } catch {}
    }
  }

  // Runs group calls: one per agent connection, or named with start_run.
  createRun(name, source = "agent") {
    const started = new Date().toISOString();
    const r = this.db.prepare("INSERT INTO runs (name, source, started_at) VALUES (?, ?, ?)").run(name, source, started);
    const run = { id: Number(r.lastInsertRowid), name, source, started_at: started };
    this.emit("run", run);
    return run;
  }

  runs(limit = 100) {
    return this.db.prepare(`SELECT r.*, COUNT(c.id) AS calls FROM runs r LEFT JOIN calls c ON c.run_id = r.id
      GROUP BY r.id ORDER BY r.id DESC LIMIT ?`).all(limit);
  }

  addCall(c) {
    const r = this.db.prepare(`INSERT INTO calls (run_id, ts, source, op_id, method, url, session, note, req_headers, req_body,
      status, res_headers, res_body, res_size, res_type, truncated, duration_ms, validation, error, replay_of, item_id, item_name, expect_status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      c.run_id ?? null, c.ts, c.source, c.op_id ?? null, c.method, c.url, c.session ?? null, c.note ?? null,
      J(c.req_headers), c.req_body ?? null, c.status ?? null, J(c.res_headers), c.res_body ?? null,
      c.res_size ?? null, c.res_type ?? null, c.truncated ? 1 : 0, c.duration_ms ?? null, J(c.validation),
      c.error ?? null, c.replay_of ?? null, c.item_id ?? null, c.item_name ?? null, c.expect_status ?? null,
    );
    const call = this.getCall(Number(r.lastInsertRowid));
    this.emit("call", call);
    return call;
  }

  hydrate(row) {
    if (!row) return null;
    return { ...row, req_headers: P(row.req_headers, {}), res_headers: P(row.res_headers, {}), validation: P(row.validation), truncated: !!row.truncated };
  }

  getCall(id) {
    return this.hydrate(this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id));
  }

  // Summary rows for lists: no bodies, so the history stays fast.
  listCalls({ limit = 200, op, status, run, q } = {}) {
    const where = [];
    const args = [];
    if (op) { where.push("op_id = ?"); args.push(op); }
    if (run) { where.push("run_id = ?"); args.push(Number(run)); }
    if (status) {
      const s = String(status);
      if (/^\dxx$/i.test(s)) { where.push("status >= ? AND status < ?"); args.push(+s[0] * 100, +s[0] * 100 + 100); }
      else if (s === "error") where.push("(error IS NOT NULL OR status >= 400)");
      else { where.push("status = ?"); args.push(Number(s)); }
    }
    if (q) { where.push("(url LIKE ? OR op_id LIKE ? OR note LIKE ? OR item_name LIKE ?)"); args.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`); }
    const sql = `SELECT id, run_id, ts, source, op_id, method, url, session, note, status, res_size, res_type, duration_ms,
      validation, error, replay_of, item_id, item_name, expect_status FROM calls ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit).map((r) => ({ ...r, validation: P(r.validation) }));
  }

  // The last earlier call of the same saved request, operation, or method + URL.
  previousOf(call) {
    if (!call) return null;
    const [col, val] = call.item_id ? ["item_id", call.item_id] : call.op_id ? ["op_id", call.op_id] : ["method || ' ' || url", `${call.method} ${call.url}`];
    return this.hydrate(this.db.prepare(`SELECT * FROM calls WHERE ${col} = ? AND id < ? ORDER BY id DESC LIMIT 1`).get(val, call.id));
  }

  clearHistory() {
    this.db.exec("DELETE FROM calls; DELETE FROM runs;");
    this.emit("cleared");
  }

  // Sessions: headers, variables and a cookie jar, by name.
  getSession(name) {
    const r = this.db.prepare("SELECT * FROM sessions WHERE name = ?").get(name);
    return r ? { name: r.name, headers: P(r.headers, {}), vars: P(r.vars, {}), cookies: P(r.cookies, {}), updated_at: r.updated_at }
      : { name, headers: {}, vars: {}, cookies: {}, updated_at: null };
  }

  saveSession(s) {
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO sessions (name, headers, vars, cookies, updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET headers = excluded.headers, vars = excluded.vars, cookies = excluded.cookies, updated_at = excluded.updated_at`)
      .run(s.name, J(s.headers || {}), J(s.vars || {}), J(s.cookies || {}), now);
    const saved = this.getSession(s.name);
    this.emit("session", saved);
    return saved;
  }

  deleteSession(name) {
    this.db.prepare("DELETE FROM sessions WHERE name = ?").run(name);
    this.emit("session", { name, deleted: true });
  }

  sessions() {
    return this.db.prepare("SELECT name FROM sessions ORDER BY name").all().map((r) => this.getSession(r.name));
  }
}
