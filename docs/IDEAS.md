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
