use axum::extract::{Path, Query, State};
use axum::response::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;

use crate::protocol::{classify_response, ScannerReply};
use crate::state::{ChannelData, ScannerMode};

use super::super::security::validate_wire_field;
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
    // Reject out-of-range indexes before touching the scanner. Without this,
    // `CIN,0` / `CIN,501` go to the wire and (pre-#134) surfaced as phantom
    // channels; now they'd just error, but a 400 is the documented contract
    // and avoids a pointless round-trip. #143.
    if !(1..=500).contains(&index) {
        return Err(ApiError::BadRequest("channel_out_of_range".to_string()));
    }
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
    // Frequency must be 0 (clear the slot) or inside the BC125AT's coverage
    // (#143 — validate_frequency existed but was never called on this path).
    if body.frequency != 0.0 && super::super::control::validate_frequency(body.frequency).is_err()
    {
        return Err(ApiError::BadRequest("frequency_out_of_range".to_string()));
    }
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
    if validate_wire_field(&body.alpha_tag).is_err() {
        return Err(ApiError::BadRequest("alpha_tag_invalid".to_string()));
    }
    // Charset validation against the scanner's documented allowlist (#149 —
    // validate_channel_name existed as groundwork with no caller). Empty is
    // allowed: it means "clear the slot" and the writer encodes it as 16
    // spaces.
    if !body.alpha_tag.is_empty() {
        if let Err(reason) = crate::protocol::validate_channel_name(&body.alpha_tag) {
            return Err(ApiError::BadRequest(format!("alpha_tag_invalid: {}", reason)));
        }
    }
    if validate_wire_field(&body.modulation).is_err() {
        return Err(ApiError::BadRequest("modulation_invalid".to_string()));
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

#[derive(Deserialize)]
pub(crate) struct PriorityBody {
    priority: bool,
}

#[derive(Serialize)]
pub(crate) struct PriorityResponse {
    changed: Vec<ChannelData>,
}

pub(crate) async fn put_memory_channel_priority(
    State(state): State<AppState>,
    Path(index): Path<u16>,
    Json(body): Json<PriorityBody>,
) -> Result<Json<PriorityResponse>, ApiError> {
    // REGRESSION GUARD: range-check BEFORE command_sender. `get_memory_channel`
    // set this precedent (#143) — a bad index is a 400 contract violation and
    // must not depend on scanner state. If command_sender ran first, an
    // out-of-range request with no scanner attached would return 503 instead of
    // 400 (and the priority_endpoint_rejects_out_of_range_index test would fail
    // against default_state()). Do not reorder these two checks.
    if !(1..=500).contains(&index) {
        return Err(ApiError::BadRequest("channel_out_of_range".to_string()));
    }
    let _ = command_sender(&state)?;
    let changed = if body.priority {
        super::super::set_channel_priority(&state, index).await?
    } else {
        vec![super::super::clear_channel_priority(&state, index).await?]
    };
    Ok(Json(PriorityResponse { changed }))
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

/// Snapshot of whether a memory sync is currently running. Exists so the
/// frontend can re-check after a WebSocket reconnect: if "Sync complete" was
/// broadcast into a dead socket, the client's `inProgress` flag is stale and
/// the full-screen overlay would otherwise stay up forever (#137).
pub(crate) async fn get_memory_sync_status(State(state): State<AppState>) -> Json<Value> {
    let task_id = state.sync_task_id.lock().unwrap().clone();
    Json(json!({
        "in_progress": task_id.is_some(),
        "task_id": task_id,
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
    //
    // REGRESSION GUARD (#262): a transport-level Ok is not enough — the scanner
    // answers `PRG,NG`/`ERR` when it can't enter program mode (e.g. it's sitting
    // in its own on-device menu), and that comes back as Ok("PRG,NG"). Treating
    // it as success sets program_mode_active (freezing the live display on
    // "Programming") while every later CIN/SCG write fails against a scanner
    // that never left normal operation. Classify the reply as
    // ProgramModeGuard::enter does. See `program_mode_start_rejects_prg_ng`.
    let resp = send_raw_command(&state, "PRG", false).await?;
    if !matches!(classify_response(&resp), ScannerReply::Ok) {
        // send_raw_command set program_mode_active on the PRG at the command
        // level and only clears it on a transport error — an NG/ERR reply
        // leaves it stranded, which would keep the poll loop suspended. Clear
        // it here before returning.
        state.program_mode_active.store(false, Ordering::Relaxed);
        return Err(ApiError::BadRequest(format!(
            "program_mode_refused: {}",
            resp.trim()
        )));
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::default_state;
    use std::sync::{Arc, Mutex};

    /// Wire `state.command_tx` to a thread that answers every `Raw` command by
    /// echoing `<CMD>` back with a suffix chosen by `prg_reply` for PRG and a
    /// plain `,OK` for everything else (e.g. the KEY,H forced-hold keypress).
    /// Records the commands it saw so the test can assert on them.
    fn fake_responder(state: &AppState, prg_reply: &'static str) -> Arc<Mutex<Vec<String>>> {
        let (tx, rx) = std::sync::mpsc::channel::<ControlCommand>();
        *state.command_tx.lock().unwrap() = Some(tx);
        let seen = Arc::new(Mutex::new(Vec::new()));
        let seen_thread = seen.clone();
        std::thread::spawn(move || {
            while let Ok(cmd) = rx.recv() {
                if let ControlCommand::Raw {
                    command, reply, ..
                } = cmd
                {
                    seen_thread.lock().unwrap().push(command.clone());
                    let response = if command.eq_ignore_ascii_case("PRG") {
                        prg_reply.to_string()
                    } else {
                        format!("{},OK", command)
                    };
                    let _ = reply.send(Ok(response));
                }
            }
        });
        seen
    }

    // REGRESSION GUARD (#262): a `PRG,NG` reply (scanner refused program mode,
    // e.g. it's in its own menu) must NOT be treated as success. Before the
    // fix, program_mode_start set program_mode_active=true and mode=Programming
    // on any transport-level Ok, freezing the live display while every later
    // CIN/SCG write failed.
    #[tokio::test]
    async fn program_mode_start_rejects_prg_ng() {
        let state = default_state();
        let seen = fake_responder(&state, "PRG,NG");

        let result = program_mode_start(State(state.clone())).await;

        assert!(matches!(result, Err(ApiError::BadRequest(_))));
        // The command-level flag set by send_raw_command must be cleared.
        assert!(!state.program_mode_active.load(Ordering::Relaxed));
        // Live mode must stay out of Programming.
        assert_ne!(state.live.read().unwrap().mode, ScannerMode::Programming);
        // It really did send PRG (and refuse on the reply, not before).
        assert!(seen.lock().unwrap().iter().any(|c| c == "PRG"));
    }

    #[tokio::test]
    async fn program_mode_start_accepts_prg_ok() {
        let state = default_state();
        let _seen = fake_responder(&state, "PRG,OK");

        let result = program_mode_start(State(state.clone())).await;

        assert!(result.is_ok());
        assert!(state.program_mode_active.load(Ordering::Relaxed));
        assert_eq!(state.live.read().unwrap().mode, ScannerMode::Programming);
    }
}
