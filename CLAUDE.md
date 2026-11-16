# jodrell: notes for working on this repo

jodrell is **the AI-first API client**: an alternative to Postman, Bruno and Insomnia, where the *agent* is the main user and the human watches and steps in. It installs into a project (`npm i -D jodrell && npx jodrell init`). The agent runs it over stdio as an MCP server, and every request goes into a history shown in agent replies (MCP Apps), a GUI (browser or Pixel terminal pane), a timeline and an HTML report.

`README.md` is the user-facing source of truth. This file is for working on the code.

## Commands

```bash
npm test                    # 166 unit + integration tests, ~5 s, no network (run npm ci first in a fresh clone)
npm run test:unit           # test/unit
npm run test:integration    # test/integration
npm run test:coverage       # ~96% line coverage
npm run demo                # demo shop API on :4600 (password: secret)
npm run fake-api            # the test suite's fake API on :4610
node bin/jodrell.mjs gui    # the GUI, using this folder as the project
python3 assets/screenshots.py   # regenerate every README screenshot (Pillow + Python Playwright, same version as the installed browser)
python3 assets/banner.py        # regenerate the banner and social preview
python3 assets/icon-source.py   # regenerate the pixel-art icon
```

## Code map

| Path | What's there |
| --- | --- |
| `bin/jodrell.mjs` | CLI: `init`, `mcp`, `gui`, `open`, `report`, `import`, `watch`, `show`, `guard` |
| `bin/guard.mjs` | Claude Code `PreToolUse` hook: blocks direct curl/wget/fetch API calls, points the agent to `send_request`. Must stay dependency-free and fast (~30 ms) |
| `src/project.mjs` | Project root, config, `.jodrell/` data folder, migrations, spec discovery and watching, one shared GUI per project (`.jodrell/server.json`) |
| `src/mcp.mjs` | All MCP tools, and the MCP Apps views (`ui://jodrell/view.html`) |
| `src/server.mjs` | The GUI's local HTTP API and SSE. Polls `PRAGMA data_version` to pick up writes from other processes |
| `src/runner.mjs` | Sending requests: sessions, host-scoped cookies and auth headers, captures, collection runs, replay, auth profiles applied and the 401 retry |
| `src/auth.mjs` | Auth profiles (`"auth"` in config): signing in, token placement from `securitySchemes`, expiry, state for the GUI, `.env` reading |
| `src/collections.mjs` | Collections, environments, Postman import, script-to-capture conversion, variable and auth resolution |
| `src/spec.mjs`, `src/discover.mjs` | OpenAPI 3 / Swagger 2 loading, base URLs, discovery by content, probing the running app |
| `src/store.mjs` | SQLite (`node:sqlite`) in `.jodrell/history.db`, with column migrations |
| `src/html.mjs` | HTML report and the MCP Apps view, both self-contained |
| `ui/index.html` | The whole GUI: one file, no build step |
| `ui/view.js`, `ui/view.css` | The timeline and request detail, shared by the GUI, report and MCP Apps view |
| `test/helpers.mjs` | `tmpProject()`, `makeCore()`, `fakeApi()`, `startGui()`, `nextEvent()` |

## Decisions (and why)

- **Name history: apiscope → capcom → jodrell.** capcom was dropped because another tool for AI coding agents is called capcom. It uses the same `.capcom/` folder (committed to git) and the same commands, and "Capcom" is also a games-company trademark. Migration code must keep working for both old names.
- **Protect the other capcom tool.** Only move `.capcom/` if it contains nothing but our files (`history.db*`, `server.json`, `reports`). `init` removes only our old artefacts: the exact `.gitignore` block, `npx capcom mcp` entries, `<!-- capcom:start -->` blocks, `mcp__capcom`, and hooks containing `capcom/bin/guard.mjs`. Never touch `<!-- BEGIN CAPCOM -->` blocks or other `capcom` hooks. Tests cover this.
- **Local and private:** no account, cloud or telemetry, and nothing loaded from the web. The font and icons are bundled, and reports embed them.
- **Secrets:** masked before storage or display. Cookies show names and attributes only (`sid=••••; HttpOnly`). Raw secret headers for replay live in memory only. Cookies and captured auth headers are scoped to the host that issued them.
- **Postman scripts are never executed.** Common lines (`pm.environment.set(...)`, status checks) are converted into captures and `expectStatus`.
- **MCP Apps uses `@modelcontextprotocol/ext-apps@1.7.5`,** the last release compatible with `@modelcontextprotocol/sdk` 1.x. Don't upgrade to ext-apps 2.x without moving to SDK 2. The view inlines `app-with-deps.js`, rewriting its final `export` to `window.McpApps`.
- **GUI design:** an Explorer-style layout with no tabs. One thing open at a time; drafts auto-saved (localStorage `jodrell:` keys, migrated from `capcom:`/`apiscope:`); a three-pane list/detail view; the feed as the home view. Green "meadow" theme with a dark "night meadow" variant. Pixelify Sans for headings only, with ligatures turned off (its "fi" reads as "A").
- **Auth profiles:** tokens live in the `auth_state` table in `.jodrell/history.db` (git-ignored), so the GUI and the agent's process share one sign-in; passwords and client secrets are never stored, only read from `.env`/the environment when signing in. Config is read fresh on each use, so edits apply without a restart. A request's own auth always wins over a profile. Sign-in request and response bodies go through `redactBody`. Tokens jodrell adds aren't kept for replay: replay adds the current one.
- **Security model (from the November 2026 audit):** the GUI server checks Host (DNS rebinding), accepts only its own Origin, requires JSON for `/api` writes, and sends no-frame headers. Auth profiles need approval (`trustFile()` in auth.mjs, outside the project, keyed by root + profile settings); `{{env.*}}` is only filled into a profile's own sign-in request; config is read through `plain()` (no prototype). Cookie domains must cover the issuing host. History masks secret headers, query params and body fields (`redactUrl`/`redactBody`); replay restores real values from memory, same host only. Don't build regexes from whole spec paths or untrusted strings: see `test/unit/slow-inputs.test.mjs`. Known accepted risk: other local OS users can reach the GUI server (no per-run token yet).
- **Positioning:** "the AI-first API client". Postman, Bruno and Insomnia all have AI features, so the claim is that the agent is the primary user, not that the others lack AI. Keep the README comparison fair and dated.

## Conventions

- No new runtime dependencies without a strong reason. It installs into other people's projects.
- Every behaviour change comes with a test. Use the helpers, with no network and no fixed ports. Don't use `spawnSync` when the fake API runs in the same process: it deadlocks.
- User-facing text: plain British English, short sentences, saying what happened and what to do next.
- GUI changes: check light and dark, and narrow widths (~760 px, the size of a terminal split). Run `assets/screenshots.py` and look at the results; it has caught real layout bugs.
- After UI changes, regenerate the screenshots so the README stays accurate.

## Gotchas found the hard way

- `.main.noside` must be `grid-template-columns: minmax(0, 1fr)`. The hidden tree leaves the grid, so a `0 1fr` template squashes the workspace to nothing.
- `body` needs `grid-template-columns: minmax(0, 1fr)`, or narrow widths overflow sideways.
- fetch refuses some ports (1, 9…), so use `closedPort()` in tests. HTML error pages where a spec promises JSON count as schema mismatches.
- Spec path parameters must come from the path template too (`{id}`), not only the declared parameters.

## Status (November 2026)

- **v0.7.0 is ready to publish** from `main` on github.com/danneh150/jodrell. Next steps:
  1. Upload `docs/images/social-preview.png` in the repo settings, and add the topics listed in the README section on GitHub.
  2. Run `npm login && npm publish` to claim the unscoped `jodrell` name (free when last checked).
- **Not yet tested for real:** the MCP Apps views in real hosts (Claude Desktop, VS Code; tested only in a protocol-accurate test host), and Pixel mouse and keyboard in a real terminal. See `docs/testing/E2E.md`; the starred cases are the smoke test.
- **Ideas, roughly in priority order:**
  1. a recording proxy, so requests from the app and tests appear too
  2. collections as files in git
  3. a CLI collection runner for CI
  4. Postman export
  5. notebooks
  6. more protocols (WebSocket, gRPC)
  7. browser-based sign-in (OAuth authorisation code, SSO)
