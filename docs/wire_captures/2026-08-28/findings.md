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

## 6. Global lockouts: `GLF` / `LOF` / `ULF` all work, and Bearpaw walks them correctly

**Transcript:** [lockout-probe.txt](lockout-probe.txt) · **Script:** [lockout-probe.py](lockout-probe.py)

The Device tab audit passed Locked Channels on the strength of the vendor
command table alone — weaker evidence than the rest of it used, and two of the
three commands are writes. Now measured.

```
GLF            -> GLF,-1        (outside program mode -- answers, does not NG)
PRG            -> PRG,OK
GLF            -> GLF,-1        walk A: 0 entries
                                walk B: 0 entries   (cursor rewinds)
GLF,***        -> GLF,OK        payload-less: does NOT iterate
LOF,00250000   -> LOF,OK        walk D: ['00250000']
ULF,00250000   -> ULF,OK        walk E: []          (net zero)
```

**Bearpaw's bare-`GLF` walk is correct for this model.** The parameterized
`GLF,***` form the vendor spec documents answers a payload-less `GLF,OK` and
does not iterate — exactly as on a BC125AT. #142 has not recurred here: had the
two families wanted different forms, the Locked Channels page would have shown a
silently truncated list.

`LOF` and `ULF` both work, and the list returned to its original state.

### Multi-entry walk, confirmed

The first run found an empty list, so iteration was only ever seen across 0
entries and then 1 — enough to show the cursor *advances*, not that it walks a
list. Re-run after building a real list with `LOF`:

```
LOF x6       -> LOF,OK
GLF          -> GLF,00250000
GLF          -> GLF,00540000
GLF          -> GLF,01080000
GLF          -> GLF,01740000
GLF          -> GLF,04060000
GLF          -> GLF,05120000
GLF          -> GLF,-1
ULF x6       -> ULF,OK      walk E: 0 entries      (net zero)
```

Six entries, returned in **insertion order**, terminated with `-1`, all six
removed. Bearpaw's `read_frequency_lockouts_walk` is correct on this model for
a real list, not just a degenerate one.

Order is worth recording even though the walk does not depend on it: the list
comes back in the order entries were added, not sorted. `LOF` appends.

One caveat remains:
- **`GLF` answered `GLF,-1` outside program mode** rather than `NG`, despite
  the spec marking it program-mode only. Harmless for Bearpaw, which brackets
  the walk regardless, but it means an out-of-bracket `GLF` here reports "no
  lockouts" rather than "wrong mode".

No code change follows from this: the existing implementation is right.

## 7. Priority cannot be cleared remotely at all

**Transcript:** [priority-clear-probe.txt](priority-clear-probe.txt) · **Script:** [priority-clear-probe.py](priority-clear-probe.py)

Both mechanisms fail. This is the worst of the three outcomes the probe was
built to distinguish.

```
DCH,300                   -> ERR                       (on an ALREADY-EMPTY slot)
CIN,300                   -> CIN,300,,00000000,,,0,1,0 (unchanged, as expected)

CIN,1                     -> CIN,1,,01451300,,,1,0,1
CIN,1,,01451300,,,1,0,0   -> CIN,OK                    <-- reports success
CIN,1                     -> CIN,1,,01451300,,,1,0,1   <-- priority still 1
```

**`DCH` does not exist on this model.** Its absence from the vendor spec's
20-command table was not an oversight. The test targeted channel 300, which was
already factory-empty, so nothing was at risk either way.

**An in-place priority `1`→`0` write is refused, silently.** The write is
answered `CIN,OK` and then ignored — the same lie the reserved `CLC` field 5
tells in §5. Nothing but a read-back reveals it.

So the BC75XLT shares the BC125AT's firmware quirk (no in-place clear) without
sharing its remedy (`DCH`). Bearpaw has no way to clear a priority channel on
this model.

### What the manual says, and why it may change the fix

> You can designate one channel in each bank as a priority channel (10 total).
> The first channel in each bank is the default Priority channel.
>
> 1. Manually select the channel you want for the Priority channel.
> 2. Press Func + Pgm, then press Func + Pri. P appears to the left of the
>    selected channel number.

**The keypad procedure has no clear step.** You designate a new priority channel
and that is the whole operation — which suggests the firmware moves the flag
within the bank by itself, and that a clear is not something the model expects
anyone to do separately.

If that is right, Bearpaw's clear-then-set swap is imposing a rule this hardware
already enforces, and the clear is precisely the step that cannot work. The fix
would be to skip it and set directly.

**That is a hypothesis, not a finding.** The current factory state does not
settle it: channels 1 and 31 both carry priority, but those are the first
channels of banks 1 and 2 — the documented defaults — so they are equally
consistent with firmware enforcement and with nothing being enforced at all.

Testing it means writing priority to a second channel in an occupied bank and
seeing whether the first one drops it. That test is **not** freely reversible:
if the firmware does *not* auto-swap, the bank is left with two priority
channels and — per this very section — Bearpaw cannot clear either one. The
recovery is the scanner's own keypad.

See #479.

---

## 8. The firmware moves the priority flag by itself

**Transcript:** [priority-swap-probe.txt](priority-swap-probe.txt) · **Script:** [priority-swap-probe.py](priority-swap-probe.py)

Run in bank 9, which the owner designates a scratch bank.

```
CIN,241                       -> CIN,241,,01451300,,,0,0,1   (holds priority)
CIN,242,,01605300,,,1,0,1     -> CIN,OK
CIN,242                       -> CIN,242,,01605300,,,1,0,1   <-- took priority
CIN,241                       -> CIN,241,,01451300,,,0,0,0   <-- dropped it, unasked
```

**One priority channel per bank is enforced by the radio.** Designating a new
one clears the old one automatically, which is exactly what the owner's manual
describes from the keypad — select the channel, Func+Pgm, Func+Pri, and no
clear step anywhere.

Confirmed in both directions. Writing priority back to 241 cleared 242 again; a
separate read-only pass afterwards showed `241 priority=1, 242 priority=0`.

So §7's conclusion stands but its consequence does not. Bearpaw's
clear-then-set swap is imposing a rule this hardware already keeps, and the
clear is precisely the step that cannot work. **The fix is to skip it and SET
directly** — see #479.

### Three more things this run settled

**`CIN` writes work.** Programming channel 241 from empty took immediately. That
closes the last open item in #478.

**Writing frequency `00000000` clears a channel.** Restoring 241 to
`,00000000,,,0,1,1` read back byte-identical. This is the `DCH` substitute this
model needs, and it means a channel clear does not depend on a command the
BC75XLT lacks.

**A refused priority clear does not block the rest of the write.** Phase 2 sent
`CIN,241,,01451300,,,0,0,0` to a channel that held priority. The frequency
landed and the priority field did not move — `CIN,OK`, then
`CIN,241,,01451300,,,0,0,1`. So the silent refusal in §7 is scoped to the one
field, not the whole command, which is *unlike* the format-error case that
aborts everything.

### A probe bug worth recording

The first run's Phase 4 reported "both channels hold priority" when the radio
had already swapped correctly. It read the partner channel *before* writing the
holder — and on an auto-swapping radio the holder's write is what clears the
partner. Reading first reports a state the very next command undoes. Fixed by
reading both after the last write.

The bank was verified by an independent read-only pass, not by trusting that
line, which is the only reason the mistake surfaced.

---

## Still untested on this model

`CLR` (destructive, deliberately not sent), `SSP`, and `BPL` writes. `DCH`
does not exist here (§7) and `CIN` writes are confirmed (§8).
