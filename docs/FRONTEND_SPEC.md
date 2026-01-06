# Scanner Bridge Frontend Specification

**Version:** 1.0.0
**Target:** Cross-platform web UI (browser-based)
**Purpose:** Stateless client for Scanner Bridge API

---

## 1. System Overview

The frontend is a single-page web application that connects to the Scanner Bridge backend via REST and WebSocket APIs. It contains no scanner logic, never communicates with hardware directly, and is fully replaceable.

### 1.1 Core Principles

- **Stateless UI:** Backend owns all state
- **API-First:** All scanner interaction via network calls
- **Zero Scanner Knowledge:** No serial protocol awareness
- **Device-Agnostic:** No hardcoded model-specific assumptions
- **Cross-Platform:** Runs in any modern browser
- **Hot-Reloadable:** Developer-friendly iteration
- **Replaceable:** Multiple UIs can coexist

### 1.2 Device-Agnostic Design

The UI must work with any scanner model without hardcoded assumptions:

**Never Hardcode:**
- Frequency ranges (get from device capabilities via API)
- Number of banks (query from device)
- Number of channels per bank (query from device)
- Available modulation modes (get from device)
- Model-specific features or UI elements

**Always Use Device API:**
- Model name: Display from `deviceInfo.model`
- Capabilities: Query device limits and features
- Available commands: Adapt UI based on device capabilities
- Frequency validation: Use device's min/max ranges

**Example - Good:**
```typescript
// Get frequency range from device capabilities
const deviceCapabilities = await api.getDeviceCapabilities();
const freqMin = deviceCapabilities.frequency_range.min;
const freqMax = deviceCapabilities.frequency_range.max;

// Validate user input against device limits
if (userFreq < freqMin || userFreq > freqMax) {
  showError(`Frequency must be between ${freqMin} and ${freqMax} MHz`);
}
```

**Example - Bad:**
```typescript
// ❌ NEVER do this - hardcoded for BC125AT
if (userFreq < 25 || userFreq > 512) {
  showError('Frequency must be between 25 and 512 MHz');
}
```

**Benefits:**
- Same UI works with BC125AT, SR30C, and future models
- No special cases or model detection logic
- New scanner models "just work"
- Easier testing and maintenance

### 1.3 Supported Platforms

**Desktop Browsers:**
- Chrome/Edge (Chromium) 90+
- Firefox 88+
- Safari 14+ (macOS)

**Mobile Browsers:**
- Safari (iOS 14+)
- Chrome (Android 10+)

**Future Native Wrappers:**
- Electron (macOS, Windows, Linux)
- Tauri (lightweight alternative)
- React Native / Flutter (mobile apps)

### 1.4 UX Philosophy: "Radio First, Computer Second"

The UI should feel like **using a scanner**, not configuring software.

**Core UX Principles:**

1. **Visual Hierarchy:**
   - **Primary (always visible):** What you're listening to NOW (frequency, mode, signal)
   - **Secondary (visible, de-emphasized):** Recent activity, connection status
   - **Progressive (hidden until needed):** Configuration, advanced features

2. **Information Prioritization:**
   ```
   ┌─────────────────────────────────────────┐
   │ FRONTMOST (Always Visible)              │
   │ • Virtual Display:                      │
   │   - Alpha tag (PRIMARY, large)          │
   │   - Metadata row (signal, CH, mode, MHz)│
   │ • Primary action: Scan/Hold toggle      │
   │ • Connection status + signal (header)   │
   ├─────────────────────────────────────────┤
   │ SECONDARY (Visible, Collapsible)        │
   │ • Current Bank Quick View               │
   │   - Channels in active bank             │
   │   - Click to tune                       │
   │   - "Browse All" link                   │
   ├─────────────────────────────────────────┤
   │ PROGRESSIVE DISCLOSURE (Hidden/Modal)   │
   │ • Direct Tune → Button + Modal          │
   │ • Full Memory Browser → Modal/Panel     │
   │ • Activity Log → Modal (optional)       │
   │ • Settings → Modal                      │
   │ • Channel navigation → Keyboard only    │
   └─────────────────────────────────────────┘
   ```

3. **Interaction Model:**
   - **Zero clicks:** See current frequency, mode, signal
   - **One click:** Scan/Hold toggle (most frequent action)
   - **Two clicks:** Direct tune, browse memory
   - **Keyboard preferred:** Channel up/down via arrow keys

4. **Anti-Patterns to Avoid:**
   - ❌ Settings-heavy interface
   - ❌ Busy dashboards with everything visible
   - ❌ Deep navigation hierarchies
   - ❌ Simultaneous display of infrequent features

**Success Metrics:**
- New user can start scanning within 5 seconds
- Current frequency identifiable in 1 glance
- Scan/Hold never scrolled off screen
- Advanced features don't clutter main view

---

## 2. Architecture

```
┌─────────────────────────────────────────────┐
│         Browser / App Shell                 │
└─────────┬───────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│        Application Layer                    │
│  ┌──────────────┐    ┌──────────────────┐  │
│  │ State Store  │◄───│ WebSocket Client │  │
│  │  (Zustand)   │    │  (Auto-Reconnect)│  │
│  └──────┬───────┘    └──────────────────┘  │
└─────────┼─────────────────────────────────── ┘
          │
          ▼
┌─────────────────────────────────────────────┐
│         View Layer (React)                  │
│  ┌──────────────┐  ┌──────────────────────┐│
│  │Virtual Display│  │ Transport Controls  ││
│  └──────────────┘  └──────────────────────┘│
│  ┌──────────────┐  ┌──────────────────────┐│
│  │Activity Log  │  │ Signal Strength     ││
│  └──────────────┘  └──────────────────────┘│
└─────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────┐
│         API Client Layer                    │
│  ┌──────────────┐    ┌──────────────────┐  │
│  │ REST Client  │    │ WebSocket Mgr    │  │
│  └──────────────┘    └──────────────────┘  │
└─────────┬───────────────────┬───────────────┘
          │                   │
          ▼                   ▼
    REST Endpoints      WebSocket Endpoint
         (Backend)           (Backend)
```

---

## 3. Technology Stack

### 3.1 Recommended Stack (Phase 1)

**Framework:** React 18+ with Hooks
**Build Tool:** Vite (fast HMR, optimized builds)
**Language:** TypeScript 5+
**State Management:** Zustand (lightweight) or Redux Toolkit
**Styling:** CSS Modules or Tailwind CSS
**WebSocket:** Native WebSocket API with reconnect wrapper
**HTTP Client:** Fetch API or Axios

### 3.2 Alternative Stacks

**Vue 3:**
- Composition API
- Vite
- Pinia (state management)

**Svelte:**
- SvelteKit
- Built-in reactivity (no external state library)

---

## 4. Data Models

### 4.1 Live State (from Backend)

```typescript
interface LiveState {
  timestamp: number;           // Unix timestamp (seconds)
  frequency: number;           // MHz
  modulation: string;          // "FM" | "AM" | "NFM" | "AUTO"
  squelch_open: boolean;
  rssi: number;                // 0-100
  mode: string;                // "SCAN" | "HOLD" | "DIRECT"
  channel?: number;            // Channel number if applicable
  alpha_tag?: string;          // Alpha tag for current channel
}
```

### 4.2 Channel Data (Shadow State)

```typescript
interface ChannelData {
  index: number;               // 1-500
  frequency: number;           // MHz
  modulation: string;
  alpha_tag: string;           // Up to 16 chars
  delay: number;               // 0-30 seconds
  lockout: boolean;
  priority: boolean;
  tone_squelch?: number;       // CTCSS tone (Hz)
  bank: number;                // 1-10
}
```

### 4.3 Device Info

```typescript
interface DeviceInfo {
  model: string;               // "BC125AT", "SR30C", etc.
  firmware?: string;
  serial_number?: string;
  connection_status: "connected" | "disconnected" | "connecting";
}
```

### 4.4 WebSocket Messages

```typescript
type WSMessage =
  | StateUpdateMessage
  | EventMessage
  | ProgressMessage
  | ErrorMessage;

interface StateUpdateMessage {
  type: "state_update";
  timestamp: number;
  sequence: number;
  data: Partial<LiveState>;    // Only changed fields
}

interface EventMessage {
  type: "event";
  timestamp: number;
  event: "scan_hit" | "hold" | "scan_start";
  data: Record<string, any>;
}

interface ProgressMessage {
  type: "progress";
  task_id: string;
  percent: number;
  message: string;
}

interface ErrorMessage {
  type: "error";
  error: string;
  message: string;
}
```

---

## 5. API Client Layer

### 5.1 REST Client

**Base Configuration:**

```typescript
class ScannerAPIClient {
  private baseURL: string;

  constructor(baseURL: string = "http://localhost:8000/api/v1") {
    this.baseURL = baseURL;
  }

  private async request<T>(
    endpoint: string,
    options?: RequestInit
  ): Promise<T> {
    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options?.headers,
      },
    });

    if (!response.ok) {
      const error = await response.json();
      throw new APIError(error.message, response.status, error);
    }

    return response.json();
  }

  // Control Commands
  async sendHold(): Promise<void> {
    await this.request("/commands/hold", { method: "POST" });
  }

  async sendScan(): Promise<void> {
    await this.request("/commands/scan", { method: "POST" });
  }

  async sendKey(key: string): Promise<void> {
    await this.request("/commands/key", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
  }

  async setFrequency(frequency: number, modulation: string = "AUTO"): Promise<void> {
    await this.request("/frequency", {
      method: "POST",
      body: JSON.stringify({ frequency, modulation }),
    });
  }

  // Query
  async getStatus(): Promise<LiveState> {
    return this.request<LiveState>("/status");
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    return this.request<DeviceInfo>("/device/info");
  }

  async getChannels(bank?: number): Promise<ChannelData[]> {
    const query = bank ? `?bank=${bank}` : "";
    return this.request<ChannelData[]>(`/memory/channels${query}`);
  }

  async syncMemory(): Promise<{ task_id: string }> {
    return this.request("/memory/sync", { method: "POST" });
  }
}
```

### 5.2 WebSocket Client

**Connection Management:**

```typescript
class ScannerWebSocket {
  private ws?: WebSocket;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000; // 30s
  private listeners = new Map<string, Set<(data: any) => void>>();

  constructor(private url: string = "ws://localhost:8000/ws") {}

  connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      console.log("WebSocket connected");
      this.reconnectAttempts = 0;
      this.emit("connection", { status: "connected" });
    };

    this.ws.onmessage = (event) => {
      const message = JSON.parse(event.data) as WSMessage;
      this.emit(message.type, message);
    };

    this.ws.onerror = (error) => {
      console.error("WebSocket error:", error);
      this.emit("error", { error });
    };

    this.ws.onclose = () => {
      console.log("WebSocket closed");
      this.emit("connection", { status: "disconnected" });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay
    );
    this.reconnectAttempts++;

    setTimeout(() => this.connect(), delay);
  }

  on(event: string, callback: (data: any) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);

    // Return unsubscribe function
    return () => this.listeners.get(event)?.delete(callback);
  }

  private emit(event: string, data: any): void {
    this.listeners.get(event)?.forEach((callback) => callback(data));
  }

  disconnect(): void {
    this.ws?.close();
  }
}
```

**React Hook:**

```typescript
function useWebSocket(url?: string) {
  const [ws] = useState(() => new ScannerWebSocket(url));
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    ws.on("connection", ({ status }) => {
      setConnected(status === "connected");
    });

    ws.connect();

    return () => ws.disconnect();
  }, [ws]);

  return { ws, connected };
}
```

---

## 6. State Management

### 6.1 Zustand Store

```typescript
interface AppState {
  // Live scanner state
  liveState: LiveState | null;

  // Device info
  deviceInfo: DeviceInfo | null;

  // Shadow state (channels)
  channels: ChannelData[];

  // Connection status
  connected: boolean;

  // Activity log
  activityLog: ActivityLogEntry[];

  // UI preferences
  preferences: {
    theme: "light" | "dark";
  };

  // Actions
  updateLiveState: (state: Partial<LiveState>) => void;
  setDeviceInfo: (info: DeviceInfo) => void;
  setChannels: (channels: ChannelData[]) => void;
  setConnected: (connected: boolean) => void;
  addActivityLogEntry: (entry: ActivityLogEntry) => void;
  clearActivityLog: () => void;
  updatePreferences: (prefs: Partial<AppState["preferences"]>) => void;
}

const useStore = create<AppState>((set) => ({
  liveState: null,
  deviceInfo: null,
  channels: [],
  connected: false,
  activityLog: [],
  preferences: {
    theme: "dark",
  },
  lastSequence: 0, // Track last processed sequence number

  updateLiveState: (state, sequence?: number) =>
    set((prev) => {
      // Prevent out-of-order updates (stale state protection)
      if (sequence !== undefined && sequence <= prev.lastSequence) {
        console.warn(`Ignoring stale update: ${sequence} <= ${prev.lastSequence}`);
        return prev; // Ignore this update
      }

      return {
        liveState: { ...prev.liveState!, ...state },
        lastSequence: sequence ?? prev.lastSequence,
      };
    }),

  setDeviceInfo: (deviceInfo) => set({ deviceInfo }),

  setChannels: (channels) => set({ channels }),

  setConnected: (connected) => set({ connected }),

  addActivityLogEntry: (entry) =>
    set((prev) => ({
      activityLog: [entry, ...prev.activityLog].slice(0, 10), // Keep last 10 only
    })),

  clearActivityLog: () => set({ activityLog: [] }),

  updatePreferences: (prefs) =>
    set((prev) => ({
      preferences: { ...prev.preferences, ...prefs },
    })),
}));
```

### 6.2 WebSocket → State Integration

```typescript
function ScannerStateSync() {
  const { ws, connected } = useWebSocket();
  const store = useStore();

  useEffect(() => {
    const unsubscribe = ws.on("state_update", (message: StateUpdateMessage) => {
      // Pass sequence number to prevent out-of-order updates
      store.updateLiveState(message.data, message.sequence);
    });

    return unsubscribe;
  }, [ws, store]);

  useEffect(() => {
    const unsubscribe = ws.on("event", (message: EventMessage) => {
      if (message.event === "scan_hit") {
        store.addActivityLogEntry({
          timestamp: message.timestamp,
          frequency: message.data.frequency,
          channel: message.data.channel,
          alpha_tag: message.data.alpha_tag,
          type: "hit",
        });
      }
    });

    return unsubscribe;
  }, [ws, store]);

  useEffect(() => {
    store.setConnected(connected);
  }, [connected, store]);

  return null;
}
```

---

## 7. Core Components

### 7.1 Virtual Display

**Purpose:** Mimic scanner LCD display with two distinct states

**Visual Design:**
- Monospace font (Courier New, SF Mono, Consolas)
- High contrast (green-on-black or amber-on-black)
- **Alpha tag as primary display** (large, 3-4x normal text size)
- **Frequency in secondary metadata row** with mode, channel, bank
- Signal strength indicator (Font Awesome mobile bars)

**Display States:**

1. **Scanning State** - Active scan, no channel hit
   - Shows "Scanning..." as primary text
   - Only signal strength visible in metadata row
   - No channel, mode, or frequency displayed

2. **Listening/Hit State** - Stopped on a channel
   - Shows alpha tag as primary text
   - Full metadata row: signal, channel, mode, frequency

**Component:**

```typescript
function VirtualDisplay() {
  const liveState = useStore((s) => s.liveState);
  const channels = useStore((s) => s.channels);
  const deviceInfo = useStore((s) => s.deviceInfo);

  if (!liveState) {
    return <div className="display">NO SIGNAL</div>;
  }

  const channel = liveState.channel
    ? channels.find((c) => c.index === liveState.channel)
    : null;

  const isScanning = liveState.mode === "SCAN" && !channel;

  // SCANNING STATE: Show "Scanning..." with only signal
  if (isScanning) {
    return (
      <div className="virtual-display scanning">
        <div className="primary-text">Scanning...</div>
        <div className="metadata">
          <SignalStrength rssi={liveState.rssi} />
          {/* No channel/mode/frequency while actively scanning */}
        </div>
      </div>
    );
  }

  // LISTENING/HIT STATE: Show full metadata
  const alphaTag = channel?.alpha_tag || "—";
  const frequency = `${liveState.frequency.toFixed(4)} MHz`;

  return (
    <div className="virtual-display">
      {/* Primary: Alpha tag (large) */}
      <div className="primary-text">{alphaTag}</div>

      {/* Secondary metadata row: Signal, Channel, Mode, Frequency */}
      <div className="metadata">
        <SignalStrength rssi={liveState.rssi} />
        <span className="channel">{channel ? `CH${channel.index}` : 'DIRECT'}</span>
        <span className="modulation">{liveState.modulation}</span>
        <span className="frequency">{frequency}</span>
      </div>
    </div>
  );
}
```

**Visual Examples:**

```
SCANNING STATE:
┌────────────────────────┐
│  Scanning...           │ ← Large text
│  [signal icon]         │ ← Only signal visible
└────────────────────────┘

LISTENING STATE:
┌────────────────────────┐
│  Dinmire Police Dept.  │ ← Alpha tag
│  [sig] CH67 NFM 442.12 │ ← Full metadata
└────────────────────────┘
```

**CSS:**

```css
.virtual-display {
  background: #000;
  color: #0f0;
  font-family: 'Courier New', monospace;
  padding: 2rem;
  border: 2px solid #333;
  border-radius: 4px;
}

.primary-text {
  font-size: 3rem;
  font-weight: bold;
  text-align: center;
  margin-bottom: 1rem;
}

/* Scanning state: add subtle animation */
.virtual-display.scanning .primary-text::after {
  content: '';
  animation: dots 1.5s infinite;
}

@keyframes dots {
  0%, 20% { content: ''; }
  40% { content: '.'; }
  60% { content: '..'; }
  80%, 100% { content: '...'; }
}

.metadata {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  font-size: 1rem;
  padding: 0 0.5rem;
}

.metadata .frequency {
  margin-left: auto; /* Push frequency to the right */
}
```

### 7.2 Signal Strength Indicator

**Visual Design:**
- **Font Awesome signal icons** (mobile phone style)
- Icons: `fa-signal-1` through `fa-signal-5` (or `fa-signal-weak`, `fa-signal-fair`, `fa-signal-good`, `fa-signal-strong`)
- RSSI determines which icon to display
- Integrated into metadata row of Virtual Display
- Glanceable, minimal design

**Component:**

```typescript
function SignalStrength({ rssi }: { rssi: number }) {
  // Map RSSI to Font Awesome signal icon
  const getSignalIcon = (value: number) => {
    if (value < 20) return 'fa-signal-weak';      // 1 bar
    if (value < 40) return 'fa-signal-fair';      // 2 bars
    if (value < 60) return 'fa-signal-good';      // 3 bars
    if (value < 80) return 'fa-signal-strong';    // 4 bars
    return 'fa-signal';                            // 5 bars (full)
  };

  const getColor = (value: number) => {
    if (value < 40) return "#f87171"; // Red (weak)
    if (value < 70) return "#fbbf24"; // Yellow (medium)
    return "#4ade80"; // Green (strong)
  };

  const icon = getSignalIcon(rssi);
  const color = getColor(rssi);

  return (
    <i
      className={`fa-solid ${icon}`}
      style={{ color }}
      aria-label={`Signal strength: ${rssi} percent`}
      title={`${rssi}%`}
    />
  );
}
```

**Dependencies:**

```bash
npm install @fortawesome/fontawesome-free
# or use CDN in index.html
```

**CSS (if needed):**

```css
.signal-strength {
  font-size: 1rem;
}
```

### 7.3 Primary Controls

**Purpose:** Always-visible toggle control for the most frequent user action: Scan/Hold.

**Design:**
- **Single toggle button** that switches between SCAN and HOLD states
- Button label and appearance changes based on current mode
- When scanning: shows "Scan" (active state), click to hold
- When holding: shows "Hold" (active state), click to scan

**Design Notes:**
- Large, touch-friendly (min 44x44px)
- Always visible, never scrolled off screen
- Visual indication of current state (active styling)
- State is managed by backend, button reflects current mode

**Component:**

```typescript
function PrimaryControls() {
  const mode = useStore((s) => s.liveState?.mode);
  const api = useAPI();

  const handleToggle = async () => {
    if (mode === "SCAN") {
      await api.sendHold();
    } else {
      await api.sendScan();
    }
  };

  const isScanning = mode === "SCAN";

  return (
    <div className="primary-controls">
      <button
        className={`btn-toggle ${isScanning ? "scanning" : "holding"}`}
        onClick={handleToggle}
        aria-pressed={isScanning}
        aria-label={isScanning ? "Scanning, click to hold" : "Holding, click to scan"}
      >
        {isScanning ? "🔄 Scan" : "⏸ Hold"}
      </button>
    </div>
  );
}
```

**CSS Example:**

```css
.primary-controls {
  display: flex;
  padding: 1rem;
}

.btn-toggle {
  flex: 1;
  padding: 1.5rem;
  font-size: 1.25rem;
  font-weight: bold;
  min-height: 60px;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
  border: 2px solid transparent;
}

.btn-toggle.scanning {
  background: #10b981;
  color: white;
  box-shadow: inset 0 2px 4px rgba(0,0,0,0.2);
}

.btn-toggle.holding {
  background: #f59e0b;
  color: white;
  border-color: #d97706;
}

.btn-toggle:hover {
  opacity: 0.9;
}
```

---

### 7.4 Direct Tune Modal (Progressive Disclosure)

**Purpose:** Allow users to manually enter a frequency to monitor. Hidden by default, accessed via trigger button.

**Trigger:** "Tune Direct..." button or keyboard shortcut (F key)

**Component:**

```typescript
function DirectTuneModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const [frequency, setFrequency] = useState("");
  const [modulation, setModulation] = useState<"FM" | "AM" | "NFM" | "AUTO">("AUTO");
  const deviceInfo = useStore((s) => s.deviceInfo);
  const api = useAPI();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const freq = parseFloat(frequency);

    // Validate frequency range using device capabilities
    // Note: Device capabilities should include frequency_range { min, max }
    const capabilities = await api.getDeviceCapabilities();
    if (freq < capabilities.frequency_range.min || freq > capabilities.frequency_range.max) {
      // Show error notification with device-specific limits
      showError(`Frequency must be between ${capabilities.frequency_range.min} and ${capabilities.frequency_range.max} MHz`);
      return;
    }

    await api.setFrequency(freq, modulation);
    onClose();
    setFrequency(""); // Reset for next use
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h3>Tune Direct</h3>

        <form onSubmit={handleSubmit}>
          <div className="frequency-input">
            <input
              type="text"
              placeholder="151.2500"
              value={frequency}
              onChange={(e) => setFrequency(e.target.value)}
              pattern="[0-9]+\.?[0-9]*"
              autoFocus
            />
            <span className="unit">MHz</span>
          </div>

          <div className="modulation-selector">
            <label>Modulation:</label>
            <div className="button-group">
              {["FM", "AM", "NFM", "AUTO"].map((mod) => (
                <button
                  key={mod}
                  type="button"
                  className={modulation === mod ? "active" : ""}
                  onClick={() => setModulation(mod as any)}
                >
                  {mod}
                </button>
              ))}
            </div>
          </div>

          <div className="modal-actions">
            <button type="submit" className="btn-primary">
              Tune →
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// Usage in main app
function App() {
  const [showTuneModal, setShowTuneModal] = useState(false);

  return (
    <div>
      {/* ... other components ... */}

      <button onClick={() => setShowTuneModal(true)}>
        Tune Direct...
      </button>

      <DirectTuneModal
        isOpen={showTuneModal}
        onClose={() => setShowTuneModal(false)}
      />
    </div>
  );
}
```

**Keyboard Shortcut:**
- `F` key opens the modal with input auto-focused
- `Escape` closes the modal
- `Enter` submits the frequency

---

### 7.5 Memory Browser Panel (Progressive Disclosure)

**Purpose:** View and search channel memory. Separate view or slide-out panel, not part of main scanning interface.

**Trigger:** "Browse Memory" button or tab

**Component:**

```typescript
function MemoryBrowser({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const channels = useStore((s) => s.channels);
  const [bankFilter, setBankFilter] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const api = useAPI();

  const filteredChannels = channels.filter((ch) => {
    const matchesBank = bankFilter === null || ch.bank === bankFilter;
    const matchesSearch =
      searchQuery === "" ||
      ch.alpha_tag.toLowerCase().includes(searchQuery.toLowerCase()) ||
      ch.frequency.toString().includes(searchQuery);
    return matchesBank && matchesSearch;
  });

  const handleTuneToChannel = async (frequency: number) => {
    await api.setFrequency(frequency);
    onClose(); // Close browser after tuning
  };

  if (!isOpen) return null;

  return (
    <div className="panel-overlay">
      <div className="memory-browser-panel">
        <header>
          <h2>Memory Channels</h2>
          <button onClick={onClose}>×</button>
        </header>

        <div className="controls">
          <select
            value={bankFilter ?? ""}
            onChange={(e) => setBankFilter(e.target.value ? Number(e.target.value) : null)}
          >
            <option value="">All Banks</option>
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((bank) => (
              <option key={bank} value={bank}>
                Bank {bank}
              </option>
            ))}
          </select>

          <input
            type="search"
            placeholder="Search by tag or frequency..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <table className="channel-table">
          <thead>
            <tr>
              <th>CH</th>
              <th>Frequency</th>
              <th>Tag</th>
              <th>Bank</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filteredChannels.map((ch) => (
              <tr key={ch.index}>
                <td>{ch.index}</td>
                <td>{ch.frequency.toFixed(4)} MHz</td>
                <td>{ch.alpha_tag || "—"}</td>
                <td>{ch.bank}</td>
                <td>
                  <button onClick={() => handleTuneToChannel(ch.frequency)}>
                    Tune
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

---

### 7.6 Activity Log (Simplified)

**Purpose:** Optional history of recent scan hits. Since this is "kind of interesting" but not critical, it's designed to be collapsible and lightweight.

**Design:**
- Collapsible panel (collapsed by default on mobile)
- Limited to last 10 entries (not 100) for simplicity
- Each entry: timestamp, frequency, alpha tag
- Click to tune to that frequency

**Data Model:**

```typescript
interface ActivityLogEntry {
  id: string;                  // UUID
  timestamp: number;           // Unix timestamp
  frequency: number;
  channel?: number;
  alpha_tag?: string;
  type: "hit" | "hold" | "manual";
}
```

**Component (Simplified):**

```typescript
function ActivityLog() {
  const entries = useStore((s) => s.activityLog).slice(0, 10); // Only show last 10
  const [isCollapsed, setIsCollapsed] = useState(false);
  const api = useAPI();

  const handleTune = async (frequency: number) => {
    await api.setFrequency(frequency);
  };

  const formatTimestamp = (ts: number) => {
    const now = Date.now() / 1000;
    const diff = now - ts;

    if (diff < 60) return "Just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return new Date(ts * 1000).toLocaleTimeString();
  };

  return (
    <div className="activity-log">
      <h3 onClick={() => setIsCollapsed(!isCollapsed)} className="collapsible-header">
        Activity Log ({entries.length})
        <span className="toggle">{isCollapsed ? '▶' : '▼'}</span>
      </h3>
      {!isCollapsed && (
        <div className="entries">
          {entries.length === 0 ? (
            <p className="empty">No recent activity</p>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.id}
                className="entry"
                onClick={() => handleTune(entry.frequency)}
              >
                <span className="time">{formatTimestamp(entry.timestamp)}</span>
                <span className="freq">{entry.frequency.toFixed(4)} MHz</span>
                {entry.alpha_tag && <span className="tag">{entry.alpha_tag}</span>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
```

**Notes:**
- Limited to 10 entries keeps UI simple and performance high
- Collapsible by default on mobile to save screen space
- No virtualization needed with only 10 entries
- Consider this component optional - can be hidden entirely if not useful

---

### 7.7 Current Bank Quick View

**Purpose:** Show channels in the currently active bank. This is more useful than activity log since it shows what's being scanned NOW, not what was scanned in the past.

**Design:**
- **Positioned below primary controls** in single-column layout
- **Collapsible** with toggle button (collapsed by default on mobile)
- Shows channels from the current bank only
- Highlights currently active channel
- Click any channel to tune directly to it
- "Browse All" link opens full memory browser

**Component:**

```typescript
function CurrentBankView() {
  const liveState = useStore((s) => s.liveState);
  const channels = useStore((s) => s.channels);
  const [isExpanded, setIsExpanded] = useState(true); // Expanded by default on desktop
  const api = useAPI();

  // Get current bank from current channel
  const currentChannel = liveState?.channel
    ? channels.find((c) => c.index === liveState.channel)
    : null;

  const currentBank = currentChannel?.bank;

  // Filter channels by current bank
  const bankChannels = currentBank
    ? channels.filter((c) => c.bank === currentBank && !c.lockout)
    : [];

  const handleTuneToChannel = async (frequency: number) => {
    await api.setFrequency(frequency);
  };

  if (!currentBank) {
    return null; // Don't show if not scanning a bank
  }

  return (
    <div className="current-bank-view">
      <button
        className="bank-header"
        onClick={() => setIsExpanded(!isExpanded)}
        aria-expanded={isExpanded}
      >
        <h3>Current Bank (BANK {currentBank})</h3>
        <span className="toggle-icon">{isExpanded ? '▼' : '▶'}</span>
      </button>

      {isExpanded && (
        <div className="channels">
          {bankChannels.length === 0 ? (
            <p className="empty">No channels in this bank</p>
          ) : (
            <>
              {bankChannels.map((channel) => (
                <div
                  key={channel.index}
                  className={`channel ${channel.index === liveState?.channel ? 'active' : ''}`}
                  onClick={() => handleTuneToChannel(channel.frequency)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Channel ${channel.index}: ${channel.frequency.toFixed(4)} MHz, ${channel.alpha_tag || 'no name'}`}
                >
                  <span className="ch-num">{channel.index}</span>
                  <span className="ch-freq">{channel.frequency.toFixed(4)}</span>
                  <span className="ch-tag">{channel.alpha_tag || '—'}</span>
                  {channel.index === liveState?.channel && (
                    <span className="ch-indicator" aria-hidden="true">●</span>
                  )}
                </div>
              ))}
              <button className="browse-all" onClick={() => {/* Open full memory browser */}}>
                Browse All Channels →
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
```

**CSS:**

```css
.current-bank-view {
  margin-top: 1rem;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.bank-header {
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  background: var(--surface-2);
  border: none;
  cursor: pointer;
  font-family: inherit;
}

.bank-header:hover {
  background: var(--surface-3);
}

.bank-header h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.toggle-icon {
  font-size: 0.875rem;
  transition: transform 0.2s;
}

.channels {
  padding: 0.5rem;
  max-height: 400px;
  overflow-y: auto;
}

.channel {
  display: grid;
  grid-template-columns: 3rem 6rem 1fr 1.5rem;
  gap: 0.5rem;
  padding: 0.5rem;
  margin-bottom: 0.25rem;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.channel:hover {
  background: var(--surface-2);
}

.channel.active {
  background: var(--primary);
  color: var(--primary-contrast);
  font-weight: bold;
}

.ch-num {
  font-family: 'Courier New', monospace;
  text-align: right;
  font-size: 0.875rem;
}

.ch-freq {
  font-family: 'Courier New', monospace;
  font-size: 0.875rem;
}

.ch-tag {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
}

.ch-indicator {
  color: var(--success);
  font-size: 1rem;
}

.browse-all {
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.5rem;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.875rem;
  color: var(--text-muted);
}

.browse-all:hover {
  background: var(--surface-2);
  color: var(--text);
}
```

**Notes:**
- Replaces activity log as primary secondary view
- Shows what you're actively scanning, not past history
- More useful for understanding current scan behavior
- Active channel clearly marked
- Quick access to jump to any channel in current bank

---

---

## 8. Layout & Responsive Design

### 8.1 Single-Column Layout (Mobile-First, Desktop-Centered)

**Design Philosophy:**
- **Single-column** stacked layout on all screen sizes
- **Centered** on larger viewports with max-width constraint
- **Mobile-first:** Design works perfectly on mobile, scales up gracefully
- **Content-driven max-width:** Based on information being displayed (640-800px)

**Visual Hierarchy:**
1. **Header:** Connection status, signal strength (Font Awesome icons)
2. **Virtual Display:** Alpha tag (large) + metadata row (signal, channel, mode, frequency)
3. **Primary Control:** Single Scan/Hold toggle button
4. **Progressive:** Tune Direct button (smaller/secondary)
5. **Current Bank View:** Collapsible list of channels in active bank
6. **Hidden:** Activity Log, Settings, Full Memory Browser (modals/panels)

**Layout Diagram:**

```
┌──────────────────────────────────────────┐
│ ● BC125AT Connected    [FA Signal Icon] │ ← Header
├──────────────────────────────────────────┤
│                                          │
│         Dinmire Police Dept.            │ ← Virtual Display
│                                          │   Alpha Tag (PRIMARY)
│ ▮▮▮  CH67  NFM        442.1250 MHz     │   Metadata Row
│                                          │
├──────────────────────────────────────────┤
│                                          │
│         [🔄 Scan / ⏸ Hold]              │ ← Single Toggle Button
│                                          │
│         [Tune Direct]                    │ ← Progressive
├──────────────────────────────────────────┤
│ Current Bank (BANK 2)              [▼]  │ ← Collapsible
│ ────────────────────────────────────────│   Bank View
│  67  442.1250  Dinmire PD            ● │
│  68  442.1500  Fire Dept               │
│  69  442.2000  EMS                     │
│         [Browse All Channels →]         │
└──────────────────────────────────────────┘

        Max-width: 640px (or 800px)
        Centered on larger viewports
```

**Container CSS:**

```css
.scanner-ui {
  width: 100%;
  max-width: 640px; /* Content-driven width */
  margin: 0 auto;   /* Centered on desktop */
  padding: 1rem;

  /* Optional: Add subtle container */
  background: var(--background);
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

/* Full-width on mobile */
@media (max-width: 768px) {
  .scanner-ui {
    padding: 0.5rem;
    border-radius: 0;
    box-shadow: none;
  }
}
```

**Notes:**
- Single-column layout works on all screen sizes
- Centered with max-width on desktop (640px recommended, 800px alternative)
- Signal strength uses Font Awesome icons (mobile-style bars)
- Model name in header from device API
- Single Scan/Hold toggle button (state changes on click)
- Current Bank View positioned below controls, collapsible
- Activity Log hidden/deprioritized (modal or separate view)
- All elements stack vertically, natural mobile-first flow

---

### 8.2 Mobile-Specific Considerations

**The single-column layout is already mobile-first**, but consider these mobile-specific optimizations:

**Responsive CSS:**

```css
/* Mobile: Collapse bank view by default, adjust spacing */
@media (max-width: 768px) {
  .scanner-ui {
    padding: 0.5rem;
  }

  .virtual-display {
    padding: 1.5rem 1rem;
  }

  .primary-text {
    font-size: 2.5rem; /* Slightly smaller alpha tag */
  }

  .metadata {
    gap: 0.5rem;
    font-size: 0.875rem;
  }

  .btn-toggle {
    min-height: 60px; /* Touch-friendly */
    font-size: 1.125rem;
  }

  /* Start collapsed on mobile to save space */
  .current-bank-view {
    /* Or use JS to detect screen size and set initial state */
  }
}
```

**Mobile Notes:**
- Same single-column layout as desktop
- Bank view starts collapsed on mobile (saves space)
- Touch targets minimum 44x44px (scan/hold button)
- Font Awesome signal icons shown in header
- Optional hamburger menu for rarely-used features
- Swipe gestures possible for channel navigation (optional enhancement)

**iOS Safe Area Handling:**

iOS devices (especially iPhone X+ with notches) require safe area insets:

```css
/* Viewport meta tag in index.html */
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">

/* CSS with safe area insets */
.app-container {
  padding-top: env(safe-area-inset-top);
  padding-bottom: env(safe-area-inset-bottom);
  padding-left: env(safe-area-inset-left);
  padding-right: env(safe-area-inset-right);
}

/* Sticky header with safe area */
header {
  position: sticky;
  top: 0;
  padding-top: max(1rem, env(safe-area-inset-top));
}

/* Bottom controls with safe area */
.primary-controls {
  padding-bottom: max(1rem, env(safe-area-inset-bottom));
}
```

**Landscape Layout:**

On mobile landscape, switch to compact horizontal layout:

```css
@media (orientation: landscape) and (max-height: 500px) {
  .app-container {
    display: flex;
    flex-direction: row;
  }

  .virtual-display {
    flex: 0 0 40%; /* Take 40% width instead of full width */
    font-size: 1.5rem; /* Reduce font size to fit */
  }

  .primary-controls {
    flex: 0 0 30%;
    flex-direction: column; /* Stack vertically */
  }

  .activity-log {
    flex: 0 0 30%;
    max-height: 100vh;
    overflow-y: auto;
  }
}
```

---

### 8.3 Progressive Disclosure Overlays

**Modal Example (Direct Tune):**
```
┌─────────────────────────────────────────────┐
│                                             │
│  [ Main UI dimmed/blurred ]                 │
│                                             │
│      ┌─────────────────────────┐            │
│      │ Tune Direct          × │            │
│      ├─────────────────────────┤            │
│      │ [151.2500____] MHz     │            │
│      │                         │            │
│      │ Modulation:             │            │
│      │ [FM] [AM] [NFM] [AUTO] │            │
│      │                         │            │
│      │ [Cancel]  [Tune →]     │            │
│      └─────────────────────────┘            │
│                                             │
└─────────────────────────────────────────────┘
```

**Panel Example (Memory Browser):**
```
┌─────────────────────────────────────────────┐
│ Main UI (pushed left)  │ Memory Browser  × │
│                        ├───────────────────┤
│  [Virtual Display]     │ Bank: [All ▼]     │
│                        │ Search: [____]     │
│  [Controls]            ├───────────────────┤
│                        │ CH  Freq    Tag   │
│                        ├───────────────────┤
│                        │ 1   151.25  Police│
│                        │ 2   154.60  Fire  │
│                        │ ... (scrolls)     │
│                        │                   │
└────────────────────────┴───────────────────┘
```

---

### 8.4 PWA Configuration (Progressive Web App)

**Purpose:** Allow users to install the scanner UI as a standalone app on mobile devices and desktops.

**Benefits:**
- Offline capability (cache static assets)
- Add to home screen (iOS, Android)
- Standalone window (no browser chrome)
- Background sync (future enhancement)

**manifest.json:**

```json
{
  "name": "Scanner Bridge",
  "short_name": "Scanner",
  "description": "Control your Uniden scanner from anywhere",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#000000",
  "theme_color": "#10b981",
  "orientation": "portrait-primary",
  "icons": [
    {
      "src": "/icons/icon-192.png",
      "sizes": "192x192",
      "type": "image/png",
      "purpose": "any maskable"
    },
    {
      "src": "/icons/icon-512.png",
      "sizes": "512x512",
      "type": "image/png",
      "purpose": "any maskable"
    }
  ],
  "categories": ["utilities", "productivity"],
  "screenshots": [
    {
      "src": "/screenshots/desktop.png",
      "sizes": "1280x720",
      "type": "image/png",
      "form_factor": "wide"
    },
    {
      "src": "/screenshots/mobile.png",
      "sizes": "750x1334",
      "type": "image/png",
      "form_factor": "narrow"
    }
  ]
}
```

**Service Worker (Basic Cache Strategy):**

```typescript
// service-worker.ts
const CACHE_NAME = 'scanner-bridge-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/assets/main.js',
  '/assets/main.css',
];

self.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('fetch', (event: FetchEvent) => {
  // Network-first strategy for API calls
  if (event.request.url.includes('/api/')) {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first strategy for static assets
  event.respondWith(
    caches.match(event.request).then((response) => {
      return response || fetch(event.request);
    })
  );
});
```

**Registration in main.ts:**

```typescript
// main.tsx
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/service-worker.js')
      .then((registration) => {
        console.log('SW registered:', registration);
      })
      .catch((error) => {
        console.error('SW registration failed:', error);
      });
  });
}
```

**iOS-Specific Meta Tags (index.html):**

```html
<!-- PWA support for iOS -->
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Scanner">
```

**Battery-Aware Behavior:**

```typescript
// Reduce WebSocket poll rate when battery is low
function useBatteryAwarePolling() {
  const [batteryLevel, setBatteryLevel] = useState(1.0);

  useEffect(() => {
    if ('getBattery' in navigator) {
      (navigator as any).getBattery().then((battery: any) => {
        setBatteryLevel(battery.level);
        battery.addEventListener('levelchange', () => {
          setBatteryLevel(battery.level);
        });
      });
    }
  }, []);

  // Reduce polling rate if battery < 20%
  const pollInterval = batteryLevel < 0.2 ? 1000 : 200; // 1s vs 200ms
  return { pollInterval, batteryLevel };
}
```

---

## 9. Build & Deployment

### 9.1 Development

```bash
npm install
npm run dev  # Vite dev server with HMR
```

**Environment Variables (`.env.development`):**

```
VITE_API_BASE_URL=http://localhost:8000/api/v1
VITE_WS_URL=ws://localhost:8000/ws
```

### 9.2 Production Build

```bash
npm run build  # Output to dist/
```

**Output:**
- `dist/index.html`
- `dist/assets/*.js` (minified, tree-shaken)
- `dist/assets/*.css`

**Deployment Options:**

1. **Backend Serves Frontend:** Copy `dist/` to backend static files directory
2. **Separate Static Server:** nginx, Caddy, Vercel, Netlify
3. **Electron/Tauri:** Bundle in native wrapper

---

## 10. Error Handling & UX

### 10.1 Connection States

**Visual Indicators:**
- **Connected:** Green dot in header
- **Disconnected:** Red dot + banner notification
- **Connecting:** Yellow dot + "Reconnecting..." message

**Behavior:**
- Disable controls when disconnected
- Show last-known state with "stale" indicator
- Auto-reconnect with exponential backoff

### 10.2 Error Notifications

**Toast/Snackbar System:**

```typescript
interface Notification {
  id: string;
  type: "success" | "error" | "info" | "warning";
  message: string;
  duration?: number;  // Auto-dismiss after N ms
}

function useNotifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  const addNotification = (notif: Omit<Notification, "id">) => {
    const id = crypto.randomUUID();
    setNotifications((prev) => [...prev, { id, ...notif }]);

    if (notif.duration) {
      setTimeout(() => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
      }, notif.duration);
    }
  };

  return { notifications, addNotification };
}
```

**Usage:**

```typescript
try {
  await api.setFrequency(freq);
  addNotification({
    type: "success",
    message: `Tuned to ${freq} MHz`,
    duration: 3000,
  });
} catch (error) {
  addNotification({
    type: "error",
    message: `Failed to tune: ${error.message}`,
    duration: 5000,
  });
}
```

---

## 11. Testing

### 11.1 Unit Tests (Vitest)

- Component rendering (Virtual Display, Controls)
- State management (Zustand store actions)
- Utility functions (formatters, validators)

### 11.2 Integration Tests

- WebSocket message handling
- API client error scenarios
- State synchronization

### 11.3 End-to-End Tests (Playwright)

- Full user flow: connect → scan → hold → tune
- Multi-tab concurrency
- Reconnection after backend restart

### 11.4 Mock Backend

Standalone mock server for UI-only development:

```typescript
// mock-server.ts
const wss = new WebSocketServer({ port: 8000 });

wss.on("connection", (ws) => {
  // Simulate state updates every 200ms
  const interval = setInterval(() => {
    ws.send(JSON.stringify({
      type: "state_update",
      timestamp: Date.now() / 1000,
      sequence: Math.floor(Math.random() * 10000),
      data: {
        frequency: 151.25 + Math.random() * 10,
        rssi: Math.floor(Math.random() * 100),
        squelch_open: Math.random() > 0.5,
      },
    }));
  }, 200);

  ws.on("close", () => clearInterval(interval));
});
```

---

## 12. Performance Targets

- **Initial Load:** < 2s (on 3G)
- **Time to Interactive:** < 3s
- **Bundle Size:** < 500KB (gzipped)
- **WebSocket Latency:** < 50ms from backend message to UI update
- **Frame Rate:** 60fps during animations
- **Memory Usage:** < 100MB (after 1 hour)

---

## 13. Accessibility

### 13.1 Screen Reader Support

**ARIA Live Regions for Real-Time Updates:**

Screen reader users need to be informed of scanner state changes without manual navigation. Use ARIA live regions:

```typescript
function VirtualDisplay() {
  const liveState = useStore((s) => s.liveState);
  const displayMode = useStore((s) => s.preferences.displayMode);

  return (
    <div className="virtual-display">
      {/* Polite announcements for frequency changes */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {liveState && `Tuned to ${liveState.frequency.toFixed(4)} megahertz, ${liveState.modulation} mode`}
      </div>

      {/* Assertive announcements for scan hits (interrupt) */}
      <div
        aria-live="assertive"
        aria-atomic="true"
        className="sr-only"
      >
        {liveState?.squelch_open && `Squelch open, receiving signal`}
      </div>

      {/* Visual display */}
      <div className="primary-text" aria-hidden="true">
        {liveState?.frequency.toFixed(4)} MHz
      </div>
      {/* ... */}
    </div>
  );
}
```

**CSS for Screen Reader Only Text:**

```css
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}
```

**Activity Log Announcements:**

```typescript
function ActivityLog() {
  const entries = useStore((s) => s.activityLog);
  const latestEntry = entries[0];

  return (
    <div className="activity-log">
      {/* Announce new hits */}
      <div aria-live="polite" aria-atomic="false" className="sr-only">
        {latestEntry && `New activity: ${latestEntry.frequency.toFixed(4)} megahertz, ${latestEntry.alpha_tag || 'unknown station'}`}
      </div>

      <h3>Activity Log</h3>
      <div className="entries" role="log" aria-label="Scanner activity history">
        {entries.map((entry) => (
          <div key={entry.id} className="entry" role="article">
            {/* ... */}
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

### 13.2 Focus Management

**Modal Focus Trapping:**

Prevent focus from leaving modals while open:

```typescript
function DirectTuneModal({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const modalRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    // Store currently focused element
    previousFocusRef.current = document.activeElement as HTMLElement;

    // Focus first input in modal
    const firstInput = modalRef.current?.querySelector('input');
    firstInput?.focus();

    // Trap focus within modal
    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;

      const focusableElements = modalRef.current?.querySelectorAll(
        'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])'
      );
      if (!focusableElements || focusableElements.length === 0) return;

      const firstElement = focusableElements[0] as HTMLElement;
      const lastElement = focusableElements[focusableElements.length - 1] as HTMLElement;

      if (e.shiftKey && document.activeElement === firstElement) {
        e.preventDefault();
        lastElement.focus();
      } else if (!e.shiftKey && document.activeElement === lastElement) {
        e.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleTab);

    return () => {
      document.removeEventListener('keydown', handleTab);
      // Restore focus when modal closes
      previousFocusRef.current?.focus();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="modal-title"
    >
      <div
        ref={modalRef}
        className="modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="modal-title">Tune Direct</h3>
        {/* ... */}
      </div>
    </div>
  );
}
```

**Skip Links:**

Allow keyboard users to skip repetitive content:

```typescript
function App() {
  return (
    <div className="app">
      <a href="#main-content" className="skip-link">
        Skip to main content
      </a>
      <a href="#controls" className="skip-link">
        Skip to controls
      </a>

      <header>{/* ... */}</header>

      <main id="main-content">
        <VirtualDisplay />
      </main>

      <div id="controls">
        <PrimaryControls />
      </div>
    </div>
  );
}
```

```css
.skip-link {
  position: absolute;
  top: -40px;
  left: 0;
  background: var(--primary);
  color: white;
  padding: 0.5rem 1rem;
  z-index: 100;
}

.skip-link:focus {
  top: 0;
}
```

---

### 13.3 Keyboard Navigation

**Global Keyboard Shortcuts with Modifiers:**

To avoid conflicts with assistive technology, require modifier keys:

```typescript
function useKeyboardShortcuts() {
  const api = useAPI();

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Require Ctrl (Windows/Linux) or Cmd (Mac) modifier
      const modifierPressed = e.ctrlKey || e.metaKey;

      if (!modifierPressed) return; // Ignore unmodified keys

      switch (e.key.toLowerCase()) {
        case 's':
          e.preventDefault();
          api.sendScan();
          break;
        case 'h':
          e.preventDefault();
          api.sendHold();
          break;
        case 'f':
          e.preventDefault();
          // Open direct tune modal
          break;
        case 'm':
          e.preventDefault();
          // Open full memory browser
          break;
        case 'b':
          e.preventDefault();
          // Jump to current bank view
          break;
        case 'c':
          e.preventDefault();
          // Copy current frequency to clipboard
          const liveState = useStore.getState().liveState;
          if (liveState) {
            navigator.clipboard.writeText(liveState.frequency.toString());
          }
          break;
        case 'arrowup':
          e.preventDefault();
          api.sendKey('UP'); // Channel up
          break;
        case 'arrowdown':
          e.preventDefault();
          api.sendKey('DOWN'); // Channel down
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [api]);
}
```

**Keyboard Shortcut Help Panel:**

```typescript
function KeyboardShortcutsHelp() {
  return (
    <div className="shortcuts-help" role="region" aria-label="Keyboard shortcuts">
      <h3>Keyboard Shortcuts</h3>
      <dl>
        <dt><kbd>Ctrl/Cmd</kbd> + <kbd>S</kbd></dt>
        <dd>Start scanning</dd>

        <dt><kbd>Ctrl/Cmd</kbd> + <kbd>H</kbd></dt>
        <dd>Hold current frequency</dd>

        <dt><kbd>Ctrl/Cmd</kbd> + <kbd>F</kbd></dt>
        <dd>Tune to specific frequency</dd>

        <dt><kbd>Ctrl/Cmd</kbd> + <kbd>M</kbd></dt>
        <dd>Browse all memory channels</dd>

        <dt><kbd>Ctrl/Cmd</kbd> + <kbd>B</kbd></dt>
        <dd>Jump to current bank view</dd>

        <dt><kbd>Ctrl/Cmd</kbd> + <kbd>C</kbd></dt>
        <dd>Copy current frequency to clipboard</dd>

        <dt><kbd>Ctrl/Cmd</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd></dt>
        <dd>Navigate channels</dd>

        <dt><kbd>Escape</kbd></dt>
        <dd>Close modals and panels</dd>
      </dl>
    </div>
  );
}
```

---

### 13.4 ARIA Labels and Semantic HTML

**Proper Labeling:**

```typescript
function PrimaryControls() {
  const mode = useStore((s) => s.liveState?.mode);

  return (
    <div className="primary-controls" role="group" aria-label="Scanner controls">
      <button
        aria-label="Start scanning mode"
        aria-pressed={mode === "SCAN"}
        onClick={handleScan}
      >
        🔄 SCAN
      </button>

      <button
        aria-label="Hold current frequency"
        aria-pressed={mode === "HOLD"}
        onClick={handleHold}
      >
        ⏸ HOLD
      </button>
    </div>
  );
}
```

**Status Indicators:**

```typescript
function ConnectionStatus() {
  const connected = useStore((s) => s.connected);

  return (
    <div
      className="connection-status"
      role="status"
      aria-live="polite"
      aria-label={connected ? "Connected to scanner" : "Disconnected from scanner"}
    >
      <span className={`indicator ${connected ? 'connected' : 'disconnected'}`} aria-hidden="true">
        {connected ? '●' : '○'}
      </span>
      <span>{connected ? 'Connected' : 'Disconnected'}</span>
    </div>
  );
}
```

---

### 13.5 High Contrast and Visual Accessibility

**Respect User Preferences:**

```css
/* High contrast mode support */
@media (prefers-contrast: high) {
  .virtual-display {
    border: 3px solid currentColor;
  }

  button {
    border: 2px solid currentColor;
  }

  .signal-strength .fill {
    outline: 2px solid black;
  }
}

/* Reduced motion support */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }

  .blink {
    animation: none;
    opacity: 1;
  }
}

/* Dark mode support */
@media (prefers-color-scheme: dark) {
  :root {
    --background: #000;
    --text: #0f0;
    --surface: #1a1a1a;
  }
}
```

---

### 13.6 Testing Checklist

- [ ] **Screen Reader:** Test with NVDA (Windows), JAWS (Windows), VoiceOver (macOS/iOS)
- [ ] **Keyboard Only:** Navigate entire app without mouse
- [ ] **Focus Visible:** All interactive elements show focus indicator
- [ ] **Color Contrast:** WCAG AA minimum (4.5:1 text, 3:1 UI components)
- [ ] **Touch Targets:** Minimum 44x44px for all buttons
- [ ] **ARIA Validation:** Use axe DevTools or WAVE browser extension
- [ ] **Zoom:** Test at 200% zoom without horizontal scroll

---

## 14. Future Enhancements

- **Audio Player:** WebRTC stream or local audio monitoring
- **Spectrum Waterfall:** Visual frequency spectrum display
- **Memory Editor:** Edit channel data via UI
- **Themes:** Light/dark mode, custom color schemes
- **Keyboard Shortcuts:** Configurable hotkeys
- **Mobile PWA:** Install as app, offline support
- **Multi-Scanner:** Tabbed interface for multiple scanners

---

## 15. Deliverables

- [ ] React application source code
- [ ] TypeScript type definitions (from backend OpenAPI schema)
- [ ] Production build (`dist/`)
- [ ] Mock backend for development
- [ ] User guide (with screenshots)
- [ ] Developer guide (local setup, architecture)
- [ ] Storybook (optional, for component documentation)

---

## 17. Current Implementation Notes (Frontend MVP)

The initial React + Vite frontend is implemented under `frontend/` with the core UI and data plumbing in place.

**Implemented Highlights:**
- Vite + React + TypeScript scaffold with Zustand state store and WebSocket client.
- Core UI components: Virtual Display, Primary Controls, Signal Strength, Activity Log, Direct Tune modal, Memory Browser panel.
- Auto memory sync on initial connection to populate alpha tags; progress handled via WebSocket.
- Keyboard shortcuts (Ctrl/Cmd + S/H/F/M/↑/↓, Escape), connection banner, and toast notifications.
- Responsive layout tuned for a premium, touch-first “radio screen” feel.

**Key Entry Points:**
- App shell and WebSocket/state wiring: `frontend/src/App.tsx`
- API client and environment defaults: `frontend/src/api/client.ts`, `frontend/src/api/useApi.ts`
- WebSocket manager: `frontend/src/websocket/ScannerWebSocket.ts`
- Core styles and layout: `frontend/src/App.css`, `frontend/src/index.css`

**Dev Notes:**
- Vite dev proxy routes `/api` and `/ws` to `http://localhost:8000` for local development.
- Default API base: `/api/v1`; WS URL uses same origin with protocol-aware `ws://` / `wss://`.

## 16. Dependencies

**Core:**
- React 18+
- TypeScript 5+
- Vite (build tool)
- Zustand or Redux Toolkit (state)

**UI:**
- CSS Modules or Tailwind CSS
- React Icons (optional)

**Testing:**
- Vitest (unit tests)
- React Testing Library
- Playwright (e2e)

**Development:**
- ESLint + Prettier
- Husky + lint-staged (pre-commit hooks)
