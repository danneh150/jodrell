# jodrell end-to-end test plan

This plan covers what the automated tests can't check: real agents and hosts, the GUI in a browser, Pixel in a real terminal, and how it all looks and feels. The automated suite (`npm test`, about 125 tests) already covers the logic underneath: import, variables, auth, cookies, the guard, the HTTP API, every MCP tool and the command line. So these cases concentrate on what a person (or an agent driving a browser) needs to see.

- **Smoke test** (about 20 minutes, before every release): the cases marked ★.
- **Full pass** (a few hours, before a major release or after big UI changes): everything.

Record results in the table at the end. Each case has an ID (for example `GUI-REQ-03`), so failures can be referenced in issues.

---

## 1. Setup

### Prerequisites

- Node 22.13 or newer
- Claude Code; Claude Desktop or VS Code with Copilot (for the in-reply views)
- A Pixel-capable terminal for section 15 (Ghostty, iTerm2, WezTerm or kitty), and tmux
- Chrome, Firefox and Safari for the GUI

### Fixtures

Run each of these in its own terminal from the jodrell folder:

| Fixture | Command | Address | What it's for |
| --- | --- | --- | --- |
| Demo shop API | `npm run demo` | http://localhost:4600 | Login (password `secret`), orders. Order `o-3` deliberately breaks the spec. |
| Fake API | `npm run fake-api` | http://127.0.0.1:4610 | Echo, any status code, redirects, slow, large, binary and hostile HTML responses, `/v3/api-docs` |

The test data files are:

- `examples/demo-shop.postman_collection.json` and `examples/demo-shop.postman_environment.json`
- `examples/openapi.yaml`

### A fresh test project

```bash
cd jodrell && npm pack                      # creates jodrell-<version>.tgz
mkdir /tmp/e2e && cd /tmp/e2e && git init && npm init -y
cp ~/code/jodrell/examples/openapi.yaml ./openapi.yaml
npm i -D ~/code/jodrell/jodrell-*.tgz
```

Reset between runs with `rm -rf .jodrell`. In the browser, clear site data for `localhost`, because drafts and settings are kept in local storage.

### The monorepo fixture (section 12)

```bash
mkdir -p /tmp/mono/{apps/api/dist,docs/old,services/billing,test/fixtures,node_modules/sdk,.next/cache}
cd /tmp/mono && git init && npm init -y
# apps/api/dist/openapi.json: an OpenAPI 3 spec with no "servers"
# docs/old/openapi.json: the same spec (same title and version), with an older modification time
# services/billing/swagger.yaml: a Swagger 2.0 spec with host localhost:4600
# test/fixtures/broken.yaml: "openapi: 3.0.0" followed by invalid YAML
# node_modules/sdk/openapi.json and .next/cache/openapi.json: valid specs that must be ignored
```

---

## 2. Install and setup

**INS-01 ★ Install from a tarball.** Install into the fresh test project (section 1).
Expected: `npm` succeeds, `npx jodrell help` prints the commands, and `node_modules/jodrell/ui/fonts/PixelifySans.ttf` exists.

**INS-02 ★ `init` sets everything up.** Run `npx jodrell init`.
Expected:
- `.mcp.json` contains `jodrell` (`npx jodrell mcp`)
- `CLAUDE.md` contains the jodrell section between `<!-- jodrell:start -->` markers
- `.claude/settings.json` allows `mcp__jodrell` and has a `PreToolUse` hook for `Bash|WebFetch`
- `.gitignore` contains `.jodrell/`
- the output lists the "Demo shop" spec

**INS-03 `init` is safe to repeat.** Add a line of your own above the jodrell section in `CLAUDE.md`, then run `init` again.
Expected: nothing is duplicated, and your line is kept.

**INS-04 Other agents.** Create `.cursor/`, `.vscode/` and `AGENTS.md`, then run `init`.
Expected:
- `.cursor/mcp.json` and `.cursor/rules/jodrell.mdc` exist, with `alwaysApply: true`
- `.vscode/mcp.json` uses the `servers` key
- `AGENTS.md` gains the jodrell section

**INS-05 Opting out.** Run `npx jodrell init --no-guard --no-rules` in a fresh project.
Expected: no hook is added, and no `CLAUDE.md` is created. `mcp__jodrell` is still allowed.

**INS-06 Migrating from apiscope.** Set up a project with an `.apiscope/` folder from an earlier version, an `apiscope.config.json`, and an `apiscope` entry in `.mcp.json`. Install jodrell and run `init`.
Expected:
- "moved your history from .apiscope/ to .jodrell/" is printed
- the old history and collections appear in the GUI
- the old config still applies
- `.mcp.json` has only `jodrell`
- drafts saved in the browser under the old name are still there

**INS-07 Without Pixel.** Install with `npm i -D <tgz> --omit=optional`, then run `npx jodrell gui --pixel`.
Expected: a message saying Pixel isn't installed, then the GUI opens in the browser.

**INS-08 Node too old.** Run `npx jodrell help` with Node 20.
Expected: "jodrell needs Node 22.13 or newer", and a non-zero exit code.

---

## 3. Agent: Claude Code

Start Claude Code in the test project after `init`, and approve the `jodrell` server when asked.

**AGT-01 ★ No approval prompts for jodrell.** Ask: "Call GET http://127.0.0.1:4610/echo/hello and show me the response."
Expected: the agent uses `send_request` without asking permission, and the reply includes the response and a link (`http://localhost:<port>/#call-N`). The request appears in the GUI.

**AGT-02 ★ The guard redirects curl.** Ask: "Use curl to fetch http://localhost:4600/orders."
Expected: the `curl` is blocked, and the agent says it will use jodrell instead. It then calls `send_request` with the same URL, and the request appears in the feed.

**AGT-03 The guard leaves downloads alone.** Ask the agent to download `https://nodejs.org/dist/index.json` to a file with `curl -o`, and to run `git clone` on any small public repository.
Expected: both run normally.

**AGT-04 Guard modes.** Set `"guard": "ask"` in `jodrell.config.json`, restart Claude Code, and repeat AGT-02.
Expected: you're asked to approve the curl. Then set `"guard": "off"` and restart.
Expected: curl runs.

**AGT-05 Explicit exception.** With the guard on, say: "I really do want you to run that curl directly."
Expected: the agent prefixes the command with `JODRELL_ALLOW=1`, and it runs.

**AGT-06 ★ Logging in with a session.** Ask: "Log in to the demo shop at http://localhost:4600/login with password secret, save the token, then list my orders."
Expected:
- the agent captures the token into a session
- the token is masked in its replies (`Bearer ••••…`)
- the orders call succeeds
- in the GUI, the request headers show the masked token

**AGT-07 ★ Postman import and a collection run.** Ask: "Import examples/demo-shop.postman_collection.json and the environment, use it, and run the whole collection."
Expected: the agent reports 5 of 5 passed (with the demo API running), and the run appears in the timeline as a "Collection run" session.

**AGT-08 The project's own API from the spec.** Ask: "What operations does our API have? Get order o-3."
Expected: the agent lists operations from `openapi.yaml`, and calls `getOrder` and reports the schema mismatches (`/quantity`, `/status`, `/warehouse`).

**AGT-09 Saving a request.** Ask: "Save that last request to a collection called Agent finds."
Expected: it appears in the GUI under Collections › Agent finds.

**AGT-10 History in the terminal.** Ask: "Show me today's request history."
Expected: a text summary with a link to the timeline. Claude Code doesn't render the in-reply views.

**AGT-11 Opening the GUI.** Ask: "Open jodrell next to you."
Expected: in a Pixel-capable terminal, a split pane opens with the GUI. Otherwise the browser opens. The reply says which happened.

**AGT-12 HTML report.** Ask: "Export the history to HTML."
Expected: the reply gives a path under `.jodrell/reports/`, and the file opens offline (see section 14).

---

## 4. Agent views inside replies (MCP Apps hosts)

Run these in Claude Desktop (add `npx jodrell mcp` as a stdio server with the project as its working folder) and in VS Code with Copilot (after `init` with `.vscode/`).

**APP-01 ★ The request view.** Ask for any request.
Expected:
- the reply contains an apiscope/jodrell card showing the method, URL, status, time and size
- tabs for Response, Request sent and Headers (plus Schema when there's a mismatch)
- the JSON is shown as a collapsible tree

**APP-02 Theme.** Switch the host between light and dark.
Expected: the card follows the host's theme.

**APP-03 The timeline view.** Ask "show the request history".
Expected: the timeline card shows the filters, histogram and sessions. Clicking a row expands its details, which load through the host. There's no error when the details aren't inline.

**APP-04 The run view.** Ask for a collection run.
Expected: the run card shows "N of M passed" with a segmented progress bar, and each row can be expanded.

**APP-05 Open full GUI.** Press "Open full GUI" on a request card.
Expected: the host asks to open `http://localhost:<port>#call-N`, and the GUI opens on that request.

**APP-06 Size.** Expand and collapse rows.
Expected: the card grows and shrinks with its content, with no inner scrollbars apart from long lists.

**APP-07 Hosts without UI.** Use a host or client without MCP Apps support.
Expected: the reply still has the full text and link. Nothing is broken.

---

## 5. GUI: navigation and layout

Open the GUI with `npx jodrell gui`.

**GUI-NAV-01 ★ Home is the feed.** Open the GUI fresh.
Expected:
- the Feed is selected at the top of the tree
- the breadcrumb reads "project › Feed"
- the command bar shows the pixel satellite icon, "jodrell" and the project name
- the browser tab shows the icon

**GUI-NAV-02 ★ Back, forward and Up.** Open a collection, a folder, then a request.
Expected: Back retraces each step, Forward returns, and Up goes request → folder → collection → Feed. `Alt`+`Left` and `Alt`+`Right` do the same.

**GUI-NAV-03 Breadcrumbs.** On a request, click each part of the breadcrumb.
Expected: each part opens that level, and the last part isn't clickable.

**GUI-NAV-04 The tree follows you.** Open a request from the list (not the tree).
Expected: the tree expands to show and highlight it.

**GUI-NAV-05 Expand without opening.** Click the ▶ arrow of a folder in the tree.
Expected: it expands without changing what's open. Clicking the folder's name opens it.

**GUI-NAV-06 Search.** Type "order" in the search box.
Expected: the tree, the current list, the feed and the timeline all filter. Clearing the search restores them.

**GUI-NAV-07 Refresh.** Press `F5` or the refresh button after changing data from the agent.
Expected: "Refreshed", with everything up to date.

**GUI-NAV-08 Layout switches.** Use the status-bar buttons: navigation pane on and off, request and response side by side, and stacked.
Expected: each takes effect immediately and is remembered after a reload.

**GUI-NAV-09 Narrow widths.** Resize the window to about 700 px wide.
Expected: when a request is selected, only it shows, and Up returns to the list. Nothing overflows horizontally.

**GUI-NAV-10 Theme.** Press "Theme" in the status bar to cycle through auto, dark and light.
Expected: everything recolours, including the agent views opened from it. The choice is remembered.

**GUI-NAV-11 Shortcuts.**
Expected:
- `Ctrl`/`⌘`+`Enter` sends
- `Ctrl`/`⌘`+`S` saves
- `Ctrl`/`⌘`+`N` starts a new request
- the arrow keys move through lists

---

## 6. GUI: the request builder

**GUI-REQ-01 ★ Variables in the URL bar.** With the "Demo local" environment active, type `{{baseUrl}}/orders/{{nope}}`.
Expected:
- `{{baseUrl}}` is green, with its value shown on hover
- `{{nope}}` is red
- the line underneath says "Not set: {{nope}}"

**GUI-REQ-02 Resolved URL.** With every variable set, look at the line under the URL bar.
Expected: it shows the final URL, including path variables.

**GUI-REQ-03 Params and the URL stay in sync.** Add a parameter in the Params table, edit the URL's query string, and untick a parameter.
Expected: each change updates the other side. An unticked parameter disappears from the URL but stays in the table.

**GUI-REQ-04 Path variables.** Use the URL `…/orders/:id`.
Expected: a Path variables table appears with `id`, and the resolved URL uses its value.

**GUI-REQ-05 Headers.** Type in the empty bottom row.
Expected: a new row appears, and focus stays in place. You can untick a header and remove it with ×. The column headers read Header and Value.

**GUI-REQ-06 Body types.** Try each body type: JSON (with Format, and the "Valid JSON" or "Not valid JSON yet" indicator), Text, XML, Form URL-encoded, Multipart (text fields, with the note about files), GraphQL (query and variables) and None.
Expected: each sends correctly. Use `/echo` on the fake API to check what arrives.

**GUI-REQ-07 Auth.** Try each auth type:
- Inherit (shows where it comes from, e.g. 'collection "Demo shop (Postman)" (bearer token)')
- No auth
- Bearer
- Basic
- API key (in a header and in the query)

Expected: check each with `/echo`.

**GUI-REQ-08 After response.** Set Expected status to 201 on a request that returns 200, and add a capture `id ← body.id`.
Expected: the response shows "Expected 201, got 200" in red, the capture shows "Saved {{id}}", and the value appears in the active environment.

**GUI-REQ-09 A capture that finds nothing.** Capture `body.missing`.
Expected: "{{missing}} not saved" in red, with a tooltip explaining why.

**GUI-REQ-10 ★ Pasting curl.** Paste each of these into the URL bar:
- `curl -X POST 'http://127.0.0.1:4610/echo' -H 'X-A: 1' --data-raw '{"a":1}'`
- `curl -u user:pass http://127.0.0.1:4610/echo`
- `curl -F name=x http://127.0.0.1:4610/echo`
- `curl --data-urlencode q=dwarf http://127.0.0.1:4610/echo`

Expected: the method, URL, headers, body type and auth are all filled in correctly.

**GUI-REQ-11 Saving.** Save a new request.
Expected:
- the dialog offers existing collections and folders, and "New collection…"
- after saving, the request appears in the tree, the breadcrumb shows its new location, and `Ctrl`+`S` then saves in place

**GUI-REQ-12 Notes.** Write a note and reload.
Expected: the note is kept (as a draft until saved).

---

## 7. GUI: the response viewer

**GUI-RES-01 ★ The basics.** Send to `/users/1`.
Expected: status and reason (e.g. "200 OK"), time, size, and the request number with its time.

**GUI-RES-02 Body views.**
Expected: Pretty is a collapsible tree with `⊞`/`⊟`. Table appears for lists of objects (e.g. `/orders` once logged in). Raw shows the text.

**GUI-RES-03 Unusual bodies.** Send to `/html`, `/binary` and `/big?kb=1100`.
Expected:
- the HTML shows as text and isn't rendered (no alert or script runs)
- the binary shows "[5 bytes of application/octet-stream]"
- the large one notes that only the first 1 MB was saved

**GUI-RES-04 Headers and cookies.** Send to `/login` with password `secret`.
Expected: the Cookies tab shows `sid=••••; HttpOnly; Path=/`, with no part of the value.

**GUI-RES-05 ★ Request sent.** Open the Request sent tab for a request using `{{variables}}` and inherited bearer auth.
Expected: the final URL and headers, with the Authorization header masked.

**GUI-RES-06 Schema.** Request order `o-3` from the demo API's spec.
Expected:
- a "Schema: 3 mismatches" chip
- the Schema tab lists `/quantity`, `/status` and `/warehouse`
- those fields are highlighted in the tree

**GUI-RES-07 HTML where JSON was promised.** Point a spec operation at a URL that returns HTML.
Expected: a schema mismatch reading "Returned text/html, but the spec documents application/json".

**GUI-RES-08 Compare.** Send the same request twice with a change in between, and open Compare.
Expected: the previous call of the same request is selected by default, the changed lines are highlighted, and you can choose any other request.

**GUI-RES-09 Copying.** Use Copy and Copy as curl.
Expected: the body, or a curl command with secrets masked, is on the clipboard.

**GUI-RES-10 Errors.** Send to a port with nothing on it.
Expected: "Connection refused at …. Is the API running?", and the request is still recorded in the history.

---

## 8. GUI: drafts and unsaved changes

**GUI-DRF-01 ★ Edits are kept automatically.** Edit a saved request's URL, open something else, and come back.
Expected: the edit is still there, with "Unsaved changes" by its title and a dot in the tree and the list.

**GUI-DRF-02 ★ They survive a restart.** With a draft open, close the browser tab and stop the GUI. Start it again and reopen the page.
Expected: the draft is still there, listed under "Unsaved requests", and the GUI opens where you left off.

**GUI-DRF-03 Revert.** Press Revert and confirm.
Expected: the saved version returns, and the dot and the "Unsaved requests" entry go.

**GUI-DRF-04 Discard.** Make a new request, type a URL, then Discard.
Expected: it's removed, and you're taken to the Unsaved requests list.

**GUI-DRF-05 Saving a draft.** Save an edited history request into a collection.
Expected: it becomes a saved request (its breadcrumb changes) and leaves "Unsaved requests".

**GUI-DRF-06 Editing a history request.** Open a request from History, change it, and Send.
Expected: a new history entry is selected, showing the new response. The original entry is unchanged.

---

## 9. GUI: the three-pane view

**GUI-LST-01 ★ A collection as a list.** Click a collection's name.
Expected:
- the middle pane lists folders first, then requests
- the columns are Name, URL, Last result and Last sent
- the right pane summarises the collection, with Run, New request here, New folder, and Variables and auth

**GUI-LST-02 Into a folder.** Click a folder row.
Expected: the list shows that folder, and the breadcrumb and tree follow.

**GUI-LST-03 ★ Previewing with the keyboard.** Click a request, then press `↓` and `↑`.
Expected: each request opens on the right as you move. Back afterwards doesn't step through every one you passed. `Enter` puts the cursor in the URL bar.

**GUI-LST-04 Sorting.** Click each column header twice.
Expected: the list sorts ascending, then descending, with an arrow on that column. Folders stay at the top.

**GUI-LST-05 Live columns.** Send a request from the list.
Expected: its Last result and Last sent update without reloading.

**GUI-LST-06 History as a list.** Open History › All requests.
Expected: the columns are Time, Name, Result, Time taken and By (Agent or You), newest first.

**GUI-LST-07 A spec as a list.** Open a spec in the tree.
Expected: its operations are listed, and the summary shows the base URL, source, type and any warnings.

**GUI-LST-08 Empty folder.** Open an empty folder.
Expected: an empty-state message, with the summary's New request here button.

---

## 10. GUI: the feed

**GUI-FEED-01 ★ The stream.** Open the Feed with some history.
Expected:
- cards appear oldest to newest, with the newest at the bottom
- day separators ("Today (n)") and labels for collection runs
- agent cards have the robot avatar and a blue-green tint, and failed cards have a red left edge

**GUI-FEED-02 ★ Live updates.** Stay at the bottom while the agent makes requests.
Expected: new cards slide in, and the feed scrolls to them. When you've scrolled up to read, it doesn't jump.

**GUI-FEED-03 Filters.** Try Everyone, Agent, You and Failed, and the search box.
Expected: the cards and the count update.

**GUI-FEED-04 Expand.** Expand a card.
Expected: the full response, Request sent and Headers tabs. Collapse returns the preview.

**GUI-FEED-05 ★ Edit and resend.** On a card, change the URL and the body, then Send.
Expected: the editor closes, and a new card appears at the bottom marked "resent #N", with the new result.

**GUI-FEED-06 Resend, Open and Copy as curl.**
Expected:
- Resend adds a new card
- Open shows the request in the History list
- Copy as curl copies a masked curl command

**GUI-FEED-07 ★ The composer.** Type a URL and Send.
Expected: a card appears. "Headers and body" opens the extra fields, and the choice is remembered. `Ctrl`+`Enter` sends from the composer.

**GUI-FEED-08 Curl into the composer.** Paste a curl command into the composer.
Expected: the method, URL, headers and body are filled in.

**GUI-FEED-09 From the composer to the editor.** Press "Open in editor".
Expected: a new unsaved request with the same contents.

**GUI-FEED-10 Earlier requests.** With more than 60 requests, scroll to the top.
Expected: "Show N earlier requests" loads more.

---

## 11. GUI: collections, runs, environments and import

**GUI-COL-01 ★ Import.** Open the Import dialog and use each of: choose a file, drag and drop, paste JSON, and an environment file.
Expected:
- each reports what was imported, plus how many script lines were converted and any notes
- a file that isn't a collection shows a clear error

**GUI-COL-02 Managing collections.** Use the ⋯ menus to create, rename, duplicate and delete collections, folders and requests.
Expected:
- each action works, and deleting asks for confirmation
- the menus work with the keyboard (`Esc` closes them)

**GUI-COL-03 Variables and auth.** Open a collection's Variables and auth.
Expected: you can edit variables and auth, and requests set to inherit use them.

**GUI-COL-04 ★ Running a collection.** Run the Demo shop collection (from the menu, the command bar, or the summary pane).
Expected:
- a progress bar of segmented blocks
- each request is shown with ✓ or ✗ and why ("Expected 200", "Saved {{token}}")
- "Run again" works
- a notification gives the result

**GUI-ENV-01 ★ Environments.** Create an environment, add a variable, make it active from the tree, and check the top bar.
Expected: the URL bar's highlighting changes immediately. Deleting the active environment clears the selection.

**GUI-ENV-02 Cookie sessions.** Log in with the cookie session set to "default", then switch it to "None" and call `/me`.
Expected: 401 with None, and 200 with default. Clearing the cookies from the tree's ⋯ menu returns `/me` to 401.

**GUI-ENV-03 Cookies per host.** Log in at `http://127.0.0.1:4610`, then call `http://localhost:4610/me`.
Expected: 401, because the cookie belongs to the other host.

---

## 12. Spec discovery

Use the monorepo fixture (section 1) with `npx jodrell init`, then `npx jodrell gui`.

**SPEC-01 ★ What's found.**
Expected: `init` and the GUI's tree list the following.
- found: the generated spec in `apps/api/dist`, the Swagger 2.0 billing spec, and any spec served by the app
- reported but not stopping anything else: the broken spec (✗)
- ignored, and reported as an older copy: `docs/old`
- ignored completely: the `node_modules` and `.next` specs

**SPEC-02 Base URL warnings.** A spec with no servers and no `appUrl` set shows ⚠ in the tree.
Expected: the summary explains how to fix it.

**SPEC-03 ★ Regenerating a spec.** With the GUI open, add an operation to `apps/api/dist/openapi.json`.
Expected: it appears in the tree within a few seconds, without reloading the page.

**SPEC-04 A new spec file.** Add a new spec file somewhere in the project.
Expected: it appears within 30 seconds, or immediately with Reload in the tree's API specs section.

**SPEC-05 Served by the app.** Run `npx jodrell init --app-url http://127.0.0.1:4610`.
Expected: "Served by the app" is listed with base URL `http://127.0.0.1:4610`, and calling `getUser` works.

---

## 13. Several processes and projects

**PROC-01 ★ The agent and the GUI share history.** Start Claude Code (which starts jodrell over stdio), then run `npx jodrell gui` in another terminal.
Expected: `gui` says it's already running for this project and opens it. The agent's requests appear live.

**PROC-02 Two projects at once.** Open the GUI in two different projects.
Expected: the second gets a different port, and each shows only its own data.

**PROC-03 The GUI outlives its starter.** Close the agent that started the GUI.
Expected: within about 15 seconds, a new agent session starts its own GUI, and links in replies point at the working one.

**PROC-04 Watch.** Run `npx jodrell watch` (and `--detail`) while the agent works.
Expected: one coloured line per request, or full details with `--detail`. If jodrell isn't running yet, it says it's waiting and connects when jodrell starts.

---

## 14. HTML report

**RPT-01 ★ Offline and complete.** Run `npx jodrell report --open`, then disconnect from the network and reload the page.
Expected: the timeline, filters and expandable requests all work, and the pixel font and icon still show.

**RPT-02 Filters.** Try `--since 1h` and `--out custom.html`.
Expected: only recent requests, written to the given path.

**RPT-03 Hostile content.** Make a request to `/html` and `/echo` with a `</script>` body, then open the report.
Expected: nothing runs, and the content shows as text.

**RPT-04 From the GUI.** Use Export in the command bar.
Expected: a notification with the saved file's path, and the file opens.

---

## 15. Pixel (the GUI in the terminal)

**PIX-01 ★ In this pane.** Run `npx jodrell open` in Ghostty, iTerm2, WezTerm or kitty.
Expected:
- the GUI fills the pane, looking as it does in the browser
- mouse clicks, scrolling and typing all work
- `Ctrl`+`C` closes it

**PIX-02 ★ A split next to the agent.** Run `npx jodrell gui --pixel`.
Expected: a new pane opens to the right with the GUI. Try `--pixel down` too.

**PIX-03 tmux.** Repeat PIX-01 and PIX-02 inside tmux.
Expected: it works, if more slowly.

**PIX-04 Unsupported terminal.** Try macOS Terminal or a basic xterm.
Expected: a clear message and a fallback to the browser.

**PIX-05 Narrow pane.** Use a split about 80 columns wide.
Expected: the narrow layout (GUI-NAV-09) applies, and everything stays usable.

**PIX-06 Linux as root.** Run as root on Linux.
Expected: Pixel's "cannot run as root" message, and the browser is suggested.

---

## 16. Security

**SEC-01 ★ No secrets on disk.** After AGT-06 and GUI-RES-04, search the database:

```bash
grep -a "tok-\|Bearer [A-Za-z0-9]" .jodrell/history.db
```

Expected: no raw tokens in request or response *headers*. Response *bodies* are stored as the server sent them, so the login response's token is expected there.

**SEC-02 Other websites can't use jodrell.** From the console of any other website, run:

```js
fetch("http://localhost:<port>/api/calls")
```

Expected: blocked (403, or a CORS error), with no data returned.

**SEC-03 Local only.** Run `lsof -iTCP -sTCP:LISTEN | grep node` (or `netstat`).
Expected: jodrell listens on `127.0.0.1` only.

**SEC-04 Hostile responses in the GUI.** Open `/html` and the `</script>` echo in every view: response, feed card, timeline and compare.
Expected: nothing runs.

**SEC-05 Guard limits are documented.** Ask the agent to make a request from a script file it writes and runs (`node script.js`).
Expected: this isn't blocked, which is a known limit noted in the README. It's in scope for the planned recording proxy.

---

## 17. Accessibility

**A11Y-01 ★ Keyboard only.** Using only `Tab`, `Shift`+`Tab`, the arrow keys and `Enter`, do the following: open a collection, select a request, edit the URL, send, open the response tabs, and save a draft.
Expected: everything is reachable, with a visible gold focus ring.

**A11Y-02 Screen reader.** Use VoiceOver or NVDA.
Expected:
- icon-only buttons are announced (Back, Forward, Up, Refresh, the layout buttons)
- the tree items, list rows and tabs have sensible names
- new feed cards and notifications are announced (log and status roles)

**A11Y-03 Contrast.** Check text and status colours in both themes with a contrast checker.
Expected: body text reaches WCAG AA. Note any status colour that falls short.

**A11Y-04 Reduced motion.** Turn on reduced motion in the operating system.
Expected: no sliding cards or smooth scrolling, and the spinners slow down.

**A11Y-05 Zoom.** Zoom the browser to 200%.
Expected: the narrow layout takes over cleanly, with no text cut off.

---

## 18. Performance

**PERF-01 A large history.** With 2,000 or more requests in the history (run the collection repeatedly), open the Feed, History, the Timeline and search.
Expected: each opens within about a second, and typing in search stays responsive.

**PERF-02 A large response.** View a response close to 1 MB in Pretty, Raw and Compare.
Expected: the GUI stays responsive. Compare may say the bodies are too large.

**PERF-03 Guard overhead.** Have the agent run 20 ordinary shell commands.
Expected: no noticeable delay. The guard adds about 30 ms per command.

---

## 19. Look and feel

**LOOK-01 ★ Light theme.** Check the following.
Expected:
- a meadow-green command bar with the pixel-grass edge, and a forest-green status bar
- section headings and view titles in the pixel font, and body text in Segoe UI (or the system font)
- yellow hover and leaf-green selection

**LOOK-02 Dark theme.** Check the "night meadow" palette across every view, including dialogs and menus.

**LOOK-03 Icons.** Check the favicon (16 px) in the browser tab, the command bar icon on a normal and a high-resolution screen, and the README image.
Expected: crisp pixels, never blurred.

**LOOK-04 Cross-browser.** Repeat the smoke test in Chrome, Firefox and Safari.
Expected: they look and behave the same, apart from native form controls.

---

## Results

Copy this table for each test run.

| Run | Date | jodrell version | Tester (person or agent) | Environment (OS, terminal, browser, host) |
| --- | --- | --- | --- | --- |
| | | | | |

| ID | Result (Pass / Fail / Blocked / N/A) | Notes or issue link |
| --- | --- | --- |
| INS-01 | | |
| INS-02 | | |
| … | | |

**Before a release:** every ★ case passes, `npm test` passes, and any failures in the full pass have an issue that is fixed or accepted.

## Running this with an agent

Most GUI cases can be driven by an agent with a browser tool, such as Playwright. Give it this file, the fixtures, and the GUI's address, and ask it to work through a section, taking a screenshot for each expected result and filling in the results table. Cases that need a real terminal (Pixel), a real host (MCP Apps), a screen reader or a human judgement on looks are best done by a person.
