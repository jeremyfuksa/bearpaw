# BC75XLT custom-search and Close Call probes

**Capture date:** 2026-08-28
**Device:** BC75XLT (firmware `Version 1.02.04`)
**Connection:** CP210x bridge at 57600 8N1, `/dev/cu.usbserial-020D43D8`
**Transcripts:** [custom-search-probe.txt](custom-search-probe.txt) · [close-call-probe.txt](close-call-probe.txt)
**Scripts:** [custom-search-probe.py](custom-search-probe.py) · [close-call-probe.py](close-call-probe.py)

Both probes write. Both read every value first, restore at the end, and verify
the restore. Both restores succeeded.

These close the "untested commands" list left open by
[bc75xlt-compatibility.md](../2026-08-26/bc75xlt-compatibility.md): `CSG`,
`CSP`, and `CLC` writes are now observed on this hardware.

---

## Headline results

| # | Question | Answer | Source it agrees with |
|---|---|---|---|
| 1 | `CSG` write shape | **3 fields required.** Bare mask is `ERR` | vendor spec |
| 2 | `CSP` writes | **Work.** Write, read back, match | (previously unprobed) |
| 3 | `CLC` band position 4 | **Reserved.** Forced to `0` | vendor spec |
| 4 | `CLC` mode 3 (`CC Only`) | **Accepted and retained** | **NEITHER — see below** |
| 5 | `CLC` field 5 (`hit_scan`) | **Reserved.** Written `1`, reads back empty | vendor spec |

---

## 1. `CSG` takes three fields on this model

```
CSG                    -> CSG,NG              (outside program mode)
CSG                    -> CSG,0111010101,1,0  (inside)
CSG,0111010101         -> CSG,ERR             <-- what Bearpaw sent
CSG,0111010101,1,0     -> CSG,OK
```

The BC125AT's `CSG` is a bare 10-character mask. This model's is
`CSG,##########,[DLY],[DIR]`, and the bare form is a **format error** — which
per the vendor spec aborts the whole set command. Every custom-search bank
toggle on the Device tab was a no-op on this radio.

The read is self-describing: one field means the BC125AT shape, three means
this one. A write can echo back whatever the read returned rather than
branching on a capability flag, and the two unmodeled fields (`DLY`, `DIR`)
survive untouched.

Only the exact three-field form observed here is proven. `CSG,<mask>,,` —
relying on the spec's "only `,` parameters are not changed" — was **not**
tested and should not be assumed.

## 2. `CSP` writes work

```
CSP,10                     -> CSP,10,04700000,05120000
CSP,10,04500000,04699937   -> CSP,OK
CSP,10                     -> CSP,10,04500000,04699937     MATCH
CSP,10,04700000,05120000   -> CSP,OK                       (restored)
```

Frequencies are 8-digit, units of 100 Hz — `00250000` = 25.0000 MHz. The
backend's `/10000.0` conversion is correct.

This supersedes the "never been probed on this model" note in
`export_bc75xlt_ss_file`. Note that the export still has a separate, unrelated
reason not to send `CSP`: Uniden's own tool writes constant factory ranges into
`.bc75xlt_ss` rather than reading the radio, and the export matches the tool.

The ten ranges read back exactly match `BC75XLT_CUSTOM_RANGES` in `exports.rs`,
which were recovered from real exported files — an independent confirmation of
both.

## 3. Close Call band position 4 is reserved

```
CLC                  -> CLC,1,1,1,11101,
CLC,1,1,1,11111,     -> CLC,OK
CLC                  -> CLC,1,1,1,11101,      <-- position 4 forced back to 0
```

All five ones went out; the radio kept four. Position 4 is reserved, confirming
the vendor spec's bit diagram against the BC125AT's layout:

| Pos | BC125AT | BC75XLT |
|---|---|---|
| 1 | VHF Low | VHF Low |
| 2 | AIR | AIR |
| 3 | VHF High | VHF High |
| 4 | UHF | **reserved** |
| 5 | 800 MHz | **UHF** |

Bearpaw used the BC125AT order for both, so on this radio the "UHF" switch wrote
the reserved slot and the "800 MHz" switch — a band this model cannot receive —
was the real UHF control. The owner's manual agrees on the band set: four Close
Call bands on keys 1–4, VHF Low / AIR / VHF High / UHF 406–512.

Note that a partial fix is worse than none here. Hiding only the "800 MHz" row
leaves "UHF" writing the reserved slot: a control that looks correct, reads back
plausibly, and does nothing.

## 4. Mode 3 (`CC Only`) EXISTS — both references are wrong

```
CLC,3,1,1,11101,   -> CLC,OK
CLC                -> CLC,3,1,1,11101,      <-- accepted AND retained
```

**This contradicts both available references.** The vendor spec documents
`0:OFF / 1:CC PRI / 2:CC DND` only, and the owner's manual describes three
operation modes. The radio accepted mode 3 and reported it back.

Per the captures-win rule, the hardware is authoritative: **Bearpaw keeps
offering `CC Only` on this model.** This is the second time a Close Call mode
digit has come out differently from the documentation on this project — see
#241, where two agreeing references had CC Priority and CC DND inverted.

The same shape as the BC125AT finding in
[clc-mode-probe-cc-only.txt](../2026-08-03/clc-mode-probe-cc-only.txt): mode 3
is undocumented on both families and works on both.

Caveat worth stating plainly: this observes that the radio *stores* mode 3, not
that Close Call behaves differently in it. Nothing here was verified against the
front panel or against reception.

## 5. Close Call field 5 (`hit_scan`) is reserved

```
CLC,1,1,1,11101,1   -> CLC,OK
CLC                 -> CLC,1,1,1,11101,     <-- read back empty
```

Accepted without error, then silently discarded. The BC125AT's `hit_scan`
("Lockout Hits While Scanning") has no counterpart here. Per CLAUDE.md pitfall
#9 the field goes out empty rather than `0`, and the control is hidden.

---

## Still untested on this model

`CLR` (destructive, deliberately not sent), `SSP`, `BPL` writes, and
`GLF`/`LOF`/`ULF`.
