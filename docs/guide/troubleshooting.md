# Menu, Shortcuts & Troubleshooting

Reference for the menus and keyboard shortcuts, plus what to do when the scanner
won't connect.

- [Menu & Keyboard Shortcuts](#menu--keyboard-shortcuts)
- [The scanner won't connect](#the-scanner-wont-connect)
- [Other common issues](#other-common-issues)

---

## Menu & Keyboard Shortcuts

### The menu

Bearpaw's menu bar has three menus of its own, plus the standard app menu.

**View** jumps between the three tabs.

| Item     | Shortcut   |
| -------- | ---------- |
| Scan     | Ctrl/⌘ + 1 |
| Device   | Ctrl/⌘ + 2 |
| Channels | Ctrl/⌘ + 3 |

**Scanner** covers actions on the radio.

| Item        | Shortcut   | What it does                                           |
| ----------- | ---------- | ------------------------------------------------------ |
| Hold        | Ctrl/⌘ + H | Park on the current channel                            |
| Scan        | Ctrl/⌘ + S | Resume scanning                                        |
| Sync Memory | Ctrl/⌘ + Y | Re-read all 500 channels from the scanner (30 to 45 s) |

**Help** opens in your web browser.

| Item          | Goes to                      |
| ------------- | ---------------------------- |
| Documentation | The project README on GitHub |
| GitHub Issues | Where to report bugs         |
| About Bearpaw | Version and credits          |

### Keyboard shortcuts

Every shortcut uses a modifier key (Ctrl on Windows/Linux, ⌘ on Mac) except
Escape. Shortcuts are ignored while you're typing in a text box.

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
down this list.

1. **Is the scanner powered on?**

2. **Is it a data USB cable?** This is the most common cause. Many USB cables,
   especially ones that came with other devices, carry power but not data, so the
   scanner charges but never appears to the computer. Try a different cable,
   ideally the one that came with the scanner.

3. **Try a different USB port** on your computer, and avoid unpowered USB hubs.
   Plug directly into the machine if you can.

4. **Give it a few seconds.** Bearpaw reconnects on its own.

5. **Quit and relaunch Bearpaw.**

If none of that works, the Device tab's
[Device Information](device.md#device-information) card shows a diagnostic message
that can point at the specific problem. For USB-detection issues on macOS, a short
troubleshooting checklist appears there automatically.

> You don't normally need a config file. Bearpaw auto-detects the scanner on all
> platforms. A config file is only for advanced cases, like
> forcing a specific serial port when auto-detect keeps picking the wrong device.
> If you need one, see [the config note below](#advanced-forcing-a-specific-port).

---

## Other common issues

### My channel edits didn't save to the scanner

Edits on the Channels tab are held as **drafts** until you press **Upload
Changes**. If your changes seem to have vanished, check the pending-changes strip
above the channel list. "N pending" means your edits are waiting to be uploaded.
See
[Drafts and uploading](channels.md#drafts-and-uploading-the-important-part). (The
Priority switch is the exception; it applies immediately.)

### I set a permanent lockout by accident

The **L/O** button on the Scan tab opens a menu with **Temporary** and
**Permanent** choices. To clear a permanent lockout, pick **Permanent** again
while on that channel, or clear it from the
[Locked Channels](device.md#locked-channels) list on the Device tab.

### The app warns it's from an "unidentified developer"

The beta builds aren't code-signed yet, so your operating system flags them on
first launch. See the [install instructions](../../README.md#download-and-install)
for how to open it anyway.

### A setting on the Device tab didn't take

Scanner settings are written to the radio the instant you change them. A failed
write (a momentary USB hiccup, say) shows a red error message, and the setting may
not have changed. Try again; if it keeps failing, check the connection.

---

### Advanced: forcing a specific port

Auto-detect handles the scanner on every platform, so you almost certainly don't
need this. But if auto-detect keeps selecting the wrong USB-serial device, a
`config.yaml` file can force a specific port.

Put it in the app's data folder:

- **macOS**: `~/Library/Application Support/com.jeremyfuksa.bearpaw/config.yaml`
- **Windows**: `%APPDATA%\com.jeremyfuksa.bearpaw\config.yaml`
- **Linux**: `~/.local/share/com.jeremyfuksa.bearpaw/config.yaml`

A minimal example:

```yaml
device:
  # Only set this if auto-detect picks the wrong device:
  port: /dev/cu.usbmodem14101 # macOS
  # port: COM3                # Windows
  # port: /dev/ttyUSB0        # Linux
```

> A `config.yaml` that exists but has a typo (bad YAML) stops the app from
> starting, rather than being ignored. If you add one and the app won't launch,
> delete it and try again.

---

**Back to:** [Getting Started](getting-started.md) · [Glossary](glossary.md)
