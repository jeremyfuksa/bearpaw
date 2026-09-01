# BC75XLT: SSP and BPL writes — 2026-09-01

Closes both items #478 still listed as unprobed. Hardware: BC75XLT, firmware
`Version 1.02.04`, over its CP2104 bridge at `/dev/cu.usbserial-020D43D8`,
57600 8N1.

Scripts and raw transcripts in this directory:

| File | What it settles |
|---|---|
| [`ssp-bpl-probe.py`](ssp-bpl-probe.py) / [`.txt`](ssp-bpl-probe.txt) | `SSP` read shape and index range; `BPL` writes |
| [`ssp-write-probe.py`](ssp-write-probe.py) / [`.txt`](ssp-write-probe.txt) | `SSP` writes, per-field |

Both follow the method established on 2026-08-28: refuse any model but a
BC75XLT, read every value before touching it, restore at the end, and verify
the restore. `ssp-bpl-probe.py` carries a `--fake` pty self-test that exercises
every branch without hardware; the model-refusal path was demonstrated when an
early run mis-parsed `MDL` and the script aborted rather than writing.

---

## 1. `SSP` — per-service delay and direction

**Program-mode only.** Outside `PRG` it answers `NG`:

```
SSP            -> 'SSP,NG'      (outside PRG)
```

**Requires an index. Valid range is 1–10.** Bare `SSP` and both out-of-range
neighbours answer `ERR`, which distinguishes "wrong mode" (`NG`) from "bad
argument" (`ERR`) on this command:

```
SSP            -> 'SSP,ERR'     (inside PRG, no index)
SSP,0          -> 'SSP,ERR'
SSP,1          -> 'SSP,1,1,0'
...
SSP,10         -> 'SSP,10,1,0'
SSP,11         -> 'SSP,ERR'
```

**Shape:** `SSP,<index>,<delay>,<direction>`. All ten services read `1,0` on
this unit as shipped.

**Both fields are writable, and the write is per-index.**

```
SSP,1,0,0      -> 'SSP,OK'      then SSP,1 -> 'SSP,1,0,0'   (delay persisted)
SSP,1,0,1      -> 'SSP,OK'      then SSP,1 -> 'SSP,1,0,1'   (direction persisted)
```

Writing index 1 left the other nine untouched — all nine re-read identical to
their pre-write values. Restored to `SSP,1,1,0` and verified byte-identical.

**Not established:** the semantics of the two values. `delay` is plausibly the
same boolean the rest of this model uses (`valid_delays` is `[0,1]`) and
`direction` plausibly up/down, but this probe only demonstrated that the fields
round-trip. Confirming meaning needs the radio's own display or a search run,
not a wire probe.

## 2. `BPL` writes

**Program-mode only**, same as the read:

```
BPL            -> 'BPL,NG'      (outside PRG)
BPL            -> 'BPL,0'       (inside PRG — USA)
```

**Writes are accepted and persist.** Staged deliberately: the current value was
written back first as a no-op that still exercises the write path, and only
after that was accepted was a real change attempted.

```
BPL,0          -> 'BPL,OK'      (no-op write accepted)
BPL,1          -> 'BPL,OK'      then BPL -> 'BPL,1'   (persisted)
BPL,0          -> 'BPL,OK'      then BPL -> 'BPL,0'   (restored)
```

**Stored channel memory is not disturbed by a band-plan round trip.** Six
channels spread across the memory map were read before and after and were
byte-identical:

```
CIN,1    -> 'CIN,1,,01451300,,,1,0,1'
CIN,31   -> 'CIN,31,,04422000,,,1,0,1'
CIN,61   -> 'CIN,61,,01470000,,,1,0,1'
CIN,121  -> 'CIN,121,,04646375,,,1,1,1'
CIN,241  -> 'CIN,241,,00000000,,,0,1,1'
CIN,300  -> 'CIN,300,,00000000,,,0,1,0'
```

**The spec warning is NOT disproved by this.** The vendor note — *"Band Plan
setting affects frequency step. Issue this command before frequency
programming"* — is about the step applied when a frequency is PROGRAMMED. This
probe deliberately never programmed a frequency while the plan was changed, so
what it establishes is narrower than it may look:

- Writing `BPL` works, persists, and is restorable. ✅
- Changing the plan and changing it back does not disturb channels already
  stored. ✅
- What a `CIN` write does under band plan `1` — whether the step changes and a
  frequency lands somewhere other than requested — is **still unprobed**. Any
  future feature that exposes the band plan has to answer that before it writes
  a channel.

## Implications for Bearpaw

- `SSP` is implementable: bracketed in `PRG`, indexed 1–10, two writable
  fields, no cross-index side effects. It remains the only service-search
  control on this model (there is no `SSG`, which is why the subtab is hidden
  as of #469).
- `BPL` writes are safe to expose with respect to existing memory, but a
  band-plan control must not sit next to channel programming until the
  interaction in the note above is probed. Order matters, per the vendor spec.
- Both commands answer `NG` outside program mode and `ERR` for a bad argument.
  That split is useful: it distinguishes "you are in the wrong mode" from "your
  argument is wrong", which the `CIN` path cannot do.
