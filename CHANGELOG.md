# Changelog

All notable changes to Bearpaw are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0-beta.3] — 2026-08-03

Third beta. Adds update notifications and keyboard-operable channel reordering,
and corrects three scanner settings that were mapped wrong or missing outright —
each confirmed against the radio rather than the reference docs.

### Fixed

- **Close Call mode was inverted.** The app mapped wire mode 1 to DND and 2 to
  Priority; the hardware means the opposite. Selecting a Close Call mode set the
  wrong one. Confirmed on firmware 1.06.06 by setting each mode from the radio's
  own keypad and reading it back.
- **Close Call `CC Only` was missing.** The radio has a fourth mode the protocol
  reference omits entirely. It was rejected by the backend and unmapped in the
  UI, so a radio already in `CC Only` displayed as "Off" — and the next save
  wrote that "Off" back to the scanner.
- **Priority DND read as Off.** The same silent-clobber shape: an unmodelled
  priority mode fell back to "Off" on read, so opening the Device page and
  saving would quietly switch the radio out of DND.
- **Offline-first fonts.** A dependency pulled in a stylesheet that imported
  fonts from Google's CDN, which survived bundling. The app is meant to render
  fully offline; those imports are gone.
- **Staged channel clears are now visible.** Clearing channels stages a zeroed
  draft in place — the BC125AT has 500 fixed slots, so no row disappears.
  Cleared rows previously looked identical to ordinary edits, and after a
  successful upload they stayed marked as pending forever, re-uploading on every
  subsequent save.

### Added

- **Update notifications.** Bearpaw checks GitHub Releases on launch and via
  Help → Check for Updates, and tells you when a newer version exists. The
  install stays manual — the Download button opens the release page in your
  browser. The launch check is optional (Device → Preferences) and fails
  silently when you're offline.
- **Keyboard-accessible channel reordering.** Reordering was pointer-only, so a
  keyboard or screen-reader user could edit channels but never reorder them
  (WCAG 2.1.1, Level A). The drag grip is now a focusable control with a
  grab/move/drop path.
- **Priority DND mode.** All four priority modes (Off, On, Plus, DND) confirmed
  present on firmware 1.06.06 and selectable in the UI.
- **A hint when Priority modes can't engage.** Selecting a priority mode does
  nothing unless some channel carries the priority flag — the radio shows
  "Priority Scan: No Channel" on its own display and the mode doesn't stick.
  Bearpaw now says so, and points at the Channels page.

[1.0.0-beta.3]: https://github.com/jeremyfuksa/bearpaw/releases/tag/v1.0.0-beta.3

## [1.0.0-beta.2] — 2026-07-23

Second beta. Fixes the macOS "damaged" install error, a USB connection wedge,
and adds a one-click way to grab logs for bug reports.

### Fixed

- **macOS "damaged" install.** Release builds are now ad-hoc signed, so the app
  no longer opens to a "Bearpaw is damaged and can't be opened" error on macOS.
- **USB connection wedge.** A USB endpoint stall (STALL) mid-command left the
  scanner unreachable in a reconnect loop that only a physical unplug could
  clear. The transport now clears the halted endpoint on reconnect, so it
  self-recovers.

### Added

- **Show Log Files.** A Help → Show Log Files menu item and a button in Device
  settings that reveals the current backend log in the OS file manager — makes
  attaching a log to a bug report a single click.

[1.0.0-beta.2]: https://github.com/jeremyfuksa/bearpaw/releases/tag/v1.0.0-beta.2

## [1.0.0-beta.1] — 2026-07-22

First public beta. A desktop control interface for the Uniden BC125AT scanner,
built as a Tauri app over a Rust backend and a React frontend.

### Added

- **Live scan display.** Real-time frequency, alpha tag, modulation, signal
  strength, and CTCSS/DCS tone, in a display readable across the room. Scan,
  hold, and direct-tune controls.
- **Channel memory management.** Read and edit all 500 channels — frequency,
  alpha tag, modulation, tone, priority, and lockout — without the radio's
  keypad.
- **Bank and priority control.** Enable/disable banks and set a priority channel
  per bank, with an atomic swap that never leaves a bank in a half-changed
  state.
- **Global lockouts.** View, add, and remove the scanner's global lockout list.
- **Import / export.** Move channel memory in and out of the radio as CSV or as
  native Uniden Sentinel `.bc125at_ss` files.
- **Activity logging.** Every scan hit is logged and turned into a read on the
  radio traffic around you — which channels are busy and when — exportable as
  CSV.
- **Device settings.** Volume, squelch, backlight, key beep, and the other
  global scanner settings.
- **Accessibility.** Keyboard-operable channel list and tabs, screen-reader
  announcements for scan hits and connection changes, app-shell landmarks, and
  WCAG AA text/border contrast.
- **Cross-platform.** macOS (including Apple Silicon via a direct-USB
  transport), Windows, and Linux.

[1.0.0-beta.1]: https://github.com/jeremyfuksa/bearpaw/releases/tag/v1.0.0-beta.1
