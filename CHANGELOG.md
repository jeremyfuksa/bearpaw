# Changelog

All notable changes to Bearpaw are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
