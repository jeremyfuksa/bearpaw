# The Scan Tab

The Scan tab is where you _watch_ the scanner. It shows what the radio is doing
right now, gives you the handful of controls you reach for most, and keeps a
running picture of what's been active.

It has four parts:

- The **big display** — the amber panel, front and center.
- The **Recent Hits** list — the last few active frequencies.
- Two **dashboards** — Busiest Channels and the Activity Heatmap.
- The **status bar** — the strip along the very bottom of the window.

---

## The big display

This is your scanner's screen, enlarged. What it shows depends on what the
scanner is doing.

### While scanning

When the scanner is cycling through channels looking for activity, the display
reads **"Scanning…"** (pulsing) with **"Searching for signal…"** beneath it. No
signal bars — there's no signal yet.

### During a hit

When the scanner stops on an active frequency, the display switches to a stable
readout:

- **The big line** shows the channel's **alpha tag** (its saved name, like "FIRE
  DISPATCH") if it has one. If the channel has no name, you get the **frequency**
  instead.
- **The detail line** underneath is built from whatever's available, separated by
  dots: `146.850 • FM • CH 12 • CTCSS 123.0`. That's the frequency, the
  [modulation](glossary.md#modulation), the channel number, and — only while the
  signal is live — the [tone](glossary.md#ctcss--tone--dcs) the transmission
  carries.
- **The signal bars** on the right fill according to strength.

> Empty channels (frequency `0`) show a dash — `—` — not "0.000".

### When you're Holding or in Direct mode

If you press **HOLD**, or the scanner is in Direct/Search mode, the display looks
just like a hit — a stable frequency and detail line — because in all these cases
the scanner is parked instead of cycling.

### Other states

- **Syncing** — "Syncing Scanner Memory" with progress text, and a panel covers
  the screen. (See [memory sync](channels.md#refreshing-from-the-scanner-memory-sync).)
- **Disconnected** — "Scanner Offline" with a plain-language reason, and the USB
  icon shows an error.

---

## The controls

Four kinds of control live on the display: **VOL**, **L/O**, **HOLD**, and the
row of **bank** buttons.

### VOL — volume

Click **VOL** to open a slider. Volume runs **0 to 15**. Dragging it changes the
scanner's actual speaker level, live.

### HOLD — park on the current channel

**HOLD** stops the scanner cycling and parks it on wherever it is right now. Press
it again to resume scanning.

> **Worth knowing:** the button always says **"HOLD"** — it does not flip to say
> "SCAN" when the scanner is held. Instead, when Hold is active the button is
> _highlighted_ (filled, with amber text). So: highlighted = currently holding,
> press to resume. Not highlighted = scanning, press to hold.

Remember the distinction from [Getting Started](getting-started.md#step-4--your-first-hit):
a **hit** pauses the scanner automatically but is _not_ Hold. Hold is something
_you_ switch on.

### L/O — lock out a frequency

**Lockout** tells the scanner to skip something so it stops stopping on it — handy
for a frequency that's just noise, a data signal, or a conversation you don't
care about. The **L/O** button does two different things depending on how you
click it:

- **Single click → temporary lockout.** Skips the frequency you're currently on,
  until the scanner is powered off. Nothing permanent.
- **Double click → permanent lockout.** Writes the lockout into the channel's
  memory, so it stays skipped across power cycles.

Both are **toggles** — click (or double-click) again to remove the lockout. A
message at the top of the screen confirms each action, telling you which channel
and whether it was enabled or cleared.

> **Careful here:** the same button does both, and it's easy to double-click out
> of habit and set a _permanent_ lockout when you only meant a temporary one.
> Watch the confirmation message. If you set a permanent lockout by mistake, you
> can clear it here (double-click again) or from the
> [Locked Channels](device.md#locked-channels) list on the Device tab.

### The bank buttons (1–9, 0)

Along the bottom are ten buttons — **1 through 9, then 0** (that last one is bank
10). Your 500 channels are split into ten [banks](glossary.md#bank) of 50, and
these buttons turn each bank on or off _for scanning_:

- **Highlighted** (filled, amber number) = the bank is **included** in the scan.
- **Outlined** (dark number) = the bank is **skipped**.

Toggling a bank off removes its 50 channels from the scan cycle. This is how you
focus the scanner on just the banks you care about right now.

> These buttons only control what gets _scanned_. To _edit_ the channels inside a
> bank, use the [Channels tab](channels.md).

---

## Recent Hits

To the right of the display, **Recent Hits** lists the last five active
frequencies, newest at the top. Each row shows:

- **How long ago** it happened ("just now", "2 minutes ago") — this updates as
  time passes.
- **The frequency.**
- **The tag** (the channel's name), or `—` if it has none.
- **A mini signal-strength meter** for that hit.

The list always shows five slots so the layout doesn't jump around; empty slots
sit quietly until traffic fills them. Before anything's been heard, it reads
"Waiting for signals…".

> **Only real hits are logged.** A transmission has to last at least a minimum
> length of time (2 seconds by default) to be recorded here. Brief static bursts
> and key-ups are ignored. You can change that threshold under [Preferences →
> Hit Minimum Duration](device.md#preferences-app-settings).

---

## The dashboards

Below the display, two widgets build a longer-term picture.

### Busiest Channels

A bar chart of your **most active channels of all time**, tallest bar first,
labeled by channel name. This is the "what does my scanner hear the most"
snapshot.

### Activity Heatmap

A grid of **7 days × 24 hours** — one row per day (Monday to Sunday), one column
per hour. The brighter a cell, the more hits happened in that day-and-hour, over
**the last 7 days**. Hover any cell to see the exact count. This is the "_when_ is
my scanner busiest" view — you can spot the morning commute, the evening net, the
Friday-night activity.

> The two dashboards use different time windows on purpose: **Busiest Channels is
> all-time**, the **Heatmap is a rolling week**. And both count only hits that met
> the minimum-duration threshold.

---

## The status bar

The strip along the bottom of the window is always visible, on every tab.

**On the left:** the connection dot and label —

- 🟢 green + your scanner's model name = **connected**
- 🟡 yellow + "Connecting…" = **establishing the link**
- 🔴 red + "Disconnected" = **no connection** (see [Troubleshooting](troubleshooting.md))

…followed by the name of the tab you're on.

**On the right (Scan tab only):** three running session counts —

- **Hits** — how many hits this session.
- **Active** — total time signals were actually active this session, shown as
  minutes:seconds. This is _airtime_, not a clock time.
- **Channels** — how many _different_ channels have gone active this session. (Not
  the number of channels in your scanner — the number that have _had traffic_.)

---

## Exporting the activity log

Bearpaw keeps a full log of everything it hears, and you can save it out to a
file. Click the small **export icon** in the Recent Hits header (or press
**Ctrl/⌘ + L**). It's greyed out until there's something to export. This opens the
export dialog, where you choose a time range and download the log.

---

**Next:** [The Channels Tab →](channels.md) — where you view and edit the 500
channels themselves.
