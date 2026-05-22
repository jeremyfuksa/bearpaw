use axum::extract::{Multipart, State};
use axum::response::{IntoResponse, Json};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::protocol::tones::tone_code_label;
use crate::state::ChannelData;

use super::super::{
    command_sender, csv_escape, flags_to_bools, format_modulation, on_off, send_raw_command,
    split_command_parts, write_channel_to_scanner, ApiError, AppState, ProgramModeGuard,
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

        let mut channels = Vec::new();
        for idx in 1..=500 {
            let cin = split_command_parts(
                &send_raw_command(&state, &format!("CIN,{}", idx), false).await?,
            );
            let mut parts = cin;
            if parts
                .first()
                .and_then(|v| v.parse::<u16>().ok())
                .map(|v| v == idx)
                .unwrap_or(false)
            {
                parts.remove(0);
            }
            let name = parts.first().cloned().unwrap_or_default();
            let frequency_hz = parts
                .get(1)
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v * 100)
                .unwrap_or(0);
            let modulation = format_modulation(parts.get(2).map(String::as_str).unwrap_or("Auto"));
            let tone = tone_code_label(parts.get(3).map(String::as_str).unwrap_or("0"));
            let delay = parts.get(4).cloned().unwrap_or_else(|| "2".to_string());
            let lockout = on_off(parts.get(5).map(String::as_str).unwrap_or("0"));
            let priority = on_off(parts.get(6).map(String::as_str).unwrap_or("0"));
            channels.push((
                idx,
                name,
                frequency_hz,
                modulation,
                tone,
                lockout.to_string(),
                delay,
                priority.to_string(),
            ));
        }

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

        let cc_band_flags = flags_to_bools(&cc_bands);
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

    for result in rdr.deserialize::<HashMap<String, String>>() {
        match result {
            Ok(row) => match parse_import_csv_row(&row) {
                Ok(payload) => {
                    if let Err(err) = write_channel_to_scanner(&state, &payload).await {
                        errors.push(json!({ "row": row, "error": format!("{:?}", err) }));
                        continue;
                    }
                    state
                        .shadow
                        .write()
                        .unwrap()
                        .channels
                        .insert(payload.index, payload);
                    imported += 1;
                }
                Err(err) => {
                    errors.push(json!({ "row": row, "error": err }));
                }
            },
            Err(err) => errors.push(json!({ "row": {}, "error": err.to_string() })),
        }
    }

    Ok(Json(json!({ "imported": imported, "errors": errors })))
}

fn parse_import_csv_row(row: &HashMap<String, String>) -> Result<ChannelData, String> {
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
    if !(25.0..=1300.0).contains(&frequency) {
        return Err(format!("Invalid frequency: {}", frequency));
    }

    let delay: u8 = row
        .get("Delay")
        .map(|s| s.as_str())
        .unwrap_or("2")
        .parse()
        .map_err(|_| "Invalid delay".to_string())?;
    if delay > 30 {
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

    Ok(ChannelData {
        index,
        frequency,
        modulation: row
            .get("Modulation")
            .map(|s| s.to_uppercase())
            .unwrap_or_else(|| "FM".to_string()),
        alpha_tag: row.get("Alpha Tag").cloned().unwrap_or_default(),
        delay,
        lockout: row.get("Lockout").map(|s| parse_bool(s)).unwrap_or(false),
        priority: row.get("Priority").map(|s| parse_bool(s)).unwrap_or(false),
        tone_squelch,
        tone_squelch_kind,
        tone_dcs_code: None,
        bank,
    })
}
