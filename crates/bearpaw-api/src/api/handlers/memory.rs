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
    // Banks are derived here rather than during parsing: they depend on the
    // connected scanner's memory model, and parse_cin_response has no access to
    // it. The bank filter below therefore has to run AFTER derivation -- against
    // raw parser output every channel's bank is 0 and the filter matches
    // nothing. See #401.
    let mut channels: Vec<ChannelData> = state.channels_with_banks();
    if let Some(bank) = q.bank {
        channels.retain(|c| c.bank == bank);
    }
    if let Some(lockout) = q.lockout {
        channels.retain(|c| c.lockout == lockout);
    }
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
    let channel_count = state.capabilities().channel_count;
    if index == 0 || index > channel_count {
        return Err(ApiError::BadRequest("channel_out_of_range".to_string()));
    }
    if command_sender(&state).is_ok() {
        if let Ok(mut channel) = read_channel_from_scanner(&state, index).await {
            state
                .shadow
                .write()
                .unwrap()
                .channels
                .insert(index, channel.clone());
            // Derive the bank before returning. `parse_cin_response` leaves
            // `bank: 0` deliberately -- it is pure, has no capability
            // descriptor, and the wire carries no bank field at all
            // (membership comes from SCG). Every boundary that hands a channel
            // outward therefore has to derive it, which is what
            // `channels_with_banks` does for the list endpoint. This one did
            // not, so a single-channel read returned bank 0 while the list
            // returned the real bank for the same channel.
            //
            // Not cosmetic: the bulk-upload loop calls this per channel and,
            // on a write mismatch, feeds the result straight into the
            // frontend's channel list -- writing bank 0 over a correct value.
            // See the third-rail note on bank derivation in CLAUDE.md.
            channel.bank = state.capabilities().index_to_bank(channel.index);
            return Ok(Json(channel));
        }
    }
    state
        .channel_with_bank(index)
        .map(Json)
        .ok_or(ApiError::NotFound("not_found".to_string()))
}

pub(crate) async fn put_memory_channel(
    State(state): State<AppState>,
    Path(index): Path<u16>,
    Json(mut body): Json<ChannelData>,
) -> Result<Json<ChannelData>, ApiError> {
    let _ = command_sender(&state)?;
    let caps = state.capabilities();
    if index == 0 || index > caps.channel_count {
        return Err(ApiError::BadRequest("channel_out_of_range".to_string()));
    }
    body.index = index;
    // Frequency must be 0 (clear the slot) or inside the CONNECTED scanner's
    // coverage (#143 — validate_frequency existed but was never called on this
    // path; #402 — the two families do not cover the same spectrum).
    //
    // The BC75XLT has no 225–380 MHz band at all and its UHF range starts at
    // 406, not 400, so the BC125AT-family bands would accept frequencies this
    // scanner cannot tune. `covers_frequency` treats 0.0 as the clear sentinel.
    if !caps.covers_frequency(body.frequency) {
        return Err(ApiError::BadRequest("frequency_out_of_range".to_string()));
    }
    // Valid CIN delay values are model-dependent: signed seconds on the
    // BC125AT family (docs/BC125AT_PROTOCOL.md §5.3), a boolean on the BC75XLT
    // (vendor spec: `[DLY] : Delay Time (0:OFF / 1:ON)`). Rejected here rather
    // than at the wire because the vendor spec aborts the ENTIRE set command on
    // a format error — a bad delay would silently discard the frequency,
    // lockout, and priority in the same write. See #402.
    if !caps.accepts_delay(body.delay) {
        return Err(ApiError::BadRequest("delay_out_of_range".to_string()));
    }
    if body.bank > caps.bank_count {
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
            return Err(ApiError::BadRequest(format!(
                "alpha_tag_invalid: {}",
                reason
            )));
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
    if index == 0 || index > state.capabilities().channel_count {
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
    // Walk only as far as the scanner actually goes. A BC75XLT returns
    // `CIN,ERR` for 301-500 -- parse_cin_response rejects those (the #134
    // guard) so nothing corrupts, but it is 200 pointless round-trips, a
    // progress bar that stalls at 60%, and 200 error-shaped replies in the log.
    let max_channels = state.capabilities().channel_count;
    tx.send(ControlCommand::StartSync {
        task_id: task_id.clone(),
        max_channels,
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
///
/// Also carries `synced_at` (#413): epoch seconds for when channel memory was
/// last read from the radio, or `null` if it never has been. This endpoint
/// rather than `GET /memory/channels` because that one is a documented BARE
/// ARRAY -- adding a field there means an envelope, which breaks every existing
/// client. "How stale is this memory" belongs beside "is a sync running"
/// anyway, and the frontend already calls this on every WS connect.
///
/// Read from `shadow.last_sync`, not from SQLite: it is the same value the
/// cache stores (`flush_channel_cache` persists it, `load_channel_cache`
/// restores it), and reading memory keeps this handler off blocking I/O.
pub(crate) async fn get_memory_sync_status(State(state): State<AppState>) -> Json<Value> {
    let task_id = state.sync_task_id.lock().unwrap().clone();
    // 0.0 is `ShadowState`'s default and means "never synced". Serialize it as
    // null rather than as a timestamp -- 0.0 renders as 1 January 1970, which
    // is not a staleness report, it is a bug that looks like data.
    let synced_at = state
        .shadow
        .read()
        .ok()
        .map(|shadow| shadow.last_sync)
        .filter(|ts| *ts > 0.0);
    Json(json!({
        "in_progress": task_id.is_some(),
        "task_id": task_id,
        "synced_at": synced_at,
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
                if let ControlCommand::Raw { command, reply, .. } = cmd {
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

    /// REGRESSION GUARD: sync status reports WHEN memory was last read.
    ///
    /// #413 wants "last synced 3 days ago" on screen, and this endpoint is the
    /// only memory endpoint that can carry it: `GET /memory/channels` is a
    /// documented bare JSON array, so adding a field there means an envelope
    /// and a breaking change for every existing client.
    #[tokio::test]
    async fn sync_status_reports_when_memory_was_last_read() {
        let state = default_state();
        state.shadow.write().unwrap().last_sync = 1_000_000_000.0;

        let Json(body) = get_memory_sync_status(State(state)).await;

        assert_eq!(
            body["synced_at"].as_f64(),
            Some(1_000_000_000.0),
            "the endpoint must surface shadow.last_sync: {body}"
        );
    }

    /// REGRESSION GUARD: never-synced reports `null`, not the epoch.
    ///
    /// `ShadowState::default` leaves `last_sync` at 0.0. Passing that through
    /// renders as 1 January 1970 in any client that formats it as a date --
    /// which is not a staleness report, it is a bug that looks like data.
    /// Paired with the guard above: asserting only that a real timestamp
    /// survives would also pass for a build that emits 0.0 here.
    #[tokio::test]
    async fn sync_status_reports_null_when_memory_has_never_been_read() {
        let state = default_state();

        let Json(body) = get_memory_sync_status(State(state)).await;

        assert!(
            body["synced_at"].is_null(),
            "a never-synced scanner must report null, not the 1970 epoch: {body}"
        );
        // The pre-existing fields must keep working -- this endpoint is what
        // clears the stuck sync overlay after a WS reconnect (#137).
        assert_eq!(body["in_progress"], serde_json::json!(false));
        assert!(body["task_id"].is_null());
    }
}
