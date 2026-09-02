use axum::extract::{Path, State};
use axum::response::Json;
use serde_json::{json, Value};

use crate::protocol::{classify_response, ScannerReply};

use super::super::{
    command_sender, get_setting_section, parse_command_parts, read_settings_snapshot_from_scanner,
    send_raw_command, set_setting_section, ApiError, AppState, ProgramModeGuard,
};

/// Strictly extract the first numeric field of a settings reply (#143).
///
/// The old pattern — `parts.first().parse().unwrap_or(0)` — turned `NG`/`ERR`
/// replies and garbage into a "real" value of 0, which the getter then cached
/// via `set_setting_section`, permanently overwriting a good cached value
/// after one flaky read. Returning an error instead makes the getter fall
/// through to its cached/default section.
pub(super) fn parse_setting_u8(response: &str, cmd: &str) -> Result<u8, ApiError> {
    match classify_response(response) {
        ScannerReply::Ng | ScannerReply::Err => {
            return Err(ApiError::BadRequest(format!(
                "{}_read_failed",
                cmd.to_lowercase()
            )));
        }
        _ => {}
    }
    parse_command_parts(response, cmd)
        .first()
        .and_then(|s| s.parse::<u8>().ok())
        .ok_or_else(|| ApiError::BadRequest(format!("{}_read_failed", cmd.to_lowercase())))
}

pub(crate) async fn get_config(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let snapshot = read_settings_snapshot_from_scanner(&state).await?;
    // Merge only non-null sections over the cache (#143): the snapshot emits
    // `null` for sections whose reply was NG/ERR/unparseable, and those must
    // not clobber previously-good cached values.
    let merged = {
        let mut settings = state.settings.write().unwrap();
        if !settings.is_object() {
            *settings = json!({});
        }
        if let (Some(cache), Some(snap)) = (settings.as_object_mut(), snapshot.as_object()) {
            for (key, value) in snap {
                if !value.is_null() {
                    cache.insert(key.clone(), value.clone());
                }
            }
        }
        settings.clone()
    };
    Ok(Json(merged))
}

pub(crate) async fn get_backlight(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, "BLT", false).await;
            let response = response?;
            // NG/ERR must not cache "NG" as the backlight event (#143).
            if matches!(
                classify_response(&response),
                ScannerReply::Ng | ScannerReply::Err
            ) {
                return Err(ApiError::BadRequest("blt_read_failed".to_string()));
            }
            let parts = parse_command_parts(&response, "BLT");
            let event = parts
                .first()
                .filter(|e| matches!(e.to_uppercase().as_str(), "AO" | "AF" | "KY" | "SQ" | "KS"))
                .cloned()
                .ok_or_else(|| ApiError::BadRequest("blt_read_failed".to_string()))?;
            Ok::<Value, ApiError>(json!({ "event": event }))
        }
        .await;
        if let Ok(value) = result {
            set_setting_section(&state, "backlight", value.clone());
            return Ok(Json(value));
        }
    }
    Ok(Json(get_setting_section(
        &state,
        "backlight",
        json!({ "event": "AO" }),
    )))
}

pub(crate) async fn set_backlight(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Refuse before the wire when the scanner has no such command. The UI
    // already hides this control (#422), so reaching here means an API client
    // or a stale frontend -- and a bare ERR from the radio is not something
    // either can act on. See #432.
    if !state.capabilities().has_backlight_control {
        return Err(ApiError::BadRequest("backlight_unsupported".to_string()));
    }
    let event = body
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("AO")
        .to_uppercase();
    if !matches!(event.as_str(), "AO" | "AF" | "KY" | "SQ" | "KS") {
        return Err(ApiError::BadRequest("backlight_invalid".to_string()));
    }
    if command_sender(&state).is_ok() {
        let _prg = ProgramModeGuard::enter(&state).await?;
        let response = send_raw_command(&state, &format!("BLT,{}", event), false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("backlight_failed".to_string()));
        }
    }
    set_setting_section(&state, "backlight", json!({ "event": event }));
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn get_battery(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, "BSV", false).await;
            let response = response?;
            let value = parse_setting_u8(&response, "BSV")?;
            Ok::<Value, ApiError>(json!({ "charge_time": value }))
        }
        .await;
        if let Ok(value) = result {
            set_setting_section(&state, "battery", value.clone());
            return Ok(Json(value));
        }
    }
    Ok(Json(get_setting_section(
        &state,
        "battery",
        json!({ "charge_time": 16 }),
    )))
}

pub(crate) async fn set_battery(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Refuse before the wire when the scanner has no such command. The UI
    // already hides this control (#422), so reaching here means an API client
    // or a stale frontend -- and a bare ERR from the radio is not something
    // either can act on. See #432.
    if !state.capabilities().has_battery_save {
        return Err(ApiError::BadRequest("battery_save_unsupported".to_string()));
    }
    // Validate the range on the wide type BEFORE narrowing to u8 — otherwise
    // e.g. 257 truncates to 1 and slips past a post-cast `1..=16` check. #143.
    let charge_time = body
        .get("charge_time")
        .and_then(Value::as_u64)
        .filter(|&v| (1..=16).contains(&v))
        .ok_or_else(|| ApiError::BadRequest("battery_charge_time_out_of_range".to_string()))?
        as u8;
    if command_sender(&state).is_ok() {
        let _prg = ProgramModeGuard::enter(&state).await?;
        let response = send_raw_command(&state, &format!("BSV,{}", charge_time), false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("battery_failed".to_string()));
        }
    }
    set_setting_section(&state, "battery", body);
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn get_key_beep(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, "KBP", false).await;
            let response = response?;
            if matches!(
                classify_response(&response),
                ScannerReply::Ng | ScannerReply::Err
            ) {
                return Err(ApiError::BadRequest("kbp_read_failed".to_string()));
            }
            let parts = parse_command_parts(&response, "KBP");
            let level = parts
                .first()
                .and_then(|s| s.parse::<i32>().ok())
                .ok_or_else(|| ApiError::BadRequest("kbp_read_failed".to_string()))?;
            let lock = parts.get(1).map(|s| s == "1").unwrap_or(false);
            Ok::<Value, ApiError>(json!({ "level": level, "lock": lock }))
        }
        .await;
        if let Ok(value) = result {
            set_setting_section(&state, "key_beep", value.clone());
            return Ok(Json(value));
        }
    }
    Ok(Json(get_setting_section(
        &state,
        "key_beep",
        json!({ "level": 1, "lock": false }),
    )))
}

pub(crate) async fn set_key_beep(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Refuse before the wire on a model whose `KBP` beep field is reserved.
    // The UI hides the control there, so reaching here means an API client or
    // a stale frontend -- and per the vendor spec a value in a reserved slot
    // is a format error that aborts the WHOLE set command, taking the key lock
    // sent alongside it. Same guard as `set_weather` (#432).
    if !state.capabilities().has_key_beep {
        return Err(ApiError::BadRequest("key_beep_unsupported".to_string()));
    }
    // Validate before narrowing (99 = "auto" sentinel). #143.
    let level = body
        .get("level")
        .and_then(Value::as_i64)
        .filter(|&v| v == 99 || (0..=15).contains(&v))
        .ok_or_else(|| ApiError::BadRequest("beep_level_out_of_range".to_string()))?
        as i32;
    let lock = body.get("lock").and_then(Value::as_bool).unwrap_or(false);
    if command_sender(&state).is_ok() {
        let _prg = ProgramModeGuard::enter(&state).await?;
        let response = send_raw_command(
            &state,
            &format!("KBP,{},{}", level, if lock { 1 } else { 0 }),
            false,
        )
        .await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("key_beep_failed".to_string()));
        }
    }
    set_setting_section(&state, "key_beep", body);
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn get_priority(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, "PRI", false).await;
            let response = response?;
            let mode = parse_setting_u8(&response, "PRI")?;
            Ok::<Value, ApiError>(json!({ "mode": mode }))
        }
        .await;
        if let Ok(value) = result {
            set_setting_section(&state, "priority", value.clone());
            return Ok(Json(value));
        }
    }
    Ok(Json(get_setting_section(
        &state,
        "priority",
        json!({ "mode": 0 }),
    )))
}

pub(crate) async fn set_priority(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Validate before narrowing — 256 would truncate to 0 and pass. #143.
    let mode = body
        .get("mode")
        .and_then(Value::as_u64)
        .filter(|&v| (0..=3).contains(&v))
        .ok_or_else(|| ApiError::BadRequest("priority_mode_invalid".to_string()))?
        as u8;
    if command_sender(&state).is_ok() {
        let _prg = ProgramModeGuard::enter(&state).await?;
        let response = send_raw_command(&state, &format!("PRI,{}", mode), false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("priority_failed".to_string()));
        }
    }
    set_setting_section(&state, "priority", body);
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn get_search(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, "SCO", false).await;
            let response = response?;
            let parts = parse_command_parts(&response, "SCO");
            let delay = parts
                .first()
                .and_then(|s| s.parse::<i32>().ok())
                .unwrap_or(0);
            let code_search = parts.get(1).map(|s| s == "1").unwrap_or(false);
            Ok::<Value, ApiError>(json!({ "delay": delay, "code_search": code_search }))
        }
        .await;
        if let Ok(value) = result {
            set_setting_section(&state, "search", value.clone());
            return Ok(Json(value));
        }
    }
    Ok(Json(get_setting_section(
        &state,
        "search",
        json!({ "delay": 2, "code_search": false }),
    )))
}

pub(crate) async fn set_search(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Validate before narrowing — a large i64 could wrap into a valid i32
    // delay. #143.
    let delay = body
        .get("delay")
        .and_then(Value::as_i64)
        .filter(|&v| matches!(v, -10 | -5 | 0 | 1 | 2 | 3 | 4 | 5))
        .ok_or_else(|| ApiError::BadRequest("search_delay_invalid".to_string()))?
        as i32;
    let code_search = body
        .get("code_search")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if command_sender(&state).is_ok() {
        let _prg = ProgramModeGuard::enter(&state).await?;
        let response = send_raw_command(
            &state,
            &format!("SCO,{},{}", delay, if code_search { 1 } else { 0 }),
            false,
        )
        .await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK") || upper.starts_with("SCO,")) {
            return Err(ApiError::BadRequest("search_failed".to_string()));
        }
    }
    set_setting_section(&state, "search", body);
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn get_close_call(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, "CLC", false).await;
            let response = response?;
            let parts = parse_command_parts(&response, "CLC");
            let mode = parts
                .first()
                .and_then(|s| s.parse::<u8>().ok())
                .unwrap_or(0);
            let alert_beep = parts.get(1).map(|s| s == "1").unwrap_or(false);
            let alert_light = parts.get(2).map(|s| s == "1").unwrap_or(false);
            let band_raw = parts.get(3).cloned().unwrap_or_else(|| "00000".to_string());
            let band = band_raw
                .chars()
                .take(5)
                .map(|c| c == '1')
                .collect::<Vec<bool>>();
            let lockout = parts.get(4).map(|s| s == "1").unwrap_or(false);
            Ok::<Value, ApiError>(json!({
                "mode": mode,
                "alert_beep": alert_beep,
                "alert_light": alert_light,
                "band": if band.len() == 5 { band } else { vec![false,false,false,false,false] },
                "lockout": lockout
            }))
        }
        .await;
        if let Ok(value) = result {
            set_setting_section(&state, "close_call", value.clone());
            return Ok(Json(value));
        }
    }
    Ok(Json(get_setting_section(
        &state,
        "close_call",
        json!({
            "mode": 0,
            "alert_beep": false,
            "alert_light": false,
            "band": [false, false, false, false, false],
            "lockout": false
        }),
    )))
}

pub(crate) async fn set_close_call(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Validate before narrowing — 256 truncates to 0 and passes. #143.
    //
    // Range is 0..=3: Off/Priority/DND/Only. Mode 3 (`CC Only`) is NOT in
    // BC125AT_PROTOCOL.md §7.6, which documents only 0-2 — it was found on
    // hardware, see docs/wire_captures/2026-08-03/clc-mode-probe-cc-only.txt.
    // This used to cap at 2, so a radio in CC Only reported a mode the API
    // would refuse to write back.
    let mode = match body.get("mode").and_then(Value::as_u64) {
        Some(v) if (0..=3).contains(&v) => v as u8,
        None => 0,
        Some(_) => return Err(ApiError::BadRequest("close_call_mode_invalid".to_string())),
    };
    let alert_beep = body
        .get("alert_beep")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let alert_light = body
        .get("alert_light")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let band = body
        .get("band")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![Value::Bool(false); 5]);
    // mode is already range-validated above; band must be exactly 5 entries.
    if band.len() != 5 {
        return Err(ApiError::BadRequest("close_call_mode_invalid".to_string()));
    }
    let band_str = band
        .iter()
        .map(|v| {
            if v.as_bool().unwrap_or(false) {
                "1"
            } else {
                "0"
            }
        })
        .collect::<String>();
    let lockout = body
        .get("lockout")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if command_sender(&state).is_ok() {
        // Field 5 (`hit_scan`) is reserved on some models -- written `1` on a
        // BC75XLT it reads back empty (hardware 2026-08-28). A reserved field
        // goes out EMPTY, per CLAUDE.md pitfall #9: an empty field means
        // "leave unchanged", while a value in a reserved slot risks the
        // format error that aborts the whole set command. The UI hides the
        // control on such a model, so `lockout` there is a default, not a
        // user choice -- writing it would be inventing an answer.
        let hit_scan = if state.capabilities().has_close_call_hit_scan {
            if lockout {
                "1"
            } else {
                "0"
            }
        } else {
            ""
        };
        let _prg = ProgramModeGuard::enter(&state).await?;
        let response = send_raw_command(
            &state,
            &format!(
                "CLC,{},{},{},{},{}",
                mode,
                if alert_beep { 1 } else { 0 },
                if alert_light { 1 } else { 0 },
                band_str,
                hit_scan
            ),
            false,
        )
        .await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("close_call_failed".to_string()));
        }
    }
    set_setting_section(&state, "close_call", body);
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn get_service_search(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, "SSG", false).await;
            let response = response?;
            let parts = parse_command_parts(&response, "SSG");
            let flags = parts
                .first()
                .cloned()
                .unwrap_or_else(|| "1111111111".to_string());
            let groups = if flags.eq_ignore_ascii_case("NG") {
                vec![false; 10]
            } else {
                let mut g = flags
                    .chars()
                    .take(10)
                    .map(|c| c == '0')
                    .collect::<Vec<bool>>();
                while g.len() < 10 {
                    g.push(false);
                }
                g
            };
            Ok::<Value, ApiError>(json!({ "groups": groups }))
        }
        .await;
        if let Ok(value) = result {
            set_setting_section(&state, "service_search", value.clone());
            return Ok(Json(value));
        }
    }
    Ok(Json(get_setting_section(
        &state,
        "service_search",
        json!({ "groups": [false, false, false, false, false, false, false, false, false, false] }),
    )))
}

pub(crate) async fn set_service_search(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Refuse before the wire when the scanner has no `SSG` command. The UI
    // hides the whole Service Search page on such a model, so reaching here
    // means an API client or a stale frontend -- and a bare ERR from the radio
    // is not something either can act on. Same guard as `set_weather` (#432).
    if !state.capabilities().has_service_search_groups {
        return Err(ApiError::BadRequest(
            "service_search_unsupported".to_string(),
        ));
    }
    let groups = body
        .get("groups")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::BadRequest("group_length_invalid".to_string()))?;
    if groups.len() != 10 {
        return Err(ApiError::BadRequest("group_length_invalid".to_string()));
    }
    if command_sender(&state).is_ok() {
        let flags = groups
            .iter()
            .map(|v| {
                if v.as_bool().unwrap_or(false) {
                    "0"
                } else {
                    "1"
                }
            })
            .collect::<String>();
        let _prg = ProgramModeGuard::enter(&state).await?;
        let response = send_raw_command(&state, &format!("SSG,{}", flags), false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("service_search_failed".to_string()));
        }
    }
    set_setting_section(&state, "service_search", body);
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn get_custom_search(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, "CSG", false).await;
            let response = response?;
            let parts = parse_command_parts(&response, "CSG");
            let flags = parts
                .first()
                .cloned()
                .unwrap_or_else(|| "1111111111".to_string());
            let groups = if flags.eq_ignore_ascii_case("NG") {
                vec![false; 10]
            } else {
                let mut g = flags
                    .chars()
                    .take(10)
                    .map(|c| c == '0')
                    .collect::<Vec<bool>>();
                while g.len() < 10 {
                    g.push(false);
                }
                g
            };
            Ok::<Value, ApiError>(json!({ "groups": groups }))
        }
        .await;
        if let Ok(value) = result {
            set_setting_section(&state, "custom_search", value.clone());
            return Ok(Json(value));
        }
    }
    Ok(Json(get_setting_section(
        &state,
        "custom_search",
        json!({ "groups": [false, false, false, false, false, false, false, false, false, false] }),
    )))
}

pub(crate) async fn set_custom_search(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let groups = body
        .get("groups")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::BadRequest("group_length_invalid".to_string()))?;
    if groups.len() != 10 {
        return Err(ApiError::BadRequest("group_length_invalid".to_string()));
    }
    if command_sender(&state).is_ok() {
        let flags = groups
            .iter()
            .map(|v| {
                if v.as_bool().unwrap_or(false) {
                    "0"
                } else {
                    "1"
                }
            })
            .collect::<String>();
        let _prg = ProgramModeGuard::enter(&state).await?;
        let write = csg_write_command(&state, &flags).await?;
        let response = send_raw_command(&state, &write, false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("custom_search_failed".to_string()));
        }
    }
    set_setting_section(&state, "custom_search", body);
    Ok(Json(json!({ "status": "ok" })))
}

/// Shape a `CSG` write the way the CONNECTED radio just said it wants one.
///
/// The field count is per-family, and the READ reports it. A BC125AT answers a
/// bare mask; a BC75XLT answers `CSG,<mask>,[DLY],[DIR]` and rejects the bare
/// form outright -- `CSG,0111010101` -> `CSG,ERR`, verified on hardware
/// 2026-08-28 (see docs/wire_captures/2026-08-28/findings.md). A format error
/// aborts the whole set command, so every bank toggle was silently a no-op on
/// that model.
///
/// Echoing the shape the radio just reported beats a capability flag twice
/// over: it needs no per-model table, and the trailing fields are a search
/// delay and direction Bearpaw does not model -- writing back exactly what was
/// read is what keeps them. `CSG,<mask>,,` would be shorter but is NOT what the
/// probe exercised, and the spec's "only ',' parameters are not changed" note
/// is not repeated in the CSG entry.
///
/// Caller holds the program-mode bracket. Shared with the `.ss` importer so
/// that path cannot reproduce the bug this function exists to fix (#625).
pub(crate) async fn csg_write_command(state: &AppState, flags: &str) -> Result<String, ApiError> {
    let current = send_raw_command(state, "CSG", false).await?;
    if matches!(
        classify_response(&current),
        ScannerReply::Ng | ScannerReply::Err
    ) {
        return Err(ApiError::BadRequest(
            "custom_search_read_failed".to_string(),
        ));
    }
    let trailing: Vec<String> = parse_command_parts(&current, "CSG")
        .into_iter()
        .skip(1)
        .collect();
    Ok(if trailing.is_empty() {
        format!("CSG,{}", flags)
    } else {
        format!("CSG,{},{}", flags, trailing.join(","))
    })
}

pub(crate) async fn get_custom_range(
    State(state): State<AppState>,
    Path(index): Path<u8>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() && (1..=10).contains(&index) {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, &format!("CSP,{}", index), false).await;
            let response = response?;
            let mut parts = parse_command_parts(&response, "CSP");
            if parts.first().and_then(|s| s.parse::<u8>().ok()) == Some(index) {
                parts.remove(0);
            }
            let lower_raw = parts
                .first()
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            let upper_raw = parts
                .get(1)
                .and_then(|s| s.parse::<i64>().ok())
                .unwrap_or(0);
            Ok::<Value, ApiError>(json!({
                "index": index,
                "lower": (lower_raw as f64) / 10000.0,
                "upper": (upper_raw as f64) / 10000.0
            }))
        }
        .await;
        if let Ok(value) = result {
            return Ok(Json(value));
        }
    }
    let config = state.settings.read().unwrap();
    let from_snapshot = config
        .get("custom_search_ranges")
        .and_then(Value::as_array)
        .and_then(|ranges| ranges.get(index.saturating_sub(1) as usize))
        .cloned();
    Ok(Json(from_snapshot.unwrap_or_else(
        || json!({ "index": index, "lower": 0, "upper": 0 }),
    )))
}

/// Read-only seed: the 10 factory-default custom-search ranges Uniden
/// preloads on `CLR`. See `docs/BC125AT_PROTOCOL.md` §5.5. No scanner
/// round-trip — this is a constant table.
pub(crate) async fn set_custom_range(
    State(state): State<AppState>,
    Path(index): Path<u8>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if !(1..=10).contains(&index) {
        return Err(ApiError::BadRequest("search_range_invalid".to_string()));
    }
    let lower = body.get("lower").and_then(Value::as_f64).unwrap_or(0.0);
    let upper = body.get("upper").and_then(Value::as_f64).unwrap_or(0.0);
    if command_sender(&state).is_ok() {
        let _prg = ProgramModeGuard::enter(&state).await?;
        let response = send_raw_command(
            &state,
            &format!(
                "CSP,{},{},{}",
                index,
                (lower * 10000.0).round() as i64,
                (upper * 10000.0).round() as i64
            ),
            false,
        )
        .await;
        let response = response?;
        let upper_resp = response.trim().to_uppercase();
        if !(upper_resp == "OK" || upper_resp.ends_with(",OK")) {
            return Err(ApiError::BadRequest(
                "custom_search_range_failed".to_string(),
            ));
        }
    }
    let mut config = state.settings.write().unwrap();
    if let Value::Object(ref mut root) = *config {
        let ranges = root
            .entry("custom_search_ranges".to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        if let Value::Array(ref mut arr) = ranges {
            let needed = index as usize;
            while arr.len() < needed {
                let i = arr.len() + 1;
                arr.push(json!({ "index": i, "lower": 0, "upper": 0 }));
            }
            if needed > 0 {
                let value = json!({
                    "index": index,
                    "lower": body.get("lower").cloned().unwrap_or(Value::from(0)),
                    "upper": body.get("upper").cloned().unwrap_or(Value::from(0))
                });
                arr[needed - 1] = value;
            }
        }
    }
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn get_weather(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, "WXS", false).await;
            let response = response?;
            let parts = parse_command_parts(&response, "WXS");
            let priority = parts.first().map(|s| s == "1").unwrap_or(false);
            Ok::<Value, ApiError>(json!({ "priority": priority }))
        }
        .await;
        if let Ok(value) = result {
            set_setting_section(&state, "weather", value.clone());
            return Ok(Json(value));
        }
    }
    Ok(Json(get_setting_section(
        &state,
        "weather",
        json!({ "priority": false }),
    )))
}

pub(crate) async fn set_weather(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Refuse before the wire when the scanner has no such command. The UI
    // already hides this control (#422), so reaching here means an API client
    // or a stale frontend -- and a bare ERR from the radio is not something
    // either can act on. See #432.
    if !state.capabilities().has_weather_alert {
        return Err(ApiError::BadRequest(
            "weather_alert_unsupported".to_string(),
        ));
    }
    let priority = body
        .get("priority")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if command_sender(&state).is_ok() {
        let _prg = ProgramModeGuard::enter(&state).await?;
        let response = send_raw_command(
            &state,
            &format!("WXS,{}", if priority { 1 } else { 0 }),
            false,
        )
        .await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("weather_failed".to_string()));
        }
    }
    set_setting_section(&state, "weather", body);
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn get_contrast(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _prg = ProgramModeGuard::enter(&state).await?;
            let response = send_raw_command(&state, "CNT", false).await;
            let response = response?;
            let level = parse_setting_u8(&response, "CNT")?;
            Ok::<Value, ApiError>(json!({ "level": level }))
        }
        .await;
        if let Ok(value) = result {
            set_setting_section(&state, "contrast", value.clone());
            return Ok(Json(value));
        }
    }
    Ok(Json(get_setting_section(
        &state,
        "contrast",
        json!({ "level": 8 }),
    )))
}

pub(crate) async fn set_contrast(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Refuse before the wire when the scanner has no such command. The UI
    // already hides this control (#422), so reaching here means an API client
    // or a stale frontend -- and a bare ERR from the radio is not something
    // either can act on. See #432.
    if !state.capabilities().has_contrast {
        return Err(ApiError::BadRequest("contrast_unsupported".to_string()));
    }
    // Validate before narrowing — 264 truncates to 8 and passes `1..=15`. #143.
    let level = match body.get("level").and_then(Value::as_u64) {
        Some(v) if (1..=15).contains(&v) => v as u8,
        _ => return Err(ApiError::BadRequest("contrast_out_of_range".to_string())),
    };
    if command_sender(&state).is_ok() {
        let _prg = ProgramModeGuard::enter(&state).await?;
        let response = send_raw_command(&state, &format!("CNT,{}", level), false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("contrast_failed".to_string()));
        }
    }
    set_setting_section(&state, "contrast", body);
    Ok(Json(json!({ "status": "ok" })))
}

#[cfg(test)]
mod tests {
    use super::parse_setting_u8;

    #[test]
    fn parse_setting_u8_accepts_valid_reply() {
        assert_eq!(parse_setting_u8("BSV,14", "BSV").unwrap(), 14);
    }

    #[test]
    fn parse_setting_u8_rejects_ng_err_and_garbage() {
        // #143: these used to become 0 and get cached as real values.
        assert!(parse_setting_u8("BSV,NG", "BSV").is_err());
        assert!(parse_setting_u8("ERR", "BSV").is_err());
        assert!(parse_setting_u8("BSV,", "BSV").is_err());
        assert!(parse_setting_u8("garbage", "BSV").is_err());
    }
}
