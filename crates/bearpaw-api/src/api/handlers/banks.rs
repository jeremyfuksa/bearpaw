use axum::extract::State;
use axum::response::Json;
use serde::{Deserialize, Serialize};
use tracing::warn;

use crate::protocol::{classify_response, ScannerReply};

use super::super::{
    broadcast_banks_update, command_sender, open_sqlite, send_raw_command, ApiError, AppState,
    ProgramModeGuard,
};

/// Longest bank name accepted, in characters. Matches a channel's alpha tag.
const BANK_NAME_MAX_CHARS: usize = 16;

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
    // The scanner refuses an all-disabled mask -- vendor spec, SCG: "*It can
    // not set all channel strage banks to '1'." Rejected here with a specific
    // error rather than surfacing a bare ERR the UI cannot explain. Note the
    // wire inversion: '1' means DISABLED, so all-disabled is `banks` all false.
    if body.banks.iter().all(|enabled| !*enabled) {
        return Err(ApiError::BadRequest("banks_all_disabled".to_string()));
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

#[derive(Serialize, Deserialize)]
pub(crate) struct BankNames {
    /// One per bank, in bank order; `""` is a bank with no name.
    names: Vec<String>,
}

/// The connected scanner's profile id, or `None` before `MDL` has resolved one.
///
/// Deliberately not `AppState::scanner_id()`: that falls back to a placeholder
/// profile, and names saved under it would follow whichever radio connects
/// next.
fn connected_scanner_id(state: &AppState) -> Option<String> {
    state.device.read().ok().and_then(|d| d.scanner_id.clone())
}

fn load_bank_names(path: &str, scanner_id: &str, bank_count: u8) -> Vec<String> {
    let mut names = vec![String::new(); bank_count as usize];
    let Some(conn) = open_sqlite(path) else {
        return names;
    };
    let Ok(mut stmt) = conn.prepare("SELECT bank, name FROM bank_names WHERE scanner_id = ?1")
    else {
        return names;
    };
    let rows = stmt.query_map(rusqlite::params![scanner_id], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    });
    for (bank, name) in rows.into_iter().flatten().flatten() {
        if let Some(slot) = usize::try_from(bank - 1)
            .ok()
            .and_then(|i| names.get_mut(i))
        {
            *slot = name;
        }
    }
    names
}

/// Bank names for the connected scanner. Names live only in Bearpaw (#677):
/// the radio has no command that carries one.
pub(crate) async fn get_bank_names(State(state): State<AppState>) -> Json<BankNames> {
    let bank_count = state.capabilities().bank_count;
    let names = match connected_scanner_id(&state) {
        Some(id) => load_bank_names(&state.preferences_db_path, &id, bank_count),
        None => vec![String::new(); bank_count as usize],
    };
    Json(BankNames { names })
}

/// Replace the connected scanner's bank names. Each is trimmed; an empty one
/// removes that bank's name.
pub(crate) async fn put_bank_names(
    State(state): State<AppState>,
    Json(body): Json<BankNames>,
) -> Result<Json<BankNames>, ApiError> {
    let scanner_id =
        connected_scanner_id(&state).ok_or_else(|| ApiError::Conflict("no_scanner".to_string()))?;
    let bank_count = state.capabilities().bank_count;
    if body.names.len() != bank_count as usize {
        return Err(ApiError::BadRequest(
            "bank_names_length_invalid".to_string(),
        ));
    }
    let names: Vec<String> = body.names.iter().map(|n| n.trim().to_string()).collect();
    if names
        .iter()
        .any(|n| n.chars().count() > BANK_NAME_MAX_CHARS || n.chars().any(char::is_control))
    {
        return Err(ApiError::BadRequest("bank_name_invalid".to_string()));
    }

    let failed = || ApiError::Internal("bank_names_persistence_failed".to_string());
    let mut conn = open_sqlite(&state.preferences_db_path).ok_or_else(failed)?;
    let tx = conn.transaction().map_err(|_| failed())?;
    tx.execute(
        "DELETE FROM bank_names WHERE scanner_id = ?1",
        rusqlite::params![scanner_id],
    )
    .map_err(|_| failed())?;
    for (i, name) in names.iter().enumerate().filter(|(_, n)| !n.is_empty()) {
        tx.execute(
            "INSERT INTO bank_names (scanner_id, bank, name) VALUES (?1, ?2, ?3)",
            rusqlite::params![scanner_id, i as i64 + 1, name],
        )
        .map_err(|_| failed())?;
    }
    tx.commit().map_err(|_| failed())?;
    Ok(Json(BankNames { names }))
}
