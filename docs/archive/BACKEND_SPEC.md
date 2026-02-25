# Bearpaw Backend Specification

**Version:** 1.0.0
**Target:** Cross-platform Python 3.10+ service
**Purpose:** Canonical backend for Uniden analog scanner control and telemetry

---

## 1. System Overview

Bearpaw is a headless, API-first service that provides exclusive control and telemetry access to Uniden analog scanners. It runs as a long-lived process and exposes scanner functionality via REST and WebSocket APIs.

### 1.1 Core Principles

- **Device Abstraction:** Multi-scanner support via driver-based architecture
- **API-First:** All functionality exposed via network API
- **State Authority:** Backend is the single source of truth
- **Safe Operation:** No destructive operations during live scanning
- **Deterministic Behavior:** Predictable serial protocol handling

### 1.2 Supported Scanner Families

| Family | Models | Connection | Memory Model |
|--------|--------|------------|--------------|
| Handheld Bank Analog | BC125AT, SR30C | USB CDC (VID:PID 1965:0017) | Bank/Channel (fixed) |
| DMA Analog XT | BCT15X, BCD996XT | RS-232/USB-Serial | System/Group/Channel (dynamic) |
| Legacy Analog | BC245XLT, BC780XLT | RS-232 | Bank-based or early trunking |

**Initial Implementation:** BC125AT and SR30C only

---

## 2. Architecture Components

```
┌─────────────────────────────────────────────┐
│           API Layer (FastAPI)               │
│  ┌──────────────┐    ┌──────────────────┐  │
│  │ REST Endpoints│    │ WebSocket Server │  │
│  └──────┬───────┘    └────────┬─────────┘  │
└─────────┼──────────────────────┼────────────┘
          │                      │
          ▼                      ▼
┌─────────────────────────────────────────────┐
│         State Store (Live + Shadow)         │
└─────────┬───────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│    Scheduler (Priority Queue + Polling)     │
└─────────┬───────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│   Protocol Engine (Driver-Based)            │
│  ┌────────────┐  ┌────────────┐            │
│  │ BC125AT    │  │ SR30C      │            │
│  │ Driver     │  │ Driver     │            │
│  └────────────┘  └────────────┘            │
└─────────┬───────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│    Serial Transport (Exclusive Lock)        │
└─────────┬───────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│   Device Discovery (Platform-Agnostic)      │
└─────────┴───────────────────────────────────┘
          │
          ▼
     [ BC125AT USB ]
```

---

## 3. Module Specifications

### 3.1 Device Discovery

**Purpose:** Enumerate and identify connected Uniden scanners

**Dependencies:**
- `pyserial` for port enumeration
- Platform-specific USB enumeration (pyusb optional)

**Behavior:**

```python
def discover_devices() -> List[DeviceDescriptor]:
    """
    Returns list of detected scanner devices
    """
    devices = []
    for port in serial.tools.list_ports.comports():
        if port.vid == 0x1965 and port.pid == 0x0017:
            devices.append(DeviceDescriptor(
                port=port.device,
                vid=port.vid,
                pid=port.pid,
                serial_number=port.serial_number,
                description=port.description
            ))
    return devices
```

**Data Model:**

```python
@dataclass
class DeviceDescriptor:
    port: str              # OS-specific: /dev/ttyACM0, COM3, etc.
    vid: int               # USB Vendor ID (0x1965 for Uniden)
    pid: int               # USB Product ID (0x0017 for BC125AT)
    serial_number: Optional[str]
    description: str       # Human-readable device name
```

**Platform-Specific Port Names:**
- **macOS:** `/dev/cu.usbmodem*` or `/dev/tty.usbmodem*`
- **Linux:** `/dev/ttyACM*` or `/dev/ttyUSB*`
- **Windows:** `COM*`

**Error Handling:**
- No devices found → return empty list
- Permission denied → raise PermissionError with instructions
- USB enumeration failure → fall back to basic serial port list

---

### 3.2 Serial Transport

**Purpose:** Exclusive, reliable communication channel to scanner hardware

**Configuration:**
- Baud rate: 115200
- Data bits: 8
- Parity: None
- Stop bits: 1
- Flow control: None
- Timeout: 500ms (configurable)

**Thread Safety:** All serial operations must be thread-safe (single writer, single reader)

**Command Queue:**

```python
class SerialTransport:
    def __init__(self, port: str):
        self.port = serial.Serial(port, 115200, timeout=0.5)
        self.command_queue = Queue()
        self.response_futures = {}
        self.lock = threading.Lock()

    def send_command(self, cmd: str) -> Future[str]:
        """
        Enqueue command and return Future for response
        """
        future = Future()
        with self.lock:
            self.command_queue.put((cmd, future))
        return future

    def _worker_loop(self):
        """
        Process command queue (single in-flight constraint)
        """
        while self.running:
            cmd, future = self.command_queue.get()
            try:
                response = self._execute(cmd)
                future.set_result(response)
            except Exception as e:
                future.set_exception(e)
```

**Framing:**
- Commands are CR-terminated (`\r`)
- Responses are CR-terminated
- Buffer incoming data until CR received
- Discard partial responses on timeout

**Lifecycle:**
- `connect()`: Open port, start worker thread
- `disconnect()`: Drain queue, close port, stop thread
- `reconnect()`: Disconnect + connect with backoff

**Error Recovery:**
- Timeout → retry once, then fail
- Malformed response → log warning, return error
- Serial port disconnected → attempt reconnect with exponential backoff

---

### 3.3 Protocol Engine

**Purpose:** Abstract scanner-specific command/response protocols

#### 3.3.1 Driver Interface

```python
class ScannerDriver(ABC):
    @abstractmethod
    def get_status(self) -> LiveState:
        """Poll current scanner status (STS equivalent)"""

    @abstractmethod
    def send_hold(self) -> bool:
        """Enter hold mode"""

    @abstractmethod
    def send_scan(self) -> bool:
        """Enter scan mode"""

    @abstractmethod
    def send_key(self, key_code: str) -> bool:
        """Simulate keypress"""

    @abstractmethod
    def set_frequency(self, freq_mhz: float, modulation: str = "AUTO") -> bool:
        """Direct frequency tune"""

    @abstractmethod
    def read_channel(self, index: int) -> ChannelData:
        """Read channel memory (requires PRG mode)"""

    @abstractmethod
    def detect_model(self) -> str:
        """Return model string (MDL command)"""
```

#### 3.3.2 BC125AT Driver

**Command Set:**

| Command | Format | Response | Purpose |
|---------|--------|----------|---------|
| STS | `STS\r` | Multi-line status | Get current scanner state |
| GLG | `GLG\r` | Multi-line log | Get extended telemetry (optional) |
| HOLD | `KEY,H,P\r` | `OK\r` | Enter hold mode |
| SCAN | `KEY,S,P\r` | `OK\r` | Enter scan mode |
| DO | `DO,frq,mod\r` | `OK\r` or `ERR\r` | Direct frequency tune |
| MDL | `MDL\r` | `MDL,BC125AT\r` | Model detection |
| PRG | `PRG\r` | `OK\r` | Enter program mode |
| EPG | `EPG\r` | `OK\r` | Exit program mode |
| CIN | `CIN,index\r` | Channel data | Read channel (PRG only) |

**STS Response Format (BC125AT):**

```
SQL,0
RSSI,75
SYS,USA
MOD,FM
CH,025
FRQ,151.2500
VOL,10
BAT,100
```

**Field Mapping:**

```python
@dataclass
class BC125ATStatus:
    squelch: int          # 0=open, 1=closed
    rssi: int             # 0-100
    system: str           # USA, CAN, etc.
    modulation: str       # FM, AM, NFM
    channel: int          # 1-500
    frequency: float      # MHz
    volume: int           # 0-15
    battery: int          # 0-100
```

**PRG Mode Constraints:**
- Never enter PRG during scan/hold (check mode first)
- Always EPG before resuming normal operation
- CIN operations are synchronous and blocking
- Full memory sync may take 30-60 seconds for 500 channels

#### 3.3.3 SR30C Driver

**Protocol Differences from BC125AT:**

- USB chipset: Silicon Labs CP210x (not native CDC-ACM)
- Status fields: different ordering, some fields missing
- Battery commands: not supported (AC-powered base model)
- Modulation field: may be absent or unreliable

**Status Response Format (SR30C - inferred from Scan75):**

```
SQL,0
RSSI,68
CH,012
FRQ,154.6000
MOD,FM
```

**Implementation Notes:**

```python
class SR30CDriver(ScannerDriver):
    def parse_status(self, response: str) -> LiveState:
        """
        Parse SR30C status with graceful field handling
        """
        fields = self._parse_key_value_pairs(response)

        # Modulation may be missing - default to AUTO
        modulation = fields.get('MOD', 'AUTO')

        # Some fields present in BC125AT are absent
        battery = None  # SR30C is AC-powered

        return LiveState(
            frequency=float(fields['FRQ']),
            modulation=modulation,
            rssi=int(fields['RSSI']),
            squelch_open=(fields['SQL'] == '0'),
            channel=int(fields.get('CH', 0)),
            battery=battery
        )
```

**CP210x Device Detection:**
- VID:PID varies (typically 10C4:EA60)
- Linux: `/dev/ttyUSB*`
- macOS: `/dev/cu.SLAB_USBtoUART`
- Windows: `COM*` (requires CP210x VCP driver)

---

### 3.4 State Store

**Purpose:** Maintain authoritative scanner state for API queries

#### 3.4.1 Live State

Represents current scanner receiver state (derived from STS polling):

```python
@dataclass
class LiveState:
    timestamp: float               # Unix timestamp of last update
    frequency: float               # Current frequency (MHz)
    modulation: str                # FM, AM, NFM, AUTO
    squelch_open: bool            # True if signal present
    rssi: int                      # Signal strength 0-100
    mode: str                      # SCAN, HOLD, DIRECT
    channel: Optional[int]         # Channel number if in bank mode
    volume: int                    # Volume level 0-15
    battery: Optional[int]         # Battery percentage (0-100, None if AC)
```

#### 3.4.2 Shadow State

Represents cached scanner memory (updated via explicit sync):

```python
@dataclass
class ChannelData:
    index: int                     # Channel number (1-500)
    frequency: float               # MHz
    modulation: str                # FM, AM, NFM
    alpha_tag: str                 # Up to 16 characters
    delay: int                     # 0-30 seconds
    lockout: bool                  # True if locked out
    priority: bool                 # Priority scan
    tone_squelch: Optional[float]  # CTCSS tone frequency (Hz)
    bank: int                      # Bank assignment (1-10)

@dataclass
class ShadowState:
    channels: Dict[int, ChannelData]  # Key = channel index
    last_sync: float                   # Unix timestamp
    dirty: bool                        # True if out of sync
```

#### 3.4.3 Persistence

**SQLite Schema:**

```sql
CREATE TABLE channels (
    index INTEGER PRIMARY KEY,
    frequency REAL NOT NULL,
    modulation TEXT NOT NULL,
    alpha_tag TEXT,
    delay INTEGER DEFAULT 2,
    lockout INTEGER DEFAULT 0,
    priority INTEGER DEFAULT 0,
    tone_squelch REAL,
    bank INTEGER
);

CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT
);

-- Store last_sync timestamp
INSERT INTO metadata (key, value) VALUES ('last_sync', '0');
```

**Alternative: JSON Snapshot**

```json
{
  "version": "1.0",
  "last_sync": 1704412800.0,
  "channels": {
    "1": {
      "frequency": 151.2500,
      "modulation": "FM",
      "alpha_tag": "Police Dispatch",
      "delay": 2,
      "lockout": false,
      "priority": true,
      "tone_squelch": null,
      "bank": 1
    }
  }
}
```

**Persistence Policy:**
- Write shadow state on every sync completion
- Write on graceful shutdown
- Read on startup (populate cache)
- Atomic write (write to temp file, rename)

---

### 3.5 Scheduler

**Purpose:** Manage serial command traffic with prioritization

#### 3.5.1 Traffic Classes

| Priority | Class | Examples | Latency Target |
|----------|-------|----------|----------------|
| 1 (Highest) | Control | HOLD, SCAN, DO | < 100ms |
| 2 (Medium) | Telemetry | STS polling | 100-200ms (10Hz) |
| 3 (Lowest) | Background | Sync, diagnostics | Best effort |

#### 3.5.2 Polling Loop

```python
class StatusPoller:
    def __init__(self, driver: ScannerDriver, interval: float = 0.1):
        self.driver = driver
        self.interval = interval  # 100ms = 10Hz
        self.running = False

    async def poll_loop(self):
        while self.running:
            # Pause if control commands are in queue
            if scheduler.has_high_priority():
                await asyncio.sleep(0.01)
                continue

            # Execute STS poll
            try:
                state = self.driver.get_status()
                state_store.update_live_state(state)
            except TimeoutError:
                logger.warning("STS poll timeout")

            await asyncio.sleep(self.interval)
```

#### 3.5.3 Command Coalescing

Optimize for rapid repeated commands:

```python
class CommandScheduler:
    def enqueue(self, cmd: Command):
        # If identical command already queued, skip
        if self.queue and self.queue[-1] == cmd:
            logger.debug(f"Coalesced duplicate command: {cmd}")
            return
        self.queue.append(cmd)
```

---

### 3.6 API Layer

**Technology:** FastAPI (async, OpenAPI auto-generation)

#### 3.6.1 REST Endpoints

**Base Path:** `/api/v1`

| Method | Endpoint | Request | Response | Description |
|--------|----------|---------|----------|-------------|
| GET | `/status` | - | LiveState | Current scanner state |
| GET | `/device/info` | - | DeviceInfo | Model, firmware, connection |
| POST | `/commands/hold` | - | `{"status": "ok"}` | Enter hold mode |
| POST | `/commands/scan` | - | `{"status": "ok"}` | Enter scan mode |
| POST | `/commands/key` | `{"key": "UP"}` | `{"status": "ok"}` | Simulate keypress |
| POST | `/frequency` | `{"frequency": 151.25, "modulation": "FM"}` | `{"status": "ok"}` | Direct tune |
| GET | `/memory/channels` | `?bank=1` | List[ChannelData] | Get channel list |
| GET | `/memory/channels/{id}` | - | ChannelData | Get specific channel |
| POST | `/memory/sync` | - | `{"status": "started", "task_id": "..."}` | Start full sync |
| GET | `/memory/export/bc125at_ss` | - | File (text/plain) | Download full BC125AT memory file |

**Error Responses:**

```json
{
  "error": "invalid_frequency",
  "message": "Frequency 999.999 MHz is out of range",
  "code": 400
}
```

**HTTP Status Codes:**
- 200: Success
- 400: Bad request (invalid input)
- 404: Resource not found
- 503: Service unavailable (scanner disconnected)
- 500: Internal error

#### 3.6.2 WebSocket Protocol

**Endpoint:** `/ws`

**Connection:**

```javascript
const ws = new WebSocket('ws://localhost:8000/ws');
```

**Message Types:**

```python
# Client → Server (future, currently read-only)
{
  "type": "subscribe",
  "topics": ["state", "events"]
}

# Server → Client: State Update
{
  "type": "state_update",
  "timestamp": 1704412800.123,
  "sequence": 12345,
  "data": {
    "frequency": 151.2500,
    "modulation": "FM",
    "squelch_open": true,
    "rssi": 75
  }
}

# Server → Client: Event
{
  "type": "event",
  "timestamp": 1704412800.456,
  "event": "scan_hit",
  "data": {
    "frequency": 151.2500,
    "channel": 25,
    "alpha_tag": "Police"
  }
}

# Server → Client: Progress (sync, etc.)
{
  "type": "progress",
  "task_id": "sync-abc123",
  "percent": 45,
  "message": "Syncing channel 225/500"
}

# Server → Client: Error
{
  "type": "error",
  "error": "scanner_disconnected",
  "message": "Scanner USB connection lost"
}
```

**Heartbeat:** Server sends ping every 30s, client must respond with pong within 10s

**Reconnection:** Client should implement exponential backoff (1s, 2s, 4s, 8s, max 30s)

---

### 3.7 Exporters (Optional)

#### 3.7.1 Text File Exporter

**Purpose:** OBS, streaming overlays, etc.

**Output Format:**

```
151.2500 MHz FM - Police Dispatch
```

**Configuration:**

```python
@dataclass
class TextExporterConfig:
    output_path: str = "./now_scanning.txt"
    template: str = "{frequency} MHz {modulation} - {alpha_tag}"
    update_on: List[str] = ["frequency", "squelch_open"]
```

**Behavior:**
- Atomic write (temp file + rename)
- Update only on specified state changes
- Blank output if squelch closed (optional)

#### 3.7.2 JSON Event Stream

**Format:** JSON Lines (one event per line)

```json
{"timestamp": 1704412800.1, "event": "scan_hit", "frequency": 151.25, "channel": 25}
{"timestamp": 1704412801.5, "event": "hold", "frequency": 151.25}
```

**Rotation:** By size (10MB default) or time (daily)

---

## 4. Runtime Modes

### 4.1 Foreground CLI

**Usage:**

```bash
bearpaw --port /dev/ttyACM0 --foreground
```

**Behavior:**
- Console status display (curses-based optional)
- Keyboard input for commands (h=hold, s=scan, q=quit)
- Log output to stdout
- Ctrl+C for graceful shutdown

### 4.2 Daemon Mode

**Usage:**

```bash
bearpaw --port /dev/ttyACM0 --daemon
```

**Behavior:**
- Detach from terminal
- Write PID file (`/var/run/bearpaw.pid`)
- Log to file (`/var/log/bearpaw.log`)
- Signal handling:
  - SIGTERM: graceful shutdown
  - SIGHUP: reload configuration
  - SIGUSR1: trigger memory sync

**Platform Integration:**
- **Linux:** systemd unit file
- **macOS:** launchd plist
- **Windows:** Windows Service wrapper

---

## 5. Configuration

**Format:** YAML or TOML

**Example (`config.yaml`):**

```yaml
device:
  port: /dev/ttyACM0
  auto_detect: true
  transport: auto
  usb_vid: 0x1965
  usb_pid: 0x0017
  usb_serial: null

api:
  host: 127.0.0.1
  port: 8000
  cors_origins:
    - http://localhost:3000

polling:
  sts_interval: 0.1  # 10Hz
  reconnect_backoff: [1, 2, 5, 10, 30]

state:
  persistence: sqlite  # or json
  db_path: ./scanner.db

exporters:
  text_file:
    enabled: true
    path: ./now_scanning.txt
  json_stream:
    enabled: false
    path: ./events.jsonl
  mqtt:
    enabled: false
    host: 127.0.0.1
    port: 1883
    topic_prefix: scanner
    qos: 0
    retain: false
```

---

## 6. Error Handling

### 6.1 Serial Errors

| Error | Recovery |
|-------|----------|
| Timeout | Retry once, then fail current command |
| Port disconnected | Attempt reconnect with backoff |
| Permission denied | Fail fast with clear user message |
| Malformed response | Log warning, mark state as stale |

### 6.2 API Errors

- Invalid input → 400 with detailed message
- Scanner unavailable → 503 with retry-after header
- Internal error → 500, log full traceback

### 6.3 State Staleness

- If STS polling fails N times consecutively, mark live state as stale
- API returns stale flag in responses
- WebSocket sends `state_stale` event

---

## 7. Testing Strategy

### 7.1 Unit Tests

- Protocol parsers (command encoding, response parsing)
- State store logic (diff calculation, persistence)
- Driver implementations (mock serial responses)

### 7.2 Integration Tests

- Full API contract validation
- WebSocket message flow
- Multi-client scenarios

### 7.3 Hardware Tests

- Real BC125AT connected via USB
- Long-running stability (24+ hours)
- USB disconnect/reconnect recovery

### 7.4 Serial Replay Tests

- Capture real serial traffic from hardware
- Replay captured traffic in tests
- Validate state transitions match recorded behavior

**Capture Format:**

```json
[
  {"timestamp": 0.0, "direction": "tx", "data": "STS\r"},
  {"timestamp": 0.05, "direction": "rx", "data": "SQL,0\rRSSI,75\r"}
]
```

---

## 8. Performance Targets

- **STS Polling:** 10Hz sustained (100ms interval)
- **Command Latency:** < 100ms for control commands
- **WebSocket Push:** < 50ms from state change to client notification
- **Memory Sync:** Full 500 channels in < 60 seconds
- **CPU Usage:** < 5% idle, < 20% during sync
- **Memory Usage:** < 50MB resident

---

## 9. Security Considerations

### 9.1 Current Scope (Local Only)

- API binds to 127.0.0.1 by default
- No authentication required
- Trust boundary: same machine

### 9.2 Future (Network Exposed)

- API key or JWT authentication
- HTTPS/WSS required
- Rate limiting per client
- Input validation and sanitization
- Command authorization (read-only vs control roles)

---

## 10. Deliverables

- [ ] Python package (Bearpaw backend)
- [ ] Single-file executables for macOS, Windows, Linux
- [ ] OpenAPI 3.0 specification (auto-generated from FastAPI)
- [ ] WebSocket message schema (JSON Schema)
- [ ] Configuration file reference
- [ ] Deployment guide (systemd, launchd, Windows Service)
- [ ] Driver extension guide for new scanner families

---

## 11. Dependencies

**Core:**
- Python 3.10+
- pyserial (serial communication)
- FastAPI (API framework)
- uvicorn (ASGI server)
- websockets (WebSocket support)

**Optional:**
- pydantic (data validation)
- SQLAlchemy or sqlite3 (persistence)
- PyYAML or tomli (configuration)
- pytest (testing)

**Packaging:**
- PyInstaller or cx_Freeze (binary builds)
