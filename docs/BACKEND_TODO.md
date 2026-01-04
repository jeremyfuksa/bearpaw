# Backend (Scanner Bridge) Todo List

## Phase 1: Foundation & Transport

- [x] **PROJECT-001** Initialize backend project structure
  - Create `backend/` directory with src, tests, docs
  - Set up Python venv
  - Create requirements.txt with initial dependencies
  - Configure pyproject.toml or setup.py

- [x] **DISCOVERY-001** Implement USB serial device enumeration
  - Cross-platform serial port enumeration (macOS, Windows, Linux)
  - Filter by VID:PID (1965:0017 for Uniden)
  - Return canonical device descriptors
  - Handle permission errors gracefully

- [x] **DISCOVERY-002** Create device descriptor data model
  - Port path (OS-specific)
  - VID/PID
  - Serial number (if available)
  - Human-readable name

- [x] **TRANSPORT-001** Build serial transport layer
  - Exclusive port ownership with lock file
  - 115200 baud, 8N1 configuration
  - Connection lifecycle (open, close, reconnect)
  - Platform-specific port naming abstraction

- [x] **TRANSPORT-002** Implement command queue
  - Single in-flight command constraint
  - Thread-safe queue operations
  - Command timeout handling (default 500ms)
  - Response framing (CR-terminated)

- [x] **TRANSPORT-003** Create read loop with timeout
  - Async read with configurable timeout
  - Buffer management for partial responses
  - Error recovery for malformed data
  - Graceful shutdown handling

## Phase 2: Protocol Engine

- [x] **PROTOCOL-001** Design device family abstraction
  - Base driver interface class
  - Command map definition structure
  - Response parser interface
  - State field mapping

- [x] **PROTOCOL-002** Implement model detection
  - MDL command execution
  - Model string parsing
  - Family assignment logic
  - Fallback for unknown models

- [x] **BC125-001** Implement BC125AT driver
  - Command set: STS, GLG, HOLD, SCAN, KEY, DO
  - Response parsers for all commands
  - Status field extraction (frequency, mode, squelch, RSSI)
  - PRG mode commands (CIN, CSP, DAL, etc.)

- [x] **BC125-002** Create BC125AT state mapper
  - Map STS response to live state structure
  - Handle frequency vs channel display modes
  - RSSI normalization (0-100%)
  - Error state detection

- [x] **SR30C-001** Implement SR30C driver
  - Command set based on Scan75 protocol
  - Handle missing/truncated response fields
  - Status field extraction (adapted layout)
  - Document protocol differences from BC125AT

- [x] **SR30C-002** Create SR30C-specific response parser
  - Field ordering adjustments
  - Graceful handling of unsupported fields
  - Modulation field fallback logic
  - CP210x device detection notes

## Phase 3: State Management

- [x] **STATE-001** Design state store schema
  - Live state structure (receiver-centric)
  - Shadow state structure (memory-centric)
  - Timestamp all state updates
  - Diff calculation for change detection

- [x] **STATE-002** Implement live state manager
  - Frequency, mode, modulation tracking
  - RSSI and squelch status
  - Receiver mode (scan/hold/direct)
  - Thread-safe read/write access

- [x] **STATE-003** Implement shadow state cache
  - Channel index, alpha tag, bank
  - Lockout status, tones, delays
  - Last-sync timestamp
  - Dirty flag for out-of-sync detection

- [x] **STATE-004** Add SQLite persistence
  - Schema for shadow state storage
  - Atomic write operations
  - Migration support for schema changes
  - Vacuum/compact on shutdown

- [x] **STATE-005** Alternative: JSON snapshot persistence
  - Single-file atomic write
  - Pretty-print for human readability
  - Backup rotation (keep last N)
  - Load-on-startup with validation

## Phase 4: Scheduler & Polling

- [x] **SCHEDULER-001** Implement priority queue
  - Three traffic classes (control, telemetry, background)
  - Head-of-line blocking prevention
  - Command coalescing for duplicates
  - Queue depth monitoring

- [x] **SCHEDULER-002** Create STS polling loop
  - Configurable rate (5-10Hz)
  - Pause during control commands
  - Exponential backoff on errors
  - Metrics for poll success rate

- [x] **SCHEDULER-003** Implement command router
  - Route by priority class
  - Enforce serial transaction constraint
  - Callback routing for responses
  - Timeout and retry logic

## Phase 5: API Layer

- [x] **API-001** Set up FastAPI application
  - CORS configuration
  - Request logging middleware
  - Error handling middleware
  - Health check endpoint

- [x] **API-002** Implement control endpoints
  - POST /commands/hold
  - POST /commands/scan
  - POST /commands/key (with key code)
  - POST /frequency (direct tune)

- [x] **API-003** Implement query endpoints
  - GET /status (current live state)
  - GET /device/info (scanner model, version)
  - GET /memory/channels (shadow state)
  - GET /memory/channels/{id}

- [x] **API-004** Implement memory sync endpoint
  - POST /memory/sync (full refresh from scanner)
  - Progress reporting via WebSocket
  - Cancellation support
  - Sync conflict resolution

- [x] **WS-001** Implement WebSocket server
  - Connection lifecycle (connect, heartbeat, disconnect)
  - Message serialization (JSON)
  - Per-client subscription management
  - Broadcast to all connected clients

- [x] **WS-002** Design telemetry message schema
  - State update messages (live state changes)
  - Event messages (scan hit, hold, etc.)
  - Progress messages (sync, diagnostics)
  - Error messages

- [x] **WS-003** Implement state change publisher
  - Detect state diffs
  - Publish only changed fields
  - Include timestamp and sequence number
  - Rate limiting for high-frequency updates

## Phase 6: Documentation & Contracts

- [x] **DOCS-001** Generate OpenAPI specification
  - Auto-generate from FastAPI
  - Add descriptions and examples
  - Document error responses
  - Include authentication (future)

- [x] **DOCS-002** Document WebSocket message schema
  - JSON Schema for each message type
  - Example payloads
  - Client implementation guide
  - Reconnection strategy recommendations

- [x] **DOCS-003** Write driver extension guide
  - Steps to add new device family
  - Command set documentation template
  - Testing requirements
  - Integration checklist

## Phase 7: Optional Features

- [x] **EXPORT-001** Implement text file exporter
  - "Now Scanning" format
  - Configurable output path
  - Template support (frequency, alpha tag, etc.)
  - Atomic write with rename

- [x] **EXPORT-002** Implement JSON event stream exporter
  - Append-only JSON lines format
  - Rotation by size or time
  - Optional compression
  - Schema versioning

- [x] **RUNTIME-001** Implement foreground CLI mode
  - Console status display
  - Keyboard command input
  - Graceful Ctrl+C shutdown
  - Log output to stdout

- [x] **RUNTIME-002** Implement daemon mode
  - Background process (systemd, launchd, Windows Service)
  - PID file management
  - Log rotation
  - Signal handling (SIGTERM, SIGHUP)

## Phase 8: Testing & Packaging

- [x] **TEST-001** Create protocol engine unit tests
  - Mock serial transport
  - Command/response validation
  - State transition coverage
  - Error condition handling

- [x] **TEST-002** Create state store unit tests
  - Diff calculation accuracy
  - Persistence roundtrip
  - Thread safety validation
  - Schema migration tests

- [x] **TEST-003** Create serial replay testing framework
  - Capture real serial traffic
  - Replay for deterministic testing
  - Timing preservation
  - Golden file validation

- [x] **PACKAGE-001** Configure PyInstaller
  - Single-file executable
  - Include dependencies (no venv required)
  - Platform-specific builds (macOS, Windows, Linux)
  - Icon and metadata

- [x] **PACKAGE-002** Create distribution artifacts
  - macOS: .app bundle and/or CLI binary
  - Windows: .exe installer or portable .exe
  - Linux: AppImage or binary + systemd unit
  - Version stamping

## Phase 9: Advanced Features (Future)

- [x] **FUTURE-001** Implement MQTT exporter
  - Publish state updates to MQTT broker
  - Topic structure design
  - QoS configuration
  - Last will and testament
