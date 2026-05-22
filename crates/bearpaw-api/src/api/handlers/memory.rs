use axum::extract::{Path, Query, State};
use axum::response::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

use crate::state::{ChannelData, ScannerMode};

use super::super::{
    command_sender, read_channel_from_scanner, send_raw_command, uuid_simple,
    write_channel_to_scanner, ApiError, AppState, ControlCommand,
};

#[derive(Deserialize)]
pub(crate) struct MemoryChannelsQuery {
    bank: Option<u8>,
    lockout: Option<bool>,
}

pub(crate) async fn get_memory_channels(
    State(state): State<AppState>,
    Query(q): Query<MemoryChannelsQuery>,
) -> Json<Vec<ChannelData>> {
    let shadow = state.shadow.read().unwrap();
    let mut channels: Vec<ChannelData> = shadow.channels.values().cloned().collect();
    if let Some(bank) = q.bank {
        channels.retain(|c| c.bank == bank);
    }
    if let Some(lockout) = q.lockout {
        channels.retain(|c| c.lockout == lockout);
    }
    channels.sort_by_key(|c| c.index);
    Json(channels)
}

pub(crate) async fn get_memory_channel(
    State(state): State<AppState>,
    Path(index): Path<u16>,
) -> Result<Json<ChannelData>, ApiError> {
    if command_sender(&state).is_ok() {
        if let Ok(channel) = read_channel_from_scanner(&state, index).await {
            state
                .shadow
                .write()
                .unwrap()
                .channels
                .insert(index, channel.clone());
            return Ok(Json(channel));
        }
    }
    let shadow = state.shadow.read().unwrap();
    shadow
        .channels
        .get(&index)
        .cloned()
        .map(Json)
        .ok_or(ApiError::NotFound("not_found".to_string()))
}

pub(crate) async fn put_memory_channel(
    State(state): State<AppState>,
    Path(index): Path<u16>,
    Json(mut body): Json<ChannelData>,
) -> Result<Json<ChannelData>, ApiError> {
    let _ = command_sender(&state)?;
    if !(1..=500).contains(&index) {
        return Err(ApiError::BadRequest("channel_out_of_range".to_string()));
    }
    body.index = index;
    // Valid CIN delay values per docs/BC125AT_PROTOCOL.md §5.3.
    if !matches!(body.delay, -10 | -5 | 0 | 1 | 2 | 3 | 4 | 5) {
        return Err(ApiError::BadRequest("delay_out_of_range".to_string()));
    }
    if body.bank > 10 {
        return Err(ApiError::BadRequest("bank_out_of_range".to_string()));
    }
    if body.alpha_tag.len() > 16 {
        return Err(ApiError::BadRequest("alpha_tag_too_long".to_string()));
    }
    let updated = write_channel_to_scanner(&state, &body).await?;
    state
        .shadow
        .write()
        .unwrap()
        .channels
        .insert(index, updated.clone());
    Ok(Json(updated))
}

#[derive(Serialize)]
pub(crate) struct MemorySyncResponse {
    status: String,
    task_id: String,
}

pub(crate) async fn post_memory_sync(
    State(state): State<AppState>,
) -> Result<Json<MemorySyncResponse>, ApiError> {
    use std::sync::mpsc::Sender;

    if let Some(task_id) = state.sync_task_id.lock().unwrap().clone() {
        return Ok(Json(MemorySyncResponse {
            status: "already_running".to_string(),
            task_id,
        }));
    }

    let task_id = format!("sync-{}", uuid_simple());
    let tx = state.command_tx.lock().unwrap();
    let tx: &Sender<ControlCommand> = tx.as_ref().ok_or(ApiError::NoScanner)?;
    state.sync_cancel_requested.store(false, Ordering::Relaxed);
    tx.send(ControlCommand::StartSync {
        task_id: task_id.clone(),
        max_channels: 500,
    })
    .map_err(|_| {
        state.sync_task_id.lock().unwrap().take();
        ApiError::SendFailed
    })?;
    *state.sync_task_id.lock().unwrap() = Some(task_id.clone());
    Ok(Json(MemorySyncResponse {
        status: "started".to_string(),
        task_id,
    }))
}

pub(crate) async fn cancel_memory_sync(State(state): State<AppState>) -> Json<Value> {
    let task = state.sync_task_id.lock().unwrap().clone();
    if let Some(task_id) = task {
        state.sync_cancel_requested.store(true, Ordering::Relaxed);
        return Json(json!({ "status": "cancelling", "task_id": task_id }));
    }
    Json(json!({ "status": "no_task" }))
}

pub(crate) async fn program_mode_start(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    if state.sync_task_id.lock().unwrap().is_some() {
        return Err(ApiError::Conflict("sync_in_progress".to_string()));
    }
    let _ = command_sender(&state)?;
    let pre_mode = state
        .live
        .read()
        .map(|live| live.mode)
        .unwrap_or(ScannerMode::Scan);
    let forced_hold = pre_mode == ScannerMode::Scan;
    if forced_hold {
        if send_raw_command(&state, "KEY,H,P", false).await.is_err() {
            let _ = send_raw_command(&state, "KEY,H", false).await;
        }
    }
    // Manual PRG/EPG here (instead of ProgramModeGuard) because this handler
    // intentionally leaves the scanner in program mode across HTTP requests.
    // The matching EPG is in program_mode_end.
    let _ = send_raw_command(&state, "PRG", false).await?;
    state
        .program_mode_forced_hold
        .store(forced_hold, Ordering::Relaxed);
    state.program_mode_active.store(true, Ordering::Relaxed);
    if let Ok(mut live) = state.live.write() {
        live.mode = ScannerMode::Programming;
    }
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn program_mode_end(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let _ = send_raw_command(&state, "EPG", false).await?;
    state.program_mode_active.store(false, Ordering::Relaxed);
    let forced_hold = state
        .program_mode_forced_hold
        .swap(false, Ordering::Relaxed);
    if forced_hold {
        if send_raw_command(&state, "KEY,S,P", false).await.is_err() {
            let _ = send_raw_command(&state, "KEY,S", false).await;
        }
    }
    if let Ok(mut live) = state.live.write() {
        live.mode = if forced_hold {
            ScannerMode::Scan
        } else {
            ScannerMode::Hold
        };
    }
    Ok(Json(json!({ "status": "ok" })))
}
