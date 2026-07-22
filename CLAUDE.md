# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## Project overview

Bearpaw is a desktop control interface for the Uniden BC125AT scanner.

- **Backend:** Rust (Axum REST + WebSocket) in [`crates/bearpaw-api/`](crates/bearpaw-api/). Talks to the scanner over serial or direct USB.
- **Frontend:** React + TypeScript + Vite SPA in [`frontend/`](frontend/), state in Zustand.
- **Desktop shell:** Tauri 2 bundles backend + frontend into a single app. Lives in [`frontend/src-tauri/`](frontend/src-tauri/).

Architecture is **strictly client/server.** The Rust backend owns ALL state and hardware communication. The React frontend is replaceable — it only displays current state and sends commands.

Current version: see [`crates/bearpaw-api/Cargo.toml`](crates/bearpaw-api/Cargo.toml).

## Development commands

### Backend (Rust)

```bash
# Run standalone (frontend dev server proxies to it)
cargo run -p bearpaw-api --bin bearpaw -- --config ./config.yaml

# Tests / type check / lint
cargo test -p bearpaw-api
cargo check -p bearpaw-api
cargo clippy -p bearpaw-api
```

**Config:** copy [`crates/bearpaw-api/config.example.yaml`](crates/bearpaw-api/config.example.yaml) to `./config.yaml` and edit. The example covers the macOS USB-direct setup (see Pitfalls).

### Frontend (React + Vite)

From [`frontend/`](frontend/):

```bash
npm install
npm run dev              # HMR dev server (proxies /api and /ws to localhost:8000)
npm run build
npm test -- --run        # vitest one-shot
npm run lint
npm run type-check
npm run format:check
```

**Type-check scope:** `tsc` runs against `src/` only. Test files are excluded — Vitest transpiles them via Vite.

### Tauri (full desktop app)

From [`frontend/`](frontend/):

```bash
npm run tauri:dev        # dev mode with HMR
npm run tauri:build      # bundle for release
```

## Critical architecture concepts

### 1. Three state surfaces

**`LiveState`** ([`crates/bearpaw-api/src/state.rs`](crates/bearpaw-api/src/state.rs)) — real-time scanner state polled 5×/sec.
- `timestamp`, `frequency`, `modulation`, `squelch_open`, `rssi`, `mode`, `channel`, `alpha_tag`, `volume`, `battery`, `stale`.
- Live tone fields, populated only during a hit (`None` while squelch is closed): `tone_squelch_kind`, `tone_squelch`, `tone_dcs_code`, `tone_dcs_label`.
- Updated by the poll loop in [`crates/bearpaw-api/src/api/poll.rs`](crates/bearpaw-api/src/api/poll.rs).

**Channel memory** — all 500 channels read once during memory sync via `PRG` → `CIN,1` … `CIN,500` → `EPG`. Cached in `AppState.shadow` (`ShadowState.channels`). Channel memory is **not** persisted across restarts — SQLite holds only preferences and analytics; every backend start needs a fresh memory sync.

**`DeviceInfo`** — static metadata: model name (from `MDL`), port, connection_status. Same module.

### 2. Command queue and program-mode guard

The poll loop is single-threaded. User commands enter via an mpsc channel ([`crates/bearpaw-api/src/api/control.rs`](crates/bearpaw-api/src/api/control.rs)) and are drained between status polls. There's no priority enum — every queued command runs before the next `STS` poll.

**Program mode** is a RAII guard ([`crates/bearpaw-api/src/api/program_mode.rs`](crates/bearpaw-api/src/api/program_mode.rs)):

1. `enter()` sends `PRG`, waits for `PRG,OK`, sets `program_mode_active` atomic.
2. Drop sends `EPG` via the command channel.
3. The poll loop checks `program_mode_active` and yields its `STS`/`GLG` polling while program mode is in effect.

Always use the guard — never send `PRG`/`EPG` manually.

### 3. The "hit" workflow

Scanner has three operational modes plus a signal-open state:

- **Mode** (user-driven): `SCAN` / `HOLD` / `DIRECT`. Tracked by the backend as `commanded_mode` in the poll loop. The scanner does NOT report mode on the wire.
- **`squelch_open`** (hardware-driven): true = signal present, scanner auto-paused. false = no signal, scanner cycling.

```
1. mode=SCAN, squelch_open=false  →  "Scanning..." (cycling)
2. squelch opens                   →  backend broadcasts `scan_hit` event
3. mode=SCAN, squelch_open=true    →  "Hit" (display the frequency, alpha tag, RSSI)
4. squelch closes                  →  back to step 1
```

**Common mistake:** during a hit, `mode` stays `"SCAN"`. The hardware pauses automatically; the mode only changes when the user presses Hold or Direct. The poll loop and squelch-detection logic live in [`crates/bearpaw-api/src/api/poll.rs`](crates/bearpaw-api/src/api/poll.rs).

### 4. WebSocket state sync

Every poll cycle the backend computes a diff and broadcasts only changed fields:

```jsonc
{
  "type": "state_update",
  "sequence": 1779433242187,    // monotonically increasing
  "data": { "frequency": 146.85, "squelch_open": true }
}
```

Message types (source of truth is what the code broadcasts — [`crates/bearpaw-api/src/api/ws.rs`](crates/bearpaw-api/src/api/ws.rs), [`poll.rs`](crates/bearpaw-api/src/api/poll.rs), [`memory_sync.rs`](crates/bearpaw-api/src/api/memory_sync.rs)):
- `state_update` — partial LiveState changes (most common)
- `event` — `scan_hit`, `state_stale`
- `progress` — long-running task updates (memory sync)
- `device_info` — model/port/connection_status changes
- `banks_update` — bank-enable mask changed server-side; the UI mirrors it instead of holding a stale local copy

[`docs/WEBSOCKET_SCHEMA.md`](docs/WEBSOCKET_SCHEMA.md) lags the code: it omits `device_info` and `banks_update`, and still documents client `subscribe`/`ping`/`pong` flows that `ws.rs` no longer implements. Where they disagree, the code wins.

The frontend MUST check `message.sequence > lastSequence` ([`frontend/src/store/useStore.ts`](frontend/src/store/useStore.ts) `updateLiveState`). Out-of-order updates are dropped.

### 5. Frontend display logic

The `mainText`/`subText` derivation in [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) decides what the big display shows:

- During scan with no hit: "Scanning..."
- During a hit OR mode = HOLD/DIRECT: stable frequency + alpha tag + modulation
- When sync is in progress: "Syncing Scanner Memory" + progress text

The connection-status enum (`'connected' | 'connecting' | 'disconnected'`) is derived in [`frontend/src/hooks/useConnectionStatus.ts`](frontend/src/hooks/useConnectionStatus.ts) by folding five signals (WS connected/connecting, deviceInfo.connection_status, liveState.stale, Tauri shell status).

## Wire protocol

The BC125AT speaks an ASCII line protocol over USB CDC-ACM at 115200 8N1, `\r`-terminated. See [`docs/SCANNER_PROTOCOL_REFERENCE.md`](docs/SCANNER_PROTOCOL_REFERENCE.md) for the canonical wire shape and the audit history. Real wire captures live in [`docs/wire_captures/`](docs/wire_captures/) (`2026-05-21/`, `2026-05-22/`, `2026-07-08/`).

**Captures win.** When a reference doc — including the decompiled [`docs/BC125AT_PROTOCOL.md`](docs/BC125AT_PROTOCOL.md) — disagrees with the wire captures from this hardware, the captures are authoritative. Don't "fix" working code to match a reference; document the disagreement instead (see `docs/wire_captures/2026-05-21/audit-reconciliation.md` for prior reconciliations).

Commonly used commands (all implemented in [`crates/bearpaw-api/src/protocol/mod.rs`](crates/bearpaw-api/src/protocol/mod.rs)):

| Cmd | Purpose | Mode |
|---|---|---|
| `MDL` | Model probe — must reply `MDL,BC125AT` (or BCT125AT, UBC125XLT, UBC126AT, AE125H) | any |
| `VER` | Firmware version | any |
| `STS` | LCD dump + status flags | any |
| `GLG` | Canonical live frequency/mod/tone/name/squelch | any |
| `PWR` | RSSI (0–1023 raw) | any |
| `KEY,<key>,P` | Virtual keypress | any |
| `PRG` / `EPG` | Enter/exit program mode | — |
| `CIN,<index>` | Read channel data | PRG |
| `GLF` / `LOF` / `ULF` | Walk/add/remove global lockouts | PRG |
| `SCG` | Bank-enable mask (10 chars, `'1'`=disabled) | PRG |
| `BLT`, `BSV`, `KBP`, `CNT`, `VOL`, `SQL`, `PRI`, `WXS` | Global settings | either |

CTCSS/DCS codes (0–231) are decoded to Hz in [`crates/bearpaw-api/src/protocol/tones.rs`](crates/bearpaw-api/src/protocol/tones.rs).

## Transport

Two transports, picked based on config:

- **`SerialTransport`** ([`crates/bearpaw-api/src/transport.rs`](crates/bearpaw-api/src/transport.rs)) — `serialport` crate, opens `/dev/cu.usbmodem*` / `/dev/ttyUSB0` / `COMx`.
- **`UsbTransport`** ([`crates/bearpaw-api/src/transport_usb.rs`](crates/bearpaw-api/src/transport_usb.rs)) — `nusb` direct bulk endpoints. Used when serial CDC binding fails (macOS — see Pitfalls).

The poll loop dispatches to the right transport based on whether the resolved port string starts with `usb:` (USB pseudo-target) or looks like a serial device. See [`crates/bearpaw-api/src/config.rs::resolve_serial_port`](crates/bearpaw-api/src/config.rs).

## Configuration

`./config.yaml` at repo root (gitignored). Example in [`crates/bearpaw-api/config.example.yaml`](crates/bearpaw-api/config.example.yaml).

Minimal macOS config:

```yaml
device:
  usb_vid: 0x1965
  usb_pid: 0x0017
api:
  host: 127.0.0.1
  port: 8000
```

On macOS the BC125AT enumerates over USB but the kernel CDC-ACM driver never binds — `/dev/cu.usbmodem*` does not appear. Setting `usb_vid`/`usb_pid` forces the `nusb` direct-USB path. Linux/Windows usually omit those fields and let auto-detect handle it.

Frontend env (in `frontend/.env`):

```
VITE_API_BASE_URL=/api/v1
VITE_WS_URL=                # auto-detect from window.location if empty
```

## Key files

### Backend
- [`crates/bearpaw-api/src/main.rs`](crates/bearpaw-api/src/main.rs) — binary entry point
- [`crates/bearpaw-api/src/api/mod.rs`](crates/bearpaw-api/src/api/mod.rs) — Axum router, `run_server`
- [`crates/bearpaw-api/src/api/poll.rs`](crates/bearpaw-api/src/api/poll.rs) — poll loop, hit detection
- [`crates/bearpaw-api/src/api/program_mode.rs`](crates/bearpaw-api/src/api/program_mode.rs) — PRG/EPG RAII guard
- [`crates/bearpaw-api/src/api/memory_sync.rs`](crates/bearpaw-api/src/api/memory_sync.rs) — `CIN,1..500` walker
- [`crates/bearpaw-api/src/api/ws.rs`](crates/bearpaw-api/src/api/ws.rs) — WebSocket broadcast
- [`crates/bearpaw-api/src/api/security.rs`](crates/bearpaw-api/src/api/security.rs) — CORS + Host-header hardening. The API is an unauthenticated loopback server, so any web page the user visits is the threat; this closes the cross-origin-fetch and DNS-rebinding paths.
- [`crates/bearpaw-api/src/api/handlers/`](crates/bearpaw-api/src/api/handlers/) — REST handlers (analytics, banks, commands, exports, lockouts, memory, preferences, settings, status)
- [`crates/bearpaw-api/src/protocol/mod.rs`](crates/bearpaw-api/src/protocol/mod.rs) — STS/GLG/CIN/PWR parsers
- [`crates/bearpaw-api/src/protocol/tones.rs`](crates/bearpaw-api/src/protocol/tones.rs) — CTCSS/DCS code → Hz
- [`crates/bearpaw-api/src/protocol/defaults.rs`](crates/bearpaw-api/src/protocol/defaults.rs) — factory-default custom-search ranges (read-only; no `CSP` write path)
- [`crates/bearpaw-api/src/logging.rs`](crates/bearpaw-api/src/logging.rs) — tracing setup, file + error log appenders
- [`crates/bearpaw-api/src/transport.rs`](crates/bearpaw-api/src/transport.rs), [`transport_usb.rs`](crates/bearpaw-api/src/transport_usb.rs)
- [`crates/bearpaw-api/src/state.rs`](crates/bearpaw-api/src/state.rs) — `LiveState`, `ChannelData`, `DeviceInfo`
- [`crates/bearpaw-api/src/config.rs`](crates/bearpaw-api/src/config.rs)

### Frontend
- [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) — app shell, view routing, top-level state derivation
- [`frontend/src/app/components/views/ScanView.tsx`](frontend/src/app/components/views/ScanView.tsx), [`DeviceTab.tsx`](frontend/src/app/components/views/DeviceTab.tsx), [`ChannelsTab.tsx`](frontend/src/app/components/views/ChannelsTab.tsx), [`ChannelEditSheet.tsx`](frontend/src/app/components/views/ChannelEditSheet.tsx), [`ActivityExportSheet.tsx`](frontend/src/app/components/views/ActivityExportSheet.tsx)
- [`frontend/src/store/useStore.ts`](frontend/src/store/useStore.ts) — Zustand store
- [`frontend/src/api/client.ts`](frontend/src/api/client.ts) — REST client
- [`frontend/src/websocket/ScannerWebSocket.ts`](frontend/src/websocket/ScannerWebSocket.ts) — WS client with auto-reconnect
- [`frontend/src/hooks/`](frontend/src/hooks/) — `useConnectionStatus`, `useActivityLogTracker`, `useActivityLogHydrate`, `useDashboardAnalytics`, `useShellStatusText`, `useKeyboardShortcuts`, `useMenuEvents`

## Documentation

- [`docs/SCANNER_PROTOCOL_REFERENCE.md`](docs/SCANNER_PROTOCOL_REFERENCE.md) — canonical wire-protocol reference
- [`docs/PROTOCOL_AUDIT_PLAN.md`](docs/PROTOCOL_AUDIT_PLAN.md) — audit history (Phases 1–4 done; 5–7 partly in v1.1)
- [`docs/API_SPEC.md`](docs/API_SPEC.md) — REST + WebSocket API contract
- [`docs/WEBSOCKET_SCHEMA.md`](docs/WEBSOCKET_SCHEMA.md) — WS message shapes
- [`docs/openapi.json`](docs/openapi.json), [`docs/postman_environment.json`](docs/postman_environment.json) — machine-readable API spec + Postman env
- [`docs/BACKEND_LOGGING.md`](docs/BACKEND_LOGGING.md), [`docs/DATA_LIFECYCLE.md`](docs/DATA_LIFECYCLE.md)
- [`docs/BC125AT_PROTOCOL.md`](docs/BC125AT_PROTOCOL.md) — decompiled Uniden reference. Second source only — where it disagrees with our wire captures, the captures win.
- [`docs/wire_captures/`](docs/wire_captures/) — real BC125AT wire traffic + audit reconciliation (`2026-05-21/`, `2026-05-22/`, `2026-07-08/`)
- [`docs/compass_artifact_wf-4d260a13-b490-4b4e-830c-010c039981ab_text_markdown.md`](docs/compass_artifact_wf-4d260a13-b490-4b4e-830c-010c039981ab_text_markdown.md) — broader protocol research notes (second-source cross-check)
- [`docs/IDEAS.md`](docs/IDEAS.md) — designated home for future-work ideas
- [`docs/BUG_AUDIT_2026-07-02.md`](docs/BUG_AUDIT_2026-07-02.md) — bug-audit snapshot
- [`docs/fixtures/kf0nui.bc125at_ss`](docs/fixtures/kf0nui.bc125at_ss) — sample Sentinel `.hpe` config dump
- [`docs/superpowers/`](docs/superpowers/) — design specs (`specs/`) and implementation plans (`plans/`) for non-trivial features. Each gets a dated markdown file before implementation starts (e.g. `specs/2026-07-08-live-tone-display-design.md` + `plans/2026-07-08-live-tone-display.md` for the #171 tone work). Start there when picking up a planned feature.

## Common pitfalls

### Backend
1. **Don't send `PRG`/`EPG` manually** — always use `ProgramModeGuard`.
2. **The wire is `\r`-terminated, not `\r\n`.** A stray LF leaves a byte in the input buffer and turns the next command into `ERR`.
3. **Commands are not pipelined.** Wait for each response before sending the next.
4. **`STS` field count varies by firmware.** Use tail-anchored field finding (already done in `parse_sts_response`).
5. **`SQL=1` means squelch OPEN** (signal present). Inverted from intuition.
6. **`mode` is not a wire field.** Track it from user commands as `commanded_mode`.
7. **Bank masks: `'1'` means disabled**, `'0'` means enabled. Counter-intuitive.

### Frontend
1. **Check sequence numbers** in WS handlers to avoid stale-state regressions.
2. **Mode vs squelch_open**: during a hit, mode stays "SCAN" but `squelch_open=true`. Display rules check both.
3. **Frequency only stable when held or during a hit.** Don't render during scan-cycling — it changes 5–10×/sec.
4. **Alpha tags need memory sync.** Until sync completes, channel-name lookups return null.

### macOS USB transport
The BC125AT enumerates at USB level (visible in `ioreg` with VID/PID `0x1965:0x0017`) but the kernel CDC-ACM driver never binds, so `/dev/cu.usbmodem*` never appears. Configure `usb_vid`/`usb_pid` in `config.yaml` to force the `nusb` direct-USB path. See [`docs/SCANNER_PROTOCOL_REFERENCE.md`](docs/SCANNER_PROTOCOL_REFERENCE.md) for the discrepancy with reference docs that claim CP210x VID/PID.

## Testing and CI

- **Backend:** `cargo test -p bearpaw-api --lib`. Fixtures driven by captures in `docs/wire_captures/`.
- **Frontend:** `npm test -- --run` (vitest), `npm run lint`, `npm run type-check`, `npm run format:check`. All four run on every PR via [`.github/workflows/tests.yml`](.github/workflows/tests.yml).
- **CI also runs `cargo check --workspace --all-targets`** in the backend job — a deliberate guard against silent drift in the Tauri crate (see the comment in `tests.yml` citing PR #80). Run it locally if your change touches anything the Tauri shell links against.
- [`.github/workflows/build.yml`](.github/workflows/build.yml) is the release pipeline: tag-triggered (`v*`), multi-platform Tauri bundles (macOS aarch64/x86_64, Windows, Linux). It does not run on PRs.

## Definition of done / PR discipline

Every change lands via a PR to `main` — never push to `main` directly, even for one-line fixes.

1. **Branch off `main`** with a semantic prefix: `phase/`, `feat/`, `fix/`, `cleanup/`, `chore/`, `docs/`.
2. **Tiny, single-purpose PRs.** One concern per PR, independently revertible, reviewable in under 10 minutes. If it's growing past ~250 LOC, split it.
3. **All CI checks green locally before push.** Backend: `cargo test -p bearpaw-api --lib`. Frontend, from `frontend/`: `npm test -- --run`, `npm run lint`, `npm run type-check`, `npm run format:check`. The Prettier check is the one that historically got skipped and failed CI (PR #44, #45) — don't skip it.
4. **Never push to retry CI.** If a check fails, reproduce and fix locally first.

## Third-rail flows

These are flows that have been broken-and-fixed at least once. Each one has a paired regression-guard test and a `REGRESSION GUARD:` comment in the relevant code site. Treat both as load-bearing — the comment exists to tell you why the code looks the way it does, the test exists to fail loudly if you regress it.

When you touch code near one of these guards, **read the comment**, run the named test, and only proceed if it still passes. If you need to change the behavior intentionally, update the test and the comment together — don't delete the guard silently.

| Flow | Code site | Test name | Why it broke before |
| --- | --- | --- | --- |
| WS subscription is stable across `liveState` updates | [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) WS-subscribe `useEffect` deps array | `frontend/src/app/__tests__/App.regression.test.tsx :: WS subscription is stable across liveState updates` | A PR added `liveState?.mode` to the deps array; the effect re-registered all four WS subscriptions on every poll tick (~5 Hz), cancelling in-flight scan-resume timers and producing visible "the app is misbehaving" churn. Handlers that need the latest mode must read it via `useStore.getState().liveState?.mode` at invocation time. |
| Memory-sync overlay covers subsequent syncs | [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) overlay `<AnimatePresence>` block | `frontend/src/app/__tests__/App.regression.test.tsx :: memory-sync overlay covers subsequent syncs` | PR #102 lifted the overlay to cover the whole UI during sync but gated it on `isInitialSyncing = inProgress && !hasSyncedInitially`. After the first sync, `hasSyncedInitially` flipped permanently true, so File → Sync Memory ran 30-45 s of PRG/CIN/EPG with no overlay — users could click into Channels/Device and corrupt the in-flight bracket. Gate on `isMemorySyncing` directly. |
| Cancel-sync runs the post-sync chain via the WS message | [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) `handleCancelSync` | `frontend/src/app/__tests__/App.regression.test.tsx :: handleCancelSync runs the post-sync chain via WS` | `handleCancelSync` synchronously set `inProgress: false` after the cancel API returned; the subsequent WS "Sync cancelled" message hit a progress handler that gated the post-sync chain on `currentSync.inProgress`, so channel-refresh and scan-resume were silently skipped on every cancel. The cancel handler must only request cancellation; the WS message is what flips `inProgress` and runs the chain. **One exception (#137):** on a `no_task` reply no WS message will ever come — that branch (and only that branch) clears `inProgress` locally. |
| Sync-status reconnect probe only clears state on reconnects | [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) reconnect `getSyncStatus` `useEffect` | `frontend/src/app/__tests__/App.regression.test.tsx :: sync-status reconnect probe only clears state on reconnects` | The #137 stuck-overlay fix probes `GET /memory/sync/status` on WS connect. On the *initial* connect that probe races the auto-start-sync effect — the status snapshot can be served before `POST /memory/sync` registers the task, and acting on the stale "not syncing" answer drops the blocking overlay while a PRG bracket is open. Clear-direction reconciliation must stay gated on `isReconnect`; adopting a running sync is safe unconditionally. |
| HOLD button label stays "HOLD" in both held/not-held states | [`frontend/src/app/components/ScannerUI.tsx`](frontend/src/app/components/ScannerUI.tsx) HOLD `<button>` | `frontend/src/app/components/__tests__/ScannerDisplay.test.tsx :: toggles HOLD button aria-pressed and aria-label when isHolding flips` | The visible label used to flip "HOLD" ↔ "SCAN" with `isHolding`, which implied "press here to resume" while simultaneously being the same control that entered HOLD. The held/not-held signal is now carried by `aria-pressed`, `aria-label`, and the highlight color — do not reintroduce a text-label flip. |
| Priority swap is atomic (clear-old fails → new not set) | `set_channel_priority` in `crates/bearpaw-api/src/api/mod.rs` | `plan_priority_swap_orders_clear_before_set` (+ the `REGRESSION GUARD (priority swap atomicity)` comment at the code site) | Clearing a channel's priority is a destructive DCH+rewrite; setting the new priority channel before—or despite—a failed clear can leave a bank with two priority channels or a DCH-deleted, unrestored channel. The clear must run first, in a single ProgramModeGuard bracket, with its error propagated so a failed clear aborts the swap. |

When you add a flow to this table, also add a `REGRESSION GUARD:` comment at the code site pointing back to the test name.

## Memory sync performance

Reading all 500 channels is slow (~30–45 s):
- Each channel is one `CIN,N` round-trip inside the PRG bracket.
- Progress events go out via WebSocket every ~10 channels.
- Frontend shows progress bar in the Scan view's sync banner.

Entry point: `POST /api/v1/memory/sync`. Implementation in [`crates/bearpaw-api/src/api/memory_sync.rs`](crates/bearpaw-api/src/api/memory_sync.rs).
