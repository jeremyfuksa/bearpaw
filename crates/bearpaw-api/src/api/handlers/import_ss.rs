use axum::extract::{Multipart, State};
use axum::response::Json;
use serde_json::{json, Value};

use super::super::{
    command_sender, send_raw_command, split_command_parts, write_channel_to_scanner, ApiError,
    AppState, ProgramModeGuard,
};
use super::exports::import_progress;
use super::settings;
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
                Ok(ch) => channels.push(ch),
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
        errors,
    }
}

/// The shape a slot takes when the file says it is empty.
///
/// A clear is not a special command -- it is a `CIN` write with frequency 0,
/// and `readback_matches` has a dedicated zero-frequency branch that accepts
/// the factory-empty signature the scanner stamps back. So an empty row in
/// the file has to reach the write loop looking like this rather than being
/// dropped: dropping it is what let stale channels survive a "full restore"
/// (#621).
///
/// `delay` is `cleared_delay` because that is what the radio reports for an
/// empty slot, and it is model-dependent -- 2 on the BC125AT family, 0 on a
/// BC75XLT. `lockout` is `true` on both. See `is_factory_empty`.
fn cleared_channel(index: u16, caps: &ScannerCapabilities) -> ChannelData {
    ChannelData {
        index,
        frequency: 0.0,
        modulation: "AUTO".to_string(),
        alpha_tag: String::new(),
        delay: caps.cleared_delay,
        lockout: true,
        priority: false,
        tone_squelch: None,
        tone_squelch_kind: ToneSquelchKind::None,
        tone_dcs_code: None,
        bank: 1,
    }
}

fn parse_ss_channel(f: &[&str], caps: &ScannerCapabilities) -> Result<ChannelData, String> {
    let on = |v: &str| v.eq_ignore_ascii_case("On");
    let index: u16 = f[1].parse().map_err(|_| "bad C-Freq index".to_string())?;
    // Bounded by the CONNECTED scanner, not a hardcoded 500 -- the same class
    // of bug #433 fixed on the CSV path. A BC75XLT holds 300.
    if !(1..=caps.channel_count).contains(&index) {
        return Err(format!(
            "C-Freq index out of range: {} (must be 1-{})",
            index, caps.channel_count
        ));
    }
    let freq_hz: i64 = f[3]
        .parse()
        .map_err(|_| "bad C-Freq frequency".to_string())?;
    if freq_hz == 0 {
        // An empty row is an INSTRUCTION to clear the slot, not an absence of
        // data. `docs/SS_FILE_FORMAT.md`: every slot is written to the file,
        // empty ones included, so a blank file is 500 (or 300) explicit
        // clears. Returning `None` here discarded all of them and left a
        // "Restore full config" leaving stale channels programmed (#621).
        return Ok(cleared_channel(index, caps));
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
    Ok(ChannelData {
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
    })
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
/// A settings write the file asks for: what to send, what to read back, and
/// the first field that read-back must echo.
type SettingJob = (String, String, String);

/// A setting the file carries that this radio has no way to accept.
///
/// Reported to the caller rather than dropped: a "Restore full config" that
/// silently ignores half the file is the bug in #625. `command` is the wire
/// command so the message names something the user can look up.
#[derive(Debug, PartialEq)]
pub(crate) struct SkippedSetting {
    pub command: &'static str,
    pub label: &'static str,
}

/// Build the settings writes this radio can actually take, and name the ones
/// it cannot.
///
/// Gated on `ScannerCapabilities`, never on a model string. Every gate here
/// mirrors one the settings handlers already enforce, because those were
/// established against real hardware:
///
/// - `BLT`/`BSV`/`CNT`/`WXS` answer `ERR` on a BC75XLT, and a stalled command
///   inside the `PRG` bracket is #436.
/// - `SSG` does not exist on that model at all.
/// - `KBP`'s beep field is `[RSV]` there, and `set_key_beep` refuses the WHOLE
///   command rather than sending the key lock alongside a reserved slot -- per
///   the vendor spec a value in a reserved field is a format error that aborts
///   the set command and takes the lock with it.
/// - `CLC` field 5 is `[RSV]` (hardware 2026-08-28), so it goes out EMPTY,
///   exactly as `set_close_call` sends it.
///
/// `CSG` is absent from this list because its write must echo the field shape
/// the radio just reported -- see `csg_write_command`, which needs a wire read
/// and so cannot be built here.
fn settings_jobs(
    s: &SsSettings,
    caps: &ScannerCapabilities,
) -> (Vec<SettingJob>, Vec<SkippedSetting>) {
    let mut jobs: Vec<SettingJob> = Vec::new();
    let mut skipped: Vec<SkippedSetting> = Vec::new();

    // A BLANK column is the tool saying "nothing recorded here", not "set this
    // to empty string" -- the same distinction CLAUDE.md pitfall #9 draws for
    // reserved `CIN` fields, one layer up. A real `.bc75xlt_ss` leaves volume
    // and contrast blank (fixtures/sample.bc75xlt_ss), and sending the literal
    // `VOL,` puts an ERR in the error list of every otherwise-clean restore.
    let value = |v: &Option<String>| v.as_ref().filter(|v| !v.trim().is_empty()).cloned();

    let mut gated =
        |supported: bool, command: &'static str, label: &'static str, job: Option<SettingJob>| {
            match (supported, job) {
                (true, Some(job)) => jobs.push(job),
                (false, Some(_)) => skipped.push(SkippedSetting { command, label }),
                // The file did not carry this setting at all -- nothing to apply
                // and nothing to warn about.
                (_, None) => {}
            }
        };

    gated(
        caps.has_backlight_control,
        "BLT",
        "Backlight",
        value(&s.backlight).map(|v| (format!("BLT,{}", v), "BLT".to_string(), v)),
    );
    gated(
        caps.has_battery_save,
        "BSV",
        "Battery charge time",
        value(&s.charge_time).map(|v| (format!("BSV,{}", v), "BSV".to_string(), v)),
    );
    gated(
        caps.has_key_beep,
        "KBP",
        "Key beep and key lock",
        match (value(&s.beep), value(&s.key_lock)) {
            (Some(b), Some(k)) => Some((format!("KBP,{},{}", b, k), "KBP".to_string(), b)),
            _ => None,
        },
    );
    gated(
        caps.has_contrast,
        "CNT",
        "Display contrast",
        value(&s.contrast).map(|v| (format!("CNT,{}", v), "CNT".to_string(), v)),
    );
    gated(
        caps.has_weather_alert,
        "WXS",
        "Weather alert priority",
        value(&s.wx_pri).map(|v| (format!("WXS,{}", v), "WXS".to_string(), v)),
    );
    gated(
        caps.has_service_search_groups,
        "SSG",
        "Service search groups",
        value(&s.service_flags).map(|v| (format!("SSG,{}", v), "SSG".to_string(), v)),
    );

    // Supported on both families.
    if let Some(v) = value(&s.volume) {
        jobs.push((format!("VOL,{}", v), "VOL".to_string(), v));
    }
    if let Some(v) = value(&s.squelch) {
        jobs.push((format!("SQL,{}", v), "SQL".to_string(), v));
    }
    if let Some(v) = value(&s.priority) {
        jobs.push((format!("PRI,{}", v), "PRI".to_string(), v));
    }
    // Conventional bank enablement. Named explicitly in #625: this is the one
    // the user is most likely to notice missing after a restore.
    // The scanner REFUSES an all-disabled mask (vendor spec; `set_banks`
    // rejects it before the wire for the same reason, CLAUDE.md pitfall #7).
    // A file recording every bank off is not restorable, and saying so beats
    // an opaque `SCG rejected: Err`.
    if let Some(v) = value(&s.scan_flags) {
        if v.chars().all(|c| c == '1') {
            skipped.push(SkippedSetting {
                command: "SCG",
                label:
                    "Bank enablement (the file has every bank disabled, which the scanner refuses)",
            });
        } else {
            jobs.push((format!("SCG,{}", v), "SCG".to_string(), v));
        }
    }
    if let (Some(d), Some(c)) = (value(&s.search_delay), value(&s.search_code)) {
        jobs.push((format!("SCO,{},{}", d, c), "SCO".to_string(), d));
    }
    for (idx, lo, hi) in &s.custom_ranges {
        jobs.push((
            format!("CSP,{},{},{}", idx, lo, hi),
            // CSP read-back is per-index; verify the index echoes.
            format!("CSP,{}", idx),
            idx.to_string(),
        ));
    }
    if let (Some(m), Some(b), Some(l), Some(bands)) = (
        value(&s.cc_mode),
        value(&s.cc_beep),
        value(&s.cc_light),
        value(&s.cc_bands),
    ) {
        // Field 5 is `[RSV]` where the model has no hit scan: written `1` on a
        // BC75XLT it reads back empty (hardware 2026-08-28). A reserved field
        // goes out EMPTY -- a value in one risks the format error that aborts
        // the whole set command. Same shape as `set_close_call`.
        let hit_scan = if caps.has_close_call_hit_scan {
            value(&s.cc_lockout).unwrap_or_else(|| "0".to_string())
        } else {
            String::new()
        };
        jobs.push((
            format!("CLC,{},{},{},{},{}", m, b, l, bands, hit_scan),
            "CLC".to_string(),
            m,
        ));
    }

    (jobs, skipped)
}

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

/// Give every cleared row the slot's EXISTING priority bit.
///
/// This firmware refuses an in-place priority 1->0 `CIN` write: the only
/// mechanism is `clear_channel_priority`'s DCH+rewrite, and a BC75XLT has no
/// `DCH` at all. So clearing a bank's priority channel writes priority=1 and
/// reads back priority=1 -- exactly the tolerance `readback_matches`'
/// zero-frequency branch carries, and what the app's own Clear button already
/// sends. Sending the file's literal `Off` instead would fail that readback
/// and report a spurious clear failure for every priority channel on every
/// restore.
///
/// Read under one lock BEFORE the program-mode bracket opens, so no lock is
/// held across a wire round-trip.
fn carry_stuck_priority(state: &AppState, channels: &mut [ChannelData]) {
    let shadow = state.shadow.read().unwrap();
    apply_stuck_priority(&shadow.channels, channels);
}

/// Body of `carry_stuck_priority`, split out so a guard can drive the REAL
/// function instead of hand-rolling the rule in a test file.
fn apply_stuck_priority(
    existing: &std::collections::HashMap<u16, ChannelData>,
    channels: &mut [ChannelData],
) {
    for ch in channels.iter_mut() {
        if ch.frequency.abs() < 0.00005 {
            ch.priority = existing
                .get(&ch.index)
                .map(|slot| slot.priority)
                .unwrap_or(false);
        }
    }
}

/// Apply every setting in the file this radio can take, and return the ones it
/// cannot.
///
/// Each write is read-back verified and each rejection is non-fatal and
/// recorded -- a bad `BSV` value must not cost the user their channels. The
/// caller holds the program-mode bracket.
///
/// This used to exist only on the BC125AT path; a BC75XLT import applied no
/// settings at all while the UI promised a full restore (#625).
async fn apply_ss_settings(
    state: &AppState,
    settings: &SsSettings,
    caps: &ScannerCapabilities,
    applied: &mut usize,
    errors: &mut Vec<Value>,
) -> Vec<SkippedSetting> {
    import_progress(state, "import-ss", 85, "Applying settings…");
    let (mut jobs, skipped) = settings_jobs(settings, caps);

    // `CSG` cannot be built without a wire read: its field count is per-family
    // and only the READ reports it. See `csg_write_command`.
    if let Some(flags) = settings
        .custom_flags
        .as_ref()
        .filter(|f| !f.trim().is_empty())
    {
        match settings::csg_write_command(state, flags).await {
            Ok(write) => jobs.push((write, "CSG".to_string(), flags.clone())),
            Err(e) => errors.push(json!({ "setting": "CSG", "error": format!("{:?}", e) })),
        }
    }

    for (write_cmd, read_cmd, expect) in jobs {
        match write_setting_verified(state, &write_cmd, &read_cmd, &expect).await {
            Ok(()) => *applied += 1,
            Err(e) => errors.push(json!({ "setting": write_cmd, "error": e })),
        }
    }
    skipped
}

fn skipped_json(skipped: &[SkippedSetting]) -> Vec<Value> {
    skipped
        .iter()
        .map(|s| json!({ "command": s.command, "label": s.label }))
        .collect()
}

/// Import a `.bc75xlt_ss` file.
///
/// Channels AND every setting this model can take. It was channels-only, on
/// the reasoning that the file's settings section is written by a tool that
/// can send `BLT`/`BSV`/`CNT`/`WXS` while this radio answers `ERR` to all four
/// (#436) -- but that is an argument for gating those four, not for dropping
/// the bank mask, priority, custom search and Close Call along with them. The
/// UI called it a full restore either way (#625). `settings_jobs` gates on
/// `ScannerCapabilities`; whatever it refuses comes back in `settings_skipped`
/// so the user is told rather than misled.
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
    let total = cfg.channels.len();

    // Substitute each channel's existing delay BEFORE the bracket opens, so
    // the shadow read is not holding a lock across a wire round-trip.
    let mut channels: Vec<ChannelData> = {
        let shadow = state.shadow.read().unwrap();
        cfg.channels
            .iter()
            .map(|ch| {
                let mut ch = ch.clone();
                // A cleared row already carries `cleared_delay`, which is what
                // the radio stamps on an empty slot and what `is_factory_empty`
                // checks for. Substituting the slot's old programmed delay
                // there would describe a channel that is about to stop
                // existing.
                if ch.frequency.abs() >= 0.00005 {
                    ch.delay = shadow
                        .channels
                        .get(&ch.index)
                        .map(|existing| existing.delay)
                        .unwrap_or(caps.cleared_delay);
                }
                ch
            })
            .collect()
    };
    carry_stuck_priority(&state, &mut channels);

    let _prg = ProgramModeGuard::enter(&state).await?;
    for (n, ch) in channels.iter().enumerate() {
        let mut r = write_channel_to_scanner(&state, ch).await;
        if r.is_err() {
            r = write_channel_to_scanner(&state, ch).await;
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
                state
                    .shadow
                    .write()
                    .unwrap()
                    .channels
                    .insert(verified.index, verified);
            }
            Err(e) => errors.push(json!({ "index": ch.index, "error": format!("{:?}", e) })),
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
    let mut settings_applied = 0usize;
    let skipped = apply_ss_settings(
        &state,
        &cfg.settings,
        &caps,
        &mut settings_applied,
        &mut errors,
    )
    .await;

    import_progress(&state, "import-ss", 100, "Import complete");

    Ok(Json(json!({
        "imported": imported,
        "total": total,
        "settings_applied": settings_applied,
        "settings_skipped": skipped_json(&skipped),
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
    let mut settings_applied = 0usize;
    let mut channels = cfg.channels.clone();
    carry_stuck_priority(&state, &mut channels);
    let total = channels.len();

    let _prg = ProgramModeGuard::enter(&state).await?;

    // --- channels (fast path, retry once — mirrors CSV import) ---
    for (n, ch) in channels.iter().enumerate() {
        let mut r = write_channel_to_scanner(&state, ch).await;
        if r.is_err() {
            r = write_channel_to_scanner(&state, ch).await;
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
                state
                    .shadow
                    .write()
                    .unwrap()
                    .channels
                    .insert(verified.index, verified);
            }
            Err(e) => errors.push(json!({ "index": ch.index, "error": format!("{:?}", e) })),
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

    // --- settings (capability-gated, write-verified, non-fatal) ---
    let skipped = apply_ss_settings(
        &state,
        &cfg.settings,
        &caps,
        &mut settings_applied,
        &mut errors,
    )
    .await;

    import_progress(&state, "import-ss", 100, "Import complete");
    Ok(Json(json!({
        "imported": imported,
        // Every slot the file names, INCLUDING the ones it says are empty --
        // those are clears, not absences (#621). A blank file is 500 attempted
        // writes, not 0.
        "total": total,
        "settings_applied": settings_applied,
        "settings_skipped": skipped_json(&skipped),
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
        let ch = parse_ss_channel(&f, &BC125AT_FAMILY).unwrap();
        assert_eq!(ch.index, 1);
        assert!((ch.frequency - 145.13).abs() < 0.00005);
        assert_eq!(ch.alpha_tag, "Ararat UHF");
        assert_eq!(ch.delay, 2);
        assert!(!ch.lockout);
    }

    /// REGRESSION GUARD (#621): an empty row is a CLEAR, not an absence.
    ///
    /// This used to assert `is_none()` -- the parser dropped every empty row,
    /// so a "Restore full config" never cleared anything and stale channels
    /// survived wherever the file said `freqHz=0`. The row must survive
    /// parsing wearing the exact shape `is_factory_empty` recognises, or
    /// `write_channel_to_scanner` rejects the readback.
    ///
    /// Paired with `an_empty_row_is_shaped_for_the_connected_model`: asserting
    /// only "some channel came back" passes for a build that emits a row the
    /// radio will refuse.
    #[test]
    fn cfreq_zero_freq_is_a_clear_not_a_dropped_row() {
        let line = "C-Freq\t6\tAUTO\t0\tAUTO\tOff\tOff\t2\tOff";
        let f: Vec<&str> = line.split('\t').collect();
        let ch = parse_ss_channel(&f, &BC125AT_FAMILY).unwrap();
        assert_eq!(ch.index, 6);
        assert_eq!(ch.frequency, 0.0);
        assert!(crate::api::is_factory_empty(&ch, &BC125AT_FAMILY));
    }

    /// The cleared shape is MODEL-DEPENDENT, and getting it wrong is silent.
    ///
    /// `cleared_delay` is 2 on the BC125AT family and 0 on a BC75XLT
    /// (hardware 2026-08-26). A clear carrying the wrong one fails
    /// `is_factory_empty` on readback, which surfaces as
    /// `channel_not_persisted` AFTER the write already landed -- the exact
    /// shape of #402. Hardcoding either value reproduces that bug on the
    /// other radio, so both are pinned.
    #[test]
    fn an_empty_row_is_shaped_for_the_connected_model() {
        let line = "C-Freq\t6\t\t0\t\t\tOff\t2\tOff";
        let f: Vec<&str> = line.split('\t').collect();
        for caps in [&BC125AT_FAMILY, &BC75XLT] {
            let ch = parse_ss_channel(&f, caps).unwrap();
            assert_eq!(ch.delay, caps.cleared_delay, "{}", caps.ss_format);
            assert!(
                crate::api::is_factory_empty(&ch, caps),
                "cleared row is not factory-empty on {}",
                caps.ss_format
            );
        }
    }

    /// The empty row must also SURVIVE the write payload builder.
    ///
    /// `build_cin_write_payload_for` rejects a delay the model does not
    /// accept, and the vendor spec aborts the whole `CIN` on one bad field.
    /// A cleared row that cannot be encoded is a clear that never happens.
    #[test]
    fn an_empty_row_encodes_to_a_writable_cin_payload() {
        let line = "C-Freq\t6\t\t0\t\t\tOff\t2\tOff";
        let f: Vec<&str> = line.split('\t').collect();
        for caps in [&BC125AT_FAMILY, &BC75XLT] {
            let ch = parse_ss_channel(&f, caps).unwrap();
            let payload = crate::api::build_cin_write_payload_for(&ch, caps)
                .unwrap_or_else(|e| panic!("{} clear is unwritable: {:?}", caps.ss_format, e));
            assert!(
                payload.contains("00000000"),
                "{} clear must send frequency 0: {payload}",
                caps.ss_format
            );
        }
    }

    #[test]
    fn cfreq_lockout_priority_on() {
        let line = "C-Freq\t3\tRepeater\t146940000\tFM\tOff\tOn\t2\tOn";
        let f: Vec<&str> = line.split('\t').collect();
        let ch = parse_ss_channel(&f, &BC125AT_FAMILY).unwrap();
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
            let parsed = parse_ss_channel(&fields, &BC125AT_FAMILY).expect("exported row parses");

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
            let parsed = parse_ss_channel(&fields, &BC125AT_FAMILY).expect("tone parses");
            let payload = crate::api::build_cin_write_payload_for(&parsed, &BC125AT_FAMILY)
                .expect("tone encodes");
            assert_eq!(payload.split(',').nth(3), Some(expected_code), "{label}");
        }
    }

    /// REGRESSION GUARD (#621): a blank file is 300 CLEARS, not zero work.
    ///
    /// `fixtures/blank.bc75xlt_ss` is a `New` -> `Save As` from Uniden's own
    /// software: 300 empty channels. This used to assert `channels.is_empty()`
    /// and it passed for a build that reported `Config restored (0 channels)`
    /// while leaving every programmed channel on the radio untouched.
    ///
    /// The count must cover `1..=channel_count` with no gaps -- a build that
    /// emitted only the first row, or shifted the indices, satisfies a bare
    /// length check.
    #[test]
    fn a_blank_bc75xlt_file_parses_to_a_clear_for_every_slot() {
        let text = include_str!("../../../fixtures/blank.bc75xlt_ss");
        let cfg = parse_ss_config(text, &BC75XLT);
        assert!(
            cfg.errors.is_empty(),
            "a file the tool itself wrote must parse cleanly: {:?}",
            cfg.errors
        );
        assert_eq!(
            cfg.channels.len(),
            BC75XLT.channel_count as usize,
            "every slot in a blank file is an explicit clear"
        );
        let indices: Vec<u16> = cfg.channels.iter().map(|c| c.index).collect();
        assert_eq!(
            indices,
            (1..=BC75XLT.channel_count).collect::<Vec<u16>>(),
            "clears must cover every slot in order"
        );
        assert!(
            cfg.channels
                .iter()
                .all(|c| crate::api::is_factory_empty(c, &BC75XLT)),
            "every row of a blank file must be a factory-empty clear"
        );
    }

    /// The same, on the other family -- 500 slots and a different
    /// `cleared_delay`. Pinning only the BC75XLT half passes for a build that
    /// hardcodes 300 or 0.
    #[test]
    fn a_blank_bc125at_file_parses_to_a_clear_for_every_slot() {
        let text = include_str!("../../../fixtures/blank.bc125at_ss");
        let cfg = parse_ss_config(text, &BC125AT_FAMILY);
        assert!(cfg.errors.is_empty(), "{:?}", cfg.errors);
        assert_eq!(cfg.channels.len(), BC125AT_FAMILY.channel_count as usize);
        assert!(
            cfg.channels
                .iter()
                .all(|c| crate::api::is_factory_empty(c, &BC125AT_FAMILY)),
            "every row of a blank file must be a factory-empty clear"
        );
    }

    /// A mixed file must match the file row-for-row: programmed rows stay
    /// programmed, empty rows become clears. A build that dropped empties
    /// passes `sample`'s programmed count on its own.
    #[test]
    fn a_mixed_file_yields_a_row_per_slot_matching_the_file() {
        let text = include_str!("../../../fixtures/sample.bc75xlt_ss");
        let cfg = parse_ss_config(text, &BC75XLT);
        assert!(cfg.errors.is_empty(), "{:?}", cfg.errors);
        assert_eq!(cfg.channels.len(), BC75XLT.channel_count as usize);

        let file_empty: Vec<u16> = text
            .lines()
            .map(|l| l.split('\t').collect::<Vec<&str>>())
            .filter(|f| f.first().copied() == Some("C-Freq") && f.len() >= 9 && f[3] == "0")
            .filter_map(|f| f[1].parse::<u16>().ok())
            .collect();
        assert!(
            !file_empty.is_empty() && file_empty.len() < BC75XLT.channel_count as usize,
            "this fixture must be genuinely mixed to be a useful guard"
        );
        for ch in &cfg.channels {
            let should_be_empty = file_empty.contains(&ch.index);
            assert_eq!(
                crate::api::is_factory_empty(ch, &BC75XLT),
                should_be_empty,
                "slot {} disagrees with the file",
                ch.index
            );
        }
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
        let ch = parse_ss_channel(&f, &BC75XLT).expect("parses");
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
        let ch = parse_ss_channel(&f, &BC125AT_FAMILY).expect("parses");
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

    /// REGRESSION GUARD (#621): a clear carries the slot's EXISTING priority
    /// bit, and touches nothing else.
    ///
    /// The firmware refuses an in-place priority 1->0 `CIN` write -- a
    /// BC75XLT has no `DCH` to force it at all -- so `readback_matches`'
    /// zero-frequency branch only tolerates a stuck priority when we WROTE
    /// priority=1. A restore that sent the file's literal `Off` would fail
    /// the readback and report a clear failure for every priority channel on
    /// the radio, on every restore, for a clear that actually landed.
    ///
    /// The second half is not decoration: a build that stamped priority on
    /// EVERY row would satisfy the first assertion and would silently
    /// displace each bank's priority holder as the import walked it.
    #[test]
    fn a_clear_carries_the_slots_existing_priority_and_leaves_programmed_rows_alone() {
        use std::collections::HashMap;

        let mut existing: HashMap<u16, ChannelData> = HashMap::new();
        // Slot 4 is in the shadow AND holds priority: a build that skipped the
        // zero-frequency check would stamp that onto the PROGRAMMED row 4 and
        // silently displace the bank's holder. Without it here, rows[3] falls
        // through `unwrap_or(false)` and the assertion passes either way.
        for (index, priority) in [(1u16, true), (2, false), (3, true), (4, true)] {
            let mut slot = cleared_channel(index, &BC125AT_FAMILY);
            slot.frequency = 146.0;
            slot.priority = priority;
            existing.insert(index, slot);
        }

        let mut programmed = cleared_channel(4, &BC125AT_FAMILY);
        programmed.frequency = 145.13;
        programmed.priority = false;

        let mut rows = vec![
            cleared_channel(1, &BC125AT_FAMILY), // slot holds priority
            cleared_channel(2, &BC125AT_FAMILY), // slot does not
            cleared_channel(9, &BC125AT_FAMILY), // slot unknown to the shadow
            programmed,
        ];
        apply_stuck_priority(&existing, &mut rows);

        assert!(
            rows[0].priority,
            "a clear of a priority channel must send 1"
        );
        assert!(!rows[1].priority, "a clear of a plain channel must send 0");
        assert!(
            !rows[2].priority,
            "an unknown slot must not invent priority"
        );
        assert!(
            !rows[3].priority,
            "a PROGRAMMED row must keep the file's priority, not the shadow's"
        );
    }

    /// Every wire command `settings_jobs` produced, in order.
    fn commands(jobs: &[SettingJob]) -> Vec<String> {
        jobs.iter()
            .map(|(w, _, _)| w.split(',').next().unwrap_or_default().to_string())
            .collect()
    }

    /// REGRESSION GUARD (#625): a BC75XLT restore applies the settings that
    /// model CAN take.
    ///
    /// `import_bc75xlt_ss` was channels-only and always returned
    /// `settings_applied: 0`, while the shared UI promised "This overwrites
    /// all channels and settings". Bank enablement, priority, custom search
    /// and Close Call all have write paths the settings handlers already
    /// exercise on that radio -- dropping them along with the four commands it
    /// genuinely refuses was a much bigger hole than the four.
    ///
    /// Paired with `a_bc75xlt_reports_the_settings_it_cannot_take`: this one
    /// alone passes for a build that writes EVERYTHING, including the four
    /// that `ERR` and stall the PRG bracket (#436).
    #[test]
    fn a_bc75xlt_restore_applies_the_settings_that_model_supports() {
        let text = include_str!("../../../fixtures/sample.bc75xlt_ss");
        let cfg = parse_ss_config(text, &BC75XLT);
        let (jobs, _) = settings_jobs(&cfg.settings, &BC75XLT);
        let sent = commands(&jobs);

        for expected in ["SQL", "PRI", "SCG", "SCO", "CSP", "CLC"] {
            assert!(
                sent.iter().any(|c| c == expected),
                "{expected} must be restored on a BC75XLT; got {sent:?}"
            );
        }
    }

    /// The other half: the four commands this radio answers `ERR` to, plus the
    /// two whose fields are reserved, must NOT reach the wire -- and must be
    /// REPORTED rather than silently dropped.
    ///
    /// A stalled command inside the `PRG` bracket is #436; a reserved field
    /// carrying a value is a format error that aborts the whole set command.
    #[test]
    fn a_bc75xlt_reports_the_settings_it_cannot_take() {
        let text = include_str!("../../../fixtures/sample.bc75xlt_ss");
        let cfg = parse_ss_config(text, &BC75XLT);
        let (jobs, skipped) = settings_jobs(&cfg.settings, &BC75XLT);
        let sent = commands(&jobs);
        let named: Vec<&str> = skipped.iter().map(|s| s.command).collect();

        for unsupported in ["BLT", "BSV", "CNT", "WXS", "SSG", "KBP"] {
            assert!(
                !sent.contains(&unsupported.to_string()),
                "{unsupported} must never reach a BC75XLT; got {sent:?}"
            );
        }
        // The file carries a backlight column and a service-group section, so
        // those two must be REPORTED, not merely absent. A build that dropped
        // them silently -- the #625 bug -- satisfies the loop above.
        for reported in ["BLT", "SSG"] {
            assert!(
                named.contains(&reported),
                "{reported} is in the file and must be reported unsupported; got {named:?}"
            );
        }
    }

    /// The gate is the CAPABILITY, not the file format. The same settings on a
    /// BC125AT must produce the full job list and report nothing unsupported.
    ///
    /// Pinning only the BC75XLT half passes for a build that hardcodes the
    /// skip list and starves every radio of `BLT`/`BSV`/`CNT`/`WXS`.
    #[test]
    fn a_bc125at_takes_every_setting_the_file_carries() {
        let text = include_str!("../../../fixtures/sample.bc75xlt_ss");
        let cfg = parse_ss_config(text, &BC125AT_FAMILY);
        let (jobs, skipped) = settings_jobs(&cfg.settings, &BC125AT_FAMILY);
        let sent = commands(&jobs);

        assert!(
            skipped.is_empty(),
            "nothing is unsupported on a BC125AT; got {:?}",
            skipped.iter().map(|s| s.command).collect::<Vec<&str>>()
        );
        for expected in ["BLT", "BSV", "SSG", "SCG", "CLC"] {
            assert!(
                sent.iter().any(|c| c == expected),
                "{expected} must be restored on a BC125AT; got {sent:?}"
            );
        }
    }

    /// REGRESSION GUARD (#625): `CLC` field 5 is `[RSV]` where the model has
    /// no hit scan, and a reserved field goes out EMPTY.
    ///
    /// Written `1` on a BC75XLT it reads back empty (hardware 2026-08-28), and
    /// per the vendor spec a value in a reserved slot is a format error that
    /// aborts the WHOLE `CLC` -- taking the mode, beep, light and band mask
    /// with it. Both models are asserted: checking only that the BC75XLT field
    /// is empty passes for a build that blanks it everywhere and quietly drops
    /// the BC125AT's Close Call lockout.
    #[test]
    fn the_reserved_close_call_field_goes_out_empty_where_it_is_reserved() {
        let text = "CloseCall\tPri\tOn\tOn\tOn\nCloseCallBands\tOn\tOn\tOn\tOff\tOn\n";

        let cfg = parse_ss_config(text, &BC75XLT);
        let (jobs, _) = settings_jobs(&cfg.settings, &BC75XLT);
        let clc = jobs
            .iter()
            .find(|(w, _, _)| w.starts_with("CLC,"))
            .expect("CLC is restorable on a BC75XLT");
        assert!(
            clc.0.ends_with(','),
            "the reserved hit-scan field must go out empty: {}",
            clc.0
        );

        let cfg = parse_ss_config(text, &BC125AT_FAMILY);
        let (jobs, _) = settings_jobs(&cfg.settings, &BC125AT_FAMILY);
        let clc = jobs
            .iter()
            .find(|(w, _, _)| w.starts_with("CLC,"))
            .expect("CLC is restorable on a BC125AT");
        assert!(
            clc.0.ends_with(",1"),
            "a model WITH hit scan must carry the file's value: {}",
            clc.0
        );
    }

    /// A BLANK column is "nothing recorded", not "set this to empty string".
    ///
    /// A real `.bc75xlt_ss` leaves volume and contrast blank
    /// (fixtures/sample.bc75xlt_ss). Sending the literal `VOL,` earns an `ERR`
    /// and puts a failure in the error list of every otherwise-clean restore,
    /// which reads to the user exactly like a broken import.
    #[test]
    fn a_blank_column_is_not_a_setting_to_write() {
        let text = include_str!("../../../fixtures/sample.bc75xlt_ss");
        let cfg = parse_ss_config(text, &BC75XLT);
        assert_eq!(
            cfg.settings.volume.as_deref(),
            Some(""),
            "this guard is only meaningful while the fixture's volume is blank"
        );
        let (jobs, skipped) = settings_jobs(&cfg.settings, &BC75XLT);
        assert!(
            !jobs.iter().any(|(w, _, _)| w.starts_with("VOL")),
            "a blank column must produce no write: {:?}",
            commands(&jobs)
        );
        assert!(
            !skipped.iter().any(|s| s.command == "VOL"),
            "a blank column is not an UNSUPPORTED setting either -- there is \
             nothing to warn about"
        );
    }

    /// An all-disabled bank mask is refused by the scanner (vendor spec), so
    /// it is caught before the wire and named -- not sent and reported as an
    /// opaque `SCG rejected: Err`. Same guard `set_banks` carries.
    #[test]
    fn an_all_disabled_bank_mask_is_refused_before_the_wire() {
        let mut off = String::new();
        for i in 1..=10 {
            off.push_str(&format!("Conventional\t{i}\tBank {i}\tOff\n"));
        }
        let cfg = parse_ss_config(&off, &BC75XLT);
        assert_eq!(cfg.settings.scan_flags.as_deref(), Some("1111111111"));
        let (jobs, skipped) = settings_jobs(&cfg.settings, &BC75XLT);
        assert!(
            !jobs.iter().any(|(w, _, _)| w.starts_with("SCG")),
            "an all-disabled mask must not reach the wire"
        );
        assert!(skipped.iter().any(|s| s.command == "SCG"));

        // One bank on is restorable, so the guard is not just "never write SCG".
        let mut one_on = off.replace(
            "Conventional\t3\tBank 3\tOff",
            "Conventional\t3\tBank 3\tOn",
        );
        one_on.push('\n');
        let cfg = parse_ss_config(&one_on, &BC75XLT);
        let (jobs, _) = settings_jobs(&cfg.settings, &BC75XLT);
        assert!(jobs.iter().any(|(w, _, _)| w.starts_with("SCG,")));
    }
}
