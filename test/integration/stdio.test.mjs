// jodrell as the agent starts it: an MCP server over stdio inside a project.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { BIN, tmpProject, fakeApi, oas } from "../helpers.mjs";

test("runs over stdio, keeps data in the project, and starts the GUI for links", async () => {
  const api = await fakeApi();
  const root = tmpProject({ "dist/openapi.json": oas("Gen", { "/users/{id}": { get: { operationId: "getUser", responses: { 200: { description: "ok" } } } } }, { servers: [{ url: api.url }] }) });
  const client = new Client({ name: "stdio-test", version: "1" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], cwd: root, stderr: "ignore" }));
  try {
    const r = await client.callTool({ name: "call_operation", arguments: { operationId: "getUser", pathParams: { id: "3" } } });
    assert.match(r.content[0].text, /HTTP 200/);
    assert.ok(fs.existsSync(path.join(root, ".jodrell", "history.db")));
    const h = await client.callTool({ name: "show_history", arguments: {} });
    assert.equal(h.structuredContent.calls.length, 1);
    // the GUI starts in the background so replies can link to it
    for (let i = 0; i < 40 && !h.structuredContent.guiUrl; i++) await new Promise((r) => setTimeout(r, 100));
    const again = await client.callTool({ name: "show_history", arguments: {} });
    assert.match(again.structuredContent.guiUrl, /^http:\/\/localhost:\d+$/);
    assert.equal((await fetch(again.structuredContent.guiUrl + "/api/info")).status, 200);
  } finally { await client.close(); await api.close(); }
});
