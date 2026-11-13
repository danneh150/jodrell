// The GUI in one process sees requests the agent makes from another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { ROOT, fakeApi, makeCore, startGui, nextEvent, sleep } from "../helpers.mjs";

test("a request made by another process shows up in the open GUI", async () => {
  const api = await fakeApi();
  const core = await makeCore();
  const gui = await startGui(core);
  try {
    const seen = nextEvent(gui.url, (e, d) => e === "call" && d.url.endsWith("/echo/from-elsewhere"));
    await sleep(150);
    const script = `const { createCore } = await import(${JSON.stringify(ROOT + "/src/project.mjs")});
      const c = await createCore({ root: ${JSON.stringify(core.root)} });
      await c.runner.send({ method: "GET", url: ${JSON.stringify(api.url + "/echo/from-elsewhere")}, source: "agent" });`;
    // Not spawnSync: the fake API lives in this process and has to keep answering.
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = ""; child.stderr.on("data", (d) => (stderr += d));
    const code = await new Promise((r) => child.on("exit", r));
    assert.equal(code, 0, stderr);
    const { data } = await seen;
    assert.equal(data.source, "agent");
  } finally { await gui.close(); await api.close(); }
});
