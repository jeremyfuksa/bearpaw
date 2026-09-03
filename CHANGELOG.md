# Changelog

All notable changes to Bearpaw are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1]

_In progress. Entries land here as they merge; the date is added at release._

## [1.1.0] — 2026-09-02

Adds support for a second scanner family, the BC75XLT, and fixes a set of
issues found by running Bearpaw against both radios on the bench.

> **Upgrading changes how your data is stored, and it is one-way.** The first
> time you open this version, your channels, settings and activity history are
> upgraded to a new format, and a backup of the old data is saved next to it.
> Bearpaw 1.0.0 cannot open the upgraded data — if you go back, it will tell you
> so and point at that backup. Bearpaw now says this on screen when it happens,
> rather than doing it silently.

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

### Security

- **A web page you visit can no longer drive your scanner.** Bearpaw's local
  API had no protection against requests sent from another site open in your
  browser. Blocking a site from _reading_ Bearpaw's replies was never enough:
  the request still arrived and still took effect, so a page could clear
  channels, rewrite banks or start an import while only the response was
  withheld. Requests from unknown websites are now refused before they reach
  anything. Local tools that aren't a browser, such as scripts using `curl`,
  are unaffected. Tracked as GHSA-fwgr-5f9j-r7q6.

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

- **Restoring a settings file now clears the channels the file says are empty,
  which means it can erase channels it previously left alone.** Bearpaw asks
  "this overwrites all channels and settings" before a restore, and it did not:
  any slot the file recorded as empty was skipped, so channels programmed since
  the file was saved survived a restore that was supposed to replace them. A
  file saved from a blank scanner reported "0 channels" and changed nothing.
  Restoring now makes the scanner match the file exactly — **including emptying
  slots** — so treat a settings file as a complete picture of the radio, not a
  set of additions. Verified on a BC75XLT.

- **Restoring a settings file on a BC75XLT now restores its settings.** It
  applied channels only and always reported no settings written, while the same
  confirmation promised "all channels and settings". Bank enablement, priority,
  squelch, custom search and Close Call are all restored now. The handful of
  settings that radio genuinely cannot accept are named in the result instead of
  being dropped in silence, so a restore no longer claims to have done more than
  it did.

- **Exporting can no longer write a backup with invented data in it.** If
  Bearpaw had not yet read the whole channel list from the radio, the export
  filled the gaps: one format made up plausible-looking empty channels, the
  other left rows out entirely. Either way the file looked complete and was not
  — and with the restore change above, restoring such a file would write that
  invented state back to the scanner. Exporting now refuses and tells you to
  sync first.

- **The scanner no longer reports a failed command at launch.** Starting a
  memory sync registered it a moment after queueing it, and anything that
  slipped into that gap waited behind a five-second sync and timed out. It
  showed up as a failure reading banks on almost every launch.

- **Search settings on a BC75XLT no longer pretend to work.** That radio accepts
  the command that reads them but rejects every attempt to change them, and
  Bearpaw treated the rejection as success — the slider moved, the confirmation
  appeared, and the radio never changed. Those controls are now hidden on models
  that cannot accept them, and a rejected write is reported as one.

- **Channels no longer go missing when you reorder them.** Uploading a reorder
  wrote the moved channels one at a time, so a later write could read a slot an
  earlier write had already changed — a swap or a rotation could duplicate one
  channel and lose another. Every source channel is now read before any of them
  is written. Edits made on the scanner's own keypad that Bearpaw hadn't loaded
  survive the move, and a channel's tone survives a reorder that didn't
  otherwise touch it.

- **Restoring a BC125AT settings file keeps your channel tones.** Tone values as
  Uniden's own tools write them — off, a CTCSS frequency, a DCS code, or search
  — weren't understood, so every restored channel came back with its tone turned
  off. They're read correctly now, and a tone value Bearpaw can't make sense of
  is reported as an error on that row instead of quietly becoming "off".

- **Exporting a BC75XLT now includes its search settings.** Custom search
  ranges, per-service search, Close Call mode and search direction were left out
  of the native export, so a backup taken from that radio couldn't put them
  back.

- **A setting that fails to save now says so.** When Bearpaw couldn't write a
  preference to disk, the control moved on screen and silently reverted later.
  Preferences are written to storage before the interface changes, and a failure
  is reported instead of hidden.

- **The activity list no longer shows the wrong scanner's history.** Switching
  between a single scanner and all scanners could show the previous selection's
  data, because the request didn't say which scope it was being made for. Hits
  arriving live while the list was loading are no longer dropped or counted
  twice.

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

[1.1.0]: https://github.com/jeremyfuksa/bearpaw/releases/tag/v1.1.0
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
