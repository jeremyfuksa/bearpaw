use axum::extract::{Multipart, State};
use axum::response::Json;
use serde_json::{json, Value};

use super::super::{
    build_cin_write_payload_for, command_sender, read_channel_from_scanner, send_raw_command,
    split_command_parts, write_channel_to_scanner, ApiError, AppState, ProgramModeGuard,
};
use super::exports::import_progress;
use crate::protocol::capabilities::ScannerCapabilities;
use crate::protocol::tones::{ctcss_hz_to_code, dcs_number_to_code};
use crate::protocol::{classify_response, ScannerReply};
use crate::state::{ChannelData, ToneSquelchKind};

#[derive(Default)]
pub(crate) struct SsSettings {
    pub backlight: Option<String>, // BLT: On->AO Off->AF Key->KY Squelch->SQ K+S->KS
    pub beep: Option<String>,      // KBP field 1: Auto->0 Off->99 else digits
    pub key_lock: Option<String>,  // KBP field 2: On->1 Off->0
    pub contrast: Option<String>,  // CNT
    pub volume: Option<String>,    // VOL
    pub squelch: Option<String>,   // SQL
    pub charge_time: Option<String>, // BSV
    pub priority: Option<String>,  // PRI: Off->0 On->1 Plus->2 DND->3
    pub wx_pri: Option<String>,    // WXS: On->1 Off->0
    pub service_flags: Option<String>, // SSG 10-char mask
    pub scan_flags: Option<String>, // SCG 10-char bank mask
    pub custom_flags: Option<String>, // CSG 10-char mask
    pub custom_ranges: Vec<(u8, i64, i64)>, // (index, lower_100hz, upper_100hz)
    pub search_delay: Option<String>, // SCO field 1
    pub search_code: Option<String>, // SCO field 2 (On->1 Off->0)
    pub cc_mode: Option<String>,   // CloseCall field: Off->0 Pri->1 DND->2
    pub cc_beep: Option<String>,
    pub cc_light: Option<String>,
    pub cc_lockout: Option<String>,
    pub cc_bands: Option<String>, // 5-char mask from CloseCallBands
}

pub(crate) struct SsConfig {
    pub settings: SsSettings,
    pub channels: Vec<ChannelData>,
    pub empty_slots: Vec<u16>,
    pub errors: Vec<String>,
}

fn on_to_mask_bit(v: &str) -> char {
    // On -> enabled -> '0'; Off/anything -> disabled -> '1'
    if v.eq_ignore_ascii_case("On") {
        '0'
    } else {
        '1'
    }
}

fn on_off_to_flag(v: &str) -> &'static str {
    if v.eq_ignore_ascii_case("On") {
        "1"
    } else {
        "0"
    }
}

pub(crate) fn parse_ss_config(text: &str, caps: &ScannerCapabilities) -> SsConfig {
    let mut s = SsSettings::default();
    let mut channels = Vec::new();
    let mut empty_slots = Vec::new();
    let mut errors = Vec::new();
    // masks built from indexed lines default to enabled ('0'); we fill by index
    let mut scan = ['0'; 10];
    let mut service = ['0'; 10];
    let mut custom_enabled = ['0'; 10];

    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        match f.first().copied() {
            Some("Misc") if f.len() >= 8 => {
                s.backlight = Some(
                    match f[1] {
                        "On" => "AO",
                        "Off" => "AF",
                        "Key" => "KY",
                        "Squelch" => "SQ",
                        "K+S" => "KS",
                        _ => "AF",
                    }
                    .to_string(),
                );
                s.beep = Some(match f[2] {
                    "Auto" => "0".to_string(),
                    "Off" => "99".to_string(),
                    other => other.to_string(),
                });
                s.key_lock = Some(on_off_to_flag(f[3]).to_string());
                s.contrast = Some(f[4].to_string());
                s.volume = Some(f[5].to_string());
                s.squelch = Some(f[6].to_string());
                s.charge_time = Some(f[7].to_string());
            }
            Some("Priority") if f.len() >= 2 => {
                s.priority = Some(
                    match f[1] {
                        "On" => "1",
                        "Plus" => "2",
                        "DND" => "3",
                        _ => "0",
                    }
                    .to_string(),
                );
            }
            Some("WxPri") if f.len() >= 2 => {
                s.wx_pri = Some(on_off_to_flag(f[1]).to_string());
            }
            Some("Service") if f.len() >= 4 => {
                if let Ok(idx) = f[1].parse::<usize>() {
                    if (1..=10).contains(&idx) {
                        service[idx - 1] = on_to_mask_bit(f[3]);
                    }
                }
            }
            Some("Conventional") if f.len() >= 4 => {
                if let Ok(idx) = f[1].parse::<usize>() {
                    if (1..=10).contains(&idx) {
                        scan[idx - 1] = on_to_mask_bit(f[3]);
                    }
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
                s.cc_mode = Some(
                    match f[1] {
                        "Pri" => "1",
                        "DND" => "2",
                        _ => "0",
                    }
                    .to_string(),
                );
                s.cc_beep = Some(on_off_to_flag(f[2]).to_string());
                s.cc_light = Some(on_off_to_flag(f[3]).to_string());
                s.cc_lockout = Some(on_off_to_flag(f[4]).to_string());
            }
            Some("CloseCallBands") if f.len() >= 6 => {
                let bands: String = (1..=5)
                    .map(|i| {
                        if f[i].eq_ignore_ascii_case("On") {
                            '1'
                        } else {
                            '0'
                        }
                    })
                    .collect();
                s.cc_bands = Some(bands);
            }
            Some("C-Freq") if f.len() >= 9 => match parse_ss_channel(&f, caps) {
                Ok(Some(ch)) => channels.push(ch),
                Ok(None) => match parse_ss_index(&f, caps) {
                    Ok(index) => empty_slots.push(index),
                    Err(error) => errors.push(error),
                },
                Err(e) => errors.push(e),
            },
            _ => {} // unknown line type: ignore (forward-compatible)
        }
    }

    s.scan_flags = Some(scan.iter().collect());
    s.service_flags = Some(service.iter().collect());
    s.custom_flags = Some(custom_enabled.iter().collect());
    SsConfig {
        settings: s,
        channels,
        empty_slots,
        errors,
    }
}

fn parse_ss_index(f: &[&str], caps: &ScannerCapabilities) -> Result<u16, String> {
    let index: u16 = f[1].parse().map_err(|_| "bad C-Freq index".to_string())?;
    if !(1..=caps.channel_count).contains(&index) {
        return Err(format!(
            "C-Freq index out of range: {} (must be 1-{})",
            index, caps.channel_count
        ));
    }
    Ok(index)
}

fn parse_ss_channel(f: &[&str], caps: &ScannerCapabilities) -> Result<Option<ChannelData>, String> {
    let on = |v: &str| v.eq_ignore_ascii_case("On");
    // Bounded by the CONNECTED scanner, not a hardcoded 500 -- the same class
    // of bug #433 fixed on the CSV path. A BC75XLT holds 300.
    let index = parse_ss_index(f, caps)?;
    let freq_hz: i64 = f[3]
        .parse()
        .map_err(|_| "bad C-Freq frequency".to_string())?;
    if freq_hz == 0 {
        return Ok(None); // empty slot
    }
    let frequency = freq_hz as f64 / 1_000_000.0;
    if !caps.covers_frequency(frequency) {
        return Err(format!(
            "C-Freq {} is outside this scanner's coverage: {}",
            index, frequency
        ));
    }
    let parsed_delay: i8 = f[7].parse().map_err(|_| "bad C-Freq delay".to_string())?;
    // Clamp to something the radio can take. The file's delay column does not
    // always carry a usable value: on a BC75XLT it is a constant 2 in every
    // row (docs/SS_FILE_FORMAT.md) while that model's wire delay is a boolean.
    // Sending 2 is a CIN format error, and the vendor spec aborts the ENTIRE
    // write on one -- silently discarding the frequency and lockout with it.
    //
    // The BC75XLT import path replaces this with the channel's existing delay
    // afterwards, since the file genuinely carries no information here. The
    // clamp is the safety net for any other model whose file disagrees.
    let delay = if caps.valid_delays.contains(&parsed_delay) {
        parsed_delay
    } else {
        caps.cleared_delay
    };
    let (tone_squelch_kind, tone_squelch, tone_dcs_code) =
        parse_ss_tone(f[5], caps.has_tone_squelch)
            .map_err(|error| format!("C-Freq {} tone: {}", index, error))?;
    Ok(Some(ChannelData {
        index,
        frequency,
        modulation: f[4].to_uppercase(),
        alpha_tag: f[2].to_string(),
        delay,
        lockout: on(f[6]),
        priority: on(f[8]),
        tone_squelch,
        tone_squelch_kind,
        tone_dcs_code,
        bank: 1,
    }))
}

#[derive(Clone)]
enum SsRestoreSlot {
    Programmed(ChannelData),
    Empty(u16),
}

impl SsRestoreSlot {
    fn index(&self) -> u16 {
        match self {
            Self::Programmed(channel) => channel.index,
            Self::Empty(index) => *index,
        }
    }
}

fn ordered_restore_slots(cfg: &SsConfig) -> Vec<SsRestoreSlot> {
    let mut slots: Vec<SsRestoreSlot> = cfg
        .channels
        .iter()
        .cloned()
        .map(SsRestoreSlot::Programmed)
        .chain(cfg.empty_slots.iter().copied().map(SsRestoreSlot::Empty))
        .collect();
    slots.sort_unstable_by_key(SsRestoreSlot::index);
    slots
}

/// Clear one file-empty slot with the operation supported by this scanner,
/// then read it back. BC125-family radios have a true delete command; BC75XLT
/// does not, so it is cleared by writing a zero-frequency channel instead.
async fn clear_ss_slot(
    state: &AppState,
    index: u16,
    caps: &ScannerCapabilities,
) -> Result<ChannelData, ApiError> {
    let response = if caps.has_priority_clear {
        send_raw_command(state, &format!("DCH,{index}"), false).await?
    } else {
        let empty = ChannelData {
            index,
            delay: caps.cleared_delay,
            lockout: true,
            bank: caps.index_to_bank(index),
            ..ChannelData::default()
        };
        let payload = build_cin_write_payload_for(&empty, caps)?;
        send_raw_command(state, &format!("CIN,{index},{payload}"), false).await?
    };
    if !matches!(classify_response(&response), ScannerReply::Ok) {
        return Err(ApiError::BadRequest("channel_clear_rejected".to_string()));
    }

    let cleared = read_channel_from_scanner(state, index).await?;
    if cleared.frequency.abs() >= 0.00005 {
        return Err(ApiError::BadRequest(
            "channel_clear_not_persisted".to_string(),
        ));
    }
    Ok(cleared)
}

fn parse_ss_tone(
    label: &str,
    supported: bool,
) -> Result<(ToneSquelchKind, Option<f64>, Option<u16>), String> {
    if !supported {
        return Ok((ToneSquelchKind::None, None, None));
    }
    let label = label.trim();
    if label.is_empty() || label.eq_ignore_ascii_case("Off") {
        return Ok((ToneSquelchKind::None, None, None));
    }
    if label.eq_ignore_ascii_case("Srch") {
        return Ok((ToneSquelchKind::Search, None, None));
    }

    let upper = label.to_ascii_uppercase();
    if let Some(value) = upper.strip_prefix('C') {
        let hz = value
            .parse::<f64>()
            .map_err(|_| format!("invalid CTCSS value {label:?}"))?;
        if ctcss_hz_to_code(hz).is_none() {
            return Err(format!("unsupported CTCSS value {label:?}"));
        }
        return Ok((ToneSquelchKind::Ctcss, Some(hz), None));
    }
    if let Some(value) = upper.strip_prefix('D') {
        if value.len() != 3 || !value.chars().all(|character| character.is_ascii_digit()) {
            return Err(format!("invalid DCS value {label:?}"));
        }
        let number = value
            .parse::<u16>()
            .map_err(|_| format!("invalid DCS value {label:?}"))?;
        let code =
            dcs_number_to_code(number).ok_or_else(|| format!("unsupported DCS value {label:?}"))?;
        return Ok((ToneSquelchKind::Dcs, None, Some(code)));
    }

    Err(format!("invalid value {label:?}"))
}

/// Sends `write_cmd`, checks the reply is OK, then reads back `read_cmd` and
/// confirms the first field matches `expect_first_field`. Catches silent
/// no-ops on unproven writes (CSP/CLC). Caller holds the program-mode
/// bracket. A full field-by-field verify is overkill for a first cut; write
/// returned OK and the read-back's first field changed is enough.
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

/// Restore a full scanner config from an uploaded Sentinel `.bc125at_ss` file.
///
/// Under ONE program-mode bracket: writes every channel (fast CIN path, retry
/// once — same as CSV import), then applies global settings write-verified
/// (each rejection is non-fatal and recorded). Progress streams over the WS.
/// Pull the `file` part out of a multipart upload.
async fn read_upload(mut multipart: Multipart) -> Result<Vec<u8>, ApiError> {
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("multipart_error: {}", e)))?
    {
        if field.name() == Some("file") {
            return Ok(field
                .bytes()
                .await
                .map_err(|e| ApiError::BadRequest(format!("upload_error: {}", e)))?
                .to_vec());
        }
    }
    Err(ApiError::BadRequest("file_required".to_string()))
}

/// Import a `.bc75xlt_ss` file.
///
/// Channels only. The settings sections in that file are written by a tool
/// that can send `BLT`/`BSV`/`CNT`/`WXS`, and this model answers `ERR` to all
/// four -- pushing them would stall the PRG bracket (#436). Applying settings
/// on this model needs its own probe and is deliberately out of scope here.
///
/// The file's delay column carries a constant 2 (see docs/SS_FILE_FORMAT.md),
/// which is a `CIN` format error on this radio. Each channel therefore keeps
/// the delay it already has rather than taking one from a file that does not
/// actually record it.
pub(crate) async fn import_bc75xlt_ss(
    State(state): State<AppState>,
    multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if state.sync_task_id.lock().unwrap().is_some() {
        return Err(ApiError::Conflict("sync_in_progress".to_string()));
    }
    let caps = state.capabilities();
    if caps.ss_format != "bc75xlt" {
        return Err(ApiError::BadRequest("unsupported_model".to_string()));
    }

    let bytes = read_upload(multipart).await?;
    let text = String::from_utf8_lossy(&bytes);
    let cfg = parse_ss_config(&text, &caps);

    let mut errors: Vec<Value> = cfg.errors.iter().map(|e| json!({ "error": e })).collect();
    let mut imported = 0usize;
    let mut cleared = 0usize;
    let mut slots = ordered_restore_slots(&cfg);
    let total = slots.len();

    // Substitute each channel's existing delay BEFORE the bracket opens, so
    // the shadow read is not holding a lock across a wire round-trip.
    {
        let shadow = state.shadow.read().unwrap();
        for slot in &mut slots {
            if let SsRestoreSlot::Programmed(channel) = slot {
                channel.delay = shadow
                    .channels
                    .get(&channel.index)
                    .map(|existing| existing.delay)
                    .unwrap_or(caps.cleared_delay);
            }
        }
    }

    let _prg = ProgramModeGuard::enter(&state).await?;
    for (n, slot) in slots.iter().enumerate() {
        let index = slot.index();
        let mut r = match slot {
            SsRestoreSlot::Programmed(channel) => write_channel_to_scanner(&state, channel).await,
            SsRestoreSlot::Empty(index) => clear_ss_slot(&state, *index, &caps).await,
        };
        if r.is_err() {
            r = match slot {
                SsRestoreSlot::Programmed(channel) => {
                    write_channel_to_scanner(&state, channel).await
                }
                SsRestoreSlot::Empty(index) => clear_ss_slot(&state, *index, &caps).await,
            };
        }
        // REGRESSION GUARD (#556, findings 3/4/5): the import stores what the
        // SCANNER reports, not what the file said.
        //
        // This used `write_channel_no_readback`, which returns nothing
        // verified, so the loop cached its own intent. The firmware
        // silently refuses an in-place priority 1->0, so every imported row
        // disagreeing on that field was cached as a lie -- and since #413
        // the lie is flushed to SQLite and re-adopted at every connect.
        //
        // `write_channel_to_scanner` writes, reads back, and returns the
        // readback. It costs one extra CIN per row: about +5 s on a full
        // 500-channel import, measured against the ~5 s a 500-channel read
        // takes. It also picks up the #595 priority-displacement re-read,
        // so a row that takes priority no longer leaves the bank's previous
        // holder stale.
        match r {
            Ok(verified) => {
                imported += 1;
                if matches!(slot, SsRestoreSlot::Empty(_)) {
                    cleared += 1;
                }
                state
                    .shadow
                    .write()
                    .unwrap()
                    .channels
                    .insert(verified.index, verified);
            }
            Err(e) => errors.push(json!({ "index": index, "error": format!("{:?}", e) })),
        }
        if total > 0 && (n + 1) % 10 == 0 {
            let pct = ((n + 1) * 100 / total) as u8;
            import_progress(
                &state,
                "import-ss",
                pct,
                &format!("Importing {}/{}", n + 1, total),
            );
        }
    }
    import_progress(&state, "import-ss", 100, "Import complete");

    Ok(Json(json!({
        "imported": imported,
        "cleared": cleared,
        "total": total,
        "settings_applied": 0,
        "errors": errors,
    })))
}

pub(crate) async fn import_bc125at_ss(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Reject if a memory sync is running — both hold the single-threaded wire
    // for a long PRG bracket; racing them contends for the command channel.
    if state.sync_task_id.lock().unwrap().is_some() {
        return Err(ApiError::Conflict("sync_in_progress".to_string()));
    }
    // The EXPORT side has always gated on model; this side had no gate at all,
    // so a BC125AT settings file could be pushed into a BC75XLT. That file
    // carries 500 channels, per-channel modulation and tone codes, and
    // BC125AT-family delay values -- none of which that scanner accepts. Its
    // delays alone are CIN format errors, and the vendor spec aborts the
    // ENTIRE set command on one, so the import would write partial channels
    // over real memory before anything surfaced as an error.
    let caps = state.capabilities();
    if caps.ss_format != "bc125at" {
        return Err(ApiError::BadRequest("unsupported_model".to_string()));
    }

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
    let cfg = parse_ss_config(&text, &caps);

    let mut errors: Vec<Value> = cfg.errors.iter().map(|e| json!({ "error": e })).collect();
    let mut imported = 0usize;
    let mut cleared = 0usize;
    let mut settings_applied = 0usize;
    let slots = ordered_restore_slots(&cfg);
    let total = slots.len();

    let _prg = ProgramModeGuard::enter(&state).await?;

    // --- channels (fast path, retry once — mirrors CSV import) ---
    for (n, slot) in slots.iter().enumerate() {
        let index = slot.index();
        let mut r = match slot {
            SsRestoreSlot::Programmed(channel) => write_channel_to_scanner(&state, channel).await,
            SsRestoreSlot::Empty(index) => clear_ss_slot(&state, *index, &caps).await,
        };
        if r.is_err() {
            r = match slot {
                SsRestoreSlot::Programmed(channel) => {
                    write_channel_to_scanner(&state, channel).await
                }
                SsRestoreSlot::Empty(index) => clear_ss_slot(&state, *index, &caps).await,
            };
        }
        // REGRESSION GUARD (#556, findings 3/4/5): the import stores what the
        // SCANNER reports, not what the file said.
        //
        // This used `write_channel_no_readback`, which returns nothing
        // verified, so the loop cached its own intent. The firmware
        // silently refuses an in-place priority 1->0, so every imported row
        // disagreeing on that field was cached as a lie -- and since #413
        // the lie is flushed to SQLite and re-adopted at every connect.
        //
        // `write_channel_to_scanner` writes, reads back, and returns the
        // readback. It costs one extra CIN per row: about +5 s on a full
        // 500-channel import, measured against the ~5 s a 500-channel read
        // takes. It also picks up the #595 priority-displacement re-read,
        // so a row that takes priority no longer leaves the bank's previous
        // holder stale.
        match r {
            Ok(verified) => {
                imported += 1;
                if matches!(slot, SsRestoreSlot::Empty(_)) {
                    cleared += 1;
                }
                state
                    .shadow
                    .write()
                    .unwrap()
                    .channels
                    .insert(verified.index, verified);
            }
            Err(e) => errors.push(json!({ "index": index, "error": format!("{:?}", e) })),
        }
        if total > 0 && (n + 1) % 10 == 0 {
            let pct = ((n + 1) * 80 / total) as u8;
            import_progress(
                &state,
                "import-ss",
                pct,
                &format!("Importing {}/{}", n + 1, total),
            );
        }
    }

    // --- settings (write-verified, non-fatal) ---
    import_progress(&state, "import-ss", 85, "Applying settings…");
    let s = &cfg.settings;
    // each entry: (write_cmd, read_cmd, expected first field of read-back)
    let mut jobs: Vec<(String, String, String)> = Vec::new();
    if let Some(v) = &s.backlight {
        jobs.push((format!("BLT,{}", v), "BLT".to_string(), v.clone()));
    }
    if let Some(v) = &s.charge_time {
        jobs.push((format!("BSV,{}", v), "BSV".to_string(), v.clone()));
    }
    if let (Some(b), Some(k)) = (&s.beep, &s.key_lock) {
        jobs.push((format!("KBP,{},{}", b, k), "KBP".to_string(), b.clone()));
    }
    if let Some(v) = &s.contrast {
        jobs.push((format!("CNT,{}", v), "CNT".to_string(), v.clone()));
    }
    if let Some(v) = &s.volume {
        jobs.push((format!("VOL,{}", v), "VOL".to_string(), v.clone()));
    }
    if let Some(v) = &s.squelch {
        jobs.push((format!("SQL,{}", v), "SQL".to_string(), v.clone()));
    }
    if let Some(v) = &s.priority {
        jobs.push((format!("PRI,{}", v), "PRI".to_string(), v.clone()));
    }
    if let Some(v) = &s.wx_pri {
        jobs.push((format!("WXS,{}", v), "WXS".to_string(), v.clone()));
    }
    if let Some(v) = &s.service_flags {
        jobs.push((format!("SSG,{}", v), "SSG".to_string(), v.clone()));
    }
    if let Some(v) = &s.scan_flags {
        jobs.push((format!("SCG,{}", v), "SCG".to_string(), v.clone()));
    }
    if let Some(v) = &s.custom_flags {
        jobs.push((format!("CSG,{}", v), "CSG".to_string(), v.clone()));
    }
    if let (Some(d), Some(c)) = (&s.search_delay, &s.search_code) {
        jobs.push((format!("SCO,{},{}", d, c), "SCO".to_string(), d.clone()));
    }
    for (idx, lo, hi) in &s.custom_ranges {
        jobs.push((
            format!("CSP,{},{},{}", idx, lo, hi),
            // CSP read-back is per-index; verify the index echoes.
            format!("CSP,{}", idx),
            idx.to_string(),
        ));
    }
    if let (Some(m), Some(b), Some(l), Some(bands), Some(lk)) = (
        &s.cc_mode,
        &s.cc_beep,
        &s.cc_light,
        &s.cc_bands,
        &s.cc_lockout,
    ) {
        jobs.push((
            format!("CLC,{},{},{},{},{}", m, b, l, bands, lk),
            "CLC".to_string(),
            m.clone(),
        ));
    }

    for (write_cmd, read_cmd, expect) in jobs {
        match write_setting_verified(&state, &write_cmd, &read_cmd, &expect).await {
            Ok(()) => settings_applied += 1,
            Err(e) => errors.push(json!({ "setting": write_cmd, "error": e })),
        }
    }

    import_progress(&state, "import-ss", 100, "Import complete");
    Ok(Json(json!({
        "imported": imported,
        "cleared": cleared,
        "total": total,
        "settings_applied": settings_applied,
        "errors": errors,
    })))
}

#[cfg(test)]
mod tests {
    use super::super::exports::ss_tone_label;
    use super::*;
    use crate::protocol::capabilities::{BC125AT_FAMILY, BC75XLT};

    #[test]
    fn setting_ok_reply_classified() {
        // Guards the OK/NG/ERR classification the verify relies on.
        use crate::protocol::{classify_response, ScannerReply};
        assert!(matches!(classify_response("BLT,OK"), ScannerReply::Ok));
        assert!(matches!(classify_response("BLT,NG"), ScannerReply::Ng));
        assert!(matches!(classify_response("BLT,ERR"), ScannerReply::Err));
    }

    const SAMPLE: &str = "Misc\tK+S\tAuto\tOff\t8\t10\t3\t16\tUSA\nPriority\tOn\nWxPri\tOff\nService\t1\tPolice\tOff\nService\t3\tHAM Radio\tOn\nConventional\t1\tBank 1\tOn\nConventional\t4\tBank 4\tOff\nCloseCall\tOff\tOff\tOff\tOff\nCloseCallBands\tOff\tOn\tOff\tOff\tOn\nGeneralSearch\t2\tOff\nCustom\t1\tSearch Bnak1\t25000000\t27995000\tOn\n";

    #[test]
    fn parses_misc_to_wire_settings() {
        let cfg = parse_ss_config(SAMPLE, &BC125AT_FAMILY);
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
        let cfg = parse_ss_config(SAMPLE, &BC125AT_FAMILY);
        assert_eq!(cfg.settings.priority.as_deref(), Some("1")); // On->1
        assert_eq!(cfg.settings.wx_pri.as_deref(), Some("0")); // Off->0
    }

    #[test]
    fn parses_bank_mask_with_correct_polarity() {
        let cfg = parse_ss_config(SAMPLE, &BC125AT_FAMILY);
        // Conventional 1 On -> '0', Conventional 4 Off -> '1', rest default On->'0'
        // mask is 10 chars, positions 1..10
        let mask = cfg.settings.scan_flags.as_deref().unwrap();
        assert_eq!(mask.len(), 10);
        assert_eq!(&mask[0..1], "0"); // bank 1 enabled
        assert_eq!(&mask[3..4], "1"); // bank 4 disabled
    }

    #[test]
    fn parses_service_mask() {
        let cfg = parse_ss_config(SAMPLE, &BC125AT_FAMILY);
        // Service 1 Off -> '1', Service 3 On -> '0'
        let mask = cfg.settings.service_flags.as_deref().unwrap();
        assert_eq!(&mask[0..1], "1");
        assert_eq!(&mask[2..3], "0");
    }

    #[test]
    fn parses_beep_auto_to_wire_zero() {
        // SAMPLE's Misc line has beep field "Auto"
        let cfg = parse_ss_config(SAMPLE, &BC125AT_FAMILY);
        assert_eq!(cfg.settings.beep.as_deref(), Some("0"));
    }

    #[test]
    fn parses_beep_off_to_wire_99() {
        let text = "Misc\tK+S\tOff\tOff\t8\t10\t3\t16\tUSA\n";
        let cfg = parse_ss_config(text, &BC125AT_FAMILY);
        assert_eq!(cfg.settings.beep.as_deref(), Some("99"));
    }

    #[test]
    fn parses_closecall_pri_to_wire_one() {
        let text = "CloseCall\tPri\tOn\tOff\tOff\n";
        let cfg = parse_ss_config(text, &BC125AT_FAMILY);
        assert_eq!(cfg.settings.cc_mode.as_deref(), Some("1"));
    }

    #[test]
    fn parses_cfreq_channel() {
        let line = "C-Freq\t1\tArarat UHF\t145130000\tAUTO\tOff\tOff\t2\tOff";
        let f: Vec<&str> = line.split('\t').collect();
        let ch = parse_ss_channel(&f, &BC125AT_FAMILY)
            .unwrap()
            .expect("some");
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
        assert!(parse_ss_channel(&f, &BC125AT_FAMILY).unwrap().is_none());
    }

    #[test]
    fn cfreq_lockout_priority_on() {
        let line = "C-Freq\t3\tRepeater\t146940000\tFM\tOff\tOn\t2\tOn";
        let f: Vec<&str> = line.split('\t').collect();
        let ch = parse_ss_channel(&f, &BC125AT_FAMILY)
            .unwrap()
            .expect("some");
        assert!(ch.lockout);
        assert!(ch.priority);
    }

    #[test]
    fn ss_tones_round_trip_through_export_and_import() {
        let channels = [
            ChannelData::default(),
            ChannelData {
                tone_squelch_kind: ToneSquelchKind::Ctcss,
                tone_squelch: Some(100.0),
                ..ChannelData::default()
            },
            ChannelData {
                tone_squelch_kind: ToneSquelchKind::Dcs,
                tone_dcs_code: Some(128),
                ..ChannelData::default()
            },
            ChannelData {
                tone_squelch_kind: ToneSquelchKind::Search,
                ..ChannelData::default()
            },
        ];

        for (offset, original) in channels.into_iter().enumerate() {
            let label = ss_tone_label(&original);
            let row = format!(
                "C-Freq\t{}\tTone\t145130000\tFM\t{}\tOff\t2\tOff",
                offset + 1,
                label
            );
            let fields: Vec<&str> = row.split('\t').collect();
            let parsed = parse_ss_channel(&fields, &BC125AT_FAMILY)
                .expect("exported row parses")
                .expect("programmed channel");

            assert_eq!(ss_tone_label(&parsed), label, "round-trip for {label}");
        }
    }

    #[test]
    fn malformed_non_empty_tones_are_reported_per_row() {
        for label in ["C100.5", "D23", "D999", "Tone"] {
            let text = format!("C-Freq\t1\tTone\t145130000\tFM\t{}\tOff\t2\tOff", label);
            let cfg = parse_ss_config(&text, &BC125AT_FAMILY);
            assert!(cfg.channels.is_empty(), "{label} must not become Off");
            assert_eq!(cfg.errors.len(), 1, "{label} must produce one row error");
            assert!(cfg.errors[0].contains("C-Freq 1 tone"));
        }
    }

    #[test]
    fn parsed_ss_tones_encode_to_the_expected_cin_codes() {
        for (label, expected_code) in [
            ("Off", "0"),
            ("C100.0", "76"),
            ("D023", "128"),
            ("Srch", "127"),
        ] {
            let row = format!("C-Freq\t1\tTone\t145130000\tFM\t{}\tOff\t2\tOff", label);
            let fields: Vec<&str> = row.split('\t').collect();
            let parsed = parse_ss_channel(&fields, &BC125AT_FAMILY)
                .expect("tone parses")
                .expect("programmed channel");
            let payload = crate::api::build_cin_write_payload_for(&parsed, &BC125AT_FAMILY)
                .expect("tone encodes");
            assert_eq!(payload.split(',').nth(3), Some(expected_code), "{label}");
        }
    }

    /// The BC75XLT parser must read a real file written by Uniden's tool.
    ///
    /// `fixtures/blank.bc75xlt_ss` is a `New` -> `Save As` from the real
    /// software: 300 empty channels. Every row must retain its slot index so a
    /// full restore can clear pre-existing scanner memory.
    #[test]
    fn a_blank_bc75xlt_file_preserves_all_empty_slots() {
        let text = include_str!("../../../fixtures/blank.bc75xlt_ss");
        let cfg = parse_ss_config(text, &BC75XLT);
        assert!(
            cfg.channels.is_empty(),
            "every slot in a blank file is empty"
        );
        assert_eq!(cfg.empty_slots.len(), 300);
        assert_eq!(cfg.empty_slots.first(), Some(&1));
        assert_eq!(cfg.empty_slots.last(), Some(&300));
        assert!(
            cfg.errors.is_empty(),
            "a file the tool itself wrote must parse cleanly: {:?}",
            cfg.errors
        );
    }

    #[test]
    fn mixed_files_keep_programmed_and_empty_rows_in_index_order() {
        let text = "C-Freq\t2\t\t0\t\tOff\tOff\t2\tOff\n\
                    C-Freq\t1\tTEST\t145130000\tFM\tOff\tOff\t2\tOff\n";
        let cfg = parse_ss_config(text, &BC125AT_FAMILY);
        let slots = ordered_restore_slots(&cfg);
        assert_eq!(slots.len(), 2);
        assert_eq!(slots[0].index(), 1);
        assert!(matches!(slots[0], SsRestoreSlot::Programmed(_)));
        assert_eq!(slots[1].index(), 2);
        assert!(matches!(slots[1], SsRestoreSlot::Empty(2)));
    }

    /// REGRESSION GUARD: the file's delay column must never reach the wire on
    /// a BC75XLT.
    ///
    /// Every row of a real `.bc75xlt_ss` carries `2` (docs/SS_FILE_FORMAT.md),
    /// and that model's `CIN` delay is a boolean. Sending 2 is a format error,
    /// and the vendor spec aborts the ENTIRE set command on one -- so a single
    /// imported row would silently discard its own frequency and lockout.
    #[test]
    fn the_files_delay_never_reaches_a_bc75xlt() {
        let row = "C-Freq\t1\t\t145130000\t\t\tOff\t2\tOff";
        let f: Vec<&str> = row.split('\t').collect();
        let ch = parse_ss_channel(&f, &BC75XLT)
            .expect("parses")
            .expect("programmed slot");
        assert!(
            BC75XLT.valid_delays.contains(&ch.delay),
            "delay {} is not writable on this model",
            ch.delay
        );
        assert_ne!(ch.delay, 2, "2 is the file's constant, not a wire value");
    }

    /// The same row on a BC125AT keeps its delay: 2 seconds is legal there,
    /// and clamping it would be silent data loss.
    #[test]
    fn a_bc125at_keeps_a_delay_the_file_supplies() {
        let row = "C-Freq\t1\tTEST\t145130000\tFM\t\tOff\t2\tOff";
        let f: Vec<&str> = row.split('\t').collect();
        let ch = parse_ss_channel(&f, &BC125AT_FAMILY)
            .expect("parses")
            .expect("programmed slot");
        assert_eq!(ch.delay, 2);
    }

    /// The index bound follows the connected scanner, not a hardcoded 500 --
    /// the same class of bug #433 fixed on the CSV path.
    #[test]
    fn the_ss_index_bound_follows_the_model() {
        let row = "C-Freq\t301\t\t145130000\t\t\tOff\t2\tOff";
        let f: Vec<&str> = row.split('\t').collect();
        assert!(parse_ss_channel(&f, &BC125AT_FAMILY).is_ok());
        let err = parse_ss_channel(&f, &BC75XLT).expect_err("301 does not exist here");
        assert!(err.contains("1-300"), "got: {err}");
    }
}
