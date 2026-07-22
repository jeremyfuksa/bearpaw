# Contributing to Bearpaw

Thanks for your interest in Bearpaw — a desktop control interface for the Uniden
BC125AT scanner.

Bearpaw is in public beta. The architecture is strictly client/server: a Rust
backend ([`crates/bearpaw-api/`](crates/bearpaw-api/)) owns all state and
hardware communication, and a React frontend ([`frontend/`](frontend/)) is a
replaceable display layer. [`CLAUDE.md`](CLAUDE.md) is the fullest map of how the
system fits together — read it before a non-trivial change.

## Getting set up

**Backend (Rust):**

```bash
# copy the example config and edit for your setup
cp crates/bearpaw-api/config.example.yaml ./config.yaml
cargo run -p bearpaw-api --bin bearpaw -- --config ./config.yaml
```

**Frontend (React + Vite):** from [`frontend/`](frontend/) — see
[`frontend/README.md`](frontend/README.md). The dev server proxies `/api` and
`/ws` to the backend on `localhost:8000`, so start the backend first.

On macOS the scanner enumerates over USB but the kernel CDC-ACM driver never
binds, so set `usb_vid`/`usb_pid` in `config.yaml` to force the direct-USB path.
See [`CLAUDE.md`](CLAUDE.md) for the details.

## The bar for a change

1. **Small, single-purpose PRs.** One concern per PR, independently revertible,
   reviewable in under ten minutes. If a change grows past ~250 lines, split it.
2. **All CI checks green locally before you push.** Never push to retry CI —
   reproduce and fix locally first.
3. **Branch off `main`** with a semantic prefix: `feat/`, `fix/`, `cleanup/`,
   `chore/`, `docs/`, or `ci/`.
4. **Semantic commit subjects:** `type(scope): summary` — e.g.
   `fix(a11y): give Device tab controls accessible names`.

## Running the checks

CI runs these on every PR (see
[`.github/workflows/tests.yml`](.github/workflows/tests.yml)). Run them all
before pushing:

**Backend:**

```bash
cargo test -p bearpaw-api --lib
cargo check --workspace --all-targets   # CI runs this to catch Tauri-crate drift
```

**Frontend** (from [`frontend/`](frontend/)):

```bash
npm test -- --run        # Vitest
npm run lint             # ESLint
npm run type-check       # tsc --noEmit
npm run format:check     # Prettier
```

The Prettier check is the one most easily forgotten — don't skip it.

## Working on the wire protocol

The BC125AT speaks an ASCII line protocol over USB. If you touch anything in
[`crates/bearpaw-api/src/protocol/`](crates/bearpaw-api/src/protocol/), the
transports, or the poll/memory-sync loops, one rule governs everything:

**Real wire captures win.** When a reference doc — including the decompiled
[`docs/BC125AT_PROTOCOL.md`](docs/BC125AT_PROTOCOL.md) — disagrees with the
captures in [`docs/wire_captures/`](docs/wire_captures/) from this hardware, the
captures are authoritative. Don't "fix" working code to match a reference;
document the disagreement instead.

See [`docs/SCANNER_PROTOCOL_REFERENCE.md`](docs/SCANNER_PROTOCOL_REFERENCE.md)
for the canonical wire shape.

## Regression guards

Several flows have been broken and fixed at least once. Each has a paired
`REGRESSION GUARD:` comment at the code site and a named test. When you touch
code near one, read the comment, run the named test, and only proceed if it
still passes. If you need to change the behavior intentionally, update the test
and the comment together — don't remove the guard silently. The full list is in
[`CLAUDE.md`](CLAUDE.md).

## Reporting bugs

Open an issue with what you did, what you expected, and what happened. For
scanner-communication problems, include your model (`MDL` response), platform,
and whether you're on the serial or direct-USB transport.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE).
