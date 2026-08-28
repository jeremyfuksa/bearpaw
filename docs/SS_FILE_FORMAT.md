# Uniden settings-file format (`.bc125at_ss`, `.bc75xlt_ss`)

The format Uniden's own "SS" tools read and write. Bearpaw exports both.

**Recovered from real files, not from a specification.** Uniden publishes no
format document. Everything here comes from files written by their software,
cross-checked between models, and confirmed end-to-end: a Bearpaw-generated
`.bc75xlt_ss` opens correctly in BC75XLT SS on Windows (2026-08-27).

> **Captures win.** As with the wire protocol, if a reference disagrees with a
> real file, the file is authoritative. Two of the bugs recorded below survived
> review precisely because they were reasoned about rather than diffed.

## Provenance

| Source | What it settled |
|---|---|
| `BC75XLT_SS_V1_01_00` installer (.NET assembly strings) | The `.bc75xlt_ss` extension, the section keywords, the service-band names |
| Two same-day exports, one per radio, from one owner | Which differences are the MODEL rather than the tool version or the operator |
| Three BC125AT exports from different dates | Which `Misc` field varies — identifying it as squelch |
| `New` → `Save As` blanks from both tools | Section ORDER, and that `AvoidFreqs` is absent at zero lockouts |
| Loading a Bearpaw file into BC75XLT SS | That the whole thing is actually valid, not merely similar |

Anonymised and blank reference files live in `crates/bearpaw-api/fixtures/`.
They back the golden tests `bc125at_ss_export_matches_the_reference_file_shape`
and `bc75xlt_ss_export_matches_the_reference_file_shape`.

## Envelope

- **ASCII**, tab-delimited
- **CRLF** line endings, *including a trailing CRLF after the last line*
- One section keyword per line, in the first field
- Frequencies as **integer Hz** (`145130000` = 145.130 MHz)
- Booleans as the literal words `On` / `Off`
- Unsupported fields are **empty**, never `0` or a placeholder

## Section order

Both models share the same skeleton. Sections absent for a model are simply
not written — there is no empty placeholder line.

```
Misc
Priority
WxPri              BC125AT only
Service        x10
CustomSearch       BC75XLT only
Custom         x10
CloseCall
CloseCallBands
GeneralSearch
AvoidFreqs         BC125AT only, and only when global lockouts exist
Conventional   ┐   these two INTERLEAVE, per bank:
C-Freq         ┘   one Conventional line, then that bank's channels
```

**The interleave is the single easiest thing to get wrong.** Banks and channels
alternate — `Conventional 1`, its 50 (or 30) channels, `Conventional 2`, its
channels, and so on. Bearpaw emitted all bank lines followed by all channel
lines for both models and it went unnoticed through review of three real files,
because the analysis aggregated lines by section *name* regardless of position.
Grouped and interleaved are indistinguishable unless you compare *sequence*.

## Sections

Field counts include the keyword itself.

### `Misc` — 9

```
Misc  backlight  beep  keylock  contrast  volume  squelch  charge  region
```

| | BC125AT | BC75XLT |
|---|---|---|
| backlight | `K+S` etc. | *empty* — no `BLT` command |
| beep | `Off` | *empty* |
| keylock | `Off` | `Off` |
| contrast | `8` | *empty* — no `CNT` command |
| volume | `14` | *empty* — **even though `VOL` answers on the wire** |
| squelch | `6` | `2` |
| charge | `2` | `2` |
| region | `USA` / `EUR` | `USA` |

`region` is `EUR` for the UBC-prefixed European variants (`UBC125XLT`,
`UBC126AT`), `USA` otherwise. Bearpaw resolves it from
`ScannerCapabilities::ss_region` rather than matching on the model string.

The empty BC75XLT volume slot is not an oversight to correct: the tool does not
write it for that model, and populating it puts a value where Uniden's parser
expects none.

### `Priority` — 2, `WxPri` — 2

```
Priority  On|Off
WxPri     On|Off      BC125AT only — the BC75XLT has no weather alert
```

### `Service` — 4 (BC125AT) / 6 (BC75XLT)

```
BC125AT   Service  n  name  On|Off
BC75XLT   Service  n  name  ''  delay  direction
```

The BC75XLT gains a delay and a direction (`Up`/`Down`), and its band list
differs — `WX` is first and the BC125AT does not have it:

```
WX, Police, Fire/Emergency, Marine, Racing, Civil Air, HAM Radio,
Railroad, CB Radio, Other (FRS/GMRS/MURS)
```

### `CustomSearch` — 3 (BC75XLT only)

```
CustomSearch  delay  direction
```

### `Custom` — 6

```
Custom  n  name  lowerHz  upperHz  On|Off
```

**The `name` differs between tools and both spellings are load-bearing:**

```
BC125AT   Search Bnak1      <- Uniden's typo
BC75XLT   Search Bank1      <- fixed in the newer tool
```

Do not "correct" the BC125AT spelling. It is what their software writes and
presumably what it expects.

### `CloseCall` — 5, `CloseCallBands` — 6

```
CloseCall       mode  beep  light  lockout
CloseCallBands  b1  b2  b3  b4  b5
```

On a BC75XLT, band 4 is **empty** rather than `Off` — that model has no
225–380 MHz band at all.

### `GeneralSearch` — 3 (BC125AT) / 4 (BC75XLT)

```
BC125AT   GeneralSearch  delay  code
BC75XLT   GeneralSearch  delay  code  direction
```

### `AvoidFreqs` — 18 (BC125AT only, optional)

The keyword plus 17 slots holding global lockout frequencies. **Absent entirely
when there are no lockouts** — confirmed by the blank file.

Bearpaw does not write this section, so exported global lockouts are lost. Only
one sample containing it exists, with a single frequency in slot 2 and slot 1
empty, which cannot distinguish fixed positions from a packed list. See #459.

### `Conventional` — 4, `C-Freq` — 9

```
Conventional  n  Bank n  On|Off
C-Freq  idx  name  freqHz  modulation  tone  lockout  delay  priority
```

`C-Freq` count is the model's channel capacity — 500 on the BC125AT family,
300 on the BC75XLT — and every slot is written, empty ones included
(`freqHz` = `0`).

On a BC75XLT, `name`, `modulation` and `tone` are always **empty**: those `CIN`
fields are `[RSV]` on that model.

**`delay` is a constant `2` on the BC75XLT.** 600 of 600 channels across two
real files, empty slots included. It cannot be echoing the radio — that model's
`CIN` delay is a boolean (`0`/`1`), so `2` is not a value the wire can produce.
The file's delay column uses the BC125AT's seconds vocabulary, which the
BC75XLT has no counterpart for, and the tool fills it with a fixed `2`. The
BC125AT files *do* vary here (490 × `2`, 10 × `0`), so this is specific to the
model rather than to the format.

Writing the wire value instead produces a file that differs from Uniden's on
every channel row — see #458.

## Which wire commands each export may send

An export runs inside one `PRG` bracket. Sending a command the model does not
answer stalls that bracket (#436), so each exporter is limited to commands
confirmed on that hardware.

| | BC125AT | BC75XLT |
|---|---|---|
| Read | `BLT` `KBP` `BSV` `CNT` `VOL` `SQL` `PRI` `SCO` `CLC` `SCG` `CSP,n` `SSP,n` `WXS` | `KBP` (inside `PRG`) `SQL` `PRI` `SCO` `CLC` `SCG` |
| Never sent | — | `BLT` `BSV` `CNT` `WXS` — all reply `ERR` |
| Not probed | — | `CSP` `SSP` |

Because `CSP` has never been probed on a BC75XLT, its custom-search ranges come
from a table taken from real files rather than from an unanswered command
inside the bracket.

## Known gaps

- **`AvoidFreqs` is never written** (#459) — global lockouts do not survive an export
- **No importer for `.bc75xlt_ss`** (#460) — Bearpaw writes it but cannot read it
- **The BC125AT export has not been opened in Uniden's software.** The BC75XLT
  export has (2026-08-27). The BC125AT path is the older code and has had two
  structural bugs found in one day — CRLF (#456) and interleaving (#461) —
  neither of which any test caught until a sequence-exact comparison existed.
