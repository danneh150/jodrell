// Drives jodrell like an agent would: import, run a collection, call a third-party API, save it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "test-agent", version: "1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:4545/mcp")));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n### ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""}\n` + r.content[0].text.slice(0, 700));
};
await call("use_environment", { name: "demo local" });
await call("list_collections");
await call("run_collection", { collection: "Demo shop (Postman)" });
await call("list_environments");
await call("run_request", { request: "Orders / Get order", vars: { firstOrder: "o-1" } });
await call("run_request", { request: "order" });
// Third-party call by full URL with a session: cookies should stay with that host
await call("send_request", { method: "POST", url: "http://127.0.0.1:4600/login", body: { password: "secret" }, session: "s1", capture: { "header:Authorization": "Bearer {{body.access_token}}" } });
await call("send_request", { method: "GET", url: "http://127.0.0.1:4600/orders", session: "s1" });
await call("send_request", { method: "GET", url: "http://localhost:4600/orders", session: "s1", note: "different host: should NOT get the cookie or token" });
await call("list_sessions");
await call("save_request", { collection: "Scratch", folder: "Third party", name: "Orders via IP", fromCall: 1 });
await client.close();
