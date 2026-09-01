# CLAUDE.md

Guidance for Claude Code (claude.ai/code) working in this repo.

## Project overview

Bearpaw is a desktop control interface for Uniden handheld scanners. It drives **two families** that speak the same wire protocol with different memory models:

- **BC125AT family** — BC125AT, BCT125AT, UBC125XLT, UBC126AT, AE125H. 500 channels in 10 banks of 50, alpha tags, per-channel modulation and tone, signed delay, 115200 baud.
- **BC75XLT** — 300 channels in 10 banks of 30, no alpha tags, no per-channel modulation or tone (those `CIN` fields are `[RSV]`), boolean delay, 57600 baud behind a CP210x bridge.

Anything model-specific reads [`ScannerCapabilities`](crates/bearpaw-api/src/protocol/capabilities.rs) rather than hardcoding a constant — see **Scanner capabilities** below.

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

**Type-check scope:** `tsc` covers `src/` plus `vite.config.ts` and `vitest.config.ts` (see `include` in [`frontend/tsconfig.json`](frontend/tsconfig.json)). Test files **are** type-checked — there is no test exclusion — so a type error in a `__tests__` file fails CI just like one in app code.

### Tauri (full desktop app)

From [`frontend/`](frontend/):

```bash
npm run tauri:dev        # dev mode with HMR
npm run tauri:build      # bundle for release
```

## Critical architecture concepts

### 0. Scanner capabilities

Two families, same wire protocol, different memory models. Every model-specific
fact lives in one descriptor — [`ScannerCapabilities`](crates/bearpaw-api/src/protocol/capabilities.rs) —
resolved from the `MDL` reply at connect and stored on `DeviceInfo`, so model and
capabilities are always read under one lock.

| Field | BC125AT family | BC75XLT |
|---|---|---|
| `channel_count` | 500 | 300 |
| `channels_per_bank` | 50 | 30 |
| `bank_count` | 10 | 10 |
| `has_alpha_tags` | true | false (`CIN` field is `[RSV]`) |
| `has_per_channel_modulation` | true | false (global `BPL` band plan) |
| `has_tone_squelch` | true | false (`[RSV]`) |
| `has_backlight_control` | true | false (no `BLT` command) |
| `has_battery_save` / `has_contrast` / `has_weather_alert` | true | false (`ERR`) |
| `has_service_search_groups` | true | false (no `SSG` command) |
| `close_call_bands` | VHF Low, Air, VHF High, UHF, 800 MHz | VHF Low, Air, VHF High, **reserved**, UHF |
| `has_close_call_hit_scan` | true | false (`CLC` field 5 is `[RSV]`) |
| `has_priority_clear` | true (`DCH`+rewrite) | false — no `DCH`, and the firmware swaps within a bank itself |
| `has_key_beep` | true | false (`KBP` beep field is `[RSV]`) |
| `key_beep_needs_program_mode` | false | true (`KBP,NG` outside PRG) |
| `valid_delays` | `-10,-5,0,1,2,3,4,5` (seconds) | `0,1` (boolean) |
| `cleared_delay` | 2 | 0 |
| `has_unique_usb_serial` | false (every unit reports `0001`) | true (per-unit CP2104) |
| `default_baud` | 115200 | 57600 |
| `coverage_bands` | 25–54, 108–174, 225–380, 400–512 | 25–54, 108–174, 406–512 |

**Rules:**

1. **Never branch on model name.** Backend reads `state.capabilities()`; frontend
   reads `useScannerCapabilities()`. A model string scatters hardware knowledge
   across the codebase and goes stale the moment a model is added.
2. **`has_backlight_control` is not "has a backlight."** The BC75XLT has one — a
   15-second button, per its owner's manual. It has no `BLT` command and no
   settable mode. Flags name what Bearpaw can *control*.
3. **A format error aborts the WHOLE `CIN` write.** Per the vendor spec, one bad
   field silently discards the frequency, lockout, and priority in the same
   command — so reserved fields go out empty and out-of-range values are rejected
   before the wire, never "sent and hope".
4. **Adding a model means adding a descriptor.** `every_accepted_model_resolves_to_capabilities`
   fails otherwise; without it a new model silently inherits BC125AT constants.
5. **A half-fix can be worse than none.** `close_call_bands` is a labels list,
   not a "position 4 is reserved" flag, because the families swap TWO facts at
   once: which slot is dead, and what slot 5 is called. Hiding only the
   obviously-wrong 800 MHz row on a BC75XLT would leave a "UHF" switch writing
   the reserved slot — a control that looks right, reads back plausibly, and
   does nothing. The visibly-absurd row at least prompts someone to look.

The TypeScript mirror is verified against real Rust output: a backend test writes
`frontend/src/test/fixtures/scanner-capabilities.json` from the actual allowlist
and fails when it is stale, and the frontend asserts its interface against that
file. A hand-written fixture would pass whether or not it matched.

### 1. Three state surfaces

**`LiveState`** ([`crates/bearpaw-api/src/state.rs`](crates/bearpaw-api/src/state.rs)) — real-time scanner state polled 5×/sec.
- `timestamp`, `frequency`, `modulation`, `squelch_open`, `rssi`, `mode`, `channel`, `alpha_tag`, `volume`, `battery`, `stale`.
- Live tone fields, populated only during a hit (`None` while squelch is closed): `tone_squelch_kind`, `tone_squelch`, `tone_dcs_code`, `tone_dcs_label`.
- Updated by the poll loop in [`crates/bearpaw-api/src/api/poll.rs`](crates/bearpaw-api/src/api/poll.rs).

**Channel memory** — every channel read once during memory sync via `PRG` → `CIN,1` … `CIN,<channel_count>` → `EPG` (500 on the BC125AT family, 300 on a BC75XLT — the bound comes from `ScannerCapabilities`, not a constant). Cached in `AppState.shadow` (`ShadowState.channels`) and **persisted to SQLite** since #413 ([`channel_cache.rs`](crates/bearpaw-api/src/api/channel_cache.rs)), so a restart adopts the previous session's channels at connect instead of paying the walk again. The cache is a **read accelerator, not the source of truth** — the scanner is the truth, every user write reaches hardware first, and nothing may write to the cache and upload later. See **Channel-memory cache** below.

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

[`docs/WEBSOCKET_SCHEMA.md`](docs/WEBSOCKET_SCHEMA.md) documents the five broadcast types (`state_update`, `event`, `progress`, `device_info`, `banks_update`); the connection is server-push only (no client `subscribe`/`ping`/`pong`). Where doc and code disagree, the code wins.

The frontend MUST check `message.sequence > lastSequence` ([`frontend/src/store/useStore.ts`](frontend/src/store/useStore.ts) `updateLiveState`). Out-of-order updates are dropped.

### 5. Frontend display logic

The `mainText`/`subText` derivation in [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) decides what the big display shows:

- During scan with no hit: "Scanning..."
- During a hit OR mode = HOLD/DIRECT: stable frequency + alpha tag + modulation
- When sync is in progress: "Syncing Scanner Memory" + progress text

The connection-status enum (`'connected' | 'connecting' | 'disconnected'`) is derived in [`frontend/src/hooks/useConnectionStatus.ts`](frontend/src/hooks/useConnectionStatus.ts) by folding five signals (WS connected/connecting, deviceInfo.connection_status, liveState.stale, Tauri shell status).

## Wire protocol

The BC125AT speaks an ASCII line protocol over USB CDC-ACM at 115200 8N1, `\r`-terminated. **The BC75XLT speaks the same protocol at 57600** behind a CP210x bridge — autodetect probes both rates (see `docs/wire_captures/2026-08-26/bc75xlt-compatibility.md`). See [`docs/SCANNER_PROTOCOL_REFERENCE.md`](docs/SCANNER_PROTOCOL_REFERENCE.md) for the canonical wire shape and the audit history. Real wire captures live in [`docs/wire_captures/`](docs/wire_captures/) (`2026-05-21/`, `2026-05-22/`, `2026-07-08/`).

**Captures win.** When a reference doc — including the decompiled [`docs/BC125AT_PROTOCOL.md`](docs/BC125AT_PROTOCOL.md) — disagrees with the wire captures from this hardware, the captures are authoritative. Don't "fix" working code to match a reference; document the disagreement instead (see `docs/wire_captures/2026-05-21/audit-reconciliation.md` for prior reconciliations).

Commonly used commands (all implemented in [`crates/bearpaw-api/src/protocol/mod.rs`](crates/bearpaw-api/src/protocol/mod.rs)):

| Cmd | Purpose | Mode |
|---|---|---|
| `MDL` | Model probe — must reply `MDL,BC125AT` (or BCT125AT, UBC125XLT, UBC126AT, AE125H, BC75XLT) | any |
| `VER` | Firmware version | any |
| `STS` | LCD dump + status flags | any |
| `GLG` | Canonical live frequency/mod/tone/name/squelch | any |
| `PWR` | RSSI (0–1023 raw) | any |
| `KEY,<key>,P` | Virtual keypress | any |
| `PRG` / `EPG` | Enter/exit program mode | — |
| `CIN,<index>` | Read channel data | PRG |
| `GLF` / `LOF` / `ULF` | Walk/add/remove global lockouts | PRG |
| `SCG` | Bank-enable mask (10 chars, `'1'`=disabled) | PRG |
| `VOL`, `SQL` | Volume / squelch | any |
| `PRI` | Priority mode | PRG |
| `KBP` | Key beep + key lock | either on the BC125AT family; **PRG only** on a BC75XLT (`KBP,NG` outside), where the beep field is `[RSV]` and only the lock is settable |
| `BLT`, `BSV`, `CNT`, `WXS` | Backlight, battery save, contrast, weather alert | either — **absent on the BC75XLT**, all reply `ERR` |
| `SSG` | Service-search avoid mask (10 chars) | PRG — **absent on the BC75XLT**, which has service search but no way to enable a band remotely |
| `BPL` | Band plan (USA/Canada). Where modulation lives on a BC75XLT | PRG |

CTCSS/DCS codes (0–231) are decoded to Hz in [`crates/bearpaw-api/src/protocol/tones.rs`](crates/bearpaw-api/src/protocol/tones.rs).

## Transport

Two transports, picked based on config:

- **`SerialTransport`** ([`crates/bearpaw-api/src/transport.rs`](crates/bearpaw-api/src/transport.rs)) — `serialport` crate, opens `/dev/cu.usbmodem*` / `/dev/ttyUSB0` / `COMx`.
- **`UsbTransport`** ([`crates/bearpaw-api/src/transport_usb.rs`](crates/bearpaw-api/src/transport_usb.rs)) — `rusb` direct bulk endpoints. Used when serial CDC binding fails (macOS — see Pitfalls).

The poll loop dispatches to the right transport based on whether the resolved port string starts with `usb:` (USB pseudo-target) or looks like a serial device. See [`crates/bearpaw-api/src/config.rs::resolve_serial_port`](crates/bearpaw-api/src/config.rs).

## Configuration

`./config.yaml` at repo root (gitignored). Example in [`crates/bearpaw-api/config.example.yaml`](crates/bearpaw-api/config.example.yaml).

**Neither scanner needs a config file.** Autodetect finds both: the BC125AT family via the direct-USB probe, the BC75XLT via its CP210x serial node, probing 115200 and 57600 in turn.

Minimal macOS config, if you want to pin the BC125AT-family path explicitly:

```yaml
device:
  usb_vid: 0x1965
  usb_pid: 0x0017
api:
  host: 127.0.0.1
  port: 8000
```

On macOS the BC125AT enumerates over USB but the kernel CDC-ACM driver never binds — `/dev/cu.usbmodem*` does not appear. Setting `usb_vid`/`usb_pid` forces the `rusb` direct-USB path. Linux/Windows usually omit those fields.

**Do not set `usb_vid`/`usb_pid` for a BC75XLT.** Its CP210x bridge binds normally, so it is a serial device — and `UsbTransport` cannot drive a CP210x (see the note in `config.rs::usb_candidate_rank`). Set `baud: 57600` only to force the rate; autodetect already probes it.

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
- [`crates/bearpaw-api/src/api/channel_cache.rs`](crates/bearpaw-api/src/api/channel_cache.rs) — channel-memory persistence: snapshot flush, guarded load
- [`crates/bearpaw-api/src/api/ws.rs`](crates/bearpaw-api/src/api/ws.rs) — WebSocket broadcast
- [`crates/bearpaw-api/src/api/security.rs`](crates/bearpaw-api/src/api/security.rs) — CORS + Host-header hardening. The API is an unauthenticated loopback server, so any web page the user visits is the threat; this closes the cross-origin-fetch and DNS-rebinding paths.
- [`crates/bearpaw-api/src/api/handlers/`](crates/bearpaw-api/src/api/handlers/) — REST handlers (analytics, banks, commands, exports, import_ss, lockouts, memory, preferences, settings, status)
- [`crates/bearpaw-api/src/protocol/mod.rs`](crates/bearpaw-api/src/protocol/mod.rs) — STS/GLG/CIN/PWR parsers
- [`crates/bearpaw-api/src/protocol/capabilities.rs`](crates/bearpaw-api/src/protocol/capabilities.rs) — `ScannerCapabilities`: per-model memory model and feature set
- [`crates/bearpaw-api/src/protocol/tones.rs`](crates/bearpaw-api/src/protocol/tones.rs) — CTCSS/DCS code → Hz
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
- [`frontend/src/hooks/`](frontend/src/hooks/) — `useConnectionStatus`, `useActivityLogTracker`, `useActivityLogHydrate`, `useDashboardAnalytics`, `useShellStatusText`, `useKeyboardShortcuts`, `useMenuEvents`, `useUpdateCheck`

### Desktop shell (Tauri)
- [`frontend/src-tauri/src/main.rs`](frontend/src-tauri/src/main.rs) — shell entry point, sidecar backend, menu wiring
- [`frontend/src-tauri/src/updates.rs`](frontend/src-tauri/src/updates.rs) — update check against the GitHub Releases API

## Update checks

The desktop shell checks GitHub Releases for a newer version (#273). Three properties are deliberate and easy to break:

1. **Check-and-notify only.** There is no in-app download, signature verification, or self-replacement — the toast's Download button opens the release page in a browser. Real self-update needs `tauri-plugin-updater`, a minisign keypair in CI, and a Developer ID cert (the bundle is ad-hoc signed today, so a swapped bundle would be Gatekeeper-quarantined).
2. **Every failure is silent.** Bearpaw is offline-first, so `check_for_updates` returns "no update" on *any* transport, status, or parse failure. A user with no network must never see an error, a toast, or a stall. The startup check is silent unless an update exists; the manual check (Help → Check for Updates) always reports, including "you're up to date," because a menu item that appears to do nothing reads as broken.
3. **Betas track betas.** A prerelease is only ever offered to a user already running a prerelease; stable users are never pushed onto a beta. The policy is applied twice — against GitHub's `prerelease` flag *and* against the parsed tag — because the flag is what GitHub was told while the tag is the truth. Selection uses `max_by`, not first-match: GitHub returns releases newest-*created* first, which is not newest-*version* when a patch to an older line ships later.

Gated by the `check_updates_on_launch` preference (default `true`, toggled on the Device tab). The startup check waits for preferences to load rather than acting on a default that may be about to change. `updates.rs` carries unit tests plus an `#[ignore]`d live test against the real API (`cargo test -p bearpaw-desktop -- --ignored`).

## Documentation

- [`docs/SCANNER_PROTOCOL_REFERENCE.md`](docs/SCANNER_PROTOCOL_REFERENCE.md) — canonical wire-protocol reference
- [`docs/API_SPEC.md`](docs/API_SPEC.md) — REST + WebSocket API contract
- [`docs/WEBSOCKET_SCHEMA.md`](docs/WEBSOCKET_SCHEMA.md) — WS message shapes
- [`docs/BACKEND_LOGGING.md`](docs/BACKEND_LOGGING.md), [`docs/DATA_LIFECYCLE.md`](docs/DATA_LIFECYCLE.md)
- [`docs/SS_FILE_FORMAT.md`](docs/SS_FILE_FORMAT.md) — the `.bc125at_ss` / `.bc75xlt_ss` settings-file format, recovered from real files written by Uniden's tools. Reference files live in [`crates/bearpaw-api/fixtures/`](crates/bearpaw-api/fixtures/) and back two golden tests.
- [`docs/BC125AT_PROTOCOL.md`](docs/BC125AT_PROTOCOL.md) — decompiled Uniden reference. Second source only — where it disagrees with our wire captures, the captures win.
- [`docs/wire_captures/`](docs/wire_captures/) — real BC125AT wire traffic + audit reconciliation (`2026-05-21/`, `2026-05-22/`, `2026-07-08/`)
- **End-user guide** — lives on the marketing site at [bearpaw.app/docs](https://bearpaw.app/docs/), hand-authored HTML in [`site/docs/`](site/docs/) (getting started, scan, channels, device, glossary, troubleshooting). Not in `docs/` — that holds developer/protocol docs only.

## Common pitfalls

### Backend
1. **Don't send `PRG`/`EPG` manually** — always use `ProgramModeGuard`.
2. **The wire is `\r`-terminated, not `\r\n`.** A stray LF leaves a byte in the input buffer and turns the next command into `ERR`.
3. **Commands are not pipelined.** Wait for each response before sending the next.
4. **`STS` field count varies by firmware.** Use tail-anchored field finding (already done in `parse_sts_response`).
5. **`SQL=1` means squelch OPEN** (signal present). Inverted from intuition.
6. **`mode` is not a wire field.** Track it from user commands as `commanded_mode`.
7. **Bank masks: `'1'` means disabled**, `'0'` means enabled. Counter-intuitive. An all-disabled mask is refused by the scanner — reject it before the wire.
8. **A `CIN` format error aborts the WHOLE write.** One bad field discards the frequency, lockout, and priority in the same command. Validate before sending; never send-and-hope.
9. **Reserved `CIN` fields go out EMPTY.** An empty field means "leave unchanged"; writing a value into a `[RSV]` slot risks the format error in #8.
10. **Never hardcode 500 / 50 / 115200 / delay 2.** Read `ScannerCapabilities`. The BC75XLT differs on every one of them.
11. **The first command after a fresh open can return `ERR`.** A CP210x bridge buffers whatever was on the line. Retry — `probe_mdl_on_port` and the poll loop both do.
12. **One scanner can present as four serial nodes** (two drivers × `cu.`/`tty.`). Dedupe on `(vid, pid, serial)`. Never probe a `/dev/tty.*` node — it blocks on carrier detect, which a scanner never asserts.

### Frontend
1. **Check sequence numbers** in WS handlers to avoid stale-state regressions.
2. **Mode vs squelch_open**: during a hit, mode stays "SCAN" but `squelch_open=true`. Display rules check both.
3. **Frequency only stable when held or during a hit.** Don't render during scan-cycling — it changes 5–10×/sec.
4. **Alpha tags need memory sync** — and a BC75XLT never has them at all. Gate on `has_alpha_tags`, not on "the sync finished".
5. **Hide unsupported controls, don't disable them.** A greyed-out control the scanner cannot honour is noise on every row; an absent one asks no questions.
6. **Use conditional rendering, not the `hidden` attribute.** `hidden` is presentational — the element stays in the DOM, stays findable by `getByLabelText`, and stays visible to assistive tech that ignores it.

### macOS USB transport

**BC125AT family** — enumerates at USB level (visible in `ioreg` with VID/PID `0x1965:0x0017`) but the kernel CDC-ACM driver never binds, so `/dev/cu.usbmodem*` never appears. Configure `usb_vid`/`usb_pid` in `config.yaml` to force the `rusb` direct-USB path, or let autodetect find it.

**BC75XLT** — sits behind a Silicon Labs CP2104 bridge (`0x10C4:0xEA60`), and that driver *does* bind, so ordinary serial works. It needs no config: autodetect probes both 115200 and 57600.

This resolves a long-standing note in [`docs/SCANNER_PROTOCOL_REFERENCE.md`](docs/SCANNER_PROTOCOL_REFERENCE.md) about reference docs claiming a CP210x VID/PID. Both are right — different models, different bridges.

## Testing and CI

- **Backend:** `cargo test -p bearpaw-api --lib` and `cargo fmt --all -- --check`. Fixtures driven by captures in `docs/wire_captures/`.
- **Frontend:** `npm test -- --run` (vitest), `npm run lint`, `npm run type-check`, `npm run format:check`.
- **CI also runs `cargo check --workspace --all-targets`** in the backend job — a deliberate guard against silent drift in the Tauri crate (see the comment in `tests.yml` citing PR #80). Run it locally if your change touches anything the Tauri shell links against. It needs `frontend/dist` to exist: `tauri::generate_context!` reads `frontendDist` at **compile** time and panics if the directory is missing, which reads like a Rust regression and is not one. CI builds the frontend first for exactly this reason; in a fresh worktree you must too (`cd frontend && npm ci && npm run build`).
- [`.github/workflows/build.yml`](.github/workflows/build.yml) is the release pipeline: tag-triggered (`v*`), multi-platform Tauri bundles (macOS aarch64/x86_64, Windows, Linux). It does not run on PRs.

### The five required checks, and why `tests.yml` has no `paths:` filter

As of 2026-08-29 `main` is branch-protected, and [`tests.yml`](.github/workflows/tests.yml)'s five jobs are **required status checks**:

`Backend Tests` · `Frontend Tests` · `Frontend Lint` · `Frontend Type Check` · `Frontend Format Check`

No required reviews (solo maintainer), `strict` off, `enforce_admins` off. CodeQL and `claude-review` deliberately are **not** required — `Analyze (rust)` alone takes ~7 min against ~3 for all of Tests, and `claude-review` is skipped on Dependabot and fork PRs, where a skipped required check would block the merge.

**These two settings are coupled, and the coupling is easy to miss.** `tests.yml` used to carry a `paths:` allowlist so docs-only PRs skipped ~9 minutes of pointless build. That was correct while its stated premise held — the comment said so plainly: *"`main` has no branch protection, so a PR reporting zero checks is still mergeable."* Adding protection silently invalidated it: **a required check that never runs never reports, so a filtered-out PR becomes permanently unmergeable**, not fast. Every docs-only, `site/**`-only and workflow-bump PR was affected, Dependabot's included. Removed in #535.

If a path filter is ever wanted back, it must ship together with a companion workflow reporting those same five job names for the excluded paths — and that companion is its own landmine, because renaming a job here without renaming it there blocks every PR with no visible cause.

## Definition of done / PR discipline

Every change lands via a PR to `main` — never push to `main` directly, even for one-line fixes.

1. **Branch off `main`** with a semantic prefix: `phase/`, `feat/`, `fix/`, `cleanup/`, `chore/`, `docs/`.
2. **Tiny, single-purpose PRs.** One concern per PR, independently revertible, reviewable in under 10 minutes. If it's growing past ~250 LOC, split it.
3. **All CI checks green locally before push.** Backend: `cargo test -p bearpaw-api --lib`, `cargo fmt --all -- --check`. Frontend, from `frontend/`: `npm test -- --run`, `npm run lint`, `npm run type-check`, `npm run format:check`. Both format checks are the ones that historically got skipped and failed CI (PR #44, #45) — don't skip them.

   Run `cargo fmt --all` (no `--check`) to fix Rust formatting. It is safe to run repo-wide: the drift that made it produce unreviewable diffs was cleared in #394, and CI now keeps it clean.
4. **Never push to retry CI.** If a check fails, reproduce and fix locally first.
5. **Merging is deliberate.** `allow_auto_merge` is `false` on this repo, and `--auto` does not fail cleanly when it is off — it silently degrades to merge-now, with no output that reliably signals which happened. Never pass `--auto`. Wait for the checks, confirm, then `gh pr merge <n> --squash`. See the `bearpaw-pr` skill.

### Verify the setting before acting on the procedure that depends on it

Every rule here was true when written. Some stopped being true without anyone editing the sentence — and a stale *procedure* is more dangerous than a stale *fact*, because a procedure gets followed rather than read.

Two instances, both on 2026-08-29, both one API call away from being caught:

- The `bearpaw-pr` skill instructed enabling auto-merge on every PR. The repo setting had since flipped off, so the flag degraded to merge-now and landed a PR **seven seconds** after opening, before any check started. `gh api repos/jeremyfuksa/bearpaw --jq .allow_auto_merge` says `false`.
- Branch protection was added without checking what depended on the old unprotected state. `tests.yml`'s `paths:` filter — whose own comment named that dependency in plain English — would have made every docs-only PR unmergeable.

So: before following a documented procedure that turns on a repo, service, or tool setting, **check the setting**. Docs are evidence; the API is truth. And when you find a conflict between two rules here, **surface it rather than silently picking a side** — picking quietly is what turned both of the above from a contradiction into an incident.

## Third-rail flows

These are flows that have been broken-and-fixed at least once. Each one has a paired regression-guard test and a `REGRESSION GUARD:` comment in the relevant code site. Treat both as load-bearing — the comment exists to tell you why the code looks the way it does, the test exists to fail loudly if you regress it.

When you touch code near one of these guards, **read the comment**, run the named test, and only proceed if it still passes. If you need to change the behavior intentionally, update the test and the comment together — don't delete the guard silently.

| Flow | Code site | Test name | Why it broke before |
| --- | --- | --- | --- |
| WS subscription is stable across `liveState` updates | [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) WS-subscribe `useEffect` deps array | `frontend/src/app/__tests__/App.regression.test.tsx :: WS subscription is stable across liveState updates` | A PR added `liveState?.mode` to the deps array; the effect re-registered all four WS subscriptions on every poll tick (~5 Hz), cancelling in-flight scan-resume timers and producing visible "the app is misbehaving" churn. Handlers that need the latest mode must read it via `useStore.getState().liveState?.mode` at invocation time. |
| Memory-sync overlay covers subsequent syncs | [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) overlay `<AnimatePresence>` block | `frontend/src/app/__tests__/App.regression.test.tsx :: memory-sync overlay covers subsequent syncs` | PR #102 lifted the overlay to cover the whole UI during sync but gated it on `isInitialSyncing = inProgress && !hasSyncedInitially`. After the first sync, `hasSyncedInitially` flipped permanently true, so File → Sync Memory ran 30-45 s of PRG/CIN/EPG with no overlay — users could click into Channels/Device during a sync. **Corrected 2026-08-30: the stated hazard — "corrupt the in-flight PRG bracket" — is NOT reachable.** `ControlCommand::StartSync` dispatches `memory_sync::run_*` INLINE inside the poll thread's own `cmd_rx.try_recv()` drain loop, so the queue is not drained for the sync's duration and no user command can interleave with the PRG/CIN/EPG bytes. Every PRG-needing handler is refused before the wire anyway: `ProgramModeGuard::enter` returns 409 while `sync_task_id` is set. What the overlay actually buys is (a) suppression of a 409/timeout toast storm and (b) an honest display — the poll loop yields `STS`/`GLG` during program mode, so a non-blocking UI would show a frozen frequency that looks live. Both are real; neither is data corruption. Keep gating on `isMemorySyncing` directly, and do not justify the overlay on bracket-corruption grounds. Also stale: the sync is **~5 s** on a BC125AT over direct USB (measured three times, 2026-08-30), not 30–45 s. |
| Cancel-sync runs the post-sync chain via the WS message | [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) `handleCancelSync` | `frontend/src/app/__tests__/App.regression.test.tsx :: handleCancelSync runs the post-sync chain via WS` | `handleCancelSync` synchronously set `inProgress: false` after the cancel API returned; the subsequent WS "Sync cancelled" message hit a progress handler that gated the post-sync chain on `currentSync.inProgress`, so channel-refresh and scan-resume were silently skipped on every cancel. The cancel handler must only request cancellation; the WS message is what flips `inProgress` and runs the chain. **One exception (#137):** on a `no_task` reply no WS message will ever come — that branch (and only that branch) clears `inProgress` locally. |
| Sync-status reconnect probe only clears state on reconnects | [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) reconnect `getSyncStatus` `useEffect` | `frontend/src/app/__tests__/App.regression.test.tsx :: sync-status reconnect probe only clears state on reconnects` | The #137 stuck-overlay fix probes `GET /memory/sync/status` on WS connect. On the *initial* connect that probe races the auto-start-sync effect — the status snapshot can be served before `POST /memory/sync` registers the task, and acting on the stale "not syncing" answer drops the blocking overlay while a PRG bracket is open. Clear-direction reconciliation must stay gated on `isReconnect`; adopting a running sync is safe unconditionally. |
| HOLD button label stays "HOLD" in both held/not-held states | [`frontend/src/app/components/ScannerUI.tsx`](frontend/src/app/components/ScannerUI.tsx) HOLD `<button>` | `frontend/src/app/components/__tests__/ScannerDisplay.test.tsx :: toggles HOLD button aria-pressed and aria-label when isHolding flips` | The visible label used to flip "HOLD" ↔ "SCAN" with `isHolding`, which implied "press here to resume" while simultaneously being the same control that entered HOLD. The held/not-held signal is now carried by `aria-pressed`, `aria-label`, and the highlight color — do not reintroduce a text-label flip. |
| Priority swap is atomic (clear-old fails → new not set) | `set_channel_priority` in `crates/bearpaw-api/src/api/mod.rs` | `plan_priority_swap_orders_clear_before_set`, `priority_swap_skips_the_clear_where_the_firmware_owns_it`, `priority_swap_still_clears_where_bearpaw_owns_it`, `priority_swap_survives_a_failed_post_set_reread` (+ the `REGRESSION GUARD (priority swap atomicity)` comments at the code site) | Clearing a channel's priority is a destructive DCH+rewrite; setting the new priority channel before—or despite—a failed clear can leave a bank with two priority channels or a DCH-deleted, unrestored channel. The clear must run first, in a single ProgramModeGuard bracket, with its error propagated so a failed clear aborts the swap. **#479 update:** that is true only where Bearpaw owns the clear. A BC75XLT has no `DCH` and refuses an in-place clear, but its firmware moves the flag within a bank itself (hardware 2026-08-28) — so the clear is skipped on `!has_priority_clear` and the old channel is re-read AFTER the set. Running the clear there was not merely redundant, it was the one step that could not work: every swap failed. The two guards are paired because asserting only the BC75XLT half would pass for a build that never clears on any model. **#532 update:** the two reads in this function are NOT symmetric and must not be made so. The clear-before-set read propagates with `?` because nothing is committed yet, so failing aborts the swap. The post-set re-read is informational — the `CIN` write is already sent and verified by readback when it runs — so its error is warned, not propagated. Propagating it reported a failed swap for a change the scanner had committed, on the one model whose CP210x bridge is documented to `ERR` a first command (pitfall #11). |
| Channel reorder is keyboard-operable | [`frontend/src/app/components/views/ChannelsTab.tsx`](frontend/src/app/components/views/ChannelsTab.tsx) grip `<button>` in `ChannelRow` | `frontend/src/app/components/views/__tests__/ChannelsTab.test.tsx :: Keyboard reordering (#236)` | Reorder is driven by `react-dnd`'s **TouchBackend** (the HTML5 backend never fires `dragover`/`drop` in Tauri's WKWebView, #195), and pointer backends have no keyboard interaction at all — so the grab/move/drop path on the grip button is the *only* way a keyboard-only user can reorder (WCAG 2.1.1, Level A). If the grip reverts to a decorative `GripVertical` icon, the whole capability silently disappears with no visual change. The grab deliberately lives on its own focusable control rather than the row's Enter/Space, which is already claimed by the a11y C1 guard (open edit sheet). Reorder is also filter-unsafe — `rowIndex` is a position in the *filtered* list while `moveRow` splices the *unfiltered* bank order — so the grip must stay disabled while a search term is active. |
| Leaving the Device page resumes scan | [`frontend/src/app/App.tsx`](frontend/src/app/App.tsx) `handleTabChange` (+ the `TabBar` wiring) | `frontend/src/app/__tests__/App.regression.test.tsx :: leaving the Device page resumes scan` | A Device-page write (unlock, bank/priority edit) runs inside a PRG/EPG bracket that parks the scanner in HOLD at ch1. Scan is intentionally NOT resumed on the page; it resumes when the user navigates away to Scan/Channels. Two regressions: dropping the `leavingDevice` resume in `handleTabChange`, or wiring `TabBar`'s `onTabChange` straight to `setCurrentTab` (bypassing the handler, so tab-bar clicks — the primary navigation — never resume and the scanner stays stuck at ch1). |
| `buildEmptyDraft` describes a cleared channel as the SCANNER reports it | [`frontend/src/app/components/views/ChannelsTab.tsx`](frontend/src/app/components/views/ChannelsTab.tsx) `buildEmptyDraft` (+ the `isClearPending` gate in the row-render loop) | `frontend/src/app/components/views/__tests__/ChannelsTab.test.tsx :: buildEmptyDraft matches a cleared channel as the scanner reports it` (+ `buildDraft returns the empty-draft shape for a cleared channel`, `an uploaded clear stops counting as a pending change`) | `buildDraft` short-circuits to `buildEmptyDraft` for any zero-frequency channel, so after an uploaded clear the rebuilt draft is diffed against the refetched channel by `draftChanges`' `hasChanges`. Every field that disagrees keeps the channel in `pendingChannelIds` **forever** — the row keeps its pending/cleared styling AND Upload Changes stays lit, rewriting those channels on every upload. `buildEmptyDraft` was written as "zero everything out" (`delay: '0'`, `lockout: false`); the hardware reports `delay: 2, lockout: true` for a cleared slot. Measured on the dev unit: 150/150 cleared channels permanently pending before, 0/150 after. Neither field is a sentinel — 0 is a valid delay and `lockout: false` is a real, different state — so do not "simplify" this back to zeroes. Both helpers are exported **for the tests**: two earlier attempts at this guard hand-built the draft shape in the test file and passed happily with the bug reintroduced, so the guard must assert the real function. The related `isClearPending` gate (`isCleared && isPending`) is necessary but NOT sufficient on its own: it gates on a signal that this bug prevented from ever clearing. **#404 update:** the cleared-slot delay is MODEL-DEPENDENT and now comes from `ScannerCapabilities.cleared_delay` — the BC125AT family reports 2, a BC75XLT reports 0 (`CIN,299 -> CIN,299,,00000000,,,0,1,0`, hardware 2026-08-26). Hardcoding either value reproduces this exact bug on the other scanner. Lockout is `true` on both, so it stays a literal. |

| Bank derivation follows the connected scanner | [`crates/bearpaw-api/src/protocol/mod.rs`](crates/bearpaw-api/src/protocol/mod.rs) `parse_cin_response` (leaves `bank: 0`) + `AppState::channels_with_banks` in [`api/mod.rs`](crates/bearpaw-api/src/api/mod.rs) + `deriveBankFromIndex` in [`ChannelsTab.tsx`](frontend/src/app/components/views/ChannelsTab.tsx) | `cin_does_not_derive_bank` **and** `channels_with_banks_derives_per_model` (+ `deriveBankFromIndex` suite in `ChannelsTab.test.tsx`) | Bank width is 50 channels on the BC125AT family and 30 on the BC75XLT, but a hardcoded `/ 50` lived in three places — the parser, the free function, and a frontend duplicate. All three agreed while all three were wrong: measured on hardware, 7 of 11 sampled BC75XLT channels were misfiled and channel 300 reported bank 6 instead of 10. Roughly a third of channels are correct by coincidence (channel 60 is bank 2 either way), which is why a spot check misses it. The parser CANNOT derive bank — it is pure, with no `AppState` and so no capability descriptor — and the wire carries no bank field at all (membership comes from `SCG`), so `bank: 0` there is an accurate statement rather than a placeholder. The two guards are paired on purpose: either alone passes while banks are broken. If the frontend and backend ever disagree, the UI files a channel in one bank while the scanner is told another — which is how a priority swap clears the wrong bank. |
| An exported CSV can be re-imported | `export_csv` in [`api/handlers/exports.rs`](crates/bearpaw-api/src/api/handlers/exports.rs) — read through `AppState::channels_with_banks`, never `state.shadow` directly | `an_exported_csv_re_imports` | `export_csv` collected channels straight out of the cache and wrote `ch.bank` into the Bank column. Bank is not a wire field: `parse_cin_response` leaves it `0` (the row above) and ONLY `channels_with_banks` derives it, so every exported row said `Bank,0` — which `parse_import_csv_row` rejects with `Invalid bank: 0`. Bearpaw's own export could not be re-imported, and had not been since #421 moved the derivation out of the parser and updated every reader except this one. Measured on the dev unit 2026-09-01: **350 programmed channels, 350 errors, 0 imported.** The silent half is worse — the 150 cleared rows hit `Ok(None)` (frequency 0 is skipped BEFORE the bank check) and vanished from both the imported count and the error list, so the toast read "Imported 0 — 350 failed" while quietly dropping 150 more. Every other test in that module hand-builds its row with `("Bank", "1")`, a value the export never produced, so all of them passed for the whole life of the bug; `parse_empty_slot_is_skipped_not_error` even cites "the hundreds of import errors bug" while fixing only the cleared half. **The guard must drive the real `export_csv` and assert the derived VALUE** (indices 1, 60, 500 → banks 1, 2, 10): a parses-without-error check passes for an export hardcoding `1`, which misfiles every channel above bank 1. The bank column is decorative — it never reaches the wire — so this cost nothing but the round trip; see the follow-up issue on whether import should validate it at all. |
| A migration step is atomic and never bumps the version on failure | [`crates/bearpaw-api/src/api/mod.rs`](crates/bearpaw-api/src/api/mod.rs) `run_migration_step` | `a_failed_step_leaves_the_version_unchanged`, `a_partly_failing_step_rolls_back_entirely`, `a_failed_backup_aborts_the_migration` | Every migration statement was `let _ = conn.execute(...)` followed by an unconditional `set_schema_version`, so a failed step still marked the database migrated: the next launch read the new version, skipped the migration, and queried a schema that did not exist — invisible until a query hit a missing column. The version bump now lives INSIDE the step's transaction, so it cannot outlive a failure. Migrations are forward-only, which makes the pre-migration `.bak` the only recovery path — so a failed backup aborts rather than proceeding, and **nothing in Bearpaw deletes a `.bak`**. A database whose `user_version` is NEWER than this build is refused outright; running old code against a newer schema is silent misbehaviour. See `docs/DATA_LIFECYCLE.md`. |
| Each test gets its own databases | [`crates/bearpaw-api/src/api/mod.rs`](crates/bearpaw-api/src/api/mod.rs) `fallback_db_path` (cfg-split) | `each_state_gets_its_own_databases` | `resolve_db_path` falls back to a fixed path when its env var is unset, and no test sets one — so all 29 `default_state()` calls opened the SAME two SQLite files and contended under parallel execution. `preferences_reset_alias_matches` deletes every preference row, which a concurrent test could observe mid-assertion. The suite passed with `--test-threads=1` and failed intermittently without it, and adding unrelated tests made it MORE likely to fire. That failure shape is the dangerous one: it trains people to rerun, and CLAUDE.md's "Never push to retry CI" depends on failures being real. |
| The channel cache records when the RADIO was read | [`channel_cache.rs`](crates/bearpaw-api/src/api/channel_cache.rs) `flush_channel_cache` | `a_flush_records_the_sync_time_not_the_flush_time`, `a_flush_with_no_recorded_sync_stamps_now` | `flush_channel_cache` stamped `epoch_now()`. That was correct while the only caller was a completed sync — there, "now" and "when the radio was read" are the same instant — and #537 added a caller on a 30-second timer, which quietly broke the equivalence: a cache read three days ago relabelled itself as fresh twice a minute, and it overwrote the timestamp a cache load restores within one interval of launch. `synced_at` exists to answer "how stale is this?" (#413 wants "last synced 3 days ago" on screen), and an indicator that always reads "moments ago" is worse than none because it looks like it works. The stamp is `shadow.last_sync`, falling back to `epoch_now()` only when no sync is recorded. **Every test in #537 passed while this was broken** — they asserted `last_synced_at(...).is_some()`, and a guard that checks a value exists cannot notice the value is wrong. The two guards are paired: the first alone passes for a build stamping a hardcoded 0.0. |
| A cached channel map is only adopted from the SAME scanner | [`channel_cache.rs`](crates/bearpaw-api/src/api/channel_cache.rs) `load_channel_cache` + the call site in [`poll.rs`](crates/bearpaw-api/src/api/poll.rs) `update_device_info_from_mdl` | `a_matching_cache_is_loaded_on_connect`, `a_cache_from_a_larger_scanner_is_discarded`, `a_cache_from_a_smaller_scanner_is_discarded`, `a_reconnect_does_not_overwrite_live_channels`, `a_loaded_cache_restores_the_sync_time` | Three separate traps. **(a)** The capacity comparison is `!=`, not `>`. Rejecting only the too-big direction still lets a BC75XLT's 300 rows load onto a 500-channel BC125AT, and because the frontend suppresses its startup sync whenever channels exist, the wrong radio's memory renders and never refreshes. Nothing panics either way — `index_to_bank` returns 0 above `channel_count` while the frontend's `deriveBankFromIndex` clamps to `bankCount`, so phantoms render in a bank the backend calls 0, and `export_csv` writes them to the user's file. **(b)** The load must run at the MDL chokepoint: before `MDL` is parsed `AppState::capabilities()` answers with the BC125AT default of 500, so an earlier load waves a 500-row cache onto a BC75XLT. Use the local `caps` — `state.capabilities()` takes `device.read()` and the function held `device.write()`. **(c)** It must NOT be gated on `transitioned_to_connected`, which is always false in production (#539) and true in tests: green CI, dead on hardware. Gate on an empty shadow instead — which is also what stops a reconnect (every few seconds on a flapping USB link, and nothing clears `shadow.channels` on disconnect) from stomping live edits with stale rows. The positive guard is not optional: with the load call removed, both discard guards stay green. |
| Only a complete channel map is written to the cache | [`channel_cache.rs`](crates/bearpaw-api/src/api/channel_cache.rs) `is_complete_image`, applied in `flush_channel_cache` and `load_channel_cache`, plus the per-row error check in `save_channels` | `a_partial_shadow_does_not_overwrite_a_complete_cache`, `a_holed_walk_does_not_delete_the_good_cache`, `a_walk_missing_a_middle_channel_does_not_replace_the_cache`, `a_map_whose_indices_are_shifted_is_refused`, `a_save_whose_insert_fails_does_not_commit` | The write side had NO completeness guard at all — only "the map is not empty" — while the read side inferred it from `max(index)`. Same question, two different wrong answers (#567, #569). `save_channels` DELETEs before inserting, so any non-empty shadow replaced the whole cache: a `GET /memory/channels/:index` landing before the MDL probe leaves ONE row in the shadow, and the 30-second timer then wrote it over 500 good ones. The walk also skips a channel it could not read (a `Soft` error or an unparseable reply — expected over 300–500 commands on a CP210x, pitfall #11), and a skip at the TOP index destroyed the good cache and wrote rows that `load_channel_cache` then rejected on every launch **forever**. Both halves of `is_complete_image` are separately pinned and neither is redundant: delete `len` and only the middle-hole guard goes red, delete `max(index)` and only the shifted-index guard does. The shifted-index guard must assert cache CONTENT, not row count — a shifted map writes exactly `channel_count` rows too, so counting them passes either way (found by mutation, not review). **#569 is fixed by prevention, not tolerance:** a cache with a hole is still discarded at load, because telling "299 rows from a BC75XLT" from "299-of-500 from a BC125AT" needs the writer's capacity STORED, which needs a migration — and #574 says the pre-migration backup is incomplete, so that migration must not land first. |
| Cached channels suppress the startup memory sync | [`frontend/src/hooks/useAutoMemorySync.ts`](frontend/src/hooks/useAutoMemorySync.ts) (lifted out of `App.tsx` in #568 so it can be MOUNTED) | `frontend/src/hooks/__tests__/useAutoMemorySync.test.tsx` (behavioural) + `frontend/src/app/__tests__/App.regression.test.tsx :: cached channels suppress the startup memory sync` (shape and order) | The early return is what turns "the backend already has channel memory" into "no startup sync" — the user-visible payoff of #413. **CONDITIONAL:** `if (!preferences.rereadMemoryOnConnect && channels.length > 0) return;`. The `reread_memory_on_connect` preference defaults ON, because a user poll (n=20, 2026-08-30) found 45% program their scanner on its own keypad "all the time" — for them a cached list is stale before Bearpaw opens. OFF is the cache-first path. **Both sides are pinned separately, and that is the point:** when this guard first went red against the conditional form, the tempting fix was to loosen it to "the body mentions `channels.length`", which passes for a build where NEITHER path works. **#568 REVERSED one instruction here.** This row used to say to assert "the preference's presence in the deps array". That was wrong, and the bug it let through was the toggle itself driving the radio: `reread_memory_on_connect` governs what happens at CONNECT, so as a dependency it made flipping the switch re-run the effect and start a blocking sync over the settings page the user was standing on. The preference is now read at invocation via `useStore.getState()` and must NOT be in the deps array; `preferencesLoaded` is what carries a stored value to an already-connected launch. The old guard could not have caught it — it asserted the deps array *contained a string*, which a build with the bug satisfies perfectly. That is why this flow now has a behavioural guard as well as source-level ones: source checks pin shape and order and are blind to timing, and this was a timing bug. Two earlier facts here were stale and are corrected: the connect-edge `device_info` broadcast DOES fire (#539 fixed in #551, and App.tsx refetches channels on it), and the sync is ~5 s, not 30–45. |

When you add a flow to this table, also add a `REGRESSION GUARD:` comment at the code site pointing back to the test name.

## Channel-memory cache

Channel memory is persisted to SQLite (`channel_memory`, keyed by `scanner_id`)
so a restart need not pay the ~5 s walk. Implementation in
[`channel_cache.rs`](crates/bearpaw-api/src/api/channel_cache.rs); the schema
arrived with `PREFERENCES_SCHEMA_VERSION` 1 → 2.

**The cache is a read accelerator, not the source of truth.** The scanner is the
truth. Every user-initiated write goes to hardware first and lands in the cache
second. Nothing may write to the cache and upload later — that path diverges
silently and is unrecoverable without a full re-read.

### Writes are whole-map snapshots, never per-site write-through

Eleven production sites across five files mutate `shadow.channels`, and the
count grows with every handler. Per-site persistence means one missed site
silently diverges the cache. `flush_channel_cache` writes the WHOLE map instead,
from three callers — a periodic timer (`CHANNEL_CACHE_FLUSH_SECS`), the end of a
completed sync, and clean shutdown. A snapshot cannot miss a site, and a
redundant write costs a couple of milliseconds.

### Rules

1. **`save_channels`/`load_channels` are raw primitives; the guards live in
   `flush_channel_cache`/`load_channel_cache`.** Production calls the guarded
   pair. #414 adds a second caller, and a call-site check is a check someone
   forgets.
2. **Only flush a COMPLETE map** — `is_complete_image`: `channel_count`
   entries covering `1..=channel_count`, read from the connected radio's
   capabilities. `save_channels` DELETEs before inserting, so every flush is a
   replace, and "not empty" was never enough evidence to justify one (#567).
   Several handlers insert a single channel, and the walk skips a channel it
   could not read — both produced a map that replaced the user's whole cache.
   Both halves of the predicate are load-bearing and separately pinned: `len`
   catches a hole in the middle, `max(index)` catches a shifted index range.
3. **`synced_at` records when the RADIO was read, not when the cache was
   written.** It comes from `shadow.last_sync`. Stamping the flush time made
   every cache claim it was fresh within one flush interval, forever.
4. **The load runs at the MDL chokepoint and nowhere earlier.** The capacity
   guard needs `channel_count`; before `MDL` is parsed `AppState::capabilities()`
   answers with the BC125AT default of 500, which would wave a 500-row cache
   onto a BC75XLT. Use the local `caps`, never `state.capabilities()` — that
   takes `device.read()` while `update_device_info_from_mdl` may hold
   `device.write()`.
5. **Never gate anything on `transitioned_to_connected`.** It is always false in
   production (#539) and true in tests, so a feature gated on it passes CI and
   is dead on hardware.
6. **No `bank` column, ever.** Bank width differs per model and is derived from
   the connected scanner by `channels_with_banks`. A persisted bank would let a
   cache written under one model be read under another and reproduce the
   bank-derivation third rail by a new route.

## Memory sync performance

Reading all 500 channels takes **~5 s** on a BC125AT over the macOS direct-USB path
(measured three times, 2026-08-30, POST to `in_progress:false`). This section long said
30–45 s; that figure predates the current transport and is wrong by roughly 8x. The
BC75XLT is unmeasured — 300 channels at 57600 through a CP210x is a different transport,
so do not assume it matches.

Why it is not instant:
- Each channel is one `CIN,N` round-trip inside the PRG bracket.
- Progress events go out via WebSocket every ~10 channels.
- Frontend shows progress bar in the Scan view's sync banner.

Entry point: `POST /api/v1/memory/sync`. Implementation in [`crates/bearpaw-api/src/api/memory_sync.rs`](crates/bearpaw-api/src/api/memory_sync.rs).
