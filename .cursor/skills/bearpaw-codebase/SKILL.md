---
name: bearpaw-codebase
description: Onboarding and conventions for the Bearpaw (Uniden scanner control) codebase. Use when modifying backend (Python/FastAPI), frontend (React/TypeScript/Vite), Tauri desktop wrapper, or API/WebSocket contract. Covers three-layer state, command scheduler, scan/hit/hold display rules, and protocol boundaries.
---

# Bearpaw Codebase

Project: web-based control for Uniden scanners (BC125AT, SR30C). Backend owns all state and hardware; frontend is stateless UI.

## Where to Read First

- **CLAUDE.md** (repo root): Architecture, key files, dev commands, common pitfalls.
- **AGENTS.md** (repo root): Code style, testing, API/WebSocket, naming.
- **docs/README.md**: Silo overview; **docs/API_SPEC.md**: REST + WebSocket contract.
- **docs/UI_WORKFLOW.md**: Display rules, squelch vs mode, hold toggle (required for UI work).

## Critical Rules (Do Not Violate)

### State and display

- **squelch_open** is the only source of truth for "hit" (signal present). Not frequency stability or mode.
- During a hit, **mode** stays `"SCAN"`; hardware auto-pauses. Only user Hold changes mode to `"HOLD"`.
- Display: `squelch_open === true` → show frequency/alpha/signal; else if `mode === "SCAN"` → "Scanning..." + spinner; else show frequency (HOLD/DIRECT).
- Alpha tags: from shadow state `channels[liveState.channel].alpha_tag`; shadow comes from memory sync.

### WebSocket

- Always enforce **sequence**: ignore messages where `message.sequence <= lastSequence` to avoid stale overwrites.

### Backend

- **Scheduler priorities**: Control (user) > Telemetry (STS poll) > Background (memory sync). User commands must preempt polling.
- **Program mode (PRG/EPG)**: Save mode → PRG → read channels → EPG → restore mode. Do not block polling loop with long work.
- **Transport**: 0.5s timeout; commands are ASCII + `\r`, read until `\r`.

### Frontend

- Do not hardcode device limits; use device API for frequency ranges.
- Only show stable frequency when `squelch_open` or `mode === "HOLD" | "DIRECT"`.

## Layout Quick Reference

| Area        | Key paths |
|------------|-----------|
| Backend    | `backend/src/bearpaw/` — api.py, scheduler.py, state.py, protocol/bc125at.py, protocol/sr30c.py, websocket.py, sync.py |
| Frontend   | `frontend/src/` — App.tsx, store/useStore.ts, api/client.ts, websocket/, components/VirtualDisplay.tsx, PrimaryControls.tsx |
| Tauri      | `frontend/src-tauri/` — main.rs, tauri.conf.json, capabilities |
| Docs       | `docs/` — BACKEND_SPEC, FRONTEND_SPEC, API_SPEC, UI_WORKFLOW.md, SCANNER_PROTOCOL_REFERENCE.md |

## Commands

- Backend: `cd backend && source .venv/bin/activate && bearpaw --config ./config.yaml`
- Frontend: `cd frontend && npm run dev`
- Full stack: root `npm run dev`; Tauri: root `npm run tauri:dev`
- Tests: backend `python -m unittest discover -s tests`; frontend `npm run test` (from frontend/)

## When Adding Features

- **New scanner model**: New driver in `protocol/` extending base; implement required commands; register in api device detection.
- **New API/WS message**: Update docs/API_SPEC.md and WEBSOCKET_SCHEMA.md; backend then frontend.
- **UI state/display**: Follow docs/UI_WORKFLOW.md; keep display logic in VirtualDisplay (or documented component).
