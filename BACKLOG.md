# Feature Backlog

This document tracks features that are **coded but not wired** into the MVP, or planned enhancements that go beyond the core scanning workflow defined in `docs/UI_WORKFLOW.md`.

---

## High Priority Enhancements

### 1. Memory Browser Panel
**Status:** Complete, not rendered
**Location:** `frontend/src/components/MemoryBrowserPanel.tsx`
**Effort:** ~30 minutes

**Description:**
Fully implemented component for browsing all 500 channels with filtering by bank, lockout status, and search.

**What's Needed:**
- Import and render in `App.tsx`
- Add open/close state management
- Wire to keyboard shortcut (useKeyboardShortcuts already has handler defined)
- Add priority/lockout badges (⭐ for priority, 🚫 for locked out)

**Value:**
Users can browse, search, and manage scanner memory without official software.

---

### 2. Current Bank View
**Status:** Complete, not rendered
**Location:** `frontend/src/components/CurrentBankView.tsx`
**Effort:** ~20 minutes

**Description:**
Shows all channels in the currently active bank with quick navigation.

**What's Needed:**
- Import and render in `App.tsx`
- Pass `onBrowseAll` handler to open MemoryBrowserPanel
- Determine which bank is "current" (needs backend support or heuristic)

**Value:**
Quick overview of channels being scanned in the active bank.

---

## Medium Priority Enhancements

### 3. Preferences System
**Status:** Store ready, no UI
**Location:** `frontend/src/store/useStore.ts` (lines 5-9, 31-35)
**Effort:** ~2 hours

**Description:**
Store infrastructure for user preferences:
- `theme`: "night" | "field" (dark/light mode)
- `displayMode`: "frequency" | "alpha" (what to show first)
- `reducedMotion`: Accessibility option

**What's Needed:**
- Create Settings modal component
- Add theme switcher (CSS variables needed)
- Add display mode toggle
- Add accessibility options
- Persist to localStorage

**Value:**
Users can customize appearance and behavior to their preferences.

---

## Advanced Features

### 4. Channel Management
**Status:** Data available, no UI
**Effort:** ~4 hours

**Description:**
Full CRUD operations for scanner channels.

**What's Needed:**
- Channel editor modal
- Edit channel properties (frequency, modulation, alpha tag, delay, lockout, priority, tone squelch, bank)
- Write endpoints in backend
- Validation and error handling

**Value:**
Edit scanner memory without official software.

---

## Implementation Priorities

### Phase 1: Upcoming Tab Features (1 hour)
1. Memory Browser Panel (30 min + badge indicators)
2. Current Bank View (20 min)

### Phase 2: User Preferences (2 hours)
1. Preferences System UI (2 hours)
   - Theme switcher
   - Display mode toggle
   - Accessibility options
   - Persist to localStorage

### Phase 3: Advanced Features (4+ hours)
1. Channel Management (4 hours)
   - Channel editor modal
   - Edit properties (frequency, modulation, alpha tag, delay, lockout, priority, tone squelch, bank)
   - Backend write endpoints
   - Validation and error handling

---

## Completed Features

The following features have been implemented and wired into the app:
- ✅ Activity Log Component
- ✅ Keyboard Shortcuts System
- ✅ Notification Center
- ✅ Shortcuts Help Modal
- ✅ Enhanced Display Components (VirtualDisplay, PrimaryControls, ConnectionStatus)
- ✅ Volume Indicator
- ✅ Individual Channel Retrieval API

## Removed from Backlog

The following items were removed as unnecessary or low priority:
- ❌ Direct Tune Modal (not possible with current hardware protocol)
- ❌ Memory Sync Cancel (sync is virtually immediate)
- ❌ Health Check Endpoint (connection status LED is sufficient)
- ❌ Additional Data Display (modulation already shown in scan display, other fields too niche)

---

## Deployment & Distribution

### 5. Hybrid Backend Management (Service Mode)
**Status:** Not implemented
**Effort:** ~8-12 hours

**Description:**
Allow users to choose between two backend operation modes:
- **Simple Mode** (default): Backend starts with Electron app, stops when app closes, minimizes to system tray
- **Service Mode**: Backend installs as system service (launchd/systemd/Windows Service), runs continuously in background even when app is closed

**What's Needed:**

**Backend (Python):**
- Add `service.py` module with platform-specific service installation
  - macOS: LaunchAgent plist generation and launchctl integration
  - Linux: systemd user service generation
  - Windows: NSSM or pywin32 service wrapper
- CLI commands: `install-service`, `uninstall-service`, `service-status`
- Service detection on startup (check if already running)
- Health check endpoint for backend detection

**Electron:**
- Backend manager class to handle lifecycle
  - Check if backend already running (service mode)
  - Start backend as child process if not (simple mode)
  - System tray icon with status indicator
  - Minimize to tray instead of closing window
  - Stop backend only in simple mode on quit
- IPC handlers for service management commands
- Prevent backend stop when in service mode

**Frontend:**
- Service settings UI in config/advanced settings
  - Display current mode (Simple vs Service)
  - One-click install/uninstall buttons
  - Service status indicators (installed, running)
  - Clear explanation of each mode

**Value:**
- **Flexibility**: Works for casual users (simple) and power users (service)
- **Multi-client**: Backend always accessible when in service mode
- **Persistent**: Service mode survives reboots, allows other apps to connect anytime
- **Server-like deployment**: Install backend on one machine, access from multiple clients
- **Easy migration path**: Start simple, upgrade to service when needed

**Implementation Notes:**
- Backend code doesn't need changes - already supports multiple clients
- Purely packaging/deployment enhancement
- Service installation may require admin privileges on some platforms
- Consider separate installers: "Bearpaw Server" (backend only) + "Bearpaw UI" (frontend only)

---

## Notes

- Remaining components are production-ready and tested
- Phase 1 requires only wiring (import, render, state management)
- Phase 2 requires UI implementation for existing store infrastructure
- Phase 3 requires new backend write endpoints for channel editing
- Estimated remaining effort: ~7 hours for all remaining features
- Deployment enhancements (service mode) are independent of feature development
