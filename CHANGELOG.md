# Changelog

## 0.7.0

- **Signs in for you.** Describe how to sign in to each API once, in `"auth"` in `jodrell.config.json`, and jodrell signs in when a request needs it, adds the token, and signs in again when it expires or the API returns 401. It supports:
  - a login request, from your spec or a URL
  - OAuth 2 client credentials
  - a command that prints a token
  - a fixed token or API key
  
  Secrets come from `.env` or your environment, as `{{env.NAME}}`. Where the token goes is read from the spec's `securitySchemes`.
- **See sign-in at a glance in the GUI:** a Sign-in section shows each API as signed in, expiring, expired or needing you (with the reason). Open one to sign in again, open its sign-in request to try it by hand, see the last sign-in, or sign out. The status bar and the request builder show it too.
- **For your agent:** `auth_status` and `sign_in` tools, and `auth: false` on `send_request` and `call_operation`.
- **Sign-in calls are masked:** passwords, client secrets and tokens in their bodies aren't stored.
- **Security review.** A full audit of the server, rendering, secrets and code execution, with every finding fixed:
  - **Critical:** a cookie with `Domain=__proto__` from any API could change JavaScript's built-in objects and make an auth profile run a command. Cookie domains must now cover the host that set them, and auth settings are read in a way that can't be affected.
  - **A project's auth profiles need your approval** (GUI or `npx jodrell trust`) before they sign in or run anything, so a cloned repository can't.
  - **`{{env.NAME}}` only goes into an auth profile's own sign-in request,** never ordinary requests.
  - **The GUI server** now blocks DNS rebinding, other local apps' pages, cross-site form posts and framing, and links use `127.0.0.1`.
  - **Tokens no longer reach lookalike hosts** (`api.test.evil.example`, other ports): base URLs are matched by origin and path.
  - **More is masked:** short secrets entirely, more header names, secret query parameters, passwords in request bodies, and sign-in tokens whatever they're called. Replay only re-sends secrets to the same host.
  - **Copy as curl** quotes every argument, and terminal output can't be hijacked by escape sequences.
  - **Hostile files can't hang jodrell:** specs with deep `$ref` chains, paths full of parameters, long script lines and long `.env` lines, and the guard's own pattern.
  - **Also:** a committed `.jodrell/server.json` can't redirect jodrell; `init` won't write through symbolic links; `appUrl` is only probed on your computer; parse errors don't quote other files; malformed HTTP methods are refused.
- **Fixed:** replay could pick up saved auth headers from another project open in the same process.
- **README:** where jodrell came from, a guide to getting a good spec, and a new Signing in section.

## 0.6.0

- **Renamed to jodrell,** after the Jodrell Bank observatory. Another open-source tool for AI coding agents is also called capcom, uses the same `.capcom/` folder and the same commands, and "Capcom" is a registered trademark of the games company.
- **Moving across is automatic:** run `npx jodrell init`.
  - Your history moves from `.capcom/` (or `.apiscope/`) to `.jodrell/`.
  - Old config files and saved browser drafts keep working.
  - `init` replaces the old agent entry, permission, guard hook, `CLAUDE.md` section and `.gitignore` line.
- **The other capcom tool is safe.** A `.capcom/` folder is only moved if it holds nothing but this tool's files, and the other capcom's hooks, `AGENTS.md` section and committed `.capcom/` folder are never touched.
- **The guard's override** is now `JODRELL_ALLOW=1`.

## 0.5.0

- **Testing:** a full automated suite (about 125 unit and integration tests, around 96% line coverage) and an end-to-end test plan in `docs/testing/E2E.md`. Run it with `npm test`.
- **Fixed:** Export HTML in the GUI now saves the report, rather than reporting an undefined path.
- **Fixed:** masked cookies no longer show the first characters of their values.
- **Fixed:** an HTML response where the spec promises JSON is now flagged as a mismatch.
- **Fixed:** path parameters that a spec forgets to declare are now required, rather than sent as `undefined`.
- **Fixed:** hiding the navigation pane collapsed the whole workspace to nothing, at any width.
- **Fixed:** at narrow widths (such as a terminal split), the page was a few pixels too wide and scrolled sideways.
- **Ready for GitHub:** README with screenshots, licence, CI, contribution guide and security policy.
- **Positioned as the AI-first API client:** an alternative to Postman, Bruno and Insomnia, with a fair comparison in the README.
- **Fixed:** the pixel heading font's "fi" ligature made words like "first" hard to read.
- **Screenshots are generated** by `assets/screenshots.py`, from an example project and the demo API, so they can be refreshed after any change.

## 0.4.0

- **Renamed to capcom.** Existing projects move across automatically: `.apiscope/` becomes `.capcom/`, the old config still works, and `init` replaces the old agent entry.
- **The guard:** a Claude Code hook that redirects the agent's direct curl, wget and fetch calls to capcom. `init` also adds agent instructions and pre-approves capcom's tools.
- **A 90s-style pixel-art icon,** used in the GUI, reports and the agent views.

## 0.3.0

- **Install it in a project.** The agent starts it over stdio, and data lives in `.capcom/`.
- **Views in the agent's replies,** via MCP Apps: requests, collection runs and the timeline.
- **The timeline,** in the GUI, the agent's replies and a self-contained HTML report.
- **Automatic spec discovery** across the whole project, including specs served by the running app, Swagger 2.0, and live reloading.
- **A new GUI:** an Explorer-style layout with no tabs, drafts kept automatically, three panes, a feed, and a green "meadow" theme.

## 0.2.0

- **Postman collections and environments:** import, run, and convert common test scripts into captures and checks.
- **A full request builder:** params, headers, body types, auth, curl paste, compare and a collection runner.
- **Sessions:** cookies and auth headers scoped to their host.

## 0.1.0

- **First version:** the agent calls APIs through MCP, using your OpenAPI spec, with a live web view of every request.
