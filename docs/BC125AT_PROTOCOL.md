# Uniden BC125AT — Programming & Remote Control Protocol

Complete reverse-engineered protocol reference for the Uniden BC125AT handheld
scanner (also covers the closely-related UBC125XLT, UBC126AT, and Albrecht
AE125H, which all share firmware and protocol).

Derived from:

- Uniden's official **BC125AT Sentinel Software v1.03.00** (2015) — decompiled
  from `BC125AT_SS.exe` (227 KB .NET 4.0 WinForms, internal namespace
  `Uniden.Scaner.SS`, built from `C:\projects\RC\SCN\PC_SOFT\UB370Z_TOOL\`).
- **Scan125 Control Program v3.9.10** by Nick Bailey (2013–2025) — decompiled
  from `Scan125.exe` (746 KB VB.NET on .NET 3.5).

The two implementations agree on every detail of the protocol below.

> **Conflicts with this hardware:** the reference's USB VID/PID and CIN
> write-side field order disagree with our captures. See
> [`docs/SCANNER_PROTOCOL_REFERENCE.md`](SCANNER_PROTOCOL_REFERENCE.md) §1 and
> §4 for the reconciliation. The governing rule: **wire captures from real
> hardware beat decompiled reference claims.**

---

## Table of contents

1. [Physical interface](#1-physical-interface)
2. [Serial port settings](#2-serial-port-settings)
3. [Wire format](#3-wire-format)
4. [Operating modes & state machine](#4-operating-modes--state-machine)
5. [Complete command catalog](#5-complete-command-catalog)
6. [Data encodings](#6-data-encodings)
7. [Enumerated value tables](#7-enumerated-value-tables)
8. [Programming session — write to radio](#8-programming-session--write-to-radio)
9. [Programming session — read from radio](#9-programming-session--read-from-radio)
10. [Live remote control](#10-live-remote-control)
11. [Memory model & limits](#11-memory-model--limits)
12. [macOS implementation notes](#12-macos-implementation-notes)
13. [Existing open-source implementations](#13-existing-open-source-implementations)
14. [Source files used](#14-source-files-used)

---

## 1. Physical interface

The BC125AT is a USB CDC (Communications Device Class) device using a
**Silicon Labs CP210x USB↔UART bridge** internally — according to the
decompiled Sentinel app. **This does not match our hardware**, which
enumerates as Uniden CDC-ACM direct (`0x1965:0x0017`). See
[`SCANNER_PROTOCOL_REFERENCE.md`](SCANNER_PROTOCOL_REFERENCE.md) §1.

| Attribute | Value (per reference) |
| --- | --- |
| USB Vendor ID | `0x10C4` (Silicon Labs) |
| USB Product ID | `0xEA60` (CP210x UART Bridge) |
| Connector on radio | Mini-USB |
| Host appearance | Virtual COM port / character device |

### Per-OS device path

| OS | Default path |
| --- | --- |
| macOS 10.13+ | `/dev/cu.usbserial-XXXX` (built-in `AppleUSBCDCACMData` driver — **no Silicon Labs kext needed**) |
| Older macOS with Silicon Labs kext | `/dev/cu.SLAB_USBtoUART` (legacy; the kext is end-of-life and unsigned for Apple Silicon — avoid) |
| Linux | `/dev/ttyUSB0` (user must be in `dialout` group) |
| Windows | `COMx` (CP210x driver from Silicon Labs) |

### Device discovery

Filter by USB VID:PID `0x10C4:0xEA60`. Globbing `/dev/cu.*` on macOS will match
Bluetooth modems and unrelated USB-serial dongles — don't rely on path patterns
alone.

Sentinel's port enumeration explicitly filters out `COM1` on Windows
([Remote.cs:56](reversed/source/Uniden.Scaner.SS/Remote.cs)) — a Windows-only
heuristic; do not replicate on other platforms.

---

## 2. Serial port settings

Both Sentinel and Scan125 use identical settings.

| Parameter | Value |
| --- | --- |
| Baud rate | **115200** |
| Data bits | 8 |
| Parity | None |
| Stop bits | 1 |
| Flow control | None |
| RTS | disabled (false) |
| DTR | disabled (false) |
| Line terminator | `\r` (CR, `0x0D`) — **not** CRLF |
| Character encoding | ASCII (7-bit) |
| Read buffer | 32 KB (Sentinel) |
| Write buffer | 8 KB (Sentinel) |
| Read timeout | 500 ms typical, 5000 ms for slow ops, 30 000 ms for `CLR` |
| Write timeout | 500 ms typical, 5000 ms for slow ops |

Source: [Remote.cs:18–39](reversed/source/Uniden.Scaner.SS/Remote.cs),
[FormMain.cs:10348–10358](../Scan125_V3910/reversed/FormMain.cs).

---

## 3. Wire format

Half-duplex ASCII line protocol. The host writes one line; the scanner writes
one line back. No streaming, no unsolicited messages.

### Request

```
COMMAND[,arg1,arg2,...]\r
```

- `COMMAND` is a 3-letter uppercase mnemonic.
- Arguments are comma-separated, ASCII.
- Line is terminated by a single `\r` (carriage return).

### Response

One of:

| Form | Meaning |
| --- | --- |
| `COMMAND,OK\r` | Write succeeded. |
| `COMMAND,ERR\r` | Bad parameters, out-of-range value, or syntactic error. |
| `COMMAND,NG\r` | "Not Good" — command not allowed in current mode (e.g. trying to write a channel outside `PRG` mode). |
| `COMMAND,arg1,arg2,...\r` | Query response with data fields. |
| `COMMAND,-1\r` | Iterator-style "no more data" sentinel (used by `GLF`). |

The first field always echoes the command name. Parse responses by splitting on
`,`.

### Error handling

Sentinel's transport layer retries every write twice before raising
([Remote.cs:90–122](reversed/source/Uniden.Scaner.SS/Remote.cs)). On a failed
write, it reads the response code and maps:

- `ERR` → `RemoteErrorResponse` exception
- `NG` → `RemoteNgResponse` exception
- Anything else (or response too short) → `RemoteInvalidResponse` exception

Suggested client behaviour: retry up to 2× on timeout, do not retry on `ERR` /
`NG` (those are deterministic — retrying produces the same error).

---

## 4. Operating modes & state machine

The radio has two modes:

```
            ┌────────────────────────────────────────────────────┐
            │  RUN MODE (default after power-on)                 │
            │                                                    │
            │  Radio scans/searches normally.                    │
            │  Allowed: MDL, VER, STS, GLG, PWR, KEY,            │
            │           VOL, SQL, BLT, KBP, CNT, WXS, ...        │
            │  Live setting changes are visible immediately.     │
            └─────────┬──────────────────────────────────▲───────┘
                      │  PRG                          │  EPG
                      ▼                               │
            ┌────────────────────────────────────────────────────┐
            │  PROGRAMMING MODE                                  │
            │                                                    │
            │  Radio LCD shows "Remote Mode". UI frozen.         │
            │  Required for: CLR, CIN, SCG, CSP, CSG, SSG,       │
            │                SCO, LOF, ULF, GLF, CLC, BPL, PRI   │
            │  Settings written here persist after EPG.          │
            └────────────────────────────────────────────────────┘
```

- `PRG` enters programming mode and returns `PRG,OK`.
- `EPG` exits programming mode and returns `EPG,OK`.
- Sending a programming-only command in run mode returns `NG`.
- **Always send `EPG` before disconnecting**, or the radio stays in Remote Mode
  until power-cycled.

A robust client should treat the PRG/EPG pair as a transaction (RAII guard,
`try/finally`, etc.) so EPG is always sent even on error paths.

---

## 5. Complete command catalog

All commands are 3 ASCII characters. Arguments are listed in order. `[arg]`
means the argument is omitted to query; supplied to set.

### 5.1 Identification & live status (run mode)

| Cmd | Args | Response | Description |
| --- | --- | --- | --- |
| `MDL` | — | `MDL,BC125AT` | Model probe. Used to confirm the right device is connected before doing anything else. |
| `VER` | — | `VER,Version 1.06.06` | Firmware version string. |
| `STS` | — | `STS,<dsp_form>,<line1>,<line1_color>,<line2>,<line2_color>,...,<sql>,<mut>,<bat>,<wat>,<sig>,...` | Mirror of the radio's LCD plus state flags. Field count is 10 or 14 depending on display mode (4-line vs 6-line). |
| `GLG` | — | `GLG,<freq>,<mod>,<att>,<ctcss_dcs>,<name1>,<name2>,<name3>,<sql>,<mut>,...` | Current reception info: tuned frequency, modulation, attenuator state, decoded tone code, channel name (3 fields), squelch open/closed, mute state. |
| `PWR` | — | `PWR,<rssi>,<freq>` | RSSI (0–999) at current frequency. Used for signal-strength meter / spectrum display. |
| `KEY` | `<key>,<mode>` | `KEY,OK` | Virtual keypress. See §5.7 for key codes. |

### 5.2 Mode control

| Cmd | Args | Response | Description |
| --- | --- | --- | --- |
| `PRG` | — | `PRG,OK` | Enter programming mode. |
| `EPG` | — | `EPG,OK` | Exit programming mode. |
| `CLR` | — | `CLR,OK` | **Factory reset** — wipes all memory. Requires 30-second timeout. Use cautiously and only with explicit user confirmation. |

### 5.3 Memory channels (programming mode)

```
CIN,<idx>
  → CIN,<idx>,<name>,<freq>,<mod>,<ctcss>,<lockout>,<delay>,<priority>

CIN,<idx>,<name>,<freq>,<mod>,<ctcss>,<delay>,<lockout>,<priority>
  → CIN,OK
```

| Field | Type | Notes |
| --- | --- | --- |
| `idx` | 1–500 | Channels 1–50 = bank 1, 51–100 = bank 2, … 451–500 = bank 10. |
| `name` | string, ≤16 chars | Restricted alphabet (§6.3). Empty allowed. |
| `freq` | 8 digits | 100 Hz units, zero-padded (§6.1). |
| `mod` | `AUTO` \| `AM` \| `NFM` \| `FM` | Modulation. |
| `ctcss` | 0–231 | CTCSS/DCS code (§7.2). |
| `lockout` | `0` \| `1` | 0 = active, 1 = locked out. |
| `delay` | `-10`, `-5`, `0`, `1`, `2`, `3`, `4`, `5` | Seconds (§7.3). Negative values are pre-recording windows. |
| `priority` | `0` \| `1` | 0 = normal, 1 = priority channel. |

> **Field order on write vs read is reportedly not identical**, per
> Sentinel's source ([hpdbCFrequency.cs:17–21](reversed/source/Uniden.Scaner.SS/hpdbCFrequency.cs)):
> on read the radio returns `..., ctcss, lockout, delay, priority` but on
> write Sentinel sends `..., ctcss, delay, lockout, priority`.
>
> **This does not match our captures.** Firmware 1.06.06 on our unit reads
> back `..., ctcss, delay, lockout, priority` — the same order as the
> reference's write side. We've never tested the write side. See
> [`SCANNER_PROTOCOL_REFERENCE.md`](SCANNER_PROTOCOL_REFERENCE.md) §4 for
> the open question.

### 5.4 Bank lockouts (programming mode)

```
SCG
  → SCG,<10-char mask>

SCG,<10-char mask>
  → SCG,OK
```

Mask is 10 chars of `'0'` / `'1'`, left-to-right = banks 1..10.
`'1'` = locked out (bank skipped during scan), `'0'` = active.

### 5.5 Custom search (programming mode)

```
CSP,<idx>
  → CSP,<idx>,<lower>,<upper>

CSP,<idx>,<lower>,<upper>
  → CSP,OK

CSG / CSG,<10-char mask>      → custom-search avoid mask
```

- `idx`: 1–10 (10 custom-search ranges).
- `lower`, `upper`: 8-digit frequencies (100 Hz units).
- `CSG` mask: `'1'` = avoid (skip during custom search).

Default custom-search ranges (used when memory is cleared) — from
[DbCustomSearch.cs:14–26](reversed/source/BC125AT_SS/DbCustomSearch.cs):

| # | Lower (MHz) | Upper (MHz) | Typical use |
| --- | --- | --- | --- |
| 1 | 25.0000 | 27.9950 | CB / 11m |
| 2 | 28.0000 | 29.6950 | 10m amateur |
| 3 | 29.7000 | 49.9950 | VHF Low |
| 4 | 50.0000 | 54.0000 | 6m amateur |
| 5 | 108.0000 | 136.9916 | AIR band |
| 6 | 137.0000 | 143.9950 | Mil/sat |
| 7 | 144.0000 | 147.9950 | 2m amateur |
| 8 | 225.0000 | 380.0000 | Mil air |
| 9 | 400.0000 | 449.9937 | 70cm amateur |
| 10 | 450.0000 | 469.9937 | UHF business / GMRS |

### 5.6 Service search (programming mode)

```
SSG
  → SSG,<10-char mask>

SSG,<10-char mask>
  → SSG,OK
```

Mask is 10 chars, fixed service order — from
[DbServiceSearch.cs:13](reversed/source/Uniden.Scaner.SS/DbServiceSearch.cs):

| Position | Service |
| --- | --- |
| 1 | Police |
| 2 | Fire / Emergency |
| 3 | HAM Radio |
| 4 | Marine |
| 5 | Railroad |
| 6 | Civil Air |
| 7 | Military Air |
| 8 | CB Radio |
| 9 | FRS / GMRS / MURS |
| 10 | Racing |

`'1'` = avoid, `'0'` = include.

### 5.7 Search options (programming mode)

```
SCO
  → SCO,<delay>,<ctcss_dcs_search>

SCO,<delay>,<ctcss_dcs_search>
  → SCO,OK
```

- `delay`: same set as channel delay (`-10`, `-5`, `0`, `1`, `2`, `3`, `4`, `5`).
- `ctcss_dcs_search`: `0` (off) or `1` (on) — whether the scanner identifies
  tones during search.

### 5.8 Global lockouts (programming mode)

Streaming/iterator-style — not indexed.

```
LOF,<freq>           → ADD a frequency to the lockout list
  → LOF,OK

ULF,<freq>           → REMOVE a frequency
  → ULF,OK

GLF                  → read NEXT lockout (advances internal cursor)
  → GLF,<freq>       valid entry
  → GLF,-1           end of list — stop iterating
```

- `freq` is the 8-digit 100 Hz-unit encoding.
- Maximum 100 entries.
- To read all lockouts: call `GLF` repeatedly until you receive `-1`.
- To replace the entire list: enumerate existing with `GLF`, send `ULF` for each
  to clear, then `LOF` for each new entry.

Source: [DbSearchLockoutList.cs:108–144](reversed/source/Uniden.Scaner.SS/DbSearchLockoutList.cs).

### 5.9 Close Call (programming mode)

```
CLC
  → CLC,<mode>,<alert_tone>,<alert_light>,<5-char band mask>,<hit_scan>

CLC,<mode>,<alert_tone>,<alert_light>,<band_mask>,<hit_scan>
  → CLC,OK
```

| Field | Values | Description |
| --- | --- | --- |
| `mode` | `0` Off, `1` Priority, `2` DND | Close Call operating mode. |
| `alert_tone` | tone code (see §7.7) | Audible alert pattern when a hit occurs. |
| `alert_light` | light pattern code (see §7.7) | LED alert pattern. |
| `band_mask` | 5-char mask | Which bands Close Call monitors. |
| `hit_scan` | `0` \| `1` | Whether to scan after a Close Call hit. |

Close Call band mask order (5 chars, `'1'` = monitor):

| Position | Band |
| --- | --- |
| 1 | VHF Low (25–54 MHz) |
| 2 | AIR (108–137 MHz) |
| 3 | VHF High (137–174 MHz) |
| 4 | UHF (400–512 MHz) |
| 5 | 800 MHz (806–956 MHz, BC125AT range allowing) |

### 5.10 Global options

Most can be read/written in run mode for live UI control. Sentinel always
writes them inside PRG mode for atomicity.

| Cmd | Args | Mode required | Notes |
| --- | --- | --- | --- |
| `BLT` | `<mode>` | either | Backlight, see §7.4. |
| `BSV` | `<hours>` | either | Battery charge hours, 1–14. |
| `KBP` | `<beep>,<keylock>` | either | **Two args.** `beep`: `0` = on, `99` = off. `keylock`: `0` or `1`. |
| `CNT` | `<level>` | either | LCD contrast, 1–15. |
| `VOL` | `<level>` | either | Volume, 0–15. Works in real time. |
| `SQL` | `<level>` | either | Squelch threshold, 0–15. Works in real time. |
| `PRI` | `<mode>` | PRG | Priority scan mode, see §7.5. |
| `WXS` | `<mode>` | either | Weather priority, `0` / `1`. |
| `BPL` | `<region>` | PRG | Band plan, `0` USA / `1` Canada. **Sentinel sends without response check** — fire-and-forget. |

Response is `<CMD>,OK` for writes, `<CMD>,<value>` for queries.

### 5.11 KEY command — virtual keypress

```
KEY,<key>,<mode>
  → KEY,OK
```

#### Key codes

Compiled from [FormMain.cs:14617, 14648, 14679, 14776, 14794, 16050–16086, 16094–16664, 17017, 18534–18569](../Scan125_V3910/reversed/FormMain.cs):

| Code | Button on radio |
| --- | --- |
| `0`–`9` | Numeric keypad |
| `.` or `L` | `.` / Lockout |
| `E` | Enter / `E` |
| `M` | Menu |
| `F` | Function |
| `H` | Hold / Resume |
| `S` | Scan |
| `R` | Range / Search (also "Custom Search") |
| `<` | Left arrow (`◄`) |
| `>` | Right arrow (`►`) |
| `^` | Up arrow (`▲`) |
| `V` | Down arrow (`▼`) |
| `P` | Power |

#### Mode codes

| Code | Meaning |
| --- | --- |
| `P` | Press (momentary tap) |
| `H` | Hold (long press) |
| `R` | Release (used in long-press sequences) |

#### Compound actions

- Start Scan: `KEY,S,P`
- Start Custom Search: `KEY,R,P`
- Start Service Search: `KEY,F,P` then `KEY,R,P`
- Hold (pause scan): `KEY,H,P`
- Toggle bank 1 while scanning: `KEY,1,P`
- Function + 9: `KEY,F,P` then `KEY,9,P`
- Long-press lockout: `KEY,L,P` (some firmwares require `H` mode)

---

## 6. Data encodings

### 6.1 Frequency

Frequencies are transmitted as 8 ASCII digits, zero-padded, **in units of
100 Hz**.

```
wire = floor(hz / 100), then zero-pad to 8 chars
hz   = int(wire) * 100
```

| Frequency | Wire encoding |
| --- | --- |
| 25.000 MHz | `00250000` |
| 154.4500 MHz | `01544500` |
| 162.5500 MHz | `01625500` (NOAA weather) |
| 460.0250 MHz | `04600250` |
| 462.5625 MHz | `04625625` (FRS ch1) |
| 469.9937 MHz | `04699937` |

The BC125AT's tunable range is approximately 25 MHz – 512 MHz with documented
gaps. The custom-search default table (§5.5) reflects the allowed sub-ranges
the firmware exposes.

Source: [FrequencyItem.cs:62–77](reversed/source/Uniden.Scaner.SS/FrequencyItem.cs).

### 6.2 CTCSS / DCS codes

Single integer 0–231 encoding both CTCSS tones and DCS codes plus three
sentinel values. Full table in §7.2.

| Code range | Meaning |
| --- | --- |
| `0` | Off (no tone squelch) |
| `64`–`113` | 50 CTCSS tones, 67.0 Hz – 254.1 Hz |
| `127` | Search (scanner identifies tone on received signal) |
| `128`–`231` | 104 DCS codes, D023 – D754 |
| `240` | No Tone (carrier squelch open; reject signals with any sub-audible) |

### 6.3 Channel name alphabet

Maximum 16 characters. Allowed character set, from
[SntlLib.cs:10](reversed/source/Uniden.Scaner.SS/SntlLib.cs):

```
ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz1234567890!@#$%&*()-/<>.? (space)
```

Notable exclusions: underscore `_`, backslash `\`, square brackets `[]`, curly
braces `{}`, colon `:`, semicolon `;`, single/double quotes `'"`, backtick,
tilde `~`, pipe `|`, plus `+`, equals `=`, comma `,` (would break the wire
format), backtick `` ` ``.

Names containing `,` or `\r` will corrupt the line — strip them on input.

### 6.4 Bank / search masks

ASCII strings of `'0'` and `'1'` characters, fixed length:

| Mask | Length | Position 1 = | Position N = |
| --- | --- | --- | --- |
| `SCG` (channel bank lockouts) | 10 | Bank 1 | Bank 10 |
| `CSG` (custom-search avoid) | 10 | Custom range 1 | Custom range 10 |
| `SSG` (service-search avoid) | 10 | Police | Racing |
| `CLC` band mask | 5 | VHF Low | 800 MHz |

In all cases `'1'` = "skip/avoid/locked-out" and `'0'` = "include/active".

### 6.5 ASCII validation

The scanner only accepts printable ASCII (`0x20`–`0x7E`) — see
[SntlLib.cs:12–27](reversed/source/Uniden.Scaner.SS/SntlLib.cs). Anything
outside that range should be rejected client-side before transmission.

---

## 7. Enumerated value tables

All tables are `(file representation, GUI display, wire code)` from
`*List.cs` files in the Sentinel decompile.

### 7.1 Modulation (`mod` field)

| Display | Wire |
| --- | --- |
| Auto | `AUTO` |
| AM | `AM` |
| NFM | `NFM` |
| FM | `FM` |

### 7.2 CTCSS / DCS (`ctcss_dcs` field)

Full table — 157 entries.

**Special values:**

| Display | Wire |
| --- | --- |
| Off | `0` |
| Search | `127` |
| No Tone | `240` |

**CTCSS tones (`64`–`113`):**

| Code | Tone (Hz) | Code | Tone (Hz) | Code | Tone (Hz) |
| --- | --- | --- | --- | --- | --- |
| 64 | 67.0 | 81 | 118.8 | 98 | 183.5 |
| 65 | 69.3 | 82 | 123.0 | 99 | 186.2 |
| 66 | 71.9 | 83 | 127.3 | 100 | 189.9 |
| 67 | 74.4 | 84 | 131.8 | 101 | 192.8 |
| 68 | 77.0 | 85 | 136.5 | 102 | 196.6 |
| 69 | 79.7 | 86 | 141.3 | 103 | 199.5 |
| 70 | 82.5 | 87 | 146.2 | 104 | 203.5 |
| 71 | 85.4 | 88 | 151.4 | 105 | 206.5 |
| 72 | 88.5 | 89 | 156.7 | 106 | 210.7 |
| 73 | 91.5 | 90 | 159.8 | 107 | 218.1 |
| 74 | 94.8 | 91 | 162.2 | 108 | 225.7 |
| 75 | 97.4 | 92 | 165.5 | 109 | 229.1 |
| 76 | 100.0 | 93 | 167.9 | 110 | 233.6 |
| 77 | 103.5 | 94 | 171.3 | 111 | 241.8 |
| 78 | 107.2 | 95 | 173.8 | 112 | 250.3 |
| 79 | 110.9 | 96 | 177.3 | 113 | 254.1 |
| 80 | 114.8 | 97 | 179.9 | | |

> Note: this table is authoritative and `protocol::tones` matches it
> exactly (fixed in #130). An earlier Bearpaw table omitted 69.3 Hz,
> shifted codes 65–113 by one slot, and wrongly treated 78/79/94/95 as
> "reserved" — they are real tones (107.2, 110.9, 171.3, 173.8 Hz).

**DCS codes (`128`–`231`):**

| Code | DCS | Code | DCS | Code | DCS | Code | DCS |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 128 | 023 | 154 | 152 | 180 | 311 | 206 | 466 |
| 129 | 025 | 155 | 155 | 181 | 315 | 207 | 503 |
| 130 | 026 | 156 | 156 | 182 | 325 | 208 | 506 |
| 131 | 031 | 157 | 162 | 183 | 331 | 209 | 516 |
| 132 | 032 | 158 | 165 | 184 | 332 | 210 | 523 |
| 133 | 036 | 159 | 172 | 185 | 343 | 211 | 526 |
| 134 | 043 | 160 | 174 | 186 | 346 | 212 | 532 |
| 135 | 047 | 161 | 205 | 187 | 351 | 213 | 546 |
| 136 | 051 | 162 | 212 | 188 | 356 | 214 | 565 |
| 137 | 053 | 163 | 223 | 189 | 364 | 215 | 606 |
| 138 | 054 | 164 | 225 | 190 | 365 | 216 | 612 |
| 139 | 065 | 165 | 226 | 191 | 371 | 217 | 624 |
| 140 | 071 | 166 | 243 | 192 | 411 | 218 | 627 |
| 141 | 072 | 167 | 244 | 193 | 412 | 219 | 631 |
| 142 | 073 | 168 | 245 | 194 | 413 | 220 | 632 |
| 143 | 074 | 169 | 246 | 195 | 423 | 221 | 654 |
| 144 | 114 | 170 | 251 | 196 | 431 | 222 | 662 |
| 145 | 115 | 171 | 252 | 197 | 432 | 223 | 664 |
| 146 | 116 | 172 | 255 | 198 | 445 | 224 | 703 |
| 147 | 122 | 173 | 261 | 199 | 446 | 225 | 712 |
| 148 | 125 | 174 | 263 | 200 | 452 | 226 | 723 |
| 149 | 131 | 175 | 265 | 201 | 454 | 227 | 731 |
| 150 | 132 | 176 | 266 | 202 | 455 | 228 | 732 |
| 151 | 134 | 177 | 271 | 203 | 462 | 229 | 734 |
| 152 | 143 | 178 | 274 | 204 | 464 | 230 | 743 |
| 153 | 145 | 179 | 306 | 205 | 465 | 231 | 754 |

### 7.3 Delay (channel delay & search delay)

| Display | Wire |
| --- | --- |
| -10 sec | `-10` |
| -5 sec | `-5` |
| 0 sec | `0` |
| 1 sec | `1` |
| 2 sec | `2` |
| 3 sec | `3` |
| 4 sec | `4` |
| 5 sec | `5` |

Negative values are pre-recording delays (the scanner backs up the audio
buffer when a hit occurs).

### 7.4 Backlight (`BLT`)

| Display | Wire |
| --- | --- |
| Always Off | `AF` |
| Always On | `AO` |
| On with Squelch | `SQ` |
| On with Keypress | `KY` |
| Keypress + Squelch | `KS` |

### 7.5 Priority scan mode (`PRI`)

| Display | Wire |
| --- | --- |
| Priority Off | `0` |
| Priority Scan (on) | `1` |
| Priority Plus | `2` |
| Priority DND | `3` |

### 7.6 Close Call mode (`CLC` `<mode>` field)

| Display | Wire |
| --- | --- |
| Off | `0` |
| Priority | `1` |
| DND | `2` |

### 7.7 Key Beep (`KBP` `<beep>` field)

| Display | Wire |
| --- | --- |
| On (Auto level) | `0` |
| Off | `99` |

### 7.8 Battery charge time (`BSV`)

`1`–`14` (hours). 12-character zero-padded NiMH charge schedule.

### 7.9 LCD contrast (`CNT`)

`1`–`15`.

### 7.10 Volume (`VOL`)

`0`–`15`.

### 7.11 Squelch (`SQL`)

`0`–`15`. `0` = open.

### 7.12 Band plan (`BPL`)

| Display | Wire |
| --- | --- |
| USA | `0` |
| Canada | `1` |

### 7.13 On/Off binary (`WXS`, `KBP` keylock, `CTCSS/DCS Search`)

| Display | Wire |
| --- | --- |
| Off | `0` |
| On | `1` |

### 7.14 Lockout (channel `lockout` field)

| Display | Wire |
| --- | --- |
| Active | `0` |
| Locked Out | `1` |

### 7.15 Bank status (custom search `BankStatus`)

| Display | Wire |
| --- | --- |
| L/O | `1` |
| – | `0` |

---

## 8. Programming session — write to radio

Exactly the sequence Sentinel emits when uploading a fresh configuration.
Source: [Database.cs:99–116](reversed/source/Uniden.Scaner.SS/Database.cs) plus
each `Db*.cs` and `hpdb*.cs` class's `WriteToTarget` method.

```text
→ MDL
← MDL,BC125AT                            # verify model

→ VER
← VER,Version 1.06.06                    # log firmware

→ PRG
← PRG,OK                                 # enter programming mode

→ CLR                                    # optional — wipes memory (30 s timeout)
← CLR,OK

# --- global options ---
→ BPL,0                                  # USA band plan (no response check)
→ BLT,AO                                 # backlight: always on
← BLT,OK
→ BSV,2                                  # 2-hour battery charge
← BSV,OK
→ KBP,0,0                                # key beep on, keylock off
← KBP,OK
→ CNT,8                                  # contrast 8
← CNT,OK
→ VOL,10
← VOL,OK
→ SQL,3
← SQL,OK
→ PRI,1                                  # priority scan on
← PRI,OK
→ WXS,0                                  # weather priority off
← WXS,OK

# --- service search ---
→ SSG,0000000000                         # don't avoid any service
← SSG,OK

# --- custom search ---
→ CSP,1,00250000,00279950
← CSP,OK
→ CSP,2,00280000,00296950
← CSP,OK
... CSP 3..10 ...
→ CSG,1111111111                         # which custom ranges to avoid
← CSG,OK

# --- close call ---
→ CLC,1,1,1,11111,1                      # priority mode, all bands, hit-scan on
← CLC,OK

# --- general search options ---
→ SCO,2,1                                # 2 s delay, tone search on
← SCO,OK

# --- global lockouts (one LOF per frequency, up to 100) ---
→ LOF,01625500
← LOF,OK
→ LOF,01625250
← LOF,OK
...

# --- bank lockouts ---
→ SCG,0000000000                         # all banks active
← SCG,OK

# --- 500 channels ---
→ CIN,1,WX1 KC Pri,01624000,FM,0,2,0,0
← CIN,OK
→ CIN,2,...
... CIN 3..500 ...

→ EPG
← EPG,OK
```

Total round-trip time at 115200 baud is dominated by per-command latency
(~30–60 ms each); a full 500-channel write takes 25–45 seconds.

### Diff-based writes

For an interactive editor, prefer reading the radio state first, computing a
diff, and writing only changed records. This drops a typical "change three
channels" operation from 30 s to under 1 s.

---

## 9. Programming session — read from radio

```text
→ PRG
← PRG,OK

→ MDL → VER
→ BPL → BLT → BSV → KBP → CNT → VOL → SQL → PRI → WXS
→ SSG → CSG → SCG
→ CSP,1 → CSP,2 → ... → CSP,10
→ SCO
→ CLC

# global lockouts — iterate until -1
→ GLF
← GLF,01625500
→ GLF
← GLF,01625250
→ GLF
← GLF,-1                                 # done

# all 500 channels
→ CIN,1 → CIN,2 → ... → CIN,500

→ EPG
← EPG,OK
```

A complete read takes 8–12 seconds.

---

## 10. Live remote control

No `PRG` required. Suitable for a "virtual scanner" UI with real-time display
mirroring and keypad emulation.

### Polling loop (10 Hz typical)

```text
loop every 100 ms:
  → STS                  # mirror the LCD
  → GLG                  # current freq / mod / tone / channel name
  → PWR                  # signal strength
```

### User interaction

```text
on user clicks "Scan":         → KEY,S,P
on user clicks "Hold":         → KEY,H,P
on user clicks digit "5":      → KEY,5,P
on user clicks "Function":     → KEY,F,P
on volume slider change:       → VOL,<0..15>
on squelch slider change:      → SQL,<0..15>
on user opens scanner LCD overlay: parse last STS response
```

### Parsing `STS`

Format is positional. From [FormMain.cs:14908–14966](../Scan125_V3910/reversed/FormMain.cs):

```
STS,<dsp_form>,<line1_text>,<line1_color>,<line2_text>,<line2_color>, ...
      ,<sql>,<mut>,<bat>,<wat>,<sig>,<gps>, ...
```

- `dsp_form` encodes the LCD layout (4-line vs 6-line). Field count between
  the first comma and the next is 4 (6-line mode) or 6 (4-line mode).
- Each `lineN_text` is a fixed-width string mirroring one LCD row.
- Each `lineN_color` is a per-character color/attribute string aligned to the
  line text.
- `sql` is squelch state (`'1'` = open, `'0'` = closed).
- `mut` is mute state.
- `bat` is battery low flag.
- `wat` is weather alert flag.
- `sig` is signal-strength bars (0–5).

Total fields is 10 in 4-line display mode or 14 in 6-line mode. A reply with a
different field count indicates a serial-error / corrupt frame — discard and
retry.

> Our firmware 1.06.06 emits 5 leading digits in the DSP_FORM block where the
> reference describes 4, and the total field count differs accordingly. Our
> parser uses tail-anchored field finding (find the status block from the
> end of the response, not the front) to handle this. See
> `SCANNER_PROTOCOL_REFERENCE.md` §3 and the captures in
> `docs/wire_captures/2026-05-21/audit-reconciliation.md` finding 1.

### Parsing `GLG`

Format from [FormMain.cs:15040–15073](../Scan125_V3910/reversed/FormMain.cs)
(reading position 4 for the tone field) and the surrounding `o()` decoder:

```
GLG,<freq>,<mod>,<att>,<ctcss_dcs>,<sys_name>,<grp_name>,<chn_name>,<sql>,<mut>, ...
```

- `freq`: 8-digit 100 Hz units. Empty string means "no current tune".
- `mod`: `AUTO` | `AM` | `NFM` | `FM`.
- `att`: attenuator `0` / `1`.
- `ctcss_dcs`: decoded tone code (§7.2). `0` if no tone or not yet identified.
- `sys_name`, `grp_name`, `chn_name`: text labels (BC125AT only uses the
  channel name field; trunked-radio scanners populate the others).
- `sql`: squelch open `1` / closed `0`.
- `mut`: mute state.

### Parsing `PWR`

```
PWR,<rssi>,<freq>
```

- `rssi`: integer 0–999 (relative; not absolute dBm).
- `freq`: 8-digit current tuned frequency.

---

## 11. Memory model & limits

From [DEFINE.cs](reversed/source/Uniden.Scaner.SS/DEFINE.cs) and observation:

| Resource | Count | Notes |
| --- | --- | --- |
| Scan banks | 10 | Each labeled "Bank 1" .. "Bank 10". |
| Channels per bank | 50 | Banks are logical only — channels are numbered 1..500 globally. |
| Total channels | 500 | `CIN,1` .. `CIN,500`. |
| Custom search ranges | 10 | `CSP,1` .. `CSP,10`. |
| Service search ranges | 10 | Fixed services (§5.6), no edit. |
| Global lockouts | 100 max | Streamed via `LOF` / `GLF` / `ULF`. |
| Channel name length | 16 ASCII chars | Restricted alphabet (§6.3). |
| Custom search range name | 16 chars | Stored only in the file format, not on the radio itself. |

### File format (Sentinel `.hpe`)

Sentinel saves to a tab-delimited text file with one record per line.

```
<RecordTag>\t<field1>\t<field2>\t...\n
```

For a new app, **do not adopt this file format**. JSON or TOML with explicit
unit-bearing types is far better. Sentinel `.hpe` compatibility is only
worthwhile if importing existing user configurations.

Export one from your own scanner via Uniden Sentinel (or Bearpaw's
`GET /api/v1/memory/export/bc125at_ss`) to see the format.

---

## 12. macOS implementation notes

> Bearpaw's own macOS quirks are documented separately in
> `SCANNER_PROTOCOL_REFERENCE.md` §1 and `audit-reconciliation.md`. The
> short version: kernel CDC-ACM does not bind to our hardware revision, so
> we use the `nusb` direct-USB transport configured via `device.usb_vid`
> and `device.usb_pid` in `config.yaml`.

### Detecting the scanner

Filter `IORegistry` for USB devices with VID `0x10C4` and PID `0xEA60` *if
the reference's hardware claim applies*. For our hardware: filter on
`0x1965:0x0017`.

The matching device node will expose `IOCalloutDevice` and `IODialinDevice`
properties giving the `/dev/cu.usbserial-XXXX` and `/dev/tty.usbserial-XXXX`
paths respectively. Use the `cu.` device (callout) — it doesn't honor the
modem-control hangup signals that can stall serial I/O.

A shell sanity check while plugging/unplugging the radio:

```bash
ls /dev/cu.usbserial-*
ioreg -p IOUSB -l -w 0 | grep -A 3 "BC125AT\|CP210\|0xea60"
```

### Driver compatibility

- macOS 10.13 High Sierra and later: built-in driver, works out of the box on
  both Intel and Apple Silicon Macs.
- Do **not** install the legacy Silicon Labs VCP kext on Big Sur+ — it
  conflicts with the built-in driver and Apple no longer signs it on Apple
  Silicon.

### Recommended Rust crates

| Need | Crate |
| --- | --- |
| Serial port | `serialport` (with `tokio-serial` wrapper for async) |
| USB direct | `nusb` or `rusb` |
| App shell | `tauri` |

---

## 13. Existing open-source implementations

These projects already implement the protocol; consult them as reference and
as integration / contribution targets.

| Project | Language | License | Notes |
| --- | --- | --- | --- |
| [rikus--/bc125at-perl](https://github.com/rikus--/bc125at-perl) | Perl | MIT | Clean-room reimplementation. Single best documentation of the protocol outside this file. |
| [CHIRP](https://chirpmyradio.com) (`chirp/drivers/uniden_bc125at.py`) | Python | GPLv3 | Mature, cross-platform, supports many radios. Mac-friendly. |

---

## 14. Source files used

Files referenced in this document, relative to each app's decompile root.

### Sentinel (`BC125AT_SS_V1_03_00/reversed/source/`)

Transport & orchestration:

- `Uniden.Scaner.SS/Remote.cs` — serial port wrapper, request/response framing, retry logic.
- `Uniden.Scaner.SS/Database.cs` — top-level read/write orchestration.
- `Uniden.Scaner.SS/ParamDb_Node.cs` — base class for each settings group; defines write/read sequences.
- `Uniden.Scaner.SS/DEFINE.cs` — memory model constants.
- `Uniden.Scaner.SS/SntlLib.cs` — character validation, alphabet definition.
- `Uniden.Scaner.SS/ParameterTable.cs` — `(file, display, wire)` value mapping struct.

Settings groups (each declares its commands and field order):

- `Uniden.Scaner.SS/DbGlobalOption.cs` — BLT, BSV, KBP, CNT, VOL, SQL, PRI, WXS, BPL
- `Uniden.Scaner.SS/DbCloseCall.cs` — CLC
- `Uniden.Scaner.SS/DbSearchOption.cs` — SCO
- `Uniden.Scaner.SS/DbServiceSearch.cs` — SSG
- `Uniden.Scaner.SS/DbSearchLockoutList.cs` — LOF / ULF / GLF
- `BC125AT_SS/DbCustomSearch.cs`, `BC125AT_SS/ss_CustomBank.cs` — CSP, CSG
- `Uniden.Scaner.SS/ChannelDb.cs`, `Uniden.Scaner.SS/hpdbCFrequency.cs` — CIN, SCG

Field encodings:

- `Uniden.Scaner.SS/FrequencyItem.cs` — frequency wire format
- `Uniden.Scaner.SS/AlphaTagItem.cs` — channel name
- `Uniden.Scaner.SS/CtcssDcsList.cs` — CTCSS / DCS table
- `Uniden.Scaner.SS/ModulationList.cs`, `BacklightList.cs`, `KeyBeepList.cs`,
  `LcdContrastList.cs`, `BandPlanModeList.cs`, `SquelchList.cs`,
  `VolumeList.cs`, `OnOffList.cs`, `CcModeList.cs`, `BankStatusList.cs`,
  `PriorityScantList.cs`, `LockoutList.cs`, `DelayList.cs`,
  `BatteryChargetList.cs` — enumerated value tables.

### Scan125 (`Scan125_V3910/reversed/`)

- `FormMain.cs` — single 24 126-line VB.NET form containing every protocol
  call site.

---

## Appendix A — Quick reference card

```text
Connect:     115200 8N1, no flow control, CR-terminated, ASCII
Probe:       MDL → expect "MDL,BC125AT"

Programming mode:
  Enter:     PRG  → PRG,OK
  Exit:      EPG  → EPG,OK
  Reset:     CLR  → CLR,OK   (30 s timeout, wipes memory)

Channels (PRG):
  Read:      CIN,<1..500>
  Write:     CIN,<idx>,<name>,<freq8>,<mod>,<ctcss>,<delay>,<lockout>,<priority>
  Bank LO:   SCG / SCG,<10-char mask>

Custom search (PRG):
  Read:      CSP,<1..10>
  Write:     CSP,<idx>,<lower8>,<upper8>
  Avoid:     CSG / CSG,<10-char mask>

Service search (PRG):
  Avoid:     SSG / SSG,<10-char mask>
             order: Police Fire Ham Marine Rail CivAir MilAir CB FRS Racing

Search options (PRG):
  SCO / SCO,<delay>,<tone_search>

Global lockouts (PRG):
  Add:       LOF,<freq8>
  Remove:    ULF,<freq8>
  Read next: GLF → GLF,<freq8> or GLF,-1

Close Call (PRG):
  CLC / CLC,<mode>,<tone>,<light>,<5-char band>,<hit_scan>

Globals (either mode):
  BLT,<AF|AO|SQ|KY|KS>     Backlight
  BSV,<1..14>              Charge hours
  KBP,<0|99>,<0|1>         Key beep, key lock
  CNT,<1..15>              LCD contrast
  VOL,<0..15>              Volume
  SQL,<0..15>              Squelch
  PRI,<0|1|2|3>            Priority (Off/On/Plus/DND)
  WXS,<0|1>                Weather priority
  BPL,<0|1>                Band plan (USA/Canada)

Live status (run mode):
  STS    LCD mirror + flags
  GLG    Current freq, mod, tone, channel name
  PWR    RSSI 0–999 + current freq
  KEY,<key>,<P|H|R>   Virtual keypress

Frequency:   8 digits, units of 100 Hz, zero-padded
             162.5500 MHz → "01625500"

CTCSS/DCS:   0=Off  64..113=CTCSS  127=Search  128..231=DCS  240=No Tone
Modulation:  AUTO | AM | NFM | FM
Delay:       -10 | -5 | 0 | 1 | 2 | 3 | 4 | 5  (seconds)
Names:       ≤16 chars, ASCII subset (no comma, underscore, etc.)
Masks:       10-char (banks) or 5-char (CC bands), '1' = skip/avoid
```
