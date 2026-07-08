# Phase 1 Audit Reconciliation

**Capture date:** 2026-05-21
**Device:** BC125AT (firmware Version 1.06.06)
**Connection:** Direct USB via `rusb` (UsbTransport) — kernel CDC binding never engaged on macOS
**Raw capture:** [raw.txt](raw.txt)

This note reconciles each finding in [SCANNER_PROTOCOL_REFERENCE.md §13](../../SCANNER_PROTOCOL_REFERENCE.md#13-known-correctness-gaps-in-current-bearpaw-code) against actual wire traffic from our device. Verdicts: **CONFIRMED**, **FIRMWARE-VARIANT** (real but different shape than the research doc), or **FALSE-ALARM**.

---

## Headline result

**The research is correct on protocol shape and field ordering. Bearpaw's parsers are written to a different (non-existent) protocol shape and produce mostly-zero `LiveState` data.** The fix is exactly what the audit plan describes.

The one notable nuance: our firmware (1.06.06, newer than the 1.04.02 in the research doc) emits **5 leading digits** in the `STS` `DSP_FORM`/status block (`STS,011000,...`) where the research doc describes 4 (`STS,0110,...`). Field count downstream also differs. Parsers must be position-based with bounds checks; absolute field positions cannot be hardcoded across firmware revisions.

---

## Finding-by-finding

### 1. `STS` parser is written for key-value pairs but the wire is a positional LCD dump — **CONFIRMED**

Sample wire response, scanner holding on GMRS CH 03 (462.6125 MHz, channel 75):

```
STS,011000,              ,,GMRS CH 03      ,,CH075  462.6125,,            ,,                ,,123          ,,1,0,0,0,,,5,,3
```

This is a single-line, comma-separated LCD dump. There is no `FRQ,xxx` or `MOD,xxx` line. The current `parse_sts_response` in [crates/bearpaw-api/src/protocol/mod.rs](../../../crates/bearpaw-api/src/protocol/mod.rs) splits on `\r`/`\n` and looks for keys like `FRQ`, `MOD`, `SQL`, `RSSI`, `CH`, `VOL`, `BAT` — none of which exist on the wire. The function returns a `HashMap` containing only `{"STS": "011000"}` (the first comma-split pair on the only line) plus possibly noise.

Verified live: `GET /api/v1/status` returns `{"frequency":0.0,"modulation":"FM","rssi":0,...}` — zero defaults, because the parser found none of the keys it was looking for.

**`STS` field layout on this firmware (1.06.06):**

| Pos | Value (sample) | Meaning |
|---|---|---|
| 0 | `STS` | command echo |
| 1 | `011000` | DSP_FORM (6 digits, not 4 as in research doc) |
| 2 | `              ` (16 spaces) | Line 1 character row |
| 3 | (empty) | Line 1 mode row (collapses when all-normal) |
| 4 | `GMRS CH 03      ` | Line 2 |
| 5 | (empty) | Line 2 modes |
| 6 | `CH075  462.6125` | Line 3 |
| 7 | (empty) | Line 3 modes |
| 8 | `            ` | Line 4 |
| 9 | (empty) | Line 4 modes |
| 10 | `                ` | Line 5 (this firmware has 5 lines?) |
| 11 | (empty) | Line 5 modes |
| 12 | `123          ` | Line 6 / status text? |
| 13 | (empty) | mode row |
| 14 | `1` | SQL (1 = open) |
| 15 | `0` | MUT |
| 16 | `0` | reserved/WAT |
| 17 | `0` | LED_CC or similar |
| 18 | (empty) | reserved |
| 19 | (empty) | reserved |
| 20 | `5` | SIG_LVL (0–5 bars) |
| 21 | (empty) | reserved |
| 22 | `3` | BK_DIMMER (3 = High) |

**This is firmware 1.06.06 emitting more lines than the research doc's 4-line spec for 1.04.02.** Either Uniden extended the LCD dump format or the original spec was incomplete. Either way: position-based parsing with the `SIG_LVL` and `SQL` fields located by counting from the **end** of the response (not the start) is more robust.

### 2. Squelch polarity (`SQL=0` vs `SQL=1`) — **CONFIRMED**

Samples 1 and 2 (held on a transmitted channel):
```
STS,...,1,0,0,0,...   (SQL field = 1)
GLG,04626125,NFM,,0,,,GMRS CH 03,1,0,,75,   (SQL field = 1)
```

Samples 3, 4, 5 (signal ended):
```
STS,...,0,1,0,0,...   (SQL field = 0)
GLG,...,GMRS CH 03,0,1,,75,   (SQL field = 0)
```

**`SQL=1` means squelch open (signal present).** Bearpaw's current parser at [protocol/mod.rs:39](../../../crates/bearpaw-api/src/protocol/mod.rs#L39) inverts this: `SQL == "0"` → `squelch_open = true`. **Inverted from reality.**

Worth noting: when `SQL` transitions 1→0, the MUT field transitions 0→1. The scanner mutes audio output when squelch closes. So "signal present" → `SQL=1, MUT=0`; "no signal, muted" → `SQL=0, MUT=1`.

### 3. `MODE` is not a wire field — **CONFIRMED**

Neither `STS` nor `GLG` carries a mode enum. The poll loop's `commanded_mode` state in [poll.rs:208](../../../crates/bearpaw-api/src/api/poll.rs#L208) is the correct source — mode is tracked from user commands, not read from the device. The `map["MODE"]` lookup in `livestate_from_sts` is dead code.

### 4. `CIN` field order — **FIRMWARE-VARIANT**

Sample CIN responses:
```
CIN,1,Ararat UHF,01451300,AUTO,0,2,0,0
CIN,2,K0ECS - JoCo,01454700,AUTO,0,2,0,0
CIN,3,AUTO,00000000,AUTO,0,2,1,0
CIN,4,Trimble 640,01466400,AUTO,0,2,1,0
CIN,5,AUTO,01454300,AUTO,0,0,1,0
```

8 fields after the `CIN` keyword. Layout matches the research doc:

| Pos | Value | Field |
|---|---|---|
| 0 | `CIN` | command echo |
| 1 | `1` | index |
| 2 | `Ararat UHF` | alpha tag |
| 3 | `01451300` | frequency × 10000 (145.1300 MHz) |
| 4 | `AUTO` | modulation |
| 5 | `0` | CTCSS/DCS code |
| 6 | `2` | delay (seconds) |
| 7 | `0` | lockout |
| 8 | `0` | priority |

**There is no 9th field.** The research is right: **no `bank` field in `CIN`.** Bearpaw's current parser fabricates one with heuristic guesswork, then defaults to 0. Real bank membership comes from `SCG`.

The current Bearpaw `ChannelData` schema has `bank` and `tone_squelch` swapped in interpretation: position 5 (the code) is being parsed as if it were Hz, and position 8 (priority) is being parsed as bank. Samples 3 and 4 have `lockout=1, priority=0` programmed, which Bearpaw's old parser would currently report as `bank=0` (the trailing 0 byte) and miss the lockout entirely.

**Also confirmed:** alpha tag is NOT space-padded on the wire (research doc says it should be 16 chars space-padded). Sample 1 returns `Ararat UHF` (10 chars, no padding). This is a firmware-variant difference — newer firmware appears to trim. **Read-side parsers should NOT depend on fixed alpha-tag width.** Write-side still needs padding-to-clear semantics per the spec, but we can verify that separately.

### 5. CTCSS as code, not Hz — **CONFIRMED**

All five captured channels have `0` in position 5. That's "no tone" — consistent with both the code interpretation (0 = none) and a Hz interpretation that happens to also be 0. Need a channel with a programmed tone to fully confirm, but the position is right and the research doc + reference implementations agree this is a code, not Hz.

### 6. Unconditional DTR assert in `SerialTransport::open` — **N/A on this connection**

We're using `UsbTransport`, not `SerialTransport`. Findings 6 (DTR) and 7 (STS truncation read) apply only to the serial path, which is unreachable on this Mac because no `/dev/cu.usbmodem*` node exists. Still valid concerns for Linux and Windows users; remain in scope for Phase 5.

### 7. No `MDL`-based port autodetect — **CONFIRMED**, partially addressed today

Today's fix to `resolve_serial_port` makes the USB pseudo-target path (`usb:1965:0017`) fire when `usb_vid`/`usb_pid` are configured even if no TTY exists. This is the macOS-specific case. The general "plug it in with no config" UX still requires VID-filter enumeration in the `UsbTransport::open` path, which already exists (it iterates all USB devices and matches VID/PID — see [transport_usb.rs:42-60](../../../crates/bearpaw-api/src/transport_usb.rs#L42-L60)). Plug-and-play is one config-file removal away.

### 8. `transport_usb.rs` does not run on `kernel_driver_active` errors — **FALSE ALARM**

The connection worked on the first try. `handle.set_active_configuration(1)` succeeded; `claim_interface(1)` succeeded. No kernel CDC driver was attached to the data interface (the IOKit picture confirms no `IOUSBHostInterface` children appeared — the kernel never tried to bind). The `detach_kernel_driver` calls at [transport_usb.rs:51-53](../../../crates/bearpaw-api/src/transport_usb.rs#L51-L53) are correctly defensive.

---

## Additional findings not in the original audit

### A. `STS` is single-line, not multi-line

`send_and_read_multiline` is over-engineered for `STS` — the response is one line ending in `\r`. The 50ms idle-timeout multiline reader works correctly but adds 50ms of latency to every poll. **`send` (read-until-`\r`) is sufficient** for `STS`, `GLG`, `PWR`, `VOL`, `SQL`, and `CIN`. The only commands that may return multiple lines on this firmware are `MEM`/`DUMP`-class commands we don't use.

Recommendation for Phase 2: switch the `STS` poll to single-line `send`. Saves ~50ms per cycle.

### B. The poll loop never sends `GLG`

The current poll loop sends only `STS`. **Frequency, modulation, alpha tag, and channel index live in `GLG`, not `STS`.** This is why `LiveState.frequency = 0.0` even when the scanner is actively holding on a channel. The Phase 3 reshape (build LiveState from GLG, not STS) is the load-bearing fix that will make the UI display real data.

### C. `GLG` trailing channel number is firmware-dependent and **present** on 1.06.06

Sample: `GLG,04626125,NFM,,0,,,GMRS CH 03,1,0,,75,`

11 commas, 12 fields. Field 10 (zero-indexed) = `75` = current channel number. The research doc said this was firmware-dependent (pa3ang found it on UBC125XLT). Confirmed present on BC125AT firmware 1.06.06.

Idle GLG (between channels) would need a separate capture — none of our samples caught the scanner mid-cycle because it was held on an active GMRS broadcast.

### D. `SCG` bank mask shape

`SCG,0001111111` — 10 digits, one per bank. Per the research doc's "0=enabled, 1=disabled" convention: only bank 1 is enabled (channels 1–50). Sample channels 1–5 match — bank 1 channels. Confirms the mask interpretation.

### E. `SSG` service-search mask

`SSG,1101111001` — 10 service banks, with banks 3, 5, 6, 7, 8, and 10 disabled (`1`), banks 1, 2, 4, 9 enabled (`0`). Verifies same convention.

### F. Volume and squelch ranges

`VOL,0` and `SQL,2` — both within the documented 0–15 range. Volume at 0 explains why audio is muted on the device right now (scanner is connected to USB but volume turned all the way down).

### G. Firmware version

`VER,Version 1.06.06` — significantly newer than the 1.04.02 the research doc cites. The audit's "STS field count varies between firmware revisions" warning is real and applicable to us. Our parsers must defend against this.

---

## What this changes about the audit plan

**Nothing structurally.** The plan in [docs/PROTOCOL_AUDIT_PLAN.md](../../PROTOCOL_AUDIT_PLAN.md) is still right. Phase 1 is now complete; Phase 2 (parser rewrite) starts next.

**Two refinements to bake into Phase 2:**

1. **Position-counting in `STS` must work from the end of the response, not the start.** Find the last numeric tail (`SQL,MUT,WAT,LED_CC,RSV,RSV,SIG_LVL,RSV,BK_DIMMER`) and anchor the LCD lines from the front, leaving the middle variable. Firmware variance is in the LCD dump section (line count), not the status tail.

2. **`GLG` is the canonical live-state source.** Add `GLG` to the poll loop in Phase 3. `STS` provides squelch / mute / sig_lvl; `GLG` provides everything else.

---

## Fixtures saved

- [raw.txt](raw.txt) — full captured wire traffic with `\r` and non-printable bytes escaped
- This file — interpretation and reconciliation

Both are committed to the repo as Phase 2 test fixtures.

---

## § Reconciliation against decompiled reference (2026-05-22)

After v1.0.0 shipped, a fresh decompile of the official Uniden Sentinel app (`BC125AT_SS.exe`, namespace `Uniden.Scaner.SS`) plus the community Scan125 tool produced a 750-line wire-protocol reference (`BC125AT_PROTOCOL.md`). Most of its content cross-confirms what we'd already documented. Two empirical claims contradict this hardware:

### Conflict 1 — USB VID/PID

- **Reference says:** BC125AT enumerates via a Silicon Labs CP210x USB-UART bridge with VID/PID `0x10C4:0xEA60`.
- **Our hardware says:** Uniden America Corp. CDC-ACM direct, VID/PID `0x1965:0x0017` (verified via `ioreg -p IOUSB -l -w 0` on macOS Darwin 25.4.0). No Silicon Labs intermediary on this unit.
- **Verdict:** captures win. Bearpaw stays on `0x1965:0x0017`. The reference is likely describing a different unit revision or an older firmware. If a CP210x BC125AT shows up in the wild we'll add a second VID/PID branch then.

### Conflict 2 — CIN write-vs-read field order

- **Reference says:** `CIN` read returns `..., ctcss, lockout, delay, priority` while write sends `..., ctcss, delay, lockout, priority` — i.e., delay and lockout are *swapped* on write.
- **Our hardware says:** Read order is `..., ctcss, delay, lockout, priority` on firmware 1.06.06 — confirmed in Finding 4 above (sample 4 `CIN,4,Trimble 640,01466400,AUTO,0,2,1,0` has delay=2, lockout=1, priority=0).
- **Verdict:** captures win on the *read* side. The write-side order is genuinely unknown for our firmware because Bearpaw doesn't currently write CIN. **Implementing CIN writes requires a write→read-back verification step on this hardware first**, before assuming the reference's claim or assuming the read order applies symmetrically.
- **RESOLVED 2026-07-08:** the write→read-back probe ran on this hardware (fw 1.06.06) — transcript in `docs/wire_captures/2026-07-08/cin-write-order-probe.txt`, reproducible via `cargo run -p bearpaw-api --example cin_write_probe`. **Write order equals read order** (`name, freq, mod, ctcss, delay, lockout, priority`): a payload with delay-slot=1 / lockout-slot=0 (both legal in either slot) read back as delay=1, lockout=0. The reference's swap claim is wrong for this firmware. Bonus confirmations: an **empty write field means "unchanged"** (empty name left the prior name in place; clear with 16 spaces), tone code 76 round-trips intact, and `DCH,<n>` restores factory-empty state (`,00000000,AUTO,0,2,1,0`).

### Governing rule

Whenever `BC125AT_PROTOCOL.md` disagrees with a wire capture from this hardware, the capture wins. Document the disagreement in `docs/SCANNER_PROTOCOL_REFERENCE.md`; do not reshape the Rust code to match the reference's claim.
