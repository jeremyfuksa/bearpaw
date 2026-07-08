# Scanner Protocol Reference

**Last updated:** 2026-05-19
**Devices:** Uniden BC125AT family — BC125AT, BCT125AT, UBC125XLT, UBC126AT, AE125H
**Authoritative sources:**
- Uniden, *BC125AT PC Protocol v1.01* (programming command set, serial settings)
- Uniden, *BCT15X v1.03 Protocol* (operational commands `STS`/`GLG`/`KEY`/`PWR`; BearTracker commands)
- `docs/compass_artifact_wf-4d260a13-b490-4b4e-830c-010c039981ab_text_markdown.md` (consolidated research)

> This document is the **wire-protocol** spec. For Bearpaw's REST/WebSocket API see [API_SPEC.md](API_SPEC.md) and [WEBSOCKET_SCHEMA.md](WEBSOCKET_SCHEMA.md). For the UI hit-workflow see [UI_WORKFLOW.md](UI_WORKFLOW.md).

---

## Table of contents

1. [USB enumeration and OS drivers](#1-usb-enumeration-and-os-drivers)
2. [Wire-protocol fundamentals](#2-wire-protocol-fundamentals)
3. [Operational-mode commands](#3-operational-mode-commands)
4. [Programming-mode commands](#4-programming-mode-commands)
5. [BearTracker commands (BCT125AT)](#5-beartracker-commands-bct125at)
6. [Frequency encoding](#6-frequency-encoding)
7. [CTCSS / DCS tone codes](#7-ctcss--dcs-tone-codes)
8. [Bearpaw `LiveState` derivation](#8-bearpaw-livestate-derivation)
9. [Bearpaw `ChannelData` structure](#9-bearpaw-channeldata-structure)
10. [Polling cadence and resilience](#10-polling-cadence-and-resilience)
11. [Memory sync process](#11-memory-sync-process)
12. [Common pitfalls](#12-common-pitfalls)
13. [Known correctness gaps in current Bearpaw code](#13-known-correctness-gaps-in-current-bearpaw-code)

---

## 1. USB enumeration and OS drivers

**VID / PID:** `0x1965` (Uniden America Corp.) / `0x0017`. Class 02 (Communications), subclass 02 (Abstract Control Model). The MCU implements USB CDC-ACM directly — there is no FTDI / CP210x / PL2303 / CH340 bridge.

**No third-party driver is required on any modern OS.**

| OS | Device node / port | Driver |
|---|---|---|
| macOS (incl. Apple Silicon) | `/dev/cu.usbmodemXXXX` | Built-in `AppleUSBCDCACMData` / `AppleUSBCDC` (Apple-signed) |
| Linux | `/dev/ttyACM0` | In-tree `cdc_acm` |
| Windows 10/11 | `COMn`, friendly name "BC125AT" | In-box `usbser.sys` |

**macOS:** Always open the `cu.*` node, never `tty.*`. The `tty.*` node blocks on open waiting for DCD, which the scanner does not assert. The trailing path number changes on replug — match by USB serial number, not by path.

**Linux:** No udev rule is strictly required, but two are recommended:
1. Grant your user access: `MODE="0666"` or `GROUP="dialout"`.
2. Tell `ModemManager` to leave it alone — it probes new ACM devices and can corrupt early traffic:
   ```
   SUBSYSTEMS=="usb", ATTRS{idVendor}=="1965", ATTRS{idProduct}=="0017", ENV{ID_MM_DEVICE_IGNORE}="1"
   ```
3. **TLP and USB autosuspend will silently break the connection on laptops.** Pin `power/autosuspend=-1` for VID `0x1965` via udev, or disable TLP for this device.

**Windows:** If Device Manager fails to bind automatically, use Uniden's signed driver bundle (`Windows_Serial_Drivers.zip` from the BCD536HP TWiki page). The older `BC125AT_USB_driver.zip` is unsigned and fails on Windows 8.1+.

**Serial settings** (canonical, from BC125AT v1.01 PDF):
- **115200 baud, 8N1, no flow control.**
- Because CDC-ACM ignores baud, any value works in practice; 115200 is the convention every Uniden library and tool uses.
- **Line ending: `\r` only (0x0D). Never `\r\n`.** A stray LF leaves a byte in the buffer that turns the next command into `ERR`.

**Open-time discipline:**
- **Disable DTR/RTS on open.** Asserting DTR has caused intermittent disconnects on Linux and macOS. In pyserial: `dsrdtr=False`; in Node `serialport`: `hupcl: false`; in Rust `serialport` crate: don't call `write_data_terminal_ready(true)`.
- **Set raw mode immediately after open** on Linux/macOS (`cfmakeraw()` or clear `ICANON`/`ECHO`). The Linux `cdc_acm` driver enables tty echo by default and will garble early traffic otherwise.
- **Drain the input buffer on connect.** Stale bytes from a previous session turn the first response into `ERR` or partial garbage.

**Auto-detection recipe:**
1. Enumerate ports, filter by `VID == 0x1965`.
2. If none match, probe every CDC-class port with `MDL\r` and accept any response starting with `MDL,`.
3. Cache the device's USB serial number so reconnects after replug find the same physical unit.

### VID/PID variants observed

The `BC125AT_PROTOCOL.md` reference (decompiled from Uniden Sentinel + Scan125, see `docs/wire_captures/2026-05-21/audit-reconciliation.md`) states the BC125AT uses a Silicon Labs CP210x USB-UART bridge with VID/PID `0x10C4:0xEA60`. **This does not match our hardware.** Our unit (verified via `ioreg -p IOUSB` on macOS Darwin 25.4.0, 2026-05-22) enumerates as Uniden America Corp. CDC-ACM with `0x1965:0x0017` — no Silicon Labs intermediary. Likely a different firmware/hardware revision than what Sentinel was originally designed against, or an outdated claim in the decompiled doc.

**Our captures win.** Bearpaw probes `0x1965:0x0017` and that is what it should keep doing for BC125AT-family hardware. If a user reports a `0x10C4:0xEA60` BC125AT in the future, we'll add a second VID/PID branch; until then it's hypothetical.

The `BC125AT_PROTOCOL.md` reference also documents a known macOS quirk for which we have empirical evidence: the device enumerates at USB level but the kernel CDC-ACM driver never binds, so `/dev/cu.usbmodem*` does not appear. Bearpaw works around this via the `nusb` direct-USB transport (`crates/bearpaw-api/src/transport_usb.rs`), configured by setting `device.usb_vid` and `device.usb_pid` in `config.yaml`. See [`crates/bearpaw-api/config.example.yaml`](../crates/bearpaw-api/config.example.yaml).

---

## 2. Wire-protocol fundamentals

The protocol is **half-duplex, synchronous, ASCII, case-sensitive, single-line by default**. Commands are uppercase keywords followed by comma-delimited fields and a single `\r`. Responses echo the command name followed by either:

- **Fields** for "get" commands (`MDL,BC125AT\r`, `GLG,01545500,FM,…\r`)
- **`OK`** for "set" commands (`KEY,OK\r`, `PRG,OK\r`)
- **`NG`** when the command is syntactically correct but invalid in the current mode (`PRG,NG\r` if already in a menu)
- **`ERR\r`** (bare token, no command echo) for syntax or out-of-range errors

The scanner **sends no unsolicited data**, no banner, and no echo of your raw command bytes. **Pipelining is not supported** — wait for the response to each command before sending the next. Pipelined commands produce `ERR`, `NG`, or mangled output.

### Error semantics

| Token | Meaning | Recovery |
|---|---|---|
| `ERR\r` | Syntax error or out-of-range value | Fix the command before retrying |
| `<CMD>,NG\r` | Correct command, wrong mode | Likely missing `PRG`; or scanner is in a menu / direct-entry state |
| `FER` | UART framing error (BCT15X only; never seen over USB) | — |
| `ORER` | UART overrun (BCT15X only; never seen over USB) | — |

### Empty fields in writes

**In any "set" command, an empty field (just a comma) means "leave this field unchanged."** Format errors abort the entire write — there are no partial updates.

To **clear** an alpha tag, send 16 spaces, not an empty field. Empty means "no change."

### Two macro-modes

- **Operational mode** (default): `STS`, `GLG`, `KEY`, `PWR`, `MDL`, `VER`, `VOL`, `SQL` all work.
- **Program mode** (entered with `PRG\r`, exited with `EPG\r`): the LCD shows "Remote Mode / Keypad Lock," scanning stops, and memory-modifying commands (`CIN`, `DCH`, `CLR`, `SCG`, `BLT`, `BSV`, `PRI`, `KBP`, `SSG`, `CSG`, `CSP`, `CLC`, `WXS`, `CNT`, `GLF`/`ULF`/`LOF`, plus BCT125AT `STT`/`BTL`/`BTS`) become valid.

Keep the real-time UI in operational mode and bracket every programming operation in `PRG`/`EPG`. After `PRG,OK` and after `EPG,OK`, wait ~50–100 ms before the next command for the mode transition to settle.

---

## 3. Operational-mode commands

### MDL — Model identification

```
> MDL\r
< MDL,BC125AT\r
```

Possible responses include `MDL,BC125AT`, `MDL,BCT125AT`, `MDL,UBC125XLT`, `MDL,UBC126AT`, `MDL,AE125H`. Works in both modes. Used for port auto-detection and model-specific branching.

### VER — Firmware version

```
> VER\r
< VER,Version 1.04.02\r
```

Useful to log because `STS` and `GLG` field counts vary between firmware revisions.

### STS — LCD display dump + status bits

```
> STS\r
< STS,<DSP_FORM>,<L1_CHAR>,<L1_MODE>,<L2_CHAR>,<L2_MODE>,<L3_CHAR>,<L3_MODE>,<L4_CHAR>,<L4_MODE>,<SQL>,<MUT>,<RSV>,<WAT>,<LED_CC>,<LED_ALERT>,<SIG_LVL>,<RSV>,<BK_DIMMER>\r
```

This is a **single-line, comma-separated LCD dump**, not key-value pairs. Field-by-field:

| Field | Meaning |
|---|---|
| `DSP_FORM` | 4-digit binary mask: 1 = line is large-font, 0 = small-font (e.g. `0110` = lines 2 & 3 large) |
| `L1_CHAR`–`L4_CHAR` | Each exactly **16 ASCII characters**, space-padded |
| `L1_MODE`–`L4_MODE` | Each up to 16 chars: space = normal, `*` = reverse video, `_` = underline. **Collapses to empty** (`,,`) if all 16 chars are normal |
| `SQL` | **1 = squelch open (signal present), 0 = squelch closed** |
| `MUT` | 1 = muted, 0 = not muted |
| `RSV` | Reserved (empty on BC125AT) |
| `WAT` | Weather / SAME alert state |
| `LED_CC` | Close Call LED, 0 / 1 |
| `LED_ALERT` | Alert LED, 0 / 1 |
| `SIG_LVL` | Signal bars, **0–5** (this is the LCD bar count, NOT a 0–100 percentage or dBm) |
| `RSV` | Reserved |
| `BK_DIMMER` | Backlight dimmer, 0=Off / 1=Low / 2=Mid / 3=High |

**Example** (scan-hold on 851.0125 MHz, signal present):

```
STS,0110,
    HOLD     L/O    ,                ,
    SYSTEM 1        ,                ,
    851.0125MHz     ,                ,
    P NFM ATT       ,                ,
    0,1,0,0,0,0,1,,\r
```

**Important parsing notes:**
- `STS` does **NOT** carry frequency, modulation, channel index, volume, or battery as named fields. Frequency comes from `GLG` or `PWR`. Modulation comes from `GLG`. Channel index comes from `GLG`. Volume comes from `VOL`. Battery is not exposed on this protocol.
- Field count varies across firmware revisions. **Parse by position with defensive bounds checks**, not by assuming a fixed shape.
- The BC125AT family is known to **occasionally drop or truncate `STS` responses** even under correct polling (Bob Smith / ProScan, confirmed). Re-poll on the next tick rather than throwing.

### GLG — Current reception info

```
> GLG\r
< GLG,<FRQ>,<MOD>,<ATT>,<CTCSS/DCS>,<NAME1>,<NAME2>,<NAME3>,<SQL>,<MUT>[,<RSV>,<CHAN_NUM>]\r
```

| Field | Meaning |
|---|---|
| `FRQ` | 8-digit integer in 100 Hz units, leading zeros. `01462250` = 146.2250 MHz |
| `MOD` | `AM` / `FM` / `NFM` / `AUTO` |
| `ATT` | Attenuator state |
| `CTCSS/DCS` | Integer tone **code** 0–231 (see [§7](#7-ctcss--dcs-tone-codes)) — **not** Hz |
| `NAME1`/`NAME2`/`NAME3` | Bank/system, group, channel alpha tags (groups are unused on BC125AT's flat memory) |
| `SQL` | 1 = open, 0 = closed |
| `MUT` | 1 = muted |
| `RSV`, `CHAN_NUM` | Optional trailing fields; presence depends on firmware (pa3ang's reverse-engineering identified these on UBC125XLT) |

**Idle state** (between channels, no current signal) returns a comma skeleton:

```
GLG,,,,,,,,,\r
```

**Parsing discipline:**
- Always **split-and-index** rather than assuming a fixed field count.
- Treat all-empty as "no current channel."
- Alpha tag is the first non-empty text field after modulation.

`GLG` is the canonical source for live frequency, modulation, alpha tag, and channel number — not `STS`.

### PWR — RSSI and current frequency

```
> PWR\r
< PWR,742,01545500\r
```

| Field | Meaning |
|---|---|
| Field 1 | RSSI as raw ADC value, **0–1023**, NOT dBm and NOT 0–100 |
| Field 2 | Frequency in 100 Hz units (same encoding as `GLG`) |

RSSI updates slowly on this family and has limited dynamic range. Use it for "signal present / strong / weak," not as a precision S-meter. Calibration varies by band.

### KEY — Simulate keypress

```
> KEY,<CODE>,<MODE>\r
< KEY,OK\r
```

`MODE` is `P` (press), `L` (long press), `H` (hold indefinitely, auto-times-out after 10 s), or `R` (release a prior `H`).

**Verified BC125AT/BCT125AT key codes:**

| Code | Key | Notes |
|---|---|---|
| `M` | Menu | |
| `F` | Function | |
| `H` | Hold / Resume | Most common via Bearpaw |
| `S` | Scan | Most common via Bearpaw |
| `L` | Lockout (L/O) | |
| `0`–`9` | Digits | |
| `.` | ./No | |
| `E` | E / Yes | |
| `>` | Scroll knob CW | |
| `<` | Scroll knob CCW | |
| `V` | Scroll-knob push (volume mode) | |
| `Q` | Func + scroll-push (squelch mode) | |
| `P` | Priority (Func+5) | |
| `W` | Weather (Func+3) | |

**BearTracker / HWY key** on the BCT125AT is **not officially documented**. The BCT15X uses `B`; verify empirically on a BCT125AT by sweeping codes and observing the LCD via `STS`.

Allow ~50–100 ms between consecutive `KEY` packets for firmware key debounce.

### DO — Direct tune (Bearpaw `DIRECT` mode)

```
> DO,151.2500,NFM\r
< DO,OK\r
```

Frequency is sent as a decimal MHz string with 4 decimal places. Modulation must be one of `AUTO`, `AM`, `FM`, `NFM`.

### VOL / SQL — Volume and squelch

```
> VOL\r          / VOL,n\r
< VOL,8\r        / VOL,OK\r

> SQL\r          / SQL,n\r
< SQL,5\r        / SQL,OK\r
```

**Range is 0–15 for both** on the BC125AT/BCT125AT family.

- `VOL` 0 = muted, 15 = max
- `SQL` 0 = open (let everything through), 15 = closed (silent unless strong signal)

Do **not** import the BCT15X 0–29 / 0–19 ranges by mistake. Different scanner family.

Both work in operational and programming mode.

### Battery

The BC125AT/BCT125AT protocol does **not expose battery level**. Treat any `battery` field in Bearpaw's `LiveState` as always `None` for these models. (Some sibling models on different firmware may; do not assume.)

### Operational command summary

| Command | Direction | Example response | Notes |
|---|---|---|---|
| `MDL` | get | `MDL,BC125AT` | Both modes |
| `VER` | get | `VER,Version 1.04.02` | Both modes |
| `PRG` | enter | `PRG,OK` or `PRG,NG` | NG if in menu / direct entry |
| `EPG` | exit | `EPG,OK` | Returns to scan or hold |
| `VOL` / `VOL,n` | get/set | `VOL,8` / `VOL,OK` | Range 0–15; both modes |
| `SQL` / `SQL,n` | get/set | `SQL,5` / `SQL,OK` | Range 0–15; both modes |
| `STS` | get | LCD dump | Both modes; field count varies |
| `GLG` | get | `GLG,01545500,FM,,76,Police,,Dispatch,1,0` | Both modes; empty when idle |
| `PWR` | get | `PWR,742,01545500` | Both modes; RSSI 0–1023 |
| `KEY,c,m` | set | `KEY,OK` | Both modes |
| `DO,<f>,<m>` | set | `DO,OK` | Both modes |
| `BLT` / `BLT,v` | get/set | `BLT,KY` / `BLT,OK` | Backlight: `AO`/`AF`/`KY`/`SQ`/`KS` |

---

## 4. Programming-mode commands

### CIN — Channel Info (read or write a memory channel)

**Read:**
```
> PRG\r
< PRG,OK\r
> CIN,42\r
< CIN,42,Tower Ground   ,01210000,AM,0,2,0,0\r
> EPG\r
< EPG,OK\r
```

**Write:**
```
> PRG\r
< PRG,OK\r
> CIN,1,Marine Ch 16   ,01560000,FM,0,2,0,0\r
< CIN,OK\r
> EPG\r
< EPG,OK\r
```

**Field order (per Uniden BC125AT v1.01 PDF):**

| Position | Field | Range / format |
|---|---|---|
| 0 | Command echo | `CIN` |
| 1 | Index | 1–500 |
| 2 | Alpha tag | ≤16 ASCII chars, space-padded; empty field means "unchanged" on write — pad with 16 spaces to clear |
| 3 | Frequency | 8-digit integer in 100 Hz units (`01545000` = 154.5000 MHz); valid 25–512 MHz |
| 4 | Modulation | `AUTO` / `AM` / `FM` / `NFM` |
| 5 | **CTCSS/DCS code** | Integer 0–231 (see [§7](#7-ctcss--dcs-tone-codes)); 0 = none, 127 = SEARCH, 240 = NO_TONE |
| 6 | Delay | One of `-10,-5,0,1,2,3,4,5` (seconds; negatives are pre-delays) |
| 7 | Lockout | 0 = not locked, 1 = locked |
| 8 | Priority | 0 = no, 1 = yes |

**There is no `bank` field in `CIN`.** Bank membership is controlled by `SCG` (see below), which is a 10-digit mask covering all 500 channels' bank assignments. Do not look for a 9th `CIN` field — it doesn't exist.

> **Write-side field order: open question.** `BC125AT_PROTOCOL.md` (decompiled from Uniden Sentinel) claims the write order is `name, freq, mod, ctcss, delay, lockout, priority` while the **read** order is `name, freq, mod, ctcss, lockout, delay, priority` — i.e., delay and lockout are swapped on write. Our wire captures (`docs/wire_captures/2026-05-21/`) confirm the read order is `delay, lockout, priority` on firmware 1.06.06 — the **same** order shown in the table above. The reference's swap claim is unverified on our hardware. **Bearpaw does not currently write CIN.** If/when a CIN write path is added, the first task is to write a known value, read it back, and confirm which order matches reality. Until that empirical check happens, do not implement CIN writes.

### Other programming commands

| Command | Purpose | Notes |
|---|---|---|
| `DCH,n` | Delete channel `n` | |
| `CLR` | Factory-reset all 500 channels + settings | **Takes ~30 s; scanner unresponsive during it.** Extend read timeout to 45–60 s for this command only. |
| `SCG` / `SCG,<mask>` | Get/set channel-storage bank mask | 10-digit string; **`0` = bank enabled, `1` = bank disabled** (inverted from intuition). Order matches LCD icons 1,2,…,9,0 (bank "0" is bank 10). **Write persistence verified 2026-07-08** on firmware 1.06.06 via live write→read-back inside one PRG bracket (`SCG,0000111110` → `SCG,OK` → read-back matched, both directions); Bearpaw's `set_banks` re-verifies on every write regardless. |
| `SSG` / `SSG,<mask>` | Service-search bank mask | Same 0=on / 1=off convention. Banks: Police, Fire/Emerg, Ham, Marine, Railroad, Civil Air, Mil Air, CB, FRS/GMRS/MURS, Racing. |
| `CSG` / `CSG,<mask>` | Custom-search range mask | Same convention |
| `CSP,n` | Get/set custom range `n` upper/lower limits | |
| `CLC` | Close Call config (mode, alert, band mask, lockout) | **Band-bit layout differs between PDF v1.00 and v1.01** — verify empirically |
| `PRI` / `PRI,n` | Priority mode | 0 off / 1 on / 2 plus / 3 DND |
| `KBP` | Key beep & keypad lock | |
| `BSV,n` | Battery save / charge time | 1–16 hours |
| `WXS` | Weather alert priority | |
| `CNT` | LCD contrast | 1–15 |
| `BLT` | Backlight behavior | `AO` always on / `AF` off / `KY` on keypress / `SQ` on squelch / `KS` keypress+squelch |
| `GLF` | Walk the global lockout list | Returns one freq per call until end |
| `LOF,freq` | Add frequency to lockout list | Up to 200 entries |
| `ULF,freq` | Remove from lockout list | |

### Memory architecture

- **500 channels in a flat namespace**, divided into **10 banks of 50** (bank 1 = ch 1–50, bank 2 = 51–100, …, bank 10 = 451–500 — the "0" key on the LCD).
- **One priority channel per bank max.**
- **No systems, no groups, no sites, no trunking.** This is a conventional-only analog scanner.
- No user-programmable BearTracker memory; BCT125AT BearTracker frequencies are baked into firmware per state.

---

## 5. BearTracker commands (BCT125AT)

Uniden has **never published a BCT125AT-specific protocol PDF**. The commands below are inferred from the BCT15X v1.03 spec; third-party tools targeting the BCT125AT use this same set. **Verify each command on your unit before depending on it in shipping code.**

These are all programming-mode commands — wrap them in `PRG` / `EPG`.

### STT — Select active BearTracker state

```
> STT,TX\r
< STT,OK\r
```

Two-letter US state abbreviation, or `CAN_xx` Canadian province code. The BCT requires a state at all times — there is no "off" value.

### BTL — Per-category lockout

```
> BTL,<POL>,<DOT>,<HP>,<BT>\r
< BTL,OK\r
```

Each field 0 (unlocked) or 1 (locked). Categories: Police, Department of Transportation, Highway Patrol, BearTracker mobile-extender. Example: `BTL,0,1,1,0\r` locks DOT and HP, leaves Police and BT active.

### BTS — BearTracker options block

```
> BTS,<beep_tone>,<alert_level>,<tape>,<delay>,<conv_hold>,<trunked_hold>,<alert_light>\r
< BTS,OK\r
```

| Field | Meaning |
|---|---|
| Alert beep tone | 0–9 |
| Alert tone level | 0 = auto, 1–15 |
| Tape-out record | Reserved on BCT125AT (no tape-out hardware) |
| Delay | One of `-10,-5,-2,0,1,2,5,10,30` |
| Conventional system hold time | seconds |
| Trunked system hold time | Reserved on analog-only BCT125AT |
| Alert light pattern | 0 off / 2 slow / 3 fast |

### Not applicable on BCT125AT

Inherited from BCT15X family but absent / always returns `NG` or `ERR`:

- `BSP` (Band Scope)
- `BBS` (Broadcast Screen)
- GPS: `GGA`, `RMC`, `GDO`
- Location alerts: `CLA`, `DLA`, `LIN`, `LIH`, `LIT`
- `ESN`

---

## 6. Frequency encoding

The protocol uses **integer 100 Hz units** for the wire form, formatted as 8 digits with leading zeros:

```
01469700  →  146.9700 MHz
04421250  →  442.1250 MHz
01518200  →  151.8200 MHz
00250000  →   25.0000 MHz
05120000  →  512.0000 MHz   (BC125AT upper limit)
```

**Valid range: 25.0000 – 512.0000 MHz on BC125AT.**

Conversion:

```python
# wire → MHz
mhz = int(wire_field) / 10_000.0

# MHz → wire (in CIN, GLF, LOF, ULF)
wire = f"{int(round(mhz * 10_000)):08d}"
```

**Note:** `DO` (direct tune) is the exception — it accepts decimal MHz with 4 decimal places:

```
DO,146.9700,NFM\r
```

---

## 7. CTCSS / DCS tone codes

`CIN` and `GLG` carry the tone as an **integer code 0–231**, not as a frequency in Hz. Bearpaw must translate.

| Code range | Meaning |
|---|---|
| `0` | No tone / open squelch |
| `64`–`113` | CTCSS tones, 67.0 Hz → 254.1 Hz |
| `127` | SEARCH (scanner identifies tone on each hit) |
| `128`–`231` | DCS codes |
| `240` | NO_TONE (explicit "tone-squelched, but no tone configured") |

### CTCSS table (code → Hz)

```
64  → 67.0      81  → 118.8     98  → 183.5
65  → 69.3      82  → 123.0     99  → 186.2
66  → 71.9      83  → 127.3     100 → 189.9
67  → 74.4      84  → 131.8     101 → 192.8
68  → 77.0      85  → 136.5     102 → 196.6
69  → 79.7      86  → 141.3     103 → 199.5
70  → 82.5      87  → 146.2     104 → 203.5
71  → 85.4      88  → 151.4     105 → 206.5
72  → 88.5      89  → 156.7     106 → 210.7
73  → 91.5      90  → 159.8     107 → 218.1
74  → 94.8      91  → 162.2     108 → 225.7
75  → 97.4      92  → 165.5     109 → 229.1
76  → 100.0     93  → 167.9     110 → 233.6
77  → 103.5     94  → 171.3     111 → 241.8
78  → 107.2     95  → 173.8     112 → 250.3
79  → 110.9     96  → 177.3     113 → 254.1
80  → 114.8     97  → 179.9
```

50 contiguous tones, codes 64–113, no gaps — the standard EIA CTCSS set.
This matches `BC125AT_PROTOCOL.md` §7.2 (decompiled Sentinel) and is
cross-confirmed by bc125py and bc125csv. **History (#130):** an earlier
version of this table omitted 69.3 Hz, shifting every tone from code 65 up
by one slot, and fabricated "reserved" gaps at 78/79/94/95 to absorb the
drift — a channel with CTCSS 100.0 Hz (wire code 76) displayed as 103.5.
If a future source disagrees with this table, suspect the source: the
50-tone list is the industry-standard set every Uniden document agrees on.

For DCS (codes 128–231), see RadioReference's CTCSS/DCS cross-reference. Most amateur and public-safety scanner programming uses CTCSS, not DCS.

---

## 8. Bearpaw `LiveState` derivation

This is what the backend constructs and broadcasts. **Field sources differ from `STS` field names** — derive each field from the right command:

```python
@dataclass
class LiveState:
    timestamp: float              # Unix timestamp, backend-generated
    frequency: float              # MHz, from GLG[1] / 10000  (or PWR[2] / 10000)
    modulation: str               # "FM" | "AM" | "NFM" | "AUTO", from GLG[2]
    squelch_open: bool            # True = signal present; from GLG SQL field (1=open)
    rssi: int                     # Bearpaw scale 0–100, mapped from PWR (0–1023) or STS SIG_LVL (0–5)
    mode: str                     # "SCAN" | "HOLD" | "DIRECT", commanded by scheduler — NOT a wire field
    channel: Optional[int]        # 1–500 or None, from GLG trailing CHAN_NUM (firmware-dependent)
    alpha_tag: Optional[str]      # First non-empty name field in GLG
    volume: int                   # 0–15, from VOL
    battery: Optional[int]        # Always None on BC125AT/BCT125AT protocol
    stale: bool                   # Backend-set: true if reads have been failing
```

### Critical correctness rules

- **`mode` is not in the protocol.** It's tracked by the command scheduler as "the last commanded mode": `SCAN` after `KEY,S,P`, `HOLD` after `KEY,H,P`, `DIRECT` after `DO,…`. The scanner reports no mode enum. Do not look for a `MODE` key in `STS` — it doesn't exist.
- **Squelch polarity:** `SQL=1` means **open** (signal present, scanner auto-paused). `SQL=0` means **closed** (no signal, scanner cycling if mode=SCAN). This is true in both `STS` and `GLG`.
- **`battery` is always `None` for this family.** The protocol does not expose it.
- **`rssi` mapping:** Either rescale `PWR` field 1 (0–1023 → 0–100) or surface `STS` `SIG_LVL` (0–5) directly. Don't pretend `STS` has a 0–100 `RSSI` key — it doesn't.
- **Hit detection:** A "hit" is the transition `squelch_open: false → true` while `mode == "SCAN"`. The scanner pauses on the channel automatically; the wire `mode` does not change. See [UI_WORKFLOW.md](UI_WORKFLOW.md).

### State transition examples

**Normal scan cycle:**
```jsonc
// Scanning (cycling)
{"mode": "SCAN", "squelch_open": false, "frequency": 146.970, "channel": 67}
{"mode": "SCAN", "squelch_open": false, "frequency": 147.000, "channel": 68}

// Hit detected (squelch opens — scanner auto-pauses)
{"mode": "SCAN", "squelch_open": true,  "frequency": 147.030, "rssi": 85, "channel": 69}

// Listening
{"mode": "SCAN", "squelch_open": true,  "rssi": 90}

// Signal ends, scanner resumes
{"mode": "SCAN", "squelch_open": false, "frequency": 147.060, "channel": 70}
```

**User presses Hold:**
```jsonc
// Before
{"mode": "SCAN", "squelch_open": false, "frequency": 146.970}

// Scheduler sends: KEY,H,P\r → KEY,OK\r ; updates commanded_mode to "HOLD"

// After
{"mode": "HOLD", "frequency": 146.970}
```

**Direct tune:**
```jsonc
// Scheduler sends: DO,151.2500,NFM\r → DO,OK\r ; updates commanded_mode to "DIRECT"
{"mode": "DIRECT", "frequency": 151.250, "channel": null}
```

---

## 9. Bearpaw `ChannelData` structure

```python
@dataclass
class ChannelData:
    index: int                    # 1–500
    frequency: float              # MHz
    modulation: str               # "FM" | "AM" | "NFM" | "AUTO"
    alpha_tag: str                # ≤16 chars
    delay: int                    # one of -10, -5, 0, 1, 2, 3, 4, 5 (seconds)
    lockout: bool                 # True = skip during scan
    priority: bool                # True = priority channel
    tone_squelch: Optional[float] # CTCSS in Hz (decoded from code), None for 0 / 240, "search" sentinel for 127
    bank: int                     # 0–10, derived from SCG mask, NOT from CIN
```

### Mapping rules

- `tone_squelch` is **decoded** from the integer code in `CIN[5]` via the table in [§7](#7-ctcss--dcs-tone-codes). Bearpaw stores Hz for UI convenience but must remember to re-encode to a code when writing channels back.
- `bank` is **synthesised**, not read from `CIN`. After memory sync, query `SCG` and apply the bank-membership rules to every channel index. (For a flat 10×50 layout: channel `n` belongs to bank `ceil(n/50)`, with the SCG mask determining whether that bank is currently *active* in scan, which is a separate concept from channel-to-bank assignment. On the BC125AT, channel-to-bank is fixed by index, not user-assignable. Document this in the UI.)
- `delay` accepts the full Uniden range `-10, -5, 0, 1, 2, 3, 4, 5`. Negative values are "pre-delays" (start delaying *before* squelch closes). UI must validate against this set.
- `alpha_tag` is space-padded on the wire to 16 chars. Strip trailing spaces for display, but **pad to 16 spaces when writing** to clear an existing tag.

---

## 10. Polling cadence and resilience

### Recommended cadence

- **`STS` + `GLG`, back-to-back, every 100–250 ms** for a snappy UI. Conservative floor: 300–500 ms.
- **`PWR` interleaved every ~500 ms** if a signal-strength bar is desired.
- ProScan exposes 5 ms–2000 ms; below ~100 ms is uncomfortable for the BC125AT firmware.

### Hard rules

1. **One command in flight at a time.** No pipelining. The scanner matches responses to commands purely by FIFO order — there are no transaction IDs.
2. **Read until `\r`, never `\n`.** Never use fixed-byte reads — field widths are variable.
3. **Defensively discard incomplete `STS` responses.** The firmware occasionally drops or truncates them. Re-poll on the next tick.
4. **After `PRG,OK` and `EPG,OK`, wait ~50–100 ms** before the next command. Mode transitions can produce partial `STS` responses.
5. **Extend read timeout for `CLR` to 45–60 s.** The scanner is unresponsive during a factory reset.
6. **Reconnect with exponential backoff** (1 s → 2 s → 5 s → 10 s, capped) on three consecutive read timeouts.
7. **Always issue `EPG` before closing the port** if you entered `PRG`. If the app crashed and left the scanner in Remote Mode, the recovery is to reopen the port and send `EPG\r`.

### Threading model

- **Python:** Single dedicated worker thread doing blocking `pyserial.read_until(b'\r')` with 500 ms timeout, pushing parsed updates onto a `queue.Queue`. Avoid `pyserial-asyncio` for this hardware.
- **Rust:** Owning task on a Tokio runtime with a mutex around the port; `serialport` crate's blocking I/O is fine in a `spawn_blocking` task, or use `tokio-serial`.
- **Node.js:** `SerialPort` + `ReadlineParser` with `delimiter: '\r'`, plus an in-memory FIFO of pending command promises that resolve in arrival order.

The invariant is **one outstanding command at a time** — build that into the API, not the caller.

---

## 11. Memory sync process

Reading all 500 channels takes ~60 seconds.

1. Backend: `PRG\r` → wait for `PRG,OK\r`, sleep 100 ms.
2. For each channel 1..500:
   - `CIN,<index>\r` → parse response into `ChannelData`.
   - Yield to higher-priority commands periodically (the scheduler should preempt for user `KEY` / `DO`).
   - Broadcast progress every ~10 channels.
3. `EPG\r` → wait for `EPG,OK\r`, sleep 100 ms.
4. Restore previous commanded mode (resend `KEY,H,P` or `KEY,S,P` as appropriate).
5. Optionally: `SCG\r` to read bank mask and populate `ChannelData.bank` per [§9](#9-bearpaw-channeldata-structure).

Progress messages:
```jsonc
{"type": "progress", "task_id": "sync-abc123", "percent": 0,   "message": "Starting memory sync..."}
{"type": "progress", "task_id": "sync-abc123", "percent": 10,  "message": "Read 50 of 500 channels"}
...
{"type": "progress", "task_id": "sync-abc123", "percent": 100, "message": "Memory sync complete"}
```

---

## 12. Common pitfalls

1. **Pipelining commands** → `ERR` / `NG` / mangled output. Wait for each response.
2. **DTR/RTS toggling on open** → silent disconnect. Disable explicitly.
3. **Opening `/dev/tty.usbmodem*` on macOS** → blocks on open. Use `cu.*`.
4. **Reading until `\n`** → never arrives. Read until `\r`.
5. **Matching device path number across replug** → wrong device on next reboot. Match by USB serial number.
6. **TLP / USB autosuspend on Linux laptops** → silent disconnect. Disable for this VID.
7. **Treating `ERR` and `NG` the same** → loses diagnostic value. `ERR` = fix the command; `NG` = enter the right mode first.
8. **Empty CIN write field meaning "blank"** → it means "unchanged." Pad alpha tags with 16 spaces to clear.
9. **`SCG`/`SSG`/`CSG` bank masks: `0` = enabled, `1` = disabled** — inverted from intuition. Document loudly in code.
10. **Hard-coding `STS` field positions** → breaks on firmware update. Parse defensively.
11. **Assuming `GLG` has a fixed field count** → breaks on firmware variants. Split-and-index, look for the named values.
12. **Treating CTCSS field as Hz** → silently corrupts every channel with a tone. It's a code 0–231; translate via [§7](#7-ctcss--dcs-tone-codes).
13. **Pushing firmware through the protocol** → bricking risk on early BC125AT units (firmware >1.03.01). Use Uniden's official updater.
14. **`CLR` with default 500 ms read timeout** → false timeout error. Use 45–60 s for this one command.
15. **Long alpha tags or non-ASCII** → silently truncated or rejected. ASCII only, ≤16 chars.

---

## 13. Known correctness gaps in current Bearpaw code

These are the eight gaps identified by the 2026-05-19 protocol audit. Each has been re-graded as of 2026-05-22 (v1.0.0 cut + v1.1 plan in flight).

1. **`parse_sts_response` parses key-value pairs.** ✅ **Fixed** in Phase 2. Parser is now position-based, tail-anchored, handles both 10- and 14-field variants.
2. **Squelch polarity inverted (`SQL=0` treated as open).** ✅ **Fixed** in Phase 2/3. `SQL=1` correctly means signal-open.
3. **`MODE` field read from `STS` (dead code).** ✅ **Fixed** in Phase 2. Mode is tracked via `commanded_mode` in the poll loop, never read from the wire.
4. **`CIN` fabricates a `bank` field; `has_tone vs has_bank` heuristic.** ✅ **Fixed** in Phase 2. Fixed-position parser; bank derived from `SCG` separately.
5. **`tone_squelch` parsed as float Hz.** ✅ **Fixed** in Phase 4. Wire value stays as integer code 0–231; decoded to Hz via [`protocol::tones::decode_tone`](../crates/bearpaw-api/src/protocol/tones.rs).
6. **`SerialTransport::open` unconditionally asserts DTR.** ❌ **Still present** at [`transport.rs:38`](../crates/bearpaw-api/src/transport.rs#L38). Scheduled as v1.1 PR-2 (Phase 9b).
7. **`SerialTransport::send` doesn't drain input buffer.** ❌ **Still present.** Scheduled as v1.1 PR-3 (Phase 9c).
8. **No `MDL`-based port autodetect.** ❌ **Still present** — Bearpaw requires explicit `device.port` or `usb_vid`/`usb_pid` in config. Scheduled as v1.1 PR-11 (Phase 9k, optional).

**Two additional gaps surfaced by the 2026-05-22 decompile audit** (cross-checked against our wire captures):

9. **`parse_cin_response` clamps negative `delay` to 0** at [`protocol/mod.rs:294`](../crates/bearpaw-api/src/protocol/mod.rs#L294), discarding the legitimate `-10` and `-5` pre-delay values. Scheduled as v1.1 PR-5 (Phase 9e).
10. **No distinction between `OK` / `ERR` / `NG` / timeout response codes.** Current code checks substring "OK" only; both `ERR` (syntax error, never retry) and `NG` (wrong mode, surface to user) are handled identically. Scheduled as v1.1 PR-4 (Phase 9d).

See [`PROTOCOL_AUDIT_PLAN.md`](PROTOCOL_AUDIT_PLAN.md) for the Phase 1–4 history. The v1.1 continuation plan covers the remaining items via Phase 9 PRs.

---

## Reference docs

- **Uniden BC125AT PC Protocol v1.01:** http://info.uniden.com/twiki/pub/UnidenMan4/BC125AT/BC125AT_PC_Protocol_V1.01.pdf
- **Uniden BCT15X v1.03 Protocol:** http://info.uniden.com/twiki/pub/UnidenMan4/BCT15XFirmwareUpdate/BCT15X_v1.03.00_Protocol.pdf
- **RadioReference wiki:** https://wiki.radioreference.com/index.php/BC125AT
- **Reverse-engineered GLG field map (pa3ang):** https://github.com/pa3ang/ubc125xlt
- **Reference Python implementation:** https://github.com/fdev/bc125csv
- **Reference Python CLI/lib:** https://github.com/itsmaxymoo/bc125py
- **BCT15X-family operational commands (closest OSS impl):** https://github.com/suidroot/pyUniden

## Related Bearpaw docs

- [API_SPEC.md](API_SPEC.md) — REST API surface
- [WEBSOCKET_SCHEMA.md](WEBSOCKET_SCHEMA.md) — live-update message shapes
- [PROTOCOL_AUDIT_PLAN.md](PROTOCOL_AUDIT_PLAN.md) — audit history (Phases 1–4 done; 5–7 partly in v1.1)
- [BACKEND_LOGGING.md](BACKEND_LOGGING.md) — logging conventions
- [DATA_LIFECYCLE.md](DATA_LIFECYCLE.md) — persistence + retention
- [wire_captures/2026-05-21/](wire_captures/2026-05-21/) — real BC125AT wire traffic + audit reconciliation
