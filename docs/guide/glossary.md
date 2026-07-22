# Glossary

Every radio and app term the guide uses, defined once. Radio terms get a light
gloss (you probably know them); the app-specific and computer terms get a fuller
explanation.

---

### Alpha tag

The text name saved for a channel — like "FIRE DISPATCH" or "NOAA WX1." It's what
shows on the big display during a [hit](#hit) instead of a bare frequency.

> Alpha tags come from the scanner's memory, so they're blank until the
> [memory sync](#memory-sync) finishes. Before sync completes, hits show just the
> frequency.

### Bank

A group of 50 channels. The BC125AT's 500 channels are divided into **10 banks of
50** — channels 1–50 are Bank 1, 51–100 are Bank 2, and so on. You can turn whole
banks on or off for scanning (on the [Scan tab](scan.md#the-bank-buttons-19-0)),
and you view/edit one bank at a time (on the [Channels tab](channels.md#banks-the-sidebar)).

### Close Call

Uniden's feature for detecting a strong signal from a transmitter physically close
to you and jumping to it automatically — even if that frequency isn't in your
channels. Good for finding what a nearby handheld is transmitting on. Configured
on the [Device tab](device.md#close-call).

### CTCSS / tone / DCS

Sub-audible codes sent along with a transmission so a receiver can be set to open
only for its own group and ignore everyone else sharing the frequency.

- **CTCSS** is a continuous tone, identified by its frequency in Hz (e.g. 123.0).
  Bearpaw lets you set a CTCSS tone when [editing a
  channel](channels.md#editing-a-channel).
- **DCS** is a digital version of the same idea, identified by a code number.

Bearpaw shows whichever a live signal is carrying, on the display, for as long as
the signal is open.

### Delay

How long the scanner waits on a channel after a transmission ends before it
resumes scanning — so you have time to hear the reply in a back-and-forth. Set per
channel, in seconds. Bearpaw also supports _negative_ delays (pre-delays), where
the scanner holds _before_ the next transmission.

### Draft

An edit you've made on the [Channels tab](channels.md) that is **held in the app
and not yet written to the scanner**. You make as many drafts as you want, then
push them all to the radio at once with **Upload Changes**. This is Bearpaw's way
of letting you batch and review edits before committing them. (See [Drafts and
uploading](channels.md#drafts-and-uploading-the-important-part).)

### Hit

When the scanner stops on a frequency because a signal is present. A hit is the
central event in the app: the display switches from "Scanning…" to the live
frequency and details, and — if the transmission lasts long enough — it's recorded
in your activity log. (See the [hit workflow](getting-started.md#step-4--your-first-hit).)

### Hold

A mode where the scanner stays parked on the current channel instead of cycling
through them. _You_ turn Hold on (with the HOLD button or Ctrl/⌘ + H). Note that
during an ordinary [hit](#hit) the scanner is paused but **not** in Hold — it's
still scanning, just waiting out the transmission.

### Lockout

Telling the scanner to **skip** a frequency or channel so it stops stopping on it.

- A **temporary lockout** lasts until the scanner is powered off, and targets the
  frequency you're currently on.
- A **permanent lockout** is written into the channel's memory and stays until you
  remove it.

Both are toggles — apply again to remove. On the [Scan
tab](scan.md#lo--lock-out-a-frequency), a single click sets a temporary lockout
and a double-click sets a permanent one. You can review and clear permanent
lockouts under [Locked Channels](device.md#locked-channels).

### Memory sync

Reading all 500 channels out of the scanner into the app. Because the scanner
hands them over one at a time, it takes about **30–45 seconds**. It runs
automatically when the app connects, and you can re-run it from **Scanner → Sync
Memory**. Bearpaw doesn't store your channels between sessions — it always
re-reads them from the radio, so what you see matches the actual scanner.

### Modulation

How a signal carries its audio. The BC125AT handles **AM**, **FM**, and **NFM**
(narrow FM). When [editing a channel](channels.md#editing-a-channel) you can also
choose **AUTO**, which lets the scanner pick based on the frequency.

### Priority

A channel the scanner checks periodically even while it's scanning or holding
somewhere else, so you don't miss activity on a channel that matters. **Each bank
can have only one priority channel.** In Bearpaw, the Priority switch is unusual:
it applies to the scanner _immediately_, not as a [draft](#draft). Priority
_mode_ (off/on/plus) is set separately on the [Device
tab](device.md#scanning-logic).

### RSSI

"Received Signal Strength Indicator" — how strong the received signal is. Bearpaw
shows it as a five-bar meter, like the signal bars on a phone.

### Squelch

The circuit that mutes the receiver until a signal is strong enough to be worth
hearing — it's what keeps the scanner silent between transmissions. Raising
squelch means only stronger signals get through; lowering it lets weaker ones (and
more noise) in.

> In the app's inner workings, "squelch open" means a signal _is_ present (the
> scanner has un-muted) — which is the active, interesting state. That's the
> opposite of how "open" might sound at first.

### Sync

See [memory sync](#memory-sync).

### Upload (Upload Changes)

The action that writes your pending channel [drafts](#draft) to the scanner. Until
you press **Upload Changes** on the [Channels tab](channels.md), your edits stay
in the app and the radio is untouched.

---

**Back to:** [Getting Started](getting-started.md) · [The Scan Tab](scan.md) ·
[The Channels Tab](channels.md) · [The Device Tab](device.md)
