# BC75XLT Compatibility Probe

**Capture date:** 2026-08-26
**Device:** BC75XLT (firmware `Version 1.02.04`)
**Connection:** CP210x USB-to-UART bridge (`0x10C4:0xEA60`) at **57600** baud, 8N1
**Raw capture:** [bc75xlt-probe.txt](bc75xlt-probe.txt) · **Probe script:** [probe.py](probe.py)
**Vendor spec:** [docs/BC75XLT_PROTOCOL.pdf](../../BC75XLT_PROTOCOL.pdf) (text: [.txt](../../BC75XLT_PROTOCOL.txt))

Read-only probe. No `CIN` writes, no settings mutation, no `CLR`.

---

## Headline result

**The wire protocol is identical to the BC125AT. Every difference is in the memory
model, the transport parameters, or fields Uniden deliberately reserved.**

`PRG`/`EPG` bracketing, `\r` framing, `ERR`/`NG` semantics, positional `CIN`
field order, and the 10-character `SCG` mask are unchanged. The BC75XLT's `CIN`
keeps the BC125AT's *field positions* and marks the unused ones `[RSV]`, so a
position-based parser does not shift.

Three sources agree on every point below: this capture, the vendor spec, and the
independent [Uniden::BC75XLT CPAN module](https://metacpan.org/dist/Uniden-BC75XLT/view/BC75XLT.pod).

---

## Differences from the BC125AT

| # | Difference | Wire evidence | Vendor spec | Impact |
|---|---|---|---|---|
| 1 | **57600 baud** (BC125AT: 115200) | Only rate yielding `MDL,BC75XLT` | "Buadrate 57600bps" [sic] | Blocker |
| 2 | **CP210x bridge**, not Uniden direct-USB | `ioreg`: `0x10C4:0xEA60` | — | Blocker |
| 3 | **300 channels**, 10 banks × 30 | `CIN,300` OK; `CIN,301` → `ERR` | `[INDEX] : Channel Index(1-300)` | Structural |
| 4 | **No alpha tags** — field is `[RSV]` | `CIN,1,,01451300,,,1,0,1` | `[RSV]` in field 2 | Cosmetic |
| 5 | **No per-channel modulation** — global `BPL` | `CIN` fields 4-5 empty | `BPL Get/Set Band Plan` | Product question |
| 6 | **`[DLY]` is boolean** `0/1` (BC125AT: `-10..5`) | `1` on live, `0` on empty | `[DLY] : Delay Time (0:OFF / 1:ON)` | **Write hazard** |
| 7 | **No `BLT`** (backlight) | `BLT` → `ERR` | Absent from command table | Minor |

---

## Vendor `CIN` spec (verbatim)

```
<COMMAND CIN>
Get/Set Channel Info
Controller -> Radio
  (1) CIN,[INDEX][\r]
  (2) CIN,[INDEX],[RSV],[FRQ],[RSV],[RSV],[DLY],[LOUT],[PRI][\r]
Radio -> Controller
  (1) CIN,[INDEX],[RSV],[FRQ],[RSV],[RSV],[DLY],[LOUT],[PRI][\r]
  (2) CIN,OK[\r]

     [INDEX] : Channel Index(1-300)
     [FRQ]   : Channel Frequency ex) 290000
     [DLY]   : Delay Time (0:OFF / 1:ON)
     [LOUT]  : Lockout    (0:Unlocked / 1:Lockout)
     [PRI]   : Priority   (0:OFF / 1:ON)
```

Compare the BC125AT's 8 data fields — `alpha_tag`, `freq`, `mod`, `tone`,
`delay`, `lockout`, `priority`. Same count, same positions; fields 2, 4, and 5
are reserved rather than removed.

---

## Bank layout: 30 channels, not 50

The band change is visible in the factory presets:

```
CIN,30  -> CIN,30,,01473750,,,1,0,0     147.3750 MHz (2m amateur)
CIN,31  -> CIN,31,,04422000,,,1,0,1     442.2000 MHz (70cm amateur)
```

A clean discontinuity at the 30/31 boundary. 300 channels / 10 banks = 30 per
bank. `SCG` remains 10 characters (`SCG,0000000111`), so only the divisor in
`protocol::index_to_bank` (currently `/ 50`) is wrong — not the mask width.

The vendor spec adds a constraint we would otherwise hit at runtime:
*"It can not set all channel storage banks to `1`"* — an all-disabled mask is
refused.

---

## Full probe transcript

```
MDL          -> MDL,BC75XLT
VER          -> VER,Version 1.02.04
STS          -> STS,1, 464.5000      ,,1,0
GLG          -> GLG,464.5000,NFM,,,,,,1,0,,,
PWR          -> PWR,228,04645000
VOL          -> VOL,0
SQL          -> SQL,2

PRG          -> PRG,OK
CIN,1        -> CIN,1,,01451300,,,1,0,1
CIN,2        -> CIN,2,,01469550,,,1,0,0
CIN,30       -> CIN,30,,01473750,,,1,0,0
CIN,31       -> CIN,31,,04422000,,,1,0,1
CIN,299      -> CIN,299,,00000000,,,0,1,0
CIN,300      -> CIN,300,,00000000,,,0,1,0
CIN,301      -> CIN,ERR
CIN,500      -> CIN,ERR
SCG          -> SCG,0000000111
BLT          -> ERR
PRI          -> PRI,0
EPG          -> EPG,OK
```

Note `GLG` reports `NFM` live while `CIN` carries no modulation — confirming
modulation is a band-plan property, not channel memory.

---

## Caveats

- **One unit, one firmware** (1.02.04). The vendor spec corroborates the
  structural claims, but firmware-observable behavior (empty-slot `DLY=0`,
  `BLT` → `ERR`) is confirmed on this device only.
- **Two serial nodes, one scanner.** macOS bound both `AppleUSBSLCOM` and
  `com.silabs.cp210x` to the same CP2104 (serial `020D43D8`), producing
  `/dev/cu.SLAB_USBtoUART` *and* `/dev/cu.usbserial-020D43D8`. Port scoring must
  not treat these as two candidate scanners.
- **Untested commands:** `BPL`, `CLC`, `SSP`, `CSG`, `CSP`, `KBP`, `CLR`, and
  all `CIN` writes. `CLR` is destructive and was deliberately not sent.

---

## Settings probe (added same day)

Which global-settings commands the BC75XLT actually answers. Read-only — every
command below is a GET with no value argument.

```
--- outside program mode ---
VOL   -> VOL,0
SQL   -> SQL,2
BLT   -> ERR
BSV   -> ERR
CNT   -> ERR
KBP   -> KBP,NG
WXS   -> ERR

--- inside program mode ---
BLT   -> ERR
BSV   -> ERR
CNT   -> ERR
KBP   -> KBP,,0
WXS   -> ERR
PRI   -> PRI,0
BPL   -> BPL,0
SCO   -> SCO,1,,0
CLC   -> CLC,2,1,1,11101,
```

| Command | BC75XLT | Note |
|---|---|---|
| `VOL` `SQL` | works, any mode | |
| `PRI` | works, program mode | |
| `KBP` | **program mode only** | `KBP,NG` outside — "invalid at this time" per the vendor spec. The BC125AT accepts it in either mode. |
| `BLT` | **absent** | Not in the command table. The scanner still HAS a backlight — the owner's manual documents a 15-second button — but no settable mode. |
| `BSV` `CNT` `WXS` | **absent** | Not in the command table; `ERR` in both modes. `CNT` matches the manual, which has no contrast setting. |
| `BPL` | works | Band plan, `BPL,0`. This is where modulation lives on this model — confirms why `CIN` carries none. |
| `SCO` `CLC` | works | Search/Close Call settings, untested for writes. |

`has_backlight_control` is named for what Bearpaw can control, not what the
hardware has: the BC75XLT has a backlight, just no `BLT` command.

**Still untested:** all writes (`BLT,<v>`-style SET forms), `CLR`, `CSG`, `CSP`,
`SSP`, and `GLF`/`LOF`/`ULF`.
