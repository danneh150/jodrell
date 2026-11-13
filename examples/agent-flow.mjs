// Drives jodrell the way an agent would, over MCP.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const client = new Client({ name: "test-agent", version: "1.0" });
await client.connect(new StreamableHTTPClientTransport(new URL("http://localhost:4545/mcp")));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  console.log(`\n### ${name} ${JSON.stringify(args)}${r.isError ? "  [ERROR]" : ""}\n` + r.content[0].text.slice(0, 900));
};
console.log((await client.listTools()).tools.map((t) => t.name).join(", "));
await call("list_operations");
await call("call_operation", { operationId: "listOrders" });
await call("call_operation", { operationId: "login", body: { email: "dev@example.com", password: "secret" }, session: "dev",
  capture: { "header:Authorization": "Bearer {{body.access_token}}", "var:lastLogin": "{{status}}" }, note: "log in" });
await call("call_operation", { operationId: "listOrders", session: "dev", query: { status: "open" } });
await call("call_operation", { operationId: "createOrder", session: "dev", body: { sku: "TEL-DWARF3", quantity: 2 }, capture: { "var:orderId": "{{body.id}}" } });
await call("call_operation", { operationId: "getOrder", session: "dev", pathParams: { orderId: "{{orderId}}" } });
await call("call_operation", { operationId: "getOrder", session: "dev", pathParams: { orderId: "o-3" }, note: "the broken one" });
await call("call_operation", { operationId: "getOrdr" });
await call("send_request", { method: "GET", url: "/health" });
await call("list_sessions");
await call("get_history", { limit: 5 });
await client.close();
