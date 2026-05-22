# App Views Documentation

This document explains how each view in the Bearpaw app works, including timing requirements, modes, and behaviors.

---

## Scan View

The Scan view is the main interface for monitoring scanner activity in real-time.

### Connection Status
The connection status LED and text display show the current state:
- **Green** (`#67E79E`): Connected to scanner, shows model name (e.g., "BC125AT")
- **Amber** (`#F59E0B`): Connecting, displays "Connecting..."
- **Red** (`#DC3A38`): Disconnected, displays "Disconnected"

Connection status is determined by WebSocket connection state and device info.

### Display Area
The large orange gradient display shows current scanner state with two modes:

#### Monitor Mode (Default)
Shows information when scanner receives a signal:
- **Main text**: Channel alpha tag OR frequency (formatted to 4 decimal places)
- **Sub text**: Shows frequency • modulation • channel number (if known)
- Example: "ASH3D Flappy Fart" with subtext "444.5250 • NFM • CH67"

#### Scanning Mode
When no signal is present:
- **Main text**: "Scanning..." (with pulse animation)
- **Sub text**: "Searching for signal..."

#### Error States
When disconnected, shows error icon:
- USB Error icon for USB disconnection
- Socket Error icon for WebSocket disconnection

### Control Buttons

#### VOL (Volume)
- **Purpose**: Adjust scanner audio volume
- **Control**: Slider from 0 to 20
- **Behavior**: Sends `setVolume` command to scanner
- **Mode Requirement**: Works in any mode

#### L/O (Lockout)
- **Purpose**: Temporary or permanent lockout of current frequency
- **Single Click**: Temporary lockout (clears automatically)
- **Double Click**: Permanent lockout (must be cleared manually)
- **Behavior**:
  - Temporary lockout creates entry in `temporary_channels` list
  - Permanent lockout sets channel `lockout` flag to true
  - After lockout, if in HOLD mode, waits 1 second then resumes scan
- **Mode Requirement**: Must be in SCAN mode to lockout current frequency

#### HOLD
- **Purpose**: Pause scanning on current signal
- **Behavior**:
  - Toggles between SCAN and HOLD modes
  - In HOLD, scanner stays on current channel
  - Button border and text turn orange (`#ef991f`) when active
- **Mode Requirement**: Works in SCAN or HOLD mode

### Bank Controls
- **Purpose**: Enable/disable scan banks (1-10, 0 displayed for bank 10)
- **Behavior**: Toggles bank on/off via `setBanks` API call
- **Visual**: Active banks show orange text and border, inactive show gray
- **Mode Requirement**: Works in any mode
- **Note**: Updates happen immediately when clicked (500ms debounce not used)

### Monitor/Dashboard Toggle
- **Purpose**: Switch between compact Monitor view and expanded Dashboard view
- **Monitor**: Smaller display, shows only recent hits list (compact)
- **Dashboard**: Larger display, shows session statistics and analytics widgets

### Recent Hits List
Shows the last 50 scan hits that opened squelch.

**Data displayed per hit**:
- **Tag**: Channel alpha tag or "—" if none
- **Frequency**: Monospace, orange color when hovered
- **Signal strength**: 5-bar indicator (green bars)
- **Time ago**: Relative time (e.g., "5m ago", "2h ago")

**Behavior**:
- New hits are added at top of list via WebSocket events
- Clicking a hit does nothing (display only)
- List automatically maintains last 50 entries

**Monitor vs Dashboard display**:
- **Monitor**: Compact list with smaller text
- **Dashboard**: Larger entries with more spacing

### Dashboard Widgets (Dashboard Mode Only)

#### Session Stats Bar
Shows three metrics from current session:
- **Session Hits**: Total number of scan hits
- **Unique Channels**: Number of different channels hit
- **Active Time**: Time scanner has been active (format: "MM:SS")

Stats refresh every **5 seconds** via API polling.

#### Busiest Channels Chart
- **Purpose**: Bar chart showing most active channels in last 24 hours
- **Data**: Top 5 channels by hit count
- **Refresh**: Every 5 seconds via API polling
- **Empty state**: Shows "Loading..." or "No data yet"

#### Activity Heatmap
- **Purpose**: 7x24 grid showing activity by day and hour
- **X-axis**: 00-23 (hours of day)
- **Y-axis**: Mon-Sun
- **Cell intensity**: Darker green = more activity (scales 0-5 based on hit count divided by 10)
- **Refresh**: Every 5 seconds via API polling
- **Empty state**: Shows "Loading..." or "No data yet"

### Sidebar Stats (Dashboard Mode Only)
Shows three metrics (same as top bar but vertical layout):
- **Hits**: Same as Session Hits
- **Active**: Same as Active Time
- **Channels**: Same as Unique Channels

### Auto-Refresh Intervals (Scan View)
- **Device info refresh**: Every 5 seconds (5000ms)
- **Temporary lockouts refresh**: Every 5 seconds (5000ms)
- **Analytics (dashboard only)**: Every 5 seconds (5000ms)

### Activity Log Button
- **Purpose**: Open activity log modal
- **Behavior**: Shows modal with scan hit history
- **Data source**: `/analytics/activity-log` API endpoint
- **Pagination**: Loads 50 entries initially, "Load More" button loads additional entries
- **Columns displayed**:
  - **Time**: Timestamp in local time (HH:MM:SS format)
  - **Frequency**: Monospace, orange color (4 decimal places)
  - **Tag**: Alpha tag or "—"
  - **Channel**: Channel number (if available)
  - **Duration**: Hit duration (if available)
  - **Signal**: Visual indicator (circle with opacity based on RSSI)
- **Loading**: Shows "Loading..." while fetching data
- **Empty state**: Shows "No activity recorded"
- **Modal size**: 500px width, 600px max height

### Mode Detection
The app automatically detects scanner mode from live state:
- **SCAN**: Normal scanning mode
- **HOLD**: Paused on current channel
- **SEARCH**: Direct frequency search
- **CLOSE_CALL**: Close call mode

Detection logic:
```javascript
if (mode === "DIRECT") → "SEARCH"
if (mode === "CLOSE_CALL") → "CLOSE_CALL"
if (mode === "HOLD") → "HOLD"
else → "SCAN"
```

---

## Device View

The Device view has 7 categories: Sync, Locked Channels, Device Config, Close Call, Service Search, Custom Search, and Preferences.

### Category: Sync

Shows memory synchronization status and controls.

#### Sync Button
- **Purpose**: Start channel memory sync from scanner to backend
- **Behavior**:
  - Calls `syncMemory` API with `{ force: true }`
  - Shows sync progress with percentage
  - Sync runs automatically on first load if no channels exist
- **Mode Requirement**: **PROGRAM MODE** must be on
- **Note**: Sync cannot be started if already running

#### Sync Progress Display
- **Shows**: "Scanning channel {n} of 500..."
- **Updates**: Via WebSocket progress messages
- **Completion**: When `percent >= 100` or "sync complete" message received
- **After completion**:
  - Refreshes channel list from API
  - Sends `sendScan()` command to resume scan mode
  - Locks button until sync completes

### Category: Locked Channels

Shows all channels that have been locked out (permanently or temporarily).

#### Lockout List
- **Data source**: `getLockouts({ includeFrequencies: false })`
- **Refresh interval**: Every 5 seconds (5000ms)
- **Columns**:
  - **Select**: Checkbox for bulk selection
  - **CH**: Channel number
  - **Freq**: Frequency in MHz (4 decimal places)
  - **Tag**: Alpha tag
  - **Type**: "Permanent" or "Temporary"
  - **Bank**: Bank number
  - **Time**: Time since lockout (e.g., "2h ago")

#### Bank Filter
- **Purpose**: Filter locked channels by bank
- **Options**: "All" or individual banks 1-10
- **Behavior**: Updates list to show only matching channels

#### Search
- **Purpose**: Filter by frequency or alpha tag
- **Behavior**: Real-time filter as you type
- **Searches**: Both frequency and alpha tag fields

#### Bulk Actions
- **Unlock Selected**: Clears lockout for selected channels
- **Select All**: Toggles all checkboxes
- **Behavior**:
  - Calls `clearChannelLockouts` API
  - Updates channel list to clear `lockout` flag
  - Removes from temporary lockout list
  - Shows success toast with count

#### Mode Requirement
- **Note**: Locked channels view works regardless of scanner mode

### Category: Device Config

Configures hardware settings on the scanner.

#### Squelch
- **Purpose**: Set squelch threshold (0-20)
- **Control**: Slider
- **Behavior**: Sends immediately when slider stops moving
- **Mode Requirement**: Works in any mode

#### Battery Saver
- **Purpose**: Set battery saver timeout (1-16)
- **Control**: Dropdown with 16 levels
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: Works in any mode

#### Backlight
- **Purpose**: Configure LCD backlight behavior
- **Options**:
  - "AO": Always On
  - "K": Key press only
  - "O": Off
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: Works in any mode

#### Contrast
- **Purpose**: Adjust LCD contrast (0-10)
- **Control**: Slider
- **Behavior**: Sends immediately when slider stops moving
- **Mode Requirement**: Works in any mode

#### Key Beep
- **Purpose**: Configure key press beep tone
- **Options**: Off, Auto, Level 1
- **Lock**: Prevents key beep from being changed by scanner
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: Works in any mode

#### Priority Mode
- **Purpose**: Set priority channel scan behavior
- **Options**: Off, On, Plus
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: Works in any mode

#### Weather Alert
- **Purpose**: Enable weather alert priority
- **Control**: Toggle switch
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: Works in any mode

### Category: Close Call

Configures Close Call feature for automatically detecting nearby transmissions.

#### Mode
- **Purpose**: Set Close Call operating mode
- **Options**: Off, CC DND, CC Priority
- **Behavior**:
  - Off: Close Call disabled
  - CC DND: Do Not Disturb mode
  - CC Priority: Priority mode
- **Mode Requirement**: Works in any mode

#### Lockout
- **Purpose**: Lock out Close Call hits temporarily
- **Control**: Toggle switch
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: Works in any mode

#### Beep
- **Purpose**: Play beep on Close Call hits
- **Control**: Toggle switch
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: Works in any mode

#### Light
- **Purpose**: Flash LCD on Close Call hits
- **Control**: Toggle switch
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: Works in any mode

#### Bands
- **Purpose**: Enable Close Call frequency bands
- **Options**: 5 bands (toggle each on/off)
- **Band 1**: 25-54 MHz (VHF Low)
- **Band 2**: 108-174 MHz (Civil Air + VHF High)
- **Band 3**: 216-469.9575 MHz (UHF)
- **Band 4**: 806-960 MHz (800 MHz)
- **Band 5**: 1240-1300 MHz (Range 7)
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: Works in any mode

### Category: Service Search

Configures Service Search pre-programmed frequency ranges.

#### Service Groups
- **Purpose**: Enable/disable predefined service search groups
- **Options**: 8 groups (each toggle on/off)
- **Groups**:
  1. Police
  2. Fire/EMS
  3. Aircraft
  4. Ham
  5. Marine
  6. Railroad
  7. FRS/GMRS/MURS
  8. CB
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: **SEARCH or CLOSE_CALL mode** required

### Category: Custom Search

Configure custom frequency search ranges.

#### Search Ranges
- **Purpose**: Define custom frequency ranges to search
- **Count**: 10 ranges (each can be enabled/disabled)
- **Default ranges**:
  1. VHF Low: 25.0000 - 54.0000 MHz (enabled)
  2. Civil Air: 108.0000 - 136.9916 MHz (enabled)
  3. VHF High: 137.0000 - 174.0000 MHz (enabled)
  4. UHF Air: 225.0000 - 380.0000 MHz (disabled)
  5. UHF: 400.0000 - 512.0000 MHz (disabled)
  6. 800 MHz: 806.0000 - 960.0000 MHz (disabled)
  7-10. Additional ranges (all disabled by default)
- **Behavior**: Sends immediately when changed
- **Mode Requirement**: **SEARCH or CLOSE_CALL mode** required

### Category: Preferences

Contains app preferences and about information.

#### About Section
- **Shows**: "Bearpaw v2.4.0-beta"
- **Description**: "Community-developed control software for Uniden scanners."
- **Links**:
  - **Website**: Opens https://bearpaw-scanner.github.io in new tab
  - **GitHub**: Opens https://github.com/bearpaw-scanner in new tab
- **Donate**: "Enjoying the app? A $10 donation helps keep updates coming!"
  - Opens https://github.com/sponsors/bearpaw-scanner in new tab

#### Application Settings
- **Heading**: "Application Settings"
- **Description**: "Manage your workspace preferences"
- **Reset to Defaults**:
  - **Behavior**: Shows confirmation dialog "Reset all preferences to default values? This cannot be undone."
  - **On confirm**: Calls `POST /preferences/reset`, reloads page
  - **Feedback**: Toast "Preferences reset to defaults"

#### Support Section
- **Heading**: "Support Bearpaw"
- **Description**: "Enjoying the app? A $10 donation helps keep updates coming!"
- **Button**: Opens https://github.com/sponsors/bearpaw-scanner in new tab

---

## Channels View

The Channels view allows you to view, edit, and manage all 500 scanner memory channels.

### Bank Navigation
- **Purpose**: Switch between channel banks (1-10)
- **Channels per bank**: 50 channels (total 500)
- **Behavior**:
  - Clicking a bank loads its 50 channels
  - Active bank shows with orange dot and highlighted text
  - Automatically clears when switching banks
- **Search**: Search box filters channels in current bank by frequency or alpha tag

### Channel List

Shows 50 channels from selected bank with columns:

#### Columns
- **CH**: Channel number
- **FREQ**: Frequency in MHz (monospace, bold, orange)
- **TAG**: Alpha tag or channel name
- **MODE**: Modulation (AUTO, FM, AM, NFM)
- **TONE**: Tone squelch frequency or "—"
- **DLY**: Delay in seconds
- **L/O**: Lockout status (shows lock icon if locked)
- **PRIO**: Priority status (shows orange dot if enabled)

#### Viewing Mode
- **Display**: Read-only mode shows channel data
- **Editing**: Click a row to edit in-place

### Inline Editing

When you click a channel row, it enters edit mode:

#### Edit Fields
- **Frequency**: Text input (monospace, orange text)
- **Tag**: Text input for alpha tag
- **Mode**: Dropdown with options (AUTO, FM, AM, NFM)
- **Tone**: Text input for tone frequency (leave blank for none)
- **Delay**: Text input for delay in seconds
- **Lockout**: Checkbox toggle
- **Priority**: Checkbox toggle

#### Auto-Save Behavior
- **Debounce**: 500ms delay after you stop typing
- **Save trigger**:
  - When you click another row, previous row auto-saves
  - When you click outside the list, current row auto-saves
  - When you press Escape, current row cancels edits (reverts to original)
- **Validation**: Only saves if fields changed from original values
- **Feedback**: Success toast shows "Saved CH {n}" on successful save
- **API call**: `updateChannel(channelIndex, payload)`

#### Mode Requirement
- **Note**: Channel editing works regardless of scanner mode
- **Program mode**: NOT required to edit channels (changes stored in shadow memory)

### Import/Export Buttons

#### Import CSV
- **Purpose**: Import channels from CSV file
- **Behavior**:
  - Opens file picker dialog (CSV files only)
  - Parses CSV and validates each row
  - Updates channels in shadow state
  - Writes to scanner if channel_write_supported
  - Shows toast with import summary (success or errors)
- **Validation**:
  - Frequency must be 25-512 MHz
  - Delay must be 0-30 seconds
  - Bank must be 1-10
- **Error handling**: Shows toast with count of errors and first 3 failed row indices
- **API endpoint**: `POST /memory/import/csv`
- **Format**: Same as Export CSV output

#### Export CSV
- **Purpose**: Export channels to CSV file
- **Behavior**:
  - Downloads all channels from shadow state
  - Shows toast "Channels exported successfully"
- **File format**: CSV with columns: Index, Frequency, Modulation, Alpha Tag, Delay, Lockout, Priority, CTCSS/DCS, Bank
- **API endpoint**: `GET /memory/export/csv`
- **Example filename**: `channels.csv`

### Bank Calculation
Channels are assigned to banks based on index:
- Channels 1-50: Bank 1
- Channels 51-100: Bank 2
- Channels 101-150: Bank 3
- Channels 151-200: Bank 4
- Channels 201-250: Bank 5
- Channels 251-300: Bank 6
- Channels 301-350: Bank 7
- Channels 351-400: Bank 8
- Channels 401-450: Bank 9
- Channels 451-500: Bank 10

### Locked Channel Visual State
- **Locked channels**:
  - Reduced opacity (50%)
  - Grayscale filter applied
  - Still editable but visually muted

---

## Tab Navigation

The app has three main tabs: Scan, Device, and Channels.

### Tab Behavior
- **Scan**: Main monitoring interface
- **Device**: Configuration and settings
- **Channels**: Channel memory management

Tabs animate with slide transitions:
- Entering tab: Slides in from left (`x: -20` → `x: 0`)
- Exiting tab: Slides out to right (`x: 0` → `x: 20`)
- Fade animation: Opacity 0 → 1

---

## WebSocket Integration

### Real-time Updates
The app connects to backend via WebSocket for live scanner state:

#### State Update Messages
- **Trigger**: When scanner state changes
- **Data sent**: Frequency, channel, alpha tag, mode, RSSI, squelch state
- **Display updates**: Main display text, subtext, mode indicator, signal bars
- **Frequency**: Updated to 4 decimal places
- **Signal strength**: Normalized from RSSI (0-100 scale → 0-5 bars)

#### Event Messages
- **Type**: "state_stale"
- **Behavior**: Marks live state as stale when connection lost

#### Progress Messages
- **Trigger**: During memory sync or long operations
- **Data**: Percent complete (0-100) and message
- **Behavior**: Updates progress display, completes when 100% or "sync complete" received

### Hit Detection Logic
The app detects new scan hits by:
1. Listening for `state_update` messages
2. Checking if `squelch_open` changed from false to true
3. Checking if valid frequency exists
4. Adding to activity log entry
5. Adding to full activity log (persistent)

---

## Mode Requirements Summary

| Feature | SCAN Mode | HOLD Mode | SEARCH Mode | CLOSE_CALL Mode | PROGRAM Mode |
|---------|-----------|-----------|-------------|------------------|--------------|
| L/O (Lockout) | Required | ✅ Resume after 1s | Required | Required | — |
| HOLD Button | ✅ Works | ✅ Works | ✅ Works | ✅ Works | — |
| VOL, REC | ✅ Works | ✅ Works | ✅ Works | ✅ Works | — |
| Bank Toggle | ✅ Works | ✅ Works | ✅ Works | ✅ Works | — |
| Device Settings | ✅ Works | ✅ Works | ✅ Works | ✅ Works | — |
| Service Search | ✅ Works | ✅ Works | ✅ Works | ✅ Works | — |
| Custom Search | ✅ Works | ✅ Works | ✅ Works | ✅ Works | — |
| Channel Edit | ✅ Works | ✅ Works | ✅ Works | ✅ Works | ✅ Works |
| Memory Sync | ✅ Works | ✅ Works | ✅ Works | ✅ Works | ✅ Works |

---

## Timing Summary

| Operation | Timing | Notes |
|-----------|---------|-------|
| Device info refresh | 5000ms | Auto-poll via setInterval |
| Lockouts refresh | 5000ms | Auto-poll via setInterval |
| Analytics refresh | 5000ms | Auto-poll via setInterval (Scan tab only) |
| Channel edit auto-save | 500ms | Debounce after typing stops |
| Resume scan after lockout | 1000ms | If in HOLD mode, waits 1s then scans |
| Toast auto-dismiss | ~3000ms | Default toast duration |

---

## State Management

The app uses Zustand for global state store with these key properties:

### Live State
- Updated via WebSocket `state_update` messages
- Contains: frequency, channel, alpha_tag, modulation, rssi, squelch_open, mode, volume

### Channels
- Array of 500 channel objects
- Updated by: Memory sync, channel edits, lockout clears
- Fields: index, frequency, alpha_tag, modulation, tone_squelch, delay, lockout, priority, bank

### Activity Log
- Last 50 scan hits
- New entries added when squelch opens
- Cleared on session restart

### Full Activity Log
- Complete session hit history
- Used for export to CSV
- Persists across sessions

### Banks
- Array of 10 boolean values
- True = bank enabled, False = bank disabled

---

## Toast Notifications

The app shows toast messages for user feedback:

### Success
- "Saved CH {n}" - Channel saved successfully
- "{n} channels unlocked" - Lockout cleared
- "Channel sync started" - Memory sync initiated

### Error
- "Failed to save CH {n}" - Channel save failed
- "Unable to start channel sync" - Sync failed
- "Failed to update banks" - Bank toggle failed
- "Failed to set volume" - Volume change failed

### Info
- "No active frequency for lockout" - Cannot lockout without signal
- "Help is on the way" - Help button clicked

---

## Keyboard Shortcuts

### Global Shortcuts
- **Escape**: Exit channel editing mode (Channels view)

### Future Shortcuts
- Full keyboard shortcut system planned but not yet implemented

---

## Responsive Design

The app is designed for a fixed viewport:
- **Width**: 1100px
- **Height**: 600px
- **Scaling**: Does not respond to window resize (fixed scanner UI)
- **Fonts**: 16px base with Manrope font family

---

## Error Handling

### Connection Errors
- **WebSocket disconnect**: Shows disconnected status with red LED
- **USB disconnect**: Shows USB error icon in display
- **Reconnection**: Automatically attempts to reconnect via WebSocket client

### API Errors
- Most API calls wrapped in try/catch
- Errors logged to console
- User feedback via toast notifications
- State updates prevented on error

### Sync Errors
- If sync fails, sync button unlocked
- User can retry by clicking sync button again
- Progress display shows current status or completion

---

## Data Flow

### Initial Load
1. App mounts
2. Connects to WebSocket
3. Loads: status, device info, channels, banks, lockouts
4. Starts auto-refresh intervals (device info, lockouts, analytics)
5. Starts memory sync if no channels exist

### Runtime
1. WebSocket updates live state on state changes
2. Auto-refresh polls update device info, lockouts, analytics
3. User interactions send API commands
4. Responses update local state
5. Changes reflect in UI immediately

### Session End
1. Activity log exported to CSV via Export button
2. Full activity log persists (in development)
3. State resets on app restart

---

## Notes

- **Program mode vs Scan mode**: The app works in either mode. Channel editing and most settings work in both modes. Lockout requires scanner to be stopped (SCAN mode).
- **Temporary vs Permanent lockout**: Temporary lockouts are stored in a separate list and can be cleared. Permanent lockouts set a flag on the channel itself.
- **Frequency format**: All frequencies displayed with 4 decimal places (e.g., 444.5250 MHz)
- **Channel index**: Displayed as CH followed by number (e.g., CH67)
- **Signal strength**: RSSI values (0-100) normalized to 5-bar scale (RSSI ÷ 20, capped at 5)

