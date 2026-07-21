use axum::extract::{Multipart, State};
use axum::response::{IntoResponse, Json};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::protocol::tones::dcs_code_to_label;
use crate::state::{ChannelData, ToneSquelchKind};

use super::super::security::validate_wire_field;
use super::super::{
    command_sender, csv_escape, flags_to_bools, on_off, send_raw_command, split_command_parts,
    write_channel_no_readback, ApiError, AppState, ProgramModeGuard,
};

pub(crate) async fn export_bc125at_ss_file(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let _ = command_sender(&state)?;
    if state.sync_task_id.lock().unwrap().is_some() {
        return Err(ApiError::Conflict("sync_in_progress".to_string()));
    }
    let model = state
        .device
        .read()
        .ok()
        .and_then(|d| d.model.clone())
        .unwrap_or_default()
        .to_uppercase();
    if !model.contains("BC125AT") && !model.contains("UBC125") {
        return Err(ApiError::BadRequest("unsupported_model".to_string()));
    }
    let region = if model.contains("UBC") { "EUR" } else { "USA" };

    let result = async {
        let _prg = ProgramModeGuard::enter(&state).await?;

        let backlight = split_command_parts(&send_raw_command(&state, "BLT", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "AF".to_string());
        let kbp = split_command_parts(&send_raw_command(&state, "KBP", false).await?);
        let beep_level = kbp.first().cloned().unwrap_or_else(|| "99".to_string());
        let key_lock = kbp.get(1).cloned().unwrap_or_else(|| "0".to_string());
        let charge_time = split_command_parts(&send_raw_command(&state, "BSV", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "16".to_string());
        let priority_mode = split_command_parts(&send_raw_command(&state, "PRI", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "0".to_string());
        let scan_flags = split_command_parts(&send_raw_command(&state, "SCG", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "1111111111".to_string());
        let sco = split_command_parts(&send_raw_command(&state, "SCO", false).await?);
        let search_delay = sco.first().cloned().unwrap_or_else(|| "0".to_string());
        let search_code = sco.get(1).cloned().unwrap_or_else(|| "0".to_string());
        let clc = split_command_parts(&send_raw_command(&state, "CLC", false).await?);
        let cc_mode = clc.first().cloned().unwrap_or_else(|| "0".to_string());
        let cc_beep = clc.get(1).cloned().unwrap_or_else(|| "0".to_string());
        let cc_light = clc.get(2).cloned().unwrap_or_else(|| "0".to_string());
        let cc_bands = clc.get(3).cloned().unwrap_or_else(|| "11111".to_string());
        let cc_lockout = clc.get(4).cloned().unwrap_or_else(|| "0".to_string());
        let service_flags = split_command_parts(&send_raw_command(&state, "SSG", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "1111111111".to_string());
        let custom_flags = split_command_parts(&send_raw_command(&state, "CSG", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "1111111111".to_string());
        let wx_pri = split_command_parts(&send_raw_command(&state, "WXS", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "0".to_string());
        let contrast = split_command_parts(&send_raw_command(&state, "CNT", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "8".to_string());
        let volume = split_command_parts(&send_raw_command(&state, "VOL", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "0".to_string());
        let squelch = split_command_parts(&send_raw_command(&state, "SQL", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "0".to_string());

        let mut custom_ranges = Vec::new();
        for idx in 1..=10 {
            let csp = split_command_parts(
                &send_raw_command(&state, &format!("CSP,{}", idx), false).await?,
            );
            let lower_hz = csp
                .get(1)
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v * 100)
                .unwrap_or(0);
            let upper_hz = csp
                .get(2)
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v * 100)
                .unwrap_or(0);
            custom_ranges.push((idx, lower_hz, upper_hz));
        }

        // Channels come from the shadow cache (populated by memory sync), not
        // a live CIN walk. Re-reading all 500 channels over the wire took
        // ~150s (300ms x 500) and blew past client timeouts, so the export
        // "did nothing". CSV export already reads the cache; this matches it.
        // Both reflect the last memory sync. The tone column is rebuilt to the
        // same label format the CIN walk produced (`tone_code_label`).
        // (index, name, frequency_hz, modulation, tone, lockout, delay, priority)
        type SsChannelRow = (u16, String, i64, String, String, String, String, String);
        let channels: Vec<SsChannelRow> = {
            let shadow = state.shadow.read().unwrap();
            let mut cached: Vec<ChannelData> = shadow.channels.values().cloned().collect();
            cached.sort_by_key(|c| c.index);
            cached
                .into_iter()
                .map(|ch| {
                    let tone = match ch.tone_squelch_kind {
                        ToneSquelchKind::Ctcss => ch
                            .tone_squelch
                            .map(|hz| format!("{:.1}", hz))
                            .unwrap_or_else(|| "Off".to_string()),
                        ToneSquelchKind::Dcs => ch
                            .tone_dcs_code
                            .and_then(dcs_code_to_label)
                            .unwrap_or_else(|| "Off".to_string()),
                        ToneSquelchKind::Search => "Srch".to_string(),
                        ToneSquelchKind::None => "Off".to_string(),
                    };
                    (
                        ch.index,
                        ch.alpha_tag,
                        (ch.frequency * 1_000_000.0).round() as i64,
                        ch.modulation,
                        tone,
                        on_off(if ch.lockout { "1" } else { "0" }).to_string(),
                        ch.delay.to_string(),
                        on_off(if ch.priority { "1" } else { "0" }).to_string(),
                    )
                })
                .collect()
        };

        const SERVICE_NAMES: [&str; 10] = [
            "Police",
            "Fire/Emergency",
            "HAM Radio",
            "Marine",
            "Railroad",
            "Civil Air",
            "Military Air",
            "CB Radio",
            "FRS/GMRS/MURS",
            "Racing",
        ];
        let backlight_display = match backlight.as_str() {
            "AO" => "On",
            "AF" => "Off",
            "KY" => "Key",
            "SQ" => "Squelch",
            "KS" => "K+S",
            _ => "Off",
        };
        let priority_display = match priority_mode.as_str() {
            "1" => "On",
            "2" => "Plus",
            "3" => "DND",
            _ => "Off",
        };
        let cc_mode_display = match cc_mode.as_str() {
            "1" => "Pri",
            "2" => "DND",
            _ => "Off",
        };
        let misc_beep = if beep_level == "0" {
            "Auto".to_string()
        } else if beep_level == "99" {
            "Off".to_string()
        } else {
            beep_level
        };

        let mut lines = Vec::new();
        lines.push(format!(
            "Misc\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            backlight_display,
            misc_beep,
            on_off(&key_lock),
            contrast,
            volume,
            squelch,
            charge_time,
            region
        ));
        lines.push(format!("Priority\t{}", priority_display));
        lines.push(format!("WxPri\t{}", on_off(&wx_pri)));

        let service_enabled = flags_to_bools(&service_flags);
        for (idx, name) in SERVICE_NAMES.iter().enumerate() {
            let enabled = if service_enabled.get(idx).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            };
            lines.push(format!("Service\t{}\t{}\t{}", idx + 1, name, enabled));
        }

        let custom_enabled = flags_to_bools(&custom_flags);
        for (idx, lower_hz, upper_hz) in custom_ranges {
            let enabled = if custom_enabled
                .get((idx - 1) as usize)
                .copied()
                .unwrap_or(false)
            {
                "On"
            } else {
                "Off"
            };
            lines.push(format!(
                "Custom\t{}\tSearch Bnak{}\t{}\t{}\t{}",
                idx, idx, lower_hz, upper_hz, enabled
            ));
        }

        lines.push(format!(
            "CloseCall\t{}\t{}\t{}\t{}",
            cc_mode_display,
            on_off(&cc_beep),
            on_off(&cc_light),
            on_off(&cc_lockout)
        ));

        // CLC close-call bands use '1' = enabled (confirmed by wire probe:
        // raw "01001" reads as [off,on,off,off,on] via the canonical
        // get_close_call reader). NOT the '0' = enabled convention of the
        // SCG/SSG/CSG masks, so don't use flags_to_bools here.
        let cc_band_flags: Vec<bool> = cc_bands.chars().map(|c| c == '1').collect();
        lines.push(format!(
            "CloseCallBands\t{}\t{}\t{}\t{}\t{}",
            if cc_band_flags.first().copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            },
            if cc_band_flags.get(1).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            },
            if cc_band_flags.get(2).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            },
            if cc_band_flags.get(3).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            },
            if cc_band_flags.get(4).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            }
        ));

        lines.push(format!(
            "GeneralSearch\t{}\t{}",
            search_delay,
            on_off(&search_code)
        ));

        let scan_enabled = flags_to_bools(&scan_flags);
        for idx in 1..=10 {
            let enabled = if scan_enabled.get(idx - 1).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            };
            lines.push(format!("Conventional\t{}\tBank {}\t{}", idx, idx, enabled));
        }

        for (idx, name, frequency_hz, modulation, tone, lockout, delay, priority) in channels {
            lines.push(format!(
                "C-Freq\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                idx, name, frequency_hz, modulation, tone, lockout, delay, priority
            ));
        }

        Ok::<String, ApiError>(format!("{}\n", lines.join("\n")))
    }
    .await;
    let payload = result?;

    Ok((
        [
            ("content-type", "text/plain"),
            (
                "content-disposition",
                "attachment; filename=scanner.bc125at_ss",
            ),
        ],
        payload,
    ))
}

pub(crate) async fn export_csv(State(state): State<AppState>) -> impl IntoResponse {
    let mut rows = Vec::new();
    rows.push(
        "Index,Frequency,Modulation,Alpha Tag,Delay,Lockout,Priority,CTCSS/DCS,Bank".to_string(),
    );

    let shadow = state.shadow.read().unwrap();
    let mut channels: Vec<ChannelData> = shadow.channels.values().cloned().collect();
    channels.sort_by_key(|c| c.index);
    for ch in channels {
        rows.push(format!(
            "{},{},{},{},{},{},{},{},{}",
            ch.index,
            ch.frequency,
            ch.modulation,
            csv_escape(&ch.alpha_tag),
            ch.delay,
            ch.lockout,
            ch.priority,
            ch.tone_squelch.map(|v| v.to_string()).unwrap_or_default(),
            ch.bank
        ));
    }

    (
        [
            ("content-type", "text/csv"),
            ("content-disposition", "attachment; filename=channels.csv"),
        ],
        rows.join("\n"),
    )
}

pub(crate) async fn import_csv(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Reject if a memory sync is running — both hold the single-threaded wire
    // for a long PRG bracket; racing them contends for the command channel.
    if state.sync_task_id.lock().unwrap().is_some() {
        return Err(ApiError::Conflict("sync_in_progress".to_string()));
    }
    let mut csv_bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("multipart_error: {}", e)))?
    {
        if field.name() == Some("file") {
            let bytes = field
                .bytes()
                .await
                .map_err(|e| ApiError::BadRequest(format!("upload_error: {}", e)))?;
            csv_bytes = Some(bytes.to_vec());
            break;
        }
    }

    let Some(bytes) = csv_bytes else {
        return Err(ApiError::BadRequest("file_required".to_string()));
    };

    let mut imported = 0;
    let mut errors: Vec<Value> = Vec::new();

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(bytes.as_slice());

    // Parse every row up front. Rows that fail to parse are recorded as errors
    // now; only the valid payloads reach the wire. Knowing the total lets us
    // stream a meaningful "N/total" progress percent.
    let mut writes: Vec<(HashMap<String, String>, ChannelData)> = Vec::new();
    for result in rdr.deserialize::<HashMap<String, String>>() {
        match result {
            Ok(row) => match parse_import_csv_row(&row) {
                Ok(Some(payload)) => writes.push((row, payload)),
                Ok(None) => {} // empty slot (frequency 0) — skip, not an error
                Err(err) => errors.push(json!({ "row": row, "error": err })),
            },
            Err(err) => errors.push(json!({ "row": {}, "error": err.to_string() })),
        }
    }

    // Hold ONE program-mode bracket for the whole import and write each
    // channel with a single CIN command, trusting the scanner's CIN,OK reply
    // (which is a real acknowledgement — a rejected write returns NG/ERR and
    // is caught as an error). This matches Uniden Sentinel's bulk-write path.
    //
    // The previous code opened its own PRG/EPG per channel AND read every
    // write back inline (4 wire commands each), so a 500-row file took ~8
    // minutes and looked frozen. This is 1 command/channel. On this hardware
    // (~210ms/wire-command, per docs/wire_captures) a full ~355-channel file
    // lands in ~75-80s; the wire latency is the floor, not the command count.
    // Progress is streamed over the WS.
    let total = writes.len();
    {
        let _prg = ProgramModeGuard::enter(&state).await?;
        for (n, (row, payload)) in writes.into_iter().enumerate() {
            // Retry a failed write once. A single dropped CIN,OK (transient
            // wire hiccup under load) would otherwise permanently fail one
            // channel; the protocol's timeout policy is "retry once, then
            // fail". Only genuine rejections (NG/ERR twice) become errors.
            let mut result = write_channel_no_readback(&state, &payload).await;
            if result.is_err() {
                result = write_channel_no_readback(&state, &payload).await;
            }
            match result {
                Ok(()) => {
                    imported += 1;
                    state
                        .shadow
                        .write()
                        .unwrap()
                        .channels
                        .insert(payload.index, payload);
                }
                Err(err) => errors.push(json!({ "row": row, "error": format!("{:?}", err) })),
            }
            if total > 0 && (n + 1) % 10 == 0 {
                let percent = ((n + 1) * 99 / total) as u8;
                import_progress(&state, percent, &format!("Importing {}/{}", n + 1, total));
            }
        }
    }
    import_progress(&state, 100, "Import complete");

    Ok(Json(json!({ "imported": imported, "errors": errors })))
}

/// Broadcast import progress over the WebSocket, mirroring the memory-sync
/// `progress` shape so the frontend's existing progress handler can display it.
pub(crate) fn import_progress(state: &AppState, percent: u8, message: &str) {
    let msg = json!({
        "type": "progress",
        "task_id": "import-csv",
        "percent": percent,
        "message": message,
    });
    let _ = state.ws_tx.send(msg.to_string());
}

/// Parse one CSV row. `Ok(None)` means an empty channel slot (frequency 0) —
/// the CSV export writes every one of the 500 slots including empties, so a
/// re-import must treat freq-0 as "skip", not an error. `Ok(Some(_))` is a
/// channel to write; `Err` is a genuinely malformed row.
fn parse_import_csv_row(row: &HashMap<String, String>) -> Result<Option<ChannelData>, String> {
    let parse_bool = |v: &str| -> bool { v.trim().eq_ignore_ascii_case("true") };

    let index: u16 = row
        .get("Index")
        .ok_or_else(|| "Missing Index".to_string())?
        .parse()
        .map_err(|_| "Invalid channel index".to_string())?;
    if !(1..=500).contains(&index) {
        return Err(format!("Invalid channel index: {} (must be 1-500)", index));
    }

    let frequency: f64 = row
        .get("Frequency")
        .ok_or_else(|| "Missing Frequency".to_string())?
        .parse()
        .map_err(|_| "Invalid frequency".to_string())?;
    // Frequency 0 is how the export represents an empty slot — skip it.
    if frequency == 0.0 {
        return Ok(None);
    }
    if !(25.0..=1300.0).contains(&frequency) {
        return Err(format!("Invalid frequency: {}", frequency));
    }

    let delay: i8 = row
        .get("Delay")
        .map(|s| s.as_str())
        .unwrap_or("2")
        .parse()
        .map_err(|_| "Invalid delay".to_string())?;
    // Valid CIN delay values per docs/BC125AT_PROTOCOL.md §5.3.
    if !matches!(delay, -10 | -5 | 0 | 1 | 2 | 3 | 4 | 5) {
        return Err(format!("Invalid delay: {}", delay));
    }

    let bank: u8 = row
        .get("Bank")
        .map(|s| s.as_str())
        .unwrap_or("1")
        .parse()
        .map_err(|_| "Invalid bank".to_string())?;
    if !(1..=10).contains(&bank) {
        return Err(format!("Invalid bank: {}", bank));
    }

    let tone_squelch = row
        .get("CTCSS/DCS")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<f64>())
        .transpose()
        .map_err(|_| "Invalid CTCSS/DCS".to_string())?;

    let tone_squelch_kind = if tone_squelch.is_some() {
        crate::state::ToneSquelchKind::Ctcss
    } else {
        crate::state::ToneSquelchKind::None
    };

    let modulation = row
        .get("Modulation")
        .map(|s| s.to_uppercase())
        .unwrap_or_else(|| "FM".to_string());
    let alpha_tag = row.get("Alpha Tag").cloned().unwrap_or_default();
    if alpha_tag.len() > 16 {
        return Err("Alpha Tag too long (max 16 chars)".to_string());
    }
    if validate_wire_field(&alpha_tag).is_err() {
        return Err("Alpha Tag contains invalid characters".to_string());
    }
    if validate_wire_field(&modulation).is_err() {
        return Err("Modulation contains invalid characters".to_string());
    }

    Ok(Some(ChannelData {
        index,
        frequency,
        modulation,
        alpha_tag,
        delay,
        lockout: row.get("Lockout").map(|s| parse_bool(s)).unwrap_or(false),
        priority: row.get("Priority").map(|s| parse_bool(s)).unwrap_or(false),
        tone_squelch,
        tone_squelch_kind,
        tone_dcs_code: None,
        bank,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn closecall_bands_use_one_equals_enabled() {
        // Regression guard: the CLC close-call bands field uses '1' = enabled,
        // NOT the '0' = enabled convention of the SCG/SSG/CSG masks. Confirmed
        // by a wire probe on fw 1.06.06: raw "01001" reads as [off,on,off,off,on].
        // The .ss export decodes this field with `c == '1'` (see cc_band_flags);
        // using flags_to_bools here would invert CloseCallBands.
        let decode = |s: &str| s.chars().map(|c| c == '1').collect::<Vec<bool>>();
        assert_eq!(decode("01001"), vec![false, true, false, false, true]);
        // flags_to_bools (the mask decoder) would give the inverted result:
        assert_eq!(flags_to_bools("01001"), vec![true, false, true, true, false]);
    }

    #[test]
    fn parse_valid_row_returns_channel() {
        let r = row(&[
            ("Index", "5"),
            ("Frequency", "145.13"),
            ("Modulation", "AUTO"),
            ("Alpha Tag", "Test"),
            ("Delay", "2"),
            ("Lockout", "false"),
            ("Priority", "false"),
            ("Bank", "1"),
        ]);
        let ch = parse_import_csv_row(&r).unwrap().expect("should be Some");
        assert_eq!(ch.index, 5);
        assert!((ch.frequency - 145.13).abs() < 0.00005);
        assert_eq!(ch.alpha_tag, "Test");
    }

    #[test]
    fn parse_empty_slot_is_skipped_not_error() {
        // Frequency 0 is how the export marks an empty slot — must be Ok(None),
        // NOT an error. Regression guard for the "hundreds of import errors"
        // bug where re-importing an exported file failed on every empty channel.
        let r = row(&[("Index", "6"), ("Frequency", "0")]);
        assert!(parse_import_csv_row(&r).unwrap().is_none());
    }

    #[test]
    fn parse_out_of_band_frequency_is_error() {
        // A non-zero frequency outside 25–1300 MHz is genuinely malformed.
        let r = row(&[("Index", "6"), ("Frequency", "9999")]);
        assert!(parse_import_csv_row(&r).is_err());
    }

    #[test]
    fn parse_bad_index_is_error() {
        let r = row(&[("Index", "501"), ("Frequency", "145.13")]);
        assert!(parse_import_csv_row(&r).is_err());
    }
}
