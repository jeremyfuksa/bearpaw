use axum::extract::State;
use axum::response::Json;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::protocol::{classify_response, ScannerReply};

use super::super::{
    broadcast_banks_update, command_sender, send_raw_command, ApiError, AppState, ProgramModeGuard,
};

#[derive(Serialize)]
pub(crate) struct BanksResponse {
    banks: Vec<bool>,
}

#[derive(Deserialize)]
pub(crate) struct BanksRequest {
    banks: Vec<bool>,
}

pub(crate) async fn get_banks(
    State(state): State<AppState>,
) -> Result<Json<BanksResponse>, ApiError> {
    let _ = command_sender(&state)?;
    let _prg = ProgramModeGuard::enter(&state).await?;
    let response = send_raw_command(&state, "SCG", false).await;
    let response = response?;
    let mut parts = response.split(',').map(|s| s.trim()).collect::<Vec<&str>>();
    if parts.first().map(|p| p.eq_ignore_ascii_case("SCG")) == Some(true) {
        parts.remove(0);
    }
    let flags = parts.first().copied().unwrap_or("");
    if flags.len() != 10 || !flags.chars().all(|c| c == '0' || c == '1') {
        return Err(ApiError::BadRequest("Invalid SCG response".to_string()));
    }
    let banks = flags.chars().map(|c| c == '0').collect::<Vec<bool>>();
    *state.banks.write().unwrap() = banks.clone();
    broadcast_banks_update(&state);
    Ok(Json(BanksResponse { banks }))
}

pub(crate) async fn set_banks(
    State(state): State<AppState>,
    Json(body): Json<BanksRequest>,
) -> Result<Json<BanksResponse>, ApiError> {
    if body.banks.len() != 10 {
        return Err(ApiError::BadRequest("banks_length_invalid".to_string()));
    }
    let _ = command_sender(&state)?;
    let flags = body
        .banks
        .iter()
        .map(|enabled| if *enabled { "0" } else { "1" })
        .collect::<String>();
    let _prg = ProgramModeGuard::enter(&state).await?;
    let response = send_raw_command(&state, &format!("SCG,{}", flags), false).await?;
    match classify_response(&response) {
        ScannerReply::Ok => {}
        ScannerReply::Ng => {
            return Err(ApiError::BadRequest("banks_wrong_mode".to_string()));
        }
        ScannerReply::Err => {
            warn!(
                response = %response.trim(),
                flags = %flags,
                "scanner returned ERR on SCG set"
            );
            return Err(ApiError::BadRequest("banks_syntax_error".to_string()));
        }
        _ => return Err(ApiError::BadRequest("banks_failed".to_string())),
    }

    // Read-back-verify: SCG writes are in the "deferred" tier of the protocol
    // audit (no wire capture confirms write-side persistence on this firmware).
    // The scanner can reply `SCG,OK` while silently dropping the mask change,
    // so we re-read the mask inside the same PRG bracket and compare. If it
    // doesn't match what we wrote, surface an error to the caller instead of
    // caching a wrong value in `state.banks`.
    let verify_response = send_raw_command(&state, "SCG", false).await?;
    let mut verify_parts = verify_response
        .split(',')
        .map(|s| s.trim())
        .collect::<Vec<&str>>();
    if verify_parts.first().map(|p| p.eq_ignore_ascii_case("SCG")) == Some(true) {
        verify_parts.remove(0);
    }
    let actual = verify_parts.first().copied().unwrap_or("");
    if actual.len() != 10 || !actual.chars().all(|c| c == '0' || c == '1') {
        warn!(
            wrote = %flags,
            response = %verify_response.trim(),
            "SCG read-back returned a malformed mask"
        );
        return Err(ApiError::BadRequest("banks_readback_invalid".to_string()));
    }
    if actual != flags {
        warn!(
            wrote = %flags,
            read_back = %actual,
            "SCG write was not persisted by the scanner — read-back mask differs from what we sent"
        );
        return Err(ApiError::BadRequest("banks_not_persisted".to_string()));
    }

    *state.banks.write().unwrap() = body.banks.clone();
    broadcast_banks_update(&state);
    Ok(Json(BanksResponse { banks: body.banks }))
}
