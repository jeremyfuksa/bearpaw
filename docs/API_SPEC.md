# Bearpaw API Specification

**Version:** 1.0.0
**Protocol:** HTTP REST + WebSocket
**Format:** JSON
**Base URL:** `http://localhost:8000/api/v1`

---

## 1. Overview

This document defines the API contract between the Bearpaw backend and all clients (including the web UI). The backend exposes scanner functionality via a REST API for control commands and queries, and a WebSocket API for real-time telemetry.

### 1.1 Design Principles

- **RESTful Design:** Resources are nouns, actions are HTTP verbs
- **Stateless:** Each request contains all necessary information
- **Versioned:** API version in URL path (`/api/v1`)
- **JSON:** All payloads are JSON-encoded
- **Idempotent:** GET/PUT/DELETE are idempotent; POST is not
- **Push Telemetry:** WebSocket for state updates (no polling)

### 1.2 Authentication (Future)

Current version: **No authentication** (localhost-only, trusted environment)

Future versions will support:
- API key via `Authorization: Bearer <token>` header
- JWT tokens for user sessions
- Role-based access control (read-only vs control)

---

## 2. Common Data Types

### 2.1 LiveState

Current scanner receiver state.

```json
{
  "timestamp": 1704412800.123,
  "frequency": 151.2500,
  "modulation": "FM",
  "squelch_open": true,
  "rssi": 75,
  "mode": "SCAN",
  "channel": 25,
  "volume": 10,
  "battery": 85,
  "tone_squelch_kind": "ctcss",
  "tone_squelch": 123.0,
  "tone_dcs_code": null,
  "tone_dcs_label": null
}
```

| Field | Type | Description | Valid Values |
|-------|------|-------------|--------------|
| `timestamp` | number | Unix timestamp (seconds) | > 0 |
| `frequency` | number | Current frequency (MHz) | 25.0000 - 512.0000 |
| `modulation` | string | Modulation mode | "FM", "AM", "NFM", "AUTO" |
| `squelch_open` | boolean | True if signal present | true, false |
| `rssi` | number | Signal strength percentage | 0 - 100 |
| `mode` | string | Receiver mode | "SCAN", "HOLD", "DIRECT" |
| `channel` | number or null | Current channel number | 1-500 or null |
| `volume` | number | Volume level | 0-15 |
| `battery` | number or null | Battery percentage | 0-100 or null (if AC) |
| `tone_squelch_kind` | string | Tone discriminator for live signal | "none", "ctcss", "dcs", "search" |
| `tone_squelch` | number or null | CTCSS frequency (Hz) when tone_squelch_kind === "ctcss" | 67.0 - 254.1 or null |
| `tone_dcs_code` | number or null | DCS code when tone_squelch_kind === "dcs" | 128-231 or null |
| `tone_dcs_label` | string or null | Display label (e.g., "DCS 023") when tone_squelch_kind === "dcs" | "DCS NNN" or null |

**Note:** The tone fields (`tone_squelch_kind`, `tone_squelch`, `tone_dcs_code`, `tone_dcs_label`) are only populated while `squelch_open === true` (during a hit).

### 2.2 ChannelData

Scanner memory channel information.

```json
{
  "index": 25,
  "frequency": 151.2500,
  "modulation": "FM",
  "alpha_tag": "Police Dispatch",
  "delay": 2,
  "lockout": false,
  "priority": true,
  "tone_squelch": 123.0,
  "bank": 1
}
```

| Field | Type | Description | Valid Values |
|-------|------|-------------|--------------|
| `index` | number | Channel number | 1-500 |
| `frequency` | number | Frequency (MHz) | 25.0000 - 512.0000 |
| `modulation` | string | Modulation mode | "FM", "AM", "NFM" |
| `alpha_tag` | string | Channel name | 0-16 characters |
| `delay` | number | Scan delay (seconds) | 0-30 |
| `lockout` | boolean | Locked out from scan | true, false |
| `priority` | boolean | Priority channel | true, false |
| `tone_squelch` | number or null | CTCSS tone (Hz) | 67.0 - 254.1 or null |
| `bank` | number | Bank assignment | 1-10 |

### 2.3 DeviceInfo

Scanner hardware and connection information.

```json
{
  "model": "BC125AT",
  "firmware": "1.00.05",
  "serial_number": "ABC123456",
  "connection_status": "connected",
  "port": "/dev/ttyACM0",
  "uptime": 3600.5
}
```

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Scanner model name |
| `firmware` | string or null | Firmware version |
| `serial_number` | string or null | Hardware serial number |
| `connection_status` | string | "connected", "disconnected", "connecting" |
| `port` | string | Serial port path |
| `uptime` | number | Seconds since scanner connected |

### 2.4 Error Response

Standard error format for all failed requests.

```json
{
  "error": "invalid_frequency",
  "message": "Frequency 999.999 MHz is out of range for BC125AT (25-512 MHz)",
  "code": 400,
  "details": {
    "min": 25.0,
    "max": 512.0,
    "provided": 999.999
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `error` | string | Machine-readable error code |
| `message` | string | Human-readable error message |
| `code` | number | HTTP status code |
| `details` | object or null | Additional error context |

**Common Error Codes:**

| Code | Error | Description |
|------|-------|-------------|
| `scanner_disconnected` | Scanner hardware not connected |
| `invalid_frequency` | Frequency out of range or malformed |
| `invalid_modulation` | Unsupported modulation mode |
| `prg_mode_active` | Operation not allowed in PRG mode |
| `timeout` | Scanner did not respond in time |
| `not_found` | Resource does not exist |

---

## 3. REST API Endpoints

### 3.1 Health & Status

#### GET /health

Liveness probe — returns 200 whenever the HTTP server is up. Says nothing
about scanner connectivity (use `/status` / `/device/info` for that).

**Request:** None

**Response:** `200 OK`

```json
{
  "status": "ok",
  "version": "1.1.1",
  "timestamp": 1704412800.123
}
```

`version` is the backend crate version (`CARGO_PKG_VERSION`).

---

#### GET /status

Get current scanner live state.

**Request:** None

**Response:** `200 OK`

```json
{
  "timestamp": 1704412800.123,
  "frequency": 151.2500,
  "modulation": "FM",
  "squelch_open": true,
  "rssi": 75,
  "mode": "SCAN",
  "channel": 25,
  "volume": 10,
  "battery": 85,
  "stale": false
}
```

Always returns `200 OK`. When the scanner is disconnected the last-known
state is returned with `"stale": true` — clients should read `stale` (and
`/device/info`'s `connection_status`) rather than expecting a 503 here.

---

### 3.2 Device Information

#### GET /device/info

Get scanner hardware and connection details.

**Request:** None

**Response:** `200 OK`

```json
{
  "model": "BC125AT",
  "firmware": "1.00.05",
  "serial_number": "ABC123456",
  "connection_status": "connected",
  "port": "/dev/ttyACM0",
  "uptime": 3600.5
}
```

**Errors:**
- `503 Service Unavailable` if scanner disconnected

---

### 3.3 Control Commands

#### POST /commands/hold

Enter hold mode (stop scanning, monitor current frequency).

**Request:** None

**Response:** `200 OK`

```json
{
  "status": "ok",
  "mode": "HOLD"
}
```

**Errors:**
- `503 Service Unavailable` if scanner disconnected
- `500 Internal Server Error` if command fails

---

#### POST /commands/scan

Enter scan mode (resume scanning).

**Request:** None

**Response:** `200 OK`

```json
{
  "status": "ok",
  "mode": "SCAN"
}
```

**Errors:**
- `503 Service Unavailable` if scanner disconnected
- `500 Internal Server Error` if command fails

---

---
#### POST /commands/key

Simulate keypress on scanner.

**Request Body:**

```json
{
  "key": "^"
}
```

**Valid Key Codes** (single-character wire codes, per the scanner's `KEY`
protocol — the allowlist in `handlers/commands.rs`):
- `^` - Channel up
- `V` - Channel down
- `<` / `>` - Left / right
- `E` - Enter
- `.` - Dot / decimal
- `0`–`9` - Digits
- `F` - Function
- `H` - Hold (equivalent to POST /commands/hold)
- `S` - Scan (equivalent to POST /commands/scan)
- `L` - Lockout
- `M` - Menu
- `R`, `Q`, `P`, `W` - Reserved scanner keys

**Response:** `200 OK`

```json
{
  "status": "ok",
  "key": "^"
}
```

**Errors:**
- `400 Bad Request` if key code invalid
- `503 Service Unavailable` if scanner disconnected

---

#### POST /frequency — NOT AVAILABLE

**Removed (#149).** BC125AT firmware 1.06.06 has no wire direct-tune command:
`DO` (both frequency encodings) and `QSH` all answer `ERR`
(`docs/wire_captures/2026-07-08/direct-tune-probe.txt`). Direct frequency
entry on this scanner is keypad-only (HOLD + digits + E), which clients can
drive via `POST /commands/key` if needed. The section below is retained for
historical context of the originally-planned contract.

Tune to specific frequency (direct entry mode).

**Request Body:**

```json
{
  "frequency": 151.2500,
  "modulation": "FM"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `frequency` | number | Yes | Frequency in MHz |
| `modulation` | string | No | "FM", "AM", "NFM", or "AUTO" (default) |

**Response:** `200 OK`

```json
{
  "status": "ok",
  "frequency": 151.2500,
  "modulation": "FM"
}
```

**Errors:**
- `400 Bad Request` if frequency out of range or invalid
- `400 Bad Request` if modulation invalid
- `503 Service Unavailable` if scanner disconnected

---

### 3.4 Memory (Shadow State)

#### GET /memory/channels

Get list of scanner memory channels.

**Query Parameters:**
- `bank` (optional): Filter by bank number (1-10)
- `lockout` (optional): Filter by lockout status (true/false)

**Examples:**
- `/memory/channels` - All channels
- `/memory/channels?bank=1` - Only bank 1 channels
- `/memory/channels?lockout=false` - Only non-locked-out channels

**Response:** `200 OK` — a bare JSON array of channel objects (not wrapped in
an envelope):

```json
[
  {
    "index": 25,
    "frequency": 151.2500,
    "modulation": "FM",
    "alpha_tag": "Police Dispatch",
    "delay": 2,
    "lockout": false,
    "priority": true,
    "tone_squelch": 123.0,
    "tone_squelch_kind": "ctcss",
    "bank": 1
  }
]
```

**Errors:**
- `400 Bad Request` if query parameters invalid

---

#### GET /memory/channels/{index}

Get specific channel by index.

**Path Parameters:**
- `index`: Channel number (1-500)

**Example:** `/memory/channels/25`

**Response:** `200 OK`

```json
{
  "index": 25,
  "frequency": 151.2500,
  "modulation": "FM",
  "alpha_tag": "Police Dispatch",
  "delay": 2,
  "lockout": false,
  "priority": true,
  "tone_squelch": 123.0,
  "bank": 1
}
```

**Errors:**
- `404 Not Found` if channel does not exist
- `400 Bad Request` if index out of range (< 1 or > 500)

---

#### POST /memory/channels/{index}/priority

Set or clear a channel's priority. Enforces one priority channel per bank
(the hardware limit).

**Path Parameters:**
- `index`: Channel number (1-500)

**Request:**

```json
{ "priority": true }
```

- `true` — set this channel as its bank's priority. If the bank already has
  a different priority channel, it is cleared first (atomic swap).
- `false` — clear this channel's priority. Uses delete-then-rewrite (`DCH` +
  `CIN`) because the firmware refuses an in-place priority downgrade; the
  channel's other data is preserved.

**Response:** `200 OK`

```json
{ "changed": [ /* ChannelData, ... */ ] }
```

`changed` lists the channels whose state changed (the cleared old channel,
if any, then the newly-set channel).

**Errors:**
- `400 channel_out_of_range` if index out of range (< 1 or > 500)
- `400 priority_set_empty_channel` if the target channel is empty
- `400 priority_clear_not_persisted` / `priority_set_not_persisted` if
  hardware read-back verification failed

**Note:** see
[`docs/wire_captures/2026-05-21/audit-reconciliation.md`](wire_captures/2026-05-21/audit-reconciliation.md)
(2026-07-21 finding) for why clearing requires `DCH` + rewrite.

---

#### POST /memory/sync

Start full memory sync from scanner (read all channels).

**Request:** None

**Response:** `200 OK`

```json
{
  "status": "started",
  "task_id": "sync-abc123"
}
```

If a sync is already running, this returns `200 OK` with
`{"status": "already_running", "task_id": "<existing>"}` (not a 409).

**Behavior:**
- Async operation (returns immediately)
- Progress updates via WebSocket (`progress` message type)
- Shadow state updated only after a clean, complete walk
- Scanner enters PRG mode (normal operation suspended)

**Errors:**
- `503 Service Unavailable` if scanner disconnected

**Progress Tracking:** Subscribe to WebSocket `progress` messages with `task_id`

---

#### GET /memory/sync/status

Snapshot of whether a memory sync is currently running. Intended for clients
re-checking after a WebSocket reconnect: if the final "Sync complete" progress
message was broadcast while the socket was down, the client's local
in-progress flag is stale until it queries this endpoint.

**Request:** None

**Response:** `200 OK`

```json
{
  "in_progress": true,
  "task_id": "sync-abc123"
}
```

When no sync is running, `in_progress` is `false` and `task_id` is `null`.

---

#### GET /memory/export/bc125at_ss

Download full scanner memory in Uniden `.bc125at_ss` format.

**Response:** `200 OK` (text/plain)

**Headers:**
- `Content-Disposition: attachment; filename=scanner.bc125at_ss`

**Behavior:**
- Reads all programming settings and channels from the scanner.
- Runs in program mode; do not use while a sync is in progress.

**Errors:**
- `400 Bad Request` if scanner model is not BC125AT
- `409 Conflict` if a memory sync is in progress
- `503 Service Unavailable` if scanner disconnected

---

#### POST /memory/sync/cancel

Request cancellation of the in-progress memory sync. Cancellation is
cooperative — this only sets the cancel flag; the sync loop stops at the next
channel boundary and the WebSocket `progress` stream emits "Sync cancelled".

**Request:** None

**Response:** `200 OK`

```json
{
  "status": "cancelling",
  "task_id": "sync-abc123"
}
```

If no sync is running, returns `200 OK` with `{"status": "no_task"}`.

---

#### GET /memory/export/csv

Download scanner channels in CSV format.

**Response:** `200 OK` (text/csv)

**Headers:**
- `Content-Disposition: attachment; filename=channels.csv`

**Behavior:**
- Exports all channels from shadow state (not scanner)
- Includes all channel fields: Index, Frequency, Modulation, Alpha Tag, Delay, Lockout, Priority, CTCSS/DCS, Bank
- No program mode required (uses cached shadow state)

**Errors:**
- `503 Service Unavailable` if backend error

**CSV Format:**
```csv
Index,Frequency,Modulation,Alpha Tag,Delay,Lockout,Priority,CTCSS/DCS,Bank
1,151.2500,FM,Police Dispatch,2,false,true,123.0,1
2,154.6000,NFM,Fire Dispatch,2,false,false,,1
```

---

#### POST /memory/import/csv

Import channels from CSV file.

**Request:** `multipart/form-data` with file field

**Response:** `200 OK`

```json
{
  "imported": 45,
  "errors": [
    {
      "row": {"Index": "501", "Frequency": "999.0000", ...},
      "error": "Invalid frequency: 999.0"
    }
  ]
}
```

**Behavior:**
- Parses CSV and validates each row
- Updates shadow state with valid channels
- Writes to scanner if channel_write_supported
- Returns count of successfully imported channels and any errors

**Validation:**
- Frequency must be 25-512 MHz
- Delay must be 0-30 seconds
- Bank must be 1-10
- Lockout/Priority must be "true" or "false"

**Errors:**
- `400 Bad Request` if CSV format invalid
- `503 Service Unavailable` if backend error

---

### 3.5 Preferences

#### GET /preferences

Get all application preferences.

**Response:** `200 OK`

```json
{
  "dashboard_enabled": true,
  "default_volume": 10,
  "auto_start_scan": true
}
```

**Errors:**
- `503 Service Unavailable` if preferences store not configured

---

#### GET /preferences/{key}

Get a specific preference value.

**Path Parameters:**
- `key`: Preference key name

**Response:** `200 OK`

```json
{
  "key": "dashboard_enabled",
  "value": true
}
```

**Errors:**
- `404 Not Found` if preference key does not exist
- `503 Service Unavailable` if preferences store not configured

---

#### PUT /preferences/{key}

Set a specific preference value.

**Path Parameters:**
- `key`: Preference key name

**Request Body:**

```json
{
  "value": true
}
```

**Response:** `200 OK`

```json
{
  "key": "dashboard_enabled",
  "value": true
}
```

**Errors:**
- `400 Bad Request` if value field missing
- `503 Service Unavailable` if preferences store not configured

---

#### PUT /preferences

Set multiple preferences at once.

**Request Body:**

```json
{
  "dashboard_enabled": true,
  "default_volume": 10,
  "auto_start_scan": false
}
```

**Response:** `200 OK`

Returns all current preferences after update.

**Errors:**
- `503 Service Unavailable` if preferences store not configured

---

#### POST /preferences/reset

Reset all preferences to default values.

**Response:** `200 OK`

Returns default preference values.

**Errors:**
- `503 Service Unavailable` if preferences store not configured

---

### 3.6 Analytics

#### GET /analytics/activity-log

Get activity log entries with optional filtering.

**Query Parameters:**
- `limit` (optional): Maximum number of entries to return (default: 100)
- `offset` (optional): Number of entries to skip (for pagination, default: 0)
- `start_time` (optional): Unix timestamp for start of range
- `end_time` (optional): Unix timestamp for end of range
- `channel` (optional): Filter by specific channel number

**Examples:**
- `/analytics/activity-log` - Last 100 entries
- `/analytics/activity-log?limit=50&offset=50` - Entries 51-100
- `/analytics/activity-log?channel=25` - Only channel 25
- `/analytics/activity-log?start_time=1704412800&end_time=1704499200` - Specific date range

**Response:** `200 OK`

```json
[
  {
    "id": 1,
    "timestamp": 1704412800.123,
    "frequency": 151.2500,
    "channel": 25,
    "alpha_tag": "Police Dispatch",
    "rssi": 75,
    "duration": 12.5,
    "modulation": "FM",
    "mode": "SCAN",
    "bank": 1,
    "session_id": "session-abc123",
    "ended_at": 1704412812.623
  }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `id` | number | Unique entry ID |
| `timestamp` | number | Unix timestamp when hit started |
| `frequency` | number | Frequency in MHz |
| `channel` | number or null | Channel number |
| `alpha_tag` | string | Channel name |
| `rssi` | number | Signal strength (0-100) |
| `duration` | number or null | Duration in seconds |
| `modulation` | string | Modulation mode |
| `mode` | string | Receiver mode when hit occurred |
| `bank` | number or null | Bank number |
| `session_id` | string | Session identifier |
| `ended_at` | number or null | Unix timestamp when hit ended |

**Errors:**
- `503 Service Unavailable` if analytics not enabled

---

### 3.7 Additional implemented endpoints

These routes are implemented (see `crates/bearpaw-api/src/api/mod.rs` `router()`
and `handlers/`) but were not previously covered above. Listed here so the spec
matches the running surface; the handler is the source of truth for exact
request/response shapes.

| Method(s) | Path | Purpose |
| --- | --- | --- |
| GET, POST | `/api/v1/banks` | Read / set the 10-char bank-enable mask (`'1'` = disabled). |
| GET, POST | `/api/v1/volume` | Read / set scanner volume (0–15). |
| GET, POST | `/api/v1/squelch` | Read / set squelch level. |
| GET | `/api/v1/config` (alias `/api/v1/settings/all`) | Full settings snapshot read from the scanner. |
| GET, POST | `/api/v1/settings/backlight`, `/battery`, `/close-call`, `/contrast`, `/custom-search`, `/custom-search/defaults`, `/custom-search/ranges/{index}`, `/key-beep`, `/priority`, `/search`, `/service-search`, `/weather` | Individual global-setting getters/setters (each brackets its work in PRG). |
| GET | `/api/v1/lockouts` | Frequency + channel + temporary lockouts. |
| POST | `/api/v1/lockouts/clear`, `/lockouts/channels/clear`, `/lockouts/temporary/clear` | Clear the respective lockout sets. |
| POST | `/api/v1/memory/program-mode/start`, `/memory/program-mode/end` | Open / close a manual program-mode session across requests. |
| POST | `/api/v1/memory/import/csv` | Import channels from CSV. |
| GET | `/api/v1/analytics/busiest-channels` | Busiest channels; `limit` (default 10), `hours` scopes the window (default: all history). |
| GET | `/api/v1/analytics/session-stats` | Hit count / avg RSSI / active seconds / unique channels for the current backend session. |
| GET | `/api/v1/analytics/hourly-heatmap` | 7×24 hit bins; `days` (default 7), `tz_offset_minutes` (minutes east of UTC, e.g. -300 for CDT) for local-time bucketing — default is UTC. |
| POST | `/api/v1/analytics/cleanup` | Delete hits older than `retention_days` (default 30). |

> Note: `POST /api/v1/preferences` was previously a destructive alias for
> `reset_preferences` — POSTing a preferences object to the collection URL (a
> natural client mistake) wiped all preferences. The alias is removed (#150);
> resetting requires the explicit `POST /api/v1/preferences/reset`, and single
> preferences are set with `PUT /api/v1/preferences/{key}`. `POST
> /api/v1/preferences` now returns 405.

---

## 4. WebSocket API

### 4.1 Connection

**Endpoint:** `ws://localhost:8000/ws`

**Protocol:** RFC 6455 WebSocket

**Subprotocol:** None (JSON messages)

**Connection Flow:**

```javascript
const ws = new WebSocket('ws://localhost:8000/ws');

ws.onopen = () => {
  console.log('Connected to Bearpaw');
};

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  console.log('Received:', message);
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
};

ws.onclose = () => {
  console.log('Disconnected');
  // Implement reconnection logic with exponential backoff
};
```

**Heartbeat:**
- Server sends ping frame every 30 seconds
- Client must respond with pong within 10 seconds
- Server closes connection if no pong received

---

### 4.2 Message Types

All messages are JSON objects with a `type` field for discrimination.

#### 4.2.1 State Update

Pushed when scanner live state changes.

```json
{
  "type": "state_update",
  "timestamp": 1704412800.123,
  "sequence": 12345,
  "data": {
    "frequency": 151.2500,
    "squelch_open": true,
    "rssi": 75
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always "state_update" |
| `timestamp` | number | Unix timestamp of update |
| `sequence` | number | Monotonically increasing sequence number |
| `data` | object | Partial LiveState (only changed fields) |

**Notes:**
- Only changed fields are included in `data`
- Clients should merge `data` into their local state
- `sequence` can detect missed messages

---

#### 4.2.2 Event

Pushed when scanner events occur.

```json
{
  "type": "event",
  "timestamp": 1704412800.456,
  "event": "scan_hit",
  "data": {
    "frequency": 151.2500,
    "channel": 25,
    "alpha_tag": "Police Dispatch"
  }
}
```

**Event Types:**

| Event | Description | Data Fields |
|-------|-------------|-------------|
| `scan_hit` | Scanner stopped on active frequency | `frequency`, `channel`, `alpha_tag` |
| `scan_start` | Scan mode activated | None |
| `hold` | Hold mode activated | `frequency` |
| `mode_change` | Receiver mode changed | `mode` |

---

#### 4.2.3 Progress

Pushed during long-running operations (memory sync).

```json
{
  "type": "progress",
  "task_id": "sync-abc123",
  "percent": 45,
  "current": 225,
  "total": 500,
  "message": "Syncing channel 225/500"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always "progress" |
| `task_id` | string | Task identifier from POST request |
| `percent` | number | Completion percentage (0-100) |
| `current` | number | Current item number |
| `total` | number | Total items |
| `message` | string | Human-readable progress message |

---

#### 4.2.4 Error

Pushed when scanner errors occur.

```json
{
  "type": "error",
  "timestamp": 1704412800.789,
  "error": "scanner_disconnected",
  "message": "Scanner USB connection lost",
  "severity": "critical"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always "error" |
| `timestamp` | number | Unix timestamp |
| `error` | string | Machine-readable error code |
| `message` | string | Human-readable message |
| `severity` | string | "critical", "warning", "info" |

**Severity Levels:**
- `critical`: Scanner disconnected, service stopping
- `warning`: Transient error, automatic recovery attempted
- `info`: Informational message, no action required

---

#### 4.2.5 Complete

Pushed when long-running operation completes.

```json
{
  "type": "complete",
  "task_id": "sync-abc123",
  "status": "success",
  "duration": 58.3,
  "result": {
    "channels_synced": 500,
    "errors": 0
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always "complete" |
| `task_id` | string | Task identifier |
| `status` | string | "success" or "error" |
| `duration` | number | Seconds elapsed |
| `result` | object | Task-specific result data |

---

### 4.3 Client Responsibilities

**Reconnection:**
- Implement exponential backoff (1s, 2s, 4s, 8s, max 30s)
- Request fresh state after reconnection (GET /status)
- Handle missed messages gracefully

**State Synchronization:**
- Maintain local copy of LiveState
- Merge `state_update` messages into local state
- Mark state as stale if connection lost

**Error Handling:**
- Display error messages to user
- Disable controls on critical errors
- Attempt recovery on warnings

---

## 5. HTTP Headers

### 5.1 Request Headers

```
Content-Type: application/json
Accept: application/json
```

**Future (Authentication):**

```
Authorization: Bearer <token>
```

### 5.2 Response Headers

```
Content-Type: application/json
X-Scanner-Bridge-Version: 1.0.0
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1704412860
```

**Future Rate Limiting:**
- 100 requests per minute per client
- Returns `429 Too Many Requests` if exceeded

---

## 6. HTTP Status Codes

| Code | Meaning | Usage |
|------|---------|-------|
| 200 | OK | Successful request |
| 202 | Accepted | Async operation started |
| 400 | Bad Request | Invalid input |
| 404 | Not Found | Resource does not exist |
| 409 | Conflict | Operation conflicts with current state |
| 429 | Too Many Requests | Rate limit exceeded |
| 500 | Internal Server Error | Backend error |
| 503 | Service Unavailable | Scanner disconnected |

---

## 7. Versioning

**Current Version:** 1.0.0

**URL Path:** `/api/v1/...`

**Breaking Changes:**
- Increment major version (v2, v3, etc.)
- Maintain backward compatibility for at least one version
- Deprecation notices in response headers:

```
X-Deprecated: true
X-Sunset: 2025-01-01T00:00:00Z
```

**Non-Breaking Changes:**
- Add new optional fields (clients ignore unknown fields)
- Add new endpoints
- Add new WebSocket message types

---

## 8. Examples

### 8.1 Full Workflow: Scan → Hit → Hold → Tune

**1. Client connects to WebSocket**

```javascript
const ws = new WebSocket('ws://localhost:8000/ws');
```

**2. Client requests current status**

```http
GET /status HTTP/1.1
```

**Response:**

```json
{
  "timestamp": 1704412800.0,
  "frequency": 151.2500,
  "mode": "SCAN",
  "squelch_open": false,
  "rssi": 0
}
```

**3. Scanner finds active signal (WebSocket push)**

```json
{
  "type": "event",
  "timestamp": 1704412801.5,
  "event": "scan_hit",
  "data": {
    "frequency": 154.6000,
    "channel": 42,
    "alpha_tag": "Fire Dispatch"
  }
}
```

**4. State update (WebSocket push)**

```json
{
  "type": "state_update",
  "timestamp": 1704412801.5,
  "sequence": 12346,
  "data": {
    "frequency": 154.6000,
    "squelch_open": true,
    "rssi": 82,
    "channel": 42
  }
}
```

**5. User clicks Hold button**

```http
POST /commands/hold HTTP/1.1
Content-Type: application/json
```

**Response:**

```json
{
  "status": "ok",
  "mode": "HOLD"
}
```

**6. State update confirms hold (WebSocket push)**

```json
{
  "type": "state_update",
  "timestamp": 1704412802.0,
  "sequence": 12347,
  "data": {
    "mode": "HOLD"
  }
}
```

**7. User enters new frequency**

```http
POST /frequency HTTP/1.1
Content-Type: application/json

{
  "frequency": 162.5500,
  "modulation": "NFM"
}
```

**Response:**

```json
{
  "status": "ok",
  "frequency": 162.5500,
  "modulation": "NFM"
}
```

**8. State update confirms tune (WebSocket push)**

```json
{
  "type": "state_update",
  "timestamp": 1704412803.0,
  "sequence": 12348,
  "data": {
    "frequency": 162.5500,
    "modulation": "NFM",
    "mode": "DIRECT"
  }
}
```

---

### 8.2 Memory Sync with Progress

**1. Client starts sync**

```http
POST /memory/sync HTTP/1.1
```

**Response:**

```json
{
  "status": "started",
  "task_id": "sync-abc123",
  "estimated_duration": 60.0
}
```

**2. Progress updates (WebSocket push, multiple messages)**

```json
{
  "type": "progress",
  "task_id": "sync-abc123",
  "percent": 10,
  "current": 50,
  "total": 500,
  "message": "Syncing channel 50/500"
}
```

```json
{
  "type": "progress",
  "task_id": "sync-abc123",
  "percent": 50,
  "current": 250,
  "total": 500,
  "message": "Syncing channel 250/500"
}
```

**3. Completion (WebSocket push)**

```json
{
  "type": "complete",
  "task_id": "sync-abc123",
  "status": "success",
  "duration": 58.3,
  "result": {
    "channels_synced": 500,
    "errors": 0
  }
}
```

**4. Client refreshes channel list**

```http
GET /memory/channels HTTP/1.1
```

**Response:** Full channel list with updated shadow state

---

## 9. Testing & Validation

### 9.1 OpenAPI Specification

Full OpenAPI 3.0 spec generated from backend (FastAPI auto-generation).

**Location:** `/openapi.json`

**Tools:**
- Swagger UI: `http://localhost:8000/docs`
- ReDoc: `http://localhost:8000/redoc`

### 9.2 Contract Testing

Use OpenAPI spec to generate:
- Mock server for frontend development
- Client SDKs (TypeScript, Python, etc.)
- Integration tests

**Recommended Tools:**
- Prism (mock server)
- openapi-typescript (TypeScript types)
- Postman collections

---

## 10. Changelog

### Version 1.1.0 (Current)

- CSV export/import endpoints (`/memory/export/csv`, `/memory/import/csv`)
- Activity log endpoint (`/analytics/activity-log`) with filtering and pagination
- Preferences API (`/preferences`, `/preferences/{key}`) with reset support
- Recording support (Tauri desktop app only)

### Version 1.0.0 (Initial Release)

- REST API for control and queries
- WebSocket API for real-time telemetry
- LiveState and ChannelData models
- Memory sync with progress tracking
- Health check endpoint
- Error response standardization

---

## 11. Future API Additions (Roadmap)

### Version 1.2.0 (Planned)

- Authentication (API keys, JWT)
- Rate limiting
- Bulk channel updates (POST /memory/channels)
- Audio stream endpoint (GET /audio/stream)
- WebSocket subscriptions (client filters message types)

### Version 2.0.0 (Future)

- Multi-scanner support (scanner ID in path)
- User accounts and preferences
- Webhooks for events
- GraphQL API (optional alternative to REST)
