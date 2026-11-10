# BC75XLT signal-strength capture (#815)

**Date:** 2026-11-10. **Hardware:** BC75XLT (`MDL,BC75XLT`, CP2104 `020D43D8`,
57600 baud) beside a BC125AT on batteries. **Data:**
[`bc75xlt-vs-bc125at.csv`](bc75xlt-vs-bc125at.csv), 2,054 samples, about 4 Hz.
**Script:** [`signal-capture.py`](signal-capture.py). It only reads the BC75XLT
(`MDL`, `GLG`, `PWR`): no program mode and no writes.

## Why

The BC75XLT has no signal meter on its LCD, and its `STS` has no `SIG_LVL`.
So the #861 fix (draw the bars the scanner itself draws) has nothing to copy
on this model, and Bearpaw still maps its raw `PWR` linearly from 0–1023. The
plan was to borrow the BC125AT's bars: both radios on the same broadcast,
with the BC125AT's bar count read off its screen against the BC75XLT's `PWR`.

**That plan failed, and why it failed is the main finding.** The BC125AT's
bars do not follow signal strength well enough to serve as a reference.

## Results

`PWR` with squelch open, samples at or below 200 excluded (see finding 3).
The bar column is what the BC125AT's screen showed, where it was read at all.

| Label in CSV | Band / mod | BC125AT bars | What you heard | 75XLT `PWR` median (p10–p90) |
|---|---|---|---|---|
| NOAA 162.550 | VHF FM | 5 | clear | **431** (429–441) |
| 145.130 sql2 | VHF FM | 5 | barely audible | **356** (341–365) |
| 155.0025 noise | VHF FM | 5 (squelch wide open) | hiss | **337** (323–350) |
| 443.775 CC off | UHF FM | 2, earlier 3 (range 3–5) | not recorded | **403** (218–404) |
| 460.000 noise | UHF FM | n/a | hiss | **237** (219–242) |
| 463.350 UHF watch | UHF FM | n/a | two transmissions, each called "clear" | **214** quiet (whole-run median); **366–371** during both |
| 128.375 sql2 | Air AM | 5 | quiet ATIS | **364** (357–374) |
| 120.750 | Air AM | n/a | buzz only | **348** (339–358) |
| 123.950 | Air AM | n/a | nothing steady | **367** (363–374) |
| 123.950 chatter | Air AM | n/a | quiet, with short transmissions | **366** quiet; **391–424** during transmissions |
| airband clear-tx watch (123.950) | Air AM | n/a | one "super clear" transmission, marked as it ended | **371** quiet; **428–431** during it (40–43 s in) |
| 135.000 noise | Air AM | n/a | empty | **375** (371–387) |
| 120.000 noise | Air AM | n/a | empty | **398** (394–402) |

The `bars` column in the CSV holds what was typed for each run. Runs that
ignored the BC125AT carry `0`. The 155.0025 run carries `-1`, which
the summary leaves out: its 5 bars were read on hiss.

## Findings

1. **The BC125AT's bars are not a usable strength reference.** It drew 5 bars
   on plain hiss with squelch wide open (squelch 2 closed it, so there was no
   signal). It also drew 5 bars on a barely audible 145.130 and on a clear
   NOAA, and 2–3 on a repeater the BC75XLT read as stronger than the barely
   audible one. Its count does not follow what you hear, at least near the
   bottom of its range. **This does not undo #861.** That change matches what
   a BC125AT owner sees on their own screen, which is the comparison they
   make. Whether that meter deserves matching is a separate question, opened
   here.

2. **On FM, the BC75XLT's `PWR` tracks what you hear.** On VHF the order runs
   hiss 337, barely audible 356, clear 431, the same order as by ear. It also
   holds steady: on the repeater it stayed near 403 while the BC125AT moved
   between 3 and 2 bars.

3. **The noise level differs by band.** With squelch open on an empty
   frequency: VHF 337, UHF 237, airband 375–398. A reading of 360 is barely
   above noise on VHF and well clear of it on UHF. **A single scale across
   bands would be wrong.** The 205–228 readings inside the 443.775 runs fall
   in UHF's noise range: they are the gaps between transmissions.

4. **`PWR` reads about 70 whenever squelch is closed.** On 162.550 with the
   squelch knob turned up it read 68–71 on a signal the BC125AT drew at 5
   bars. Turning squelch down took it straight to 440. So a closed squelch
   gives a reading that can't be mistaken for anything else.

5. **Close Call puts a dip in `PWR` every ~2.3 s.** With Close Call on, the
   BC75XLT left the frequency at a steady interval. Four samples caught it on
   111.55–111.87 MHz (airband), and samples taken while it was away read
   about 70. Turning Close Call off removed every dip (443.775: 27 dips
   before, 0 after). A user with Close Call on will see the same dip in
   Bearpaw's meter.

6. **On airband (AM), a signal reads higher, as on FM.** On 123.950 `PWR`
   sat at about 366 with no one talking, and jumped to 421–424 and 391–401
   during two short transmissions (the `123.950 AM, chatter` run, about 10 s
   and 32 s in). Until that run, the evidence pointed the other way: the two
   weak ATIS signals (quiet 364, buzz 348) read below both "empty"
   frequencies (375, 398), which looked like `PWR` running backwards on AM.
   It doesn't. Those signals were at the noise level, and 120.000 likely
   carried the buzz heard on it, so it wasn't empty. Airband's noise level
   is about 366–375. A transmission described as "super clear" read 428–431,
   about the same as the clear NOAA on VHF (431).

7. **VHF-low (27.025, CB, AM): `PWR` does not separate signal from noise.**
   Two 2-minute runs. With no transmission marked, the reading sat at
   410–464 (median 443-445). Two transmissions called clear read 422–434,
   no higher than the background. One unexplained dip to 133–166 lasted
   about 4 s with `GLG` still reporting squelch open. This is one frequency
   in a very noisy part of the spectrum, so a 6 m or 30–50 MHz FM signal may
   behave like VHF high. Nothing here supports a scale for 25–54 MHz.

8. **Unexplained: the August reading.** The 2026-08-26 probe read `PWR,278`
   on 145.130 with `GLG` reporting squelch closed. Finding 4 says a closed
   squelch reads about 70. Not reproduced, not explained.

## What it would take to finish

- **VHF FM:** enough to scale it now. Noise 337 at the bottom, clear 431 at
  the top.
- **UHF FM:** enough to scale it now. Noise about 214–237 at the bottom; two
  transmissions called clear on 463.350 read 366–371, and the 443.775
  repeater read 403. So the top is about 370–400: lower than VHF and
  airband (about 430). **Each band needs its own top as well as its own
  bottom.**
- **Airband AM:** enough to scale it now. Noise about 371 at the bottom, a
  clear transmission about 430 at the top. It rests on one transmission, and
  a steady strong signal would firm it up.
- **VHF low (25–54):** not scaled. See finding 7. A clear FM signal against
  an empty frequency in that range would settle it.

## What Bearpaw does with it

`ScannerCapabilities::pwr_bands` holds a floor (0 bars) and a top (5 bars)
for each band, and `rssi` is scaled linearly between them on the band the
`PWR` sample's own frequency falls in:

| Band | MHz | floor | top | Source |
|---|---|---|---|---|
| Airband | 108–137 | 371 | 430 | quiet 123.950 / its clear transmission |
| VHF high | 137–174 | 337 | 431 | 155.0025 hiss / NOAA 162.550 |
| UHF | 406–512 | 225 | 403 | middle of 214–237 / the 443.775 repeater |

The UHF top is 403, the repeater, by decision: the two clear 463.350
transmissions (~368) then show 4 bars. 25–54 MHz has no entry and keeps the
old linear 0–1023 mapping (finding 7). A `PWR` below 100 while `GLG` says
squelch is open is skipped as a Close Call dip (finding 5), and the last good
reading carries over.
