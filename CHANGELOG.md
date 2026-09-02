# Changelog

All notable changes to Bearpaw are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **BC75XLT support.** Bearpaw now drives a second scanner family. The BC75XLT
  speaks the same wire protocol as the BC125AT but has 300 channels in banks of
  30, no channel names, no per-channel modulation or tone, a simple on/off scan
  delay, and a different serial speed behind a CP210x adapter. It's detected
  automatically — no configuration — and the interface adapts: columns and
  controls the radio can't support don't appear rather than sitting greyed out.
  Verified against real hardware.

- **The Device tab names your scanner and its capacity** — model, channel count,
  and bank layout — so it's obvious which radio Bearpaw picked up when more than
  one is on the desk.

### Fixed

- **Exporting channels to CSV and importing them back now works.** Every
  exported row carried a bank number of zero, and the importer refused any row
  whose bank wasn't between 1 and 10 — so Bearpaw's own export failed on every
  programmed channel. On a full scanner that was 350 rows rejected and nothing
  imported. Empty channels were skipped without being counted at all, so the
  error message under-reported the damage. The bank column is now filled in on
  the way out and worked out from the channel number on the way back in, which
  is how the scanner decides it anyway.

- **One scanner's activity no longer crowds out another's.** Recorded hits were
  loaded newest-first up to a fixed limit across all scanners together, so a busy
  radio could fill the entire budget and a quieter one's history would be missing
  from the activity list and every dashboard built on it — while sitting intact
  in the database, which made it look like a display problem rather than a
  loading one. The limit now applies per scanner.

- **Channel banks now follow the connected scanner.** Bank width was fixed at 50
  channels in three places, so on a 300-channel scanner every channel above 30
  was filed in the wrong bank — and the priority swap, which enforces one
  priority channel per bank, could clear priority on a channel in a different
  bank than the one you were editing.

- **Writes are checked against what the scanner accepts** before they're sent.
  A value the radio rejects doesn't just fail on its own — the scanner aborts
  the whole write, silently discarding the frequency and lockout in the same
  command. Scan delay, frequency coverage, and channel numbers are all validated
  against the connected model now.

- **Cleared channels stop showing as unsaved.** On a BC75XLT, every cleared
  channel stayed marked as a pending change forever, keeping Upload Changes lit
  and rewriting those channels on every upload.

- **Database upgrades are safer.** A failed upgrade no longer marks itself
  finished, upgrades run as a single all-or-nothing step, and a failure to write
  the pre-upgrade backup stops the upgrade rather than proceeding without a way
  back. Data written by a newer version of Bearpaw is now refused with an
  explanation instead of being read by older code that doesn't understand it.

- **A USB adapter that isn't a scanner is left alone.** Detection could try to
  claim a generic serial adapter — including unrelated devices like development
  boards — and on Linux that could take the device's serial port away until it
  was unplugged.

## [1.0.0] — 2026-08-26

First stable release. Every major feature has been exercised against the
physical scanner, and the test suite now pins the exact wire command behind each
one rather than trusting that the HTTP layer got it right.

### Added

- **European hardware support.** The UBC125XLT's USB PID is now probed, so the
  EU variant autodetects the way the BC125AT does. Contributed and confirmed on
  real hardware by [@dan-r](https://github.com/dan-r).

### Changed

- **A scanner Bearpaw can't drive now says so.** A Uniden that answers the model
  probe with something outside the supported family used to report the same
  "no scanner found" as an empty USB port — which reads as a bad cable. It now
  names the model it saw, lists what is supported, and points at the issue
  tracker so unsupported hardware turns into a report rather than a dead end.
- **Smaller install.** 37 unused UI components and 29 npm dependencies removed.

### Fixed

- **The Windows `.msi` was never actually built.** The download table offered it
  anyway. Only `.exe` ships on Windows; the docs now say so.
- **Release builds no longer ship stray files.** The macOS `.app` bundle was
  being uploaded as loose `Info.plist` / `CodeResources` / `bearpaw-desktop`
  files, which collided between the two Mac architectures. Releases now carry
  only the five installers.

### Internal

- Backend tests grew from 92 to 171. The API contract test previously asserted
  string literals against regexes of themselves — it could never catch the drift
  it was named for. It now probes the real router, and the exact wire command
  behind every control, setting, bank, and channel write is pinned and
  verified by mutation.

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

[1.0.0]: https://github.com/jeremyfuksa/bearpaw/releases/tag/v1.0.0
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
