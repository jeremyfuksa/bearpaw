# Live CTCSS/DCS tone display — design

**Date:** 2026-07-08
**Status:** Approved, ready for implementation
**Origin:** `docs/IDEAS.md` "Live tone display" note (surfaced during the 2026-07-02 audit as issue #149 item 9b — `GlgFrame.tone_code` parsed but never surfaced).

## Goal

During an active hit, show the CTCSS/DCS tone the scanner is already decoding, in the Scan display's subText line. This lets a user identify co-channel users by their tone. The tone is a property of the currently-received signal, so it is only meaningful while the squelch is open.

## Non-goals (YAGNI)

- No Recent Hits / activity-log changes. Persisting tone into past hit entries was considered and explicitly deferred — it touches the activity-log data model and the hit-tracking hook, and the value is marginal versus the live display.
- No new UI component or badge. The tone reuses the existing subText line alongside frequency / modulation / channel.
- No tone-decode table in the frontend. The backend owns all protocol knowledge (the project's core client/server principle); the frontend receives decoded fields and formats a label.

## Data path today

The tone is parsed but dropped before it reaches the client:

1. `parse_glg_response` (`protocol/mod.rs`) reads the GLG tone field into `GlgFrame.tone_code: u16` (0–231, 0 = no tone).
2. `livestate_from_frames` (`protocol/mod.rs`) assembles `LiveState` from the GLG/STS/PWR frames — but **ignores `tone_code`**.
3. `LiveState` (`state.rs`) has no tone fields, so nothing is broadcast.

The decoder already exists: `decode_tone(code) -> (ToneSquelchKind, Option<f64>, Option<u16>)` in `protocol/mod.rs` (currently private), returning the kind, CTCSS Hz, and DCS code. It uses the `tones.rs` table corrected in #130. The `ToneSquelchKind` enum (`none`/`ctcss`/`dcs`/`search`) already serializes to the wire via `ChannelData`.

## Design

### Backend (`crates/bearpaw-api/`)

**`state.rs` — extend `LiveState`** with four fields mirroring `ChannelData`'s existing tone shape, plus a pre-formatted DCS label (see "Why a `tone_dcs_label` field" under Frontend):

```rust
#[serde(default)]
pub tone_squelch_kind: ToneSquelchKind,   // none | ctcss | dcs | search
#[serde(skip_serializing_if = "Option::is_none")]
pub tone_squelch: Option<f64>,            // CTCSS frequency in Hz
#[serde(skip_serializing_if = "Option::is_none")]
pub tone_dcs_code: Option<u16>,           // DCS wire code (128–231)
#[serde(skip_serializing_if = "Option::is_none")]
pub tone_dcs_label: Option<String>,       // pre-formatted "DCS NNN" for display
```

Idle frames (kind `none`, all options `None`) stay lean on the wire, and clients that don't read these fields are unaffected.

**`protocol/mod.rs`:**
- Change `decode_tone` from private `fn` to `pub(crate) fn` (no logic change — it is already exactly the decoder needed).
- In `livestate_from_frames`, decode the tone from the GLG frame, **gated on squelch_open**: when the squelch is closed (scanning/idle) the tone is meaningless, so emit `none`/`None` regardless of a stale GLG tone field. When open, decode `glg.tone_code` into the fields, deriving the DCS label from the code.

```rust
let (tone_squelch_kind, tone_squelch, tone_dcs_code) = if squelch_open {
    glg.map(|g| decode_tone(g.tone_code)).unwrap_or_default()
} else {
    Default::default()
};
let tone_dcs_label = tone_dcs_code.and_then(tones::dcs_code_to_label);
```

(`decode_tone` returns the 3-tuple `(kind, Hz, dcs_code)`; the label is derived separately via the already-public `tones::dcs_code_to_label`, so `decode_tone`'s signature is unchanged.)

**`poll.rs` — `broadcast_live_update`:** add the four fields to the `state_update` `data` object. The broadcast emits the full field set every tick (there is no computed diff — the CLAUDE.md "diff" description is aspirational; the frontend's monotonic sequence gate handles ordering), so this is a four-line addition to the existing `json!` block.

### Frontend (`frontend/src/`)

**`types.ts` — extend the `LiveState` interface** with the same four optional fields (`tone_squelch_kind?`, `tone_squelch?`, `tone_dcs_code?`, `tone_dcs_label?`). The `'none' | 'ctcss' | 'dcs' | 'search'` union already exists on `ChannelData`.

**`App.tsx`:**
- Add a pure `formatLiveTone(liveState): string | null` helper:
  - `ctcss` + `tone_squelch` → `"CTCSS " + tone_squelch.toFixed(1)` (e.g. `"CTCSS 100.0"`)
  - `dcs` + `tone_dcs_label` → the label as-is (e.g. `"DCS 023"`)
  - `search` → `"Tone Search"`
  - anything else (`none`, missing fields) → `null`
- In the `mainText`/`subText` memo, push the formatted tone into `parts` when `squelch_open` is true and the helper returns non-null. (The backend already gates on squelch; the frontend check is belt-and-suspenders and keeps the display logic self-contained.)

Resulting subText during a CTCSS hit: `146.850 • FM • CH 12 • CTCSS 100.0`.

**Why a `tone_dcs_label` field (not just the raw code):** the DCS *wire code* (128–231) is not the human DCS *number* (023, 754, …); the mapping lives in `tones.rs::dcs_code_to_number`. Rather than duplicate that table in TypeScript, the backend sends the ready label string via `dcs_code_to_label`. CTCSS needs no equivalent — `tone_squelch` is the Hz value the frontend prints directly. This is why the `LiveState` additions are **four** fields, not three: `tone_squelch_kind`, `tone_squelch`, `tone_dcs_code`, `tone_dcs_label`.

### Tests

**Backend (`protocol/mod.rs` tests):**
- `livestate_from_frames` with a CTCSS GLG frame (tone code 76, squelch open) → `kind=Ctcss, tone_squelch=Some(100.0), tone_dcs_code=None, tone_dcs_label=None`.
- Same frame with squelch **closed** → all tone fields `none`/`None` (the gate).
- A DCS GLG frame (e.g. code 151, squelch open) → `kind=Dcs, tone_dcs_code=Some(151), tone_dcs_label=Some("DCS 134")`.

**Frontend (`App` or a small `formatLiveTone` unit test):**
- CTCSS → `"CTCSS 100.0"`; DCS → `"DCS 023"`; search → `"Tone Search"`; none/absent → `null`.

### Docs

- `docs/WEBSOCKET_SCHEMA.md` `state_update` and `docs/API_SPEC.md` `LiveState`: document the four new fields.
- Remove the "Live tone display" note from `docs/IDEAS.md` (now implemented).

## Risk

Very low. All additions are optional/defaulted fields; no existing consumer behavior changes. Reuses the `decode_tone` / `dcs_code_to_label` paths already unit-tested (and corrected in #130) and the `ToneSquelchKind` enum already in the wire contract.

## Hardware verification

Hold on (or catch a live hit on) a channel with a known CTCSS or DCS tone and confirm the subText shows the matching label. The user's scanner has real programmed channels; a CTCSS hit on a local repeater is the natural test.
