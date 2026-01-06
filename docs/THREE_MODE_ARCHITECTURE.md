# Three-Mode Architecture Plan: Scanner Bridge

## Vision

Organize the Scanner Bridge app into three distinct operational modes:

1. **Scanner Control Mode** (COMPLETE) - Real-time scanning operations
2. **Scanner Config Mode** (NEW) - Device settings and configuration
3. **Scanner Bank Editing Mode** (NEW) - Channel and bank management

---

## Current State

### What We Have
- **App.tsx** (485 lines) - Single-view application with all features inline
- **Modal Pattern** - `DirectTuneModal` and `MemoryBrowserPanel` use `isOpen` boolean prop pattern
- **No Mode Switching** - All functionality rendered in single view
- **Zustand Store** - Global state for scanner data, no UI visibility state
- **10+ Dormant Components** - Built but not integrated (see BACKLOG.md)

### Architecture Foundation
- ✅ Modal/panel pattern established (conditional render with `isOpen` prop)
- ✅ Zustand for global state management
- ✅ Strong TypeScript typing throughout
- ✅ Accessibility-first (ARIA attributes, focus management)
- ✅ WebSocket real-time updates

---

## Backlog Feature Categorization

### Mode 1: Scanner Control Mode ✅ (User says COMPLETE)

**Purpose:** Real-time scanning operations, live status monitoring, quick actions

**Current Features (Implemented):**
- Scan/Hold toggle button
- Live frequency display with "Scanning..." indicator
- Signal strength (RSSI) indicator
- Connection status
- Bank enable/disable toggle buttons (10 banks)

**Missing from Current Implementation:**
- 🆕 **Hit Detail Display** - During squelch_open (hit), show secondary row under alpha tag:
  - Frequency (e.g., "154.2750 MHz")
  - Transmission mode (AM/FM/NFM)
  - Channel number (e.g., "CH 1")
  - Currently only shows alpha tag OR frequency, not both with details

**Backlog Features to Add:**
1. ✅ **Activity Log** (#1) - Recent scan hits modal
   - Shows last 5 hits from persistent storage (not just in-memory)
   - Click to tune to frequency
   - Keyboard shortcut to open
   - Future: Pagination to view older hits, search/filter

2. ✅ **Direct Tune Modal** (#3) - Manual frequency entry
   - Frequency validation
   - Modulation selector
   - Keyboard shortcut (Ctrl+F)

3. ✅ **Volume Indicator** (#10) - Visual volume level
   - Display in header area
   - Data already available in LiveState

4. ✅ **Keyboard Shortcuts** (#5) - Power user controls
   - Ctrl+S: Scan
   - Ctrl+H: Hold
   - Ctrl+F: Direct tune
   - Ctrl+?: Show shortcuts help
   - Up/Down: Channel navigation

5. ✅ **Shortcuts Help Modal** (#7) - Keyboard shortcuts reference
   - Modal overlay
   - Lists all shortcuts
   - Ctrl+? to open

6. ✅ **Enhanced Display Components** (#9) - Better component architecture
   - VirtualDisplay.tsx (more feature-rich than inline version)
   - PrimaryControls.tsx (dedicated Scan/Hold button)
   - ConnectionStatus.tsx (dedicated connection indicator)
   - 🆕 **Add Hit Detail Display** - Secondary data row during hits:
     - Primary line: Alpha tag (large, prominent)
     - Secondary line: "154.2750 MHz · FM · CH 1" (smaller, muted color)
     - Only show secondary line when squelch_open=true or mode=HOLD/DIRECT

**Cross-Mode Features:**
- ✅ **Notification Center** (#6) - Toast notifications for all modes
- ✅ **Additional Data Display** (#15) - Battery level, firmware version (where applicable)
- 🆕 **Persistent Hit Logging** - Save all scan hits to database for later features:
  - Store: timestamp, frequency, alpha_tag, channel, modulation, bank, rssi, duration
  - Backend: SQLite table with indexed timestamps
  - API endpoints: GET /api/v1/hits (paginated, filterable)
  - Enables future features: analytics, pattern detection, replay, export

---

### Mode 2: Scanner Config Mode 🆕 (NEW)

**Purpose:** Device settings, global scanner configuration, diagnostics

**Implementation Approach:**
- Real-time configuration via scanner commands (preferred)
- Fallback: Edit BC125AT_SS file and upload to device
- Display current settings with edit controls
- Immediate apply or batch save

**Device Settings to Expose:**

**Display Settings:**
- Backlight mode (On/Off/Key/Squelch/K+S)
- Contrast level
- Beep level (Auto/Off/0-15)
- Key lock (On/Off)

**Scanning Behavior:**
- Priority mode (Off/On/Plus/DND)
- Weather priority (On/Off)
- Volume level (0-15)
- Squelch level (0-15)

**Search Settings:**
- Service search enable/disable (10 services: Police, Fire, HAM, Marine, Railroad, Civil Air, Military Air, CB, FRS/GMRS/MURS, Racing)
- Custom search ranges (10 ranges with lower/upper frequencies)
- Search delay
- Search code (On/Off)

**Close Call Settings:**
- Close Call mode (Off/Pri/DND)
- Close Call beep (On/Off)
- Close Call light (On/Off)
- Close Call bands enable/disable
- Close Call lockout (On/Off)

**Device Info (Read-Only):**
- Model name (BC125AT, SR30C)
- Firmware version
- Serial port / VID/PID
- Connection status

**Backlog Features:**
1. ✅ **Health Check Endpoint** (#13) - Connection diagnostics
   - Display connection quality
   - Command response times
   - Error rates

2. ✅ **Preferences System** (#8) - UI preferences (separate from device config)
   - Theme selector (dark/light)
   - Display mode (frequency-first vs alpha-first)
   - Reduced motion (accessibility)
   - Persist to localStorage

**Backend Support:**
- ✅ BC125AT_SS exporter already reads all settings (bc125at_ss.py:275-425)
- 🆕 Need: GET /api/v1/config/all - Read all current device settings
- 🆕 Need: POST /api/v1/config/all - Update device settings in bulk
- 🆕 Need: Driver methods for setting commands (BLT, KBP, BSV, PRI, SCO, CLC, SSG, CSG, CSP, WXS, CNT, VOL, SQL)

**UI Components Needed:**
- ConfigModeView.tsx (main view)
- SettingGroup.tsx (collapsible setting sections)
- ToggleSetting.tsx (On/Off switches)
- RangeSetting.tsx (numeric sliders)
- SelectSetting.tsx (dropdown selectors)
- ServiceSearchSettings.tsx (10 service toggles)
- CustomSearchSettings.tsx (10 range editors)
- CloseCallSettings.tsx (Close Call configuration)

---

### Mode 3: Scanner Bank Editing Mode 🆕 (NEW)

**Purpose:** Channel management, memory editing, bank organization

**Implementation Approach:** ✅ **Real-time API (consistent with Config Mode)**
- Single channel edit: PRG → CIN → EPG (~1 second)
- Bulk channel edit: PRG → multiple CINs → EPG (efficient for batch operations)
- Immediate feedback, shadow state stays in sync
- Scanner briefly pauses during program mode, auto-resumes after

**Current Backend Support:**
- ✅ GET /api/v1/memory/channels - Fetch all channels
- ✅ GET /api/v1/memory/channels?bank=N - Filter by bank
- ✅ GET /api/v1/memory/channels/{id} - Individual channel
- ✅ POST /api/v1/memory/sync - Full memory sync
- ✅ DELETE /api/v1/memory/sync - Cancel sync
- ✅ GET/POST /api/v1/banks - Bank enable/disable
- 🆕 Need: PUT /api/v1/memory/channels/{id} - Update single channel (real-time)
- 🆕 Need: PUT /api/v1/memory/channels/bulk - Update multiple channels (efficient batch)
- 🆕 Need: DELETE /api/v1/memory/channels/{id} - Delete channel (clear channel data)

**Backlog Features:**

1. ✅ **Memory Browser Panel** (#2) - Browse all 500 channels
   - Bank filter dropdown (1-10 or "All Banks")
   - Search by alpha tag or frequency
   - Table view: CH, Frequency, Tag, Bank, Lockout, Priority
   - Click to edit channel
   - Tune button per channel

2. ✅ **Current Bank View** (#4) - Channels in active bank
   - Shows only channels in currently scanning bank
   - Quick navigation
   - "Browse All Channels" link to open Memory Browser

3. ✅ **Individual Channel Retrieval** (#12) - Fetch single channel details
   - API method already exists
   - Add frontend client method

4. ✅ **Memory Sync Cancel** (#11) - Cancel long-running sync
   - Backend endpoint exists
   - Add cancel button to progress UI
   - Frontend client method needed

5. 🆕 **Channel Management** (#14) - Full CRUD for channels
   - Edit channel modal with fields:
     - Channel number (1-500)
     - Frequency (25.0-512.0 MHz for BC125AT)
     - Modulation (AM/FM/NFM/AUTO)
     - Alpha tag (16 chars max)
     - Bank assignment (1-10)
     - Lockout status (On/Off)
     - Priority status (On/Off)
     - Delay (0/1/2/3/4 seconds)
     - Tone squelch (CTCSS/DCS codes)
   - Validation and error handling
   - Immediate write to scanner
   - Update shadow state

6. ✅ **Export Scanner Memory** - BC125AT_SS format export
   - Read button to trigger memory sync
   - Export button to download memory as BC125AT_SS file
   - Moved from Control Mode (better fit for bank management)

**UI Components Needed:**
- BankEditorView.tsx (main view)
- MemoryBrowserPanel.tsx ✅ (already exists, integrate)
- CurrentBankView.tsx ✅ (already exists, integrate)
- ChannelEditor.tsx (modal for editing single channel)
- BankManager.tsx (bulk bank operations)
- MemorySyncProgress.tsx (progress indicator with cancel)
- ChannelSearchFilter.tsx (advanced filtering)
- ExportControls.tsx (Read/Export buttons, moved from Control Mode)

**Key Decisions:** ✅
- **Bank enable/disable buttons:** Show in both Control Mode and Bank Editor Mode for easy access

---

## Implementation Architecture

## Approved Architecture: Store-Based Mode Switching ✅

**Add to useStore.ts:**
```typescript
interface AppState {
  // ... existing state ...
  uiMode: "control" | "config" | "bank_editor";
  setUiMode: (mode: "control" | "config" | "bank_editor") => void;

  // Modal visibility states
  showActivityLog: boolean;
  showDirectTune: boolean;
  showShortcutsHelp: boolean;
  showMemoryBrowser: boolean;
  setShowActivityLog: (show: boolean) => void;
  setShowDirectTune: (show: boolean) => void;
  setShowShortcutsHelp: (show: boolean) => void;
  setShowMemoryBrowser: (show: boolean) => void;
}
```

**App.tsx Structure:**
```tsx
function App() {
  const { uiMode, setUiMode } = useStore();

  return (
    <div className="mvp">
      {/* Tab navigation at top */}
      <nav className="mode-navigation">
        <button
          onClick={() => setUiMode("control")}
          className={uiMode === "control" ? "active" : ""}
          aria-selected={uiMode === "control"}
        >
          Control
        </button>
        <button
          onClick={() => setUiMode("config")}
          className={uiMode === "config" ? "active" : ""}
          aria-selected={uiMode === "config"}
        >
          Config
        </button>
        <button
          onClick={() => setUiMode("bank_editor")}
          className={uiMode === "bank_editor" ? "active" : ""}
          aria-selected={uiMode === "bank_editor"}
        >
          Bank Editor
        </button>
      </nav>

      {/* Mode-specific views */}
      {uiMode === "control" && <ControlModeView />}
      {uiMode === "config" && <ConfigModeView />}
      {uiMode === "bank_editor" && <BankEditorView />}

      {/* Cross-mode components */}
      <NotificationCenter />

      {/* Modals (accessible from appropriate modes) */}
      <ActivityLog />
      <DirectTuneModal />
      <ShortcutsHelp />
      <MemoryBrowserPanel />
    </div>
  );
}
```

**Key Features:**
- ✅ Tab-style navigation with visual active state
- ✅ Store-based mode state (persists on re-render)
- ✅ Scanner continues operating in all modes
- ✅ Clean component separation
- ✅ No router dependency needed

---

## File Structure Reorganization

```
frontend/src/
  components/
    # Shared Components
    NotificationCenter.tsx ✅
    ModeNavigation.tsx 🆕

    # Control Mode Components
    ControlModeView.tsx 🆕
    VirtualDisplay.tsx ✅ (move inline display here)
    PrimaryControls.tsx ✅
    SignalStrength.tsx ✅
    ConnectionStatus.tsx ✅
    VolumeIndicator.tsx ✅
    ActivityLog.tsx ✅
    DirectTuneModal.tsx ✅
    ShortcutsHelp.tsx ✅

    # Config Mode Components
    ConfigModeView.tsx 🆕
    SettingGroup.tsx 🆕
    ToggleSetting.tsx 🆕
    RangeSetting.tsx 🆕
    SelectSetting.tsx 🆕
    ServiceSearchSettings.tsx 🆕
    CustomSearchSettings.tsx 🆕
    CloseCallSettings.tsx 🆕
    DeviceInfoPanel.tsx 🆕
    PreferencesPanel.tsx 🆕

    # Bank Editor Mode Components
    BankEditorView.tsx 🆕
    MemoryBrowserPanel.tsx ✅
    CurrentBankView.tsx ✅
    ChannelEditor.tsx 🆕
    BankManager.tsx 🆕
    MemorySyncProgress.tsx 🆕
    ChannelSearchFilter.tsx 🆕
```

---

## Backend API Additions Needed

### Config Mode Endpoints

**Option A: Individual Setting Endpoints**
```
GET  /api/v1/config/backlight
POST /api/v1/config/backlight {"value": "KY"}

GET  /api/v1/config/priority
POST /api/v1/config/priority {"value": "2"}

... (40+ endpoints for all settings)
```

**Option B: Grouped Setting Endpoints**
```
GET  /api/v1/config/display
POST /api/v1/config/display {"backlight": "KY", "contrast": "8"}

GET  /api/v1/config/search
POST /api/v1/config/search {"delay": "2", "code": "1"}
```

**Option C: Bulk Settings Endpoint (RECOMMENDED)**
```
GET  /api/v1/config/all
POST /api/v1/config/all { ...all settings... }
```

**Option D: File-Based (SIMPLEST - No Backend Changes)**
```
1. User clicks "Edit Config"
2. Frontend downloads current BC125AT_SS file via existing endpoint
3. Frontend parses SS file and shows in UI
4. User edits settings in UI
5. Frontend regenerates SS file
6. User downloads SS file
7. User uploads to scanner via official software
```

### Bank Editor Mode Endpoints (Real-Time API ✅)

**Single Channel Update:**
```
PUT /api/v1/memory/channels/{id}
{
  "frequency": 154.275,
  "modulation": "FM",
  "alpha_tag": "Police",
  "bank": 1,
  "lockout": false,
  "priority": false,
  "delay": 2,
  "tone_squelch": "Off"
}
```

**Bulk Channel Update (efficient):**
```
PUT /api/v1/memory/channels/bulk
{
  "channels": [
    {"id": 1, "frequency": 154.275, "alpha_tag": "Police", ...},
    {"id": 2, "frequency": 154.340, "alpha_tag": "Fire", ...},
    {"id": 3, "frequency": 155.160, "alpha_tag": "EMS", ...}
  ]
}
```

**Delete Channel (clear channel data):**
```
DELETE /api/v1/memory/channels/{id}
```

**Backend Implementation:**
- Single update: PRG → CIN,{id},{data} → EPG (~1 second)
- Bulk update: PRG → multiple CINs → EPG (one program mode session)
- Delete: PRG → CIN,{id},,,0,2,0,0 (empty channel) → EPG
- Shadow state updated after each operation
- WebSocket broadcast to all connected clients

---

## Implementation Phases

### Phase 1: Mode Switching Foundation (3-4 hours)
**Goal:** Enable switching between three modes with Control Mode functional

1. Add `uiMode` to Zustand store (30 min)
2. Create `ModeNavigation.tsx` component (30 min)
3. Extract `ControlModeView.tsx` from App.tsx (1 hour)
4. Create empty `ConfigModeView.tsx` and `BankEditorView.tsx` (30 min)
5. **Add persistent hit logging backend** (1 hour)
   - Create SQLite table for hits
   - Add hit recording on squelch_open events
   - Add GET /api/v1/hits endpoint (paginated)
6. Test mode switching (30 min)

**Deliverable:** Three-mode navigation with Control Mode working + hit logging infrastructure

---

### Phase 2: Control Mode Completion (3-4 hours)
**Goal:** Integrate all backlog components for Control Mode

1. Activity Log integration (45 min)
   - Import and render with visibility state
   - Wire to backend API to fetch recent hits
   - Add keyboard shortcut
   - Display last 5 from persistent storage

2. Direct Tune Modal integration (30 min)
   - Import and render with visibility state
   - Wire to Ctrl+F shortcut
   - Connect to API

3. Volume Indicator integration (15 min)
   - Import and render in header
   - Wire to LiveState.volume

4. Keyboard Shortcuts integration (1 hour)
   - Import useKeyboardShortcuts hook
   - Wire all handlers
   - Test all shortcuts

5. Shortcuts Help Modal integration (30 min)
   - Import and render with visibility state
   - Wire to Ctrl+? shortcut

6. Notification Center integration (30 min)
   - Import useNotifications hook
   - Render NotificationCenter
   - Wire to API errors and WebSocket events

7. Enhanced Display Components (1 hour)
   - Replace inline display with VirtualDisplay.tsx
   - Add hit detail secondary row (frequency, mode, channel)
   - Use dedicated PrimaryControls.tsx
   - Use dedicated ConnectionStatus.tsx

**Deliverable:** Fully-featured Control Mode with all backlog items

---

### Phase 3: Bank Editor Mode (5-7 hours) ✅ Real-Time API
**Goal:** Complete channel and bank management functionality with real-time updates

**Backend Work (2-3 hours):**
1. Add PUT /api/v1/memory/channels/{id} endpoint (1 hour)
2. Add PUT /api/v1/memory/channels/bulk endpoint (1 hour)
3. Add DELETE /api/v1/memory/channels/{id} endpoint (30 min)
4. Update shadow state after edits (30 min)

**Frontend Work (3-4 hours):**
1. Create BankEditorView layout (1 hour)
2. Move Read/Export buttons from Control Mode to Bank Editor (15 min)
3. Integrate MemoryBrowserPanel (30 min)
4. Integrate CurrentBankView (30 min)
5. Create ChannelEditor modal with validation (1.5 hours)
6. Wire to real-time API with immediate feedback (1 hour)
7. Add Memory Sync Cancel button (30 min)

**Deliverable:** Functional bank and channel editor with immediate apply

---

### Phase 4: Config Mode (6-8 hours) ✅ Real-Time API
**Goal:** Device configuration interface with real-time updates

**Backend Work (3 hours):**
1. Create bulk config endpoint: GET/POST /api/v1/config/all (1 hour)
2. Add config commands to driver (BLT, KBP, BSV, PRI, etc.) (1 hour)
3. Read current settings on startup or on-demand (1 hour)

**Frontend Work (3-5 hours):**
1. Create ConfigModeView layout (1 hour)
2. Create setting components (ToggleSetting, RangeSetting, SelectSetting) (2 hours)
3. Wire all settings to API with real-time update (1 hour)
4. Add validation and error handling (1 hour)

**Deliverable:** Full device configuration interface with immediate apply

---

### Phase 5: Polish & Testing (2-3 hours)
1. Cross-mode state preservation
2. Transition animations between modes
3. Mobile responsive design for all modes
4. Accessibility audit
5. Error handling improvements
6. Documentation updates

---

## Design Decisions ✅ (User Approved)

1. **Bank Toggle Location:** ✅ **Show in both modes**
   - Duplicate bank toggles in Control Mode and Bank Editor Mode
   - Control Mode: Quick access during scanning (current location)
   - Bank Editor Mode: With other channel management features for context

2. **Mode Switching UX:** ✅ **Tab-style navigation at top**
   - Three horizontal tabs/buttons at top of app
   - Visual indicator of current mode
   - Layout: `Control | Config | Bank Editor`

3. **State Preservation:** ✅ **Keep scanning in all modes**
   - Scanner continues operating in all modes
   - WebSocket updates work everywhere
   - Users can configure/edit while scanning
   - No automatic pause/resume logic needed

4. **Config Mode Approach:** ✅ **Real-time via API endpoints**
   - Create backend endpoints for device settings
   - Changes apply immediately to scanner
   - Better UX than file-based approach
   - Estimated 6-8 hours for backend + frontend

---

## Success Criteria

**Mode 1: Scanner Control** ✅
- All BACKLOG features integrated
- Keyboard shortcuts functional
- Notifications working
- Activity log accessible

**Mode 2: Scanner Config** 🆕
- All device settings readable
- Settings editable (real-time or file-based)
- Changes persist to scanner
- Preferences system functional

**Mode 3: Scanner Bank Editing** 🆕
- Memory browser functional
- Channel editing working
- Memory sync with cancel
- Bank management complete

**Cross-Mode** ✅
- Smooth mode switching
- WebSocket updates in all modes
- Notification system working everywhere
- Consistent UI/UX across modes
