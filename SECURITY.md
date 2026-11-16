# Security

jodrell runs locally and handles API credentials, so security reports are very welcome.

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's **Report a vulnerability** button on the Security tab of this repository, or email the maintainer via https://dancurtis.dev. Include what you found, how to reproduce it, and what it could expose. You'll get a reply within a week.

## What jodrell does to protect you

- **The GUI server** listens on `127.0.0.1` only. It refuses requests from other websites and other local apps' pages, requests addressed to any other host name (DNS rebinding), and cross-site form posts, and it can't be framed.
- **Secrets are masked** before they're stored or shown: credential headers, cookie values (entirely), secret query parameters, password and token fields in request bodies, and sign-in tokens in responses. Short secrets are hidden completely.
- **Cookies and captured auth headers** are only sent back to the host that issued them (and its subdomains). A server can't set cookies for other hosts.
- **Auth profiles** (`"auth"` in `jodrell.config.json`) do nothing until you allow them, and you're asked again if they change. Their secrets (`{{env.NAME}}`) are only filled into their own sign-in requests, and command values are shell-quoted.
- **Untrusted project files** can't act for you: `init` won't write through symbolic links, a committed `.jodrell/server.json` is ignored unless it points at this project's own jodrell, and `appUrl` is only probed automatically on your own computer.
- **The HTML report, the GUI and the terminal** never run content from API responses. Copy as curl quotes every argument, so a pasted command can't run anything hidden in a URL, header or body.
- **Nothing is sent anywhere** except the requests you or your agent make, and the sign-ins you've allowed.

## What it doesn't do

- **Variables are stored as you typed them.** Environment and collection variables live in plain text in `.jodrell/history.db`, as in Postman. Keep `.jodrell/` out of git (`init` does this) and treat it like a local `.env` file.
- **Response bodies are stored as received,** apart from sign-in responses. If another API returns a token in its body, it's in the history.
- **Other accounts on the same computer** can use the GUI server, as with most local developer tools. Don't run jodrell on a shared machine with people you don't trust.
- **Your agent's jodrell tools are pre-approved** by `init`, so a prompt-injected agent could send requests through jodrell without asking you. You'll see them in jodrell, but it won't stop them. Remove `mcp__jodrell` from `.claude/settings.json` to approve each call.
- **The guard is a convenience.** It redirects the agent's direct HTTP calls to jodrell, but it isn't a sandbox. Code the agent runs can still make requests of its own.
