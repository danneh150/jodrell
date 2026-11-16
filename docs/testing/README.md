# Testing jodrell

Two layers, so between them everything is covered.

## Automated tests

```bash
npm test                  # everything (about 15 seconds)
npm run test:unit         # one module at a time
npm run test:integration  # the real pieces together
npm run test:coverage     # with a coverage report
```

They use Node's built-in test runner. Everything runs locally: each test gets its own temporary project and database, and talks to a fake API (`test/helpers.mjs`), so no network or external services are needed.

| Folder | What it covers |
| --- | --- |
| `test/unit/checks` | Masking secrets (including cookies) and validating responses against schemas |
| `test/unit/spec` | Loading OpenAPI 3 and Swagger 2 specs, base URLs, matching URLs to operations |
| `test/unit/discover` | Finding specs in a project, and asking a running app for its spec |
| `test/unit/collections` | Postman import, collections and folders, environments, script conversion |
| `test/unit/resolve` | Variables, inherited auth and body types, in what's actually sent |
| `test/unit/store` | The project database, including upgrading older databases |
| `test/unit/auth` | Auth profiles: signing in automatically, expiry, signing in again after a 401, other sign-in methods, the GUI's status |
| `test/unit/slow-inputs` | Hostile specs, scripts, `.env` files and commands can't make jodrell or the guard hang |
| `test/unit/runner` | Sending requests, sessions and cookies, captures, collection runs, replay |
| `test/unit/html` | The HTML report, the agent's in-reply view, timeline data |
| `test/unit/project` | Project root, config, the data folder, spec sources and watching |
| `test/unit/guard` | The Claude Code hook: what it blocks and allows, and its protocol |
| `test/unit/term` | Terminal output |
| `test/integration/http-api` | The GUI's HTTP API, end to end |
| `test/integration/mcp` | Every agent tool, through a real MCP client |
| `test/integration/stdio` | jodrell as the agent starts it, inside a project |
| `test/integration/cli` | The command line (`init`, `import`, `report` and more) as a separate process |
| `test/integration/cross-process` | The GUI seeing requests made by another process |

Coverage is about 96% of lines. The interactive commands (`gui`, `watch`, `open`) are covered by the end-to-end plan instead.

**Adding a test:** use `tmpProject()`, `makeCore()` and `fakeApi()` from `test/helpers.mjs`, and add a route to the fake API if you need new behaviour. Tests must not use the network or fixed ports.

## End-to-end tests

[`E2E.md`](E2E.md) is the plan for what needs a real agent, host, terminal, browser or person: 127 cases, of which 33 are a smoke test to run before every release. `npm run fake-api` starts the fake API on port 4610 for manual testing.
