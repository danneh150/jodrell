# Security

jodrell runs locally and handles API credentials, so security reports are very welcome.

## Reporting a problem

Please don't open a public issue for a security problem. Use GitHub's **Report a vulnerability** button on the Security tab of this repository, or email the maintainer via https://dancurtis.dev. Include what you found, how to reproduce it, and what it could expose. You'll get a reply within a week.

## What jodrell does to protect you

- The GUI server listens on `127.0.0.1` only, and rejects requests from other websites.
- Secret-looking headers (authorisation, cookies, API keys, anything named like a token or secret) are masked before they're stored or shown, and cookie values are hidden entirely.
- Cookies and captured auth headers are only sent back to the host that issued them.
- The HTML report and the GUI never run content from API responses.
- Nothing is sent anywhere except the requests you or your agent make.

## What it doesn't do

- **Variables are stored as you typed them.** Environment and collection variables live in plain text in `.jodrell/history.db`, as in Postman. Keep `.jodrell/` out of git (`init` does this) and treat it like a local `.env` file.
- **Response bodies are stored as received.** If an API returns a token in its body, it's in the history.
- **The guard is a convenience.** It redirects the agent's direct HTTP calls to jodrell, but it isn't a sandbox. Code the agent runs can still make requests of its own.
