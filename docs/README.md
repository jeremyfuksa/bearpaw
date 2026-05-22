# Bearpaw Project Documentation

> **Cross-platform control and telemetry system for Uniden analog scanners**

---

## Quick Navigation

### 📖 Technical Specifications

- **[BACKEND_SPEC.md](./BACKEND_SPEC.md)** - Backend architecture & implementation spec
- **[FRONTEND_SPEC.md](./FRONTEND_SPEC.md)** - Frontend architecture & implementation spec
- **[API_SPEC.md](./API_SPEC.md)** - API contract specification (REST + WebSocket)
- **[SCANNER_PROTOCOL_REFERENCE.md](./SCANNER_PROTOCOL_REFERENCE.md)** - Protocol reference and commands
- **[DATA_LIFECYCLE.md](./DATA_LIFECYCLE.md)** - Database persistence, migration, and retention policy

### 🗂️ Archive (Non-Daily)

- **[BACKEND_TODO.md](./archive/BACKEND_TODO.md)** - Backend development task list
- **[FRONTEND_TODO.md](./archive/FRONTEND_TODO.md)** - Frontend development task list
- **[INTEGRATION_TODO.md](./archive/INTEGRATION_TODO.md)** - Integration & shared task list
- **[ROADMAP.md](./archive/ROADMAP.md)** - Milestones and phase plan

---

## Project Overview

Bearpaw is a **two-silo system** designed for independent development:

```
┌─────────────────────────────────────────────────────────┐
│                    BACKEND (Python)                     │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐   │
│  │  Device    │  │  Protocol  │  │  API Server    │   │
│  │  Discovery │→ │  Engine    │→ │  (REST + WS)   │   │
│  └────────────┘  └────────────┘  └────────────────┘   │
│         ▲                                  │            │
│         │                                  │            │
│    USB Serial                         Network API      │
│         │                                  │            │
│         ▼                                  ▼            │
│   [ BC125AT Scanner ]              [ API Contract ]    │
└─────────────────────────────────────────────┬───────────┘
                                              │
                                              │ JSON/WebSocket
                                              │
┌─────────────────────────────────────────────┴───────────┐
│                  FRONTEND (Web UI)                      │
│  ┌────────────┐  ┌────────────┐  ┌────────────────┐   │
│  │  Virtual   │  │  Transport │  │  Activity      │   │
│  │  Display   │  │  Controls  │  │  Log           │   │
│  └────────────┘  └────────────┘  └────────────────┘   │
│         ▲             ▲                  ▲              │
│         │             │                  │              │
│         └─────────────┴──────────────────┘              │
│                       │                                 │
│              ┌────────┴─────────┐                       │
│              │  State Store     │                       │
│              │  (Zustand)       │                       │
│              └──────────────────┘                       │
└─────────────────────────────────────────────────────────┘
```

---

## Development Silos

### Backend Silo (The Product)

**What it does:**
- Communicates directly with scanner hardware via USB serial
- Implements Uniden protocol (command encoding/response parsing)
- Maintains authoritative scanner state
- Exposes REST API for control commands
- Pushes real-time telemetry via WebSocket

**Key principle:** The backend contains ALL scanner logic. It is the product.

**Developer focus:**
- Python 3.10+
- Serial communication (pyserial)
- Protocol engineering
- State management
- API design (FastAPI)

**Start here:**
1. Read [BACKEND_SPEC.md](./BACKEND_SPEC.md)
2. Review [API_SPEC.md](./API_SPEC.md) (the contract you'll implement)

---

### Frontend Silo (The Client)

**What it does:**
- Displays scanner state in user-friendly UI
- Sends control commands to backend via REST
- Receives real-time updates via WebSocket
- Provides virtual scanner display and controls

**Key principle:** The frontend is stateless and replaceable. It never touches hardware.

**Developer focus:**
- React 18+ (or Vue/Svelte)
- TypeScript
- WebSocket client programming
- Real-time UI updates
- Responsive design

**Start here:**
1. Read [FRONTEND_SPEC.md](./FRONTEND_SPEC.md)
2. Review [API_SPEC.md](./API_SPEC.md) (the contract you'll consume)

---

### Integration Work (Both Silos)

**What it involves:**
- API contract definition (OpenAPI spec)
- WebSocket message schema
- End-to-end testing
- Deployment configuration

**Start here:**
1. Read [API_SPEC.md](./API_SPEC.md)
2. Review [WEBSOCKET_SCHEMA.md](./WEBSOCKET_SCHEMA.md)

---

## Independent Development Strategy

### Backend Can Work Independently With:

✅ **Mock serial devices** - Simulated scanner responses for testing
✅ **Serial capture replay** - Recorded traffic from real hardware
✅ **Standalone API testing** - Postman, curl, wscat
✅ **No frontend required** - API is fully testable alone

**Validation:**
```bash
# Start backend
bearpaw --config ./config.yaml

# Test with curl
curl http://localhost:8000/status

# Test WebSocket with wscat
wscat -c ws://localhost:8000/ws
```

---

### Frontend Can Work Independently With:

✅ **Mock WebSocket server** - Simulates backend telemetry
✅ **Stubbed API responses** - Static test data
✅ **Mock service worker** - Intercepts HTTP requests
✅ **No scanner required** - UI development is fully decoupled

**Validation:**
```bash
# Start mock backend (provided in frontend repo)
npm run mock-backend

# Start frontend dev server
npm run dev

# Open browser to localhost:3000
```

---

## API Contract (The Bridge Between Silos)

The **API specification** ([API_SPEC.md](./API_SPEC.md)) is the critical interface between silos.

### REST API Summary

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/status` | GET | Get current scanner state |
| `/device/info` | GET | Get scanner model and connection info |
| `/commands/hold` | POST | Enter hold mode |
| `/commands/scan` | POST | Enter scan mode |
| `/frequency` | POST | Tune to specific frequency |
| `/memory/channels` | GET | Get channel list (shadow state) |
| `/memory/sync` | POST | Start full memory sync |
| `/memory/export/bc125at_ss` | GET | Download full BC125AT memory file |

### WebSocket Message Types

| Type | Direction | Purpose |
|------|-----------|---------|
| `state_update` | Backend → Frontend | Live state changed |
| `event` | Backend → Frontend | Scanner event occurred |
| `progress` | Backend → Frontend | Long operation progress |
| `error` | Backend → Frontend | Error occurred |
| `complete` | Backend → Frontend | Long operation finished |

**Full details:** [API_SPEC.md](./API_SPEC.md)

---

## Development Phases

### Phase 1: Backend Core (Weeks 1-4)

**Goal:** Functional backend that can control scanner and expose API

**Deliverables:**
- Device discovery and serial transport
- BC125AT driver implementation
- State store (live + shadow)
- REST API endpoints
- WebSocket server
- OpenAPI specification

**Success criteria:** Backend can control real scanner, API is testable with curl/Postman

**Blocked by:** Scanner hardware availability (can use serial replay for development)

---

### Phase 2: Frontend Core (Weeks 2-5)

**Goal:** Functional web UI that connects to backend

**Deliverables:**
- React application foundation
- WebSocket client with auto-reconnect
- Virtual Display component
- Transport Controls component
- Activity Log component
- Production build pipeline

**Success criteria:** UI can display scanner state and send commands

**Blocked by:** API contract definition (can use mock backend until real backend ready)

**Note:** Frontend development can start in parallel with backend using mock services

---

### Phase 3: Integration (Week 5-6)

**Goal:** End-to-end system working with real hardware

**Deliverables:**
- Integration test suite
- Combined deployment packages
- Documentation (user guide, developer guide)
- Bug fixes from integration testing

**Success criteria:** Full user workflow functional (scan → hit → hold → tune)

**Blocked by:** Both backend and frontend core complete

---

### Phase 4: Polish & Advanced Features (Week 7+)

**Goal:** Production-ready system with optional features

**Deliverables:**
- Memory sync UI with progress
- Audio integration (optional)
- Native wrappers (Electron/Tauri)
- Performance optimization

---

## Quick Start for New Developers

### I want to work on Backend

```bash
# 1. Read the specs
open docs/BACKEND_SPEC.md
open docs/API_SPEC.md

# 2. Check the todo list
open docs/archive/BACKEND_TODO.md

# 3. Set up environment
cd backend/
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

# 4. Start coding!
# Begin with DISCOVERY-001 or TRANSPORT-001
```

---

### I want to work on Frontend

```bash
# 1. Read the specs
open docs/FRONTEND_SPEC.md
open docs/API_SPEC.md

# 2. Check the todo list
open docs/archive/FRONTEND_TODO.md

# 3. Set up environment
cd frontend/
npm install

# 4. Start mock backend (for development without real backend)
npm run mock-backend

# 5. Start dev server
npm run dev

# 6. Start coding!
# Begin with PROJECT-001 or COMP-001
```

---

### I want to work on Integration

```bash
# 1. Read the API spec
open docs/API_SPEC.md
open docs/archive/INTEGRATION_TODO.md

# 2. Ensure both silos are functional
cd backend/ && bearpaw --config ./config.yaml &
cd frontend/ && npm run dev &

# 3. Start integration testing
# Begin with CONTRACT-001 or TEST-001
```

---

## Key Design Principles

### 🎯 Separation of Concerns

- **Backend:** Owns scanner communication, protocol, state
- **Frontend:** Owns UI, user interaction, display
- **API:** Clean contract between the two

**Never:**
- ❌ Frontend talking to serial port directly
- ❌ Backend containing UI logic
- ❌ Sharing code between backend and frontend (except API types)

---

### 🔄 State Authority

- **Backend is authoritative** - Frontend reflects backend state
- **Backend never polls frontend** - All data flows backend → frontend
- **Frontend uses optimistic updates** - Assume commands succeed, backend confirms

---

### 🔌 Replaceability

- **Multiple frontends can coexist** - Web UI, mobile app, CLI, automation
- **Backend is the product** - Frontend is just one interface
- **API-first design** - Everything exposed via network API

---

### 🛡️ Safe Operation

- **Never enter PRG mode during scan** - Could miss critical traffic
- **Graceful degradation** - UI survives backend disconnect
- **Atomic state updates** - No partial state exposure

---

## Supported Scanners (v1.0)

| Model | Family | Connection | Status |
|-------|--------|------------|--------|
| **BC125AT** | Handheld Bank Analog | USB CDC | ✅ Primary target |
| BCT125AT | Handheld Bank Analog | USB CDC | 🔄 Compatible (same protocol; BearTracker commands not yet exposed) |
| BCT15X | DMA Analog XT | RS-232/USB | 🔮 Future |
| BC245XLT | Legacy Analog | RS-232 | 🔮 Future |

---

## Technology Stack Summary

### Backend
- **Language:** Python 3.10+
- **Framework:** FastAPI (async, OpenAPI)
- **Serial:** pyserial
- **Persistence:** SQLite or JSON
- **Packaging:** PyInstaller

### Frontend
- **Language:** TypeScript 5+
- **Framework:** React 18+ (or Vue 3, Svelte)
- **Build Tool:** Vite
- **State:** Zustand (or Redux Toolkit)
- **Styling:** CSS Modules or Tailwind

### Integration
- **API:** REST (JSON) + WebSocket
- **Spec:** OpenAPI 3.0
- **Testing:** pytest (backend), Vitest (frontend), Playwright (e2e)

---

## Project Structure

```
uniden/
├── docs/                      # ← YOU ARE HERE
│   ├── README.md              # This file
│   ├── archive/               # Non-daily docs
│   │   ├── BACKEND_TODO.md     # Backend task list
│   │   ├── FRONTEND_TODO.md    # Frontend task list
│   │   ├── INTEGRATION_TODO.md # Integration task list
│   │   └── ROADMAP.md          # Milestones
│   ├── BACKEND_SPEC.md        # Backend technical spec
│   ├── FRONTEND_SPEC.md       # Frontend technical spec
│   └── API_SPEC.md            # API contract spec
│
├── backend/                   # Backend silo
│   ├── src/
│   │   ├── discovery/         # USB device detection
│   │   ├── transport/         # Serial communication
│   │   ├── protocol/          # Protocol engine & drivers
│   │   ├── scheduler/         # Command prioritization
│   │   ├── state/             # State management
│   │   ├── api/               # REST + WebSocket API
│   │   └── exporters/         # Optional output modules
│   ├── tests/
│   ├── requirements.txt
│   └── README.md
│
├── frontend/                  # Frontend silo
│   ├── src/
│   │   ├── components/        # UI components
│   │   ├── services/          # API clients
│   │   ├── store/             # State management
│   │   └── views/             # Main views
│   ├── public/
│   ├── package.json
│   └── README.md
│
└── integration/               # Integration tests
    ├── e2e/                   # End-to-end tests
    ├── contract/              # API contract tests
    └── mock-backend/          # Mock server for frontend dev
```

---

## Questions?

### Backend Questions
- "How do I implement a new scanner driver?" → See BACKEND_SPEC.md § 3.3
- "What's the serial protocol?" → See BACKEND_SPEC.md § 3.3.2 (BC125AT)
- "How does the scheduler work?" → See BACKEND_SPEC.md § 3.5

### Frontend Questions
- "How do I handle WebSocket reconnection?" → See FRONTEND_SPEC.md § 5.2
- "What state management should I use?" → See FRONTEND_SPEC.md § 6.1
- "How do I test without a real backend?" → See FRONTEND_SPEC.md § 11.4

### API Questions
- "What's the REST endpoint for X?" → See API_SPEC.md § 3
- "How do WebSocket messages work?" → See API_SPEC.md § 4
- "What error codes exist?" → See API_SPEC.md § 2.4

---

## Contributing

1. **Pick a silo** (backend or frontend)
2. **Read the spec** for your silo
3. **Check the todo list** for available tasks
4. **Follow the API contract** (don't break the interface!)
5. **Write tests** for your code
6. **Document as you go** (update specs if behavior changes)

---

## License

*To be determined*

---

**Last Updated:** 2026-01-04
**Documentation Version:** 1.0.0
