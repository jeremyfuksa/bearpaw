# Getting Started

This is the fifteen-minute tour: from a scanner in a box to watching live radio
traffic scroll across your screen. Follow it in order the first time — each step
builds on the one before.

If a radio term trips you up, the **[Glossary](glossary.md)** defines every one
of them.

---

## What you'll need

- A **Uniden BC125AT** scanner (Bearpaw also works with the closely related
  BCT125AT, UBC125XLT, UBC126AT, and AE125H).
- The **USB cable** that came with it — or any USB cable that carries _data_, not
  just power. A charge-only cable is the single most common reason the app won't
  connect.
- Bearpaw installed on your computer. If you haven't done that yet, see the
  [README](../../README.md#download-and-install).

## Step 1 — Plug in and launch

Connect the scanner to your computer with the USB cable, turn the scanner on, and
open Bearpaw.

You don't need to configure anything. Bearpaw looks for the scanner on its own
the moment it starts — this works the same on Mac, Windows, and Linux.

**Look at the bottom-left corner of the window.** There's a small colored dot:

- 🟡 **Yellow — "Connecting…"** — Bearpaw is reaching for the scanner. Normal for
  a few seconds at launch.
- 🟢 **Green — "BC125AT"** — connected. The dot turns green and shows your
  scanner's model name.
- 🔴 **Red — "Disconnected"** — no link yet. Jump to
  [Troubleshooting](troubleshooting.md) if it stays red.

## Step 2 — Wait for the first sync

The first time Bearpaw connects, it reads all 500 of your channels out of the
scanner. This is called a **memory sync**, and it takes about **30 to 45
seconds** — the scanner hands over its channels one at a time, and there's no way
to hurry it.

While it runs, a "Syncing Scanner Memory" panel covers the screen with a progress
bar. Let it finish. When it's done, the panel disappears and your channels are
loaded.

> **Why the wait?** Your scanner is the source of truth, not Bearpaw. The app
> doesn't keep a copy of your channels on the computer between sessions — it
> re-reads them fresh every time it starts, so what you see always matches
> what's actually in the radio.

## Step 3 — Watch it scan

You're now on the **Scan tab** (the first of the three tabs across the top). The
big amber panel in the middle is your scanner's display, blown up to full size.

If the scanner is scanning, you'll see **"Scanning…"** pulsing gently, with
"Searching for signal…" below it. Behind the scenes the scanner is cycling
through your channels five to ten times a second, listening for activity.

Now wait for traffic — or, if you want to guarantee a result, tune your handheld
to one of the scanner's channels and key up.

## Step 4 — Your first hit

When the scanner lands on an active frequency, that's a **hit**. Here's what you
see happen:

1. **"Scanning…" is replaced by the signal.** The big line shows the channel's
   name (its _alpha tag_) if it has one, or the frequency if it doesn't.
2. **The detail line fills in** underneath: the frequency, the modulation (FM/AM/
   NFM), the channel number, and — if the transmission carries one — the CTCSS
   tone.
3. **The signal-strength bars** on the right light up, like the bars on a phone.
4. When the transmission ends, the scanner resumes and the display goes back to
   "Scanning…".

That's the core of the whole app. Everything else builds on it.

> **A thing that surprises people:** during a hit, the scanner has _paused
> itself_ on the busy frequency, but it is **not** in "Hold" mode. It's still in
> Scan mode — it's just waiting out the transmission before it moves on. You only
> enter Hold when _you_ press the **HOLD** button. (More on that in [The Scan
> Tab](scan.md).)

## Step 5 — Look at what you've caught

Two places record what the scanner hears:

- The **Recent Hits** list, to the right of the big display, shows the last few
  active frequencies with how long ago each one happened.
- The **dashboards** below — a "Busiest Channels" bar chart and an "Activity
  Heatmap" — build up a picture of _when_ and _where_ your scanner is most
  active, over time.

Give it a few minutes of listening and these start to fill in.

## Where to go next

You've got the scanner connected, synced, and scanning — the hard part is done.
From here, pick what you want to do:

- **Understand everything on the Scan tab** — the controls, the status bar, what
  each part of the display means → **[The Scan Tab](scan.md)**
- **Edit your channels** — rename them, change frequencies, lock out the noisy
  ones → **[The Channels Tab](channels.md)**
- **Adjust the scanner itself** — volume, squelch, Close Call, custom searches →
  **[The Device Tab](device.md)**
- **Something not working?** → **[Troubleshooting](troubleshooting.md)**
