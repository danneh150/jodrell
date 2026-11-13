// A tiny API to try jodrell against. It needs a cookie or bearer token, and
// order "o-3" deliberately breaks the spec so you can see a schema mismatch.
import http from "node:http";

const TOKEN = "demo-token-" + Math.random().toString(36).slice(2, 10);
const orders = new Map([
  ["o-1", { id: "o-1", sku: "TEL-DWARF3", quantity: 1, status: "shipped", total: 459, note: null }],
  ["o-2", { id: "o-2", sku: "FLT-UVIR", quantity: 2, status: "open", total: 58 }],
  ["o-3", { id: "o-3", sku: "MNT-TRIPOD", quantity: "1", status: "pending", total: 89, warehouse: "B12" }],
]);

const json = (res, status, data, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(data)); };
const authed = (req) => req.headers.authorization === `Bearer ${TOKEN}` || (req.headers.cookie || "").includes(`sid=${TOKEN}`);
const read = async (req) => { let b = ""; for await (const c of req) b += c; try { return JSON.parse(b || "{}"); } catch { return {}; } };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  await new Promise((r) => setTimeout(r, 20 + Math.random() * 120));
  if (req.method === "POST" && url.pathname === "/login") {
    const b = await read(req);
    if (b.password !== "secret") return json(res, 401, { error: "Wrong email or password" });
    return json(res, 200, { access_token: TOKEN, expires_in: 3600 }, { "set-cookie": `sid=${TOKEN}; HttpOnly; Path=/` });
  }
  if (!authed(req)) return json(res, 401, { error: "Log in first" });
  if (req.method === "GET" && url.pathname === "/orders") {
    const s = url.searchParams.get("status");
    return json(res, 200, { items: [...orders.values()].filter((o) => !s || o.status === s) });
  }
  if (req.method === "POST" && url.pathname === "/orders") {
    const b = await read(req);
    const o = { id: `o-${orders.size + 1}`, sku: b.sku, quantity: b.quantity ?? 1, status: "open", total: 42 * (b.quantity ?? 1) };
    orders.set(o.id, o);
    return json(res, 201, o, { location: `/orders/${o.id}` });
  }
  const m = url.pathname.match(/^\/orders\/([^/]+)$/);
  if (req.method === "GET" && m) return orders.has(m[1]) ? json(res, 200, orders.get(m[1])) : json(res, 404, { error: "No such order" });
  json(res, 404, { error: "Not found" });
}).listen(4600, () => console.log("Demo API on http://localhost:4600 (password: secret)"));
