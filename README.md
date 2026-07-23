<!-- markdownlint-disable MD033 MD041 -->

# Bearpaw

[![Latest release](https://img.shields.io/github/v/release/jeremyfuksa/bearpaw?include_prereleases&sort=semver&label=release&color=e6a817)](https://github.com/jeremyfuksa/bearpaw/releases)
[![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows%20%7C%20Linux-2b2f38)](#download-and-install)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db)](https://tauri.app)
[![Buy me a coffee](https://img.shields.io/badge/buy%20me%20a%20coffee-ffdd00?logo=buymeacoffee&logoColor=000)](https://buymeacoffee.com/jeremyfuksa)

**A desktop control interface for the Uniden BC125AT scanner.**

Bearpaw puts your BC125AT on your computer screen. See what the scanner sees:
the live frequency, the alpha tag, the signal strength, in a display big enough
to read across the room. Edit all 500 channels without the radio's keypad, and
move them in and out of the radio as plain CSV or native Uniden files.

It does one thing the radio and the official software never did: while it runs, Bearpaw logs every hit and records a log of 
the radio world around you, and hands you the
raw data as CSV whenever you want it.

It talks to the scanner the same way Uniden's Sentinel software does, over the
USB cable, and runs live while you're listening, on macOS, Windows, and Linux.

> **This is a beta.** It's been tested against real hardware, but
> you may hit rough edges. Found one?
> [Open an issue](https://github.com/jeremyfuksa/bearpaw/issues).

---

## Download and install

Grab the latest build from the
[**Releases page**](https://github.com/jeremyfuksa/bearpaw/releases) and pick the
file for your system:

| Your computer                         | Download                                              |
| ------------------------------------- | ----------------------------------------------------- |
| **Mac** (Apple Silicon, M1 and newer) | `Bearpaw_…_aarch64.dmg`                               |
| **Mac** (older Intel)                 | `Bearpaw_…_x64.dmg`                                   |
| **Windows**                           | `Bearpaw_…_x64-setup.exe` or `.msi`                   |
| **Linux**                             | `.AppImage` (runs anywhere) or `.deb` (Debian/Ubuntu) |

These beta builds aren't code-signed yet, so your computer flags them the first
time you open the app.

- **macOS**: open the `.dmg`, drag **Bearpaw** to Applications, then right-click
  the app and choose **Open**, then **Open** again. A normal double-click refuses
  with "can't be opened." If it still won't open, run this once in Terminal:

  ```bash
  xattr -cr /Applications/Bearpaw.app
  ```

- **Windows**: if you see "Windows protected your PC," click **More info**, then
  **Run anyway**.

- **Linux**: `chmod +x` the `.AppImage` and run it, or install the `.deb`.

## Connect your scanner

Plug the BC125AT into a USB port and launch Bearpaw. It auto-detects the scanner
on every platform.

If it doesn't connect, two things to check:

- Use a **data USB cable**, not a charge-only one. If you're not sure which you
  have, try a different cable.
- Make sure the scanner is **powered on**.

Once connected, Bearpaw reads your channels from the radio, which takes about 30 to 45
seconds the first time.

## Learn your way around

The full user guide lives at **[bearpaw.app/docs](https://bearpaw.app/docs/)** and
walks through every part of the app:

- **[Getting Started](https://bearpaw.app/docs/getting-started.html)**: from
  plugging in to your first received signal.
- **[The Scan Tab](https://bearpaw.app/docs/scan.html)**: the live display, the
  "hit" workflow, and the on-screen controls.
- **[The Channels Tab](https://bearpaw.app/docs/channels.html)**: viewing and
  editing your 500 channels, and how to save your changes back to the radio.
- **[The Device Tab](https://bearpaw.app/docs/device.html)**: the scanner's own
  settings plus the app's preferences.
- **[Menu & Keyboard Shortcuts](https://bearpaw.app/docs/troubleshooting.html#menu--keyboard-shortcuts)**
  and **[Troubleshooting](https://bearpaw.app/docs/troubleshooting.html)**.
- **[Glossary](https://bearpaw.app/docs/glossary.html)**

## What Bearpaw is and isn't

Bearpaw is a **community project**. It is not made by or affiliated with Uniden.
It reads and writes your scanner over the documented USB protocol, replicating what the scanner can already do from its own keypad.

## For developers

Building from source, the architecture, and the wire protocol are documented
separately. See [`CONTRIBUTING.md`](CONTRIBUTING.md) to get set up, [`CLAUDE.md`](CLAUDE.md)
for the fullest map of the system, and the reference material in [`docs/`](docs/).
Bearpaw is a Rust backend (Axum plus a Tauri desktop shell) with a
React/TypeScript frontend. Release notes live in [`CHANGELOG.md`](CHANGELOG.md).

---

_Bearpaw is released under the [MIT License](LICENSE). Made by
[Jeremy Fuksa](https://github.com/jeremyfuksa). If it's useful to you, you can
[buy the developer a coffee](https://buymeacoffee.com/jeremyfuksa)._
