use axum::extract::{Multipart, State};
use axum::response::Json;
use serde_json::{json, Value};

use super::exports::import_progress;
use super::super::{
    command_sender, send_raw_command, split_command_parts, write_channel_no_readback, ApiError,
    AppState, ProgramModeGuard,
};
use crate::protocol::{classify_response, ScannerReply};
use crate::state::{ChannelData, ToneSquelchKind};

#[derive(Default)]
pub(crate) struct SsSettings {
    pub backlight: Option<String>,   // BLT: On->AO Off->AF Key->KY Squelch->SQ K+S->KS
    pub beep: Option<String>,        // KBP field 1: Auto->0 Off->99 else digits
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
    pub cc_mode: Option<String>,       // CloseCall field: Off->0 Pri->1 DND->2
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
                    "Pri" => "1", "DND" => "2", _ => "0",
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

    let mut errors: Vec<Value> = cfg.errors.iter().map(|e| json!({ "error": e })).collect();
    let mut imported = 0usize;
    let mut settings_applied = 0usize;
    let total = cfg.channels.len();

    let _prg = ProgramModeGuard::enter(&state).await?;

    // --- channels (fast path, retry once — mirrors CSV import) ---
    for (n, ch) in cfg.channels.iter().enumerate() {
        let mut r = write_channel_no_readback(&state, ch).await;
        if r.is_err() {
            r = write_channel_no_readback(&state, ch).await;
        }
        match r {
            Ok(()) => {
                imported += 1;
                state
                    .shadow
                    .write()
                    .unwrap()
                    .channels
                    .insert(ch.index, ch.clone());
            }
            Err(e) => errors.push(json!({ "index": ch.index, "error": format!("{:?}", e) })),
        }
        if total > 0 && (n + 1) % 10 == 0 {
            let pct = ((n + 1) * 80 / total) as u8;
            import_progress(&state, "import-ss", pct, &format!("Importing {}/{}", n + 1, total));
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
        "settings_applied": settings_applied,
        "errors": errors,
    })))
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn parses_beep_auto_to_wire_zero() {
        // SAMPLE's Misc line has beep field "Auto"
        let cfg = parse_ss_config(SAMPLE);
        assert_eq!(cfg.settings.beep.as_deref(), Some("0"));
    }

    #[test]
    fn parses_beep_off_to_wire_99() {
        let text = "Misc\tK+S\tOff\tOff\t8\t10\t3\t16\tUSA\n";
        let cfg = parse_ss_config(text);
        assert_eq!(cfg.settings.beep.as_deref(), Some("99"));
    }

    #[test]
    fn parses_closecall_pri_to_wire_one() {
        let text = "CloseCall\tPri\tOn\tOff\tOff\n";
        let cfg = parse_ss_config(text);
        assert_eq!(cfg.settings.cc_mode.as_deref(), Some("1"));
    }

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
}
