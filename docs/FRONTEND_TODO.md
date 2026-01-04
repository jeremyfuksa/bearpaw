# Frontend (Web UI) Todo List

## Phase 1: Project Foundation

- [ ] **PROJECT-001** Initialize frontend project
  - Create `frontend/` directory
  - Set up Vite + React (or Vue/Svelte)
  - Configure TypeScript
  - Install base dependencies

- [ ] **PROJECT-002** Configure development environment
  - Hot module replacement (HMR)
  - ESLint + Prettier
  - Git hooks (lint-staged, husky)
  - Environment variable management (.env)

- [ ] **PROJECT-003** Set up build pipeline
  - Production build configuration
  - Asset optimization (minification, tree-shaking)
  - Source maps for debugging
  - Bundle size analysis

## Phase 2: API Integration

- [ ] **API-001** Create REST client module
  - Base HTTP client (fetch or axios)
  - Error handling and retry logic
  - Request/response interceptors
  - TypeScript types from OpenAPI spec

- [ ] **API-002** Implement control command functions
  - `sendHold()` - POST /commands/hold
  - `sendScan()` - POST /commands/scan
  - `sendKey(keyCode)` - POST /commands/key
  - `setFrequency(freq)` - POST /frequency

- [ ] **API-003** Implement query functions
  - `getStatus()` - GET /status
  - `getDeviceInfo()` - GET /device/info
  - `getChannels()` - GET /memory/channels
  - `syncMemory()` - POST /memory/sync

- [ ] **WS-001** Create WebSocket client
  - Connection management (connect, disconnect)
  - Auto-reconnect with exponential backoff
  - Heartbeat/ping-pong
  - Connection state tracking

- [ ] **WS-002** Implement message handling
  - Parse incoming JSON messages
  - Type guards for message discrimination
  - Message queue for offline buffering
  - Event emitter for message dispatch

- [ ] **WS-003** Create WebSocket service hook/composable
  - React: `useWebSocket()` hook
  - Vue: `useWebSocket()` composable
  - Subscribe to specific message types
  - Automatic cleanup on unmount

## Phase 3: State Management

- [ ] **STATE-001** Design client-side state structure
  - Live state (frequency, mode, RSSI, squelch)
  - Device info (model, connection status)
  - Shadow state (channels, alpha tags)
  - UI state (selected view, preferences)

- [ ] **STATE-002** Implement state store
  - Zustand (React) or Pinia (Vue)
  - Actions for state updates
  - Selectors for derived state
  - Persistence for UI preferences (localStorage)

- [ ] **STATE-003** Connect WebSocket to state store
  - Listen for state update messages
  - Merge updates into local state
  - Handle out-of-order messages
  - Optimistic updates for control commands

- [ ] **STATE-004** Implement connection state management
  - Connected, disconnected, connecting states
  - Backend availability detection
  - Retry attempts tracking
  - User notification on status change

## Phase 4: Core Components

- [ ] **COMP-001** Create Virtual Display component
  - LCD-style text rendering (monospace font)
  - Frequency display mode (large digits)
  - Alpha tag display mode
  - Automatic mode switching based on scanner state

- [ ] **COMP-002** Add Virtual Display features
  - Squelch indicator (open/closed)
  - Mode indicator (FM, AM, NFM)
  - Bank/channel indicator
  - Visual blinking for scan hits

- [ ] **COMP-003** Create Signal Strength Indicator
  - S-meter style visualization
  - RSSI value (0-100%)
  - Color coding (green/yellow/red)
  - Peak hold display

- [ ] **COMP-004** Create Transport Controls component
  - Scan button (large, primary action)
  - Hold button
  - Channel up/down buttons
  - Direct frequency entry field

- [ ] **COMP-005** Implement frequency entry validation
  - Format validation (xxx.xxxx MHz)
  - Range validation based on scanner model
  - Modulation selection (FM/AM)
  - Submit on Enter key

- [ ] **COMP-006** Create Activity Log component
  - Scrollable list of recent hits
  - Timestamped entries (relative and absolute)
  - Frequency, alpha tag, duration
  - Click to tune functionality

- [ ] **COMP-007** Add Activity Log features
  - Auto-scroll to newest
  - Manual scroll lock
  - Clear log button
  - Export to CSV/JSON

## Phase 5: Layout & Navigation

- [ ] **LAYOUT-001** Design responsive layout
  - Desktop: multi-column (display, controls, log)
  - Tablet: adaptive layout
  - Mobile: stacked, swipeable views
  - Dark mode support

- [ ] **LAYOUT-002** Create app shell component
  - Header with device connection status
  - Navigation (if multiple views)
  - Footer with version info
  - Loading states

- [ ] **LAYOUT-003** Implement view routing (if needed)
  - Main scanner view (default)
  - Memory browser view (future)
  - Settings view (future)
  - About/help view

## Phase 6: Advanced Features

- [ ] **FEATURE-001** Create memory browser view
  - Channel list table
  - Filter by bank
  - Search by alpha tag or frequency
  - Sort by column

- [ ] **FEATURE-002** Implement memory sync UI
  - Progress bar during sync
  - Cancel sync button
  - Success/error notification
  - Last sync timestamp display

- [ ] **FEATURE-003** Add keyboard shortcuts
  - Space: toggle scan/hold
  - Arrow keys: channel up/down
  - F: focus frequency entry
  - H: hold
  - S: scan

- [ ] **FEATURE-004** Create settings panel
  - WebSocket reconnect interval
  - Activity log retention (number of entries)
  - Display preferences (font size, colors)
  - Export settings to JSON

## Phase 7: Audio Integration (Optional)

- [ ] **AUDIO-001** Design audio player component
  - Audio level meter
  - Mute/unmute toggle
  - Volume slider
  - Audio source indicator

- [ ] **AUDIO-002** Implement audio stream handling
  - WebRTC stream receiver (future backend support)
  - Local audio monitoring (if backend provides URL)
  - Latency monitoring
  - Buffer underrun handling

## Phase 8: Polish & UX

- [ ] **UX-001** Add loading states
  - Skeleton screens for initial load
  - Spinner for in-progress actions
  - Disabled state for controls during disconnection
  - Error boundaries for component crashes

- [ ] **UX-002** Implement notifications/toasts
  - Success messages (frequency changed, sync complete)
  - Error messages (backend disconnected, invalid input)
  - Info messages (scanning started, hold activated)
  - Auto-dismiss with manual close option

- [ ] **UX-003** Add visual feedback
  - Button press animations
  - Active state for scan/hold
  - Pulse effect for signal strength updates
  - Transition animations between states

- [ ] **UX-004** Improve accessibility
  - ARIA labels for controls
  - Keyboard navigation support
  - Focus management
  - Screen reader announcements for state changes

## Phase 9: Testing

- [ ] **TEST-001** Set up testing framework
  - Vitest or Jest configuration
  - React Testing Library (or Vue Testing Library)
  - Mock service worker for API mocking
  - Coverage reporting

- [ ] **TEST-002** Write component tests
  - Virtual Display rendering
  - Transport Controls interactions
  - Activity Log updates
  - State transitions

- [ ] **TEST-003** Write integration tests
  - WebSocket connection lifecycle
  - State updates from backend messages
  - User interactions triggering API calls
  - Error handling flows

- [ ] **TEST-004** Create mock backend for development
  - Mock WebSocket server
  - Simulated state updates
  - Configurable scenarios (scanning, hits, errors)
  - Standalone mode for UI-only development

## Phase 10: Deployment

- [ ] **DEPLOY-001** Optimize production build
  - Code splitting by route
  - Lazy loading for heavy components
  - Asset compression (gzip/brotli)
  - CDN preparation (if applicable)

- [ ] **DEPLOY-002** Create standalone deployment option
  - Static file server configuration
  - Environment variable injection
  - CORS configuration documentation
  - Docker container (optional)

- [ ] **DEPLOY-003** Integrate with backend serving
  - Backend serves frontend assets
  - API and UI on same origin (no CORS needed)
  - Versioning strategy
  - Health check for UI availability

## Phase 11: Documentation

- [ ] **DOCS-001** Write user guide
  - Quick start instructions
  - Feature overview with screenshots
  - Keyboard shortcuts reference
  - Troubleshooting common issues

- [ ] **DOCS-002** Write developer guide
  - Local development setup
  - Architecture overview
  - State management patterns
  - Adding new components

- [ ] **DOCS-003** Create UI component storybook
  - Storybook setup (optional)
  - Stories for each component
  - Interactive prop controls
  - Visual regression testing baseline

## Phase 12: Future Enhancements

- [ ] **FUTURE-001** Mobile-optimized layout
  - Touch-friendly controls
  - Gesture support (swipe for channel change)
  - Portrait/landscape adaptation
  - iOS/Android PWA manifest

- [ ] **FUTURE-002** Native wrapper support
  - Electron shell for desktop app
  - Tauri for lightweight native binary
  - macOS menu bar integration
  - Windows system tray integration

- [ ] **FUTURE-003** Advanced visualizations
  - Spectrum waterfall display (if backend provides FFT)
  - Signal strength history graph
  - Channel activity heatmap
  - Geographic hit mapping (with location data)

- [ ] **FUTURE-004** Multi-scanner support
  - Scanner selection dropdown
  - Tabbed interface for multiple scanners
  - Synchronized control of scanner groups
  - Aggregate activity log
