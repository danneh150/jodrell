# Contributing to jodrell

Thanks for helping. A few things make changes easy to review.

## Getting started

```bash
git clone https://github.com/danneh150/jodrell && cd jodrell
npm install
npm test              # about 125 tests, around 15 seconds, no network needed
npm run demo          # a demo API on :4600
npx jodrell gui        # the GUI, using this folder as the project
```

To try your changes in a real project, run `npm pack` here and `npm i -D path/to/jodrell-<version>.tgz` there, or use `npm i -D ../jodrell` to work on it live.

## How the code is laid out

| Path | What's there |
| --- | --- |
| `bin/jodrell.mjs` | The command line |
| `bin/guard.mjs` | The Claude Code hook that sends the agent's API calls through jodrell |
| `src/project.mjs` | Finding the project, config, the data folder, keeping specs current |
| `src/mcp.mjs` | The tools the agent uses (MCP), and the in-reply views |
| `src/server.mjs` | The GUI's local server and HTTP API |
| `src/runner.mjs` | Sending requests: sessions, cookies, captures, collection runs |
| `src/collections.mjs` | Collections, environments, Postman import, resolving variables and auth |
| `src/spec.mjs`, `src/discover.mjs` | Loading and finding OpenAPI and Swagger specs |
| `src/store.mjs` | The SQLite database in `.jodrell/` |
| `src/html.mjs` | The HTML report and the in-reply view |
| `ui/` | The GUI (`index.html`), the shared timeline (`view.js`, `view.css`), font and icons |
| `test/` | Unit and integration tests; see `docs/testing/README.md` |
| `assets/` | Scripts that draw the icon and banner |

## Guidelines

- **No new runtime dependencies** without a good reason: jodrell installs into other people's projects.
- **Nothing leaves the machine** except the requests the user or agent sends. No telemetry, and no fonts or scripts from CDNs.
- **Secrets stay masked** in the history, the GUI, agent replies and reports. Add a test if you touch anything that records headers.
- **Tests**: new behaviour comes with a unit or integration test. Use `tmpProject()`, `makeCore()` and `fakeApi()` from `test/helpers.mjs`, with no network and no fixed ports.
- **GUI changes**: check the relevant cases in `docs/testing/E2E.md`, in light and dark, and at a narrow width.
- **Writing**: user-facing text in plain British English. Short sentences, and say what happened and what to do next.

## The icon and banner

They're drawn by code, so they can be tweaked and regenerated:

```bash
python3 assets/icon-source.py   # needs Pillow: pip install pillow
python3 assets/banner.py
```
