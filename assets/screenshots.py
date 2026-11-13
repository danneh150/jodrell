"""
Regenerates every screenshot in docs/images/ from scratch.

It builds an example project (specs, a Postman collection, a few days of
history), starts the demo API and the GUI, and photographs each view in
light and dark. Run it after UI changes, or after renaming the project:

    pip install playwright pillow && python -m playwright install chromium
    python3 assets/screenshots.py

The history before today is example data written straight into the
database; today's requests are real calls to the demo API.
"""
import json, os, shutil, socket, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(ROOT, "docs", "images")
BIN = os.path.join(ROOT, "bin", "jodrell.mjs")
NODE = shutil.which("node")
procs = []

def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p

def up(url, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        try: urllib.request.urlopen(url, timeout=1); return True
        except urllib.error.HTTPError: return True
        except Exception: time.sleep(0.2)
    raise SystemExit(f"Nothing answered at {url}")

def start(args, cwd):
    p = subprocess.Popen([NODE, *args], cwd=cwd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
    procs.append(p); return p

def node(script, cwd):
    r = subprocess.run([NODE, "--input-type=module", "-e", script], cwd=cwd, capture_output=True, text=True, timeout=120)
    if r.returncode: raise SystemExit(r.stderr)
    return r.stdout

def api(base, path, method="GET", body=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r: return json.loads(r.read() or b"null")

# ---------------------------------------------------------------- the example project
def build_project():
    root = os.path.join(tempfile.mkdtemp(prefix="jodrell-shots-"), "shop")  # the folder name shows as the project name
    os.makedirs(root)
    w = lambda p, s: (os.makedirs(os.path.dirname(os.path.join(root, p)), exist_ok=True), open(os.path.join(root, p), "w").write(s if isinstance(s, str) else json.dumps(s, indent=2)))
    w("package.json", {"name": "shop", "private": True})
    os.makedirs(os.path.join(root, ".git"))
    os.makedirs(os.path.join(root, "apps", "api"), exist_ok=True)
    shutil.copy(os.path.join(ROOT, "examples", "openapi.yaml"), os.path.join(root, "apps", "api", "openapi.yaml"))
    w("services/billing/swagger.yaml", 'swagger: "2.0"\ninfo: { title: Billing (legacy), version: "1.4" }\nhost: localhost:4600\nbasePath: /\nschemes: [http]\npaths:\n  /orders/{orderId}:\n    get:\n      operationId: getInvoiceOrder\n      summary: Get the order an invoice belongs to\n      parameters: [{ name: orderId, in: path, required: true, type: string }]\n      responses: { "200": { description: ok } }\n')
    w("services/search/openapi.json", {"openapi": "3.0.3", "info": {"title": "Search", "version": "1"}, "paths": {"/search": {"get": {"operationId": "search", "summary": "Search the catalogue", "responses": {"200": {"description": "ok"}}}}}})
    w("test/fixtures/broken.yaml", "openapi: 3.0.0\ninfo: {title: [\n")
    return root

SEED = r"""
const { createCore } = await import(%(root)s + "/src/project.mjs");
const c = await createCore({ root: process.cwd() });
const s = c.store, day = 864e5, now = Date.now();
const mk = (name, source, start, reqs) => {
  const run = s.createRun(name, source); let t = start;
  for (const [method, url, status, ms, extra = {}] of reqs) {
    t += extra.gap ?? 4000 + Math.random() * 9000; delete extra.gap;
    s.addCall({ run_id: run.id, ts: new Date(t).toISOString(), source, method, url, status, duration_ms: ms, res_size: 300 + Math.floor(Math.random() * 3000),
      res_type: "application/json", req_headers: { accept: "application/json", authorization: "Bearer ••••9f2c" }, res_headers: { "content-type": "application/json" },
      res_body: JSON.stringify(extra.body || { ok: status < 400 }), ...extra, body: undefined });
  }
};
mk("claude-code", "agent", now - 3 * day + 36e6, [["GET", "https://api.stripe.com/v1/customers?limit=3", 200, 312, { note: "find a test customer" }], ["POST", "https://api.stripe.com/v1/payment_intents", 402, 377, { note: "check the card-declined path" }], ["GET", "https://api.stripe.com/v1/payment_intents/pi_3P", 200, 205]]);
mk("Your requests", "ui", now - day + 72e5, [["GET", "https://api.github.com/repos/vercel/next.js", 200, 640], ["GET", "https://api.github.com/repos/vercel/next.js/issues?state=open", 200, 980], ["GET", "https://api.github.com/rate_limit", 200, 120]]);
mk("Run: Shipping (Postman)", "ui", now - day + 216e5, [["POST", "https://sandbox.shipengine.example/v1/labels", 200, 1310, { item_name: "Shipping / Labels / Create label", expect_status: 200 }], ["GET", "https://sandbox.shipengine.example/v1/labels/se-1", 200, 233, { item_name: "Shipping / Labels / Get label", expect_status: 200 }], ["POST", "https://sandbox.shipengine.example/v1/rates", 500, 2890, { item_name: "Shipping / Rates / Estimate", expect_status: 200 }], ["DELETE", "https://sandbox.shipengine.example/v1/labels/se-1", 204, 180, { item_name: "Shipping / Labels / Void label", expect_status: 204 }]]);
console.log("seeded");
"""

AGENT = r"""
const { createCore } = await import(%(root)s + "/src/project.mjs");
const c = await createCore({ root: process.cwd() });
const run = c.store.createRun("claude-code", "agent");
const send = (o) => c.runner.send({ source: "agent", runId: run.id, ...o });
await send({ method: "GET", url: "http://localhost:4600/orders", note: "what orders are there?" });
await send({ method: "POST", url: "http://localhost:4600/login", body: { email: "dev@example.com", password: "secret" }, session: "agent", note: "log in first", capture: { "header:Authorization": "Bearer {{body.access_token}}" } });
await send({ method: "GET", url: "http://localhost:4600/orders?status=open", session: "agent" });
await send({ ...c.runner.fromOperation("getOrder", { pathParams: { orderId: "o-3" } }), session: "agent", note: "the order the spec says is broken" });
await send({ method: "POST", url: "http://localhost:4600/orders", body: { sku: "TEL-DWARF3", quantity: 2 }, session: "agent", note: "create a test order" });
await send({ method: "GET", url: "http://localhost:4600/orders?status=open", session: "agent", note: "check the new order is listed" });
console.log("agent done");
"""

# ---------------------------------------------------------------- MCP Apps test host
HOST = """<!doctype html><html><body style="margin:0;background:%(bg)s;font-family:system-ui,sans-serif;padding:18px 18px 4px">
<div style="color:%(fg)s;font-size:13px;margin:0 0 8px 2px">%(prompt)s</div>
<iframe id="f" sandbox="allow-scripts" style="width:100%%;border:0;height:300px;display:block"></iframe>
<script>
const f=document.getElementById('f'); const RESULT=%(result)s, DETAILS=%(details)s, THEME=%(theme)s;
const send=(m)=>f.contentWindow.postMessage(m,'*'); const reply=(id,result)=>send({jsonrpc:'2.0',id,result});
addEventListener('message',(e)=>{ if(e.source!==f.contentWindow) return; const m=e.data;
 if(m.method==='ui/initialize') reply(m.id,{protocolVersion:m.params.protocolVersion,hostInfo:{name:'test',version:'1'},hostCapabilities:{openLinks:{},serverTools:{}},hostContext:{theme:THEME,displayMode:'inline'}});
 else if(m.method==='ui/notifications/initialized') send({jsonrpc:'2.0',method:'ui/notifications/tool-result',params:{content:[{type:'text',text:'ok'}],structuredContent:RESULT}});
 else if(m.method==='tools/call') reply(m.id,{content:[],structuredContent:{call:DETAILS[m.params.arguments.callId]}});
 else if(m.method==='ui/notifications/size-changed') f.style.height=Math.min(m.params.height,1400)+'px';
 else if(m.id!==undefined&&m.method) reply(m.id,{}); });
f.srcdoc=%(app)s;
</script></body></html>"""
J = lambda x: json.dumps(x).replace("</", "<\\/")

VIEWS = r"""
import fs from "node:fs";
const { createCore } = await import(%(root)s + "/src/project.mjs");
const { timelineData, forView, summarise, buildAppHtml } = await import(%(root)s + "/src/html.mjs");
const c = await createCore({ root: process.cwd() });
const calls = c.store.listCalls({ limit: 1000 });
const details = Object.fromEntries(calls.map((x) => [x.id, forView(c.store.getCall(x.id))]));
const broken = calls.find((x) => x.note === "the order the spec says is broken");
const run = c.store.runs().find((r) => r.name.startsWith("Run: Demo shop"));
const runCalls = c.store.listCalls({ run: run.id, limit: 50 }).reverse().map(summarise);
fs.writeFileSync("views.json", JSON.stringify({
  timeline: { view: "timeline", ...timelineData(c.store, { limit: 1000 }), guiUrl: "http://localhost:4545", range: "all", title: "Request history" },
  call: { view: "call", call: forView(c.store.getCall(broken.id)), guiUrl: "http://localhost:4545" },
  run: { view: "run", summary: { name: run.name, total: runCalls.length, passed: runCalls.filter((x) => !x.error && (x.expect_status ? x.status === x.expect_status : x.status < 400)).length }, calls: runCalls, guiUrl: "http://localhost:4545" },
  details,
}));
fs.writeFileSync("app.html", buildAppHtml());
"""

def main():
    os.makedirs(OUT, exist_ok=True)
    root = build_project()
    q = json.dumps(ROOT)
    print("example project:", root)
    # the demo API (reuse one that's already running)
    try: urllib.request.urlopen("http://localhost:4600/orders", timeout=1)
    except urllib.error.HTTPError: pass
    except Exception: start([os.path.join(ROOT, "examples", "demo-api.mjs")], ROOT); up("http://localhost:4600/orders")
    subprocess.run([NODE, BIN, "import", os.path.join(ROOT, "examples", "demo-shop.postman_collection.json")], cwd=root, check=True, capture_output=True)
    subprocess.run([NODE, BIN, "import", os.path.join(ROOT, "examples", "demo-shop.postman_environment.json")], cwd=root, check=True, capture_output=True)
    node(SEED % {"root": q}, root)
    port = free_port()
    start([BIN, "gui", "--no-open", "--port", str(port)], root)
    gui = f"http://localhost:{port}"; up(gui + "/api/info")
    # point the collection at the demo API, make the environment active, and run it for real
    col = next(c for c in api(gui, "/api/collections") if c["name"].startswith("Demo shop"))
    api(gui, f"/api/collections/{col['id']}", "PATCH", {"variables": [{"key": "baseUrl", "value": "http://localhost:4600", "enabled": True}]})
    api(gui, "/api/environments/active", "PUT", {"id": api(gui, "/api/environments")[0]["id"]})
    api(gui, f"/api/collections/{col['id']}/run", "POST", {"session": "default"}); time.sleep(3)
    node(AGENT % {"root": q}, root)
    node(VIEWS % {"root": q}, root)
    V = json.load(open(os.path.join(root, "views.json"))); APP = open(os.path.join(root, "app.html")).read()
    subprocess.run([NODE, BIN, "report", "--out", os.path.join(root, "report.html")], cwd=root, check=True, capture_output=True)

    with sync_playwright() as p:
        b = p.chromium.launch()
        def page(w=1400, h=840, scheme="light"):
            pg = b.new_page(viewport={"width": w, "height": h}, color_scheme=scheme)
            pg.goto(gui); pg.wait_for_timeout(1500); return pg
        def shot(pg, name, **kw): pg.wait_for_timeout(400); pg.screenshot(path=os.path.join(OUT, name), **kw); print("  ", name)
        def tree(pg, label): pg.locator(f".node:has-text('{label}') .nm").first.click(); pg.wait_for_timeout(500)
        def row(pg, text): pg.locator(f".dl-row:has-text('{text}')").first.click(); pg.wait_for_timeout(600)

        # The feed, dark: first, so the newest cards are the agent's
        pg = page(scheme="dark"); pg.click(".node:has-text('Feed')"); pg.wait_for_timeout(1500)
        pg.locator(".card").last.locator("text=Expand").click(); pg.wait_for_timeout(800)
        pg.evaluate("document.querySelector('.feed-scroll').scrollTop = 1e6"); shot(pg, "gui-feed-dark.png")
        # The request view, with a real response
        pg = page(); tree(pg, "Demo shop (Postman)"); pg.locator(".dl-row.folder").first.click(); pg.wait_for_timeout(400)
        row(pg, "List open orders"); pg.click("#cmdSend"); pg.wait_for_timeout(1200)
        if pg.locator("[data-view=table]").count(): pg.click("[data-view=table]")
        shot(pg, "gui-request.png")
        # Drafts: an edited request, marked in the title, the list and the tree
        row(pg, "Get order"); pg.locator(".urlwrap input").click(); pg.keyboard.press("End"); pg.keyboard.type("?expand=items")
        pg.wait_for_timeout(500); shot(pg, "drafts.png")
        # Schema mismatches, highlighted on the field
        pg = page(); pg.locator(".node:has-text('All requests')").click(); pg.wait_for_timeout(500)
        row(pg, "/orders/o-3"); shot(pg, "schema.png")
        # Compare two responses
        pg.locator(".dl-row:has-text('/orders?status=open')").first.click(); pg.wait_for_timeout(600)
        pg.click(".subtab:has-text('Compare')"); pg.wait_for_timeout(900)
        pg.evaluate("document.querySelector('.diff .a, .diff .d')?.scrollIntoView({ block: 'center' })"); shot(pg, "compare.png")
        # A collection run
        pg = page(); tree(pg, "Demo shop (Postman)"); pg.click(".summary .btn.primary"); pg.wait_for_timeout(3500); shot(pg, "collection-run.png")
        # API specs found in the project
        pg = page(); tree(pg, "Billing (legacy)"); shot(pg, "specs.png")
        # The timeline, light and dark
        for scheme, name in [("light", "timeline.png"), ("dark", "timeline-dark.png")]:
            pg = page(h=900, scheme=scheme); pg.click(".node:has-text('Timeline')"); pg.wait_for_timeout(1000); shot(pg, name)
        # A narrow pane, as in a terminal split
        pg = page(w=760, h=820, scheme="dark"); pg.click("#toggleSide"); pg.wait_for_timeout(300)
        pg.goto(gui + "/#call-" + str(max(V["details"], key=int))); pg.wait_for_timeout(1500); shot(pg, "narrow.png")
        # Postman import (last: it adds a second copy of the collection)
        pg = page(); pg.click("#importBtn"); pg.wait_for_timeout(300)
        pg.fill(".dlg textarea", open(os.path.join(ROOT, "examples", "demo-shop.postman_collection.json")).read())
        pg.click(".dlg .btn.primary"); pg.wait_for_timeout(1200); shot(pg, "import.png")


        # The agent's in-reply views, in a test host speaking the MCP Apps protocol
        def host(result, theme, prompt, name, w=920, h=780, after=None, fit=False):
            pg = b.new_page(viewport={"width": w, "height": h})
            pg.set_content(HOST % {"bg": "#1f1f1f" if theme == "dark" else "#f4f4f2", "fg": "#bbb" if theme == "dark" else "#666", "prompt": prompt,
                                   "result": J(result), "details": J(V["details"]), "theme": J(theme), "app": J(APP)})
            pg.wait_for_timeout(1600)
            if after: after(pg.frame_locator("#f")); pg.wait_for_timeout(900)
            shot(pg, name, full_page=fit)
        host(V["timeline"], "dark", 'Claude (test MCP Apps host): <i>"Show me what happened with the APIs today"</i>', "agent-view.png",
             after=lambda fr: fr.locator(".av-row:has-text('/orders/o-3')").first.click())
        host(V["call"], "light", 'Claude (test MCP Apps host): <i>"Get order o-3"</i>', "agent-request.png", h=120, fit=True)
        host(V["run"], "dark", 'Claude (test MCP Apps host): <i>"Run the demo shop collection"</i>', "agent-run.png", h=120, fit=True)

        # The HTML report, offline
        pg = b.new_page(viewport={"width": 1100, "height": 760})
        pg.route("**/*", lambda r: r.abort() if not r.request.url.startswith(("file:", "data:")) else r.continue_())
        pg.goto("file://" + os.path.join(root, "report.html")); pg.wait_for_timeout(800)
        pg.locator(".av-row:has-text('payment_intents')").first.click(); shot(pg, "report.png")
        b.close()

    for f in os.listdir(OUT):  # strip alpha and compress
        if f.endswith(".png") and f not in ("banner.png", "social-preview.png"):
            Image.open(os.path.join(OUT, f)).convert("RGB").save(os.path.join(OUT, f), optimize=True)

if __name__ == "__main__":
    try: main()
    finally:
        for p in procs: p.terminate()
