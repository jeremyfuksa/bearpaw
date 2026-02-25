# Rust Backend Refactor Plan

**Goal:** Replace the Python Bearpaw backend with a native Rust implementation for better performance and reliable USB/serial on desktop (Tauri). Single process, no sidecar.

---

## Why Rust

- **USB/serial reliability:** Native serial and USB (e.g. `serialport`, `nusb`) with Tokio async; no GIL, no process boundary.
- **Performance:** One process, low memory, fast startup; polling and command handling stay tight.
- **Distribution:** One binary (Tauri app) that embeds the API server; no Python runtime or subprocess orchestration.
- **Contract unchanged:** Same REST + WebSocket API and JSON shapes; frontend stays as-is.

---

## Architecture

- **In-process server:** The Rust backend runs inside the Tauri process. An Axum HTTP server (REST + WebSocket) binds to a port (e.g. `127.0.0.1:8000` or an OS-assigned port). The existing web frontend continues to call `/api/v1/*` and `/ws`; we only need to point it at the right origin (fixed port or injected at runtime).
- **No sidecar:** Nothing is spawned; the Tauri main process hosts both the webview and the API.
- **Optional standalone binary:** The same Rust crate can expose a `main` for running the backend alone (e.g. headless or dev without Tauri).

---

## Crate Layout

```
crates/
├── bearpaw-api/          # Backend library + optional bin
│   ├── Cargo.toml
│   ├── src/
│   │   ├── lib.rs
│   │   ├── main.rs       # optional standalone binary
│   │   ├── transport/    # serial, USB
│   │   ├── protocol/     # BC125AT, SR30C command/response
│   │   ├── scheduler/    # priority command queue
│   │   ├── state/        # LiveState, ShadowState
│   │   ├── api/          # Axum routes + WebSocket
│   │   └── config.rs
│   └── ...
```

- **Tauri app** (`frontend/src-tauri`) depends on `bearpaw-api` as a library, starts the server on a background Tokio task, and (if needed) injects the API base URL into the frontend.

---

## Phased Port (Slices)

### Phase 1: Shell + status (MVP for “something works”)

- [ ] **Transport:** Serial open/close/send/receive with `serialport` or `tokio-serial`; optional USB via `nusb` or `libusb1-sys` for direct claim.
- [ ] **Protocol (minimal):** `MDL`, `STS` (and BC125AT `GLG` fallback) parsing; build `LiveState` from response.
- [ ] **Scheduler:** Single-threaded or async command queue with priority (control > telemetry > background); one command at a time to the device.
- [ ] **State:** In-memory `LiveState` + `DeviceInfo`; no persistence yet.
- [ ] **API:** `GET /api/v1/status`, `GET /api/v1/device/info`; poll loop that runs STS and broadcasts updates.
- [ ] **WebSocket:** One channel: broadcast `state_update` with the same JSON shape as today.
- [ ] **Tauri integration:** Start Axum on a fixed port (e.g. 8000) in a Tokio runtime; ensure frontend can reach it (devUrl / proxy or inject base URL).

**Exit criteria:** Tauri app opens, frontend shows status and device info; polling and WS updates work; no Python backend required.

### Phase 2: Control + scan/hold

- [ ] **Protocol:** `KEY,H,P` (hold), `KEY,S,P` (scan), `DO,<freq>,<mod>` (direct); optional volume/key beep if needed for UI.
- [ ] **API:** `POST /api/v1/commands/hold`, `POST /api/v1/commands/scan`, `POST /api/v1/frequency` (body: frequency + modulation).
- [ ] **Events:** Emit `event` (e.g. mode change) and/or rely on `state_update` for mode/frequency.

**Exit criteria:** User can hold, scan, and direct-tune from the UI; state and WS stay in sync.

### Phase 3: Memory (shadow state + sync)

- [ ] **Protocol:** `PRG` / `EPG`, `CIN,<index>`; parse channel line into `ChannelData`.
- [ ] **State:** Shadow state: list of channels; optional SQLite or JSON persistence.
- [ ] **Sync:** Background task: enter PRG, read channels in batches, exit PRG; progress via WebSocket `progress` message.
- [ ] **API:** `GET /api/v1/memory/channels`, `POST /api/v1/memory/sync`.

**Exit criteria:** Channel list and alpha tags in UI; memory sync with progress; no regression on status/control.

### Phase 4: Parity + polish

- [ ] **API parity:** Remaining endpoints (lockouts, settings, firmware, analytics, preferences, activity log, etc.) ported or stubbed with 501 where out of scope.
- [ ] **Exporters (optional):** Text file, MQTT, JSON stream if still desired in desktop build.
- [ ] **Config:** YAML/TOML config load; device selection (port, VID/PID); logging.
- [ ] **Standalone binary:** `bearpaw-api --config config.yaml` for headless or server use; same binary as “backend only” build.

---

## Tech Stack (Rust)

| Concern        | Crate / approach              |
|----------------|-------------------------------|
| HTTP + WS      | `axum` + `axum::extract::ws`  |
| Async runtime | `tokio`                       |
| Serial         | `serialport` or `tokio-serial`|
| USB (optional)| `nusb` or `rusb`              |
| JSON           | `serde`, `serde_json`         |
| Config         | `config` + `serde` or `figment`|
| Logging        | `tracing`                     |

---

## Frontend Compatibility

- **No URL change if fixed port:** If the Rust server always binds to `http://127.0.0.1:8000`, existing proxy and `VITE_API_BASE_URL`/`VITE_WS_URL` continue to work.
- **Dynamic port:** If the port is chosen at runtime (e.g. to avoid conflicts), Tauri can inject the base URL into the frontend (e.g. `window.__BEARPAW_API_URL__`) and the frontend uses it for `fetch` and WebSocket; or the Tauri dev server proxy can be configured from Rust.

---

## Where Python Lives After Port

- **Desktop (Tauri):** Rust only; no Python.
- **Headless / server / dev:** Either run the Rust backend binary (`bearpaw-api`) or keep the Python backend for environments where you prefer Python; both can implement the same API contract.
- **Deprecation:** Once Rust reaches parity and is stable, the Python backend can be deprecated or retained only for legacy/scripting.

---

## Next Steps

1. ~~Create `crates/bearpaw-api` with Cargo.toml and module skeleton (transport, protocol, state, api).~~ **Done.** Root `Cargo.toml` workspace includes `crates/bearpaw-api` and `frontend/src-tauri`.
2. Implement Phase 1 (transport, STS/MDL, scheduler, state, GET status + device/info, WS broadcast, poll loop).
3. Wire Tauri to start the Axum server and open the app; verify frontend status and WS.
4. Proceed through Phase 2–4 in order.

---

*Last updated: 2026-02-25*
