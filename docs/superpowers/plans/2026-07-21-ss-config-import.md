# `.ss` Full-Config Import + Unified Import Dialog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a Sentinel `.ss` file (500 channels + all global settings) to restore a full scanner config, and make the Import button accept either `.csv` or `.bc125at_ss`, dispatching by file extension.

**Architecture:** A backend parser turns the tab-separated `.ss` text into a `SsConfig` struct, then a new `POST /api/v1/memory/import/bc125at_ss` endpoint writes it under one program-mode bracket — channels via the existing fast bulk-write (trust `CIN,OK`), settings each write-verified and non-fatal. The frontend picks either extension in the native dialog and dispatches to the CSV or `.ss` endpoint, confirming first for `.ss`.

**Tech Stack:** Rust (Axum, serde_json), React/TypeScript, Tauri dialog + fs plugins, sonner toasts, vitest.

**Spec deviation (approved scope reduction):** The spec's `C-Freq` mapping implies per-channel tone is restored. This plan **defers tone round-trip** — imported channels get tone = off — because reversing the export's tone *label* (`100.0` / `DCS 023` / `Srch`) back to a CIN tone *code* is an unproven write path. Everything else (freq, name, modulation, delay, lockout, priority, all global settings, banks) round-trips. Tone restore is a tracked follow-up. See "Known limitation" at the end.

## Global Constraints

- Wire is `\r`-terminated; one command in flight at a time; never send `PRG`/`EPG` manually — use `ProgramModeGuard`. (bearpaw-protocol-audit)
- Masks (`SCG`/`SSG`/`CSG`): `'1'` = disabled, `'0'` = enabled. `On` → `'0'`, `Off` → `'1'`.
- Frequency on the wire: units of 100 Hz (MHz × 10000 for CSP; Hz already in `.ss` C-Freq).
- CSP and CLC writes are unproven on this hardware — write-verify each and record failures rather than trusting the reply. Do NOT abort the import on a settings failure.
- Channels reuse `write_channel_no_readback` + retry-once + freq-0-skip from PR #180 — do NOT reimplement channel writes.
- CI gates (all four green locally before push): `cargo test -p bearpaw-api --lib`, and from `frontend/`: `npm test -- --run`, `npm run lint`, `npm run type-check`, `npm run format:check`.
- Every change lands via a PR to `main`; never commit to `main` directly. Two PRs: backend then frontend.

---

## File Structure

- **Create** `crates/bearpaw-api/src/api/handlers/import_ss.rs` — the `.ss` parser (`parse_ss_config`), the `SsConfig`/`SsSettings` types, and the `import_bc125at_ss` endpoint handler. One responsibility: `.ss` import. Keeps `exports.rs` from growing further.
- **Modify** `crates/bearpaw-api/src/api/handlers/mod.rs` — register the new `import_ss` submodule.
- **Modify** `crates/bearpaw-api/src/api/mod.rs` — add the route; expose any helper (`import_progress`) the new handler reuses.
- **Modify** `frontend/src/tauri-shell.ts` — `pickAndReadFile` already takes extensions; no change needed unless the picker filter needs both. Verify.
- **Modify** `frontend/src/app/components/views/ChannelsTab.tsx` — `handleImportCSV` → dispatch by extension; add `.ss` confirm + endpoint.
- **Modify** `frontend/src/app/components/views/__tests__/ChannelsTab.test.tsx` — dispatch tests.

Channel-write reuse: `write_channel_no_readback` (`crates/bearpaw-api/src/api/mod.rs`), `parse_import_csv_row` returning `Ok(None)` for freq-0, and the retry-once loop all live in `exports.rs`/`mod.rs` from PR #180. The `.ss` channel phase calls the same helpers.

---

# PR 1 — Backend `.ss` import

## Task 1: `.ss` parser — settings block

**Files:**
- Create: `crates/bearpaw-api/src/api/handlers/import_ss.rs`
- Modify: `crates/bearpaw-api/src/api/handlers/mod.rs` (add `pub(crate) mod import_ss;`)

**Interfaces:**
- Produces: `pub(crate) struct SsSettings` (all fields `Option<String>`, holding the raw wire values to write), `pub(crate) struct SsConfig { settings: SsSettings, channels: Vec<ChannelData> }`, and `pub(crate) fn parse_ss_config(text: &str) -> SsConfig`. Parsing never hard-fails; unrecognized/malformed lines are collected into `SsConfig.errors: Vec<String>`.

The parser reverses `export_bc125at_ss_file`'s encodings. Field references below are the export's `format!` calls in `exports.rs`.

- [ ] **Step 1: Write the failing test (settings parse)**

Add to `import_ss.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "Misc\tK+S\tAuto\tOff\t8\t10\t3\t16\tUSA\nPriority\tOn\nWxPri\tOff\nService\t1\tPolice\tOff\nService\t3\tHAM Radio\tOn\nConventional\t1\tBank 1\tOn\nConventional\t4\tBank 4\tOff\nCloseCall\tOff\tOff\tOff\tOff\nCloseCallBands\tOff\tOn\tOff\tOff\tOn\nGeneralSearch\t2\tOff\nCustom\t1\tSearch Bnak1\t25000000\t27995000\tOn\n";

    #[test]
    fn parses_misc_to_wire_settings() {
        let cfg = parse_ss_config(SAMPLE);
        // Misc: backlight K+S->KS, beep Auto->99, keylock Off->0,
        // contrast 8, volume 10, squelch 3, charge 16
        assert_eq!(cfg.settings.backlight.as_deref(), Some("KS"));
        assert_eq!(cfg.settings.volume.as_deref(), Some("10"));
        assert_eq!(cfg.settings.squelch.as_deref(), Some("3"));
        assert_eq!(cfg.settings.contrast.as_deref(), Some("8"));
        assert_eq!(cfg.settings.charge_time.as_deref(), Some("16"));
    }

    #[test]
    fn parses_priority_and_wxpri() {
        let cfg = parse_ss_config(SAMPLE);
        assert_eq!(cfg.settings.priority.as_deref(), Some("1")); // On->1
        assert_eq!(cfg.settings.wx_pri.as_deref(), Some("0")); // Off->0
    }

    #[test]
    fn parses_bank_mask_with_correct_polarity() {
        let cfg = parse_ss_config(SAMPLE);
        // Conventional 1 On -> '0', Conventional 4 Off -> '1', rest default On->'0'
        // mask is 10 chars, positions 1..10
        let mask = cfg.settings.scan_flags.as_deref().unwrap();
        assert_eq!(mask.len(), 10);
        assert_eq!(&mask[0..1], "0"); // bank 1 enabled
        assert_eq!(&mask[3..4], "1"); // bank 4 disabled
    }

    #[test]
    fn parses_service_mask() {
        let cfg = parse_ss_config(SAMPLE);
        // Service 1 Off -> '1', Service 3 On -> '0'
        let mask = cfg.settings.service_flags.as_deref().unwrap();
        assert_eq!(&mask[0..1], "1");
        assert_eq!(&mask[2..3], "0");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bearpaw-api --lib import_ss`
Expected: FAIL — `parse_ss_config` / `SsSettings` not defined.

- [ ] **Step 3: Write the types and settings parser**

In `import_ss.rs` (above the test module):
```rust
use std::collections::HashMap;

use crate::state::ChannelData;

#[derive(Default)]
pub(crate) struct SsSettings {
    pub backlight: Option<String>,   // BLT: On->AO Off->AF Key->KY Squelch->SQ K+S->KS
    pub beep: Option<String>,        // KBP field 1: Auto->99 Off->0 else digits
    pub key_lock: Option<String>,    // KBP field 2: On->1 Off->0
    pub contrast: Option<String>,    // CNT
    pub volume: Option<String>,      // VOL
    pub squelch: Option<String>,     // SQL
    pub charge_time: Option<String>, // BSV
    pub priority: Option<String>,    // PRI: Off->0 On->1 Plus->2 DND->3
    pub wx_pri: Option<String>,      // WXS: On->1 Off->0
    pub service_flags: Option<String>, // SSG 10-char mask
    pub scan_flags: Option<String>,    // SCG 10-char bank mask
    pub custom_flags: Option<String>,  // CSG 10-char mask
    pub custom_ranges: Vec<(u8, i64, i64)>, // (index, lower_100hz, upper_100hz)
    pub search_delay: Option<String>,  // SCO field 1
    pub search_code: Option<String>,   // SCO field 2 (On->1 Off->0)
    pub cc_mode: Option<String>,       // CloseCall field: Off->0 Priority->1 DND->2
    pub cc_beep: Option<String>,
    pub cc_light: Option<String>,
    pub cc_lockout: Option<String>,
    pub cc_bands: Option<String>, // 5-char mask from CloseCallBands
}

pub(crate) struct SsConfig {
    pub settings: SsSettings,
    pub channels: Vec<ChannelData>,
    pub errors: Vec<String>,
}

fn on_to_mask_bit(v: &str) -> char {
    // On -> enabled -> '0'; Off/anything -> disabled -> '1'
    if v.eq_ignore_ascii_case("On") { '0' } else { '1' }
}

fn on_off_to_flag(v: &str) -> &'static str {
    if v.eq_ignore_ascii_case("On") { "1" } else { "0" }
}

pub(crate) fn parse_ss_config(text: &str) -> SsConfig {
    let mut s = SsSettings::default();
    let mut channels = Vec::new();
    let mut errors = Vec::new();
    // masks built from indexed lines default to enabled ('0'); we fill by index
    let mut scan = ['0'; 10];
    let mut service = ['0'; 10];
    let mut custom_enabled = ['0'; 10];

    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        match f.first().copied() {
            Some("Misc") if f.len() >= 8 => {
                s.backlight = Some(match f[1] {
                    "On" => "AO", "Off" => "AF", "Key" => "KY",
                    "Squelch" => "SQ", "K+S" => "KS", _ => "AF",
                }.to_string());
                s.beep = Some(match f[2] {
                    "Auto" => "99".to_string(),
                    "Off" => "0".to_string(),
                    other => other.to_string(),
                });
                s.key_lock = Some(on_off_to_flag(f[3]).to_string());
                s.contrast = Some(f[4].to_string());
                s.volume = Some(f[5].to_string());
                s.squelch = Some(f[6].to_string());
                s.charge_time = Some(f[7].to_string());
            }
            Some("Priority") if f.len() >= 2 => {
                s.priority = Some(match f[1] {
                    "On" => "1", "Plus" => "2", "DND" => "3", _ => "0",
                }.to_string());
            }
            Some("WxPri") if f.len() >= 2 => {
                s.wx_pri = Some(on_off_to_flag(f[1]).to_string());
            }
            Some("Service") if f.len() >= 4 => {
                if let Ok(idx) = f[1].parse::<usize>() {
                    if (1..=10).contains(&idx) { service[idx - 1] = on_to_mask_bit(f[3]); }
                }
            }
            Some("Conventional") if f.len() >= 4 => {
                if let Ok(idx) = f[1].parse::<usize>() {
                    if (1..=10).contains(&idx) { scan[idx - 1] = on_to_mask_bit(f[3]); }
                }
            }
            Some("Custom") if f.len() >= 6 => {
                if let (Ok(idx), Ok(lo), Ok(hi)) =
                    (f[1].parse::<u8>(), f[3].parse::<i64>(), f[4].parse::<i64>())
                {
                    // export writes Hz; CSP wants units of 100 Hz
                    s.custom_ranges.push((idx, lo / 100, hi / 100));
                    if (1..=10).contains(&(idx as usize)) {
                        custom_enabled[(idx - 1) as usize] = on_to_mask_bit(f[5]);
                    }
                }
            }
            Some("GeneralSearch") if f.len() >= 3 => {
                s.search_delay = Some(f[1].to_string());
                s.search_code = Some(on_off_to_flag(f[2]).to_string());
            }
            Some("CloseCall") if f.len() >= 5 => {
                s.cc_mode = Some(match f[1] {
                    "Priority" => "1", "DND" => "2", _ => "0",
                }.to_string());
                s.cc_beep = Some(on_off_to_flag(f[2]).to_string());
                s.cc_light = Some(on_off_to_flag(f[3]).to_string());
                s.cc_lockout = Some(on_off_to_flag(f[4]).to_string());
            }
            Some("CloseCallBands") if f.len() >= 6 => {
                let bands: String = (1..=5)
                    .map(|i| if f[i].eq_ignore_ascii_case("On") { '1' } else { '0' })
                    .collect();
                s.cc_bands = Some(bands);
            }
            Some("C-Freq") if f.len() >= 9 => {
                match parse_ss_channel(&f) {
                    Ok(Some(ch)) => channels.push(ch),
                    Ok(None) => {}
                    Err(e) => errors.push(e),
                }
            }
            _ => {} // unknown line type: ignore (forward-compatible)
        }
    }

    s.scan_flags = Some(scan.iter().collect());
    s.service_flags = Some(service.iter().collect());
    s.custom_flags = Some(custom_enabled.iter().collect());
    SsConfig { settings: s, channels, errors }
}
```

Add a stub `parse_ss_channel` so it compiles (Task 2 fills it):
```rust
fn parse_ss_channel(_fields: &[&str]) -> Result<Option<ChannelData>, String> {
    Ok(None)
}
```

Register the module — in `crates/bearpaw-api/src/api/handlers/mod.rs` add:
```rust
pub(crate) mod import_ss;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p bearpaw-api --lib import_ss`
Expected: PASS (4 settings tests).

- [ ] **Step 5: Commit**

```bash
git add crates/bearpaw-api/src/api/handlers/import_ss.rs crates/bearpaw-api/src/api/handlers/mod.rs
git commit -m "feat: .ss parser — settings block (channels stubbed)"
```

---

## Task 2: `.ss` parser — channel (`C-Freq`) lines

**Files:**
- Modify: `crates/bearpaw-api/src/api/handlers/import_ss.rs`

**Interfaces:**
- Consumes: `SsConfig.channels` from Task 1.
- Produces: `fn parse_ss_channel(fields: &[&str]) -> Result<Option<ChannelData>, String>` — `C-Freq\t<idx>\t<name>\t<freq_hz>\t<mod>\t<tone>\t<lockout>\t<delay>\t<priority>`. Freq is Hz (integer). `Ok(None)` when freq is 0 (empty slot). Tone/lockout/priority are the export's display strings (`Off`/`On`/Hz/`Srch`/`DCS nnn`).

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `import_ss.rs`:
```rust
#[test]
fn parses_cfreq_channel() {
    let line = "C-Freq\t1\tArarat UHF\t145130000\tAUTO\tOff\tOff\t2\tOff";
    let f: Vec<&str> = line.split('\t').collect();
    let ch = parse_ss_channel(&f).unwrap().expect("some");
    assert_eq!(ch.index, 1);
    assert!((ch.frequency - 145.13).abs() < 0.00005);
    assert_eq!(ch.alpha_tag, "Ararat UHF");
    assert_eq!(ch.delay, 2);
    assert!(!ch.lockout);
}

#[test]
fn cfreq_zero_freq_is_empty_slot() {
    let line = "C-Freq\t6\tAUTO\t0\tAUTO\tOff\tOff\t2\tOff";
    let f: Vec<&str> = line.split('\t').collect();
    assert!(parse_ss_channel(&f).unwrap().is_none());
}

#[test]
fn cfreq_lockout_priority_on() {
    let line = "C-Freq\t3\tRepeater\t146940000\tFM\tOff\tOn\t2\tOn";
    let f: Vec<&str> = line.split('\t').collect();
    let ch = parse_ss_channel(&f).unwrap().expect("some");
    assert!(ch.lockout);
    assert!(ch.priority);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bearpaw-api --lib import_ss::tests::parses_cfreq_channel`
Expected: FAIL — stub returns `Ok(None)`, so `.expect("some")` panics.

- [ ] **Step 3: Implement `parse_ss_channel`**

Replace the stub in `import_ss.rs`. Field indices: `[0]=C-Freq [1]=idx [2]=name [3]=freq_hz [4]=mod [5]=tone [6]=lockout [7]=delay [8]=priority`.
```rust
use crate::state::ToneSquelchKind;

fn parse_ss_channel(f: &[&str]) -> Result<Option<ChannelData>, String> {
    let on = |v: &str| v.eq_ignore_ascii_case("On");
    let index: u16 = f[1].parse().map_err(|_| "bad C-Freq index".to_string())?;
    if !(1..=500).contains(&index) {
        return Err(format!("C-Freq index out of range: {}", index));
    }
    let freq_hz: i64 = f[3].parse().map_err(|_| "bad C-Freq frequency".to_string())?;
    if freq_hz == 0 {
        return Ok(None); // empty slot
    }
    let frequency = freq_hz as f64 / 1_000_000.0;
    let delay: i8 = f[7].parse().map_err(|_| "bad C-Freq delay".to_string())?;
    Ok(Some(ChannelData {
        index,
        frequency,
        modulation: f[4].to_uppercase(),
        alpha_tag: f[2].to_string(),
        delay,
        lockout: on(f[6]),
        priority: on(f[8]),
        // Tone parsing from the display label is deferred: import writes tone
        // as "0" (off) in the CIN payload for now. Tone round-trip is tracked
        // separately — the export label ("100.0"/"DCS 023"/"Srch") would need
        // reverse decoding to a code. Channels still import with correct
        // freq/name/mod/delay/lockout/priority.
        tone_squelch: None,
        tone_squelch_kind: ToneSquelchKind::None,
        tone_dcs_code: None,
        bank: 1,
    }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p bearpaw-api --lib import_ss`
Expected: PASS (all parser tests).

- [ ] **Step 5: Commit**

```bash
git add crates/bearpaw-api/src/api/handlers/import_ss.rs
git commit -m "feat: .ss parser — C-Freq channel lines"
```

---

## Task 3: settings write-verify helper

**Files:**
- Modify: `crates/bearpaw-api/src/api/handlers/import_ss.rs`

**Interfaces:**
- Consumes: `send_raw_command`, `classify_response`, `ScannerReply` (from `crate::api`/`crate::protocol`), `AppState`.
- Produces: `async fn write_setting_verified(state: &AppState, write_cmd: &str, read_cmd: &str, expect_first_field: &str) -> Result<(), String>` — sends `write_cmd`, checks the reply is OK, then sends `read_cmd` and confirms the first field matches `expect_first_field`. Returns `Err(reason)` on any mismatch. Caller holds the program-mode bracket.

Note: full field-by-field verify is overkill for a first cut; verifying the write returned OK and the read-back's first field changed is enough to catch a silent no-op (the CSP/CLC risk). Record failures, never abort.

- [ ] **Step 1: Write the failing test**

`write_setting_verified` needs a live scanner, so it is covered by the live-hardware step, not a unit test. Instead unit-test the mask/verify *decision* with a pure helper:
```rust
#[test]
fn setting_ok_reply_classified() {
    // Guards the OK/NG/ERR classification the verify relies on.
    use crate::protocol::{classify_response, ScannerReply};
    assert!(matches!(classify_response("BLT,OK"), ScannerReply::Ok));
    assert!(matches!(classify_response("BLT,NG"), ScannerReply::Ng));
    assert!(matches!(classify_response("BLT,ERR"), ScannerReply::Err));
}
```

- [ ] **Step 2: Run test to verify it fails/passes**

Run: `cargo test -p bearpaw-api --lib import_ss::tests::setting_ok_reply_classified`
Expected: PASS immediately (uses existing `classify_response`). This is a guard, not new behavior.

- [ ] **Step 3: Implement `write_setting_verified`**

Add to `import_ss.rs`:
```rust
use crate::api::{send_raw_command, split_command_parts, AppState};
use crate::protocol::{classify_response, ScannerReply};

async fn write_setting_verified(
    state: &AppState,
    write_cmd: &str,
    read_cmd: &str,
    expect_first_field: &str,
) -> Result<(), String> {
    let write_resp = send_raw_command(state, write_cmd, false)
        .await
        .map_err(|e| format!("{:?}", e))?;
    match classify_response(&write_resp) {
        ScannerReply::Ok => {}
        other => return Err(format!("{} rejected: {:?}", write_cmd, other)),
    }
    let read_resp = send_raw_command(state, read_cmd, false)
        .await
        .map_err(|e| format!("{:?}", e))?;
    let got = split_command_parts(&read_resp)
        .into_iter()
        .next()
        .unwrap_or_default();
    if got == expect_first_field {
        Ok(())
    } else {
        Err(format!("{} not persisted (got {})", write_cmd, got))
    }
}
```

Confirm `send_raw_command` and `split_command_parts` are `pub(crate)` and re-exported from `crate::api` — if the path differs, use the one Task's compile error names.

- [ ] **Step 4: Run test + compile**

Run: `cargo test -p bearpaw-api --lib import_ss`
Expected: PASS; crate compiles with the new helper.

- [ ] **Step 5: Commit**

```bash
git add crates/bearpaw-api/src/api/handlers/import_ss.rs
git commit -m "feat: .ss import — settings write-verify helper"
```

---

## Task 4: the `import_bc125at_ss` endpoint

**Files:**
- Modify: `crates/bearpaw-api/src/api/handlers/import_ss.rs`
- Modify: `crates/bearpaw-api/src/api/mod.rs` (add route; expose `import_progress` if not already `pub(crate)`)

**Interfaces:**
- Consumes: `parse_ss_config`, `write_setting_verified` (Tasks 1-3); `write_channel_no_readback`, `ProgramModeGuard`, `command_sender`, `import_progress`, `Multipart`, `Json`, `AppState` (existing).
- Produces: `pub(crate) async fn import_bc125at_ss(State(state): State<AppState>, multipart: Multipart) -> Result<Json<Value>, ApiError>`, wired at `POST /api/v1/memory/import/bc125at_ss`. Returns `{ imported, settings_applied, errors: [String] }`.

- [ ] **Step 1: Write the failing test (route exists)**

The handler needs hardware; unit-test that the router registers the path (mirrors existing router tests). In `crates/bearpaw-api/src/api/mod.rs` tests (or wherever router tests live), add:
```rust
#[tokio::test]
async fn import_ss_route_is_registered() {
    let state = crate::default_state();
    let app = router(state);
    // A GET on a POST-only route returns 405, proving the path is mounted.
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;
    let resp = app
        .oneshot(
            Request::builder()
                .uri("/api/v1/memory/import/bc125at_ss")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::METHOD_NOT_ALLOWED);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p bearpaw-api --lib import_ss_route_is_registered`
Expected: FAIL — route not mounted (likely 404).

- [ ] **Step 3: Implement the handler + route**

In `import_ss.rs`:
```rust
use axum::extract::{Multipart, State};
use axum::response::Json;
use serde_json::{json, Value};

use crate::api::{
    command_sender, import_progress, write_channel_no_readback, ApiError, ProgramModeGuard,
};

pub(crate) async fn import_bc125at_ss(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // read the uploaded file
    let mut bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("multipart_error: {}", e)))?
    {
        if field.name() == Some("file") {
            bytes = Some(
                field
                    .bytes()
                    .await
                    .map_err(|e| ApiError::BadRequest(format!("upload_error: {}", e)))?
                    .to_vec(),
            );
            break;
        }
    }
    let Some(bytes) = bytes else {
        return Err(ApiError::BadRequest("file_required".to_string()));
    };
    let text = String::from_utf8_lossy(&bytes);
    let cfg = parse_ss_config(&text);

    let mut errors: Vec<Value> =
        cfg.errors.iter().map(|e| json!({ "error": e })).collect();
    let mut imported = 0usize;
    let mut settings_applied = 0usize;
    let total = cfg.channels.len();

    let _prg = ProgramModeGuard::enter(&state).await?;

    // --- channels (fast path, retry once) ---
    for (n, ch) in cfg.channels.iter().enumerate() {
        let mut r = write_channel_no_readback(&state, ch).await;
        if r.is_err() {
            r = write_channel_no_readback(&state, ch).await;
        }
        match r {
            Ok(()) => {
                imported += 1;
                state.shadow.write().unwrap().channels.insert(ch.index, ch.clone());
            }
            Err(e) => errors.push(json!({ "index": ch.index, "error": format!("{:?}", e) })),
        }
        if total > 0 && (n + 1) % 10 == 0 {
            let pct = ((n + 1) * 80 / total) as u8;
            import_progress(&state, pct, &format!("Importing {}/{}", n + 1, total));
        }
    }

    // --- settings (write-verify, non-fatal) ---
    import_progress(&state, 85, "Applying settings…");
    let s = &cfg.settings;
    let mut apply = |cmd: String, read: &str, expect: String| {
        (cmd, read.to_string(), expect)
    };
    // each entry: (write_cmd, read_cmd, expected first field of read-back)
    let mut jobs: Vec<(String, String, String)> = Vec::new();
    if let Some(v) = &s.backlight { jobs.push(apply(format!("BLT,{}", v), "BLT", v.clone())); }
    if let Some(v) = &s.charge_time { jobs.push(apply(format!("BSV,{}", v), "BSV", v.clone())); }
    if let (Some(b), Some(k)) = (&s.beep, &s.key_lock) {
        jobs.push(apply(format!("KBP,{},{}", b, k), "KBP", b.clone()));
    }
    if let Some(v) = &s.contrast { jobs.push(apply(format!("CNT,{}", v), "CNT", v.clone())); }
    if let Some(v) = &s.volume { jobs.push(apply(format!("VOL,{}", v), "VOL", v.clone())); }
    if let Some(v) = &s.squelch { jobs.push(apply(format!("SQL,{}", v), "SQL", v.clone())); }
    if let Some(v) = &s.priority { jobs.push(apply(format!("PRI,{}", v), "PRI", v.clone())); }
    if let Some(v) = &s.wx_pri { jobs.push(apply(format!("WXS,{}", v), "WXS", v.clone())); }
    if let Some(v) = &s.service_flags { jobs.push(apply(format!("SSG,{}", v), "SSG", v.clone())); }
    if let Some(v) = &s.scan_flags { jobs.push(apply(format!("SCG,{}", v), "SCG", v.clone())); }
    if let Some(v) = &s.custom_flags { jobs.push(apply(format!("CSG,{}", v), "CSG", v.clone())); }
    if let (Some(d), Some(c)) = (&s.search_delay, &s.search_code) {
        jobs.push(apply(format!("SCO,{},{}", d, c), "SCO", d.clone()));
    }
    for (idx, lo, hi) in &s.custom_ranges {
        jobs.push(apply(
            format!("CSP,{},{},{}", idx, lo, hi),
            // CSP read-back is per-index; verify the index echoes
            &format!("CSP,{}", idx),
            idx.to_string(),
        ));
    }
    if let (Some(m), Some(b), Some(l), Some(bands), Some(lk)) =
        (&s.cc_mode, &s.cc_beep, &s.cc_light, &s.cc_bands, &s.cc_lockout)
    {
        jobs.push(apply(
            format!("CLC,{},{},{},{},{}", m, b, l, bands, lk),
            "CLC",
            m.clone(),
        ));
    }

    for (write_cmd, read_cmd, expect) in jobs {
        match write_setting_verified(&state, &write_cmd, &read_cmd, &expect).await {
            Ok(()) => settings_applied += 1,
            Err(e) => errors.push(json!({ "setting": write_cmd, "error": e })),
        }
    }

    import_progress(&state, 100, "Import complete");
    Ok(Json(json!({
        "imported": imported,
        "settings_applied": settings_applied,
        "errors": errors,
    })))
}
```

In `crates/bearpaw-api/src/api/mod.rs`, next to the CSV import route:
```rust
.route(
    "/api/v1/memory/import/bc125at_ss",
    post(handlers::import_ss::import_bc125at_ss),
)
```
Ensure `import_progress` and `write_channel_no_readback` are `pub(crate)` and reachable via `crate::api` (they are `pub(crate)` in `exports.rs`/`mod.rs` from PR #180; re-export `import_progress` from `mod.rs` if it is module-private to `exports.rs`).

- [ ] **Step 4: Run test + full backend suite**

Run: `cargo test -p bearpaw-api --lib`
Expected: PASS — route test + all parser tests + existing 94.

- [ ] **Step 5: Run clippy + workspace check**

Run: `cargo clippy -p bearpaw-api` then `cargo check --workspace --all-targets`
Expected: no errors on `import_ss.rs`; workspace compiles.

- [ ] **Step 6: Commit**

```bash
git add crates/bearpaw-api/src/api/handlers/import_ss.rs crates/bearpaw-api/src/api/mod.rs
git commit -m "feat: POST /memory/import/bc125at_ss — full-config restore"
```

---

## Task 5: PR 1 — ship backend

- [ ] **Step 1: Branch and run all four checks**

```bash
git checkout -b feat/ss-config-import-backend
# (commits from Tasks 1-4 are already on this branch if you branched first;
#  otherwise cherry-pick or rebase them here)
cargo test -p bearpaw-api --lib
cd frontend && npx prettier --check . && npm run lint && npm run type-check && npm test -- --run && cd ..
```
Expected: all green.

- [ ] **Step 2: Live-hardware verification (per bearpaw-protocol-audit)**

With the scanner connected and a memory sync done:
```bash
cargo run -p bearpaw-api --bin bearpaw -- --config ./config.yaml   # in one shell
# in another: export an .ss, then import it back
curl -s http://127.0.0.1:8000/api/v1/memory/export/bc125at_ss -o /tmp/cfg.ss
curl -s -X POST http://127.0.0.1:8000/api/v1/memory/import/bc125at_ss \
  -F "file=@/tmp/cfg.ss" -w "\n%{http_code} %{time_total}s\n"
```
Expected: `imported` ≈ number of non-empty channels, `settings_applied` > 0, and `errors` lists only genuinely unproven writes (note any `CSP`/`CLC` failures). Record CSP/CLC behavior in `docs/wire_captures/2026-05-21/audit-reconciliation.md`; correct the CLAUDE.md "no CSP write path" note if CSP persisted.

- [ ] **Step 3: PR**

```bash
git push -u origin feat/ss-config-import-backend
gh pr create --title "feat: .ss full-config import (backend)" --label "enhancement,rust,protocol,rebuild" --body "..."
gh pr merge <n> --auto --squash --delete-branch
```

---

# PR 2 — Frontend unified Import dialog

## Task 6: dispatch Import by file extension

**Files:**
- Modify: `frontend/src/app/components/views/ChannelsTab.tsx`
- Modify: `frontend/src/app/components/views/__tests__/ChannelsTab.test.tsx`
- Verify (likely no change): `frontend/src/tauri-shell.ts` — `pickAndReadFile(['csv','bc125at_ss'])` already supports multiple extensions.

**Interfaces:**
- Consumes: `pickAndReadFile(extensions: string[])`, `confirmDialog(message, title)`, `saveExport` (existing in `tauri-shell.ts`), `toast` (sonner).
- Produces: updated `handleImportCSV` (rename to `handleImport`) that picks `['csv','bc125at_ss']`, branches on the picked filename extension, POSTs to `/import/csv` or `/import/bc125at_ss`, and gates `.ss` behind `confirmDialog`.

- [ ] **Step 1: Write the failing tests**

In `ChannelsTab.test.tsx` (the file already mocks `tauri-shell` — add `confirmDialog` to that mock if not present):
```tsx
it('dispatches .csv to the csv import endpoint', async () => {
  vi.mocked(pickAndReadFile).mockResolvedValue({
    name: 'channels.csv',
    bytes: new TextEncoder().encode('Index,Frequency\n1,145.13'),
  });
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ imported: 1, errors: [] }),
  });
  global.fetch = fetchSpy as unknown as typeof fetch;
  mockApiClient.getChannels = vi.fn().mockResolvedValue(mockChannels);

  render(<ChannelsTab />);
  await userEvent.click(screen.getByRole('button', { name: /Import/i }));

  await waitFor(() => {
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/memory/import/csv'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

it('dispatches .bc125at_ss to the ss import endpoint after confirm', async () => {
  vi.mocked(pickAndReadFile).mockResolvedValue({
    name: 'scanner.bc125at_ss',
    bytes: new TextEncoder().encode('Misc\tK+S\tAuto\tOff\t8\t10\t3\t16\tUSA'),
  });
  vi.mocked(confirmDialog).mockResolvedValue(true);
  const fetchSpy = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({ imported: 0, settings_applied: 1, errors: [] }),
  });
  global.fetch = fetchSpy as unknown as typeof fetch;
  mockApiClient.getChannels = vi.fn().mockResolvedValue(mockChannels);

  render(<ChannelsTab />);
  await userEvent.click(screen.getByRole('button', { name: /Import/i }));

  await waitFor(() => {
    expect(confirmDialog).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining('/memory/import/bc125at_ss'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

it('does not import .ss when confirm is declined', async () => {
  vi.mocked(pickAndReadFile).mockResolvedValue({
    name: 'scanner.bc125at_ss',
    bytes: new TextEncoder().encode('Misc\tK+S'),
  });
  vi.mocked(confirmDialog).mockResolvedValue(false);
  const fetchSpy = vi.fn();
  global.fetch = fetchSpy as unknown as typeof fetch;

  render(<ChannelsTab />);
  await userEvent.click(screen.getByRole('button', { name: /Import/i }));

  await waitFor(() => expect(confirmDialog).toHaveBeenCalled());
  expect(fetchSpy).not.toHaveBeenCalled();
});
```
If the Import button label is exactly "Import CSV", either update the test's name regex or (preferred) relabel the button to "Import" in Step 3 since it now takes both formats.

- [ ] **Step 2: Run tests to verify they fail**

Run (from `frontend/`): `npm test -- --run ChannelsTab`
Expected: FAIL — dispatch not implemented; `.ss` goes to the CSV endpoint.

- [ ] **Step 3: Implement dispatch**

In `ChannelsTab.tsx`, replace `handleImportCSV` with:
```tsx
const handleImport = async () => {
  if (isImporting) return;
  const picked = await pickAndReadFile(['csv', 'bc125at_ss']);
  if (!picked) return;

  const isSs = picked.name.toLowerCase().endsWith('.bc125at_ss');
  if (isSs) {
    const ok = await confirmDialog(
      'Restore full config from this file? This overwrites all channels and settings.',
      'Restore config',
    );
    if (!ok) return;
  }

  setIsImporting(true);
  const toastId = toast.loading(
    isSs
      ? 'Restoring config — this can take a minute or two…'
      : 'Importing channels — this can take a minute or two…',
  );
  try {
    const endpoint = isSs
      ? `${API_BASE}/memory/import/bc125at_ss`
      : `${API_BASE}/memory/import/csv`;
    const formData = new FormData();
    formData.append('file', new File([picked.bytes as BlobPart], picked.name));
    const response = await fetch(endpoint, { method: 'POST', body: formData });
    if (!response.ok) throw new Error('Import failed');
    const result = await response.json();
    const { imported, errors } = result;
    if (errors && errors.length > 0) {
      toast.error(`Imported ${imported} — ${errors.length} item(s) failed`, { id: toastId });
    } else {
      toast.success(
        isSs ? `Config restored (${imported} channels)` : `Imported ${imported} channels successfully`,
        { id: toastId },
      );
    }
    const updatedChannels = await api.getChannels();
    setChannels(updatedChannels);
  } catch (error) {
    console.error('Failed to import', error);
    toast.error('Failed to import', { id: toastId });
  } finally {
    setIsImporting(false);
  }
};
```
Update the button: `onClick={handleImport}` and label `{isImporting ? 'Importing…' : 'Import'}`. Add `confirmDialog` to the `tauri-shell` import.

- [ ] **Step 4: Run tests to verify they pass**

Run (from `frontend/`): `npm test -- --run ChannelsTab`
Expected: PASS (3 new dispatch tests + existing).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/components/views/ChannelsTab.tsx frontend/src/app/components/views/__tests__/ChannelsTab.test.tsx
git commit -m "feat: unified Import — dispatch .csv/.bc125at_ss by extension"
```

---

## Task 7: PR 2 — ship frontend

- [ ] **Step 1: Branch (off updated main after PR 1 merges) and run all four checks**

```bash
git checkout main && git pull origin main
git checkout -b feat/ss-config-import-frontend
cd frontend
npx prettier --check .
npm run lint
npm run type-check
npm test -- --run
cd ..
cargo test -p bearpaw-api --lib
```
Expected: all green.

- [ ] **Step 2: Live verification in the desktop app**

`npm run tauri:dev`; Channels → Import → pick a `.bc125at_ss` → confirm → watch progress → "Config restored". Then pick a `.csv` → imports channels, no confirm. Trigger a couple exports too and confirm the toast stacking still reads well.

- [ ] **Step 3: PR**

```bash
git push -u origin feat/ss-config-import-frontend
gh pr create --title "feat: unified Import dialog (.csv + .bc125at_ss)" --label "enhancement,frontend,rebuild" --body "..."
gh pr merge <n> --auto --squash --delete-branch
```

---

## Known limitation (document in PR 1)

**Tone round-trip is not restored on `.ss` import.** The export writes tone as a
display label (`100.0`, `DCS 023`, `Srch`); reversing that to a CIN tone code is
deferred, so imported channels get tone = off. Freq/name/mod/delay/lockout/
priority round-trip correctly. Call this out in the PR body and file a follow-up.
This keeps the plan bounded and avoids an unverified tone-decode write path.
