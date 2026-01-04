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
- **Cross-Platform:** Runs in any modern browser
- **Hot-Reloadable:** Developer-friendly iteration
- **Replaceable:** Multiple UIs can coexist

### 1.2 Supported Platforms

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
  volume: number;              // 0-15
  battery?: number;            // 0-100, undefined if AC-powered
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
    displayMode: "frequency" | "alpha";
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
    displayMode: "frequency",
  },

  updateLiveState: (state) =>
    set((prev) => ({
      liveState: { ...prev.liveState!, ...state },
    })),

  setDeviceInfo: (deviceInfo) => set({ deviceInfo }),

  setChannels: (channels) => set({ channels }),

  setConnected: (connected) => set({ connected }),

  addActivityLogEntry: (entry) =>
    set((prev) => ({
      activityLog: [entry, ...prev.activityLog].slice(0, 100), // Keep last 100
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
      store.updateLiveState(message.data);
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

**Purpose:** Mimic scanner LCD display

**Visual Design:**
- Monospace font (Courier New, SF Mono, Consolas)
- High contrast (green-on-black or amber-on-black)
- Large frequency display (3-4x normal text size)
- Smaller metadata (modulation, channel, bank)

**Component:**

```typescript
function VirtualDisplay() {
  const liveState = useStore((s) => s.liveState);
  const displayMode = useStore((s) => s.preferences.displayMode);
  const channels = useStore((s) => s.channels);

  if (!liveState) {
    return <div className="display">NO SIGNAL</div>;
  }

  const channel = liveState.channel
    ? channels.find((c) => c.index === liveState.channel)
    : null;

  const primaryText =
    displayMode === "alpha" && channel?.alpha_tag
      ? channel.alpha_tag
      : `${liveState.frequency.toFixed(4)} MHz`;

  return (
    <div className="virtual-display">
      <div className="primary-text">{primaryText}</div>
      <div className="metadata">
        <span className="modulation">{liveState.modulation}</span>
        {channel && <span className="channel">CH {channel.index}</span>}
        {channel && <span className="bank">BANK {channel.bank}</span>}
      </div>
      <div className="indicators">
        {liveState.squelch_open && <span className="sql-open">SQL</span>}
        {liveState.mode === "SCAN" && <span className="scanning blink">SCAN</span>}
      </div>
    </div>
  );
}
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
}

.metadata {
  display: flex;
  justify-content: space-around;
  margin-top: 1rem;
  font-size: 1rem;
}

.blink {
  animation: blink 1s infinite;
}

@keyframes blink {
  50% { opacity: 0; }
}
```

### 7.2 Signal Strength Indicator

**Visual Design:**
- S-meter style (horizontal bar)
- Color-coded zones: 0-30% (green), 31-70% (yellow), 71-100% (red)
- Numeric RSSI value overlay

**Component:**

```typescript
function SignalStrength() {
  const rssi = useStore((s) => s.liveState?.rssi ?? 0);

  const getColor = (value: number) => {
    if (value < 30) return "#4ade80";
    if (value < 70) return "#fbbf24";
    return "#f87171";
  };

  return (
    <div className="signal-strength">
      <label>Signal Strength</label>
      <div className="meter">
        <div
          className="fill"
          style={{
            width: `${rssi}%`,
            backgroundColor: getColor(rssi),
          }}
        />
        <span className="value">{rssi}%</span>
      </div>
    </div>
  );
}
```

### 7.3 Transport Controls

**Controls:**
- **Scan** (large primary button)
- **Hold** (secondary button)
- **Channel Up/Down** (arrow buttons or +/- buttons)
- **Direct Frequency Entry** (text input + submit)

**Component:**

```typescript
function TransportControls() {
  const [frequency, setFrequency] = useState("");
  const mode = useStore((s) => s.liveState?.mode);
  const api = useAPI();

  const handleScan = async () => {
    await api.sendScan();
  };

  const handleHold = async () => {
    await api.sendHold();
  };

  const handleChannelUp = async () => {
    await api.sendKey("UP");
  };

  const handleChannelDown = async () => {
    await api.sendKey("DOWN");
  };

  const handleFrequencySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const freq = parseFloat(frequency);
    if (freq >= 25 && freq <= 512) {
      await api.setFrequency(freq);
      setFrequency("");
    }
  };

  return (
    <div className="transport-controls">
      <div className="main-buttons">
        <button
          className="btn-scan"
          onClick={handleScan}
          disabled={mode === "SCAN"}
        >
          SCAN
        </button>
        <button
          className="btn-hold"
          onClick={handleHold}
          disabled={mode === "HOLD"}
        >
          HOLD
        </button>
      </div>

      <div className="channel-buttons">
        <button onClick={handleChannelDown}>▼</button>
        <button onClick={handleChannelUp}>▲</button>
      </div>

      <form onSubmit={handleFrequencySubmit}>
        <input
          type="text"
          placeholder="Frequency (MHz)"
          value={frequency}
          onChange={(e) => setFrequency(e.target.value)}
          pattern="[0-9]+\.?[0-9]*"
        />
        <button type="submit">Tune</button>
      </form>
    </div>
  );
}
```

### 7.4 Activity Log

**Display:**
- Scrollable list (latest at top)
- Each entry: timestamp, frequency, alpha tag, duration
- Click to tune to that frequency

**Data Model:**

```typescript
interface ActivityLogEntry {
  id: string;                  // UUID
  timestamp: number;           // Unix timestamp
  frequency: number;
  channel?: number;
  alpha_tag?: string;
  duration?: number;           // Seconds
  type: "hit" | "hold" | "manual";
}
```

**Component:**

```typescript
function ActivityLog() {
  const entries = useStore((s) => s.activityLog);
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
      <h3>Activity Log</h3>
      <div className="entries">
        {entries.map((entry) => (
          <div
            key={entry.id}
            className="entry"
            onClick={() => handleTune(entry.frequency)}
          >
            <span className="time">{formatTimestamp(entry.timestamp)}</span>
            <span className="freq">{entry.frequency.toFixed(4)} MHz</span>
            {entry.alpha_tag && <span className="tag">{entry.alpha_tag}</span>}
            {entry.duration && <span className="dur">{entry.duration}s</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
```

---

## 8. Layout & Responsive Design

### 8.1 Desktop Layout

```
┌─────────────────────────────────────────────┐
│  Header (Device Info, Connection Status)   │
├─────────────────┬───────────────────────────┤
│                 │                           │
│  Virtual        │   Activity Log            │
│  Display        │                           │
│                 │   (Scrollable)            │
│                 │                           │
├─────────────────┤                           │
│  Signal         │                           │
│  Strength       │                           │
├─────────────────┤                           │
│  Transport      │                           │
│  Controls       │                           │
│                 │                           │
└─────────────────┴───────────────────────────┘
```

### 8.2 Mobile Layout (Stacked)

```
┌─────────────────────────────────┐
│  Header                         │
├─────────────────────────────────┤
│  Virtual Display                │
├─────────────────────────────────┤
│  Signal Strength                │
├─────────────────────────────────┤
│  Transport Controls             │
├─────────────────────────────────┤
│  Activity Log (Collapsible)     │
└─────────────────────────────────┘
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

- Semantic HTML elements
- ARIA labels for controls
- Keyboard navigation (Tab, Enter, Space, Arrow keys)
- Focus management (trap focus in modals)
- Screen reader announcements for state changes
- High contrast mode support

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
