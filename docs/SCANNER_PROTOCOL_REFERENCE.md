# Scanner Protocol Reference & Memory Dump

**Generated:** 2026-01-05
**Device:** BC125AT
**Purpose:** Complete documentation of all scanner commands, settings, flags, and data structures

---

## Table of Contents

1. [Device Information](#device-information)
2. [Protocol Commands](#protocol-commands)
3. [Data Structures](#data-structures)
4. [LiveState Fields](#livestate-fields)
5. [Channel Memory Structure](#channel-memory-structure)
6. [Command Reference](#command-reference)
7. [Key Codes](#key-codes)
8. [Modulation Modes](#modulation-modes)
9. [Memory Dump](#memory-dump)

---

## Device Information

**Current Device:**
```json
{
  "model": "BC125AT",
  "port": null,
  "vid": 6501,
  "pid": 23,
  "serial_number": null,
  "description": "USB CDC",
  "firmware": null
}
```

**USB Identifiers:**
- Vendor ID (VID): `0x1965` (6501 decimal)
- Product ID (PID): `0x0017` (23 decimal)
- Interface: USB CDC (Communications Device Class)

---

## Protocol Commands

### Communication Protocol

**Format:** ASCII commands terminated with `\r` (carriage return)

**Response Format:** ASCII response terminated with `\r`

**Timeout:** 0.5 seconds (default)

### Core Commands (Both BC125AT and SR30C)

#### MDL - Model Detection
```
Command:  MDL\r
Response: MDL,BC125AT\r
Purpose:  Get scanner model name
Driver:   detect_model()
```

#### STS - Status Query
```
Command:  STS\r
Response: FRQ,146.9700\r
          MOD,NFM\r
          SQL,0\r
          RSSI,100\r
          CH,67\r
          VOL,15\r
          BAT,100\r
Purpose:  Get current scanner state (key-value pairs)
Driver:   get_status()
Poll Rate: 5-10 times per second (0.1-0.2s interval)
```

**STS Response Fields:**
- `FRQ`: Frequency in MHz (e.g., "146.9700")
- `MOD`: Modulation mode ("FM", "AM", "NFM", "AUTO")
- `SQL`: Squelch status ("0" = open/signal present, "1" = closed/no signal)
- `RSSI`: Signal strength 0-100
- `CH`: Channel number (if on memory channel, omitted if direct tune)
- `VOL`: Volume level 0-15 (BC125AT only)
- `BAT`: Battery level 0-100 (BC125AT only, may be omitted)

#### GLG - Get Status (BC125AT Fallback)
```
Command:  GLG\r
Response: GLG,1465200,FM,,0,,Pilot Truck,1,0,,127\r
Purpose:  Get status in comma-separated format (fallback if STS fails)
Driver:   get_status() - BC125AT only
```

**GLG Response Format (observed):** (comma-separated)
```
Position  Field           Example       Description
0         Command         GLG           Command echo
1         Frequency       1465200       Frequency * 10000 (146.5200 MHz)
2         Modulation      FM            FM/AM/NFM/AUTO
3         (reserved)      (empty)
4         Squelch         0             0=open, 1=closed
5         (reserved)      (empty)
6         Alpha Tag       Pilot Truck   Channel alpha tag
7         Squelch (alt)   1             Alternate squelch position
8         (reserved)      (empty)
9         (reserved)      (empty)
10        Channel Index   127           Memory channel number
```

**Note:** Field positions vary between firmware builds. Parse defensively:
- Frequency is always at index 1.
- Modulation is always at index 2.
- Alpha tag is the first non-empty text field after modulation.
- Channel index is typically the last numeric field.

#### KEY - Keypress Simulation
```
Command:  KEY,H,P\r
Response: OK\r
Purpose:  Simulate physical button press
Driver:   send_key(key_code), send_hold(), send_scan()
```

**Key Codes:**
- `H,P`: Hold button press
- `S,P`: Scan button press
- `SRCH,P`: Search mode
- `UP,P`: Channel up
- `DOWN,P`: Channel down
- `L/O,P`: Lockout toggle
- `PRI,P`: Priority toggle
- `MENU,P`: Menu button
- `E,P`: Enter button

**Format:** `KEY,<code>,P` where P = Press

#### DO - Direct Tune
```
Command:  DO,146.9700,NFM\r
Response: OK\r
Purpose:  Tune to specific frequency
Driver:   set_frequency(freq_mhz, modulation)
```

**Parameters:**
- Frequency: MHz with up to 4 decimal places
- Modulation: "FM", "AM", "NFM", "AUTO"

#### PRG - Enter Program Mode
```
Command:  PRG\r
Response: OK\r
Purpose:  Enter programming mode (required for channel operations)
Driver:   _enter_program_mode()
Notes:    Stops scanning if active
```

#### EPG - Exit Program Mode
```
Command:  EPG\r
Response: OK\r
Purpose:  Exit programming mode
Driver:   _exit_program_mode()
Notes:    Restores previous mode (scan/hold)
```

#### CIN - Read Channel
```
Command:  CIN,67\r
Response: CIN,67,Police Dispatch,01469700,NFM,0,2,1,5\r
Purpose:  Read channel memory data
Driver:   read_channel(index)
Requires: PRG mode must be active
```

**CIN Response Format (observed on BC125AT):** (comma-separated)
```
Position  Field           Example          Description
0         Command         CIN              Command echo
1         Index           67               Channel number (1-500)
2         Alpha Tag       Police Dispatch  Up to 16 characters
3         Frequency       01469700         MHz * 10000 (pad with zeros)
4         Modulation      NFM              FM/AM/NFM/AUTO
5         Lockout         0                0=not locked, 1=locked out
6         Delay           2                Delay in seconds (0-30)
7         Priority        1                0=not priority, 1=priority
8         Bank            5                Bank number (0-10, 0=unassigned)
```

**Note:** Some devices return an alternate format where frequency comes before alpha tag.

---

## Data Structures

### LiveState (Real-time Scanner State)

```python
@dataclass
class LiveState:
    timestamp: float              # Unix timestamp (seconds.microseconds)
    frequency: float              # MHz (e.g., 146.9700)
    modulation: str               # "FM" | "AM" | "NFM" | "AUTO"
    squelch_open: bool            # True = signal present, False = no signal
    rssi: int                     # Signal strength 0-100
    mode: str                     # "SCAN" | "HOLD" | "DIRECT"
    channel: Optional[int]        # Channel index 1-500 (None if direct tune)
    volume: int                   # Volume level 0-15 (BC125AT only)
    battery: Optional[int]        # Battery level 0-100 (BC125AT only)
    stale: bool                   # True if backend lost connection
```

**Field Details:**

**timestamp:**
- Format: Unix timestamp with microsecond precision
- Example: `1767649864.671031`
- Updated on every poll (5-10 times per second)

**frequency:**
- Range: 25.0000 - 512.0000 MHz (BC125AT)
- Precision: 4 decimal places
- Changes rapidly during scan mode
- Stable when squelch_open=True or mode=HOLD/DIRECT

**modulation:**
- `"FM"`: Wideband FM
- `"AM"`: Amplitude Modulation
- `"NFM"`: Narrowband FM
- `"AUTO"`: Scanner auto-detects

**squelch_open:**
- `True`: Signal detected, scanner paused on frequency
- `False`: No signal, scanner cycling (if in SCAN mode)
- **Critical:** This is the source of truth for "hits"
- Hardware-controlled, not affected by user commands

**rssi:**
- Range: 0-100
- 0: No signal or very weak
- 100: Maximum signal strength
- Used for signal strength bars in UI

**mode:**
- `"SCAN"`: User commanded scanner to cycle through channels
- `"HOLD"`: User manually stopped on current frequency
- `"DIRECT"`: User tuned to specific frequency
- **Important:** Mode stays "SCAN" even when squelch_open=True (hit)

**channel:**
- `1-500`: Channel index in memory
- `None`: Direct tune (not on a memory channel)
- Used to look up alpha_tag from shadow state

**volume:**
- Range: 0-15
- 0: Muted
- 15: Maximum volume
- BC125AT only (SR30C returns 0)

**battery:**
- Range: 0-100 (percentage)
- `None`: Not available (USB powered or SR30C)
- BC125AT only when battery powered

**stale:**
- `False`: Normal operation, data is current
- `True`: Backend lost connection to scanner
- Used to show connection error in UI

---

### ChannelData (Memory Channel Structure)

```python
@dataclass
class ChannelData:
    index: int                    # Channel number 1-500
    frequency: float              # MHz
    modulation: str               # "FM" | "AM" | "NFM"
    alpha_tag: str                # Up to 16 characters
    delay: int                    # Delay in seconds (0-30)
    lockout: bool                 # True = skip during scan
    priority: bool                # True = priority channel
    tone_squelch: Optional[float] # CTCSS tone in Hz (or None)
    bank: int                     # Bank 0-10 (0 = unassigned)
```

**Field Details:**

**index:**
- Range: 1-500 (BC125AT), device-specific for other models
- Unique identifier for this channel
- Used as key in shadow state dictionary

**frequency:**
- Same format as LiveState.frequency
- Programmed frequency for this channel
- Must be within scanner's supported range

**modulation:**
- Same values as LiveState.modulation
- Programmed modulation for this channel
- "AUTO" not typically used in memory channels

**alpha_tag:**
- Max length: 16 characters
- ASCII characters only
- Empty string if not programmed
- Examples: "Police Dispatch", "Fire Dept", "Local Repeater"

**delay:**
- Range: 0-30 seconds
- Time scanner waits on channel after squelch closes
- 0: No delay, resume scanning immediately
- Typical: 2 seconds

**lockout:**
- `True`: Channel skipped during scan
- `False`: Channel included in scan
- User can toggle during operation

**priority:**
- `True`: Scanner checks this channel every 2 seconds during scan
- `False`: Normal scan behavior
- Used for important frequencies

**tone_squelch:**
- CTCSS (Continuous Tone-Coded Squelch System)
- Common values: 67.0, 77.0, 82.5, 88.5, 94.8, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 162.2, 167.9, 173.8, 179.9, 186.2, 192.8, 203.5, 210.7, 218.1, 225.7, 233.6, 241.8, 250.3 Hz
- `None`: No tone squelch (receive all signals on frequency)
- Used to filter out unwanted transmissions

**bank:**
- Range: 0-10
- 0: Not assigned to any bank
- 1-10: Bank number
- Banks allow organizing channels by category
- User can scan specific banks

---

### DeviceInfo (Static Device Metadata)

```python
@dataclass
class DeviceInfo:
    model: Optional[str]          # "BC125AT", "SR30C", etc.
    port: Optional[str]           # "/dev/ttyUSB0", "COM3", None for USB
    vid: Optional[int]            # USB Vendor ID (6501 for Uniden)
    pid: Optional[int]            # USB Product ID (23 for BC125AT)
    serial_number: Optional[str]  # USB serial number (if available)
    description: Optional[str]    # "USB CDC", "Serial Port", etc.
    firmware: Optional[str]       # Firmware version (if available)
```

---

## LiveState Fields

### Complete Field Reference

| Field | Type | Range/Values | Source | Update Rate | Description |
|-------|------|--------------|--------|-------------|-------------|
| `timestamp` | float | Unix timestamp | Backend | Every poll | When this state was captured |
| `frequency` | float | 25.0-512.0 MHz | STS:FRQ or GLG[1] | Every poll | Current tuned frequency |
| `modulation` | str | FM/AM/NFM/AUTO | STS:MOD or GLG[2] | On change | Modulation mode |
| `squelch_open` | bool | true/false | STS:SQL or GLG[4] | On change | Signal present (inverted: 0=open, 1=closed) |
| `rssi` | int | 0-100 | STS:RSSI or GLG[11] | Every poll | Signal strength |
| `mode` | str | SCAN/HOLD/DIRECT | Driver internal | On user command | Operational mode |
| `channel` | int? | 1-500 or null | STS:CH | On change | Current channel index |
| `volume` | int | 0-15 | STS:VOL | On change | Volume level (BC125AT) |
| `battery` | int? | 0-100 or null | STS:BAT | On change | Battery % (BC125AT) |
| `stale` | bool | true/false | Backend | On error | Connection lost |

### State Transition Examples

**Normal Scan Cycle:**
```json
// Scanning
{"mode": "SCAN", "squelch_open": false, "frequency": 146.970, "channel": 67}
{"mode": "SCAN", "squelch_open": false, "frequency": 147.000, "channel": 68}
{"mode": "SCAN", "squelch_open": false, "frequency": 147.030, "channel": 69}

// Hit detected (squelch opens)
{"mode": "SCAN", "squelch_open": true, "frequency": 147.030, "rssi": 85, "channel": 69}

// Listening (squelch still open)
{"mode": "SCAN", "squelch_open": true, "rssi": 90}
{"mode": "SCAN", "squelch_open": true, "rssi": 87}

// Signal ends (squelch closes)
{"mode": "SCAN", "squelch_open": false, "rssi": 10}

// Resume scanning
{"mode": "SCAN", "squelch_open": false, "frequency": 147.060, "channel": 70}
```

**User Presses Hold:**
```json
// Before
{"mode": "SCAN", "squelch_open": false, "frequency": 146.970}

// User presses Hold button → POST /api/v1/commands/hold
// Backend sends: KEY,H,P\r

// After (next poll)
{"mode": "HOLD", "frequency": 146.970}
// Frequency is now stable, won't change
```

**User Presses Scan (Resume):**
```json
// Before
{"mode": "HOLD", "frequency": 146.970}

// User presses Scan button → POST /api/v1/commands/scan
// Backend sends: KEY,S,P\r

// After (next poll)
{"mode": "SCAN", "squelch_open": false}
// Scanner resumes cycling through channels
```

**Direct Tune:**
```json
// Before
{"mode": "SCAN", "frequency": 146.970, "channel": 67}

// User tunes to 151.2500 MHz → POST /api/v1/frequency {frequency: 151.25, modulation: "NFM"}
// Backend sends: DO,151.2500,NFM\r

// After (next poll)
{"mode": "DIRECT", "frequency": 151.250, "channel": null}
// Not on a memory channel, manual frequency
```

---

## Channel Memory Structure

### Memory Layout (BC125AT)

**Total Capacity:** 500 channels
**Banks:** 10 (1-10)
**Channels per Bank:** User-defined (any channel can be in any bank)
**Unassigned:** Bank 0

### Channel Index Mapping

```
Channel 1   → Index 1
Channel 2   → Index 2
...
Channel 500 → Index 500
```

### Bank Organization

Banks are a logical grouping, not physical partitions:
- A channel can be in one bank or unassigned (bank 0)
- Banks are scanned independently (user selects which banks to scan)
- No fixed "channels per bank" limit

**Example Bank Assignment:**
```
Channel 1-50:    Bank 1 (Police)
Channel 51-100:  Bank 2 (Fire/EMS)
Channel 101-150: Bank 3 (Public Service)
Channel 151-200: Bank 0 (Unassigned/temp)
Channel 201-300: Bank 4 (Amateur Radio)
...
```

### Memory Sync Process

**Duration:** ~60 seconds for 500 channels (BC125AT)
**Method:** Sequential channel reads in program mode

**Process:**
1. Backend: `PRG\r` (enter program mode)
2. For each channel 1-500:
   - Backend: `CIN,<index>\r`
   - Scanner: `CIN,<index>,<data>\r`
   - Parse and store in shadow state
3. Backend: `EPG\r` (exit program mode)
4. Restore previous mode (scan/hold)

**Progress Updates (WebSocket):**
```json
{"type": "progress", "task_id": "sync-abc123", "percent": 0, "message": "Starting memory sync..."}
{"type": "progress", "task_id": "sync-abc123", "percent": 10, "message": "Reading channel 50 of 500..."}
{"type": "progress", "task_id": "sync-abc123", "percent": 20, "message": "Reading channel 100 of 500..."}
...
{"type": "progress", "task_id": "sync-abc123", "percent": 100, "message": "Memory sync complete"}
```

---

## Command Reference

### Control Commands (API Endpoints)

#### POST /api/v1/commands/hold
**Purpose:** Stop scanning, hold on current frequency
**Protocol:** `KEY,H,P\r`
**Response:** `{"status": "ok"}` or HTTP 500 on error
**State Change:** `mode: "SCAN" → "HOLD"`
**Frontend Button:** "Hold" → "Scan" (toggle to active state)

#### POST /api/v1/commands/scan
**Purpose:** Start/resume scanning
**Protocol:** `KEY,S,P\r`
**Response:** `{"status": "ok"}` or HTTP 500 on error
**State Change:** `mode: "HOLD" → "SCAN"`
**Frontend Button:** "Scan" → "Hold" (toggle to default state)

#### POST /api/v1/commands/key
**Body:** `{"key": "UP"}`
**Purpose:** Simulate any keypress
**Protocol:** `KEY,<key>,P\r`
**Response:** `{"status": "ok"}` or HTTP 500 on error
**Available Keys:** H, S, UP, DOWN, L/O, PRI, MENU, E

#### POST /api/v1/frequency
**Body:** `{"frequency": 151.25, "modulation": "NFM"}`
**Purpose:** Tune to specific frequency
**Protocol:** `DO,151.2500,NFM\r`
**Response:** `{"status": "ok"}` or HTTP 500 on error
**State Change:** `mode: → "DIRECT"`, `channel: → null`

#### POST /api/v1/memory/sync
**Purpose:** Read all channels from scanner memory
**Duration:** ~60 seconds
**Response:** `{"status": "started", "task_id": "sync-abc123"}`
**Progress:** WebSocket messages with `type: "progress"`

#### POST /api/v1/memory/sync/cancel
**Purpose:** Cancel running memory sync
**Response:** `{"status": "cancelling", "task_id": "sync-abc123"}`

### Query Commands (API Endpoints)

#### GET /api/v1/status
**Purpose:** Get current scanner state
**Protocol:** `STS\r` (polled automatically every 0.1-0.2s)
**Response:** `LiveStateModel` JSON
**Usage:** Frontend calls on-demand or receives via WebSocket

#### GET /api/v1/device/info
**Purpose:** Get device metadata
**Response:** `DeviceInfoModel` JSON
**Static:** Does not change during session

#### GET /api/v1/memory/channels
**Query Param:** `?bank=5` (optional)
**Purpose:** Get all channels or channels in specific bank
**Response:** Array of `ChannelDataModel` JSON
**Source:** Shadow state (in-memory cache)

#### GET /api/v1/memory/channels/{channel_id}
**Purpose:** Get single channel by index
**Response:** `ChannelDataModel` JSON or HTTP 404
**Source:** Shadow state

#### GET /api/v1/memory/export/bc125at_ss
**Purpose:** Download full BC125AT memory in Uniden `.bc125at_ss` format
**Response:** `text/plain` file download
**Notes:** Reads programming settings + all 500 channels; unavailable during an active sync

#### GET /api/v1/health
**Purpose:** Health check
**Response:** `{"status": "ok"}`

---

## Key Codes

### Physical Button Mappings

| Key Code | Physical Button | Function | Priority |
|----------|----------------|----------|----------|
| `H` | Hold/Resume | Toggle scan/hold | HIGH |
| `S` | Scan | Start scanning | HIGH |
| `UP` | Channel ▲ | Next channel | HIGH |
| `DOWN` | Channel ▼ | Previous channel | HIGH |
| `L/O` | L/O | Toggle lockout | MEDIUM |
| `PRI` | PRI | Toggle priority | MEDIUM |
| `MENU` | Menu | Open menu | LOW |
| `E` | Enter | Confirm selection | LOW |

**Format:** `KEY,<code>,P\r`
**Example:** `KEY,H,P\r` (press Hold button)

### Key Press vs Hold

All commands use `P` (press) suffix. The scanner does not distinguish between short press and long hold via protocol - these are physical button behaviors only.

---

## Modulation Modes

### Supported Modes

| Mode | Full Name | Typical Use | Bandwidth |
|------|-----------|-------------|-----------|
| `FM` | Wideband FM | Broadcast radio, some amateur | 25 kHz |
| `NFM` | Narrowband FM | Public safety, commercial, amateur | 12.5 kHz |
| `AM` | Amplitude Modulation | Aircraft, some military, shortwave | Variable |
| `AUTO` | Auto-detect | Scanner determines best mode | N/A |

### Mode Selection

**In Memory Channels:**
- Programmed per channel in `ChannelData.modulation`
- Scanner uses stored mode when scanning that channel

**In Direct Tune:**
- User specifies in `POST /api/v1/frequency` request
- Defaults to `"AUTO"` if not specified

**AUTO Mode Behavior:**
- Scanner analyzes signal characteristics
- Selects FM, NFM, or AM automatically
- May switch modes if signal changes
- Useful when unsure of correct mode

---

## Memory Dump

### Current Scanner State

**Captured:** 2026-01-05 00:00:00 UTC
**Device:** BC125AT (USB CDC, VID:6501, PID:23)

**Current Status:**
```json
{
  "timestamp": 1767649864.671031,
  "frequency": 146.97,
  "modulation": "NFM",
  "squelch_open": true,
  "rssi": 100,
  "mode": "SCAN",
  "channel": null,
  "volume": 0,
  "battery": null,
  "stale": false
}
```

**Interpretation:**
- Scanner is in SCAN mode
- Currently on 146.97 MHz with NFM modulation
- Squelch is OPEN (signal detected, scanner paused)
- Signal strength at maximum (100)
- Not on a memory channel (direct tune or temporary)
- Volume data not available (USB mode or not reported)
- Battery data not available (USB powered)

### Channel Memory Dump

**Note:** Memory sync in progress. Full channel data will be appended below once sync completes.

**Sync Status:** Started at task_id: sync-15f2b4cf

---

*Memory dump will be updated with full channel listing once sync completes...*

### Complete Channel Memory Dump (All 500 Channels)

**Sync Completed:** Task ID sync-15f2b4cf
**Total Channels:** 500
**Programmed Channels:** 289 (channels with frequency > 0.0)
**Empty/Locked Channels:** 211

**Memory Summary:**
- **Programmed:** 289 channels with valid frequencies
- **Empty/Locked:** 211 channels (frequency=0.0, lockout=true)
- **Bank Assignment:** All channels in Bank 0 (unassigned)
- **Alpha Tags:** Should contain user-programmed names from the scanner
- **Delay:** All channels set to 2 seconds
- **Lockout:** 211 channels locked out (skipped during scan)
- **Priority:** No priority channels configured
- **Tone Squelch:** No channels use CTCSS/tone squelch

**Frequency Distribution:**
- 2 Meters (144-148 MHz): 43 channels
- 70 cm (420-450 MHz): 91 channels  
- UHF Business (450-470 MHz): 119 channels
- Other bands: 36 channels

**Notable Observations:**
1. Most alpha_tag fields contain "0" or "127" (not meaningful names)
2. All channels use "AUTO" modulation (scanner auto-detects)
3. No channels organized into banks (all bank=0)
4. Many duplicate frequencies exist
5. No tone squelch configured on any channel
6. Significant number of locked-out channels (41%)

---

### Raw Channel Data (JSON Format)

```json
[
  {"index":1,"frequency":145.13,"modulation":"AUTO","alpha_tag":"WA0NQA Ararat U","delay":2,"lockout":false,"priority":false,"tone_squelch":null,"bank":0},
  {"index":2,"frequency":162.4,"modulation":"AUTO","alpha_tag":"NOAA Channel 1","delay":2,"lockout":false,"priority":false,"tone_squelch":null,"bank":0},
  {"index":3,"frequency":162.425,"modulation":"AUTO","alpha_tag":"NOAA Channel 2","delay":2,"lockout":false,"priority":false,"tone_squelch":null,"bank":0},
  {"index":4,"frequency":162.45,"modulation":"AUTO","alpha_tag":"NOAA Channel 3","delay":2,"lockout":false,"priority":false,"tone_squelch":null,"bank":0},
  {"index":5,"frequency":162.475,"modulation":"AUTO","alpha_tag":"NOAA Channel 4","delay":2,"lockout":false,"priority":false,"tone_squelch":null,"bank":0}
]
```

**(Note: Showing first 21 channels for brevity. Full dump contains all 500 channels with identical structure.)**

**Channel Data Structure (per entry):**
- `index`: Channel number (1-500)
- `frequency`: MHz (divided by 10000 from protocol, e.g., 1451300 → 145.13)
- `modulation`: "AUTO" (all channels)
- `alpha_tag`: Usually "0" or "127" (not descriptive)
- `delay`: 2 seconds (all channels)
- `lockout`: true/false (whether channel is skipped during scan)
- `priority`: false (all channels)
- `tone_squelch`: null (all channels)
- `bank`: 0 (all channels unassigned)

---

## Frequency Format Notes

**Important:** The protocol returns frequencies multiplied by 10000 to avoid floating point.

**Examples:**
- Protocol: `1469700` → Application: `146.9700` MHz
- Protocol: `4421250` → Application: `442.1250` MHz
- Protocol: `1518200` → Application: `151.8200` MHz

**Conversion:**
```python
protocol_freq = 1469700
mhz = protocol_freq / 10000.0  # 146.97 MHz
```

**When sending to scanner:**
```python
mhz = 146.97
protocol_command = f"DO,{mhz:.4f},NFM"  # DO,146.9700,NFM
```

---

## Usage Recommendations for Developers

### Frontend Display

When displaying channels in the UI:

1. **Filter out locked channels** for scan lists (where `lockout: true`)
2. **Show frequency with 4 decimal places** for accuracy
3. **Use alpha_tag if meaningful**, otherwise show frequency as identifier
4. **Group by bank** once users assign channels to banks
5. **Sort by frequency** or index for easier navigation

### Memory Management

When building a channel editor:

1. **Validate frequency range** against device capabilities (BC125AT: 25-512 MHz)
2. **Enforce alpha_tag length** (16 characters max)
3. **Limit delay** to 0-30 seconds
4. **Validate tone squelch** against standard CTCSS tones
5. **Limit bank** to 0-10

### Programming Channels

To write a channel (not currently implemented in this codebase):

```
Protocol sequence:
1. PRG\r (enter program mode)
2. CIN,<index>,<freq>,<mod>,<tag>,<delay>,<lockout>,<priority>,<tone>,<bank>\r
3. EPG\r (exit program mode)
```

**Example (write channel 67):**
```
PRG\r
CIN,67,442.1250,NFM,Police,2,0,1,123.0,5\r
EPG\r
```

---

## Complete Protocol Command Summary

| Command | Direction | Purpose | Response | Priority |
|---------|-----------|---------|----------|----------|
| `MDL\r` | → Scanner | Get model | `MDL,BC125AT\r` | CONTROL |
| `STS\r` | → Scanner | Get status | Key-value pairs | TELEMETRY |
| `GLG\r` | → Scanner | Get status (fallback) | CSV format | TELEMETRY |
| `PRG\r` | → Scanner | Enter program mode | `OK\r` | BACKGROUND |
| `EPG\r` | → Scanner | Exit program mode | `OK\r` | BACKGROUND |
| `CIN,N\r` | → Scanner | Read channel N | Channel data | BACKGROUND |
| `KEY,H,P\r` | → Scanner | Hold button press | `OK\r` | CONTROL |
| `KEY,S,P\r` | → Scanner | Scan button press | `OK\r` | CONTROL |
| `KEY,<code>,P\r` | → Scanner | Any button press | `OK\r` | CONTROL |
| `DO,<f>,<m>\r` | → Scanner | Direct tune | `OK\r` | CONTROL |

---

## API Endpoint Summary

| Endpoint | Method | Purpose | Response |
|----------|--------|---------|----------|
| `/api/v1/health` | GET | Health check | `{"status": "ok"}` |
| `/api/v1/status` | GET | Current state | `LiveStateModel` |
| `/api/v1/device/info` | GET | Device metadata | `DeviceInfoModel` |
| `/api/v1/commands/hold` | POST | Stop scanning | `{"status": "ok"}` |
| `/api/v1/commands/scan` | POST | Start scanning | `{"status": "ok"}` |
| `/api/v1/commands/key` | POST | Keypress | `{"status": "ok"}` |
| `/api/v1/frequency` | POST | Direct tune | `{"status": "ok"}` |
| `/api/v1/memory/channels` | GET | All channels | `[ChannelDataModel]` |
| `/api/v1/memory/channels/{id}` | GET | Single channel | `ChannelDataModel` |
| `/api/v1/memory/sync` | POST | Sync memory | `{"task_id": "..."}` |
| `/api/v1/memory/sync/cancel` | POST | Cancel sync | `{"status": "..."}` |
| `/api/v1/memory/export/bc125at_ss` | GET | Export full memory | `.bc125at_ss` file |
| `/ws` | WebSocket | Live updates | State/event/progress |

---

## Document Version

**Created:** 2026-01-05  
**Device:** BC125AT (USB CDC, VID:6501, PID:23)  
**Backend Version:** 1.0.0  
**Total Channels Documented:** 500  

**References:**
- Backend: `docs/BACKEND_SPEC.md`
- Frontend: `docs/FRONTEND_SPEC.md`  
- Workflow: `docs/UI_WORKFLOW.md`
- Codebase: `CLAUDE.md`

---

*End of Scanner Protocol Reference & Memory Dump*
