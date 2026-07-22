# Getting Started

Plug in the scanner, launch Bearpaw, and this walks you from there to watching
live radio traffic on screen. Do the steps in order the first time.

If a radio term trips you up, the **[Glossary](glossary.md)** defines every one
of them.

---

## What you'll need

- A **Uniden BC125AT** scanner. Bearpaw also works with the closely related
  BCT125AT, UBC125XLT, UBC126AT, and AE125H.
- The **USB cable** that came with it, or any USB cable that carries _data_, not
  just power. A charge-only cable is the usual reason the app won't connect.
- Bearpaw installed on your computer. If you haven't done that yet, see the
  [README](../../README.md#download-and-install).

## Step 1: Plug in and launch

Connect the scanner to your computer with the USB cable, turn the scanner on, and
open Bearpaw. There's nothing to configure. Bearpaw looks for the scanner the
moment it starts.

The small colored dot in the bottom-left corner shows where the connection
stands:

- 🟡 **Yellow, "Connecting…"**: Bearpaw is reaching for the scanner, which is
  normal for a few seconds at launch.
- 🟢 **Green, "BC125AT"**: connected, showing your scanner's model name.
- 🔴 **Red, "Disconnected"**: no link yet. If it stays red, go to
  [Troubleshooting](troubleshooting.md).

## Step 2: The first sync

The first time Bearpaw connects, it reads all 500 of your channels out of the
scanner. This is a **memory sync**, and it takes about 30 to 45 seconds. The
scanner hands over its channels one at a time.

A "Syncing Scanner Memory" panel covers the screen with a progress bar while it
runs, and blocks the UI until it's done.

> Bearpaw doesn't keep a copy of your channels on the computer between sessions.
> It re-reads them fresh every time it starts, so what you see is what's actually
> in the radio.

## Step 3: Watch it scan

The big amber panel in the middle of the **Scan tab** is your scanner's display,
blown up to full size. When the scanner is scanning, it reads **"Scanning…"**
with "Searching for signal…" below it. The scanner is cycling through your
channels five to ten times a second, listening for activity.

Tune your handheld to one of the scanner's channels and key up if you want to
force a result. Otherwise, wait for traffic.

## Step 4: Your first hit

When the scanner lands on an active frequency, that's a **hit**.

1. **"Scanning…" is replaced by the signal.** The big line shows the channel's
   name (its _alpha tag_) if it has one, or the frequency if it doesn't.
2. **The detail line fills in** underneath: the frequency, the modulation (FM,
   AM, or NFM), the channel number, and, if the transmission carries one, the
   CTCSS tone.
3. **The signal-strength bars** on the right light up, like the bars on a phone.
4. When the transmission ends, the scanner resumes and the display goes back to
   "Scanning…".

> During a hit, the scanner has _paused itself_ on the busy frequency, but it is
> **not** in "Hold" mode. It's still in Scan mode, waiting out the transmission
> before it moves on. Hold is something _you_ switch on with the **HOLD** button.
> (More on that in [The Scan Tab](scan.md).)

## Step 5: Look at what you've caught

Two places record what the scanner hears:

- The **Recent Hits** list, to the right of the big display, shows the last few
  active frequencies with how long ago each one happened.
- The **dashboards** below, a "Busiest Channels" bar chart and an "Activity
  Heatmap," build up a picture of _when_ and _where_ your scanner is most active
  over time.

## Where to go next

- **Everything on the Scan tab**, the controls, the status bar, what each part of
  the display means: **[The Scan Tab](scan.md)**
- **Edit your channels**, rename them, change frequencies, lock out the noisy
  ones: **[The Channels Tab](channels.md)**
- **Adjust the scanner itself**, volume, squelch, Close Call, custom searches:
  **[The Device Tab](device.md)**
- **Something not working?** **[Troubleshooting](troubleshooting.md)**
