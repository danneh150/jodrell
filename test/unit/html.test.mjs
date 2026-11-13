// The HTML report, the agent's in-reply view, and the data behind the timeline.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../../src/store.mjs";
import { buildReport, buildAppHtml, timelineData, summarise, forView, parseSince, APP_URI, APP_MIME } from "../../src/html.mjs";
import { tmpDb } from "../helpers.mjs";

const call = (over = {}) => ({ ts: new Date().toISOString(), source: "agent", method: "GET", url: "https://a.test/x", status: 200, duration_ms: 5, req_headers: {}, res_headers: {}, res_body: "{}", ...over });

describe("timeline data", () => {
  test("summaries without bodies, filtered by time, run and failure", () => {
    const s = new Store(tmpDb());
    const r = s.createRun("claude-code", "agent");
    s.addCall(call({ ts: new Date(Date.now() - 3 * 864e5).toISOString() }));
    s.addCall(call({ run_id: r.id, status: 500 }));
    s.addCall(call({ run_id: r.id }));
    assert.equal(timelineData(s).calls.length, 3);
    assert.equal(timelineData(s, { since: parseSince("24h") }).calls.length, 2);
    assert.equal(timelineData(s, { runId: r.id }).calls.length, 2);
    assert.equal(timelineData(s, { failedOnly: true }).calls.length, 1);
    assert.equal(timelineData(s).runs[r.id].name, "claude-code");
    assert.equal(timelineData(s).calls[0].res_body, undefined);
  });
  test("summarise drops bodies; forView shortens long ones", () => {
    const c = call({ res_body: "x".repeat(20000), validation: { checked: true, valid: false, errors: Array.from({ length: 30 }, (_, i) => ({ path: "/" + i, message: "m" })) } });
    assert.equal(summarise(c).res_body, undefined);
    assert.equal(summarise(c).validation.errors.length, 20);
    assert.equal(forView(c).res_body.length, 16000);
    assert.equal(forView(c).truncated, true);
  });
  test("parseSince understands minutes, hours, days, weeks, dates and all", () => {
    for (const [s, ms] of [["30m", 18e5], ["24h", 864e5], ["7d", 6048e5], ["2w", 12096e5]]) assert.ok(Math.abs(Date.now() - parseSince(s).getTime() - ms) < 2000, s);
    assert.equal(parseSince("all"), null); assert.equal(parseSince(""), null);
    assert.equal(parseSince("2026-01-02").getUTCFullYear(), 2026);
    assert.throws(() => parseSince("soon"), /Couldn't read "soon"/);
  });
});

describe("the HTML report", () => {
  test("is self-contained, includes every call, and can't be broken by a hostile body", () => {
    const s = new Store(tmpDb());
    s.addCall(call({ res_body: '</script><script>window.pwned=1</script>', url: "https://evil.test/<b>" }));
    s.addCall(call({ status: 404 }));
    const html = buildReport(s, { project: "shop" });
    const data = html.split('<script type="application/json" id="data">')[1].split("</script>")[0];
    assert.ok(!data.includes("<"), "no raw < inside the embedded data");
    const parsed = JSON.parse(data);
    assert.equal(parsed.calls.length, 2); assert.equal(Object.keys(parsed.details).length, 2); assert.equal(parsed.project, "shop");
    assert.match(html, /@font-face \{ font-family: "Pixelify Sans"; src: url\(data:font\/ttf;base64,/);
    assert.match(html, /<link rel="icon" type="image\/png" href="data:image\/png;base64,/);
    assert.ok(!/src="https?:|href="https?:/.test(html.replace(/https:\/\/www\.npmjs\.com[^"]*/g, "")), "nothing is loaded from the web");
  });
});

describe("the agent's in-reply view", () => {
  test("bundles the MCP Apps client as a plain script, with no external resources", () => {
    const html = buildAppHtml();
    assert.ok(APP_URI.startsWith("ui://")); assert.equal(APP_MIME, "text/html;profile=mcp-app");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n;\n");
    assert.ok(scripts.includes("window.McpApps={App:"));
    new Function(scripts);
    assert.ok(!/<script src=|<link rel="stylesheet" href="http/.test(html));
  });
});
