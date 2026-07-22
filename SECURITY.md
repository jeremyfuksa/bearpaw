# Security Policy

## Supported versions

Bearpaw is pre-1.0 (`1.0.0-beta.x`). Only the latest release and the current
`main` branch receive security fixes. There is no back-porting to older betas —
if you hit a security issue, first confirm it reproduces against the latest
release or `main`.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately through GitHub's built-in advisory flow:

1. Go to the [Security tab](https://github.com/jeremyfuksa/bearpaw/security).
2. Click **Report a vulnerability** (Private vulnerability reporting).
3. Describe the issue, the affected component, and steps to reproduce.

You'll get a response within a few days. Once the report is confirmed and a fix
is available, the advisory is published and you'll be credited unless you ask
otherwise.

## Scope

Bearpaw is a desktop control interface for the Uniden BC125AT scanner. The parts
worth flagging:

- **The backend is an unauthenticated loopback HTTP + WebSocket server** bound to
  `127.0.0.1` by default. It relies on CORS and Host-header hardening
  ([`crates/bearpaw-api/src/api/security.rs`](crates/bearpaw-api/src/api/security.rs))
  to keep other web pages the user visits from reaching it. Bypasses of that
  boundary (cross-origin fetch, DNS rebinding) are in scope.
- **Wire-protocol parsing** of untrusted serial/USB input from the scanner
  ([`crates/bearpaw-api/src/protocol/`](crates/bearpaw-api/src/protocol/)).
- **The Tauri desktop shell** and any command surface it exposes to the frontend.

Out of scope: physical access to the machine running Bearpaw, and the security of
the BC125AT hardware/firmware itself (report those to Uniden).
