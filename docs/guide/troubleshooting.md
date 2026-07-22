# Menu, Shortcuts & Troubleshooting

Reference for the menus and keyboard shortcuts, plus what to do when something
isn't working.

- [Menu & Keyboard Shortcuts](#menu--keyboard-shortcuts)
- [The scanner won't connect](#the-scanner-wont-connect)
- [Other common issues](#other-common-issues)

---

## Menu & Keyboard Shortcuts

### The menu

Bearpaw's menu bar has three menus of its own (plus the standard app menu):

**View** — jump between the three tabs.

| Item     | Shortcut   |
| -------- | ---------- |
| Scan     | Ctrl/⌘ + 1 |
| Device   | Ctrl/⌘ + 2 |
| Channels | Ctrl/⌘ + 3 |

**Scanner** — actions on the radio.

| Item        | Shortcut   | What it does                                         |
| ----------- | ---------- | ---------------------------------------------------- |
| Hold        | Ctrl/⌘ + H | Park on the current channel                          |
| Scan        | Ctrl/⌘ + S | Resume scanning                                      |
| Sync Memory | Ctrl/⌘ + Y | Re-read all 500 channels from the scanner (~30–45 s) |

**Help** — opens in your web browser.

| Item          | Goes to                      |
| ------------- | ---------------------------- |
| Documentation | The project README on GitHub |
| GitHub Issues | Where to report bugs         |
| About Bearpaw | Version and credits          |

### Keyboard shortcuts

Every shortcut uses a modifier key (Ctrl on Windows/Linux, ⌘ on Mac) except
Escape. Shortcuts are ignored while you're typing in a text box, so they never
get in the way of editing.

| Shortcut               | What it does                                        |
| ---------------------- | --------------------------------------------------- |
| **Esc**                | Close any open panel or dialog                      |
| **Ctrl/⌘ + /**         | Show the keyboard-shortcuts help                    |
| **Ctrl/⌘ + S**         | Scan (resume scanning)                              |
| **Ctrl/⌘ + H**         | Hold                                                |
| **Ctrl/⌘ + C**         | Copy the current frequency to the clipboard         |
| **Ctrl/⌘ + L**         | Toggle a temporary lockout on the current frequency |
| **Ctrl/⌘ + Shift + L** | Open the activity log                               |
| **Ctrl/⌘ + M**         | Open the channels (memory) browser                  |
| **Ctrl/⌘ + ↑**         | Scanner: navigate up                                |
| **Ctrl/⌘ + ↓**         | Scanner: navigate down                              |

---

## The scanner won't connect

If the connection dot in the bottom-left corner is **red** and stays there, work
down this list. Most of the time it's the cable.

1. **Is the scanner powered on?** Bearpaw can only find a scanner that's running.

2. **Is it a data USB cable?** This is the single most common cause. Many USB
   cables — especially ones that came with other devices — carry power but not
   data, so the scanner charges but never appears to the computer. Try a
   different cable, ideally the one that came with the scanner.

3. **Try a different USB port** on your computer, and avoid unpowered USB hubs —
   plug directly into the machine if you can.

4. **Give it a few seconds.** Bearpaw reconnects on its own; a red dot right after
   plugging in often turns green within a moment.

5. **Quit and relaunch Bearpaw.** This makes it search for the scanner again from
   scratch.

6. **On the scanner, check the USB mode.** The BC125AT needs to be set to allow PC
   / serial control. If it's in a mass-storage or charge-only mode, the app can't
   talk to it.

If none of that works, the app is telling you it genuinely can't find the scanner
on any port. The Device tab's [Device
Information](device.md#device-information) card shows a diagnostic message that
can point at the specific problem, and — for USB-detection issues on macOS — a
short troubleshooting checklist appears there automatically.

> **You don't normally need a config file.** Bearpaw auto-detects the scanner on
> all platforms, including macOS. A config file is only for advanced cases — like
> forcing a specific serial port when auto-detect keeps picking the wrong device.
> If you need one, see [the config note below](#advanced-forcing-a-specific-port).

---

## Other common issues

### The channel list is empty, or names are missing

If channels show as bare frequencies with no names, or the list looks empty right
after launch, the **memory sync** probably hasn't finished. Channel names (alpha
tags) only appear once the ~30–45-second sync completes. Wait for the "Syncing
Scanner Memory" panel to disappear. If it never appeared, run **Scanner → Sync
Memory** (Ctrl/⌘ + Y).

### My channel edits didn't save to the scanner

Edits on the Channels tab are held as **drafts** until you press **Upload
Changes**. If your changes seem to have vanished, check the pending-changes strip
above the channel list — if it says "N pending," your edits are waiting to be
uploaded. See [Drafts and
uploading](channels.md#drafts-and-uploading-the-important-part).

(The one exception is the **Priority** switch, which applies immediately.)

### I set a permanent lockout by accident

The **L/O** button on the Scan tab sets a _temporary_ lockout on a single click
and a _permanent_ one on a double-click — easy to trigger by habit. To clear a
permanent lockout, either double-click **L/O** again while on that channel, or
unlock it from the [Locked Channels](device.md#locked-channels) list on the Device
tab.

### The app opened but warns it's from an "unidentified developer"

The beta builds aren't code-signed yet, so your operating system flags them on
first launch. This is expected. See the [install
instructions](../../README.md#download-and-install) for how to open it anyway —
on macOS it's right-click → Open; on Windows it's More info → Run anyway.

### A setting on the Device tab didn't take

Scanner settings are written to the radio the instant you change them. If a write
fails (a momentary USB hiccup, say), you'll get a red error message, and the
setting may not have changed. Try again; if it keeps failing, check the
connection.

---

### Advanced: forcing a specific port

You almost certainly don't need this — auto-detect handles the scanner on every
platform. But if auto-detect keeps selecting the wrong USB-serial device, you can
create a `config.yaml` file to force a specific port.

Put it in the app's data folder:

- **macOS** — `~/Library/Application Support/com.jeremyfuksa.bearpaw/config.yaml`
- **Windows** — `%APPDATA%\com.jeremyfuksa.bearpaw\config.yaml`
- **Linux** — `~/.local/share/com.jeremyfuksa.bearpaw/config.yaml`

A minimal example:

```yaml
device:
  # Only set this if auto-detect picks the wrong device:
  port: /dev/cu.usbmodem14101 # macOS
  # port: COM3                  # Windows
  # port: /dev/ttyUSB0          # Linux
```

> **Careful:** a `config.yaml` that exists but has a typo (bad YAML) will stop the
> app from starting, rather than being ignored. If you add one and the app won't
> launch, delete it and try again.

---

**Back to:** [Getting Started](getting-started.md) · [Glossary](glossary.md)
