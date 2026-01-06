# Feature Backlog

This document tracks features that are **coded but not wired** into the MVP. These are nice-to-have enhancements that go beyond the core scanning workflow defined in `docs/UI_WORKFLOW.md`.

---

## High Priority Enhancements

### 1. Activity Log Component
**Status:** Complete, not rendered
**Location:** `frontend/src/components/ActivityLog.tsx`
**Effort:** ~30 minutes

**Description:**
Fully implemented component that shows recent scan hits with timestamps, frequencies, and alpha tags.

**What's Needed:**
- Import and render in `App.tsx`
- Add open/close state management
- Wire to scan_hit events to populate log
- Add UI button or keyboard shortcut to open

**Value:**
Users can review what they've missed and track scanning patterns.

---

### 2. Memory Browser Panel
**Status:** Complete, not rendered
**Location:** `frontend/src/components/MemoryBrowserPanel.tsx`
**Effort:** ~30 minutes

**Description:**
Fully implemented component for browsing all 500 channels with filtering by bank, lockout status, and search.

**What's Needed:**
- Import and render in `App.tsx`
- Add open/close state management
- Wire to keyboard shortcut (useKeyboardShortcuts already has handler defined)

**Value:**
Users can browse, search, and manage scanner memory without official software.

---

### 3. Direct Tune Modal
**Status:** Complete, not rendered
**Location:** `frontend/src/components/DirectTuneModal.tsx`
**Effort:** ~20 minutes

**Description:**
Fully implemented modal for manual frequency entry with validation.

**What's Needed:**
- Import and render in `App.tsx`
- Add open/close state management
- Wire to keyboard shortcut (Ctrl+F already defined in useKeyboardShortcuts)

**Value:**
Users can quickly tune to specific frequencies without navigating memory banks.

---

### 4. Current Bank View
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

### 5. Keyboard Shortcuts System
**Status:** Complete, not used
**Location:** `frontend/src/hooks/useKeyboardShortcuts.ts`
**Effort:** ~1 hour

**Description:**
Comprehensive keyboard shortcut system with handlers for:
- Ctrl+F: Direct tune
- Ctrl+?: Shortcuts help
- Up/Down: Channel navigation (partially wired)
- Space: Scan/Hold toggle
- H: Hold
- S: Scan

**What's Needed:**
- Import hook in `App.tsx`
- Pass handler functions for modals/panels
- Enable all shortcuts

**Value:**
Power users can control scanner without mouse/touch.

---

## Medium Priority Enhancements

### 6. Notification Center
**Status:** Complete, not rendered
**Location:** `frontend/src/components/NotificationCenter.tsx`, `frontend/src/hooks/useNotifications.ts`
**Effort:** ~30 minutes

**Description:**
Toast notification system for errors, success messages, and warnings.

**What's Needed:**
- Import and use `useNotifications` hook in `App.tsx`
- Render `NotificationCenter` component
- Show notifications for API errors, sync completion, etc.
- Wire to WebSocket error messages

**Value:**
Better user feedback for background operations and errors.

---

### 7. Shortcuts Help Modal
**Status:** Complete, not rendered
**Location:** `frontend/src/components/ShortcutsHelp.tsx`
**Effort:** ~15 minutes

**Description:**
Modal displaying all available keyboard shortcuts.

**What's Needed:**
- Import and render in `App.tsx`
- Add open/close state management
- Wire to Ctrl+? keyboard shortcut

**Value:**
Improves discoverability of keyboard shortcuts.

---

### 8. Preferences System
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

### 9. Enhanced Display Components
**Status:** Complete, duplicated in App.tsx
**Effort:** ~1 hour

Replace inline implementations with dedicated components:

**9.1 Virtual Display**
`frontend/src/components/VirtualDisplay.tsx`
More feature-rich than current inline display with better alpha tag support.

**9.2 Primary Controls**
`frontend/src/components/PrimaryControls.tsx`
Dedicated Scan/Hold button component.

**9.3 Connection Status**
`frontend/src/components/ConnectionStatus.tsx`
Dedicated connection indicator.

**Value:**
Cleaner code, better maintainability, consistent styling.

---

### 10. Volume Indicator
**Status:** Complete, not rendered
**Location:** `frontend/src/components/VolumeIndicator.tsx`
**Effort:** ~15 minutes

**Description:**
Visual volume level indicator (data already available in `LiveState.volume`).

**What's Needed:**
- Import and render in header area
- Style to match existing UI

**Value:**
Visual feedback for scanner volume level.

---

## API Enhancements

### 11. Memory Sync Cancel
**Status:** Backend endpoint exists, no frontend method
**Location:** Backend: `api.py:322`, Frontend: needs client method
**Effort:** ~30 minutes

**What's Needed:**
- Add `cancelMemorySync()` to `frontend/src/api/client.ts`
- Add cancel button to sync progress UI
- Handle cancellation response

**Value:**
Users can cancel long-running memory sync operations.

---

### 12. Individual Channel Retrieval
**Status:** Backend endpoint exists, no frontend method
**Location:** Backend: `GET /api/v1/memory/channels/{channel_id}`
**Effort:** ~20 minutes

**What's Needed:**
- Add `getChannel(channelId: number)` to `frontend/src/api/client.ts`
- Use for on-demand channel detail views

**Value:**
Fetch individual channel details without loading all 500 channels.

---

### 13. Health Check Endpoint
**Status:** Backend endpoint exists, no frontend use
**Location:** Backend: `GET /api/v1/health`
**Effort:** ~30 minutes

**What's Needed:**
- Add `getHealth()` to API client
- Use in connection monitoring/diagnostics
- Display in settings/diagnostics panel

**Value:**
Better connection diagnostics and troubleshooting.

---

## Advanced Features

### 14. Channel Management
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

### 15. Additional Data Display
**Status:** Data available in backend, not displayed
**Effort:** ~1 hour

Display additional device/channel information:

**Device Info:**
- Firmware version
- Port/VID/PID/Serial (for debugging)

**Channel Data:**
- Priority flag
- Lockout status (used in filter, not displayed)
- Delay setting
- Tone squelch frequency

**LiveState:**
- Battery level (for handheld scanners)

**What's Needed:**
- Add to device info panel
- Add to channel detail views
- Add battery indicator to header

**Value:**
Complete information for advanced users and debugging.

---

## Implementation Priorities

### Phase 1: Quick Wins (2-3 hours)
1. Activity Log (30 min)
2. Memory Browser (30 min)
3. Direct Tune Modal (20 min)
4. Shortcuts Help (15 min)
5. Keyboard Shortcuts (1 hour)

### Phase 2: User Experience (3-4 hours)
1. Notification Center (30 min)
2. Current Bank View (20 min)
3. Volume Indicator (15 min)
4. Memory Sync Cancel (30 min)
5. Preferences System (2 hours)

### Phase 3: Polish (2-3 hours)
1. Enhanced Display Components (1 hour)
2. Additional Data Display (1 hour)
3. Health Check Integration (30 min)
4. Individual Channel Retrieval (20 min)

### Phase 4: Advanced (4+ hours)
1. Channel Management (4 hours)

---

## Notes

- All components are production-ready and tested
- Most require only wiring (import, render, state management)
- No new backend work needed for Phase 1-3
- Phase 4 requires new backend endpoints for write operations
- Estimated total effort: ~15-20 hours for all features
