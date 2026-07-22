# The Channels Tab

The Channels tab is where you manage your scanner's memory: all 500 channels,
without the radio's keypad. Rename them, change frequencies, set tones, lock out
the noisy ones, and reorder them. When you're done, you push your changes back to
the radio.

> **Your edits don't reach the scanner until you press "Upload Changes."**
> Everything you change here is held as a _draft_, a pending change stored in the
> app, until you upload it. Close the editor, switch tabs, edit ten more
> channels: nothing touches the radio until you upload. Batching this way lets
> you make a set of changes and review them before they go to the scanner. (More
> on this [below](#drafts-and-uploading-the-important-part).)

---

## Banks: the sidebar

Your 500 channels are organized into **10 banks of 50 channels each**. Channels 1
to 50 are Bank 1, 51 to 100 are Bank 2, and so on. The left sidebar has a button
for each bank.

**Click a bank to see its 50 channels.** Only one bank shows at a time; the app
opens on Bank 1. The selected bank is highlighted with a small glowing dot, and
its number appears next to the "Bank Channels" heading.

> These sidebar buttons choose _which channels you're looking at and editing_.
> They're different from the bank buttons on the
> [Scan tab](scan.md#the-bank-buttons-1-to-9-then-0), which turn banks on and off
> _for scanning_.

## The channel list

Each row is one channel. The columns, left to right:

| Column   | What it means                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------ |
| ☑        | A checkbox to **select** the row for a bulk action (see the [toolbar](#the-toolbar)).            |
| ⠿        | A **drag handle**. Grab it to reorder the channel within its bank.                               |
| **CH**   | The channel number (1 to 500).                                                                   |
| **FREQ** | The frequency, in MHz (e.g. `146.8500`).                                                         |
| **TAG**  | The channel's name (its [alpha tag](glossary.md#alpha-tag)), or a dash if unnamed.               |
| **MODE** | The [modulation](glossary.md#modulation): AUTO, FM, AM, or NFM.                                  |
| **TONE** | The [CTCSS tone](glossary.md#ctcss--tone--dcs) in Hz, or a dash for none.                        |
| **DLY**  | The [delay](glossary.md#delay) in seconds before the scanner resumes after a transmission.       |
| **L/O**  | A red **lock** icon if the channel is [locked out](glossary.md#lockout) (skipped when scanning). |
| **PRIO** | A glowing dot if this is the bank's [priority](glossary.md#priority) channel.                    |

**To edit a channel, click anywhere on its row** except the checkbox. That opens
the edit panel. The checkbox in the header row selects (or clears) every channel
currently shown.

## Editing a channel

Clicking a row opens the **Edit Channel** panel. Every field:

**Frequency (MHz)** is a direct entry. The BC125AT doesn't cover one continuous
range; it covers four bands: **25 to 54, 108 to 174, 225 to 380, and 400 to 512
MHz**. Enter something outside those bands (say, 90.0 MHz) and the app rejects it
with a message. Enter `0` to mark the channel empty.

**Alpha Tag** is the channel's name, up to **16 characters**.

**Modulation** is one of **AUTO**, **FM**, **AM**, or **NFM** (narrow FM). AUTO
lets the scanner choose based on the frequency.

**Tone Squelch (CTCSS Hz)** sets a [CTCSS tone](glossary.md#ctcss--tone--dcs) so
the scanner only opens on transmissions carrying that tone. Leave it blank for
none. The app accepts only the standard CTCSS tones (67.0 to 254.1 Hz) and warns
you on a value that isn't one of them.

**Delay (seconds)** is how long the scanner waits on a channel after a
transmission ends before it resumes scanning, giving you time to hear a reply.
Choose from **-10, -5, 0, 1, 2, 3, 4, 5**. The negative values are _pre-delays_:
the scanner holds _before_ the next transmission.

**Lockout** is a switch. On means the scanner skips this channel. It's a draft,
like the fields above, and takes effect when you upload.

**Priority** is a switch, and it applies to the scanner immediately rather than
waiting for Upload. The radio allows only one priority channel per bank, so
turning it on where another channel already has priority asks you to confirm
moving it. (More on priority in the [Glossary](glossary.md#priority).)

At the bottom: **Save Draft** stores your changes as a pending draft, and won't
let you save while a field has an error. **Clear** blanks the panel to an empty
channel. **Cancel** discards your edits.

## Drafts and uploading (the important part)

Between the toolbar and the channel list is a status strip that reads either
**"Edits are saved as drafts. No pending changes."** or **"…N pending."**, next
to two buttons: **Discard Changes** and **Upload Changes**.

1. **Edit** one or more channels. Each saved edit becomes a _draft_. Rows with
   pending changes get a colored bar down their left edge, and the pending count
   ticks up.
2. **Review.** Nothing has touched the radio yet. Edit more, or change your mind.
3. **Upload.** Press **Upload Changes**. The app writes your drafts to the
   scanner, then re-reads the channels to confirm they took. The button reads
   "Uploading…" while it works.

To throw away all your pending edits without uploading, press **Discard Changes**
(it asks you to confirm first).

The **Priority** switch is the exception. It applies the moment you toggle it.
Everything else waits for Upload.

## The toolbar

Across the top of the tab:

- **Search box**: filter the current bank by frequency or name. Drag-reorder is
  turned off while a search is active.
- **Clear Selected**: blanks all the checkbox-selected channels. Like edits, this
  creates drafts; it doesn't wipe them from the radio until you upload.
- **Import**: load channels from a file. Bearpaw reads two kinds.
  - A **CSV** file is a plain spreadsheet of channels (opens in Excel or
    Numbers).
  - A **`.bc125at_ss`** file is a full backup (the same format the official
    Sentinel software uses), containing _all_ your channels _and_ settings.
    Importing one overwrites everything, so the app warns you first.
- **Export**: save your channels to a file, in either format.
  - **CSV**: just the channel list.
  - **BC125AT**: the full backup (channels and settings), read live from the
    radio.
- **Drag to reorder**: grab a row's handle (⠿) and drag it up or down to change
  the channel order within the bank. Reordering is a draft, and uploads with
  everything else.

> Reordering is mouse-only. There's no keyboard path to it yet.

## Refreshing from the scanner (memory sync)

Your channels are read from the scanner when the app starts. This **memory sync**
takes about 30 to 45 seconds, because the scanner hands over its 500 channels one
at a time.

To re-read them manually, say after you changed something on the radio's own
keypad, use **Scanner → Sync Memory** in the menu (or **Ctrl/⌘ + Y**). A panel
covers the screen with a progress bar and blocks the UI until it's done.

---

**Next:** [The Device Tab](device.md), the scanner's own settings and the app's
preferences.
