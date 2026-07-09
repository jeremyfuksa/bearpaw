# Live CTCSS/DCS Tone Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** During an active scan hit, show the CTCSS/DCS tone the scanner is already decoding in the Scan display's subText line (e.g. `146.850 • FM • CH 12 • CTCSS 100.0`).

**Architecture:** Pure plumbing of an already-decoded value the last mile: the GLG frame's `tone_code` is already parsed into `GlgFrame.tone_code` but dropped at `livestate_from_frames`. Decode it (gated on `squelch_open`) into four new `LiveState` fields, broadcast them over the existing `state_update` WebSocket message, and render a formatted label in the frontend's subText memo. No new protocol logic, no new tone tables — the `decode_tone` and `tones::dcs_code_to_label` paths already exist and are unit-tested (corrected in #130).

**Tech Stack:** Rust (Axum backend, `serde` JSON, `cargo test`), React + TypeScript (Vite, Vitest).

## Global Constraints

- Line terminator on the wire is `\r`, never `\r\n`. (Not touched by this plan — no new wire commands.)
- `SQL=1` / `squelch_open=true` means signal PRESENT. The tone is only meaningful while squelch is open.
- Bearpaw is strictly client/server: the backend owns ALL protocol knowledge. The frontend receives decoded fields and formats labels — no tone-decode table in TypeScript.
- Every PR: < 250 LOC, all four CI checks green locally before push, one concern, independently revertible. (This whole feature is one concern and lands as one branch `feat/live-tone-display`.)
- CI checks (run all locally before any push): `cargo test -p bearpaw-api --lib`, `cargo check -p bearpaw-api`, `npm run lint`, `npm run type-check`, `npm test -- --run`, `npx prettier --check .` (from `frontend/`).
- No `Co-Authored-By` trailer in this repo. Commit messages use HEREDOC multi-line form: tag line, blank line, wrapped why-paragraph.
- Branch is `feat/live-tone-display` (already created and checked out; spec already committed there).

---

## File Structure

**Backend (`crates/bearpaw-api/`):**
- `src/state.rs` — add four fields to the `LiveState` struct (mirrors `ChannelData`'s tone shape).
- `src/protocol/mod.rs` — make `decode_tone` `pub(crate)`; decode tone in `livestate_from_frames` gated on `squelch_open`; add three backend tests.
- `src/api/poll.rs` — add the four fields to the `broadcast_live_update` `state_update` `data` block.

**Frontend (`frontend/src/`):**
- `types.ts` — add four optional fields to the `LiveState` interface.
- `app/App.tsx` — add a module-level `formatLiveTone` pure helper; push its output into the subText `parts` array when `squelch_open`.
- `app/__tests__/formatLiveTone.test.ts` — new unit test file for the pure helper.

**Docs:**
- `docs/WEBSOCKET_SCHEMA.md`, `docs/API_SPEC.md` — document the four new fields.
- `docs/IDEAS.md` — remove the now-implemented "Live tone display" note.

---

## Task 1: Backend — extend LiveState and decode the tone

**Files:**
- Modify: `crates/bearpaw-api/src/state.rs:58-73` (the `LiveState` struct)
- Modify: `crates/bearpaw-api/src/protocol/mod.rs:507` (`decode_tone` visibility), `:583-596` (struct literal in `livestate_from_frames`)
- Test: `crates/bearpaw-api/src/protocol/mod.rs` (the existing `#[cfg(test)] mod tests` block, starting ~line 601)

**Interfaces:**
- Consumes: `decode_tone(code: u16) -> (ToneSquelchKind, Option<f64>, Option<u16>)` (existing, `protocol/mod.rs:507`); `tones::dcs_code_to_label(code: u16) -> Option<String>` (existing, `pub`, `tones.rs:99`); `GlgFrame.tone_code: u16` (existing, `protocol/mod.rs:246`); `ToneSquelchKind` enum (existing, `state.rs:100`, already imported into `protocol/mod.rs`).
- Produces: `LiveState` gains public fields `tone_squelch_kind: ToneSquelchKind`, `tone_squelch: Option<f64>`, `tone_dcs_code: Option<u16>`, `tone_dcs_label: Option<String>`. `decode_tone` becomes `pub(crate)`. Task 2 (poll.rs) reads these fields; Frontend Task 4 mirrors them over the wire.

- [ ] **Step 1: Write the failing tests**

Add these three tests inside the existing `#[cfg(test)] mod tests` block in `crates/bearpaw-api/src/protocol/mod.rs` (append after the last existing test, before the closing `}` of the module). They build GLG frames with known tone codes and assert the decoded `LiveState` fields.

Note on fixtures: the existing `GLG_SIGNAL_PRESENT` constant has tone field `0` (index 4 = `,0,`). These tests build their own GLG strings with non-zero tone codes. GLG field layout is `GLG,<FRQ>,<MOD>,<ATT>,<TONE>,<N1>,<N2>,<N3>,<SQL>,<MUT>,<RSV>,<CHAN>`, so the tone code sits at index 4 and `<SQL>` at index 8 (`1` = squelch open, `0` = closed).

```rust
    // ---- Live tone decode (2026-07-08 live-tone-display feature) ----

    // GLG with CTCSS code 76 (= 100.0 Hz per tones.rs) and squelch OPEN.
    const GLG_CTCSS_OPEN: &str = "GLG,04626125,NFM,,76,,,GMRS CH 03,1,0,,75,";
    // Same tone, squelch CLOSED — tone must be suppressed.
    const GLG_CTCSS_CLOSED: &str = "GLG,04626125,NFM,,76,,,GMRS CH 03,0,1,,75,";
    // GLG with DCS code 151 (= DCS 134 per tones.rs) and squelch OPEN.
    const GLG_DCS_OPEN: &str = "GLG,04626125,NFM,,151,,,GMRS CH 03,1,0,,75,";

    #[test]
    fn livestate_decodes_ctcss_tone_when_squelch_open() {
        let glg = parse_glg_response(GLG_CTCSS_OPEN).unwrap();
        let live = livestate_from_frames(None, Some(&glg), None, ScannerMode::Scan, 0);
        assert_eq!(live.tone_squelch_kind, ToneSquelchKind::Ctcss);
        assert_eq!(live.tone_squelch, Some(100.0));
        assert_eq!(live.tone_dcs_code, None);
        assert_eq!(live.tone_dcs_label, None);
    }

    #[test]
    fn livestate_suppresses_tone_when_squelch_closed() {
        let glg = parse_glg_response(GLG_CTCSS_CLOSED).unwrap();
        let live = livestate_from_frames(None, Some(&glg), None, ScannerMode::Scan, 0);
        assert_eq!(live.tone_squelch_kind, ToneSquelchKind::None);
        assert_eq!(live.tone_squelch, None);
        assert_eq!(live.tone_dcs_code, None);
        assert_eq!(live.tone_dcs_label, None);
    }

    #[test]
    fn livestate_decodes_dcs_tone_with_label_when_squelch_open() {
        let glg = parse_glg_response(GLG_DCS_OPEN).unwrap();
        let live = livestate_from_frames(None, Some(&glg), None, ScannerMode::Scan, 0);
        assert_eq!(live.tone_squelch_kind, ToneSquelchKind::Dcs);
        assert_eq!(live.tone_squelch, None);
        assert_eq!(live.tone_dcs_code, Some(151));
        assert_eq!(live.tone_dcs_label.as_deref(), Some("DCS 134"));
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p bearpaw-api --lib livestate_decodes 2>&1 | tail -20; cargo test -p bearpaw-api --lib livestate_suppresses 2>&1 | tail -20`

Expected: FAIL to **compile** — `no field tone_squelch_kind on type LiveState` (the fields don't exist yet). A compile error here is the correct "red" state.

- [ ] **Step 3: Add the four fields to `LiveState`**

In `crates/bearpaw-api/src/state.rs`, extend the `LiveState` struct. Insert the four fields immediately after `stale` (line 72), before the closing `}` at line 73:

```rust
    #[serde(default)]
    pub stale: bool,
    /// Tone squelch decoded from the live GLG frame during an active hit.
    /// `None` / defaulted while the squelch is closed (tone is meaningless
    /// when no signal is present). Mirrors `ChannelData`'s tone shape plus a
    /// pre-formatted DCS label so the frontend needs no DCS table.
    #[serde(default)]
    pub tone_squelch_kind: ToneSquelchKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone_squelch: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone_dcs_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone_dcs_label: Option<String>,
```

`ToneSquelchKind` is already defined later in this same file (`state.rs:100`) and derives `Default` (→ `None`), so `LiveState`'s `#[derive(Default)]` still works.

- [ ] **Step 4: Make `decode_tone` crate-visible**

In `crates/bearpaw-api/src/protocol/mod.rs:507`, change the signature from private to `pub(crate)` (no body change):

```rust
/// Decode the CTCSS/DCS code field into kind + Hz + DCS code.
pub(crate) fn decode_tone(code: u16) -> (ToneSquelchKind, Option<f64>, Option<u16>) {
```

- [ ] **Step 5: Decode the tone in `livestate_from_frames`**

In `crates/bearpaw-api/src/protocol/mod.rs`, inside `livestate_from_frames`, add the decode logic just before the `LiveState { ... }` struct literal (after the `alpha_tag` binding at line 581, before line 583). Gate on `squelch_open` (already computed at line 557):

```rust
    // Tone is a property of the currently-received signal, so it's only
    // meaningful while the squelch is open. When closed (scanning/idle), emit
    // no tone regardless of a stale GLG tone field.
    let (tone_squelch_kind, tone_squelch, tone_dcs_code) = if squelch_open {
        glg.map(|g| decode_tone(g.tone_code)).unwrap_or_default()
    } else {
        Default::default()
    };
    let tone_dcs_label = tone_dcs_code.and_then(tones::dcs_code_to_label);
```

Then add the four fields to the returned `LiveState { ... }` literal, after `stale: false,` (line 595), before the closing `}` at line 596:

```rust
        stale: false,
        tone_squelch_kind,
        tone_squelch,
        tone_dcs_code,
        tone_dcs_label,
    }
```

Note: `(ToneSquelchKind, Option<f64>, Option<u16>)` implements `Default` (all three components do), so `Default::default()` in the `else` branch and `.unwrap_or_default()` both yield `(ToneSquelchKind::None, None, None)`. Confirm `tones` is in scope in this module — it is used elsewhere in `protocol/mod.rs` (e.g. `decode_tone` calls `tones::ctcss_code_to_hz`), so `tones::dcs_code_to_label` resolves without a new `use`.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cargo test -p bearpaw-api --lib 2>&1 | tail -25`

Expected: PASS — all three new tests (`livestate_decodes_ctcss_tone_when_squelch_open`, `livestate_suppresses_tone_when_squelch_closed`, `livestate_decodes_dcs_tone_with_label_when_squelch_open`) pass, and no existing test regresses.

- [ ] **Step 7: Type-check the backend**

Run: `cargo check -p bearpaw-api 2>&1 | tail -15`

Expected: clean (no errors, no new warnings).

- [ ] **Step 8: Commit**

```bash
git add crates/bearpaw-api/src/state.rs crates/bearpaw-api/src/protocol/mod.rs
git commit -m "$(cat <<'EOF'
feat: decode live CTCSS/DCS tone into LiveState

Surface the GLG tone_code (already parsed into GlgFrame but dropped at
livestate_from_frames) as four new LiveState fields: tone_squelch_kind,
tone_squelch (CTCSS Hz), tone_dcs_code, and tone_dcs_label (backend-
formatted "DCS NNN" so the frontend needs no DCS table). Decode is gated
on squelch_open — the tone is only meaningful while a signal is present.

Reuses the existing decode_tone (now pub(crate)) and tones::dcs_code_to_label
paths, both unit-tested and corrected in #130. Part of the live-tone-display
feature (docs/superpowers/specs/2026-07-08-live-tone-display-design.md).
EOF
)"
```

---

## Task 2: Backend — broadcast the tone fields over WebSocket

**Files:**
- Modify: `crates/bearpaw-api/src/api/poll.rs:873-885` (the `state_update` `data` block in `broadcast_live_update`)

**Interfaces:**
- Consumes: the `live: LiveState` value in `broadcast_live_update` now carrying the four tone fields from Task 1.
- Produces: the `state_update` WebSocket message's `data` object now includes `tone_squelch_kind`, `tone_squelch`, `tone_dcs_code`, `tone_dcs_label`. Frontend Task 4 reads these.

- [ ] **Step 1: Add the four fields to the broadcast `data` block**

In `crates/bearpaw-api/src/api/poll.rs`, in `broadcast_live_update`, extend the `json!` `data` object. Insert after `"stale": live.stale,` (line 884), before the closing `}` of the `data` object (line 885):

```rust
            "stale": live.stale,
            "tone_squelch_kind": live.tone_squelch_kind,
            "tone_squelch": live.tone_squelch,
            "tone_dcs_code": live.tone_dcs_code,
            "tone_dcs_label": live.tone_dcs_label,
```

`ToneSquelchKind` derives `Serialize` with `#[serde(rename_all = "lowercase")]`, so `tone_squelch_kind` serializes as `"none"`/`"ctcss"`/`"dcs"`/`"search"`. `serde_json`'s `json!` macro serializes `Option` as `null` when `None` — note this differs from the struct's `skip_serializing_if`, but a `null` field is harmless (the frontend fields are `?`-optional and the `formatLiveTone` helper treats `null`/absent identically).

- [ ] **Step 2: Type-check the backend**

Run: `cargo check -p bearpaw-api 2>&1 | tail -15`

Expected: clean. (`json!` accepts the `Serialize`-deriving fields directly; no code change needed beyond the four lines.)

- [ ] **Step 3: Run the full backend test suite**

Run: `cargo test -p bearpaw-api --lib 2>&1 | tail -15`

Expected: PASS — no regressions. (There is no dedicated broadcast unit test; the `state_update` shape is covered by the frontend and by manual/hardware verification. This step confirms nothing else broke.)

- [ ] **Step 4: Commit**

```bash
git add crates/bearpaw-api/src/api/poll.rs
git commit -m "$(cat <<'EOF'
feat: broadcast live tone fields in state_update

Add the four tone fields (tone_squelch_kind, tone_squelch, tone_dcs_code,
tone_dcs_label) to the state_update WebSocket data block. broadcast_live_update
emits the full field set every tick, so this is a four-line addition; the
frontend's monotonic sequence gate handles ordering.

Part of the live-tone-display feature.
EOF
)"
```

---

## Task 3: Frontend — extend the LiveState type

**Files:**
- Modify: `frontend/src/types.ts:3-15` (the `LiveState` interface)

**Interfaces:**
- Consumes: the `'none' | 'ctcss' | 'dcs' | 'search'` union already declared on `ChannelData` (`types.ts:32`).
- Produces: `LiveState` gains optional `tone_squelch_kind?`, `tone_squelch?`, `tone_dcs_code?`, `tone_dcs_label?`. Task 4 (`formatLiveTone`) reads these.

- [ ] **Step 1: Add the four fields to the `LiveState` interface**

In `frontend/src/types.ts`, extend the `LiveState` interface. Insert after `stale?: boolean;` (line 14), before the closing `}` at line 15:

```ts
  stale?: boolean;
  /** Tone discriminator from the live GLG frame during a hit; mirrors ChannelData. */
  tone_squelch_kind?: 'none' | 'ctcss' | 'dcs' | 'search';
  /** CTCSS frequency in Hz when tone_squelch_kind === 'ctcss'. */
  tone_squelch?: number | null;
  /** DCS wire code (128–231) when tone_squelch_kind === 'dcs'. */
  tone_dcs_code?: number | null;
  /** Backend-formatted "DCS NNN" label when tone_squelch_kind === 'dcs'. */
  tone_dcs_label?: string | null;
```

- [ ] **Step 2: Type-check the frontend**

Run (from `frontend/`): `npm run type-check 2>&1 | tail -15`

Expected: clean. (Adding optional fields to an interface breaks no existing consumer.)

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types.ts
git commit -m "$(cat <<'EOF'
feat: add tone fields to frontend LiveState type

Mirror the backend's four new tone fields on the LiveState interface. The
'none'|'ctcss'|'dcs'|'search' union already exists on ChannelData, so this
reuses a proven type. All four fields optional — no existing consumer changes.

Part of the live-tone-display feature.
EOF
)"
```

---

## Task 4: Frontend — formatLiveTone helper and subText display

**Files:**
- Create: `frontend/src/app/__tests__/formatLiveTone.test.ts`
- Modify: `frontend/src/app/App.tsx` (add module-level `formatLiveTone`; push into subText `parts` at line 700)

**Interfaces:**
- Consumes: `LiveState` with the four tone fields (Task 3); the subText `parts` array in the `mainText`/`subText` `useMemo` (`App.tsx:695-701`).
- Produces: exported `formatLiveTone(live: LiveState): string | null`. The subText line shows the formatted tone during a hit.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/__tests__/formatLiveTone.test.ts`. It imports the not-yet-exported helper and covers each branch. (These objects are partial `LiveState`s cast for the test — the helper only reads tone fields.)

```ts
import { describe, expect, it } from 'vitest';
import { formatLiveTone } from '../App';
import type { LiveState } from '../../types';

const base = (over: Partial<LiveState>): LiveState =>
  ({
    timestamp: 0,
    frequency: 146.85,
    modulation: 'FM',
    squelch_open: true,
    rssi: 0,
    mode: 'SCAN',
    volume: 0,
    ...over,
  }) as LiveState;

describe('formatLiveTone', () => {
  it('formats a CTCSS tone as "CTCSS <Hz>"', () => {
    expect(formatLiveTone(base({ tone_squelch_kind: 'ctcss', tone_squelch: 100 }))).toBe(
      'CTCSS 100.0',
    );
  });

  it('passes a DCS label through as-is', () => {
    expect(
      formatLiveTone(base({ tone_squelch_kind: 'dcs', tone_dcs_code: 128, tone_dcs_label: 'DCS 023' })),
    ).toBe('DCS 023');
  });

  it('labels tone search', () => {
    expect(formatLiveTone(base({ tone_squelch_kind: 'search' }))).toBe('Tone Search');
  });

  it('returns null for none', () => {
    expect(formatLiveTone(base({ tone_squelch_kind: 'none' }))).toBeNull();
  });

  it('returns null when tone fields are absent', () => {
    expect(formatLiveTone(base({}))).toBeNull();
  });

  it('returns null for ctcss with a missing Hz value', () => {
    expect(formatLiveTone(base({ tone_squelch_kind: 'ctcss', tone_squelch: null }))).toBeNull();
  });

  it('returns null for dcs with a missing label', () => {
    expect(formatLiveTone(base({ tone_squelch_kind: 'dcs', tone_dcs_code: 128 }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `frontend/`): `npm test -- --run formatLiveTone 2>&1 | tail -20`

Expected: FAIL — the import `formatLiveTone` does not exist / is not exported (`No known export 'formatLiveTone' in '../App'`).

- [ ] **Step 3: Add the `formatLiveTone` helper to App.tsx**

In `frontend/src/app/App.tsx`, add this module-level pure function (outside the component). Place it near the top of the file, after the imports and before the component definition. Import `LiveState` if not already imported (check the existing import block for `../types` / `../../types` — the file already uses `LiveState`, so it is imported; just add the function).

```ts
/**
 * Format the live tone for the Scan display's subText, or null if there is
 * no tone to show. CTCSS prints the Hz value; DCS uses the backend-formatted
 * label (the DCS wire code is not the human DCS number — the backend owns
 * that mapping); Tone Search gets a fixed label. Called only while the
 * squelch is open (see the subText memo).
 */
export function formatLiveTone(live: LiveState): string | null {
  switch (live.tone_squelch_kind) {
    case 'ctcss':
      return live.tone_squelch != null ? `CTCSS ${live.tone_squelch.toFixed(1)}` : null;
    case 'dcs':
      return live.tone_dcs_label ?? null;
    case 'search':
      return 'Tone Search';
    default:
      return null;
  }
}
```

- [ ] **Step 4: Push the tone into the subText parts array**

In `frontend/src/app/App.tsx`, in the `mainText`/`subText` `useMemo`, after the `CH` push (line 698-700) and before `return { mainText: main, subText: parts.join(' • ') };` (line 701), add the tone. Gate on `squelch_open` (belt-and-suspenders — the backend already gates decode on squelch):

```ts
    if (liveState.channel !== undefined && liveState.channel !== null) {
      parts.push(`CH ${liveState.channel}`);
    }
    if (liveState.squelch_open) {
      const tone = formatLiveTone(liveState);
      if (tone) parts.push(tone);
    }
    return { mainText: main, subText: parts.join(' • ') };
```

No change to the `useMemo` deps array is needed — `liveState` is already a dependency (line 702), and the tone fields live on that same object.

- [ ] **Step 5: Run the test to verify it passes**

Run (from `frontend/`): `npm test -- --run formatLiveTone 2>&1 | tail -20`

Expected: PASS — all seven `formatLiveTone` cases pass.

- [ ] **Step 6: Run the full frontend gate**

Run (from `frontend/`): `npm test -- --run 2>&1 | tail -15 && npm run type-check 2>&1 | tail -10 && npm run lint 2>&1 | tail -10 && npx prettier --check . 2>&1 | tail -10`

Expected: all green. If Prettier flags `App.tsx` or the new test file, run `npx prettier --write frontend/src/app/App.tsx frontend/src/app/__tests__/formatLiveTone.test.ts` and re-check.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/App.tsx frontend/src/app/__tests__/formatLiveTone.test.ts
git commit -m "$(cat <<'EOF'
feat: show live CTCSS/DCS tone in Scan subText

Add a pure formatLiveTone helper (CTCSS -> "CTCSS 100.0", DCS -> backend
label as-is, search -> "Tone Search", else null) and push its output into
the subText parts array during a hit, gated on squelch_open. Resulting
line: "146.850 - FM - CH 12 - CTCSS 100.0".

Part of the live-tone-display feature.
EOF
)"
```

---

## Task 5: Docs — schema, API spec, and IDEAS cleanup

**Files:**
- Modify: `docs/WEBSOCKET_SCHEMA.md` (the `state_update` `data` field list)
- Modify: `docs/API_SPEC.md` (the `LiveState` field list)
- Modify: `docs/IDEAS.md` (remove the implemented "Live tone display" note)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Locate the `state_update` / `LiveState` field tables**

Run: `grep -n "squelch_open\|stale\|alpha_tag" docs/WEBSOCKET_SCHEMA.md docs/API_SPEC.md`

This locates the existing field lists so the four new fields can be added in the same style (table row or bullet) the doc already uses. Read the surrounding lines in each file before editing to match the exact format.

- [ ] **Step 2: Document the four fields in `docs/WEBSOCKET_SCHEMA.md`**

In the `state_update` `data` field documentation, add entries for the four fields matching the file's existing format. The content to convey:

- `tone_squelch_kind` — string enum `"none" | "ctcss" | "dcs" | "search"`. Tone discriminator for the live signal. `"none"` (or absent) while squelch is closed.
- `tone_squelch` — number or null. CTCSS frequency in Hz when `tone_squelch_kind === "ctcss"`.
- `tone_dcs_code` — number or null. DCS wire code (128–231) when `tone_squelch_kind === "dcs"`.
- `tone_dcs_label` — string or null. Backend-formatted `"DCS NNN"` display label when `tone_squelch_kind === "dcs"`.

Add a one-line note that these fields are only populated while `squelch_open === true` (during a hit).

- [ ] **Step 3: Document the four fields in `docs/API_SPEC.md`**

In the `LiveState` field documentation, add the same four fields in the file's existing format, with the same descriptions as Step 2.

- [ ] **Step 4: Remove the implemented note from `docs/IDEAS.md`**

Run: `grep -n -i "tone" docs/IDEAS.md`

Remove the "Live tone display" idea entry (now implemented). If removing it leaves an empty section or dangling heading, tidy that up too. If `docs/IDEAS.md` has no tone entry (it may have been consumed already), skip this step and note it.

- [ ] **Step 5: Commit**

```bash
git add docs/WEBSOCKET_SCHEMA.md docs/API_SPEC.md docs/IDEAS.md
git commit -m "$(cat <<'EOF'
docs: document live tone fields; drop implemented IDEAS note

Add the four live tone fields (tone_squelch_kind, tone_squelch,
tone_dcs_code, tone_dcs_label) to WEBSOCKET_SCHEMA.md state_update and
API_SPEC.md LiveState, noting they populate only during a hit. Remove the
now-implemented "Live tone display" note from IDEAS.md.

Part of the live-tone-display feature.
EOF
)"
```

---

## Task 6: Full local CI gate, PR, and hardware verification

**Files:** none (verification and shipping).

- [ ] **Step 1: Run the full four-check gate locally**

```bash
cargo check -p bearpaw-api
cargo test -p bearpaw-api --lib
cd frontend
npx prettier --check .
npm run lint
npm run type-check
npm test -- --run
cd ..
```

Expected: all green. Fix anything red before pushing — never push to retry CI.

- [ ] **Step 2: Push the branch and open the PR**

```bash
git push -u origin feat/live-tone-display
gh pr create --title "feat: live CTCSS/DCS tone display" --label "enhancement,rust,frontend,protocol,rebuild" --body "$(cat <<'EOF'
## Summary
During an active scan hit, show the CTCSS/DCS tone the scanner is already
decoding in the Scan display's subText (e.g. `146.850 • FM • CH 12 • CTCSS 100.0`).
Design: docs/superpowers/specs/2026-07-08-live-tone-display-design.md.

## Why
`GlgFrame.tone_code` was parsed but dropped at `livestate_from_frames` (audit
issue #149 item 9b). The decoder (`decode_tone`, `tones::dcs_code_to_label`)
already existed and was corrected in #130 — this carries the already-decoded
value the last mile to the display. Tone is gated on `squelch_open` because it
is only meaningful while a signal is present.

## Test plan
- [x] `cargo test -p bearpaw-api --lib` — 3 new tests (CTCSS open, squelch-closed suppression, DCS+label)
- [x] `cargo check -p bearpaw-api` — clean
- [x] `npm run type-check` — clean
- [x] `npm test -- --run` — 7 new formatLiveTone tests
- [x] `npm run lint` — clean
- [x] `npx prettier --check .` — clean
- [ ] Real-hardware verification: hold on a channel with a known CTCSS/DCS tone, confirm the subText label matches.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

If any label doesn't exist, create it first (`gh label create "<name>" --color "fef2c0" --description "..."`), then re-run.

- [ ] **Step 3: Enable auto-merge and start the checks watcher**

```bash
gh pr merge <number> --auto --squash --delete-branch
```

Then, via the Bash tool with `run_in_background: true`:

```bash
gh pr checks <number> --watch --repo jeremyfuksa/bearpaw
```

Note: per `bearpaw-merge-mechanics` memory, this repo has no GitHub auto-merge configured — if `gh pr merge --auto` is rejected, fall back to `gh pr checks <number> --watch` in the background, then a direct `gh pr merge <number> --squash --delete-branch` once the watcher exits 0.

- [ ] **Step 4: Hardware verification (with the user, scanner on the desk)**

Once the backend is running against the hardware (`cargo run -p bearpaw-api --bin bearpaw -- --config ./config.yaml`) and the frontend is up:

- Hold on (or catch a live hit on) a channel with a **known CTCSS** tone (e.g. a local repeater) → confirm subText shows `CTCSS <Hz>` matching the programmed tone.
- If a **DCS** channel is available → confirm subText shows `DCS NNN` matching the programmed code.
- While **scanning with no hit** → confirm no tone appears (the squelch-closed gate).

Report the observed labels back. This is the trust-ladder rung 2 confirmation (running backend against hardware). If a tone label is wrong, it points at the tones.rs table, not this plumbing — capture the wire `GLG` line and reconcile.

---

## Self-Review

**Spec coverage** (each spec section → task):
- Goal (tone in subText during hit) → Tasks 1, 2, 4. ✓
- Non-goals (no activity-log, no new component, no frontend table) → honored; nothing in the plan touches the activity log or adds a component/table. ✓
- Backend: `LiveState` +4 fields → Task 1 Step 3. ✓
- Backend: `decode_tone` → `pub(crate)` → Task 1 Step 4. ✓
- Backend: decode gated on `squelch_open`, label via `dcs_code_to_label` → Task 1 Step 5. ✓
- Backend: `poll.rs` broadcast +4 fields → Task 2. ✓
- Frontend: `types.ts` +4 optional fields → Task 3. ✓
- Frontend: `formatLiveTone` helper + subText push → Task 4. ✓
- Tests: backend CTCSS-open / squelch-closed / DCS-label → Task 1 Step 1. Frontend CTCSS/DCS/search/none → Task 4 Step 1 (plus absent + missing-value edge cases). ✓
- Docs: WEBSOCKET_SCHEMA, API_SPEC, IDEAS cleanup → Task 5. ✓
- Hardware verification → Task 6 Step 4. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step shows real code. The only conditional instruction is Task 5 Step 4 (IDEAS.md may already lack the note), which is handled explicitly with a skip-and-note fallback. ✓

**Type consistency:** `formatLiveTone(live: LiveState): string | null` is named identically in Task 4's helper, test import, and Interfaces block. `decode_tone`'s tuple `(ToneSquelchKind, Option<f64>, Option<u16>)` matches the existing signature and the destructure in Task 1 Step 5. The four field names (`tone_squelch_kind`, `tone_squelch`, `tone_dcs_code`, `tone_dcs_label`) are spelled identically across state.rs, poll.rs, types.ts, and the helper. CTCSS test uses code 76 → 100.0 and DCS uses code 151 → "DCS 134", both verified against `tones.rs`. ✓
