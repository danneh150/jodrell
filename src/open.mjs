// Opening the GUI: a Pixel pane in the terminal when possible, otherwise the browser.
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const a = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try { spawn(opener, a, { stdio: "ignore", detached: true }).on("error", () => {}).unref(); return true; } catch { return false; }
}

export async function pixel() {
  try {
    const bin = path.join(path.dirname(require.resolve("@zenbu-labs/pixel/package.json")), "dist", "bin.js");
    const terminal = await import("@zenbu-labs/pixel/terminal");
    return { bin, terminal, command: (url) => [process.execPath, bin, path.join(ROOT, "pixel", "main.cjs"), "--", url] };
  } catch { return null; }
}

// split: "right" | "down" | null. Returns a sentence saying what happened.
export async function openGui(url, { split = "right" } = {}) {
  if (split) {
    const px = await pixel();
    if (px) {
      try {
        const t = px.terminal.detect(process.env);
        if (t && px.terminal.canSplit(t)) {
          const tty = px.terminal.callerTty?.();
          const pane = await t.getCurrentPane?.({ tty: tty?.path ?? null, cwd: process.cwd() });
          if (pane) {
            await t.split({ from: pane, direction: split, command: px.command(url), size: null, tty: null });
            return `Opened jodrell in a split pane (${t.name})`;
          }
        }
      } catch {}
    }
  }
  return openBrowser(url) ? "Opened jodrell in the browser" : "Couldn't open a browser here";
}
