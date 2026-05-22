# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Bearpaw is a web-based control interface for the Uniden BC125AT scanner. It's split into:
- **Backend**: Python FastAPI service that talks to scanner hardware via serial/USB
- **Frontend**: React + TypeScript + Vite SPA that provides a web UI

The architecture is **strictly client-server**: the backend owns ALL state and hardware communication. The frontend is a stateless, replaceable UI that only displays current state and sends commands.

## Development Commands

### Backend (Python)

```bash
# Setup (from backend/)
python -m venv venv
source venv/bin/activate  # or venv\Scripts\activate on Windows
pip install -r requirements.txt

# Run backend
bearpaw --config ./config.yaml

# Install in dev mode
pip install -e .
```

**Config**: Copy `backend/config.example.yaml` to create your config. See `docs/BACKEND_SPEC.md` for schema.

### Frontend (React + Vite)

```bash
# Setup (from frontend/)
npm install

# Development
npm run dev              # Start dev server with HMR
npm run build            # Production build

# Tests
npm test                 # Run vitest once
npm run test:watch       # Vitest in watch mode
npm run test:coverage    # Vitest with coverage

# Code quality
npm run lint             # Run ESLint
npm run lint:fix         # Auto-fix ESLint issues
npm run format           # Format with Prettier
npm run format:check     # Check formatting
npm run type-check       # TypeScript type checking (excludes test files)
```

**Type-check scope**: `tsc` runs against production source (`src/`). Test files (`__tests__/`, `*.test.*`, `e2e/`) are excluded — Vitest transpiles them via Vite. Re-include them in `tsconfig.json` once test mock typing is cleaned up.

**Dev server proxy**: Vite proxies `/api` and `/ws` to `http://localhost:8000` in development (see `frontend/vite.config.ts`).

## Critical Architecture Concepts

### 1. Three-Layer State Model (Backend)

The backend maintains state in three distinct layers:

**LiveState** (real-time polling):
- Current frequency, modulation, squelch_open, rssi, mode
- Polled from scanner hardware 5-10x per second via `STS` command
- Located in `state.py`, updated by `_poll_status()` in `api.py:350`

**ShadowState** (cached channel memory):
- All 500 channels with frequency, alpha_tag, bank, lockout, etc.
- Read once during memory sync (60+ seconds), cached in-memory
- Optional persistence to SQLite or JSON (`persistence.py`)

**DeviceInfo** (static metadata):
- Model name, serial port, VID/PID
- Detected on startup via `MDL` command

### 2. Command Scheduler Priority System

Scanner commands are queued with three priority levels (`scheduler.py`):

```python
PRIORITY_CONTROL = 0      # User commands (hold, scan, tune) - highest
PRIORITY_TELEMETRY = 1    # Status polling (STS) - medium
PRIORITY_BACKGROUND = 2   # Memory sync, channel reads - lowest
```

**Why this matters**: High-priority commands preempt polling. During memory sync, status polling yields to avoid blocking user controls.

**Program mode**: Reading channels requires entering `PRG` mode, which:
1. Saves current mode (SCAN/HOLD)
2. Stops scanning if active
3. Enters program mode
4. Reads channel data
5. Exits program mode (`EPG`)
6. Restores previous mode

Located in `protocol/bc125at.py:135-147`.

### 3. Scanner State Transitions (The "Hit" Workflow)

**Critical concept**: The scanner has THREE operational modes, plus a signal state:

**Modes** (controlled by user commands):
- `SCAN`: Cycling through channels (hardware does the cycling)
- `HOLD`: Stopped on one frequency (user-initiated via `KEY,H,P`)
- `DIRECT`: Tuned to manual frequency (via `DO,<freq>,<mod>`)

**Signal State** (hardware-controlled):
- `squelch_open: true` - Signal detected, scanner AUTOMATICALLY paused
- `squelch_open: false` - No signal, scanner resumes cycling (if in SCAN mode)

**The "hit" workflow** (see `docs/UI_WORKFLOW.md`):
```
1. mode=SCAN, squelch_open=false  → "Scanning..." (actively searching)
2. squelch_open: false → true     → Scanner auto-pauses, backend broadcasts "scan_hit" event
3. mode=SCAN, squelch_open=true   → "Hit" state (listening to signal)
4. squelch_open: true → false     → Scanner auto-resumes scan, back to step 1
```

**Common mistake**: During a hit, `mode` is still `"SCAN"`. The scanner hardware pauses automatically when squelch opens, but the mode doesn't change to HOLD. Only manual user action changes mode.

**Code location**: `api.py:374-395` detects squelch transitions and broadcasts WebSocket events.

### 4. WebSocket State Synchronization

Backend → Frontend flow (`websocket.py` + `api.py:350-420`):

```python
# Every poll cycle (0.1-0.2s):
state = await driver.get_status()           # Poll scanner
changes = state_store.update_live_state()   # Detect what changed
if changes:
    ws_manager.broadcast({
        "type": "state_update",
        "sequence": int(timestamp * 1000),  # Prevents out-of-order updates
        "data": changes                     # Only changed fields
    })
```

**Message types**:
- `state_update`: Partial state changes (most common)
- `event`: Special events like "scan_hit" (when squelch opens)
- `progress`: Long-running task updates (memory sync)
- `error`: Error conditions

**Sequence numbers**: Frontend MUST check `message.sequence > lastSequence` to prevent stale updates from overwriting newer state.

### 5. Frontend State Rules (React + Zustand)

Frontend display logic (`frontend/src/components/VirtualDisplay.tsx`):

```typescript
// Show "Scanning..." when:
liveState.mode === "SCAN" && !liveState.squelch_open

// Show frequency/channel/alpha tag when:
liveState.squelch_open === true       // Hit detected
|| liveState.mode === "HOLD"          // Manual hold
|| liveState.mode === "DIRECT"        // Direct tune
```

**Why**: During active scan, frequency changes 5-10x per second (unreadable). Only display stable frequency when scanner is stopped.

**Alpha tags**: Frontend looks up `channels[liveState.channel]` from shadow state to display friendly names like "Police Dispatch" instead of just frequency.

**Store location**: `frontend/src/store/useStore.ts` (Zustand store with partial update merging).

## Device Driver

Single protocol implementation for the BC125AT family
(`protocol/bc125at.py`).

- Supports `STS` (LCD dump) and `GLG` (comma-separated) status formats —
  see `docs/SCANNER_PROTOCOL_REFERENCE.md` for the canonical wire spec
- Returns battery level and volume

**Identification**: `api.py` queries the `MDL` command on connect; only
BC125AT-family responses (BC125AT, BCT125AT, UBC125XLT, UBC126AT, AE125H)
are supported.

**Common commands**:
- `STS` - Get current status (frequency, squelch, rssi, etc.)
- `KEY,H,P` - Hold (stop scanning)
- `KEY,S,P` - Scan (start scanning)
- `DO,<freq>,<mod>` - Direct tune to frequency
- `PRG` / `EPG` - Enter/exit program mode
- `CIN,<index>` - Read channel data (requires program mode)

## Transport Layer

Two transport implementations:

**SerialTransport** (`transport.py`):
- Standard pyserial over COM/ttyUSB ports
- Auto-detection via `discovery.py` (scans for Uniden VID/PID)

**UsbTransport** (`transport_usb.py`):
- Direct USB CDC access via pyusb (Linux without kernel drivers)
- Requires USB VID/PID in config

**Command protocol**:
1. Send ASCII command + `\r` (carriage return)
2. Read until `\r` received
3. Strip `\r` from response
4. Timeout: 0.5s default

## Configuration

**Backend** (`backend/config.yaml`):
```yaml
device:
  port: "/dev/ttyUSB0"          # Serial port (or null for auto-detect)
  transport: "serial"            # "serial", "usb", or "auto"
  usb_vid: 0x1965               # For USB transport
  usb_pid: 0x0017

polling:
  sts_interval: 0.2              # Status poll rate (seconds)

state:
  persistence: "sqlite"          # "none", "json", or "sqlite"
  db_path: "./scanner.db"

exporters:
  text_file:
    enabled: true
    path: "./now_scanning.txt"   # Live frequency export for OBS
    update_on: ["squelch_open"]  # When to update file

  mqtt:
    enabled: false
    host: "localhost"
    topic_prefix: "scanner/"
```

**Frontend** (environment variables in `frontend/.env`):
```
VITE_API_BASE_URL=/api/v1      # API base (proxied in dev)
VITE_WS_URL=                   # WebSocket URL (auto-detected if empty)
```

## Key Files Reference

### Backend Critical Paths

- `api.py` - FastAPI app, polling loop, WebSocket endpoint
- `scheduler.py` - Priority queue for scanner commands
- `state.py` - LiveState/ShadowState management
- `protocol/bc125at.py` - BC125AT driver implementation
- `websocket.py` - WebSocket manager, broadcast logic
- `sync.py` - Memory sync task (reads all channels)

### Frontend Critical Paths

- `src/App.tsx` - Main app shell, WebSocket setup
- `src/store/useStore.ts` - Zustand state store
- `src/api/client.ts` - REST API client
- `src/websocket/ScannerWebSocket.ts` - WebSocket client with auto-reconnect
- `src/components/VirtualDisplay.tsx` - Main display component
- `src/components/PrimaryControls.tsx` - Scan/Hold button

## Documentation

**Must-read for UI work**:
- `docs/UI_WORKFLOW.md` - Complete scanning workflow explanation (for coding agents)
- `docs/FRONTEND_SPEC.md` - Full frontend architecture specification

**Backend reference**:
- `docs/BACKEND_SPEC.md` - Configuration schema and API documentation

## Common Pitfalls

### Backend

1. **Don't block the polling loop**: Long operations go in background tasks, not inline
2. **Program mode changes scanner state**: Always save/restore mode when entering PRG
3. **Serial timeouts are critical**: Set transport timeout to 0.5s to prevent hangs
4. **Scheduler priorities matter**: User commands must be PRIORITY_CONTROL to preempt polling

### Frontend

1. **Don't hardcode device limits**: Get frequency ranges from device API, not constants
2. **Check sequence numbers**: Prevent stale WebSocket updates from overwriting newer state
3. **Mode vs squelch_open confusion**: During hit, mode is still "SCAN" but squelch_open=true
4. **Display logic**: Only show frequency when stable (squelch_open OR mode=HOLD/DIRECT)
5. **Alpha tags require memory sync**: Frontend can't show friendly names until shadow state loaded

## File Layout

```
backend/
  src/bearpaw/
    api.py                    # FastAPI app, main polling loop
    scheduler.py              # Command priority queue
    state.py                  # LiveState/ShadowState management
    protocol/
      bc125at.py              # BC125AT scanner driver
    transport.py              # Serial port communication
    transport_usb.py          # USB CDC communication
    websocket.py              # WebSocket manager
    sync.py                   # Memory sync task
    exporters/                # Text file, MQTT, JSON stream exporters

frontend/
  src/
    App.tsx                   # Main app shell
    store/useStore.ts         # Zustand state store
    api/client.ts             # REST API client
    websocket/                # WebSocket client
    components/               # React components
      VirtualDisplay.tsx      # Main scanner display
      PrimaryControls.tsx     # Scan/Hold button
```

## Testing Notes

**Backend**: `python -m unittest discover -s tests` (run from `backend/` with venv active).

**Frontend**: `npm test` (vitest), `npm run lint` (ESLint), `npm run type-check` (tsc), `npm run format:check` (Prettier). All four run on every PR via `.github/workflows/tests.yml`.

## Memory Sync Performance

Reading all scanner channels is SLOW (60+ seconds for 500 channels):
- Each channel read requires: PRG → CIN,N → EPG sequence
- Driver yields to higher-priority commands (user controls)
- Progress updates sent via WebSocket every ~10 channels
- Frontend shows progress bar during sync

**Location**: `sync.py:MemorySyncTask`, invoked via POST `/api/v1/memory/sync`

## Export Features

**Text file exporter** (`exporters/text_exporter.py`):
- Writes current frequency/alpha tag to file (for OBS overlays)
- Configurable template with `{frequency}`, `{alpha_tag}`, `{modulation}` placeholders
- Updates on squelch_open or frequency change

**MQTT exporter** (`exporters/mqtt.py`):
- Publishes state changes to MQTT broker
- Topics: `scanner/state`, `scanner/events/scan_hit`
- Useful for Home Assistant integration

**JSON stream** (`exporters/json_stream.py`):
- Appends newline-delimited JSON events to log file
- Supports rotation (daily or size-based)
- Records all scan hits with timestamps
