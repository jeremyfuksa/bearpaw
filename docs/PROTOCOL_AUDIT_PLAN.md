# Protocol Audit Remediation Plan

**Status:** Phases 1–4 complete (2026-05-21); Phases 5 and 6 continued in v1.1 (Phase 9); Phase 7 deferred.
**Created:** 2026-05-19
**Last updated:** 2026-05-22
**Source audit:** `docs/compass_artifact_wf-4d260a13-b490-4b4e-830c-010c039981ab_text_markdown.md`
**Updated reference:** [SCANNER_PROTOCOL_REFERENCE.md](SCANNER_PROTOCOL_REFERENCE.md)
**Continuation:** v1.1 picks up the unfinished work as "Phase 9" — see the project plan at `/Users/jeremyfuksa/.claude/plans/snazzy-knitting-meerkat.md` (not committed).

The May 2026 protocol audit identified eight gaps between Bearpaw's Rust implementation and the documented Uniden BC125AT/BCT125AT wire protocol. This plan sequences fixes by **blast radius first, then leverage**: validate the actual wire format before rewriting parsers, fix the load-bearing bugs before adding features, defer plug-and-play polish until correctness is locked.

## Guiding constraints

1. **Validate before rewriting.** A parser written to the wrong spec passing tests written to the same wrong spec proves nothing. Phase 1 captures real wire traffic and pins down which audit findings are real on *our* hardware.
2. **One contract at a time.** REST/WebSocket shapes stay stable. Internal parsers and state derivation change underneath. The frontend should not need a coordinated release.
3. **No new features until the parser is honest.** BearTracker (BCT125AT) support, plug-and-play autodetect, and CTCSS Hz display are blocked behind a correct `LiveState` and `ChannelData`.
4. **Reversible work.** Each phase ships independently. If Phase 2's parser rewrite regresses, Phase 1's captured fixtures let us revert and compare.

---

## Phase 1 — Ground truth (½ day)

**Goal:** Capture real `STS`, `GLG`, `PWR`, and `CIN` responses from the physical BC125AT before changing any code. Decide which audit findings are real and which are doc-level discrepancies.

### Tasks

- [x] **Wire capture script.** Write a small Rust binary (`crates/bearpaw-api/examples/wire_capture.rs`) or shell + `socat` recipe that opens the port at 115200 8N1, drains the input buffer, and issues:
  - `MDL\r`, `VER\r`
  - `STS\r` × 5 (under different signal conditions: scanning idle, scanning during a hit, manual hold)
  - `GLG\r` × 5 (same conditions)
  - `PWR\r` × 3
  - `PRG\r`, `CIN,1\r` … `CIN,5\r`, `EPG\r` (with a known channel programmed)
  - `SCG\r`, `SSG\r`
  - `VOL\r`, `SQL\r`
  Dump raw bytes (with `\r` rendered) and parsed splits to a file under `docs/wire_captures/YYYY-MM-DD/`.
- [x] **Fixture file format.** One `.txt` per command with raw bytes; one `fixtures.json` summarising parsed splits for use in unit tests later.
- [x] **Reconcile against the audit.** For each of the eight gaps in [SCANNER_PROTOCOL_REFERENCE.md §13](SCANNER_PROTOCOL_REFERENCE.md#13-known-correctness-gaps-in-current-bearpaw-code), record one of: `confirmed`, `firmware-variant`, `false-alarm`. Notes in `docs/wire_captures/YYYY-MM-DD/audit-reconciliation.md`.

### Exit criteria

- `docs/wire_captures/YYYY-MM-DD/` exists with at least 30 captured frames covering all command shapes above.
- A short reconciliation note (~½ page) confirms or refutes each audit finding against our actual device.
- Decision recorded: proceed with Phase 2 as written, or scope it down based on findings.

### Why this comes first

If `STS` on our firmware genuinely returns key-value pairs (one possibility — the existing parser had to have come from *somewhere*), the audit's biggest claim is wrong and Phase 2 changes shape entirely. If it returns the documented LCD dump, every assumption in Phase 2 holds. Cost of capturing first: ~15 minutes. Cost of skipping: potentially a half-day rewrite in the wrong direction.

---

## Phase 2 — Honest parsers (1 day)

**Goal:** Replace the `STS`/`GLG`/`CIN` parsers in `crates/bearpaw-api/src/protocol/mod.rs` with implementations that match the captured wire format. Drop dead code.

Depends on: **Phase 1 reconciliation complete.**

### Tasks

#### 2.1 STS parser
- [x] Rename `parse_sts_response` → `parse_sts_lcd_dump` (or delete if Phase 1 shows it's unused).
- [x] New struct `StsFrame { lines: [String; 4], modes: [String; 4], sql: bool, mut_: bool, wat: u8, led_cc: u8, led_alert: u8, sig_lvl: u8, dimmer: u8 }`.
- [x] Parser splits on `,`, handles **empty-collapse** for line-mode fields (`,,` → empty string), bounds-checks every index.
- [x] Returns `Option<StsFrame>` — `None` on truncated or unrecognisable frames so the poll loop can retry rather than crash.

#### 2.2 GLG parser (becomes the live-state source)
- [x] New function `parse_glg_response(&str) -> Option<GlgFrame>`.
- [x] `GlgFrame { frequency_mhz: f64, modulation: String, attenuator: bool, tone_code: u16, names: [String; 3], sql: bool, mut_: bool, channel: Option<u16> }`.
- [x] Frequency: parse 8-digit field, divide by 10_000.
- [x] Tone: keep as **code 0–231**, do not decode here.
- [x] Alpha tag: first non-empty `names[i]` (per audit note that flat memory only uses one).
- [x] Channel: optional trailing field — try parse, accept absence.
- [x] Idle frame (`GLG,,,,,,,,,`) returns `Some(GlgFrame { ..default })` with everything blank, not `None` — caller distinguishes "scanner is idle" from "parse failed".

#### 2.3 PWR parser
- [x] `parse_pwr_response(&str) -> Option<PwrFrame { rssi_raw: u16, frequency_mhz: f64 }>`.
- [x] `rssi_raw` is 0–1023 verbatim; scaling to 0–100 happens at the `LiveState` boundary.

#### 2.4 CIN parser rewrite
- [x] Drop the `has_tone` / `has_bank` heuristic entirely.
- [x] Fixed field order: `CIN, index, name, freq, mod, tone_code, delay, lockout, priority` (8 fields after `CIN`).
- [x] **Remove `bank` from `ChannelData`'s CIN-derived fields.** Bank comes from `SCG` post-sync. (See Phase 4.)
- [x] Keep `tone_squelch` as `Option<u16>` (the code), not `Option<f64>` (Hz). Decode at the API boundary in Phase 3.
- [x] Name field: keep as the wire form (space-padded 16 chars); trim only at the display/API boundary.

#### 2.5 Drop dead code
- [x] Remove the `map["MODE"]` lookup in `livestate_from_sts` — mode is not a wire field and is already tracked in `poll.rs` as `commanded_mode`.
- [x] Remove the `FRQ`/`MOD`/`RSSI`/`CH`/`VOL`/`BAT` key-value path if Phase 1 confirmed it's never populated.

#### 2.6 Tests
- [x] Replace synthetic unit tests in `protocol/mod.rs` with tests driven by `docs/wire_captures/.../fixtures.json`.
- [x] Snapshot tests for each `STS` / `GLG` / `CIN` shape we captured.
- [x] Property test: `GLG` parser is total — never panics on any input.

### Exit criteria

- `cargo test -p bearpaw-api` passes against captured fixtures.
- No `STS`-derived field appears in `LiveState` other than `sig_lvl`-mapped `rssi` and `sql`-mapped `squelch_open`.
- `cargo check --workspace` clean.

---

## Phase 3 — LiveState derivation (½ day)

**Goal:** Make `LiveState` correct by sourcing each field from the right command's parsed frame. Lock down the hit-detection rule against the new (correct) squelch polarity.

Depends on: **Phase 2 parsers landed.**

### Tasks

#### 3.1 Poll loop reshape — `crates/bearpaw-api/src/api/poll.rs`
- [x] Each tick: `STS` → `StsFrame`, `GLG` → `GlgFrame`. (Add `PWR` every Nth tick, see 3.3.)
- [x] Build `LiveState` by combining:
  - `frequency` ← `GlgFrame.frequency_mhz`
  - `modulation` ← `GlgFrame.modulation`
  - `squelch_open` ← `GlgFrame.sql` **OR** `StsFrame.sql` (cross-check; warn-log if they disagree)
  - `rssi` ← `StsFrame.sig_lvl × 20` (maps 0–5 to 0, 20, 40, …, 100), OR `PwrFrame.rssi_raw` if available, else stale
  - `channel` ← `GlgFrame.channel` (firmware permitting)
  - `alpha_tag` ← `GlgFrame.names[*]` first non-empty
  - `mode` ← `commanded_mode` (unchanged)
  - `volume` ← cached from periodic `VOL` query (see 3.4)
  - `battery` ← always `None` on BC125AT family; remove any code paths that try to populate it
- [x] Drop dropped-or-truncated `STS` frames silently and re-poll on next tick. Increment a counter for telemetry.

#### 3.2 Squelch polarity
- [x] Confirm in code comments: `sql == true` means **open** (signal present). This is opposite to the old parser's `SQL == "0"` rule.
- [x] Existing hit-detection (`live.squelch_open && !prev_squelch_open`) is correct *as written* — no change needed once the source field is right.

#### 3.3 PWR pacing
- [x] Poll `PWR` every ~500 ms (every 3rd–5th tick, depending on `STS`+`GLG` cadence). Provides `rssi_raw` for fine-grained signal strength.
- [x] Add a config knob `polling.pwr_interval_ticks` (default 4) so we can disable it if it interferes with `STS`/`GLG` timing.

#### 3.4 VOL caching
- [x] On startup and after explicit volume commands, query `VOL\r` and cache the value into `LiveState.volume`.
- [x] Optional: re-query every ~5 s. The audit notes the value rarely changes outside user action.

#### 3.5 Frontend impact
- [x] **Zero changes expected to REST or WebSocket payload shapes.** `LiveState` JSON keys are stable; values become correct.
- [x] Sanity-check the React store's display logic in [VirtualDisplay.tsx](../frontend/src/components/VirtualDisplay.tsx) — confirm it doesn't depend on the old (broken) rssi 0–100 directly-from-STS path.

### Exit criteria

- Manual test: a real broadcast on a programmed channel produces `squelch_open: true` while held, scanner auto-pauses, and frontend shows the alpha tag and frequency.
- Manual test: during scan idle, `squelch_open: false` consistently, mode stays `SCAN`.
- No warnings in logs about disagreement between `STS.sql` and `GLG.sql`.

---

## Phase 4 — CTCSS decoding and bank derivation (½ day)

**Goal:** Surface tone-squelch in Hz for the UI; populate `ChannelData.bank` correctly from `SCG`.

Depends on: **Phase 2 parsers, Phase 3 LiveState.**

### Tasks

#### 4.1 CTCSS code → Hz table
- [x] New module `protocol/tones.rs` with the full table from [SCANNER_PROTOCOL_REFERENCE.md §7](SCANNER_PROTOCOL_REFERENCE.md#7-ctcss--dcs-tone-codes).
- [x] Functions: `code_to_hz(code: u16) -> Option<ToneSquelch>` and `hz_to_code(hz: f64) -> Option<u16>`.
- [x] `enum ToneSquelch { None, Ctcss(f64), Dcs(u16), Search, NoTone }` — the four meaningful states the wire carries.
- [x] Update `ChannelData` (or add a transport DTO) to expose the rich variant via JSON.

#### 4.2 Bank derivation
- [x] After memory sync completes, issue `SCG\r` once.
- [x] Parse the 10-digit mask (`0` = bank enabled, `1` = disabled — invert when writing).
- [x] For BC125AT's fixed channel-to-bank layout (channel `n` → bank `ceil(n/50)`), populate `ChannelData.bank` for every channel.
- [x] Surface `bank_active` as a separate field on a future `/api/v1/banks` endpoint (out of scope for this plan — keep `ChannelData.bank` as channel→bank, not enabled-state).

#### 4.3 JSON shape
- [x] `ChannelData.tone_squelch` becomes `{ kind: "ctcss" | "dcs" | "search" | "none", hz?: number, code?: number }` (or similar). Coordinate one frontend update for this; this is the only **breaking** payload change in the plan.
- [x] Alternatively, keep `tone_squelch: number | null` (Hz only) and add `tone_squelch_kind: string` to avoid breaking the frontend. Decide once we look at the React components.

### Exit criteria

- `cargo test` covers a representative channel from fixtures with CTCSS 100.0 Hz that round-trips: wire code → Hz in JSON → Hz round-trip.
- `cargo test` covers DCS code with `kind = "dcs"`.
- After a memory sync, every programmed channel shows a sensible `bank` value in `GET /api/v1/memory/channels`.

---

## Phase 5 — Transport hardening (½ day)

**Goal:** Stop asserting DTR on open; harden against the documented BC125AT firmware quirks.

Depends on: **Phase 3** (so the new poll loop sees the more resilient transport).

### Tasks

#### 5.1 Transport open behaviour
- [ ] Remove the unconditional `port.write_data_terminal_ready(true)` in [transport.rs:38-39](../crates/bearpaw-api/src/transport.rs#L38-L39).
- [ ] Add config option `device.assert_dtr_on_open` (default `false`).
- [ ] On Linux/macOS: after open, set raw mode (`tcgetattr` + `cfmakeraw` + `tcsetattr`), or document why the `serialport` crate already handles it.
- [ ] After open: `port.clear(ClearBuffer::Input)` to drain stale bytes before issuing `MDL`.

#### 5.2 `STS` read robustness
- [ ] Keep `send_and_read_multiline` for `STS` (Phase 1 will tell us if `STS` is one-line or multi-line on our firmware; the function name should match reality).
- [ ] Before every command write, call `port.clear(ClearBuffer::Input)` (Python's `reset_input_buffer()` equivalent). One control-tower for buffer hygiene.
- [ ] On truncated `STS` (less than 18 commas after the keyword), drop the frame and increment a counter.

#### 5.3 CLR timeout
- [ ] Add a per-command timeout override mechanism so a future `CLR` op can use 60 s without changing the global default.
- [ ] Document in code that `CLR` is the only command that needs this.

#### 5.4 Mode-transition settle delays
- [ ] After `PRG,OK` and after `EPG,OK`, sleep 100 ms before the next command. Wrap in helpers `enter_program_mode()` / `exit_program_mode()` so the rule lives in one place.

### Exit criteria

- A fresh plug-in on macOS goes from "scanner connected" to first `LiveState` broadcast without warnings about garbage in the input buffer.
- The PRG/EPG bracket helpers exist and are used by the memory sync path.
- Manual test: starting a memory sync immediately after a `KEY,H,P` succeeds (settle delay verified).

---

## Phase 6 — Plug-and-play autodetect (½ day)

**Goal:** Bearpaw finds the scanner without a config-file port path. The MVP UX should be "plug it in, open the app."

Depends on: **Phase 5** (transport open is sane).

### Tasks

- [ ] Enumerate serial ports via `serialport::available_ports()`; filter by `UsbPortInfo.vid == 0x1965`.
- [ ] For each match, open at 115200 8N1, send `MDL\r`, accept the first port that responds with `MDL,<model>` matching `BC125AT|BCT125AT|UBC125XLT|UBC126AT|AE125H`.
- [ ] Cache the USB serial number; on reconnect, prefer the same serial number.
- [ ] Config precedence:
  1. `device.port` in config (explicit override)
  2. Last-seen USB serial number
  3. VID filter + `MDL` probe
- [ ] Surface "no scanner found" as a structured error the frontend can display (alongside the existing `stale: true` mechanism).

### Exit criteria

- With no `device.port` configured, the app finds and connects to a BC125AT on macOS, Linux, and Windows (verify at least macOS in dev; document Linux/Windows manual-test recipes).
- Replugging the scanner reconnects to the same physical unit within the existing reconnect-backoff window.

---

## Phase 7 — BearTracker (BCT125AT) support (½ day, optional)

**Goal:** Add the three BearTracker commands. Cheap protocol coverage; opens the door to BCT125AT users.

Depends on: **Phase 6** (autodetect already branches on `MDL`).

### Tasks

- [ ] Detect `MDL == "BCT125AT"` and set a `device_capabilities` flag on `DeviceInfo`.
- [ ] Implement `STT,<state>` (set BearTracker state).
- [ ] Implement `BTL,POL,DOT,HP,BT` (per-category lockouts).
- [ ] Implement `BTS,…` (BearTracker options block) — readonly for v1, settable later.
- [ ] REST: `GET/PUT /api/v1/beartracker/state`, `GET/PUT /api/v1/beartracker/lockouts`, `GET /api/v1/beartracker/options`.
- [ ] Empirically discover the BearTracker key code via `KEY` sweep + `STS` observation. Document the result in [SCANNER_PROTOCOL_REFERENCE.md §5](SCANNER_PROTOCOL_REFERENCE.md#5-beartracker-commands-bct125at).
- [ ] Hide the BearTracker endpoints from the frontend when `MDL != BCT125AT`.

### Exit criteria

- A user with a BCT125AT can switch state via the API and see the new state reflected on the LCD.
- The BC125AT user sees no BearTracker UI affordances and gets `404` / capability error from the BT endpoints.

---

## What's explicitly out of scope

These came up in the audit notes but don't belong in this plan:

- **Channel write support** (`CIN` writes). Future work. The "empty field = unchanged" footgun is documented in the protocol reference; will need its own design pass.
- **`CLR` factory reset.** Dangerous; gate behind explicit user confirmation in a future "danger zone" settings panel.
- **DCS Hz mapping.** The wire carries DCS codes; we surface the code but don't translate to the formal Hz representation (DCS isn't a tone in the CTCSS sense). Display the code; users who care will recognise it.
- **Lockout list management** (`GLF`/`LOF`/`ULF`). Useful for permanent lockouts; future feature.
- **`CLC` Close Call.** The audit notes the band-bit ordering changed between protocol PDF revisions and needs empirical verification. Not worth the verification cost until we have a user asking for it.
- **HF / aviation AM tweaks.** BC125AT/BCT125AT already support AM mode; nothing protocol-level is missing.
- **Pi Zero 2W / rtl_airband port.** That research lives in `docs/archive/` (when re-archived) and is a separate product hypothesis, not this product.

---

## Effort summary

| Phase | Effort | Blocks |
|---|---|---|
| 1. Ground truth | ½ day | All others |
| 2. Honest parsers | 1 day | 3, 4 |
| 3. LiveState derivation | ½ day | 4, 5 |
| 4. CTCSS + bank | ½ day | — |
| 5. Transport hardening | ½ day | 6 |
| 6. Plug-and-play autodetect | ½ day | 7 |
| 7. BearTracker (optional) | ½ day | — |
| **Total (1–6)** | **3 days** | |
| **Total with BCT125AT** | **3½ days** | |

Realistic schedule with normal interruptions: one focused week. Phase 1 should happen as soon as a BC125AT is plugged in — until that runs, everything downstream is guesswork.

---

## Success criteria for the whole plan

- The eight findings in [SCANNER_PROTOCOL_REFERENCE.md §13](SCANNER_PROTOCOL_REFERENCE.md#13-known-correctness-gaps-in-current-bearpaw-code) are either fixed in code or downgraded to "false alarm" with a Phase 1 capture as evidence.
- A user plugs in a BC125AT on macOS, opens Bearpaw, and within 10 seconds sees: device info populated, scan mode active, accurate frequency/RSSI/alpha tag during a hit.
- A memory sync produces channels whose CTCSS tones (in Hz) match the values configured on the physical scanner.
- `cargo test -p bearpaw-api` covers each `STS` / `GLG` / `CIN` shape we captured in Phase 1.
- The Rust crate has zero references to a non-existent `MODE` field, zero `SQL == "0"` polarity checks, and zero `bank` extracted from `CIN`.

---

## Phase 9 (v1.1) continuation

After v1.0.0 shipped (2026-05-22, hardware-verified), a fresh decompile of the Uniden Sentinel + Scan125 apps surfaced as `BC125AT_PROTOCOL.md`. Triage in the v1.1 plan revealed that:

- Phases 1–4 of this document are silently complete (this PR retroactively ticks the boxes).
- Phase 5 (transport hardening) is partly done in spirit but the load-bearing fixes (DTR=true, ERR/NG handling, settle delays, input-buffer drain) were never landed. Picked up as v1.1 PRs 2–4, 7, 8.
- Phase 6 (plug-and-play autodetect) picked up as v1.1 PR-11 (optional).
- Phase 7 (BearTracker / BCT125AT) stays deferred — no user demand.

The Phase 5/6 task boxes above remain unticked here on purpose. They'll be ticked as v1.1 PRs land.
