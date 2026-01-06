# Frontend (Web UI) Todo List

> **UX Philosophy: "Radio First, Computer Second"**
>
> The UI should feel like using a scanner, not configuring software. Follow the hierarchy:
> - **Primary (always visible):** Alpha tag (large), metadata row (signal, CH, mode, MHz), Scan/Hold toggle
> - **Secondary (collapsible):** Current Bank Channels (below controls)
> - **Progressive (hidden until needed):** Direct Tune, Full Memory Browser, Activity Log, Settings
>
> **Design:** Single-column, mobile-first, centered on desktop (max-width: 640px)
>
> See FRONTEND_SPEC.md § 1.4 for full UX principles and § 1.2 for device-agnostic design.

---

## Phase 1: Project Foundation

- [x] **PROJECT-001** Initialize frontend project
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

- [ ] **PROJECT-004** Implement device-agnostic design principles
  - **NEVER hardcode** frequency ranges, bank counts, channel counts, or model-specific features
  - **ALWAYS query** device capabilities from backend API
  - Display model name from `deviceInfo.model` (never hardcoded)
  - Validate user input against device-specific limits from API
  - UI adapts to device capabilities without special cases
  - See FRONTEND_SPEC.md § 1.2 for full guidelines

## Phase 2: API Integration

- [x] **API-001** Create REST client module
  - Base HTTP client (fetch or axios)
  - Error handling and retry logic
  - Request/response interceptors
  - TypeScript types from OpenAPI spec

- [x] **API-002** Implement control command functions
  - `sendHold()` - POST /commands/hold
  - `sendScan()` - POST /commands/scan
  - `sendKey(keyCode)` - POST /commands/key
  - `setFrequency(freq)` - POST /frequency

- [x] **API-003** Implement query functions
  - `getStatus()` - GET /status
  - `getDeviceInfo()` - GET /device/info
  - `getChannels()` - GET /memory/channels
  - `syncMemory()` - POST /memory/sync

- [x] **WS-001** Create WebSocket client
  - Connection management (connect, disconnect)
  - Auto-reconnect with exponential backoff
  - Heartbeat/ping-pong
  - Connection state tracking

- [x] **WS-002** Implement message handling
  - Parse incoming JSON messages
  - Type guards for message discrimination
  - Message queue for offline buffering
  - Event emitter for message dispatch

- [x] **WS-003** Create WebSocket service hook/composable
  - React: `useWebSocket()` hook
  - Vue: `useWebSocket()` composable
  - Subscribe to specific message types
  - Automatic cleanup on unmount

## Phase 3: State Management

- [x] **STATE-001** Design client-side state structure
  - Live state (frequency, mode, RSSI, squelch)
  - Device info (model, connection status)
  - Shadow state (channels, alpha tags)
  - UI state (selected view, preferences)

- [x] **STATE-002** Implement state store
  - Zustand (React) or Pinia (Vue)
  - Actions for state updates
  - Selectors for derived state
  - Persistence for UI preferences (localStorage)
  - Sequence number tracking for stale state prevention

- [x] **STATE-003** Connect WebSocket to state store
  - Listen for state update messages
  - Merge updates into local state
  - Handle out-of-order messages with sequence number validation
  - Optimistic updates for control commands
  - Reject stale updates (sequence number <= last processed)

- [x] **STATE-004** Implement connection state management
  - Connected, disconnected, connecting states
  - Backend availability detection
  - Retry attempts tracking
  - User notification on status change

## Phase 4: Core Components

- [x] **COMP-001** Create Virtual Display component (Two States - Figma design)
  - LCD-style text rendering (monospace font)
  - High contrast (green-on-black or amber-on-black)
  - **STATE 1 - SCANNING:** "Scanning..." text, only signal icon in metadata
  - **STATE 2 - LISTENING:** Alpha tag (large), full metadata row
  - Conditional rendering based on `liveState.mode === "SCAN" && !channel`
  - Optional: Animated dots for "Scanning..." state

- [x] **COMP-002** Add Virtual Display metadata row (State-aware)
  - **Scanning state:** Only signal strength icon visible
  - **Listening state:** Full metadata row:
    - Signal strength (Font Awesome icon, left)
    - Channel ("CH67" or "DIRECT")
    - Mode ("FM", "AM", "NFM")
    - Frequency ("442.1250 MHz", right-aligned)
  - Responsive spacing, readable on mobile

- [x] **COMP-003** Create Signal Strength Indicator (Font Awesome)
  - **Font Awesome icons:** `fa-signal-weak` through `fa-signal` (5 levels)
  - RSSI value (0-100%) determines which icon to show
  - Color coding: red (weak <40%), yellow (medium 40-70%), green (strong >70%)
  - Integrated into Virtual Display metadata row
  - Install: `npm install @fortawesome/fontawesome-free`
  - ARIA labels for accessibility

- [x] **COMP-004** Create Primary Controls component (Single Toggle)
  - **Single Scan/Hold toggle button** (not two separate buttons)
  - Button changes label and state when clicked
  - Shows "🔄 Scan" when scanning (green background)
  - Shows "⏸ Hold" when holding (orange background)
  - Large, touch-friendly (min 44x44px / 60px recommended)
  - aria-pressed attribute for accessibility
  - Backend manages state, UI reflects current mode

- [x] **COMP-005** Create Direct Tune Modal (progressive disclosure)
  - Frequency input with validation (xxx.xxxx format)
  - **DEVICE-AGNOSTIC:** Validate using device capabilities API, NOT hardcoded ranges
  - Query device min/max frequency from backend, display in error messages
  - Modulation selector (FM/AM/NFM/AUTO)
  - Modal overlay (dims background, click-outside to close)
  - Keyboard shortcuts (Ctrl/Cmd+F to open, Escape to close, Enter to submit)
  - Auto-focus input on open

- [x] **COMP-006** Create Memory Browser Panel (progressive disclosure)
  - Channel list table (index, frequency, tag, bank)
  - Filter by bank (dropdown)
  - Search by alpha tag or frequency
  - Click to tune functionality
  - Slide-out panel or separate view
  - Close button and escape key support

- [x] **COMP-007** Create Activity Log component (SIMPLIFIED)
  - **LIMITED:** Show only last 10 entries (not 100)
  - Collapsible panel (collapsed by default on mobile)
  - Timestamped entries (relative: "2m ago" or absolute)
  - Frequency and alpha tag only (no duration field)
  - Click to tune functionality
  - Empty state message when no entries
  - **DEPRIORITIZED:** Moved to progressive disclosure, not always visible

- [x] **COMP-008** Create Current Bank Quick View component (Below Controls)
  - **Positioned below primary controls** in single-column layout
  - **Collapsible** with toggle button (▼/▶ icon)
  - Show channels in currently active bank only
  - Highlight currently active channel with ● indicator
  - Grid layout: CH# | Frequency | Alpha Tag
  - Click any channel to tune directly
  - "Browse All Channels →" button at bottom
  - Returns `null` if not scanning a bank (hidden)
  - Max-height with scrolling for long lists
  - Starts expanded on desktop, collapsed on mobile

## Phase 5: Layout & Navigation

- [x] **LAYOUT-001** Design responsive layout (Single-Column, Mobile-First)
  - **Single-column layout** on all screen sizes
  - **Centered on desktop** with max-width: 640px (or 800px)
  - **Mobile-first:** Stack vertically (header → display → controls → bank view)
  - Container: `width: 100%; max-width: 640px; margin: 0 auto;`
  - Padding: 1rem desktop, 0.5rem mobile
  - Signal strength in metadata row (Font Awesome icons)
  - Current Bank View below controls (collapsible)
  - Activity log in modal/menu (deprioritized)
  - Dark mode support

- [x] **LAYOUT-002** Create app shell component
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

- [ ] **FEATURE-001** Enhance Memory Browser (extends COMP-006)
  - Sort by column (frequency, tag, bank)
  - Multi-column sorting
  - Lockout indicator and toggle
  - Priority indicator
  - Advanced filtering (lockout status, modulation)

- [ ] **FEATURE-002** Implement memory sync UI
  - Progress bar during sync
  - Cancel sync button
  - Success/error notification
  - Last sync timestamp display

- [x] **FEATURE-003** Add keyboard shortcuts (IMPORTANT: replaces on-screen channel buttons)
  - Require Ctrl/Cmd modifier to avoid conflicts with assistive tech
  - Ctrl/Cmd+S: start scan
  - Ctrl/Cmd+H: hold current frequency
  - Ctrl/Cmd+F: open direct tune modal
  - Ctrl/Cmd+M: open full memory browser
  - Ctrl/Cmd+B: jump to current bank view (NEW)
  - Ctrl/Cmd+C: copy current frequency to clipboard (NEW)
  - Ctrl/Cmd+↑/↓: channel up/down (PRIMARY navigation method)
  - Escape: close modals/panels (no modifier needed)
  - Keyboard shortcut help panel showing all shortcuts

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

## Phase 8: Accessibility (WCAG 2.1 AA Compliance)

- [x] **A11Y-001** Implement ARIA live regions
  - Polite announcements for frequency changes
  - Assertive announcements for scan hits
  - Activity log announcements for new entries
  - Connection status announcements
  - Screen reader only text (.sr-only CSS class)

- [x] **A11Y-002** Implement focus management
  - Modal focus trapping (trap focus in open modals)
  - Focus restoration (return focus when closing modals)
  - Skip links (skip to main content, skip to controls)
  - Focus indicators for all interactive elements
  - Keyboard shortcuts help panel

- [ ] **A11Y-003** Add semantic HTML and ARIA labels
  - Proper ARIA labels for all buttons
  - Role attributes (dialog, status, log, article)
  - aria-pressed for toggle buttons
  - aria-expanded for expandable controls
  - Landmark regions (main, navigation, complementary)

- [ ] **A11Y-004** Visual accessibility improvements
  - High contrast mode support (@media prefers-contrast: high)
  - Reduced motion support (@media prefers-reduced-motion: reduce)
  - Color contrast WCAG AA compliance (4.5:1 text, 3:1 UI)
  - Minimum 44x44px touch targets
  - Focus visible indicators

- [ ] **A11Y-005** Screen reader testing
  - Test with NVDA (Windows)
  - Test with JAWS (Windows)
  - Test with VoiceOver (macOS/iOS)
  - Validate with axe DevTools
  - Test at 200% zoom

## Phase 9: Mobile & PWA Optimization

- [x] **MOBILE-001** Implement iOS safe area handling
  - viewport-fit=cover meta tag
  - env(safe-area-inset-*) CSS variables
  - Safe area padding for header and controls
  - Test on iPhone X+ devices with notch

- [ ] **MOBILE-002** Create landscape layout
  - Horizontal flex layout for landscape orientation
  - Compact font sizes for limited vertical space
  - Side-by-side display/controls/log layout
  - Test on tablets in landscape mode

- [ ] **MOBILE-003** Implement PWA configuration
  - Create manifest.json (icons, name, theme color)
  - Service worker with cache strategy
  - iOS-specific meta tags (apple-mobile-web-app-*)
  - Install prompt handling
  - Offline capability for static assets

- [ ] **MOBILE-004** Add battery-aware behavior
  - Detect battery level with Battery API
  - Reduce WebSocket poll rate when battery < 20%
  - Optional: Reduce animation complexity on low battery
  - Test on mobile devices

## Phase 10: Polish & UX

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

## Phase 11: Testing

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

## Phase 12: Deployment

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

## Phase 13: Documentation

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

## Phase 14: Future Enhancements

- [ ] **FUTURE-001** Advanced mobile features
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
