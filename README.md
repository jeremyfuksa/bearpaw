<!-- markdownlint-disable MD033 MD041 -->

# Bearpaw

**A desktop control interface for the Uniden BC125AT scanner.**

Bearpaw puts your BC125AT on your computer screen. See what the scanner sees:
the live frequency, the alpha tag, the signal strength, in a big, readable
display. Edit all 500 channels without the radio's keypad. Watch which
frequencies are busiest, and keep a searchable log of everything the scanner
hears.

It talks to the scanner the same way the official Sentinel software does, over
the USB cable. The difference is that it runs live, while you're listening, on
macOS, Windows, and Linux.

> **This is a beta.** It works, and it's been tested against real hardware, but
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
on every platform, including macOS. No config file, no port setup.

If it doesn't connect, two things to check:

- Use a **data USB cable**, not a charge-only one. If you're not sure which you
  have, try a different cable.
- Make sure the scanner is **powered on**.

The dot in the bottom-left corner shows the connection state: **green** is
connected, **yellow** is connecting, **red** is not connected. When it goes
green, Bearpaw reads your channels from the radio, which takes about 30 to 45
seconds the first time.

## Learn your way around

The full user guide walks through every part of the app in plain language:

- **[Getting Started](docs/guide/getting-started.md)**: from plugging in to your
  first received signal, step by step.
- **[The Scan Tab](docs/guide/scan.md)**: the live display, the "hit" workflow,
  and the on-screen controls.
- **[The Channels Tab](docs/guide/channels.md)**: viewing and editing your 500
  channels, and how to save your changes back to the radio.
- **[The Device Tab](docs/guide/device.md)**: the scanner's own settings (volume,
  squelch, Close Call, searches) plus the app's preferences.
- **[Menu & Keyboard Shortcuts](docs/guide/troubleshooting.md#menu--keyboard-shortcuts)**
  and **[Troubleshooting](docs/guide/troubleshooting.md)**.
- **[Glossary](docs/guide/glossary.md)**: every radio and app term the guide
  uses, defined once.

## What Bearpaw is and isn't

Bearpaw is a **community project**. It is not made by or affiliated with Uniden.
It reads and writes your scanner over the documented USB protocol, and stays
inside what the scanner can already do from its own keypad. Bearpaw reads your
channel memory fresh from the radio each time it starts.

## For developers

Building from source, the architecture, and the wire protocol are documented
separately. See [`CLAUDE.md`](CLAUDE.md) and the reference material in
[`docs/`](docs/). Bearpaw is a Rust backend (Axum plus a Tauri desktop shell)
with a React/TypeScript frontend.

---

_Bearpaw is licensed for personal use. Made by
[Jeremy Fuksa](https://github.com/jeremyfuksa). If it's useful to you, you can
[buy the developer a coffee](https://buymeacoffee.com/jeremyfuksa)._
