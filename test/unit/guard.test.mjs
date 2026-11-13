// The Claude Code hook that sends the agent's API calls through jodrell.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { checkBash, checkWebFetch } from "../../bin/guard.mjs";
import { GUARD, tmpProject } from "../helpers.mjs";

describe("deciding what to block", () => {
  test("direct API calls in every common form", () => {
    for (const c of [
      "curl https://api.github.com/repos/vercel/next.js",
      `curl -s -X POST http://localhost:3000/api/orders -d '{"a":1}' | jq .`,
      "cd api && curl -fsS localhost:4600/health", "echo start; curl https://api.example.com/x; echo done",
      "TOKEN=abc curl -H 'Authorization: Bearer x' https://api.stripe.com/v1/customers", "sudo curl http://10.0.0.5/status",
      "RES=$(curl -s https://api.example.com/token)", "env -i FOO=1 curl https://a.test",
      "http POST :3000/login email=a@b.c", "https GET example.com/api", "xh get httpbin.org/json", "wget -qO- https://api.example.com/v1/things",
      "Invoke-RestMethod https://api.example.com", `node -e "fetch('http://localhost:3000/api').then(r => r.json())"`,
      `python3 -c "import requests; requests.get('https://api.example.com')"`, `python -c "import urllib.request as u; u.urlopen('https://a.test')"`,
    ]) assert.ok(checkBash(c), `should block: ${c}`);
  });
  test("downloads, installs, mentions and everything else are left alone", () => {
    for (const c of [
      "curl -fsSL https://bun.sh/install | bash", "curl -fsSL https://get.example.sh | sudo sh", "curl -L -o node.tar.gz https://nodejs.org/x.tar.gz",
      "curl -LO https://github.com/x/y.tgz", "curl --output a.zip https://a.test/a.zip", "curl https://example.com/a.tgz | tar xz",
      "wget https://example.com/file.zip", "curl --version", "curl --help", "git clone https://github.com/vercel/next.js",
      "npm install && npm test", `echo "see https://api.example.com"`, `grep -r "curl" docs/`, "cat scripts/curl-examples.sh",
      "open http://localhost:3000", "JODRELL_ALLOW=1 curl https://api.example.com/x", "curl https://a.test # jodrell: allow", "",
    ]) assert.equal(checkBash(c), null, `should allow: ${c}`);
  });
  test("pulls out the URL to suggest", () => {
    assert.equal(checkBash("curl -s 'https://api.test/v1/x?a=1' | jq").url, "https://api.test/v1/x?a=1");
  });
  test("WebFetch: docs are fine, local and private addresses go through jodrell", () => {
    for (const u of ["http://localhost:3000/api", "http://127.0.0.1:4600", "http://[::1]:80/", "http://192.168.1.20/api", "http://10.1.2.3", "http://172.20.0.2", "http://shop.local/api", "http://svc.internal/x"]) assert.ok(checkWebFetch(u), u);
    for (const u of ["https://docs.stripe.com/api", "https://developer.mozilla.org/", "http://172.32.0.1", "not a url"]) assert.equal(checkWebFetch(u), null, u);
  });
});

describe("the hook protocol", () => {
  const run = (input, env = {}) => execFileSync(process.execPath, [GUARD], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...process.env, ...env } }).toString();
  test("denies with a reason that tells the agent exactly what to do", () => {
    const out = JSON.parse(run({ tool_name: "Bash", tool_input: { command: "curl http://localhost:4600/orders" } }));
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /send_request.*localhost:4600\/orders.*JODRELL_ALLOW=1/s);
  });
  test("stays silent for everything else, including bad input", () => {
    assert.equal(run({ tool_name: "Bash", tool_input: { command: "ls" } }), "");
    assert.equal(run({ tool_name: "Edit", tool_input: { file_path: "x" } }), "");
    assert.equal(run("not json"), "");
    assert.equal(run(""), "");
  });
  test("follows the project's guard setting: ask, or off", () => {
    const ask = tmpProject({ "jodrell.config.json": { guard: "ask" } });
    assert.equal(JSON.parse(run({ tool_name: "Bash", tool_input: { command: "curl https://a.test" } }, { CLAUDE_PROJECT_DIR: ask })).hookSpecificOutput.permissionDecision, "ask");
    const off = tmpProject({ "jodrell.config.json": { guard: "off" } });
    assert.equal(run({ tool_name: "Bash", tool_input: { command: "curl https://a.test" } }, { CLAUDE_PROJECT_DIR: off }), "");
  });
});
