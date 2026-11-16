// MCP tools for the agent. Each agent connection gets its own run in the history.
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import fs from "node:fs";
import { mask, isSecretHeader } from "./checks.mjs";
import { blankRequest } from "./collections.mjs";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAppTool, registerAppResource } from "@modelcontextprotocol/ext-apps/server";
import { APP_URI, APP_MIME, buildAppHtml, forView, summarise as summariseCall, timelineData, buildReport, parseSince } from "./html.mjs";

const AGENT_BODY_LIMIT = 8000; // characters of response body returned to the agent

const text = (s) => ({ content: [{ type: "text", text: s }] });
const fail = (s) => ({ content: [{ type: "text", text: s }], isError: true });

function bodyForAgent(call) {
  let b = call.res_body ?? "";
  try { b = JSON.stringify(JSON.parse(b), null, 2); } catch {}
  return b.length > AGENT_BODY_LIMIT ? b.slice(0, AGENT_BODY_LIMIT) + `\n… truncated (${b.length} characters). Use get_call with offset to read more.` : b;
}

function summarise(call, uiBase) {
  const lines = [];
  if (call.error) lines.push(`Request failed: ${call.error}`);
  else lines.push(`HTTP ${call.status} in ${call.duration_ms} ms (${call.res_size} bytes, ${call.res_type || "no content type"})`);
  lines.push(`${call.method} ${call.url}`);
  if (call.item_name) lines.push(`Saved request: ${call.item_name}`);
  if (call.expect_status) lines.push(call.status === call.expect_status ? `Expected status ${call.expect_status}: passed.` : `Expected status ${call.expect_status}: FAILED (got ${call.status ?? "no response"}).`);
  const v = call.validation;
  if (v?.checked) lines.push(v.valid ? "Response matches the spec." : `Response does NOT match the spec:\n${v.errors.map((e) => `  ${e.path} ${e.message}`).join("\n")}`);
  else if (v?.note) lines.push(`Schema: ${v.note}`);
  if (call.retriedFrom) lines.push(`The first try (call #${call.retriedFrom}) got HTTP 401, so jodrell signed in again and sent it once more.`);
  if (call.auth?.note) lines.push(`Before sending this, ${call.auth.note}.`);
  if (call.auth && "ok" in call.auth) lines.push(call.auth.ok ? `Signed in for "${call.auth.profile}": jodrell will add this token to "${call.auth.profile}" requests.` : `Sign-in for "${call.auth.profile}" didn't work: ${call.auth.error}`);
  if (call.captured) lines.push(`Saved to session: ${Object.entries(call.captured).map(([k, v]) => `${k} = ${v}`).join(", ")}`);
  const interesting = Object.entries(call.res_headers || {}).filter(([k]) => /^(location|content-type|retry-after|x-request-id|etag|www-authenticate|set-cookie)$/i.test(k));
  if (interesting.length) lines.push("Headers: " + interesting.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(" | ") : v}`).join("; "));
  if (!call.error) lines.push("", bodyForAgent(call));
  lines.push("", uiBase ? `Call #${call.id}. The user can see it in jodrell at ${uiBase}/#call-${call.id}` : `Call #${call.id}.`);
  return lines.join("\n");
}

function describe(op) {
  const p = op.params.map((x) => `  - ${x.name} (${x.in}${x.required ? ", required" : ""})${x.schema?.type ? ": " + x.schema.type : ""}${x.description ? " — " + x.description : ""}`);
  const schema = (s) => { const j = JSON.stringify(s, null, 1); return j.length > 3000 ? j.slice(0, 3000) + " …" : j; };
  return [
    `${op.id}: ${op.method} ${op.path}`,
    op.summary,
    `Base URL: ${op.baseUrl || "(none — pass --base-url)"}`,
    p.length ? "Parameters:\n" + p.join("\n") : "No parameters.",
    op.requestBody ? `Request body${op.requestBody.required ? " (required)" : ""}:\n${schema(op.requestBody.schema)}` : "",
    "Responses: " + Object.keys(op.responses).join(", "),
  ].filter(Boolean).join("\n");
}

function tree(items, depth = 0) {
  return items.map((it) => it.kind === "folder"
    ? `${"  ".repeat(depth)}📁 ${it.name} (folder #${it.id})\n${tree(it.items || [], depth + 1)}`
    : `${"  ".repeat(depth)}#${it.id} ${it.request?.method || "GET"} ${it.name}`).join("\n");
}

function buildServer({ store, specs, runner, collections, auth, uiBase: base, ctx, gui, root, project, refreshSpecs }) {
  const uiBase = typeof base === "function" ? base() : base;
  const guiUrl = () => (typeof base === "function" ? base() : base) || "";
  const server = new McpServer(
    { name: "jodrell", version: "0.3.0" },
    { instructions: "jodrell is the user's API client. Every call you make is recorded and shown to them live. To call the project's own APIs, use call_operation (from the OpenAPI specs). For third-party APIs and imported Postman collections, use list_collections and run_request / run_collection, or send_request for one-off calls. {{variables}} come from the active environment and collection variables. Auth profiles in jodrell.config.json sign in automatically: don't call login endpoints yourself when auth_status lists a profile for that API. Use sessions for cookies and captured auth headers otherwise." },
  );

  // ---- MCP Apps: the same tools also return a view the host can render in the reply.
  registerAppResource(server, "jodrell view", APP_URI, { description: "jodrell request, run and history views", mimeType: APP_MIME },
    async () => ({ contents: [{ uri: APP_URI, mimeType: APP_MIME, text: buildAppHtml(), _meta: { ui: { prefersBorder: false } } }] }));
  const appTool = (name, config, cb, visibility) => registerAppTool(server, name, { ...config, _meta: { ui: { resourceUri: APP_URI, ...(visibility ? { visibility } : {}) } } }, cb);
  const callResult = (call) => ({ content: [{ type: "text", text: summarise(call, guiUrl()) }], structuredContent: { view: "call", call: forView(call), guiUrl: guiUrl() } });
  const runResult = (textOut, r) => ({
    content: [{ type: "text", text: textOut }],
    structuredContent: { view: "run", summary: { name: r.name, total: r.total, passed: r.passed }, calls: store.listCalls({ run: r.runId, limit: 500 }).reverse().map(summariseCall), guiUrl: guiUrl() },
  });

  const runId = () => {
    if (!ctx.run) {
      const client = server.server.getClientVersion()?.name || "agent";
      ctx.run = store.createRun(client, "agent").id;
    }
    return ctx.run;
  };

  const sessionArg = z.string().optional().describe("Named session to use (headers, cookies and variables are applied and updated)");
  const authArg = z.boolean().optional().describe("Set false to send without the auth profile's token (e.g. to test what happens when signed out). Default: true.");
  const captureArg = z.record(z.string(), z.string()).optional().describe('Save values from the response into the session, e.g. {"header:Authorization": "Bearer {{body.access_token}}", "var:orderId": "{{body.id}}"}. Requires session.');

  server.registerTool("list_operations", {
    description: "List the operations in this project's OpenAPI/Swagger specs (found automatically), grouped by spec. Optionally filter by text (matches id, path, summary or tag).",
    inputSchema: { filter: z.string().optional() },
  }, async ({ filter }) => {
    const f = filter?.toLowerCase();
    if (!specs.specs.length) return text("No OpenAPI or Swagger specs were found in this project. If your app serves one at runtime, set \"appUrl\" in jodrell.config.json. For third-party APIs, use send_request or collections instead.");
    const out = [];
    for (const sp of specs.specs) {
      if (sp.error) { if (!f) out.push(`✗ ${root && !/^https?:/.test(sp.source) ? path.relative(root, sp.source) : sp.source}: couldn't load (${sp.error})`); continue; }
      const ops = specs.list().filter((o) => o.spec === sp.title && (!f || [o.id, o.path, o.summary, ...o.tags].join(" ").toLowerCase().includes(f)));
      if (f && !ops.length) continue;
      out.push(`${sp.title}${sp.version ? " " + sp.version : ""} (${sp.baseUrl || "NO BASE URL"})`);
      for (const w of sp.warnings) out.push(`  ⚠ ${w}`);
      for (const o of ops) out.push(`  ${o.id}  ${o.method} ${o.path}${o.summary ? "  — " + o.summary : ""}`);
    }
    return text(out.length ? out.join("\n") : `No operations match "${filter}".`);
  });

  server.registerTool("list_specs", {
    description: "List the OpenAPI/Swagger specs jodrell found in this project (and any served by the running app), with their base URLs and any problems.",
    inputSchema: {},
  }, async () => {
    const { describeSpecs } = await import("./project.mjs");
    return text(describeSpecs(specs, root || process.cwd()).join("\n") + (specs.loadedAt ? `\nLast loaded ${new Date(specs.loadedAt).toLocaleTimeString("en-GB")}. Specs reload automatically when they change.` : ""));
  });

  server.registerTool("reload_specs", {
    description: "Search the project for specs again and reload them now. Use after regenerating a spec or starting the app, rather than waiting for the automatic check.",
    inputSchema: {},
  }, async () => {
    try {
      if (refreshSpecs) await refreshSpecs({ force: true }); else await specs.load();
      const { describeSpecs } = await import("./project.mjs");
      return text("Reloaded.\n" + describeSpecs(specs, root || process.cwd()).join("\n"));
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("describe_operation", {
    description: "Show an operation's parameters, request body schema and documented responses.",
    inputSchema: { operationId: z.string() },
  }, async ({ operationId }) => {
    const op = specs.get(operationId);
    return op ? text(describe(op)) : fail(`Unknown operation "${operationId}". Use list_operations.`);
  });

  appTool("call_operation", {
    description: "Call an API operation by operationId. The response is checked against the spec and recorded. Strings can use {{varName}} to insert session variables.",
    inputSchema: {
      operationId: z.string(),
      pathParams: z.record(z.string(), z.any()).optional(),
      query: z.record(z.string(), z.any()).optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.any().optional().describe("JSON body (object or array), or a raw string"),
      session: sessionArg,
      capture: captureArg,
      note: z.string().optional().describe("Short note shown in the history, e.g. why you made this call"),
      auth: authArg,
    },
  }, async ({ operationId, pathParams, query, headers, body, session, capture, note, auth: useAuth }) => {
    try {
      const req = runner.fromOperation(operationId, { pathParams, query, headers, body }, session);
      const call = await runner.send({ ...req, session, capture, note, runId: runId(), auth: useAuth });
      return callResult(call);
    } catch (e) { return fail(e.message); }
  });

  appTool("send_request", {
    description: "Send a raw HTTP request. Use for endpoints not in the spec. A path like /health is resolved against the first spec's base URL.",
    inputSchema: {
      method: z.string().default("GET"),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.any().optional(),
      session: sessionArg,
      capture: captureArg,
      note: z.string().optional(),
      auth: authArg,
    },
  }, async ({ method, url, headers, body, session, capture, note, auth: useAuth }) => {
    try {
      const base = specs.list()[0]?.baseUrl;
      const full = /^https?:\/\//.test(url) ? url : base ? base.replace(/\/$/, "") + "/" + url.replace(/^\//, "") : null;
      if (!full) return fail("Relative URL given but no base URL is known. Pass a full URL.");
      const call = await runner.send({ method: method.toUpperCase(), url: full, headers, body, session, capture, note, runId: runId(), auth: useAuth });
      return callResult(call);
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("auth_status", {
    description: "List the auth profiles from jodrell.config.json: which API each one signs in to, whether it's signed in, and when the token expires. Requests to those APIs get the token automatically.",
    inputSchema: {},
  }, async () => {
    const list = auth?.statuses() || [];
    if (!list.length) return text('No auth profiles. To have jodrell sign in for you, add "auth" to jodrell.config.json, e.g. {"auth": {"shop": {"login": {"op": "login", "body": {"username": "{{env.SHOP_USER}}", "password": "{{env.SHOP_PASS}}"}}}}}. Secrets come from .env or the environment.');
    return text(list.map((a) => [
      `${a.name} (${a.state}): ${a.message}`,
      `  Applies to: ${[a.spec && `${a.spec}${a.baseUrl ? ` (${a.baseUrl})` : ""}`, ...a.hosts].filter(Boolean).join(", ") || "nothing yet"}`,
      `  Signs in with ${a.how}${a.login ? `: ${a.login.method} ${a.login.url}` : a.command ? `: ${a.command}` : ""}. Token goes in the ${a.placement}.`,
      a.expiresAt ? `  Expires: ${a.expiresAt}` : null,
    ].filter(Boolean).join("\n")).join("\n"));
  });

  server.registerTool("sign_in", {
    description: "Sign in for an auth profile now, even if its token is still valid. Normally not needed: jodrell signs in when a request needs it.",
    inputSchema: { name: z.string().describe("The auth profile's name, from auth_status") },
  }, async ({ name }) => {
    const p = auth?.profile(name);
    if (!p) return fail(`No auth profile called "${name}". Use auth_status to see them.`);
    try { await auth.ensure(p, runner, { force: true, source: "agent", runId: runId() }); }
    catch (e) { return fail(`Couldn't sign in for "${name}": ${e.message}`); }
    const st = auth.status(name);
    return text(`Signed in for "${name}". ${st.expiresAt ? `The token expires at ${st.expiresAt}.` : "The API didn't say when the token expires."}`);
  });

  server.registerTool("set_session", {
    description: "Create or update a named session. Headers are sent on every call using the session; variables can be used as {{name}}. Values are never shown in full afterwards.",
    inputSchema: {
      name: z.string(),
      headers: z.record(z.string(), z.string()).optional().describe("Headers to set; use an empty string to remove one"),
      host: z.string().optional().describe("Only send these headers to this host (recommended for auth headers)"),
      vars: z.record(z.string(), z.any()).optional(),
      clearCookies: z.boolean().optional(),
    },
  }, async ({ name, headers = {}, host, vars = {}, clearCookies }) => {
    const s = store.getSession(name);
    for (const [k, v] of Object.entries(headers)) v === "" ? delete s.headers[k] : (s.headers[k] = host ? { value: v, host: host.toLowerCase() } : v);
    Object.assign(s.vars, vars);
    if (clearCookies) s.cookies = {};
    store.saveSession(s);
    return text(`Session "${name}" saved: headers ${Object.keys(s.headers).join(", ") || "none"}; variables ${Object.keys(s.vars).join(", ") || "none"}; ${Object.keys(s.cookies).length} cookie(s).`);
  });

  server.registerTool("list_sessions", {
    description: "List sessions with their header names, variables and cookie names (secret values masked).",
    inputSchema: {},
  }, async () => {
    const all = store.sessions();
    if (!all.length) return text("No sessions yet. Create one with set_session, or pass session on a call.");
    return text(all.map((s) => `${s.name}: headers {${Object.entries(s.headers).map(([k, v]) => typeof v === "object" ? `${k}: ${mask(v.value)} (${v.host} only)` : `${k}: ${mask(v)} (all hosts)`).join(", ")}} vars ${JSON.stringify(s.vars)} cookies [${Object.entries(s.cookies).filter(([, c]) => typeof c === "object").flatMap(([d, c]) => Object.keys(c).map((n) => n + "@" + d)).join(", ")}]`).join("\n"));
  });

  server.registerTool("get_history", {
    description: "List recent calls (newest first). Filter by operationId or status (e.g. 404, 5xx, error).",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20), operationId: z.string().optional(), status: z.string().optional(), thisRunOnly: z.boolean().default(false) },
  }, async ({ limit, operationId, status, thisRunOnly }) => {
    const rows = store.listCalls({ limit, op: operationId, status, run: thisRunOnly ? ctx.run : undefined });
    if (!rows.length) return text("No calls match.");
    return text(rows.map((r) => `#${r.id} ${r.method} ${r.error ? "ERR" : r.status} ${r.item_name ? r.item_name + " " : ""}${r.url} ${r.duration_ms}ms${r.validation?.checked && !r.validation.valid ? " (schema mismatch)" : ""}${r.note ? " — " + r.note : ""}`).join("\n"));
  });

  server.registerTool("get_call", {
    description: "Read a recorded call in full, including request and response headers and body.",
    inputSchema: { callId: z.number().int(), offset: z.number().int().min(0).default(0) },
  }, async ({ callId, offset }) => {
    const call = store.getCall(callId);
    if (!call) return fail(`No call #${callId}.`);
    const body = (call.res_body || "").slice(offset, offset + AGENT_BODY_LIMIT);
    return text([
      `#${call.id} ${call.method} ${call.url} → ${call.error || call.status}`,
      "Request headers: " + JSON.stringify(call.req_headers),
      call.req_body ? "Request body: " + call.req_body.slice(0, 4000) : "",
      "Response headers: " + JSON.stringify(call.res_headers),
      `Response body (characters ${offset}–${offset + body.length} of ${(call.res_body || "").length}):`,
      body,
    ].filter(Boolean).join("\n"));
  });

  server.registerTool("import_collection", {
    description: "Import a Postman collection (v2.0/v2.1) or Postman environment export, from a file path on this machine, a URL, or pasted JSON.",
    inputSchema: { path: z.string().optional(), url: z.string().optional(), json: z.string().optional() },
  }, async ({ path, url, json }) => {
    try {
      let data = json;
      if (path) data = fs.readFileSync(path, "utf8");
      else if (url) { const r = await fetch(url); if (!r.ok) throw new Error(`Could not fetch ${url}: HTTP ${r.status}`); data = await r.text(); }
      if (!data) return fail("Pass path, url or json.");
      const s = collections.importPostman(data);
      if (s.kind === "environment") return text(`Imported environment "${s.environment}" with ${s.variables} variables. Use use_environment to make it active.`);
      return text([`Imported "${s.collection}" (collection #${s.id}): ${s.requests} requests in ${s.folders} folders.`,
        s.capturesFromScripts ? `${s.capturesFromScripts} script line(s) converted into automatic captures or status checks.` : "",
        ...s.notes].filter(Boolean).join("\n"));
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("list_collections", {
    description: "List saved collections with their folders and requests (ids, methods, names), plus collection variables.",
    inputSchema: { collection: z.string().optional().describe("Name or id, to show just one") },
  }, async ({ collection }) => {
    let cols = collections.list();
    if (collection) cols = cols.filter((c) => String(c.id) === collection || c.name.toLowerCase() === collection.toLowerCase());
    if (!cols.length) return text(collection ? `No collection "${collection}".` : "No collections yet. Import one with import_collection, or save requests with save_request.");
    return text(cols.map((c) => `Collection #${c.id} ${c.name}${c.variables.length ? `\n  variables: ${c.variables.map((v) => v.key).join(", ")}` : ""}\n${tree(c.items, 1)}`).join("\n\n"));
  });

  server.registerTool("describe_request", {
    description: "Show a saved request in full: method, URL, headers, body, auth type, captures and expected status.",
    inputSchema: { request: z.string().describe('Request id, or a path like "Stripe / Customers / Create customer"') },
  }, async ({ request }) => {
    try {
      const it = collections.findRequest(request);
      if (!it) return fail(`No saved request "${request}". Use list_collections.`);
      const r = it.request;
      const secret = (h) => (isSecretHeader(h.key) ? mask(h.value) : h.value);
      return text([
        `#${it.id} ${collections.pathOf(it)}`, `${r.method} ${r.url}`,
        r.pathVars?.length ? "Path variables: " + r.pathVars.map((v) => `${v.key}=${v.value}`).join(", ") : "",
        r.headers?.length ? "Headers:\n" + r.headers.map((h) => `  ${h.enabled === false ? "(off) " : ""}${h.key}: ${secret(h)}`).join("\n") : "",
        r.body?.mode !== "none" ? `Body (${r.body.mode}):\n${r.body.mode === "graphql" ? r.body.graphql.query : r.body.raw || r.body.fields.map((f) => `  ${f.key}=${f.value}`).join("\n")}` : "",
        `Auth: ${r.auth?.type || "inherit"}`,
        r.captures?.length ? "After response, saves: " + r.captures.map((c) => `${c.key} ← ${c.value}`).join(", ") : "",
        r.expectStatus ? `Expects status ${r.expectStatus}` : "",
        r.description ? `Notes: ${r.description.slice(0, 800)}` : "",
      ].filter(Boolean).join("\n"));
    } catch (e) { return fail(e.message); }
  });

  appTool("run_request", {
    description: "Run a saved request (from an imported or saved collection). Variables, inherited auth and captures are applied. Optionally override variables for this call only.",
    inputSchema: {
      request: z.string().describe('Request id, or a path like "Stripe / Customers / Create customer"'),
      vars: z.record(z.string(), z.any()).optional().describe('Variables for this call only, e.g. {"customerId": "cus_123"}'),
      session: sessionArg,
      note: z.string().optional(),
    },
  }, async ({ request, vars, session, note }) => {
    try {
      const it = collections.findRequest(request);
      if (!it) return fail(`No saved request "${request}". Use list_collections.`);
      const call = await runner.runItem(it.id, { vars, session, note, source: "agent", runId: runId() });
      return callResult(call);
    } catch (e) { return fail(e.message); }
  });

  appTool("run_collection", {
    description: "Run every request in a collection (or one folder) in order, like Postman's collection runner. Returns pass/fail per request.",
    inputSchema: { collection: z.string().describe("Collection name or id"), folder: z.string().optional().describe("Folder name or id"), session: sessionArg, stopOnFailure: z.boolean().default(false) },
  }, async ({ collection, folder, session, stopOnFailure }) => {
    try {
      const c = collections.findCollection(collection);
      if (!c) return fail(`No collection "${collection}".`);
      let folderId;
      if (folder) {
        const f = collections.db.prepare("SELECT id FROM items WHERE collection_id = ? AND kind = 'folder' AND (id = ? OR name = ? COLLATE NOCASE)").get(c.id, Number(folder) || -1, folder);
        if (!f) return fail(`No folder "${folder}" in ${c.name}.`);
        folderId = f.id;
      }
      const r = await runner.runCollection(c.id, { folderId, session, stopOnFailure, source: "agent" });
      return runResult([`${r.name}: ${r.passed} of ${r.total} passed.`, ...r.results.map((x) =>
        `${x.passed ? "✓" : "✗"} ${x.item}: ${x.error || x.status}${x.expected && !x.passed ? ` (expected ${x.expected})` : ""} ${x.ms ?? ""}ms${x.callId ? ` #${x.callId}` : ""}${x.captured ? ` saved ${Object.keys(x.captured).join(", ")}` : ""}`),
        "", guiUrl() ? `The user can see the run in jodrell at ${guiUrl()}` : ""].join("\n"), r);
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("save_request", {
    description: "Save a request into a collection so the user can open and re-run it. Creates the collection and folder if needed. Use {{variables}} for secrets rather than literal tokens.",
    inputSchema: {
      collection: z.string(), folder: z.string().optional(), name: z.string(),
      method: z.string().default("GET"), url: z.string().optional(),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.any().optional().describe("JSON body (object/array) or raw string"),
      fromCall: z.number().int().optional().describe("Copy method, URL, headers and body from a recorded call instead"),
    },
  }, async ({ collection, folder, name, method, url, headers = {}, body, fromCall }) => {
    try {
      const c = collections.findCollection(collection) || collections.createCollection({ name: collection });
      let parentId = null;
      if (folder) {
        const f = collections.db.prepare("SELECT id FROM items WHERE collection_id = ? AND kind = 'folder' AND name = ? COLLATE NOCASE").get(c.id, folder);
        parentId = f ? f.id : collections.createItem({ collectionId: c.id, kind: "folder", name: folder }).id;
      }
      let req;
      if (fromCall) {
        const call = store.getCall(fromCall);
        if (!call) return fail(`No call #${fromCall}`);
        const isJson = (() => { try { JSON.parse(call.req_body); return true; } catch { return false; } })();
        req = blankRequest({ method: call.method, url: call.url,
          headers: Object.entries(call.req_headers).filter(([k, v]) => !String(v).includes("••••") && !/^(accept|user-agent|content-length)$/i.test(k)).map(([key, value]) => ({ key, value, enabled: true })) });
        if (call.req_body) req.body = { ...req.body, mode: isJson ? "json" : "text", raw: call.req_body };
      } else {
        if (!url) return fail("Pass url, or fromCall.");
        const raw = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body, null, 2);
        req = blankRequest({ method: method.toUpperCase(), url, headers: Object.entries(headers).map(([key, value]) => ({ key, value, enabled: true })) });
        if (raw) req.body = { ...req.body, mode: typeof body === "string" ? "text" : "json", raw };
      }
      const it = collections.createItem({ collectionId: c.id, parentId, kind: "request", name, request: req });
      return text(`Saved as #${it.id} ${collections.pathOf(it)}.`);
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("list_environments", {
    description: "List environments and their variable names (secret-looking values masked). Shows which is active.",
    inputSchema: {},
  }, async () => {
    const envs = collections.environments();
    if (!envs.length) return text("No environments. Import a Postman environment, or set_variable creates one.");
    return text(envs.map((e) => `${e.active ? "● " : "  "}${e.name} (#${e.id}): ${e.vars.map((v) => `${v.key}=${isSecretHeader(v.key) ? mask(v.value) : String(v.value).slice(0, 40)}`).join(", ") || "no variables"}`).join("\n"));
  });

  server.registerTool("use_environment", {
    description: "Make an environment active (its variables fill {{placeholders}}). Pass an empty name for none.",
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    if (!name) { collections.setActiveEnv(null); return text("No environment active."); }
    const e = collections.findEnv(name);
    if (!e) return fail(`No environment "${name}".`);
    collections.setActiveEnv(e.id);
    return text(`"${e.name}" is now active.`);
  });

  server.registerTool("set_variable", {
    description: "Set a {{variable}} in the active environment (default) or a collection.",
    inputSchema: { name: z.string(), value: z.string(), collection: z.string().optional().describe("Set it on this collection instead") },
  }, async ({ name, value, collection }) => {
    try {
      const c = collection ? collections.findCollection(collection) : null;
      if (collection && !c) return fail(`No collection "${collection}".`);
      const where = collections.setVariable(name, value, { collectionId: c?.id, scope: c ? "collection" : undefined });
      return text(`Set {{${name}}} in ${where}.`);
    } catch (e) { return fail(e.message); }
  });

  appTool("show_history", {
    title: "Show request history",
    description: "Show the user a timeline of recent API requests (theirs and yours), grouped into sessions. Use when the user asks to see history, what happened, or recent requests.",
    inputSchema: {
      since: z.string().optional().describe("How far back: 30m, 24h, 7d, all (default 24h)"),
      onlyFailed: z.boolean().optional(),
      thisRunOnly: z.boolean().optional().describe("Only the requests you made in this conversation"),
    },
  }, async ({ since = "24h", onlyFailed, thisRunOnly }) => {
    try {
      const d = timelineData(store, { since: parseSince(since), runId: thisRunOnly ? ctx.run : undefined, failedOnly: onlyFailed, limit: 1000 });
      const failedN = d.calls.filter((c) => c.error || c.status >= 400).length;
      const lines = [`${d.calls.length} request(s) since ${since === "all" ? "the start" : since}${failedN ? `, ${failedN} failed` : ""}.`,
        ...d.calls.slice(0, 15).map((c) => `#${c.id} ${new Date(c.ts).toLocaleTimeString("en-GB")} ${c.method} ${c.error ? "ERR" : c.status} ${c.item_name || c.url}${c.source === "agent" ? " (agent)" : ""}`),
        d.calls.length > 15 ? `…and ${d.calls.length - 15} more.` : "",
        guiUrl() ? `Full timeline: ${guiUrl()}` : ""].filter(Boolean);
      return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { view: "timeline", ...d, guiUrl: guiUrl(), range: "all", title: onlyFailed ? "Failed requests" : thisRunOnly ? "This conversation" : "Request history" } };
    } catch (e) { return fail(e.message); }
  });

  appTool("show_request", {
    title: "Show a request",
    description: "Show the user one recorded request and its response (by call number).",
    inputSchema: { callId: z.number().int() },
  }, async ({ callId }) => {
    const c = store.getCall(callId);
    return c ? callResult(c) : fail(`No call #${callId}.`);
  });

  appTool("get_call_view", {
    description: "Used by the jodrell view to load one request's details.",
    inputSchema: { callId: z.number().int() },
  }, async ({ callId }) => {
    const c = store.getCall(callId);
    return c ? { content: [{ type: "text", text: `Call #${callId}` }], structuredContent: { call: forView(c) } } : fail(`No call #${callId}.`);
  }, ["app"]);

  server.registerTool("export_report", {
    description: "Write the request history (timeline, requests and responses) to a self-contained HTML file the user can open or share. Secret headers are masked.",
    inputSchema: { since: z.string().optional().describe("30m, 24h, 7d or all (default all)"), thisRunOnly: z.boolean().optional() },
  }, async ({ since = "all", thisRunOnly }) => {
    try {
      const fs = await import("node:fs");
      const dir = path.join(root || process.cwd(), ".jodrell", "reports");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `history-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}.html`);
      fs.writeFileSync(file, buildReport(store, { since: parseSince(since), runId: thisRunOnly ? ctx.run : undefined, project }));
      return text(`Saved the report to ${file}\nOpen it in a browser: file://${file}`);
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("open_gui", {
    description: "Open the full jodrell GUI for the user: in a split pane next to you if the terminal supports it, otherwise in their browser.",
    inputSchema: { where: z.enum(["split", "browser"]).default("split") },
  }, async ({ where }) => {
    try {
      const url = gui ? (await gui()).url : guiUrl();
      if (!url) return fail("The GUI isn't running. Ask the user to run: npx jodrell gui");
      const { openGui } = await import("./open.mjs");
      const how = await openGui(url, { split: where === "split" ? "right" : null });
      return text(`${how}. URL: ${url}`);
    } catch (e) { return fail(e.message); }
  });

  server.registerTool("start_run", {
    description: "Start a new named run, so the following calls are grouped together in the history (e.g. 'checkout flow test').",
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    ctx.run = store.createRun(name, "agent").id;
    return text(`Started run "${name}". Following calls are grouped under it.`);
  });

  return server;
}

// stdio: how agents start jodrell inside a project (npx jodrell mcp).
export async function startStdio(deps) {
  const server = buildServer({ ...deps, ctx: {} });
  await server.connect(new StdioServerTransport());
  return server;
}

// Handles /mcp: one transport + server per MCP session.
export function createMcpHandler(deps) {
  const transports = new Map();
  return async (req, res, body) => {
    const sid = req.headers["mcp-session-id"];
    let transport = sid ? transports.get(sid) : null;
    if (!transport) {
      if (req.method !== "POST" || !isInitializeRequest(body)) {
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "No valid MCP session. Reconnect the client." }, id: null }));
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => transports.set(id, transport),
      });
      transport.onclose = () => transport.sessionId && transports.delete(transport.sessionId);
      const server = buildServer({ ...deps, ctx: {} });
      await server.connect(transport);
    }
    await transport.handleRequest(req, res, body);
  };
}
