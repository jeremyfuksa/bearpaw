# Scanner Bridge - Bearpaw Design Implementation Plan

## Overview
Implementing a completely new UI design for Scanner Bridge generated from Figma (code named "Bearpaw"). The new design is significantly different from the current implementation and includes both redesigned existing features and several new features.

## Phase 1: Design Analysis Complete

### Current Implementation Summary
- **Tech Stack**: React + TypeScript + Zustand + CSS modules
- **Structure**: 3 tabs (Scan, Device, Channels)
- **Styling**: CSS custom properties (dark theme), Inter font
- **Components**: VirtualDisplay, PrimaryControls, bank buttons, recent hits table, dashboard widgets
- **State**: Zustand store with WebSocket updates

### New Design (Bearpaw) Summary
- **Tech Stack**: React + TypeScript + Tailwind CSS + Radix UI + Motion (Framer Motion)
- **Structure**: Same 3 tabs but COMPLETELY redesigned layouts
- **Styling**: Tailwind utility classes, dark theme with orange accents
- **Components**: Heavy use of Radix UI primitives, more polished/modern aesthetic
- **Key Dependencies**: Added ~50 new packages (Radix UI suite, motion, recharts, etc.)

## Phase 2: Feature Mapping

### Core Features - Direct Mapping

| Current Feature | Bearpaw Equivalent | Changes Required |
|----------------|-------------------|------------------|
| **VirtualDisplay** | `ScannerDisplay` component | ✅ Major redesign - now has "hero" and "dashboard" variants with smooth transitions |
| **PrimaryControls** (Scan/Hold) | Integrated into `StatusHeader` as HOLD button | ✅ Moved location, different styling |
| **Bank Controls** | `BankControls` component | ✅ Similar concept, different visual treatment |
| **Recent Hits Table** | Recent Hits panel (sidebar) | ✅ Now has dual modes: "calm mode" (cards) and "dashboard mode" (compact list) |
| **ConnectionStatus** | Part of `StatusHeader` (status LED + text) | ✅ Similar concept, integrated into header |
| **Volume Control** | Volume popover in `StatusHeader` | ✅ Now a popover with slider instead of indicator |
| **Session Stats** | Stats chips (in normal mode) or sidebar (dashboard mode) | ✅ Different layout, same data |
| **Device Config Tab** | `DeviceTab` with sidebar navigation | ✅ Similar structure, completely redesigned UI |
| **Memory Browser** | `ChannelsTab` with bank selection sidebar | ✅ Similar structure, redesigned grid |

### New Features in Bearpaw

#### 1. **Dashboard Mode Toggle** 🆕
- **What**: Button to switch between "Monitor Mode" (normal) and "Dashboard Mode" (compact)
- **Behavior**:
  - Monitor Mode: VirtualDisplay is large (hero variant), takes most of space, stats below
  - Dashboard Mode: VirtualDisplay shrinks to compact size, analytics widgets appear below
  - Smooth height/width transitions using motion/framer-motion
- **Location**: Top right of Scan view
- **Implementation**: State toggle + conditional rendering + motion animations

#### 2. **Recording Indicator/Toggle** 🆕
- **What**: REC button in StatusHeader that shows recording state
- **States**:
  - Not recording: Gray button with gray dot
  - Recording: Red pulsing button with animated red dot + glow effect
- **Functionality**: Needs to integrate with audio recording backend (may not exist yet)
- **Question**: Does backend support audio recording currently?

#### 3. **Dual-Mode Recent Hits Display** 🆕
- **What**: Recent hits render differently based on mode
- **Modes**:
  - **Calm/Monitor Mode**: Rich cards with large text, hover effects, play icons
  - **Dashboard Mode**: Compact list items with inline signal strength
- **Feature**: Play icons indicate recorded audio is available for hit
- **Question**: How do we determine if a hit has audio?

#### 4. **Audio Indicator in Hits** 🆕
- **What**: Play icon (▶) next to hits that have recorded audio
- **Behavior**: Presumably clickable to play back the recording
- **Question**: Does backend record audio? How is it stored/retrieved?

#### 5. **Enhanced Lockout Button** 🆕
- **Behavior**: Single click = temp lockout, double click = permanent
- **Visual**: Shows different states during flash
- **Already exists** in current implementation, just needs visual update

#### 6. **Activity Log Modal** 🆕
- **What**: Full-screen modal showing complete activity history
- **Features**:
  - Table view with Time, Freq, Tag, Signal columns
  - Download button (export functionality)
  - Close button
  - Footer with session stats
- **Trigger**: "Activity Log" button at bottom of Scan view
- **Question**: Should this pull from existing activityLog or from backend API?

#### 7. **Locked Channels Matrix View** 🆕
- **What**: Complete redesign of locked channels management in Device tab
- **Features**:
  - Visual grid/matrix of locked frequencies (not a list)
  - Each item is a card showing freq + name
  - Click to select multiple
  - Bulk unlock button
  - Select all / Deselect all
  - Status light indicator per card
  - Much more visual/polished than current checkbox list
- **Implementation**: Needs state for selection, bulk operations

#### 8. **Custom Search Range Editor** 🆕
- **What**: Inline editable table for 10 search ranges
- **Features**:
  - Toggle switch per range
  - Editable label, lower freq, upper freq fields
  - Active range count display
  - Fluid grid layout that fills space
  - Visual distinction for enabled ranges (orange tint)
- **Current**: Already has similar functionality but different UI

#### 9. **Preferences/Settings Page** 🆕
- **What**: New "Preferences" category in Device tab (collapsed under "Advanced")
- **Features**:
  - About section with version, app info, links
  - Support/donation section with call-to-action
  - Application settings (auto-connect, start in dashboard, updates)
  - Audio settings (output device, buffer size)
  - Data/storage settings (recordings path, retention policy)
- **Implementation**: Many of these settings don't exist in current backend

#### 10. **Smooth Animations Throughout** 🆕
- **What**: Motion/Framer Motion used extensively
- **Examples**:
  - Tab transitions (slide in/out)
  - Dashboard mode toggle (height/width animations)
  - Modal fade in/out
  - Component enter/exit animations
- **Package**: motion (v12.23.24) - Framer Motion successor

## Phase 3: Critical Questions

### Backend Integration Questions

1. **Audio Recording**:
   - Does the backend currently support audio recording from the scanner?
   - If yes, what format? Where stored? How to retrieve?
   - If no, is this a planned feature or should I stub it out?

2. **Activity Log Storage**:
   - Current implementation keeps max 5 items in memory
   - Bearpaw design shows full session history in modal
   - Should I persist full history on backend? SQLite? In-memory only?
   - Or should Activity Log modal just show the same 5 items in table format?

3. **Preferences/Settings**:
   - Many settings in Bearpaw Preferences don't exist currently:
     - Audio output device selection
     - Recording buffer size
     - Recordings path
     - Data retention policy
     - Check for updates
   - Which should be implemented now vs stubbed for future?

4. **Dashboard Mode Persistence**:
   - Should dashboard mode preference persist across sessions?
   - Store in Zustand? localStorage? Backend preferences?

### Implementation Approach Questions

5. **Migration Strategy**:
   - **Option A**: Full rewrite - delete current frontend, start fresh with Bearpaw
     - Pros: Clean slate, modern dependencies, no technical debt
     - Cons: Risky, all-or-nothing, might break things

   - **Option B**: Incremental replacement - replace components one by one
     - Pros: Safer, can test each piece, maintain working app
     - Cons: Two styling systems coexist temporarily, more complex

   - **Option C**: Parallel development - keep both, add toggle
     - Pros: Can compare, easy rollback, gradual user migration
     - Cons: Maintenance burden, doubled code

   - **Your preference?**

6. **Dependency Management**:
   - Bearpaw adds ~50 new packages (Radix UI, motion, tailwind, etc.)
   - Current app is lightweight (minimal deps)
   - Should I:
     - Add all Bearpaw deps to main project?
     - Cherry-pick only needed components?
     - Find lighter alternatives?

7. **Styling System**:
   - Current: CSS modules + custom properties
   - Bearpaw: Tailwind CSS utility classes
   - Should I:
     - Fully migrate to Tailwind?
     - Keep CSS modules, port Bearpaw styles manually?
     - Use both (Tailwind for new, CSS for existing)?

### Feature Priority Questions

8. **What's Most Important?**
   Rank these in order of priority (1=highest):
   - [ ] Visual redesign (colors, layout, polish)
   - [ ] Dashboard mode toggle
   - [ ] Audio recording integration
   - [ ] Activity log modal
   - [ ] Locked channels matrix view
   - [ ] Preferences page
   - [ ] Smooth animations

9. **MVP Scope**:
   - Should I implement EVERYTHING in Bearpaw design?
   - Or focus on core features first, stub advanced ones?
   - What's the timeline/urgency?

## Phase 4: Technical Considerations

### Compatibility Issues

1. **React Version**:
   - Current: React 18.3.1
   - Bearpaw: React 18.3.1 (peer dep)
   - ✅ Compatible

2. **TypeScript**:
   - Current: TypeScript 5.7+
   - Bearpaw: No explicit TS in package.json but uses .tsx files
   - ✅ Compatible

3. **Build System**:
   - Current: Vite 6.3+
   - Bearpaw: Vite 6.3.5
   - ✅ Compatible

4. **Styling Conflicts**:
   - Current CSS custom properties may conflict with Tailwind
   - Need CSS reset/normalization strategy
   - Tailwind's base layer might override existing styles

### State Management Challenges

1. **Dashboard Mode State**:
   - New state: `isDashboardMode: boolean`
   - Where: Zustand store? Local component state?
   - Persistence: localStorage?

2. **Recording State**:
   - New state: `isRecording: boolean`
   - Integration: WebSocket? API polling? Local audio capture?

3. **Activity Log Full History**:
   - Current: Max 5 items in activityLog array
   - Bearpaw: Shows full session history
   - Need: Either backend API or in-memory full history

4. **Selection State (Locked Channels)**:
   - Bearpaw has multi-select grid
   - Need: `selectedLockedChannels: string[]` or similar

### Animation Performance

1. **Motion Library**:
   - Framer Motion successor, larger bundle size
   - May impact load time
   - Consider: Lazy loading, code splitting

2. **Transition Complexity**:
   - Dashboard mode toggle animates many elements simultaneously
   - Risk: Jank on slower devices
   - Solution: Test performance, add `will-change` hints

## Phase 5: Proposed Implementation Plan

### Stage 1: Foundation (Week 1)
**Goal**: Set up new tech stack alongside existing code

1. Install dependencies (Tailwind, Radix UI, motion, recharts)
2. Configure Tailwind (custom colors, fonts to match design)
3. Set up component library structure (Bearpaw UI components)
4. Create utility functions (cn helper, etc.)
5. No breaking changes to existing UI yet

### Stage 2: Core Components (Week 2)
**Goal**: Build new components with mock data

1. `ScannerDisplay` component (hero + compact variants)
2. `StatusHeader` component (status, buttons, volume popover)
3. `BankControls` component
4. `TabNav` component
5. Test all components in isolation (Storybook or similar)

### Stage 3: Scan View (Week 3)
**Goal**: Replace Scan tab with new design

1. Build Scan view layout
2. Integrate `ScannerDisplay` with live state
3. Dashboard mode toggle + animations
4. Recent Hits dual-mode display
5. Session stats chips
6. Wire up all existing backend data

### Stage 4: Analytics Widgets (Week 4)
**Goal**: Implement dashboard widgets

1. Busiest Channels chart (Recharts)
2. Activity Heatmap grid
3. Conditionally render in dashboard mode
4. Smooth enter/exit animations

### Stage 5: Device Tab (Week 5)
**Goal**: Redesign configuration interface

1. Sidebar navigation
2. Locked Channels matrix view
3. Device Config categories
4. Close Call settings
5. Service/Custom Search
6. Preferences page (stub unimplemented settings)

### Stage 6: Channels Tab (Week 6)
**Goal**: Redesign memory browser

1. Bank sidebar
2. Search/filter
3. Editable grid with Tailwind styling
4. Import/Export CSV buttons
5. Maintain existing edit behavior

### Stage 7: Polish & Features (Week 7)
**Goal**: Add advanced features

1. Activity Log modal
2. Recording button integration (if backend ready)
3. Audio playback in hits (if backend ready)
4. Keyboard shortcuts
5. Animations and transitions
6. Accessibility review

### Stage 8: Testing & Refinement (Week 8)
**Goal**: Ensure quality and stability

1. Cross-browser testing
2. Responsive behavior testing
3. Performance optimization
4. Bug fixes
5. Documentation updates

## Decisions Made ✅

1. **Migration Strategy**: Full rewrite with Bearpaw code
   - Clean slate approach
   - Replace current frontend completely
   - Modern tech stack from day one

2. **Audio Recording**: Stub it out for now
   - Backend doesn't support recording yet
   - Implement UI controls but non-functional
   - Add TODO comments for future integration

3. **Styling**: Use Tailwind CSS
   - Matches Bearpaw implementation exactly
   - Modern, maintainable approach
   - Delete old CSS modules

4. **Priority Features**: ALL new features are high priority
   - Dashboard mode toggle
   - Visual redesign
   - Activity log modal
   - Preferences page

## Final Implementation Strategy

### Approach: Bearpaw Code as Foundation

Instead of rewriting from scratch, I'll use the Bearpaw generated code as the starting point and integrate it with Scanner Bridge backend:

**Step 1: Prepare Bearpaw Code**
- Copy Bearpaw source files to frontend/src
- Install all Bearpaw dependencies in frontend/package.json
- Configure Tailwind in frontend (already has vite.config.ts)
- Remove mock data, keep component structure

**Step 2: Integrate State Management**
- Replace Bearpaw's local useState with Zustand store
- Connect components to existing useStore hooks
- Wire up WebSocket client
- Map Bearpaw's mock types to Scanner Bridge types

**Step 3: Connect Backend APIs**
- Replace all mock data with real API calls
- Integrate existing api/client.ts
- Connect Device tab to config endpoints
- Connect Channels tab to memory endpoints

**Step 4: Implement New Features**
- Dashboard mode toggle with animations
- Activity log modal with real session data
- Preferences page (stub unimplemented backend features)
- Recording button (UI only, non-functional)

**Step 5: Testing & Refinement**
- Test all WebSocket scenarios
- Test device config changes
- Test memory browser editing
- Performance optimization
- Accessibility review

## Critical Files to Modify/Create

### Files to Copy from Bearpaw → frontend/src
```
Bearpaw/src/app/App.tsx                    → frontend/src/App.tsx (replace)
Bearpaw/src/app/components/ScannerUI.tsx   → frontend/src/components/ScannerUI.tsx (new)
Bearpaw/src/app/components/ui/*            → frontend/src/components/ui/* (all Radix components)
Bearpaw/src/lib/utils.ts                   → frontend/src/lib/utils.ts (new)
Bearpaw/src/styles/*                       → frontend/src/styles/* (Tailwind)
```

### Files to Keep & Integrate
```
frontend/src/store/useStore.ts             → Keep, integrate with new components
frontend/src/api/client.ts                 → Keep, use in new components
frontend/src/websocket/ScannerWebSocket.ts → Keep, use in new App.tsx
frontend/src/types.ts                      → Keep, may need minor updates
```

### Files to Delete (Old Implementation)
```
frontend/src/components/VirtualDisplay.tsx      → Delete (replaced by ScannerDisplay)
frontend/src/components/PrimaryControls.tsx     → Delete (integrated into StatusHeader)
frontend/src/components/RecentHitsTable.tsx     → Delete (integrated into App)
frontend/src/components/SessionStatsWidget.tsx  → Delete (integrated into App)
frontend/src/components/BusiestChannelsWidget.tsx → Delete (replaced by Recharts chart)
frontend/src/components/ActivityHeatmapWidget.tsx → Delete (replaced)
frontend/src/components/ConfigModeView.tsx      → Delete (replaced by DeviceTab)
frontend/src/components/MemoryBrowserView.tsx   → Delete (replaced by ChannelsTab)
frontend/src/App.css                            → Delete (using Tailwind)
frontend/src/index.css                          → Keep base, remove old styles
```

### New Files to Create
```
frontend/src/components/ActivityLogModal.tsx    → Full session history modal
frontend/src/components/config/PreferencesCategory.tsx → Settings page
frontend/src/hooks/useDashboardMode.ts          → Dashboard toggle logic
frontend/src/utils/activityLog.ts               → Full history management
frontend/tailwind.config.js                     → Tailwind configuration
```

## Implementation Details

### 1. Type Mapping

**Bearpaw Types → Scanner Bridge Types**

```typescript
// Bearpaw uses:
type ScannerMode = "SCAN" | "HOLD" | "SEARCH" | "CLOSE_CALL";

// Scanner Bridge has:
type Mode = "SCAN" | "HOLD" | "DIRECT" | "SEARCH" | "CLOSE_CALL";

// Map: Bearpaw's "SEARCH" = Scanner Bridge's "DIRECT"
```

**Activity Log Entries**

```typescript
// Keep Scanner Bridge ActivityLogEntry
// Add new fields for Bearpaw features:
interface ActivityLogEntry {
  // ... existing fields ...
  hasAudio?: boolean;  // NEW: for recording indicator
}
```

### 2. State Integration Plan

**Keep Zustand Store Structure**

```typescript
// Add new state:
interface AppState {
  // ... existing state ...

  // New for Bearpaw:
  isDashboardMode: boolean;
  isRecording: boolean;  // UI state only
  fullActivityLog: ActivityLogEntry[];  // Unlimited history
}

// New actions:
setDashboardMode: (mode: boolean) => void;
setRecording: (recording: boolean) => void;  // UI only
addToFullActivityLog: (entry: ActivityLogEntry) => void;
```

### 3. Component Integration Examples

**ScannerDisplay Integration**

```tsx
// OLD: VirtualDisplay with custom CSS
<VirtualDisplay
  temporaryLockoutChannels={tempLockouts}
  scanOverrideActive={false}
/>

// NEW: ScannerDisplay with props from store
const liveState = useStore(state => state.liveState);
const isDashboard = useStore(state => state.isDashboardMode);

<ScannerDisplay
  mainText={liveState?.alpha_tag || liveState?.frequency.toString() || "—"}
  subText={`${liveState?.frequency} • ${liveState?.modulation} • CH${liveState?.channel}`}
  mode={liveState?.mode || "SCAN"}
  signalStrength={liveState?.rssi || 0}
  isScanning={liveState?.mode === "SCAN" && !liveState?.squelch_open}
  isError={!connected}
  errorType="usb"
  variant={isDashboard ? "default" : "hero"}
  className="flex-1 min-h-0"
/>
```

**StatusHeader Integration**

```tsx
// OLD: Separate components in header
<ConnectionStatus />
<VolumeIndicator />
<PrimaryControls />

// NEW: Unified StatusHeader
<StatusHeader
  connectionStatus={connected ? "connected" : connecting ? "connecting" : "disconnected"}
  modelName={deviceInfo?.model || "BC125AT"}
  volume={liveState?.volume || 12}
  onVolumeChange={(v) => api.setVolume(v)}
  isHolding={liveState?.mode === "HOLD"}
  onHoldToggle={handleToggleHold}
  onLockout={(type) => handleLockout(type)}
  isRecording={isRecording}
  onRecordingToggle={() => setRecording(!isRecording)}  // UI only
/>
```

### 4. Animation Strategy

**Dashboard Mode Toggle**

```tsx
// Use AnimatePresence + motion for smooth transitions
<AnimatePresence mode="wait">
  {isDashboardMode ? (
    <motion.div
      key="dashboard"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 240 }}
      exit={{ opacity: 0, height: 0 }}
      transition={{ duration: 0.5, ease: "easeInOut" }}
    >
      {/* Analytics widgets */}
    </motion.div>
  ) : (
    <motion.div key="monitor" {...}>
      {/* Full session stats */}
    </motion.div>
  )}
</AnimatePresence>
```

### 5. Stubbed Features

**Recording Button**

```tsx
// Button is interactive but shows toast notification
const handleRecordingToggle = () => {
  toast.info("Recording feature coming soon", {
    description: "Audio recording requires backend support"
  });
  // Don't actually change recording state
};
```

**Preferences Settings**

```tsx
// Render UI but disable non-implemented features
<div className="space-y-4">
  <div className="flex items-center justify-between">
    <label>Audio Output Device</label>
    <Select disabled>
      <SelectTrigger>
        <SelectValue placeholder="System Default" />
      </SelectTrigger>
    </Select>
    <span className="text-xs text-white/40">Coming soon</span>
  </div>
</div>
```

## Verification Plan

After implementation, verify:

### Functional Requirements
- [x] WebSocket connects and receives state updates
- [x] Frequency displays correctly during hits
- [x] Scan/Hold toggle works
- [x] Bank buttons enable/disable banks
- [x] Recent hits populate from live data
- [x] Activity log modal shows session history
- [x] Dashboard mode toggles smoothly
- [x] Device config categories all load
- [x] Channel memory browser edits save
- [x] Busiest channels chart displays real data
- [x] Heatmap shows activity patterns

### Visual Requirements
- [x] Dark theme matches Figma design
- [x] Orange accent color (#ef991f) used consistently
- [x] Typography uses correct weights and sizes
- [x] Layout matches Bearpaw at 1100x600 dimensions
- [x] Animations are smooth and performant
- [x] No layout shifts or flickering

### Accessibility
- [x] Keyboard navigation works
- [x] ARIA labels present on interactive elements
- [x] Focus indicators visible
- [x] Screen reader announcements for state changes

## Rollout Plan

1. **Development Branch**: Create `feature/bearpaw-ui`
2. **Testing**: Test with real scanner hardware
3. **Documentation**: Update README with new screenshots
4. **Merge**: Merge to main when stable
5. **Cleanup**: Archive old Bearpaw directory

## Notes

- Bearpaw package.json has 70+ dependencies - this is expected for a polished UI
- Motion (Framer Motion) adds ~150kb gzipped but worth it for smooth animations
- Recharts adds significant bundle size - consider lazy loading dashboard widgets
- All Radix UI components are accessible by default - maintain this
- Keep existing backend API contracts - no breaking changes needed
