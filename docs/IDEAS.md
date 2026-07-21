# Ideas

Product ideas for Bearpaw that aren't scheduled work yet. Captured here so they
don't get lost. Not a roadmap or a commitment — a holding place.

## Location-aware channel fill

Let the user enter their **location**, then use it to pre-populate the channel
list: query [RadioReference](https://www.radioreference.com/) and
[RepeaterBook](https://www.repeaterbook.com/) for the repeaters, business
licenses, and public-safety systems near that location, and fill in the
frequencies, names, and metadata automatically instead of making the user type
each channel by hand.

**Why it fits Bearpaw specifically:** the stock Uniden channel editor is a
spreadsheet you populate yourself — frequency, a name capped at sixteen
characters, a little metadata, all by hand. That's the tedium worth removing. A
frequency is a lookup key, and the data already lives online, so the app can go
get it.

**How this differs from Kerchunk's lookup:** Kerchunk looks a frequency up
_reactively_ — after a hit lands, it enriches that hit against public databases
and plots it. Bearpaw's version runs the other direction: _proactively_ seed the
channel list from where you are, before any scanning happens. Location in →
channels out. Same data sources, opposite trigger. This is a Bearpaw feature, not
a Kerchunk one.

**Open questions:**

- Location input: manual entry, or derive from an IP/geo lookup?
- Radius / how many channels to pull, and how to let the user prune.
- Data source access: RadioReference is subscription-gated; check terms before
  building against it.

---

## Priority-channel follow-ups (from the 2026-07-21 one-per-bank rework)

The priority-channel feature (spec + plan in `docs/superpowers/`, the
`POST /memory/channels/{index}/priority` endpoint, DCH+rewrite clear, atomic
one-per-bank swap) shipped with three deliberately-deferred items. None affect
correctness of the shipped code; all were triaged as follow-up by the final
whole-branch review.

- **Failure-injectable transport mock.** The atomicity guarantee (a failed
  clear aborts the swap before the new channel is set) and the endpoint's
  happy-path (true→set / false→clear through HTTP) are currently proven only
  structurally (the `?`-abort + the `REGRESSION GUARD (priority swap
  atomicity)` comment in `set_channel_priority`) and by the pure planner test
  `plan_priority_swap_orders_clear_before_set`. A true abort-path test and an
  endpoint success-path test both need a mock transport that can simulate
  "connects fine, but the DCH/CIN round-trip fails." Building that mock unblocks
  both tests at once.

- **Drop the vestigial `ChannelDraft.priority`.** Since the edit-sheet toggle
  became an immediate action, priority no longer flows through the draft/upload
  path — but `ChannelDraft.priority` is still set by `buildDraft` and read at
  `ChannelsTab.tsx:915` (`draft?.priority ?? channel.priority`, always redundant
  now). Correct today, but a footgun: a future edit could reconnect it and
  resurface the false `channel_write_mismatch` this rework killed. Clean it up:
  remove `priority` from `ChannelDraft` and simplify the `displayPriority`
  derivation to read `channel.priority` directly.

- **Real abort-path hardware verification.** The DCH+rewrite swap has never been
  exercised end-to-end on the physical scanner (all tests avoid hardware by
  design). A manual verification pass — set priority on a bank with an existing
  priority channel and confirm the old one clears; clear priority and confirm
  the channel data survives — is the last mile before full confidence.
