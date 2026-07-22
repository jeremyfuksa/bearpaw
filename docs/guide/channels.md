# The Channels Tab

The Channels tab is where you manage your scanner's memory — all 500 channels,
without touching the radio's keypad. Rename them, change frequencies, set tones,
lock out the noisy ones, and reorder them. When you're done, you push your changes
back to the radio.

There's one idea that trips up almost everyone at first, so let's put it up front:

> **Your edits don't reach the scanner until you press "Upload Changes."**
> Everything you change here is held as a _draft_ — a pending change stored in the
> app — until you deliberately upload it. Close the editor, switch tabs, edit ten
> more channels: nothing touches the radio until you upload. (This is a feature,
> not a quirk — it lets you make a batch of changes and review them before
> committing. More on this [below](#drafts-and-uploading-the-important-part).)

---

## Banks: the sidebar

Your 500 channels are organized into **10 banks of 50 channels each** — channels
1–50 are Bank 1, 51–100 are Bank 2, and so on. The left sidebar has a button for
each bank.

**Click a bank to see its 50 channels.** Only one bank shows at a time; the app
opens on Bank 1. The selected bank is highlighted with a small glowing dot, and
its number appears next to the "Bank Channels" heading.

> These sidebar buttons choose _which channels you're looking at and editing_.
> They're different from the bank buttons on the [Scan tab](scan.md#the-bank-buttons-19-0),
> which turn banks on and off _for scanning_.

## The channel list

Each row is one channel. The columns, left to right:

| Column   | What it means                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------ |
| ☑        | A checkbox to **select** the row for a bulk action (see the [toolbar](#the-toolbar)).            |
| ⠿        | A **drag handle** — grab it to reorder the channel within its bank.                              |
| **CH**   | The channel number (1–500).                                                                      |
| **FREQ** | The frequency, in MHz (e.g. `146.8500`).                                                         |
| **TAG**  | The channel's name (its [alpha tag](glossary.md#alpha-tag)), or `—` if unnamed.                  |
| **MODE** | The [modulation](glossary.md#modulation): AUTO, FM, AM, or NFM.                                  |
| **TONE** | The [CTCSS tone](glossary.md#ctcss--tone--dcs) in Hz, or `—` for none.                           |
| **DLY**  | The [delay](glossary.md#delay) in seconds before the scanner resumes after a transmission.       |
| **L/O**  | A red **lock** icon if the channel is [locked out](glossary.md#lockout) (skipped when scanning). |
| **PRIO** | A glowing dot if this is the bank's [priority](glossary.md#priority) channel.                    |

**To edit a channel, click anywhere on its row** (except the checkbox) — this
opens the edit panel. The checkbox just selects the row without opening anything.
The checkbox in the header row selects (or clears) every channel currently shown.

## Editing a channel

Clicking a row opens the **Edit Channel** panel. Here's every field:

**Frequency (MHz)** — type the frequency directly. The BC125AT doesn't cover one
continuous range; it covers four bands: **25–54, 108–174, 225–380, and 400–512
MHz**. If you enter something outside those bands (say, 90.0 MHz), the app rejects
it with a message rather than letting you save a frequency the scanner can't tune.
Enter `0` to mark the channel empty.

**Alpha Tag** — the channel's name, up to **16 characters**. This is what shows on
the big display during a hit.

**Modulation** — pick **AUTO**, **FM**, **AM**, or **NFM** (narrow FM). AUTO lets
the scanner choose based on the frequency; most of the time that's the right
answer.

**Tone Squelch (CTCSS Hz)** — a [CTCSS tone](glossary.md#ctcss--tone--dcs) so the
scanner only opens on transmissions carrying that tone. Leave it blank for none.
The app accepts only the standard CTCSS tones (67.0 through 254.1 Hz) and warns
you if you type a value that isn't one of them.

**Delay (seconds)** — how long the scanner waits on a channel after a transmission
ends before it resumes scanning, giving you time to hear a reply. Choose from
**-10, -5, 0, 1, 2, 3, 4, 5**. The negative values are _pre-delays_ — the scanner
holds _before_ the next transmission, a real BC125AT feature.

**Lockout** — a switch. On = the scanner skips this channel. This is a draft, like
the fields above — it takes effect when you upload.

**Priority** — a switch, and it behaves differently from everything else in this
panel: **Priority takes effect immediately**, not as a draft. Because the radio
allows only one priority channel per bank, turning it on where another channel
already has priority asks you to confirm moving it. (More on priority in the
[Glossary](glossary.md#priority).)

At the bottom: **Save Draft** stores your changes as a pending draft (it won't let
you save while a field has an error). **Clear** blanks the panel to an empty
channel. **Cancel** discards your edits without saving anything.

## Drafts and uploading (the important part)

Between the toolbar and the channel list is a status strip that reads either
**"Edits are saved as drafts. No pending changes."** or **"…N pending."** — and
two buttons: **Discard Changes** and **Upload Changes**.

Here's the whole workflow:

1. **Edit** one or more channels. Each saved edit becomes a _draft_. Rows with
   pending changes get a colored bar down their left edge, and the pending count
   ticks up.
2. **Review.** Nothing has touched the radio yet. Edit more, or change your mind.
3. **Upload.** Press **Upload Changes**. _Now_ the app writes your drafts to the
   scanner, then re-reads the channels to confirm they took. The button reads
   "Uploading…" while it works.

To throw away all your pending edits without uploading, press **Discard Changes**
(it asks you to confirm first).

> **The one exception:** the **Priority** switch is applied to the scanner
> _immediately_ when you toggle it — it does not wait for Upload. Everything else
> (frequency, tag, mode, tone, delay, lockout, reordering) waits.

## The toolbar

Across the top of the tab:

- **Search box** — filter the current bank by frequency or name. (Reordering by
  drag is turned off while a search is active.)
- **Clear Selected** — blanks all the checkbox-selected channels. Like edits,
  this creates drafts — it doesn't wipe them from the radio until you upload.
- **Import** — load channels from a file. Bearpaw reads two kinds:
  - A **CSV** file — a plain spreadsheet of channels (opens in Excel or Numbers).
  - A **`.bc125at_ss`** file — a full backup (the same format the official
    Sentinel software uses), containing _all_ your channels _and_ settings.
    Importing one of these overwrites everything, so the app warns you first, and
    it takes a while (there's a progress bar).
- **Export** — save your channels to a file, in either format:
  - **CSV** — just the channel list.
  - **BC125AT** — the full backup (channels and settings), read live from the
    radio.
- **Drag to reorder** — grab a row's handle (⠿) and drag it up or down to change
  the channel order within the bank. Reordering is a draft, like any edit — it
  uploads with everything else.

> **Reordering is mouse-only.** There's no keyboard way to drag a row (yet). If
> you rely on the keyboard, this is a known gap we're tracking.

## Refreshing from the scanner (memory sync)

Your channels are read from the scanner when the app starts — this is the **memory
sync**, and it takes about **30–45 seconds** because the scanner hands over its
500 channels one at a time.

To re-read them manually — say, if you changed something on the radio's own keypad
and want Bearpaw to catch up — use **Scanner → Sync Memory** in the menu (or
**Ctrl/⌘ + Y**). A panel covers the screen with a progress bar while it runs; let
it finish before clicking around.

---

**Next:** [The Device Tab →](device.md) — the scanner's own settings, and the
app's preferences.
