// Starts the test suite's fake API on a fixed port, for the manual E2E tests.
//   npm run fake-api        then use http://127.0.0.1:4610
import { fakeApi } from "./helpers.mjs";
import http from "node:http";
const api = await fakeApi();
// Re-expose it on a fixed, memorable port.
http.createServer((req, res) => {
  const p = http.request({ host: "127.0.0.1", port: api.port, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  req.pipe(p);
}).listen(4610, "127.0.0.1", () => {
  console.log("Fake API on http://127.0.0.1:4610 (also http://localhost:4610)");
  console.log("  POST /login {\"password\":\"secret\"}   GET /me   GET /logout   ANY /echo/...");
  console.log("  GET /status/:code   /redirect   /slow?ms=   /big?kb=   /binary   /html   /users/:id   /v3/api-docs");
});
