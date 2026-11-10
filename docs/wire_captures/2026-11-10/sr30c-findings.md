# SR30C wire probes (#845, #846)

**Hardware:** SR30C (`MDL,SR30C`, firmware `Version 1.01.04`), CP2104 bridge
`0x10C4:0xEA60` serial `02A72C10`, `/dev/cu.usbserial-02A72C10`, 57600 8N1 on macOS.

Three sessions:

| Session | Date | Script | Transcript | Writes? |
|---|---|---|---|---|
| Read-only probe | 2026-11-09 | [`sr30c-probe.py`](sr30c-probe.py), [`sr30c-banks.py`](sr30c-banks.py) | [`sr30c-probe.txt`](sr30c-probe.txt), [`sr30c-banks.txt`](sr30c-banks.txt) | No: GET forms only |
| `CIN` write probe | 2026-11-10 | [`sr30c-cin-write-probe.py`](sr30c-cin-write-probe.py) | [`sr30c-cin-write-probe.txt`](sr30c-cin-write-probe.txt) | Bank 9 (401–408), restored and verified |
| Full-memory copy from a BC125AT | 2026-11-10 | [`sr30c-write-image.py`](sr30c-write-image.py) | [`sr30c-copy-run.txt`](sr30c-copy-run.txt) | All 500 slots, each read back |

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

## Values for the descriptor (#849)

| Field | Value | Evidence |
|---|---|---|
| `has_alpha_tags` | false | §2 |
| `has_per_channel_modulation` | false | §2 |
| `has_tone_squelch` | false | §2 |
| `valid_delays` | `0, 1` | §2 |
| `cleared_delay` | 0 | empty shape `,00000000,,,0,1,0`, §1 and §3 |
| `has_priority_clear` | false | §2, §3 |
| `coverage_bands` | **open**: 239.0–347.5 MHz is outside | §3 |

Still unprobed from #846: the `CLC`, `SCO`, `KBP` write paths, and a round-trip of `SCG`, `BPL`, `PRI`, `VOL` and `SQL`.
