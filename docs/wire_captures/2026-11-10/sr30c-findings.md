# SR30C wire probes (#845, #846)

**Hardware:** SR30C (`MDL,SR30C`, firmware `Version 1.01.04`), CP2104 bridge
`0x10C4:0xEA60` serial `02A72C10`, `/dev/cu.usbserial-02A72C10`, 57600 8N1 on macOS.

Five sessions:

| Session | Date | Script | Transcript | Writes? |
|---|---|---|---|---|
| Read-only probe | 2026-11-09 | [`sr30c-probe.py`](sr30c-probe.py), [`sr30c-banks.py`](sr30c-banks.py) | [`sr30c-probe.txt`](sr30c-probe.txt), [`sr30c-banks.txt`](sr30c-banks.txt) | No: GET forms only |
| `CIN` write probe | 2026-11-10 | [`sr30c-cin-write-probe.py`](sr30c-cin-write-probe.py) | [`sr30c-cin-write-probe.txt`](sr30c-cin-write-probe.txt) | Bank 9 (401–408), restored and verified |
| Full-memory copy from a BC125AT | 2026-11-10 | [`sr30c-write-image.py`](sr30c-write-image.py) | [`sr30c-copy-run.txt`](sr30c-copy-run.txt) | All 500 slots, each read back |
| Settings write probe | 2026-11-10 | [`sr30c-settings-probe.py`](sr30c-settings-probe.py) | [`sr30c-settings-probe.txt`](sr30c-settings-probe.txt) | `VOL` `SQL` `SCG` `BPL` `PRI` `KBP` `SCO` `CLC` `CSG`, each restored and verified (`ALL RESTORED`) |
| Backlight (`BLT`) probe | 2026-11-10 | [`sr30c-blt-probe.py`](sr30c-blt-probe.py) | [`sr30c-blt-probe.txt`](sr30c-blt-probe.txt) | `BLT` only, left on High (`RESTORED`) |

The read-only probe ran a day earlier. It is filed here with the write
sessions so all the SR30C evidence sits in one folder.

---

## 1. Read-only probe: a BC75XLT with 500 channels

| | BC75XLT | SR30C |
|---|---|---|
| Channels | 300 (`CIN,301` → `ERR`) | **500** (`CIN,500` OK, `CIN,501` → `CIN,ERR`) |
| Banks | 10 × 30 | **10 × 50**: the empty-slot priority flag sits on exactly 1, 51, 101 … 451 |
| Baud / bridge | 57600, CP2104 | 57600, CP2104 |
| `BLT` | `ERR` | **`BLT,,,10`**, a shape neither family uses (#847) |
| `BSV`, `CNT`, `WXS`, `SSG` | `ERR` | `ERR` |
| `KBP` | `NG` outside PRG, `KBP,,0` inside | same |
| Empty slot | `CIN,300,,00000000,,,0,1,0` | `CIN,500,,00000000,,,0,1,0` (same shape) |
| `GLG` field 11 (channel) | empty | empty (`GLG,488.9375,NFM,,,,,,0,1,,,`) |

The first `MDL` after opening the port came back as `\x00MDL,SR30C`, with a
leading NUL: the CP210x stale-byte behaviour in CLAUDE.md pitfall #11.

## 2. `CIN` writes: unsupported fields are dropped, and the reply is still `OK`

Every test wrote a frequency alongside the field under test. Reading the
frequency back distinguishes three outcomes: the field was kept, the field was
dropped, or the whole write was aborted.

| Field | Sent | Reply | Read back | Verdict |
|---|---|---|---|---|
| frequency only | `,01462500,,,0,0,0` | `CIN,OK` | identical | kept |
| name | `BEARPAW TEST` | `CIN,OK` | `''` | **dropped**: `has_alpha_tags = false` |
| modulation | `FM` | `CIN,OK` | `''` | **dropped**: `has_per_channel_modulation = false` |
| tone | `64` (67.0 Hz) | `CIN,OK` | `''` | **dropped**: `has_tone_squelch = false` |
| delay | `1` | `CIN,OK` | `1` | kept |
| delay | `2` | `CIN,OK` | `1` | **not applied** |
| delay | `-5` | `CIN,OK` | `1` | **not applied** |
| lockout | `1` | `CIN,OK` | `1` | kept |
| priority | `1` on 408 | `CIN,OK` | `1`; **401 dropped its flag** | kept; the firmware moves the flag within a bank, as on the BC75XLT |

**Not aborted.** CLAUDE.md rule 3 says a format error aborts the whole `CIN`
write, which is why Bearpaw sends reserved fields empty. On this radio a name,
modulation, tone or out-of-range delay does **not** abort the write: the
frequency, lockout and priority in the same command land, and the bad field is
dropped. Bearpaw should still send reserved fields empty. The finding is that
`CIN,OK` does not mean every field was stored, so only a read-back proves a
write.

**Delay is ambiguous.** Channel 406 already held delay `1` when `2` and `-5`
were sent, so these captures cannot tell "field left unchanged" from "clamped
to 1". Either way `valid_delays` is `0, 1`.

**Restore.** All eight slots were written back to their before-state and read
back identical (`RESTORE OK`). Writing an empty slot with priority `1` (401,
written last) took the flag back from 408.

## 3. Full-memory copy from a BC125AT

All 500 slots were written from a BC125AT's channel memory, slot for slot
(frequency, lockout and priority; delay 0 kept as 0, any other delay sent as 1).
The SR30C was backed up first. Every write replied `CIN,OK`. Read-back found:

**Out-of-coverage frequencies are refused without an error.** Nine channels
between 239.0 and 347.5 MHz (233–241) replied `CIN,OK`, but the slot stayed in
the empty shape `,00000000,,,0,1,0`. **The whole write was refused**, not
clamped. This capture does not establish where coverage starts and stops.
`coverage_bands` for #849 still needs a cited source (owner's manual or vendor
spec), checked against this result.

**A bank always keeps one priority flag.** In six banks (51, 101, 151, 201,
251, 351) the first slot, which held the empty-slot priority flag, was
programmed with priority `0` and read back `1`. A write cannot clear the flag:
only another channel in the bank taking priority moves it. That matches the
BC75XLT (`docs/wire_captures/2026-08-28/`, priority-swap probe). An SR30C bank
cannot be left with no priority channel, so `has_priority_clear = false`.

The other 485 slots matched exactly, including every slot written empty.

## 4. Settings writes

Each setting was read, written, read back, then restored by sending the
original read reply verbatim. Write shapes are the ones Bearpaw sends today,
plus an echo of the radio's own reply. `VOL` and `SQL` ran outside program
mode; the rest inside.

| Command | Write | Reply | Read back | Verdict |
|---|---|---|---|---|
| `VOL` | `VOL,5` | `OK` | `VOL,5` | stored |
| `SQL` | `SQL,4` | `OK` | `SQL,4` | stored |
| `SCG` | `SCG,0000000000` | `OK` | same | stored |
| `SCG` | `SCG,1111111111` (all banks disabled) | `OK` | **same** | **stored** — see below |
| `BPL` | `BPL,1` | `OK` | `BPL,1` | stored |
| `PRI` | `PRI,1`, `PRI,2` | `OK` | same | stored |
| `KBP` | `KBP,,1` (lock on) | `OK` | `KBP,,1` | stored |
| `KBP` | `KBP,1,0` (value in the beep field) | `OK` | `KBP,,0` | beep field reserved, as on the BC75XLT |
| `SCO` | `SCO,1,,0` (echo of its reply) | `OK` | same | stored |
| `SCO` | `SCO,2,1` (**Bearpaw's 2-field form**) | **`ERR`** | unchanged | **refused** |
| `SCO` | `SCO,0,,0`, `SCO,1,,1` | `OK` | same | stored |
| `SCO` | `SCO,2,,0` | `OK` | `SCO,1,,0` | delay `2` not applied |
| `CLC` | `CLC,2,0,0,11111,` | `OK` | `…,11101,` | band position 4 reserved, as on the BC75XLT |
| `CLC` | `CLC,3,0,0,11101,` | `OK` | same | mode 3 stored, as on the BC75XLT |
| `CLC` | `CLC,2,0,0,11101,1` | `OK` | `…,11101,` | field 5 (`hit_scan`) reserved, as on the BC75XLT |
| `CSG` | echo, then `CSG,1000000000,1,0` | `OK` | same | stored; 3-field shape, as on the BC75XLT |

**`SCO` is settable, in a different shape than Bearpaw sends.** The SR30C's
`SCO` has three fields, `SCO,<delay>,<code search, reserved>,<direction>`, and
accepts writes in that shape: delay `0`/`1` and direction `0`/`1` both
round-trip. Bearpaw writes `SCO,<delay>,<code search>`, which this radio
answers `ERR`.

*Corrected after this section was first written:* the third field was
labelled "code search" here. It is the search **direction** (`0` Up, `1`
Down), the shape the BC75XLT exporter already reads, and the radio's own
`.sr30c_ss` confirms it: `SCO,1,,0` exports as `GeneralSearch 2 (blank) Up`
(§6). So `SCO,1,,1` above set direction Down, not code search.
This differs from the BC75XLT, which refused every `SCO` write including an
echo of its own reply (`has_search_options = false` there). As with `CSG`
(`docs/wire_captures/2026-08-28/findings.md` §1), the read is self-describing,
so a write can follow the field count of the read rather than branch on model.
Delay `2` behaves as in `CIN` (§2): `OK`, not applied, and ambiguous between
ignored and clamped because the slot already held `1`.

**An all-disabled `SCG` mask is accepted.** CLAUDE.md pitfall #7 says the
scanner refuses one. This radio stored `1111111111` and returned it on read.
Bearpaw rejects that mask before the wire on every model, which is still
right: a scanner with every bank disabled has nothing to scan. Only the stated
reason ("the scanner refuses it") does not hold here.

## 5. Backlight: `BLT,,,<level>`

`BLT` answers in and out of program mode with the level in its third field.
Uniden's software offers two levels and wrote each to the radio:

| Software | `BLT` read |
|---|---|
| High | `BLT,,,10` |
| Low | `BLT,,,5` |

Bearpaw can set it ([`sr30c-blt-probe.txt`](sr30c-blt-probe.txt)): `BLT,,,10`
and `BLT,,,5` each reply `BLT,OK` and read back, outside program mode and
inside. `BLT,,,7`, which the software never offers, is also accepted and
stored; what the display does with it is unverified. The radio was left on
High. This decodes the `BLT,,,10` the read-only probe found (§1, #847).

## 6. The settings file (`.sr30c_ss`, #848)

Uniden's software read this radio into a `.sr30c_ss` within minutes of a
Bearpaw read; every `C-Freq` row matches it, and the settings sections match
the wire values above. The layout and its two differences from the BC75XLT
are in `docs/SS_FILE_FORMAT.md`, "SR30C". The file is committed as
`crates/bearpaw-api/fixtures/sample.sr30c_ss`.

Two more single-variable tests came out of it:
- Banks 3 and 9 set off in the software and written gave `SCG,0010000010`,
  and the saved file changed in one line, `Conventional 3` `Off` → `On`. That
  is the evidence for #881 (`On` = locked out, on every model).
- `SCG` answers `NG` outside program mode on this radio.

## Values for the descriptor (#849)

| Field | Value | Evidence |
|---|---|---|
| `has_alpha_tags` | false | §2 |
| `has_per_channel_modulation` | false | §2 |
| `has_tone_squelch` | false | §2 |
| `valid_delays` | `0, 1` | §2 |
| `cleared_delay` | 0 | empty shape `,00000000,,,0,1,0`, §1 and §3 |
| `has_priority_clear` | false | §2, §3 |
| `has_key_beep` | false | §4 |
| `key_beep_needs_program_mode` | true | `KBP,NG` outside PRG (§1); lock round-trips inside (§4) |
| `has_search_options` | true **only once the write follows the 3-field read**; false until then | §4 |
| `close_call_bands` | position 4 reserved, as on the BC75XLT. The other four labels are **not** verified: take them from the owner's manual, not by copying the BC75XLT list (CLAUDE.md capabilities rule 5) | §4 |
| `has_close_call_hit_scan` | false | §4 |
| `coverage_bands` | **open**: 239.0–347.5 MHz is outside | §3 |
