# Testing Strategy for Uniden Scanner App

## Overview

This document describes the comprehensive QA testing strategy for the Uniden Scanner application, which consists of a React frontend and Python FastAPI backend.

## Testing Philosophy

**Goal**: Ensure every control in the UI does what it is supposed to do and the app behaves as expected.

**Approach**: Test at multiple levels:
1. **Unit Tests**: Test isolated functions and components
2. **Integration Tests**: Test interactions between modules
3. **Component Tests**: Test UI controls and user interactions
4. **API Tests**: Test frontend-backend communication
5. **E2E Tests**: Test complete user workflows (manual only)

## Testing Pyramid

```
        ┌─────────────┐
        │  E2E Tests  │  Manual, Real browser
        ├─────────────┤
        │ Integration  │  API contract, WebSocket
        │    Tests      │  Component interactions
        ├─────────────┤
        │  Component   │  User interactions, API calls
        │   Tests      │  Render, props, state
        ├─────────────┤
        │   Unit       │  Pure functions, utilities
        │   Tests      │  No side effects
        └─────────────┘
```

## Frontend Testing

### Test Infrastructure

#### Test Utilities (`frontend/src/test/`)

**Utils** (`utils/`):
- `renderWithProviders()` - Wrap components with store, API client, theme
- `renderHookWithProviders()` - Test hooks with provider context
- `mockApiResponse()` - Mock async responses with delays
- `mockFetch()` / `resetMockFetch()` - Global fetch mocking
- `mockFetchError()` / `mockFetchNetworkError()` - Mock fetch failures

**Mocks** (`mocks/`):
- `createMockStore()` - Zustand store mock with configurable state
- `createMockApiClient()` - API client mock with all methods and response/error config
- `mockWebSocket()` - WebSocket mock with connection state and message handling

**Fixtures** (`fixtures/`):
- `createTestChannel()` / `mockChannels` - Channel data factories
- `createTestLiveState()` / `mockLiveState` - Scanner state factories
- `createTestDeviceInfo()` / `mockDeviceInfo` - Device info factories
- `mockApiResponses` - Pre-configured API success responses
- `mockApiErrors` - Pre-configured API error responses

### Component Tests

**Focus**: Verify every UI control works correctly.

#### Test Coverage Areas

1. **ScannerUI Components**
   - `TabNav` - Tab navigation, connection status display
   - `StatusHeader` - Volume, recording, lockout, hold, dashboard toggle
   - `ScannerDisplay` - Main display, signal strength, error states
   - `BankControls` - 10 bank toggle buttons

2. **Device Tab Components**
   - Sync category - Start sync button, progress display
   - Locked Channels - Search, filter, select all, unlock selected/all
   - Device Config - Sliders (volume, squelch, battery, contrast), selects (backlight, key beep, priority), switches
   - Close Call - Mode select, switches, band toggles
   - Service Search - Group switches
   - Custom Search - Range enable, label, start/end inputs
   - Preferences - External links, reset, hit duration slider, dashboard mode switch

3. **Channels Tab Components**
   - Bank navigation (1-10)
   - Search/filter
   - Import CSV button
   - Export CSV button
   - Channel edit button

4. **Channel Edit Sheet**
   - All inputs (frequency, alpha tag, modulation, tone squelch, delay)
   - Lockout/priority switches
   - Save/cancel buttons
   - Validation (required fields, value ranges)

5. **Activity Export Sheet**
   - Timeframe selection (today/week/month/all/custom)
   - Date pickers
   - Download CSV button

#### Test Patterns

**For Each Control**:
1. **Rendering**
   - Verify control appears in DOM
   - Verify correct initial state/props
   - Verify conditional rendering (disabled states, error states)

2. **User Interactions**
   - Click button and verify callback is called
   - Type in text input and verify value updates
   - Drag slider and verify value changes
   - Toggle switch and verify state changes
   - Select dropdown option and verify callback

3. **State Updates**
   - Verify state changes after interaction
   - Verify API calls with correct parameters
   - Verify loading states during async operations

4. **Error Handling**
   - Simulate API errors
   - Verify error messages display
   - Verify retry mechanisms
   - Verify disabled states during errors

5. **Edge Cases**
   - Empty values, max/min values
   - Rapid repeated clicks
   - Network errors, timeouts
   - Concurrent interactions

### API Client Tests

**Focus**: Verify frontend-backend API communication.

#### Test Coverage

1. **Commands**
   - `sendHold()`, `sendScan()`, `sendKey(key)`
   - Success responses
   - Network failures
   - 503 errors (device disconnected)

2. **Status & Device**
   - `getStatus()`, `getDeviceInfo()`
   - Verify response parsing
   - Error handling

3. **Banks**
   - `getBanks()`, `setBanks(banks)`
   - Array length validation
   - Error on invalid length

4. **Channels**
   - `getChannels()`, `getChannel(index)`
   - `updateChannel(index, payload)`
   - Invalid channel index (404)
   - Invalid frequency (out of range)
   - Invalid delay (0-30)
   - Invalid bank (1-10)
   - Alpha tag too long

5. **Lockouts**
   - `toggleTemporaryLockout()`, `togglePermanentLockout()`
   - `clearTemporaryLockouts()`, `clearGlobalLockouts()`, `clearChannelLockouts()`
   - Frequency and channel lockouts

6. **Settings**
   - All device settings (backlight, battery, key beep, priority, etc.)
   - GET/SET for each setting
   - Invalid values (out of range)

7. **Memory Sync**
   - `syncMemory()`, `syncMemory({ force: true })`
   - Handle "already_running" status
   - Export formats (BC125AT SS, CSV)
   - Import CSV with validation errors

8. **Preferences**
   - `getAllPreferences()`, `getPreference(key)`, `setPreference(key, value)`, `setPreferences(prefs)`, `resetPreferences()`
   - Verify persistence

9. **Analytics**
   - `getBusiestChannels()`, `getHourlyHeatmap()`, `getSessionStats()`, `getActivityLog()`
   - Query parameters (limit, hours, timeframe)

10. **APIError Class**
   - Verify error structure (status, message, payload)
   - Verify instanceof Error
   - Verify correct status codes

### WebSocket Tests

**Focus**: Verify real-time communication and message handling.

#### Test Coverage

1. **Connection Lifecycle**
   - Auto-connect on mount
   - Reconnection on disconnect
   - Connection failure handling
   - Exponential backoff for reconnection

2. **Message Handling**
   - Subscribe/unsubscribe to topics (state, events, progress, errors)
   - `state_update` messages with sequence tracking
   - `event` messages (scan_hit, state_stale)
   - `progress` messages (memory sync)
   - `error` messages
   - `ping`/`pong` heartbeat

3. **Message Parsing**
   - Verify correct parsing of all message types
   - Verify data structure
   - Handle malformed messages

4. **Cleanup**
   - Verify unsubscribe on unmount
   - Verify connection cleanup

## Backend Testing

### Test Infrastructure

#### Test Utilities (`backend/tests/`)

**Fixtures** (`fixtures.py`):
- `create_channel()` - Channel data factory
- `create_live_state()` - Live state factory
- `create_device_info()` - Device info factory
- `create_shadow_state()` - Shadow state factory
- `create_analytics_hit()` - Analytics hit factory
- `create_settings()` - Settings factory
- `create_lockouts_response()` - Lockouts response factory

**Stubs** (`stubs.py`):
- `MockDriver` - ScannerDriver implementation with call tracking
- `MockScheduler` - Async scheduler with configurable responses
- `MockTransport` - Transport mock with connection state

**Helpers** (`helpers.py`):
- `setup_test_app()` - Context manager for FastAPI app with mocked runtime
- `wait_for_condition()` - Async wait with timeout and interval
- `assert_api_error()` - HTTP error assertion helper
- `assert_success()` - Success response assertion helper

### API Endpoint Tests

**Focus**: Verify backend API endpoints and business logic.

#### Test Coverage

1. **Health & Status**
   - `/api/v1/status` - Live state polling
   - `/api/v1/health` - Health check
   - `/api/v1/device/info` - Device information

2. **Commands**
   - `/api/v1/commands/hold` - Enter hold mode
   - `/api/v1/commands/scan` - Enter scan mode
   - `/api/v1/commands/key` - Send keypress
   - Auto-resume scan after lockout operations

3. **Bank Management**
   - `/api/v1/banks` (GET) - Get bank states
   - `/api/v1/banks` (POST) - Set bank states
   - Array length validation

4. **Lockouts**
   - `/api/v1/commands/lockout` - Toggle lockout (temporary/permanent)
   - `/api/v1/lockouts` - Get all lockouts
   - `/api/v1/lockouts/{frequency}` - Check if frequency locked
- `/api/v1/lockouts/temporary/clear` - Clear temporary lockouts
   - `/api/v1/lockouts/clear` - Clear global lockouts
   - `/api/v1/lockouts/channels/clear` - Clear channel lockouts

5. **Volume & Squelch**
   - `/api/v1/volume` - Set volume (0-15)
   - `/api/v1/squelch` - Get squelch level
   - `/api/v1/squelch` - Set squelch level (0-15)
   - Out of range validation

6. **Device Settings** (BC125AT specific)
   - All `/api/v1/settings/*` endpoints
   - Backlight, battery, key beep, priority
   - Search/close call settings
   - Service search groups
   - Custom search groups and ranges
   - Weather priority
   - Contrast

7. **Memory Management**
   - `/api/v1/memory/channels` - Get channels (with optional bank filter)
   - `/api/v1/memory/channels/{index}` - Get specific channel
- `/api/v1/memory/channels/{index}` (PUT) - Update channel
   - Input validation:
     - Channel index: 1-500
     - Frequency: 25-1300 MHz
     - Delay: 0-30 seconds
     - Bank: 1-10
     - Alpha tag: max 16 chars
   - `/api/v1/memory/sync` - Start memory sync
   - Handle "already_running" status
   - `/api/v1/memory/sync/cancel` - Cancel running sync
   - `/api/v1/memory/export/bc125at_ss` - Export scanner format
   - `/api/v1/memory/export/csv` - Export CSV format
   - `/api/v1/memory/import/csv` - Import CSV with validation

8. **Preferences**
   - `/api/v1/preferences` - Get all preferences
   - `/api/v1/preferences/{key}` - Get specific preference
- `/api/v1/preferences/{key}` (PUT) - Set specific preference
- `/api/v1/preferences` (PUT) - Set multiple preferences
- `/api/v1/preferences` - POST - Reset to defaults
   - Validation: valid preference keys and value types

9. **Analytics**
   - `/api/v1/analytics/busiest-channels` - Get busiest channels
- `/api/v1/analytics/hourly-heatmap` - Get activity heatmap
- `/api/v1/analytics/session-stats` - Get session statistics
- `/api/v1/analytics/activity-log` - Get activity log with filters
- `/api/v1/analytics/cleanup` - Delete old analytics data
   - 503 when analytics disabled

10. **Error Handling**
   - All endpoints should return 503 when device disconnected
   - Return 400 for invalid inputs (out of range, wrong type)
   - Return 404 for not found resources
   - Return 500 for internal errors
   - Proper error messages in JSON response

### WebSocket Tests

**Focus**: Verify WebSocket communication and broadcasting.

#### Test Coverage

1. **Connection Management**
   - Accept and handle WebSocket connections
   - Track connected clients
   - Send ping every 30 seconds
   - Disconnect clients not responding to ping (10s timeout)

2. **Subscription & Topics**
   - Subscribe to topics: state, events, progress, errors
   - Only send subscribed topic messages to clients
   - Unsubscribe from topics

3. **Message Broadcasting**
   - `state_update` - On any live state change
   - `event` - On scan hits, mode changes, state stale
   - `progress` - During memory sync
   - `error` - On critical errors

4. **Message Format**
   - Verify all message types have correct `type` field
   - Verify sequence numbers in state_update
   - Verify timestamp fields
   - Verify data fields match expected types

### Integration Tests

**Focus**: Verify complete workflows and module interactions.

#### Test Coverage

1. **Status Polling Loop**
   - Continuous status polling when connected
   - Skip polling during high-priority commands
   - State change detection and WebSocket broadcast
   - Squelch open handling:
     - Get GLG status on squelch open
     - Record analytics hit
     - Broadcast `scan_hit` event
   - Record hit duration on squelch close
   - Mark state stale after 3+ consecutive failures

2. **Lockout Workflow**
   - Temporary lockout: In-memory toggle, no persistence
   - Permanent lockout: Write to device, persist shadow
   - Auto-resume scan after lockout:
     - Wait 1s
     - Send scan command
     - Wait 0.6s, send scan again
     - Verify mode is SCAN after 0.8s

3. **Memory Sync Workflow**
   - Enter program mode (force HOLD if in SCAN)
   - Read 500 channels sequentially
   - Publish progress every 10 channels
   - Update shadow state and persist
   - Handle cancel: stop reading, restore mode, cancel status broadcast
   - Update channels list in store

4. **Channel Write Flow**
   - Validate all inputs
   - Enter program mode
   - Read existing channel
   - Write new channel data
   - Read back to verify
   - Retry if mismatch (up to 3 attempts)
   - Raise exception if still mismatched

5. **Analytics Recording**
   - Record hit on squelch open
   - Track duration during squelch open
   - Store with timestamp, frequency, channel, tag, rssi
   - Close hit on squelch close with duration

6. **Preferences Persistence**
   - Load on app startup
- Update via API
- Apply to UI components (dashboard mode, hit duration, etc.)
- Verify changes persist across restarts

## E2E Testing

**Focus**: Manual testing of complete user workflows.

### Test Scenarios

1. **Basic Workflow**
   - Connect to scanner
   - View status display (frequency, mode, signal strength)
   - Toggle between scan/hold modes
   - Adjust volume and squelch
   - Navigate between tabs (Scan, Device, Channels)

2. **Channel Management**
   - Switch between banks (1-10)
   - Search/filter channels
   - Edit a channel (frequency, tag, modulation, delay, etc.)
   - Save and verify persistence
   - Export channels to CSV
   - Import channels from CSV

3. **Lockout Operations**
   - Lockout current frequency (L/O button single-click)
   - Lockout current channel (L/O button double-click)
   - Unlock channels from Locked Channels tab
   - View lockout list

4. **Device Configuration**
   - Start memory sync
   - Adjust device settings (volume, squelch, contrast, etc.)
   - Configure close call settings
   - Set service search groups
   - Set custom search ranges
   - Reset preferences to defaults

5. **Keyboard Shortcuts**
   - Ctrl+S (scan)
   - Ctrl+H (hold)
   - Ctrl+L (lockout)
   - Ctrl+Shift+L (activity log)
   - Ctrl+M (channels)
   - Ctrl+Arrow Up/Down (navigation)

### Mock Hardware Server

A mock hardware server should simulate scanner responses for E2E testing without real hardware.

#### Implementation

- Pseudo-terminal for serial communication
- Responds to protocol commands (STS, GLG, PRG, etc.)
- Configurable responses (valid, error, timeout)
- BC125AT-family protocol only

## Test Execution

### Automated Tests (CI/CD)

```yaml
# .github/workflows/test.yml
name: Tests

on: [push, pull_request]

jobs:
  unit-tests:
    runs-on: ubuntu-latest
    steps:
      - Run backend tests (unittest)
      - Run frontend unit tests (Vitest)

  component-tests:
    runs-on: ubuntu-latest
    steps:
      - Run frontend component tests (Vitest)

  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - Run API client tests (Vitest)
      - Run backend integration tests (unittest)

  e2e-tests:
    if: github.event_name == 'workflow_dispatch'
    runs-on: ubuntu-latest
    steps:
      - Start mock hardware server
      - Run Playwright E2E tests
```

### Manual Tests (Developer)

```bash
# Run all tests locally
cd frontend && npm test

# Run specific test file
npm run test -- path/to/test.test.tsx

# Run tests with UI
npm run test:ui

# Run coverage report
npm run test:coverage

# Run backend tests
cd backend && source .venv/bin/activate && python -m unittest discover -s tests

# Run hardware tests (requires device)
cd backend && HARDWARE_TESTS=1 python -m unittest tests.test_hardware
```

## Coverage Targets

| Layer | Target | Current | Target |
|-------|--------|---------|--------|
| Frontend components | 0% | 80% |
| Frontend API client | 0% | 90% |
| Frontend hooks | 50% | 85% |
| Backend API endpoints | 30% | 80% |
| Backend logic | 40% | 85% |
| WebSocket (both) | 0% | 75% |
| Overall | ~10% | 75% |

## Known Issues & Workarounds

### ResizeObserver in jsdom

Some UI components use `useResizeObserver` from Radix UI which requires `ResizeObserver` polyfill in jsdom. This causes test failures in certain components.

**Workaround**: Focus on testing component behavior and state changes rather than full rendering of all sub-components.

### SVG Elements

SVG elements in icons don't always have `role="img"` attribute.

**Workaround**: Use `container.querySelector("svg")` instead of `screen.queryByRole("img")`.

### Hardware Dependency

Backend tests marked with `@unittest.skipUnless(HARDWARE_TESTS=1)` require a physical scanner connected.

**Workaround**: Tests are skipped in CI by default; run manually with `HARDWARE_TESTS=1`.

## Continuous Improvement

1. **Add more component tests** - Currently 0% coverage, target 80%
2. **Complete API client tests** - Currently partial, target 90%
3. **Add WebSocket tests** - Currently 0%, target 75%
4. **Add backend integration tests** - Target 85%
5. **Set up CI/CD pipeline** - Target automated test runs
6. **Add E2E tests with mock hardware** - Target manual workflow testing
