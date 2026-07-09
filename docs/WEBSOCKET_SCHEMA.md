# WebSocket Message Schema

Endpoint: `/ws`

## Client → Server

### Subscribe

```json
{
  "type": "subscribe",
  "topics": ["state", "events", "progress", "errors"]
}
```

## Server → Client

### State Update

```json
{
  "type": "state_update",
  "timestamp": 1704412800.123,
  "sequence": 12345,
  "data": {
    "frequency": 151.2500,
    "modulation": "FM",
    "squelch_open": true,
    "rssi": 75,
    "tone_squelch_kind": "ctcss",
    "tone_squelch": 123.0,
    "tone_dcs_code": null,
    "tone_dcs_label": null
  }
}
```

**Note:** The `tone_squelch_kind`, `tone_squelch`, `tone_dcs_code`, and `tone_dcs_label` fields are only populated while `squelch_open === true` (during a hit); they are omitted or null otherwise.

#### state_update data fields

| Field | Type | Description |
|-------|------|-------------|
| `frequency` | number | Current frequency (MHz) |
| `modulation` | string | Modulation mode |
| `squelch_open` | boolean | True if signal present |
| `rssi` | number | Signal strength |
| `mode` | string | Receiver mode |
| `channel` | number or null | Current channel number |
| `volume` | number | Volume level |
| `battery` | number or null | Battery percentage |
| `tone_squelch_kind` | string | Tone discriminator: "none", "ctcss", "dcs", "search" |
| `tone_squelch` | number or null | CTCSS frequency (Hz) when tone_squelch_kind === "ctcss" |
| `tone_dcs_code` | number or null | DCS code (128-231) when tone_squelch_kind === "dcs" |
| `tone_dcs_label` | string or null | Display label (e.g., "DCS 023") when tone_squelch_kind === "dcs" |

### Event

```json
{
  "type": "event",
  "timestamp": 1704412800.456,
  "event": "scan_hit",
  "data": {
    "frequency": 151.2500,
    "channel": 25
  }
}
```

### Progress

```json
{
  "type": "progress",
  "task_id": "sync-abc123",
  "percent": 45,
  "message": "Syncing channel 225/500"
}
```

### Error

```json
{
  "type": "error",
  "error": "scanner_disconnected",
  "message": "Scanner USB connection lost"
}
```

### Heartbeat

```json
{"type": "ping"}
```

Client must respond within 10 seconds:

```json
{"type": "pong"}
```

## Subscriptions

If no `subscribe` message is sent, the server will deliver all messages. When `topics` are specified, only those message categories are delivered.
