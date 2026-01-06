# Scanner UI Workflow - Technical Guide for Coding Agents

## Simple User Flow (What the user experiences)

- App opens
- Scan begins automatically
  - Display reads "scanning..."
  - Icon is spinner
- When frequency hits, stop and play channel
  - Display reads the frequency/alpha tag
  - Icon is signal strength bars
- When frequency closes, resume scan
  - Back to scan mode display
- The hold button acts as a latch button (toggle)
  - When pressed: stops scanning, holds current frequency, appears active
  - When pressed again: resumes scanning, returns to default state

---

## 🚨 CRITICAL RULES (Read This First)

**For coding agents implementing the UI:**

1. **`squelch_open` is the ONLY source of truth for "hits"**
   - NOT frequency stability, NOT mode changes, NOT timeouts
   - When `squelch_open: false → true`: Scanner detected signal, stopped scanning
   - When `squelch_open: true → false`: Signal ended, scanner resumed scanning

2. **`mode` stays `"SCAN"` during hits**
   - Scanner hardware pauses automatically when squelch opens
   - `mode` only changes to `"HOLD"` when user manually presses hold button
   - During a hit: `mode === "SCAN"` AND `squelch_open === true`

3. **Display Decision Tree:**
   ```
   Is squelch_open === true?
   ├─ YES → Show frequency + alpha tag + signal bars
   └─ NO  → What is mode?
            ├─ "SCAN"   → Show "Scanning..." + spinner
            ├─ "HOLD"   → Show frequency (manually held)
            └─ "DIRECT" → Show frequency (direct tune)
   ```

4. **The Hold Button is a Toggle:**
   - Single button, changes state (active/default)
   - Active state (scanning paused): Shows "Resume Scan" or "Scan" label
   - Default state (scanning): Shows "Hold" label
   - Backend controls actual scanning, button just sends commands

5. **Always Check Sequence Numbers:**
   - WebSocket messages can arrive out of order
   - Ignore updates where `message.sequence <= lastSequence`

6. **Alpha Tags Come from Shadow State:**
   - `liveState.channel` gives you the channel index (e.g., 67)
   - Look up `channels[liveState.channel].alpha_tag` from shadow state
   - Shadow state populated via POST `/api/v1/memory/sync`

---

## Visual State Machine

```
┌─────────────────────────────────────────────────────────────────┐
│  SCAN MODE (mode="SCAN")                                        │
│                                                                  │
│  ┌────────────────────┐   squelch opens   ┌──────────────────┐ │
│  │   Scanning...      │ ─────────────────> │  HIT (Listening) │ │
│  │ squelch_open=false │                    │ squelch_open=true│ │
│  │ Display: spinner   │ <───────────────── │ Display: freq    │ │
│  │ Button: "Hold"     │   squelch closes   │   + alpha tag    │ │
│  └────────────────────┘                    │   + signal bars  │ │
│                                             │ Button: "Hold"   │ │
│                                             └──────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
              ↕ User presses Hold button (toggle)
┌─────────────────────────────────────────────────────────────────┐
│  HOLD MODE (mode="HOLD")                                        │
│  Display: frequency (stable, user has control)                  │
│  Button: "Scan" (active state - scanning paused)               │
└─────────────────────────────────────────────────────────────────┘
              ↕ User presses Scan button (toggle)
         (Back to SCAN MODE above)
```

---

## Quick Start (3 Minutes)

**Goal**: Display live scanner state with scan/hold control

**Setup**:
```typescript
// 1. Connect WebSocket
const ws = new WebSocket('ws://localhost:8000/ws');

// 2. Handle state updates
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'state_update') {
    // Check sequence to prevent stale updates
    if (message.sequence > lastSequence) {
      // Merge partial update into state
      setState({ ...state, ...message.data });
      lastSequence = message.sequence;
    }
  }
};

// 3. Send hold/scan commands
async function toggleScanHold() {
  const endpoint = state.mode === 'SCAN'
    ? '/api/v1/commands/hold'   // Stop scanning
    : '/api/v1/commands/scan';  // Resume scanning
  await fetch(endpoint, { method: 'POST' });
}
```

**Display Logic**:
```typescript
function VirtualDisplay({ liveState, channels }) {
  // Determine what to show
  const isListening = liveState.squelch_open
                   || liveState.mode === 'HOLD'
                   || liveState.mode === 'DIRECT';

  if (!isListening) {
    return <div>Scanning... <Spinner /></div>;
  }

  // Get alpha tag from shadow state
  const channel = channels[liveState.channel];
  const alphaTag = channel?.alpha_tag || liveState.frequency.toFixed(4);

  return (
    <div>
      <div className="primary">{alphaTag}</div>
      <div className="metadata">
        <SignalBars rssi={liveState.rssi} />
        {channel && <span>CH{channel.index}</span>}
        <span>{liveState.modulation}</span>
        <span>{liveState.frequency.toFixed(4)} MHz</span>
      </div>
    </div>
  );
}
```

**Hold Button**:
```typescript
function HoldButton({ mode, onToggle }) {
  const isScanning = mode === 'SCAN';

  return (
    <button
      className={isScanning ? 'default' : 'active'}
      onClick={onToggle}
    >
      {isScanning ? '⏸ Hold' : '▶ Scan'}
    </button>
  );
}
```

**Get Alpha Tags** (run on app start):
```typescript
// Trigger memory sync
await fetch('/api/v1/memory/sync', { method: 'POST' });

// Listen for progress
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === 'progress') {
    updateProgressBar(msg.percent, msg.message);
  }
};

// Shadow state will be in store after sync completes
```

---

## Technical Implementation Details

### USB Device Connection Workflow (Plain English)

This is the actual connection and reconnection flow the backend uses for USB scanners.

**1. Startup: choose a connection path**
- If `device.transport` is `"usb"`: try a USB CDC connection using `usb_vid`, `usb_pid`, and optional `usb_serial`.
- If `device.transport` is `"auto"`: prefer USB CDC first, then fall back to serial discovery.
- If `device.transport` is `"serial"`:
  - If `device.port` is set, use that serial port directly.
  - Otherwise, if `auto_detect` is true, scan serial ports for matching `vid/pid`.
  - If nothing is found, startup fails with "No scanner devices detected" or "No scanner port specified".

**2. When a transport opens successfully**
- Backend starts the command scheduler.
- It sends `MDL` to identify the scanner model.
- It picks the driver (`BC125AT` or `SR30C`) and sets `device_info.connection_status = "connected"`.
- The polling loop starts and WebSocket `state_update` messages begin.

**3. If the USB device is missing or unplugged**
- `device_info.connection_status` flips to `"disconnected"` after repeated failures.
- A `state_stale` event is broadcast when the poller marks live state stale.
- The UI should treat this as "scanner offline" and stop assuming updates will arrive.

**4. USB auto-reconnect loop**
- A background task checks every second.
- If not connected, it sets status to `"connecting"` and tries to reconnect using the configured backoff.
- On success, it recreates the scheduler/driver if needed, re-queries `MDL`, and resumes polling.
- The UI sees normal `state_update` traffic resume and `device_info.connection_status` becomes `"connected"`.

**5. What the UI can query**
- `GET /api/v1/device/info` returns `connection_status` (`connecting`, `connected`, `disconnected`) plus `model`, `vid/pid`, and serial when known.

**UI copy suggestions (connection states)**
- `connecting`: "Connecting to scanner..." (show spinner)
- `connected`: "Scanner connected" (steady indicator)
- `disconnected`: "Scanner not found. Check USB cable." (show USB icon)

**System theme preference**
- UI should follow the OS light/dark preference (`prefers-color-scheme`).
- Default to dark visuals when the system is set to dark; use light palette when the system is set to light.

**USB connection flow diagram**
```
App start
  |
  +-- transport = "usb" ---------------------> Try USB CDC
  |                                             |
  |                                             +-- Success -> Connected -> Start polling
  |                                             |
  |                                             +-- Failure -> Disconnected -> Monitor USB
  |
  +-- transport = "auto" / "serial"
        |
        +-- port set? ------------------------> Open serial port
        |                                         |
        |                                         +-- Success -> Connected -> Start polling
        |                                         |
        |                                         +-- Failure -> Error (port not available)
        |
        +-- auto_detect? -> Scan serial ports -> match vid/pid?
                                |                       |
                                |                       +-- Yes -> Open serial port
                                |                       |
                                |                       +-- No -> Try USB (auto)
                                |
                                +-- No -> Error (no device detected)
```

### Initial App Load

**1. Frontend Initialization**
- User opens browser → React app loads
- WebSocket connects to `/ws` endpoint
- Backend accepts connection, may send initial state snapshot
- UI should show "Starting..." until the first valid `LiveState` arrives
- If a valid `state_update` arrives while `device_info` still says "connecting", treat the device as connected in the UI
- Start memory sync in parallel (`POST /api/v1/memory/sync`) once the device is connected and no channels are loaded so alpha tags are available ASAP

**2. Backend Startup**
- Backend connects to scanner via serial/USB
- Starts continuous polling loop (every 0.1-0.2s)
- Each poll sends `STS` command to scanner hardware
- Parses response into LiveState object

**3. Memory Sync** (Optional but Recommended)
- Frontend: `POST /api/v1/memory/sync`
- Backend enters program mode, reads all channels (60+ seconds)
- Progress updates via WebSocket: `{ type: "progress", percent: X, ... }`
- Channel data stored in shadow state (in-memory + optional DB)
- UI can show frequency-only until sync completes, then switch to alpha tags
- Avoid re-running sync every load unless channels are empty

---

### Core Scanning Loop

#### State 1: SCAN MODE (Actively Scanning)

**What the frontend receives:**
```json
{
  "type": "state_update",
  "sequence": 1704234567123,
  "data": {
    "mode": "SCAN",
    "frequency": 442.1250,      // Changes rapidly
    "squelch_open": false,
    "rssi": 0,
    "channel": 67               // Current channel being checked
  }
}
```

**Frontend Display:**
- Primary text: "Scanning..." (large)
- Metadata: Spinner icon (no frequency shown - changes too fast)

---

#### State 2: SCAN HIT (Signal Detected)

**What triggers this:**
- Backend polling detects: `squelch_open: false → true`
- Scanner hardware AUTOMATICALLY stops on this frequency

**Frontend receives TWO messages:**

1. State update:
```json
{
  "type": "state_update",
  "sequence": 1704234567456,
  "data": {
    "squelch_open": true,      // KEY CHANGE!
    "frequency": 442.1250,     // Now stable
    "rssi": 75,
    "mode": "SCAN"             // Still SCAN, not HOLD!
  }
}
```

2. Event notification:
```json
{
  "type": "event",
  "event": "scan_hit",
  "data": {
    "frequency": 442.1250,
    "channel": 67
  }
}
```

**Frontend Display:**
- Primary text: "Dinmire Police Dept." (alpha tag from `channels[67]`)
- Metadata: [Signal bars] CH67 NFM 442.1250 MHz
- Hold button: Still shows "Hold" (default state)

**Important**: Mode is still `"SCAN"`. The scanner paused automatically (hardware behavior), but the mode didn't change.

---

#### State 3: SIGNAL ENDS (Squelch Closes)

**What triggers this:**
- Signal strength drops below threshold
- Backend polling detects: `squelch_open: true → false`
- Scanner hardware AUTOMATICALLY resumes scanning

**Frontend receives:**
```json
{
  "type": "state_update",
  "data": {
    "squelch_open": false      // Signal ended
  }
}
```

**Frontend Response:**
- Switch back to "Scanning..." display
- Show spinner icon again
- Frequency will start changing rapidly again

**Timing Note**: There may be a "delay" setting on the channel (0-30 seconds). This is a HARDWARE setting that keeps the scanner on the frequency for X seconds after squelch closes. Frontend just observes this - doesn't control it.

---

### User Controls (Manual Hold/Scan)

#### User Presses Hold Button (While Scanning)

**Frontend Action:**
```typescript
// POST to hold endpoint
await fetch('/api/v1/commands/hold', { method: 'POST' });
```

**Backend sends to scanner:**
```
KEY,H,P\r
```

**Frontend receives (next poll):**
```json
{
  "type": "state_update",
  "data": {
    "mode": "HOLD"             // Mode changed!
  }
}
```

**Frontend Display:**
- Shows current frequency (stable)
- Hold button changes to active state, shows "Scan" label
- User now has control - frequency won't change

---

#### User Presses Scan Button (While Holding)

**Frontend Action:**
```typescript
// POST to scan endpoint
await fetch('/api/v1/commands/scan', { method: 'POST' });
```

**Backend sends to scanner:**
```
KEY,S,P\r
```

**Frontend receives:**
```json
{
  "type": "state_update",
  "data": {
    "mode": "SCAN"             // Back to scanning
  }
}
```

**Frontend Display:**
- Button returns to default state, shows "Hold" label
- If squelch_open is false: Shows "Scanning..."
- If squelch_open is true: Shows frequency (hit immediately after resuming)

---

## Common Implementation Pitfalls

| ❌ DON'T | ✅ DO | Why |
|----------|-------|-----|
| Detect hits from frequency stability | Use `squelch_open === true` | Frequency can stabilize briefly during normal scan |
| Assume `mode === "HOLD"` during hit | Check `squelch_open`, not mode | Mode stays "SCAN" when hardware pauses on hit |
| Display frequency during active scan | Only when `squelch_open` or `mode !== "SCAN"` | Frequency changes 5-10x/sec, unreadable |
| Apply all WebSocket updates | Check `message.sequence > lastSequence` | Out-of-order messages can overwrite newer state |
| Use separate Scan/Hold buttons | Single toggle button, change label/state | Matches physical scanner UX |
| Hardcode frequency ranges | Get from device capabilities API | Each scanner model has different limits |

### Example: Wrong vs Right Hit Detection

**❌ WRONG:**
```typescript
// Trying to detect hit from frequency changes
if (newFreq !== oldFreq && stableFor > 1000) {
  showFrequency();  // Unreliable!
}
```

**✅ RIGHT:**
```typescript
// Use squelch_open as source of truth
if (liveState.squelch_open === true) {
  showFrequency();  // Reliable!
}
```

### Example: Wrong vs Right Button Implementation

**❌ WRONG:**
```typescript
// Two separate buttons
<button onClick={scan}>Scan</button>
<button onClick={hold}>Hold</button>
```

**✅ RIGHT:**
```typescript
// Single toggle button
<button
  className={mode === 'SCAN' ? 'default' : 'active'}
  onClick={toggleScanHold}
>
  {mode === 'SCAN' ? 'Hold' : 'Scan'}
</button>
```

---

## WebSocket Message Types

### state_update (Most Common)

Sent whenever scanner state changes:

```json
{
  "type": "state_update",
  "timestamp": 1704234567.123,
  "sequence": 1704234567123,
  "data": {
    "frequency": 442.1250,
    "squelch_open": true,
    "rssi": 75
  }
}
```

**Important**: Only changed fields are sent. Merge into existing state, don't replace.

**Sequence Number**: `timestamp * 1000` in milliseconds. Prevents out-of-order updates.

### event (Special Events)

Sent for important events:

```json
{
  "type": "event",
  "timestamp": 1704234567.123,
  "event": "scan_hit",
  "data": {
    "frequency": 442.1250,
    "channel": 67
  }
}
```

**Events**:
- `scan_hit`: Squelch opened (hit detected)
- `state_stale`: Backend lost connection to scanner

### progress (Long Operations)

Sent during memory sync:

```json
{
  "type": "progress",
  "task_id": "sync-abc123",
  "percent": 45,
  "message": "Reading channel 225 of 500..."
}
```

**Usage**: Update progress bar, show estimated time remaining.

---

## Advanced Concepts

### Why Three Modes + Squelch State?

**Common Confusion:**
> "Why not just have scanning=true/false?"

**Answer**: Because scanning state has TWO independent dimensions:

1. **What the user commanded** (`mode`):
   - `SCAN`: "Please cycle through channels"
   - `HOLD`: "Please stay on current frequency"
   - `DIRECT`: "Please tune to this specific frequency"

2. **What the scanner is actually doing** (`squelch_open`):
   - `false`: No signal, scanner is cycling (if in SCAN mode)
   - `true`: Signal detected, scanner PAUSED (even in SCAN mode)

**Example Scenario**:
```
mode="SCAN", squelch_open=false   → Scanning
mode="SCAN", squelch_open=true    → Hit (paused on signal)
mode="HOLD", squelch_open=false   → Held (no signal)
mode="HOLD", squelch_open=true    → Held (with signal)
```

All four combinations are valid and distinct.

### Why Only Partial Updates in state_update?

**Efficiency**: Most polls show no changes. Sending only changed fields:
- Reduces WebSocket bandwidth (5-10 messages/sec)
- Makes changes obvious (easier to debug)
- Prevents UI thrashing (only re-render what changed)

**Example**:
```json
// Instead of sending full state every 0.2s:
{ "frequency": 442.1250, "rssi": 75, "squelch_open": false, "mode": "SCAN", ... }

// Only send what changed:
{ "rssi": 76 }  // RSSI went from 75 → 76
```

### Why Sequence Numbers Matter

**Problem**: Network delays can cause messages to arrive out of order.

**Scenario**:
```
t=1000: Backend sends { sequence: 1000, frequency: 442.1 }
t=1001: Backend sends { sequence: 1001, frequency: 442.2 }
        Network delays message #2
t=1002: Frontend receives message #1 (442.1)
t=1003: Frontend receives message #2 (442.2) ← correct!
t=1004: Frontend receives message #1 again (442.1) ← stale!
```

**Without sequence check**: UI would show 442.1 (wrong!)

**With sequence check**: Ignore message #1 on second arrival (correct!)

---

## Summary for AI Coding Agents

**The Complete Flow:**

1. App starts → Backend connects to scanner, starts polling 5-10x/sec
2. Frontend connects WebSocket, receives state updates
3. **Scanning**: mode="SCAN", squelch_open=false → Show "Scanning..."
4. **Hit detected**: squelch_open: false → true → Show frequency/alpha tag
5. **Signal ends**: squelch_open: true → false → Back to "Scanning..."
6. **User presses Hold**: mode: "SCAN" → "HOLD" → Button shows "Scan" (active)
7. **User presses Scan**: mode: "HOLD" → "SCAN" → Button shows "Hold" (default)

**Critical State Variables:**
- `mode`: "SCAN" | "HOLD" | "DIRECT" (user's command to scanner)
- `squelch_open`: true | false (what scanner is actually doing)
- `frequency`: Current frequency in MHz (stable during hit/hold)
- `channel`: Channel index (1-500) if in memory, null if direct tune
- `rssi`: Signal strength 0-100

**Display Logic (Copy This):**
```typescript
const isListening = squelch_open || mode === "HOLD" || mode === "DIRECT";

if (isListening) {
  // Show frequency, alpha tag, signal bars
  const alphaTag = channels[liveState.channel]?.alpha_tag;
  display(alphaTag || frequency);
} else {
  // mode === "SCAN" && !squelch_open
  display("Scanning...");
}
```

**Hold Button Logic (Copy This):**
```typescript
<button
  className={mode === 'SCAN' ? 'default' : 'active'}
  onClick={() => {
    const endpoint = mode === 'SCAN' ? '/api/v1/commands/hold' : '/api/v1/commands/scan';
    fetch(endpoint, { method: 'POST' });
  }}
>
  {mode === 'SCAN' ? '⏸ Hold' : '▶ Scan'}
</button>
```

---

## Reference

**Key Files**:
- Backend: `api.py:350-420` (polling loop), `websocket.py` (broadcast logic)
- Frontend: `App.tsx`, `store/useStore.ts`, `components/VirtualDisplay.tsx`

**Documentation**:
- `FRONTEND_SPEC.md` - Complete UI architecture
- `BACKEND_SPEC.md` - API endpoints and configuration

**Remember**: Frontend is purely reactive. It displays current state and sends commands, but never makes decisions about what should happen next. The scanner hardware + backend polling loop own all behavior.
