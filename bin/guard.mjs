#!/usr/bin/env node
// jodrell guard: a Claude Code PreToolUse hook. It stops the agent calling APIs
// directly (curl, wget, HTTPie, inline fetch...) so every request goes through
// jodrell, where you can see it. Downloads, installs and docs pages are left alone.
// Kept dependency-free and small: it runs before every shell command.
import fs from "node:fs";
import path from "node:path";

// Commands that make HTTP requests, when used as a command (not inside a URL).
const CLIENTS = "curl|wget|http|https|xh|xhs|httpie|Invoke-WebRequest|Invoke-RestMethod|iwr|irm";
const CMD_START = String.raw`(?:^|[;&|(\x60\n]|\$\(|&&|\|\|)\s*(?:sudo\s+|command\s+|time\s+|env\s+(?:-\S+\s+)*(?:\w+=\S*\s+)*|(?:\w+=\S*\s+)+)*`;
const CLIENT_RE = new RegExp(`${CMD_START}(${CLIENTS})(?=\\s|$)`, "i");
const INLINE_RE = [
  /\b(?:node|deno|bun|tsx)\s+(?:-e|--eval|-p|--print)\b[\s\S]*\b(?:fetch|axios|got|http\.request|https\.request)\s*\(/,
  /\bpython3?\s+-c\b[\s\S]*\b(?:requests\.(?:get|post|put|patch|delete|head|request)|urllib\.request|http\.client|httpx\.)/,
  /\bruby\s+-e\b[\s\S]*\bNet::HTTP\b/,
];
const ESCAPE = /\bJODRELL_ALLOW=1\b|#\s*jodrell:\s*allow\b/i;

// Not API calls: saving a file, piping into a shell or an unpacker, or asking for help.
function isDownloadOrHarmless(cmd, client) {
  if (/\s(--version|-V|--help|-h)(\s|$)/.test(cmd) && !/https?:\/\//.test(cmd)) return true;
  if (/^(curl)$/i.test(client) && /\s(-o|-O|--output|--remote-name|--remote-name-all|-OJ|-JO)(\s|=|$)|\s-o\S|\s-\w*O\w*(\s|$)/.test(cmd)) return true;
  if (/^wget$/i.test(client) && !/\s(-O\s*-|-qO-|-qO\s*-|--output-document=-|-O-)(\s|$)/.test(cmd)) return true; // wget saves to a file by default
  if (/\|\s*(sudo\s+)?(sh|bash|zsh|fish|tar|unzip|gunzip|gzip|xz|bsdtar|python3?|node|install)\b/.test(cmd)) return true;
  return false;
}

export function checkBash(cmd) {
  if (!cmd || ESCAPE.test(cmd)) return null;
  const m = cmd.match(CLIENT_RE);
  if (m && !isDownloadOrHarmless(cmd, m[1])) return { what: m[1], url: (cmd.match(/https?:\/\/[^\s'"`)]+/) || [])[0] };
  for (const re of INLINE_RE) if (re.test(cmd)) return { what: "an inline HTTP call", url: (cmd.match(/https?:\/\/[^\s'"`)]+/) || [])[0] };
  return null;
}

// WebFetch is for reading docs on the web; local and private APIs go through jodrell.
export function checkWebFetch(url) {
  let host;
  try { host = new URL(url).hostname.replace(/^\[|\]$/g, ""); } catch { return null; }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|.*\.local|.*\.localhost|.*\.internal|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/i.test(host);
  return local ? { what: "WebFetch on a local API", url } : null;
}

function mode() {
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  for (const f of ["jodrell.config.json", "capcom.config.json", "apiscope.config.json"]) {
    try { const g = JSON.parse(fs.readFileSync(path.join(root, f), "utf8")).guard; if (g) return g; } catch {}
  }
  return "block";
}

function reason(hit) {
  return [
    `Please make this request through jodrell instead of ${hit.what}, so the user can see it in jodrell's history and GUI.`,
    hit.url ? `Use the send_request tool with { "method": "...", "url": "${hit.url}", "headers": {...}, "body": ... }.` : "Use the send_request tool (or call_operation / run_request if it's in a spec or a saved collection).",
    "Session cookies and captured auth work across calls; secrets are masked in the history.",
    "Only if the user explicitly asked for this command to be run directly, prefix it with JODRELL_ALLOW=1.",
  ].join(" ");
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let data;
  try { data = JSON.parse(input || "{}"); } catch { return; } // not for us: let it run
  const m = mode();
  if (m === "off") return;
  const tool = data.tool_name;
  const hit = tool === "Bash" ? checkBash(data.tool_input?.command) : tool === "WebFetch" ? checkWebFetch(data.tool_input?.url) : null;
  if (!hit) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: m === "ask" ? "ask" : "deny", permissionDecisionReason: reason(hit) } }));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("guard.mjs")) main().catch(() => {});
