use axum::extract::State;
use axum::response::Json;
use serde::{Deserialize, Serialize};

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
    let set_result = send_raw_command(&state, &format!("SCG,{}", flags), false).await;
    let _ = set_result?;
    *state.banks.write().unwrap() = body.banks.clone();
    broadcast_banks_update(&state);
    Ok(Json(BanksResponse { banks: body.banks }))
}
