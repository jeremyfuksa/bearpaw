//! Axum REST + WebSocket server.
//!
//! Compatibility-first API surface so the Rust backend can replace the Python backend
//! without frontend contract regressions.

mod control;
mod poll;
mod program_mode;

pub(crate) use program_mode::ProgramModeGuard;

pub use control::{validate_frequency, validate_modulation, ControlCommand, FrequencyRequest};
pub use poll::spawn_poll_loop;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Multipart, Path, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::{DefaultMakeSpan, DefaultOnRequest, DefaultOnResponse, TraceLayer};
use tracing::{info, warn};

use crate::protocol::parse_cin_response;
use crate::state::{ChannelData, DeviceInfo, LiveState, ScannerMode, ShadowState};

#[derive(Clone)]
pub struct AppState {
    pub live: Arc<std::sync::RwLock<LiveState>>,
    pub device: Arc<std::sync::RwLock<DeviceInfo>>,
    pub shadow: Arc<std::sync::RwLock<ShadowState>>,
    pub banks: Arc<std::sync::RwLock<Vec<bool>>>,
    pub settings: Arc<std::sync::RwLock<Value>>,
    pub temporary_lockouts: Arc<std::sync::RwLock<HashMap<u16, f64>>>,
    pub frequency_lockouts: Arc<std::sync::RwLock<HashSet<u32>>>,
    pub sync_task_id: Arc<Mutex<Option<String>>>,
    pub sync_cancel_requested: Arc<AtomicBool>,
    pub analytics_log: Arc<Mutex<Vec<ActivityHit>>>,
    pub active_hit: Arc<Mutex<Option<ActiveHit>>>,
    pub next_hit_id: Arc<AtomicU64>,
    pub session_id: Arc<String>,
    pub preferences_db_path: Arc<String>,
    pub analytics_db_path: Arc<String>,
    pub preferences: Arc<Mutex<Map<String, Value>>>,
    pub ws_tx: broadcast::Sender<String>,
    pub sequence: Arc<AtomicU64>,
    pub command_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<ControlCommand>>>>,
    pub program_mode_forced_hold: Arc<AtomicBool>,
    pub program_mode_active: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ActivityHit {
    pub id: String,
    pub timestamp: f64,
    pub frequency: f64,
    pub channel: Option<u16>,
    pub alpha_tag: Option<String>,
    pub rssi: u8,
    pub duration: f64,
    pub modulation: String,
    pub mode: ScannerMode,
    pub bank: Option<u8>,
    pub session_id: String,
    pub ended_at: f64,
}

#[derive(Clone, Debug)]
pub struct ActiveHit {
    pub timestamp: f64,
    pub frequency: f64,
    pub channel: Option<u16>,
    pub alpha_tag: Option<String>,
    pub rssi: u8,
    pub modulation: String,
    pub mode: ScannerMode,
    pub bank: Option<u8>,
}

const PREFERENCES_SCHEMA_VERSION: i32 = 1;
const ANALYTICS_SCHEMA_VERSION: i32 = 1;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/status", get(get_status))
        .route("/api/v1/health", get(get_health))
        .route("/api/v1/device/info", get(get_device_info))
        .route("/api/v1/banks", get(get_banks).post(set_banks))
        .route("/api/v1/commands/hold", post(post_hold))
        .route("/api/v1/commands/scan", post(post_scan))
        .route("/api/v1/commands/key", post(post_key))
        .route("/api/v1/commands/lockout", post(post_lockout))
        .route("/api/v1/frequency", post(post_frequency))
        .route("/api/v1/volume", get(get_volume).post(set_volume))
        .route("/api/v1/squelch", get(get_squelch).post(set_squelch))
        .route("/api/v1/config", get(get_config))
        .route("/api/v1/settings/firmware", get(get_firmware))
        .route("/api/v1/settings/all", get(get_config))
        .route(
            "/api/v1/settings/backlight",
            get(get_backlight).post(set_backlight),
        )
        .route(
            "/api/v1/settings/battery",
            get(get_battery).post(set_battery),
        )
        .route(
            "/api/v1/settings/key-beep",
            get(get_key_beep).post(set_key_beep),
        )
        .route(
            "/api/v1/settings/priority",
            get(get_priority).post(set_priority),
        )
        .route("/api/v1/settings/search", get(get_search).post(set_search))
        .route(
            "/api/v1/settings/close-call",
            get(get_close_call).post(set_close_call),
        )
        .route(
            "/api/v1/settings/service-search",
            get(get_service_search).post(set_service_search),
        )
        .route(
            "/api/v1/settings/custom-search",
            get(get_custom_search).post(set_custom_search),
        )
        .route(
            "/api/v1/settings/custom-search/ranges/:index",
            get(get_custom_range).post(set_custom_range),
        )
        .route(
            "/api/v1/settings/weather",
            get(get_weather).post(set_weather),
        )
        .route(
            "/api/v1/settings/contrast",
            get(get_contrast).post(set_contrast),
        )
        .route("/api/v1/lockouts", get(get_lockouts))
        .route("/api/v1/lockouts/:frequency", get(get_lockout_status))
        .route(
            "/api/v1/lockouts/temporary/clear",
            post(clear_temporary_lockouts),
        )
        .route("/api/v1/lockouts/clear", post(clear_global_lockouts))
        .route(
            "/api/v1/lockouts/channels/clear",
            post(clear_channel_lockouts),
        )
        .route("/api/v1/memory/channels", get(get_memory_channels))
        .route(
            "/api/v1/memory/channels/:index",
            get(get_memory_channel).put(put_memory_channel),
        )
        .route("/api/v1/memory/sync", post(post_memory_sync))
        .route("/api/v1/memory/sync/cancel", post(cancel_memory_sync))
        .route(
            "/api/v1/memory/program-mode/start",
            post(program_mode_start),
        )
        .route("/api/v1/memory/program-mode/end", post(program_mode_end))
        .route(
            "/api/v1/memory/export/bc125at_ss",
            get(export_bc125at_ss_file),
        )
        .route("/api/v1/memory/export/csv", get(export_csv))
        .route("/api/v1/memory/import/csv", post(import_csv))
        .route(
            "/api/v1/preferences",
            get(get_preferences)
                .put(set_preferences)
                .post(reset_preferences),
        )
        .route("/api/v1/preferences/reset", post(reset_preferences))
        .route(
            "/api/v1/preferences/:key",
            get(get_preference).put(set_preference),
        )
        .route("/api/v1/debug/glg", get(debug_glg))
        .route("/api/v1/debug/scg", get(debug_scg))
        .route("/api/v1/debug/glf", get(debug_glf))
        .route("/api/v1/test/simulate-hit", post(simulate_hit))
        .route("/api/v1/analytics/busiest-channels", get(analytics_busiest))
        .route(
            "/api/v1/analytics/session-stats",
            get(analytics_session_stats),
        )
        .route(
            "/api/v1/analytics/hourly-heatmap",
            get(analytics_hourly_heatmap),
        )
        .route(
            "/api/v1/analytics/activity-log",
            get(analytics_activity_log),
        )
        .route("/api/v1/analytics/cleanup", post(analytics_cleanup))
        .route("/ws", get(ws_handler))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(tracing::Level::INFO))
                .on_request(DefaultOnRequest::new().level(tracing::Level::INFO))
                .on_response(DefaultOnResponse::new().level(tracing::Level::INFO)),
        )
        .with_state(state)
}

async fn get_status(State(state): State<AppState>) -> Json<LiveState> {
    Json(state.live.read().unwrap().clone())
}

async fn get_health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

async fn get_device_info(State(state): State<AppState>) -> Json<DeviceInfo> {
    Json(state.device.read().unwrap().clone())
}

fn command_sender(state: &AppState) -> Result<std::sync::mpsc::Sender<ControlCommand>, ApiError> {
    state
        .command_tx
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or(ApiError::NoScanner)
}

pub(crate) async fn send_raw_command(
    state: &AppState,
    command: &str,
    multiline: bool,
) -> Result<String, ApiError> {
    let sender = command_sender(state)?;
    let started = std::time::Instant::now();
    let command = command.to_string();
    let command_for_log = command.clone();

    // Track program-mode entry/exit at the command level so the poll loop can
    // suppress its STS/GLG/PWR fetch while the scanner is in PRG. Otherwise
    // the poll loop interleaves operational commands with the PRG bracket and
    // races against the API handler for the bulk endpoint, causing SCG /
    // CIN reads to time out or read back stale ACKs.
    let upper = command.to_uppercase();
    let is_prg = upper == "PRG";
    let is_epg = upper == "EPG";
    let prg_flag = state.program_mode_active.clone();
    if is_prg {
        prg_flag.store(true, Ordering::Relaxed);
    }

    let join_result = tokio::task::spawn_blocking(move || {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        sender
            .send(ControlCommand::Raw {
                command,
                multiline,
                reply: reply_tx,
            })
            .map_err(|_| ApiError::SendFailed)?;
        match reply_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(response)) => Ok(response),
            Ok(Err(message)) => Err(ApiError::BadRequest(message)),
            Err(_) => Err(ApiError::BadRequest("command_timeout".to_string())),
        }
    })
    .await
    .map_err(|_| ApiError::BadRequest("command_task_failed".to_string()))
    .and_then(|inner| inner);

    match &join_result {
        Ok(response) => {
            info!(
                command = %command_for_log,
                multiline = multiline,
                elapsed_ms = started.elapsed().as_millis() as u64,
                response_len = response.len(),
                "scanner command completed"
            );
        }
        Err(err) => {
            warn!(
                command = %command_for_log,
                multiline = multiline,
                elapsed_ms = started.elapsed().as_millis() as u64,
                error = ?err,
                "scanner command failed"
            );
        }
    }

    // Always clear the flag on EPG (even on failure — leaving it stuck would
    // freeze the live display). On PRG failure, also clear so the flag never
    // gets stranded.
    if is_epg || (is_prg && join_result.is_err()) {
        prg_flag.store(false, Ordering::Relaxed);
    }
    join_result
}

#[derive(Serialize)]
struct BanksResponse {
    banks: Vec<bool>,
}

#[derive(Deserialize)]
struct BanksRequest {
    banks: Vec<bool>,
}

async fn get_banks(State(state): State<AppState>) -> Result<Json<BanksResponse>, ApiError> {
    let _ = command_sender(&state)?;
    let _ = send_raw_command(&state, "PRG", false).await?;
    let response = send_raw_command(&state, "SCG", false).await;
    let _ = send_raw_command(&state, "EPG", false).await;
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

async fn set_banks(
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
    let _ = send_raw_command(&state, "PRG", false).await?;
    let set_result = send_raw_command(&state, &format!("SCG,{}", flags), false).await;
    let _ = send_raw_command(&state, "EPG", false).await;
    let _ = set_result?;
    *state.banks.write().unwrap() = body.banks.clone();
    broadcast_banks_update(&state);
    Ok(Json(BanksResponse { banks: body.banks }))
}

/// Send a Hold or Scan ControlCommand to the poll loop and wait for its
/// scanner-side reply. The poll loop updates commanded_mode inside the same
/// match arm that issues the KEY write, so on success the next poll tick
/// broadcasts the new mode — no separate live.mode write needed here.
async fn send_mode_command(
    state: &AppState,
    make_cmd: impl FnOnce(
            Option<std::sync::mpsc::Sender<Result<String, String>>>,
        ) -> ControlCommand
        + Send
        + 'static,
    error_tag: &'static str,
) -> Result<(), ApiError> {
    let sender = command_sender(state)?;
    tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        sender
            .send(make_cmd(Some(reply_tx)))
            .map_err(|_| ApiError::SendFailed)?;
        let response = match reply_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(r)) => r,
            Ok(Err(m)) => return Err(ApiError::BadRequest(m)),
            Err(_) => return Err(ApiError::BadRequest("command_timeout".to_string())),
        };
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest(format!("{}_failed", error_tag)));
        }
        Ok(())
    })
    .await
    .map_err(|_| ApiError::SendFailed)?
}

async fn post_hold(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    send_mode_command(&state, |reply| ControlCommand::Hold { reply }, "hold").await?;
    Ok(Json(json!({ "status": "ok" })))
}

async fn post_scan(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    send_mode_command(&state, |reply| ControlCommand::Scan { reply }, "scan").await?;
    Ok(Json(json!({ "status": "ok" })))
}

#[derive(Deserialize)]
struct KeyRequest {
    key: String,
}

async fn post_key(
    State(state): State<AppState>,
    Json(body): Json<KeyRequest>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let key = body.key.to_uppercase();
    let cmd = match key.as_str() {
        "H" => Some(ControlCommand::Hold { reply: None }),
        "S" => Some(ControlCommand::Scan { reply: None }),
        _ => None,
    };
    if let Some(cmd) = cmd {
        let tx = state.command_tx.lock().unwrap();
        let tx = tx.as_ref().ok_or(ApiError::NoScanner)?;
        tx.send(cmd).map_err(|_| ApiError::SendFailed)?;
    } else {
        let primary = send_raw_command(&state, &format!("KEY,{},P", key), false).await;
        if primary.is_err() {
            let _ = send_raw_command(&state, &format!("KEY,{}", key), false).await?;
        }
    }
    Ok(Json(json!({ "status": "ok" })))
}

async fn post_frequency(
    State(state): State<AppState>,
    Json(body): Json<FrequencyRequest>,
) -> Result<Json<LiveState>, ApiError> {
    validate_frequency(body.frequency).map_err(ApiError::BadRequest)?;
    validate_modulation(&body.modulation).map_err(ApiError::BadRequest)?;
    let tx = state.command_tx.lock().unwrap();
    let tx = tx.as_ref().ok_or(ApiError::NoScanner)?;
    tx.send(ControlCommand::Direct {
        frequency: body.frequency,
        modulation: body.modulation.to_uppercase(),
    })
    .map_err(|_| ApiError::SendFailed)?;
    Ok(Json(state.live.read().unwrap().clone()))
}

#[derive(Deserialize)]
struct LockoutRequest {
    mode: String,
    frequency: Option<f64>,
    channel: Option<u16>,
}

async fn post_lockout(
    State(state): State<AppState>,
    Json(body): Json<LockoutRequest>,
) -> Result<Json<Value>, ApiError> {
    match body.mode.as_str() {
        "temporary" => {
            let live = state.live.read().unwrap().clone();
            let channel = body
                .channel
                .or(live.channel)
                .ok_or_else(|| ApiError::BadRequest("channel_required".to_string()))?;
            let frequency = body.frequency.unwrap_or(live.frequency);
            let was_locked = state
                .temporary_lockouts
                .read()
                .unwrap()
                .contains_key(&channel);
            let locked = if was_locked {
                if command_sender(&state).is_ok() {
                    let updated = set_channel_lockout_on_scanner(&state, channel, false).await?;
                    state
                        .shadow
                        .write()
                        .unwrap()
                        .channels
                        .insert(channel, updated);
                }
                state.temporary_lockouts.write().unwrap().remove(&channel);
                false
            } else {
                if command_sender(&state).is_ok() {
                    let updated = set_channel_lockout_on_scanner(&state, channel, true).await?;
                    state
                        .shadow
                        .write()
                        .unwrap()
                        .channels
                        .insert(channel, updated);
                }
                state
                    .temporary_lockouts
                    .write()
                    .unwrap()
                    .insert(channel, frequency);
                true
            };
            Ok(Json(json!({
                "mode": "temporary",
                "frequency": frequency,
                "locked": locked,
                "channel": channel
            })))
        }
        "permanent" => {
            let live = state.live.read().unwrap().clone();
            let index = body
                .channel
                .or(live.channel)
                .ok_or_else(|| ApiError::BadRequest("channel_required".to_string()))?;
            let updated = if command_sender(&state).is_ok() {
                let current = {
                    let shadow = state.shadow.read().unwrap();
                    shadow
                        .channels
                        .get(&index)
                        .map(|c| c.lockout)
                        .unwrap_or(false)
                };
                set_channel_lockout_on_scanner(&state, index, !current).await?
            } else {
                let mut shadow = state.shadow.write().unwrap();
                let ch = shadow.channels.entry(index).or_insert(ChannelData {
                    index,
                    frequency: live.frequency,
                    modulation: live.modulation,
                    alpha_tag: live.alpha_tag.unwrap_or_default(),
                    delay: 2,
                    lockout: false,
                    priority: false,
                    tone_squelch: None,
                    tone_squelch_kind: Default::default(),
                    tone_dcs_code: None,
                    bank: crate::protocol::index_to_bank(index),
                });
                ch.lockout = !ch.lockout;
                ch.clone()
            };
            state
                .shadow
                .write()
                .unwrap()
                .channels
                .insert(index, updated.clone());
            state.temporary_lockouts.write().unwrap().remove(&index);
            Ok(Json(json!({ "mode": "permanent", "channel": updated })))
        }
        _ => Err(ApiError::BadRequest("invalid_lockout_mode".to_string())),
    }
}

#[derive(Deserialize)]
struct MemoryChannelsQuery {
    bank: Option<u8>,
    lockout: Option<bool>,
}

async fn get_memory_channels(
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

async fn get_memory_channel(
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

async fn put_memory_channel(
    State(state): State<AppState>,
    Path(index): Path<u16>,
    Json(mut body): Json<ChannelData>,
) -> Result<Json<ChannelData>, ApiError> {
    let _ = command_sender(&state)?;
    if !(1..=500).contains(&index) {
        return Err(ApiError::BadRequest("channel_out_of_range".to_string()));
    }
    body.index = index;
    if body.delay > 30 {
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
struct MemorySyncResponse {
    status: String,
    task_id: String,
}

async fn post_memory_sync(
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

async fn cancel_memory_sync(State(state): State<AppState>) -> Json<Value> {
    let task = state.sync_task_id.lock().unwrap().clone();
    if let Some(task_id) = task {
        state.sync_cancel_requested.store(true, Ordering::Relaxed);
        return Json(json!({ "status": "cancelling", "task_id": task_id }));
    }
    Json(json!({ "status": "no_task" }))
}

async fn program_mode_start(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
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

async fn program_mode_end(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
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

#[derive(Deserialize)]
struct LockoutsQuery {
    include_frequencies: Option<bool>,
}

#[derive(Serialize)]
struct LockoutsResponse {
    frequencies: Vec<f64>,
    channels: Vec<u16>,
    temporary_channels: Vec<Value>,
}

async fn get_lockouts(
    State(state): State<AppState>,
    Query(query): Query<LockoutsQuery>,
) -> Result<Json<LockoutsResponse>, ApiError> {
    let include_frequencies = query.include_frequencies.unwrap_or(true);
    let mut channels: Vec<u16> = {
        let shadow = state.shadow.read().unwrap();
        shadow
            .channels
            .values()
            .filter(|c| c.lockout)
            .map(|c| c.index)
            .collect()
    };
    channels.sort_unstable();

    let mut temporary_channels: Vec<Value> = {
        let temp = state.temporary_lockouts.read().unwrap();
        temp.iter()
            .map(|(channel, frequency)| json!({ "channel": channel, "frequency": frequency }))
            .collect()
    };
    temporary_channels.sort_by(|a, b| {
        a.get("channel")
            .and_then(Value::as_u64)
            .cmp(&b.get("channel").and_then(Value::as_u64))
    });

    let mut frequencies = Vec::new();
    if include_frequencies {
        let _ = command_sender(&state)?;
        let from_scanner = read_frequency_lockouts_from_scanner(&state).await?;
        let mut raw = state.frequency_lockouts.write().unwrap();
        raw.clear();
        raw.extend(from_scanner.iter().copied());
        let raw = state.frequency_lockouts.read().unwrap();
        frequencies = raw
            .iter()
            .map(|f| *f as f64 / 10000.0)
            .collect::<Vec<f64>>();
        frequencies.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    }

    Ok(Json(LockoutsResponse {
        frequencies,
        channels,
        temporary_channels,
    }))
}

async fn get_lockout_status(
    State(state): State<AppState>,
    Path(frequency): Path<f64>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let raw = (frequency * 10000.0).round().max(0.0) as u32;
    let from_scanner = read_frequency_lockouts_from_scanner(&state).await?;
    let mut set = state.frequency_lockouts.write().unwrap();
    set.clear();
    set.extend(from_scanner.iter().copied());
    let locked = state.frequency_lockouts.read().unwrap().contains(&raw);
    Ok(Json(json!({ "frequency": frequency, "locked": locked })))
}

async fn clear_temporary_lockouts(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let channels = state
        .temporary_lockouts
        .read()
        .unwrap()
        .keys()
        .copied()
        .collect::<Vec<u16>>();
    let mut cleared = Vec::new();
    let mut failed = Vec::new();
    for channel in channels {
        match set_channel_lockout_on_scanner(&state, channel, false).await {
            Ok(updated) => {
                state
                    .shadow
                    .write()
                    .unwrap()
                    .channels
                    .insert(channel, updated);
                state.temporary_lockouts.write().unwrap().remove(&channel);
                cleared.push(channel);
            }
            Err(_) => failed.push(channel),
        }
    }
    cleared.sort_unstable();
    failed.sort_unstable();
    Ok(Json(json!({ "cleared": cleared, "failed": failed })))
}

async fn clear_global_lockouts(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let mut cleared = Vec::new();
    let existing = read_frequency_lockouts_from_scanner(&state).await?;
    let _ = send_raw_command(&state, "PRG", false).await?;
    for frequency in &existing {
        let _ = send_raw_command(&state, &format!("ULF,{}", frequency), false).await;
        cleared.push(*frequency as f64 / 10000.0);
    }
    let _ = send_raw_command(&state, "EPG", false).await;
    cleared.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    state.frequency_lockouts.write().unwrap().clear();
    Ok(Json(json!({ "cleared": cleared, "failed": [] })))
}

#[derive(Deserialize)]
struct ClearChannelLockoutsRequest {
    channels: Option<Vec<u16>>,
}

async fn clear_channel_lockouts(
    State(state): State<AppState>,
    Json(body): Json<ClearChannelLockoutsRequest>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let targets: Vec<u16> = match body.channels {
        Some(channels) if !channels.is_empty() => channels,
        _ => {
            let shadow = state.shadow.read().unwrap();
            shadow
                .channels
                .values()
                .filter(|c| c.lockout)
                .map(|c| c.index)
                .collect()
        }
    };

    let mut cleared = Vec::new();
    let mut failed = Vec::new();
    for id in targets {
        match set_channel_lockout_on_scanner(&state, id, false).await {
            Ok(updated) => {
                state.shadow.write().unwrap().channels.insert(id, updated);
                cleared.push(id);
            }
            Err(_) => failed.push(id),
        }
    }
    cleared.sort_unstable();
    failed.sort_unstable();
    Ok(Json(json!({ "cleared": cleared, "failed": failed })))
}

async fn get_volume(State(state): State<AppState>) -> Json<Value> {
    if command_sender(&state).is_ok() {
        if let Ok(response) = send_raw_command(&state, "VOL", false).await {
            let mut parts = response.split(',').map(|s| s.trim()).collect::<Vec<&str>>();
            if parts.first().map(|p| p.eq_ignore_ascii_case("VOL")) == Some(true) {
                parts.remove(0);
            }
            if let Some(first) = parts.first() {
                if let Ok(volume) = first.parse::<u8>() {
                    if let Ok(mut live) = state.live.write() {
                        live.volume = volume.min(15);
                    }
                }
            }
        }
    }
    let volume = state.live.read().unwrap().volume;
    Json(json!({ "volume": volume }))
}

#[derive(Deserialize)]
struct VolumeRequest {
    volume: u8,
}

async fn set_volume(
    State(state): State<AppState>,
    Json(body): Json<VolumeRequest>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if body.volume > 15 {
        return Err(ApiError::BadRequest("volume_out_of_range".to_string()));
    }
    let response = send_raw_command(&state, &format!("VOL,{}", body.volume), false).await?;
    let upper = response.trim().to_uppercase();
    if !(upper == "OK" || upper.ends_with(",OK") || upper.starts_with("VOL,")) {
        return Err(ApiError::BadRequest("volume_failed".to_string()));
    }
    let mut live = state.live.write().unwrap();
    live.volume = body.volume;
    let seq = state.sequence.fetch_add(1, Ordering::Relaxed);
    let msg = json!({
        "type": "state_update",
        "timestamp": live.timestamp,
        "sequence": seq,
        "data": { "volume": body.volume }
    });
    let _ = state.ws_tx.send(msg.to_string());
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_squelch(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let _ = send_raw_command(&state, "PRG", false).await?;
    let response = send_raw_command(&state, "SQL", false).await;
    let _ = send_raw_command(&state, "EPG", false).await;
    let response = response?;
    let mut parts = response.split(',').map(|s| s.trim()).collect::<Vec<&str>>();
    if parts.first().map(|p| p.eq_ignore_ascii_case("SQL")) == Some(true) {
        parts.remove(0);
    }
    let level = parts
        .first()
        .and_then(|s| s.parse::<u8>().ok())
        .unwrap_or(0);
    let value = json!({ "level": level });
    set_setting_section(&state, "squelch", value.clone());
    Ok(Json(value))
}

#[derive(Deserialize)]
struct SquelchRequest {
    level: u8,
}

async fn set_squelch(
    State(state): State<AppState>,
    Json(body): Json<SquelchRequest>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if body.level > 15 {
        return Err(ApiError::BadRequest("squelch_out_of_range".to_string()));
    }
    let _ = send_raw_command(&state, "PRG", false).await?;
    let response = send_raw_command(&state, &format!("SQL,{}", body.level), false).await;
    let _ = send_raw_command(&state, "EPG", false).await;
    let response = response?;
    let upper = response.trim().to_uppercase();
    if !(upper == "OK" || upper.ends_with(",OK") || upper.starts_with("SQL,")) {
        return Err(ApiError::BadRequest("squelch_failed".to_string()));
    }
    set_setting_section(&state, "squelch", json!({ "level": body.level }));
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_config(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let snapshot = read_settings_snapshot_from_scanner(&state).await?;
    *state.settings.write().unwrap() = snapshot.clone();
    Ok(Json(snapshot))
}

async fn get_firmware(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let response = send_raw_command(&state, "VER", false).await?;
    let mut parts = response.split(',').map(|s| s.trim()).collect::<Vec<&str>>();
    if parts.first().map(|p| p.eq_ignore_ascii_case("VER")) == Some(true) {
        parts.remove(0);
    }
    let firmware = parts.join(",").trim().to_string();
    if let Ok(mut device) = state.device.write() {
        device.firmware = Some(firmware.clone());
    }
    Ok(Json(json!({ "firmware": firmware })))
}

async fn get_backlight(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, "BLT", false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
            let response = response?;
            let parts = parse_command_parts(&response, "BLT");
            Ok::<Value, ApiError>(
                json!({ "event": parts.first().cloned().unwrap_or_else(|| "AO".to_string()) }),
            )
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

async fn set_backlight(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let event = body
        .get("event")
        .and_then(Value::as_str)
        .unwrap_or("AO")
        .to_uppercase();
    if !matches!(event.as_str(), "AO" | "AF" | "KY" | "SQ" | "KS") {
        return Err(ApiError::BadRequest("backlight_invalid".to_string()));
    }
    if command_sender(&state).is_ok() {
        let _ = send_raw_command(&state, "PRG", false).await?;
        let response = send_raw_command(&state, &format!("BLT,{}", event), false).await;
        let _ = send_raw_command(&state, "EPG", false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("backlight_failed".to_string()));
        }
    }
    set_setting_section(&state, "backlight", json!({ "event": event }));
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_battery(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, "BSV", false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
            let response = response?;
            let parts = parse_command_parts(&response, "BSV");
            let value = parts
                .first()
                .and_then(|s| s.parse::<u8>().ok())
                .unwrap_or(0);
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

async fn set_battery(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let charge_time = body
        .get("charge_time")
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::BadRequest("battery_charge_time_out_of_range".to_string()))?
        as u8;
    if !(1..=16).contains(&charge_time) {
        return Err(ApiError::BadRequest(
            "battery_charge_time_out_of_range".to_string(),
        ));
    }
    if command_sender(&state).is_ok() {
        let _ = send_raw_command(&state, "PRG", false).await?;
        let response = send_raw_command(&state, &format!("BSV,{}", charge_time), false).await;
        let _ = send_raw_command(&state, "EPG", false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("battery_failed".to_string()));
        }
    }
    set_setting_section(&state, "battery", body);
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_key_beep(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, "KBP", false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
            let response = response?;
            let parts = parse_command_parts(&response, "KBP");
            let level = parts
                .first()
                .and_then(|s| s.parse::<i32>().ok())
                .unwrap_or(0);
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

async fn set_key_beep(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let level = body
        .get("level")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::BadRequest("beep_level_out_of_range".to_string()))?
        as i32;
    let lock = body.get("lock").and_then(Value::as_bool).unwrap_or(false);
    if level != 99 && !(0..=15).contains(&level) {
        return Err(ApiError::BadRequest("beep_level_out_of_range".to_string()));
    }
    if command_sender(&state).is_ok() {
        let _ = send_raw_command(&state, "PRG", false).await?;
        let response = send_raw_command(
            &state,
            &format!("KBP,{},{}", level, if lock { 1 } else { 0 }),
            false,
        )
        .await;
        let _ = send_raw_command(&state, "EPG", false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("key_beep_failed".to_string()));
        }
    }
    set_setting_section(&state, "key_beep", body);
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_priority(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, "PRI", false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
            let response = response?;
            let parts = parse_command_parts(&response, "PRI");
            let mode = parts
                .first()
                .and_then(|s| s.parse::<u8>().ok())
                .unwrap_or(0);
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

async fn set_priority(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let mode = body
        .get("mode")
        .and_then(Value::as_u64)
        .ok_or_else(|| ApiError::BadRequest("priority_mode_invalid".to_string()))?
        as u8;
    if !matches!(mode, 0..=3) {
        return Err(ApiError::BadRequest("priority_mode_invalid".to_string()));
    }
    if command_sender(&state).is_ok() {
        let _ = send_raw_command(&state, "PRG", false).await?;
        let response = send_raw_command(&state, &format!("PRI,{}", mode), false).await;
        let _ = send_raw_command(&state, "EPG", false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("priority_failed".to_string()));
        }
    }
    set_setting_section(&state, "priority", body);
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_search(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, "SCO", false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
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

async fn set_search(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let delay = body
        .get("delay")
        .and_then(Value::as_i64)
        .ok_or_else(|| ApiError::BadRequest("search_delay_invalid".to_string()))?
        as i32;
    let code_search = body
        .get("code_search")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if !matches!(delay, -10 | -5 | 0 | 1 | 2 | 3 | 4 | 5) {
        return Err(ApiError::BadRequest("search_delay_invalid".to_string()));
    }
    if command_sender(&state).is_ok() {
        let _ = send_raw_command(&state, "PRG", false).await?;
        let response = send_raw_command(
            &state,
            &format!("SCO,{},{}", delay, if code_search { 1 } else { 0 }),
            false,
        )
        .await;
        let _ = send_raw_command(&state, "EPG", false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK") || upper.starts_with("SCO,")) {
            return Err(ApiError::BadRequest("search_failed".to_string()));
        }
    }
    set_setting_section(&state, "search", body);
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_close_call(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, "CLC", false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
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

async fn set_close_call(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let mode = body.get("mode").and_then(Value::as_u64).unwrap_or(0) as u8;
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
    if !matches!(mode, 0 | 1 | 2) || band.len() != 5 {
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
        let _ = send_raw_command(&state, "PRG", false).await?;
        let response = send_raw_command(
            &state,
            &format!(
                "CLC,{},{},{},{},{}",
                mode,
                if alert_beep { 1 } else { 0 },
                if alert_light { 1 } else { 0 },
                band_str,
                if lockout { 1 } else { 0 }
            ),
            false,
        )
        .await;
        let _ = send_raw_command(&state, "EPG", false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("close_call_failed".to_string()));
        }
    }
    set_setting_section(&state, "close_call", body);
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_service_search(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, "SSG", false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
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

async fn set_service_search(
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
        let _ = send_raw_command(&state, "PRG", false).await?;
        let response = send_raw_command(&state, &format!("SSG,{}", flags), false).await;
        let _ = send_raw_command(&state, "EPG", false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("service_search_failed".to_string()));
        }
    }
    set_setting_section(&state, "service_search", body);
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_custom_search(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, "CSG", false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
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

async fn set_custom_search(
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
        let _ = send_raw_command(&state, "PRG", false).await?;
        let response = send_raw_command(&state, &format!("CSG,{}", flags), false).await;
        let _ = send_raw_command(&state, "EPG", false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("custom_search_failed".to_string()));
        }
    }
    set_setting_section(&state, "custom_search", body);
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_custom_range(
    State(state): State<AppState>,
    Path(index): Path<u8>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() && (1..=10).contains(&index) {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, &format!("CSP,{}", index), false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
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

async fn set_custom_range(
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
        let _ = send_raw_command(&state, "PRG", false).await?;
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
        let _ = send_raw_command(&state, "EPG", false).await;
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

async fn get_weather(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, "WXS", false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
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

async fn set_weather(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let priority = body
        .get("priority")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if command_sender(&state).is_ok() {
        let _ = send_raw_command(&state, "PRG", false).await?;
        let response = send_raw_command(
            &state,
            &format!("WXS,{}", if priority { 1 } else { 0 }),
            false,
        )
        .await;
        let _ = send_raw_command(&state, "EPG", false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("weather_failed".to_string()));
        }
    }
    set_setting_section(&state, "weather", body);
    Ok(Json(json!({ "status": "ok" })))
}

async fn get_contrast(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if command_sender(&state).is_ok() {
        let result = async {
            let _ = send_raw_command(&state, "PRG", false).await?;
            let response = send_raw_command(&state, "CNT", false).await;
            let _ = send_raw_command(&state, "EPG", false).await;
            let response = response?;
            let parts = parse_command_parts(&response, "CNT");
            let level = parts
                .first()
                .and_then(|s| s.parse::<u8>().ok())
                .unwrap_or(0);
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

async fn set_contrast(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let level = body.get("level").and_then(Value::as_u64).unwrap_or(0) as u8;
    if !(1..=15).contains(&level) {
        return Err(ApiError::BadRequest("contrast_out_of_range".to_string()));
    }
    if command_sender(&state).is_ok() {
        let _ = send_raw_command(&state, "PRG", false).await?;
        let response = send_raw_command(&state, &format!("CNT,{}", level), false).await;
        let _ = send_raw_command(&state, "EPG", false).await;
        let response = response?;
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest("contrast_failed".to_string()));
        }
    }
    set_setting_section(&state, "contrast", body);
    Ok(Json(json!({ "status": "ok" })))
}

fn split_command_parts(response: &str) -> Vec<String> {
    let mut parts = response
        .trim()
        .split(',')
        .map(|s| s.trim().to_string())
        .collect::<Vec<String>>();
    if parts
        .first()
        .map(|p| p.chars().all(|c| c.is_ascii_alphabetic()))
        .unwrap_or(false)
    {
        parts.remove(0);
    }
    while parts.last().map(|s| s.is_empty()).unwrap_or(false) {
        parts.pop();
    }
    parts
}

fn flags_to_bools(flags: &str) -> Vec<bool> {
    flags.trim().chars().map(|ch| ch == '0').collect()
}

fn on_off(value: &str) -> &'static str {
    if value == "1" {
        "On"
    } else {
        "Off"
    }
}

fn format_modulation(value: &str) -> String {
    if value.eq_ignore_ascii_case("AUTO") || value.is_empty() {
        "Auto".to_string()
    } else {
        value.to_uppercase()
    }
}

fn ctcss_code_to_tone(code: i32) -> Option<f64> {
    match code {
        64 => Some(67.0),
        65 => Some(69.3),
        66 => Some(71.9),
        67 => Some(74.4),
        68 => Some(77.0),
        69 => Some(79.7),
        70 => Some(82.5),
        71 => Some(85.4),
        72 => Some(88.5),
        73 => Some(91.5),
        74 => Some(94.8),
        75 => Some(97.4),
        76 => Some(100.0),
        77 => Some(103.5),
        78 => Some(107.2),
        79 => Some(110.9),
        80 => Some(114.8),
        81 => Some(118.8),
        82 => Some(123.0),
        83 => Some(127.3),
        84 => Some(131.8),
        85 => Some(136.5),
        86 => Some(141.3),
        87 => Some(146.2),
        88 => Some(151.4),
        89 => Some(156.7),
        90 => Some(159.8),
        91 => Some(162.2),
        92 => Some(165.5),
        93 => Some(167.9),
        94 => Some(171.3),
        95 => Some(173.8),
        96 => Some(177.3),
        97 => Some(179.9),
        98 => Some(183.5),
        99 => Some(186.2),
        100 => Some(189.9),
        101 => Some(192.8),
        102 => Some(196.6),
        103 => Some(199.5),
        104 => Some(203.5),
        105 => Some(206.5),
        106 => Some(210.7),
        107 => Some(218.1),
        108 => Some(225.7),
        109 => Some(229.1),
        110 => Some(233.6),
        111 => Some(241.8),
        112 => Some(250.3),
        113 => Some(254.1),
        _ => None,
    }
}

fn dcs_code_to_string(code: i32) -> Option<String> {
    let value = match code {
        128 => 23,
        129 => 25,
        130 => 26,
        131 => 31,
        132 => 32,
        133 => 36,
        134 => 43,
        135 => 47,
        136 => 51,
        137 => 53,
        138 => 54,
        139 => 65,
        140 => 71,
        141 => 72,
        142 => 73,
        143 => 74,
        144 => 114,
        145 => 115,
        146 => 116,
        147 => 122,
        148 => 125,
        149 => 131,
        150 => 132,
        151 => 134,
        152 => 143,
        153 => 145,
        154 => 152,
        155 => 155,
        156 => 156,
        157 => 162,
        158 => 165,
        159 => 172,
        160 => 174,
        161 => 205,
        162 => 212,
        163 => 223,
        164 => 225,
        165 => 226,
        166 => 243,
        167 => 244,
        168 => 245,
        169 => 246,
        170 => 251,
        171 => 252,
        173 => 261,
        174 => 263,
        175 => 265,
        176 => 266,
        177 => 271,
        178 => 274,
        179 => 306,
        180 => 311,
        181 => 315,
        182 => 325,
        183 => 331,
        184 => 332,
        185 => 343,
        186 => 346,
        187 => 351,
        188 => 356,
        189 => 364,
        190 => 365,
        191 => 371,
        192 => 411,
        193 => 412,
        194 => 413,
        195 => 423,
        196 => 431,
        197 => 432,
        198 => 445,
        199 => 446,
        200 => 452,
        201 => 454,
        202 => 455,
        203 => 462,
        204 => 464,
        205 => 465,
        206 => 466,
        207 => 503,
        208 => 506,
        209 => 516,
        210 => 523,
        211 => 526,
        212 => 532,
        213 => 546,
        214 => 565,
        215 => 606,
        216 => 612,
        217 => 624,
        218 => 627,
        219 => 631,
        220 => 632,
        221 => 654,
        222 => 662,
        223 => 664,
        224 => 703,
        225 => 712,
        226 => 723,
        227 => 731,
        228 => 732,
        229 => 734,
        230 => 743,
        231 => 754,
        _ => return None,
    };
    Some(format!("DCS {:03}", value))
}

fn ctcss_dcs_to_string(code: &str) -> String {
    if code.is_empty() || code == "0" || code == "240" {
        return "Off".to_string();
    }
    if code == "127" {
        return "Srch".to_string();
    }
    let Ok(value) = code.parse::<i32>() else {
        return "Off".to_string();
    };
    if (64..=113).contains(&value) {
        return ctcss_code_to_tone(value)
            .map(|v| format!("{:.1}", v))
            .unwrap_or_else(|| "Off".to_string());
    }
    if (128..=231).contains(&value) {
        return dcs_code_to_string(value).unwrap_or_else(|| "Off".to_string());
    }
    "Off".to_string()
}

async fn export_bc125at_ss_file(
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
        let _ = send_raw_command(&state, "PRG", false).await?;

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
            let tone = ctcss_dcs_to_string(parts.get(3).map(String::as_str).unwrap_or("0"));
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
    let _ = send_raw_command(&state, "EPG", false).await;
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

async fn export_csv(State(state): State<AppState>) -> impl IntoResponse {
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

async fn import_csv(
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

fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
}

async fn get_preferences(State(state): State<AppState>) -> Json<Value> {
    Json(Value::Object(state.preferences.lock().unwrap().clone()))
}

async fn get_preference(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let prefs = state.preferences.lock().unwrap();
    let value = prefs
        .get(&key)
        .cloned()
        .ok_or_else(|| ApiError::NotFound(format!("Unknown preference: {}", key)))?;
    Ok(Json(json!({ "key": key, "value": value })))
}

async fn set_preference(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let value = body
        .get("value")
        .cloned()
        .ok_or_else(|| ApiError::BadRequest("value_required".to_string()))?;
    state
        .preferences
        .lock()
        .unwrap()
        .insert(key.clone(), value.clone());
    save_preference_to_db(&state.preferences_db_path, &key, &value);
    Ok(Json(json!({ "key": key, "value": value })))
}

async fn set_preferences(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let Value::Object(map) = body else {
        return Err(ApiError::BadRequest(
            "invalid_preferences_payload".to_string(),
        ));
    };
    let mut prefs = state.preferences.lock().unwrap();
    for (k, v) in map {
        save_preference_to_db(&state.preferences_db_path, &k, &v);
        prefs.insert(k, v);
    }
    Ok(Json(Value::Object(prefs.clone())))
}

async fn reset_preferences(State(state): State<AppState>) -> Json<Value> {
    reset_preferences_db(&state.preferences_db_path);
    *state.preferences.lock().unwrap() = default_preferences();
    Json(Value::Object(state.preferences.lock().unwrap().clone()))
}

async fn debug_glg(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let response = send_raw_command(&state, "GLG", true).await?;
    Ok(Json(json!({ "response": response })))
}

async fn debug_scg(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = send_raw_command(&state, "PRG", false).await?;
    let response = send_raw_command(&state, "SCG", false).await;
    let _ = send_raw_command(&state, "EPG", false).await;
    Ok(Json(json!({ "response": response? })))
}

async fn debug_glf(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _ = send_raw_command(&state, "PRG", false).await?;
    let result = async {
        let mut responses = Vec::new();
        let first = send_raw_command(&state, "GLF,***", false).await?;
        responses.push(format!("GLF,*** => {}", first.trim()));
        let mut next = parse_glf_response(&first);
        if next.is_none() {
            let plain = send_raw_command(&state, "GLF", false).await?;
            responses.push(format!("GLF => {}", plain.trim()));
            next = parse_glf_response(&plain);
        }
        for _ in 0..20 {
            let Some(value) = next else { break };
            let response = send_raw_command(&state, &format!("GLF,{}", value), false).await?;
            responses.push(format!("GLF,{} => {}", value, response.trim()));
            next = parse_glf_response(&response);
        }
        Ok::<Vec<String>, ApiError>(responses)
    }
    .await;
    let _ = send_raw_command(&state, "EPG", false).await;
    Ok(Json(json!({ "responses": result? })))
}

async fn simulate_hit(State(state): State<AppState>) -> Json<Value> {
    let now = epoch_now();
    let live = LiveState {
        timestamp: now,
        frequency: 162.55,
        modulation: "FM".to_string(),
        squelch_open: true,
        rssi: 75,
        mode: ScannerMode::Scan,
        channel: Some(1),
        alpha_tag: Some("Test Channel".to_string()),
        volume: 5,
        battery: None,
        stale: false,
    };
    broadcast_state_update(&state, &live);

    let state_for_close = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let close_live = LiveState {
            timestamp: epoch_now(),
            frequency: 162.55,
            modulation: "FM".to_string(),
            squelch_open: false,
            rssi: 0,
            mode: ScannerMode::Scan,
            channel: Some(1),
            alpha_tag: Some("Test Channel".to_string()),
            volume: 5,
            battery: None,
            stale: false,
        };
        broadcast_state_update(&state_for_close, &close_live);
    });

    Json(json!({ "message": "Simulated hit", "frequency": 162.550, "duration": 2 }))
}

#[derive(Deserialize)]
struct AnalyticsBusiestQuery {
    limit: Option<usize>,
    hours: Option<f64>,
}

async fn analytics_busiest(
    State(state): State<AppState>,
    Query(query): Query<AnalyticsBusiestQuery>,
) -> Json<Value> {
    let limit = query.limit.unwrap_or(10).max(1);
    let hours = query.hours.unwrap_or(24.0).max(0.1);
    let cutoff = epoch_now() - (hours * 3600.0);
    let min_duration = min_hit_duration(&state);

    let log = state.analytics_log.lock().unwrap();
    let mut grouped: HashMap<String, (f64, Option<String>, Option<u16>, usize, f64, f64)> =
        HashMap::new();
    for hit in log
        .iter()
        .filter(|h| h.timestamp >= cutoff && h.duration >= min_duration)
    {
        let key = format!("{}|{}", hit.frequency, hit.channel.unwrap_or(0));
        let entry = grouped.entry(key).or_insert((
            hit.frequency,
            hit.alpha_tag.clone(),
            hit.channel,
            0,
            0.0,
            0.0,
        ));
        entry.3 += 1;
        entry.4 += hit.duration;
        if hit.timestamp > entry.5 {
            entry.5 = hit.timestamp;
        }
    }

    let mut rows: Vec<Value> = grouped
        .into_values()
        .map(|(frequency, alpha_tag, channel, hit_count, total_duration, last_seen)| {
            json!({
                "frequency": frequency,
                "alpha_tag": alpha_tag,
                "channel": channel,
                "hit_count": hit_count,
                "avg_duration": if hit_count > 0 { total_duration / hit_count as f64 } else { 0.0 },
                "last_seen": last_seen
            })
        })
        .collect();
    rows.sort_by(|a, b| {
        b.get("hit_count")
            .and_then(Value::as_u64)
            .cmp(&a.get("hit_count").and_then(Value::as_u64))
    });
    rows.truncate(limit);
    for (idx, row) in rows.iter_mut().enumerate() {
        if let Value::Object(map) = row {
            map.insert("rank".to_string(), Value::from((idx + 1) as u64));
        }
    }

    Json(json!({ "channels": rows }))
}

async fn analytics_session_stats(State(state): State<AppState>) -> Json<Value> {
    let session_id = (*state.session_id).clone();
    let min_duration = min_hit_duration(&state);
    let log = state.analytics_log.lock().unwrap();
    let mut total_hits = 0usize;
    let mut rssi_sum = 0u64;
    let mut active_time_seconds = 0.0f64;
    let mut unique_channels: HashSet<u16> = HashSet::new();

    for hit in log
        .iter()
        .filter(|h| h.session_id == session_id && h.duration >= min_duration)
    {
        total_hits += 1;
        rssi_sum += hit.rssi as u64;
        active_time_seconds += hit.duration;
        if let Some(ch) = hit.channel {
            unique_channels.insert(ch);
        }
    }

    Json(json!({
        "total_hits": total_hits,
        "avg_rssi": if total_hits > 0 { (rssi_sum as f64) / (total_hits as f64) } else { 0.0 },
        "active_time_seconds": active_time_seconds,
        "unique_channels": unique_channels.len()
    }))
}

#[derive(Deserialize)]
struct HourlyHeatmapQuery {
    days: Option<u32>,
}

async fn analytics_hourly_heatmap(
    State(state): State<AppState>,
    Query(query): Query<HourlyHeatmapQuery>,
) -> Json<Value> {
    let days = query.days.unwrap_or(7).max(1);
    let cutoff = epoch_now() - (days as f64 * 24.0 * 3600.0);
    let min_duration = min_hit_duration(&state);
    let log = state.analytics_log.lock().unwrap();
    let mut bins: HashMap<(u32, u32), u64> = HashMap::new();
    for hit in log
        .iter()
        .filter(|h| h.timestamp >= cutoff && h.duration >= min_duration)
    {
        let (day, hour) = day_hour(hit.timestamp);
        *bins.entry((day, hour)).or_insert(0) += 1;
    }
    let mut heatmap = Vec::new();
    let mut counts = Vec::new();
    for ((day, hour), count) in bins {
        counts.push(count as f64);
        heatmap.push(json!({ "hour": hour, "day": day, "count": count }));
    }
    heatmap.sort_by(|a, b| {
        a.get("day")
            .and_then(Value::as_u64)
            .cmp(&b.get("day").and_then(Value::as_u64))
            .then_with(|| {
                a.get("hour")
                    .and_then(Value::as_u64)
                    .cmp(&b.get("hour").and_then(Value::as_u64))
            })
    });
    let min = counts
        .iter()
        .cloned()
        .fold(0.0, |acc, v| if acc == 0.0 { v } else { acc.min(v) });
    let max = counts.iter().cloned().fold(0.0, f64::max);
    let avg = if counts.is_empty() {
        0.0
    } else {
        counts.iter().sum::<f64>() / counts.len() as f64
    };
    Json(json!({ "heatmap": heatmap, "stats": { "min": min, "max": max, "avg": avg } }))
}

#[derive(Deserialize)]
struct ActivityLogQuery {
    limit: Option<usize>,
    offset: Option<usize>,
    start_time: Option<f64>,
    end_time: Option<f64>,
    channel: Option<u16>,
}

async fn analytics_activity_log(
    State(state): State<AppState>,
    Query(query): Query<ActivityLogQuery>,
) -> Json<Value> {
    let limit = query.limit.unwrap_or(100);
    let offset = query.offset.unwrap_or(0);
    let start = query.start_time.unwrap_or(0.0);
    let end = query.end_time.unwrap_or(f64::MAX);
    let channel_filter = query.channel;
    let mut rows = state
        .analytics_log
        .lock()
        .unwrap()
        .iter()
        .filter(|h| h.timestamp >= start && h.timestamp <= end)
        .filter(|h| channel_filter.map(|c| h.channel == Some(c)).unwrap_or(true))
        .cloned()
        .collect::<Vec<ActivityHit>>();
    rows.sort_by(|a, b| {
        b.timestamp
            .partial_cmp(&a.timestamp)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let slice = rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<ActivityHit>>();
    Json(json!(slice))
}

#[derive(Deserialize)]
struct AnalyticsCleanupQuery {
    retention_days: Option<u32>,
}

async fn analytics_cleanup(
    State(state): State<AppState>,
    Query(query): Query<AnalyticsCleanupQuery>,
) -> Json<Value> {
    let days = query.retention_days.unwrap_or(30) as f64;
    let cutoff = epoch_now() - (days * 24.0 * 3600.0);
    let mut log = state.analytics_log.lock().unwrap();
    let before = log.len();
    log.retain(|h| h.timestamp >= cutoff);
    let deleted_mem = before - log.len();
    let deleted_db =
        cleanup_analytics_db(&state.analytics_db_path, query.retention_days.unwrap_or(30));
    Json(json!({ "deleted_records": deleted_mem.max(deleted_db) }))
}

#[derive(Debug)]
pub enum ApiError {
    NoScanner,
    SendFailed,
    BadRequest(String),
    NotFound(String),
    Conflict(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match &self {
            ApiError::NoScanner => (StatusCode::SERVICE_UNAVAILABLE, "device_disconnected"),
            ApiError::SendFailed => (StatusCode::SERVICE_UNAVAILABLE, "Command channel closed"),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.as_str()),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.as_str()),
            ApiError::Conflict(msg) => (StatusCode::CONFLICT, msg.as_str()),
        };
        (
            status,
            Json(json!({
                "error": message,
                "message": message,
                "code": status.as_u16()
            })),
        )
            .into_response()
    }
}

async fn ws_handler(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    ws.on_upgrade(move |socket| handle_socket(state.clone(), socket))
}

async fn handle_socket(state: AppState, mut socket: WebSocket) {
    let mut rx = state.ws_tx.subscribe();
    loop {
        tokio::select! {
            Ok(msg) = rx.recv() => {
                if socket.send(Message::Text(msg.into())).await.is_err() {
                    break;
                }
            }
            next = socket.recv() => {
                if next.is_none() {
                    break;
                }
            }
        }
    }
}

pub async fn run_server(
    bind: &str,
    mut state: AppState,
    serial_port: Option<(String, u32)>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    run_server_with_shutdown(bind, state, serial_port, std::future::pending()).await
}

/// Like `run_server` but accepts a shutdown future. When the future resolves,
/// the server drains in-flight requests and exits cleanly.
pub async fn run_server_with_shutdown(
    bind: &str,
    mut state: AppState,
    serial_port: Option<(String, u32)>,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some((port_name, baud)) = serial_port {
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        state.command_tx = Arc::new(Mutex::new(Some(cmd_tx)));
        spawn_poll_loop(state.clone(), port_name, baud, cmd_rx);
        if let Ok(mut d) = state.device.write() {
            d.connection_status = "connecting".to_string();
            d.diagnostic_code = None;
            d.diagnostic_message = None;
        }
    } else {
        warn!("No scanner port resolved; API starting without poll loop");
        if let Ok(mut d) = state.device.write() {
            d.connection_status = "disconnected".to_string();
            d.diagnostic_code = Some("scanner_not_found".to_string());
            d.diagnostic_message = Some(
                "No scanner port resolved from config/auto-detect. Check USB/serial settings."
                    .to_string(),
            );
        }
    }

    let cleanup_state = state.clone();
    tokio::spawn(async move {
        loop {
            let retention_days = analytics_retention_days(&cleanup_state);
            let deleted = tokio::task::spawn_blocking({
                let path = (*cleanup_state.analytics_db_path).clone();
                move || cleanup_analytics_db(&path, retention_days)
            })
            .await
            .unwrap_or(0);
            info!(
                retention_days = retention_days,
                deleted_records = deleted,
                "analytics cleanup run complete"
            );
            tokio::time::sleep(Duration::from_secs(24 * 60 * 60)).await;
        }
    });

    let listener = tokio::net::TcpListener::bind(bind).await?;
    info!("Bearpaw API listening on http://{}", bind);
    axum::serve(listener, router(state).into_make_service())
        .with_graceful_shutdown(shutdown)
        .await?;
    info!("Bearpaw API server shut down gracefully");
    Ok(())
}

pub fn default_state() -> AppState {
    let preferences_db_path = resolve_db_path("BEARPAW_PREFERENCES_DB", "scanner.db");
    let analytics_db_path = resolve_db_path("BEARPAW_ANALYTICS_DB", "analytics.db");
    init_preferences_db(&preferences_db_path);
    init_analytics_db(&analytics_db_path);
    let loaded_preferences = load_preferences_from_db(&preferences_db_path);
    let loaded_hits = load_analytics_hits_from_db(&analytics_db_path);
    let retention_days = extract_retention_days(&loaded_preferences);
    let _ = cleanup_analytics_db(&analytics_db_path, retention_days);
    let next_hit_id = loaded_hits
        .last()
        .and_then(|h| h.id.parse::<u64>().ok())
        .unwrap_or(0);

    let (ws_tx, _) = broadcast::channel(64);
    AppState {
        live: Arc::new(std::sync::RwLock::new(LiveState::default())),
        device: Arc::new(std::sync::RwLock::new(DeviceInfo {
            connection_status: "disconnected".to_string(),
            ..Default::default()
        })),
        shadow: Arc::new(std::sync::RwLock::new(ShadowState::default())),
        banks: Arc::new(std::sync::RwLock::new(vec![true; 10])),
        settings: Arc::new(std::sync::RwLock::new(config_snapshot_value(None))),
        temporary_lockouts: Arc::new(std::sync::RwLock::new(HashMap::new())),
        frequency_lockouts: Arc::new(std::sync::RwLock::new(HashSet::new())),
        sync_task_id: Arc::new(Mutex::new(None)),
        sync_cancel_requested: Arc::new(AtomicBool::new(false)),
        analytics_log: Arc::new(Mutex::new(loaded_hits)),
        active_hit: Arc::new(Mutex::new(None)),
        next_hit_id: Arc::new(AtomicU64::new(next_hit_id)),
        session_id: Arc::new(format!("session-{}", uuid_simple())),
        preferences_db_path: Arc::new(preferences_db_path),
        analytics_db_path: Arc::new(analytics_db_path),
        preferences: Arc::new(Mutex::new(loaded_preferences)),
        ws_tx,
        sequence: Arc::new(AtomicU64::new(0)),
        command_tx: Arc::new(Mutex::new(None)),
        program_mode_forced_hold: Arc::new(AtomicBool::new(false)),
        program_mode_active: Arc::new(AtomicBool::new(false)),
    }
}

fn default_preferences() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("theme".to_string(), Value::String("dark".to_string()));
    m.insert(
        "displayMode".to_string(),
        Value::String("frequency".to_string()),
    );
    m.insert("reduced_motion".to_string(), Value::Bool(false));
    m.insert("hit_min_duration".to_string(), Value::from(2));
    m.insert("start_dashboard_mode".to_string(), Value::Bool(true));
    m.insert("auto_connect".to_string(), Value::Bool(false));
    m.insert("check_updates".to_string(), Value::Bool(true));
    m.insert("data_retention_days".to_string(), Value::from(30));
    m.insert("mqtt_enabled".to_string(), Value::Bool(false));
    m.insert(
        "mqtt_host".to_string(),
        Value::String("127.0.0.1".to_string()),
    );
    m.insert("mqtt_port".to_string(), Value::from(1883));
    m.insert(
        "mqtt_topic_prefix".to_string(),
        Value::String("scanner".to_string()),
    );
    m.insert("mqtt_qos".to_string(), Value::from(0));
    m.insert("mqtt_retain".to_string(), Value::Bool(false));
    m
}

fn config_snapshot_value(firmware: Option<String>) -> Value {
    json!({
        "firmware": firmware,
        "squelch": { "level": 0 },
        "backlight": { "event": "AO" },
        "battery": { "charge_time": 16 },
        "key_beep": { "level": 1, "lock": false },
        "priority": { "mode": 0 },
        "search": { "delay": 2, "code_search": false },
        "close_call": {
            "mode": 0,
            "alert_beep": false,
            "alert_light": false,
            "band": [false, false, false, false, false],
            "lockout": false
        },
        "service_search": { "groups": [false, false, false, false, false, false, false, false, false, false] },
        "custom_search": { "groups": [false, false, false, false, false, false, false, false, false, false] },
        "custom_search_ranges": [],
        "weather": { "priority": false },
        "contrast": { "level": 8 }
    })
}

fn get_setting_section(state: &AppState, key: &str, fallback: Value) -> Value {
    state
        .settings
        .read()
        .unwrap()
        .get(key)
        .cloned()
        .unwrap_or(fallback)
}

fn set_setting_section(state: &AppState, key: &str, value: Value) {
    let mut config = state.settings.write().unwrap();
    if let Value::Object(ref mut map) = *config {
        map.insert(key.to_string(), value);
    }
}

pub(crate) fn track_analytics_transition(
    state: &AppState,
    live: &LiveState,
    prev_squelch_open: bool,
) {
    if live.squelch_open && !prev_squelch_open {
        let mut active = state.active_hit.lock().unwrap();
        *active = Some(ActiveHit {
            timestamp: live.timestamp,
            frequency: live.frequency,
            channel: live.channel,
            alpha_tag: live.alpha_tag.clone(),
            rssi: live.rssi,
            modulation: live.modulation.clone(),
            mode: live.mode,
            bank: None,
        });
        return;
    }

    if !live.squelch_open && prev_squelch_open {
        let mut active = state.active_hit.lock().unwrap();
        if let Some(open_hit) = active.take() {
            let duration = (live.timestamp - open_hit.timestamp).max(0.0);
            if duration >= min_hit_duration(state) {
                let id = state.next_hit_id.fetch_add(1, Ordering::Relaxed) + 1;
                let entry = ActivityHit {
                    id: id.to_string(),
                    timestamp: open_hit.timestamp,
                    frequency: open_hit.frequency,
                    channel: open_hit.channel,
                    alpha_tag: open_hit.alpha_tag,
                    rssi: open_hit.rssi,
                    duration,
                    modulation: open_hit.modulation,
                    mode: open_hit.mode,
                    bank: open_hit.bank,
                    session_id: (*state.session_id).clone(),
                    ended_at: live.timestamp,
                };
                {
                    state.analytics_log.lock().unwrap().push(entry.clone());
                }
                insert_analytics_hit(&state.analytics_db_path, &entry);
            }
        }
    }
}

fn min_hit_duration(state: &AppState) -> f64 {
    let prefs = state.preferences.lock().unwrap();
    prefs
        .get("hit_min_duration")
        .and_then(Value::as_f64)
        .or_else(|| {
            prefs
                .get("hit_min_duration")
                .and_then(Value::as_i64)
                .map(|v| v as f64)
        })
        .unwrap_or(2.0)
}

fn extract_retention_days(prefs: &Map<String, Value>) -> u32 {
    prefs
        .get("data_retention_days")
        .and_then(Value::as_u64)
        .map(|v| v as u32)
        .or_else(|| {
            prefs
                .get("data_retention_days")
                .and_then(Value::as_i64)
                .map(|v| if v < 0 { 0 } else { v as u32 })
        })
        .unwrap_or(30)
}

fn analytics_retention_days(state: &AppState) -> u32 {
    let prefs = state.preferences.lock().unwrap();
    extract_retention_days(&prefs)
}

fn init_preferences_db(path: &str) {
    if let Some(conn) = open_sqlite(path) {
        migrate_preferences_db(path, &conn);
    }
}

fn load_preferences_from_db(path: &str) -> Map<String, Value> {
    let mut prefs = default_preferences();
    if let Some(conn) = open_sqlite(path) {
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL)",
            [],
        );
        if let Ok(mut stmt) = conn.prepare("SELECT key, value FROM preferences") {
            let rows = stmt.query_map([], |row| {
                let key: String = row.get(0)?;
                let value_json: String = row.get(1)?;
                Ok((key, value_json))
            });
            if let Ok(rows) = rows {
                for row in rows.flatten() {
                    if let Ok(value) = serde_json::from_str::<Value>(&row.1) {
                        prefs.insert(row.0, value);
                    }
                }
            }
        }
    }
    prefs
}

fn save_preference_to_db(path: &str, key: &str, value: &Value) {
    if let Some(conn) = open_sqlite(path) {
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL)",
            [],
        );
        let _ = conn.execute(
            "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?1, ?2, strftime('%s','now'))",
            rusqlite::params![key, value.to_string()],
        );
    }
}

fn reset_preferences_db(path: &str) {
    if let Some(conn) = open_sqlite(path) {
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL)",
            [],
        );
        let _ = conn.execute("DELETE FROM preferences", []);
    }
}

fn init_analytics_db(path: &str) {
    if let Some(conn) = open_sqlite(path) {
        migrate_analytics_db(path, &conn);
    }
}

fn load_analytics_hits_from_db(path: &str) -> Vec<ActivityHit> {
    let mut out = Vec::new();
    if let Some(conn) = open_sqlite(path) {
        let _ = conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS scan_hits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                frequency REAL NOT NULL,
                channel INTEGER,
                alpha_tag TEXT,
                modulation TEXT NOT NULL,
                rssi INTEGER NOT NULL,
                duration REAL,
                mode TEXT NOT NULL,
                bank INTEGER,
                session_id TEXT NOT NULL,
                ended_at REAL
            );
            ",
        );
        if let Ok(mut stmt) = conn.prepare(
            "SELECT id, timestamp, frequency, channel, alpha_tag, modulation, rssi, duration, mode, bank, session_id, ended_at
             FROM scan_hits ORDER BY timestamp DESC LIMIT 5000",
        ) {
            let rows = stmt.query_map([], |row| {
                let id: i64 = row.get(0)?;
                let timestamp: f64 = row.get(1)?;
                let frequency: f64 = row.get(2)?;
                let channel: Option<u16> = row.get(3)?;
                let alpha_tag: Option<String> = row.get(4)?;
                let modulation: String = row.get(5)?;
                let rssi: i64 = row.get(6)?;
                let duration: Option<f64> = row.get(7)?;
                let mode: String = row.get(8)?;
                let bank: Option<u8> = row.get(9)?;
                let session_id: String = row.get(10)?;
                let ended_at: Option<f64> = row.get(11)?;
                Ok(ActivityHit {
                    id: id.to_string(),
                    timestamp,
                    frequency,
                    channel,
                    alpha_tag,
                    rssi: rssi as u8,
                    duration: duration.unwrap_or(0.0),
                    modulation,
                    mode: ScannerMode::from_str(&mode),
                    bank,
                    session_id,
                    ended_at: ended_at.unwrap_or(timestamp),
                })
            });
            if let Ok(rows) = rows {
                out.extend(rows.flatten());
            }
        }
        out.sort_by(|a, b| {
            a.timestamp
                .partial_cmp(&b.timestamp)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
    out
}

fn insert_analytics_hit(path: &str, hit: &ActivityHit) {
    if let Some(conn) = open_sqlite(path) {
        let _ = conn.execute(
            "INSERT INTO scan_hits (timestamp, frequency, channel, alpha_tag, modulation, rssi, duration, mode, bank, session_id, ended_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            rusqlite::params![
                hit.timestamp,
                hit.frequency,
                hit.channel,
                hit.alpha_tag,
                hit.modulation,
                hit.rssi as i64,
                hit.duration,
                hit.mode.as_str(),
                hit.bank,
                hit.session_id,
                hit.ended_at
            ],
        );
    }
}

fn cleanup_analytics_db(path: &str, retention_days: u32) -> usize {
    if let Some(conn) = open_sqlite(path) {
        let cutoff = epoch_now() - (retention_days as f64 * 24.0 * 3600.0);
        if let Ok(deleted) = conn.execute(
            "DELETE FROM scan_hits WHERE timestamp < ?1",
            rusqlite::params![cutoff],
        ) {
            return deleted;
        }
    }
    0
}

fn resolve_db_path(env_key: &str, default_file: &str) -> String {
    if let Ok(raw) = std::env::var(env_key) {
        if !raw.trim().is_empty() {
            let candidate = PathBuf::from(raw);
            if candidate.is_absolute() {
                return candidate.to_string_lossy().into_owned();
            }
            return default_data_dir()
                .join(candidate)
                .to_string_lossy()
                .into_owned();
        }
    }
    default_data_dir()
        .join(default_file)
        .to_string_lossy()
        .into_owned()
}

fn backup_db_if_needed(path: &str, label: &str, from_version: i32, target_version: i32) {
    if from_version >= target_version {
        return;
    }
    let source = PathBuf::from(path);
    if !source.exists() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup_name = format!(
        "{}.v{}-to-v{}.{}.{}.bak",
        source
            .file_name()
            .and_then(|v| v.to_str())
            .unwrap_or("database.db"),
        from_version,
        target_version,
        label,
        ts
    );
    let backup_path = source
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join(backup_name);
    let _ = std::fs::copy(source, backup_path);
}

fn schema_version(conn: &rusqlite::Connection) -> i32 {
    conn.pragma_query_value(None, "user_version", |row| row.get::<usize, i32>(0))
        .unwrap_or(0)
}

fn set_schema_version(conn: &rusqlite::Connection, version: i32) {
    let _ = conn.pragma_update(None, "user_version", version);
}

fn migrate_preferences_db(path: &str, conn: &rusqlite::Connection) {
    let current = schema_version(conn);
    if current > 0 || has_user_tables(conn) {
        backup_db_if_needed(path, "preferences", current, PREFERENCES_SCHEMA_VERSION);
    }
    if current < 1 {
        let _ = conn.execute(
            "CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL)",
            [],
        );
        set_schema_version(conn, 1);
    }
}

fn migrate_analytics_db(path: &str, conn: &rusqlite::Connection) {
    let current = schema_version(conn);
    if current > 0 || has_user_tables(conn) {
        backup_db_if_needed(path, "analytics", current, ANALYTICS_SCHEMA_VERSION);
    }
    if current < 1 {
        let _ = conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS scan_hits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                frequency REAL NOT NULL,
                channel INTEGER,
                alpha_tag TEXT,
                modulation TEXT NOT NULL,
                rssi INTEGER NOT NULL,
                duration REAL,
                mode TEXT NOT NULL,
                bank INTEGER,
                session_id TEXT NOT NULL,
                ended_at REAL
            );
            CREATE INDEX IF NOT EXISTS idx_hits_timestamp ON scan_hits(timestamp DESC);
            CREATE INDEX IF NOT EXISTS idx_hits_channel ON scan_hits(channel);
            CREATE INDEX IF NOT EXISTS idx_hits_frequency ON scan_hits(frequency);
            CREATE INDEX IF NOT EXISTS idx_hits_session ON scan_hits(session_id);
            ",
        );
        set_schema_version(conn, 1);
    }
}

fn has_user_tables(conn: &rusqlite::Connection) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        [],
        |row| row.get::<usize, i64>(0),
    )
    .map(|count| count > 0)
    .unwrap_or(false)
}

fn default_data_dir() -> PathBuf {
    if let Ok(raw) = std::env::var("BEARPAW_DATA_DIR") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    if cfg!(test) {
        return std::env::temp_dir().join("bearpaw-tests");
    }

    #[cfg(target_os = "windows")]
    {
        if let Ok(appdata) = std::env::var("APPDATA") {
            return PathBuf::from(appdata).join("Bearpaw");
        }
    }

    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("Bearpaw");
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Ok(xdg_data_home) = std::env::var("XDG_DATA_HOME") {
            return PathBuf::from(xdg_data_home).join("bearpaw");
        }
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(home)
                .join(".local")
                .join("share")
                .join("bearpaw");
        }
    }

    std::env::temp_dir().join("bearpaw")
}

fn open_sqlite(path: &str) -> Option<rusqlite::Connection> {
    let path = PathBuf::from(path);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = rusqlite::Connection::open(path).ok()?;
    let _ = conn.pragma_update(None, "journal_mode", "WAL");
    let _ = conn.pragma_update(None, "synchronous", "NORMAL");
    let _ = conn.busy_timeout(Duration::from_secs(5));
    Some(conn)
}

fn broadcast_state_update(state: &AppState, live: &LiveState) {
    let prev_squelch_open = state.live.read().map(|g| g.squelch_open).unwrap_or(false);

    if let Ok(mut guard) = state.live.write() {
        *guard = live.clone();
    }

    track_analytics_transition(state, live, prev_squelch_open);

    let sequence = state.sequence.fetch_add(1, Ordering::Relaxed);
    let msg = json!({
        "type": "state_update",
        "timestamp": live.timestamp,
        "sequence": sequence,
        "data": {
            "timestamp": live.timestamp,
            "frequency": live.frequency,
            "modulation": live.modulation,
            "squelch_open": live.squelch_open,
            "rssi": live.rssi,
            "mode": live.mode,
            "channel": live.channel,
            "alpha_tag": live.alpha_tag,
            "volume": live.volume,
            "battery": live.battery,
            "stale": live.stale,
        }
    });
    let _ = state.ws_tx.send(msg.to_string());

    if live.squelch_open && !prev_squelch_open {
        let event = json!({
            "type": "event",
            "timestamp": live.timestamp,
            "event": "scan_hit",
            "data": {
                "frequency": live.frequency,
                "channel": live.channel,
                "alpha_tag": live.alpha_tag,
                "rssi": live.rssi,
            }
        });
        let _ = state.ws_tx.send(event.to_string());
    }
}

/// Push the current bank-enabled mask to all WebSocket subscribers. Call
/// after any change to state.banks so the UI can mirror reality instead of
/// holding a stale local copy.
pub(crate) fn broadcast_banks_update(state: &AppState) {
    let banks = state.banks.read().map(|g| g.clone()).unwrap_or_default();
    let msg = json!({
        "type": "banks_update",
        "timestamp": epoch_now(),
        "data": { "banks": banks },
    });
    let _ = state.ws_tx.send(msg.to_string());
}

fn epoch_now() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn day_hour(ts: f64) -> (u32, u32) {
    let total_hours = (ts / 3600.0).floor() as i64;
    let hour = ((total_hours % 24) + 24) % 24;
    let days_since_epoch = total_hours.div_euclid(24);
    // 1970-01-01 was Thursday. Shift so Monday=0 .. Sunday=6 like Python weekday().
    let day = ((days_since_epoch + 3) % 7 + 7) % 7;
    (day as u32, hour as u32)
}

fn parse_glf_response(response: &str) -> Option<u32> {
    for line in response.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let mut parts = line.split(',').map(str::trim).collect::<Vec<&str>>();
        if parts.first().map(|p| p.eq_ignore_ascii_case("GLF")) == Some(true) {
            parts.remove(0);
        }
        let value = parts.first().copied().unwrap_or("");
        if value.eq_ignore_ascii_case("OK") || value.is_empty() || value == "-1" {
            continue;
        }
        if let Ok(parsed) = value.parse::<u32>() {
            return Some(parsed);
        }
    }
    None
}

fn parse_command_parts(response: &str, command: &str) -> Vec<String> {
    let mut parts = response
        .split(',')
        .map(|s| s.trim().to_string())
        .collect::<Vec<String>>();
    if parts
        .first()
        .map(|p| p.eq_ignore_ascii_case(command))
        .unwrap_or(false)
    {
        parts.remove(0);
    }
    parts
}

async fn read_frequency_lockouts_from_scanner(state: &AppState) -> Result<Vec<u32>, ApiError> {
    let _ = send_raw_command(state, "PRG", false).await?;
    let mut values = Vec::new();
    let first = send_raw_command(state, "GLF,***", false).await?;
    let mut next = parse_glf_response(&first);
    if next.is_none() {
        let fallback = send_raw_command(state, "GLF", false).await?;
        next = parse_glf_response(&fallback);
    }
    for _ in 0..600 {
        let Some(value) = next else { break };
        if values.contains(&value) {
            break;
        }
        values.push(value);
        let response = send_raw_command(state, &format!("GLF,{}", value), false).await?;
        next = parse_glf_response(&response);
    }
    let _ = send_raw_command(state, "EPG", false).await;
    Ok(values)
}

async fn read_settings_snapshot_from_scanner(state: &AppState) -> Result<Value, ApiError> {
    let firmware_response = send_raw_command(state, "VER", false).await?;
    let firmware = {
        let mut parts = firmware_response
            .split(',')
            .map(|s| s.trim())
            .collect::<Vec<&str>>();
        if parts.first().map(|p| p.eq_ignore_ascii_case("VER")) == Some(true) {
            parts.remove(0);
        }
        parts.join(",").trim().to_string()
    };

    let _ = send_raw_command(state, "PRG", false).await?;
    let result = async {
        let squelch = {
            let parts = parse_command_parts(&send_raw_command(state, "SQL", false).await?, "SQL");
            json!({ "level": parts.first().and_then(|s| s.parse::<u8>().ok()).unwrap_or(0) })
        };
        let backlight = {
            let parts = parse_command_parts(&send_raw_command(state, "BLT", false).await?, "BLT");
            json!({ "event": parts.first().cloned().unwrap_or_else(|| "AO".to_string()) })
        };
        let battery = {
            let parts = parse_command_parts(&send_raw_command(state, "BSV", false).await?, "BSV");
            json!({ "charge_time": parts.first().and_then(|s| s.parse::<u8>().ok()).unwrap_or(0) })
        };
        let key_beep = {
            let parts = parse_command_parts(&send_raw_command(state, "KBP", false).await?, "KBP");
            json!({
                "level": parts.first().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0),
                "lock": parts.get(1).map(|s| s == "1").unwrap_or(false)
            })
        };
        let priority = {
            let parts = parse_command_parts(&send_raw_command(state, "PRI", false).await?, "PRI");
            json!({ "mode": parts.first().and_then(|s| s.parse::<u8>().ok()).unwrap_or(0) })
        };
        let search = {
            let parts = parse_command_parts(&send_raw_command(state, "SCO", false).await?, "SCO");
            json!({
                "delay": parts.first().and_then(|s| s.parse::<i32>().ok()).unwrap_or(0),
                "code_search": parts.get(1).map(|s| s == "1").unwrap_or(false)
            })
        };
        let close_call = {
            let parts = parse_command_parts(&send_raw_command(state, "CLC", false).await?, "CLC");
            let band_raw = parts.get(3).cloned().unwrap_or_else(|| "00000".to_string());
            json!({
                "mode": parts.first().and_then(|s| s.parse::<u8>().ok()).unwrap_or(0),
                "alert_beep": parts.get(1).map(|s| s == "1").unwrap_or(false),
                "alert_light": parts.get(2).map(|s| s == "1").unwrap_or(false),
                "band": band_raw.chars().take(5).map(|c| c == '1').collect::<Vec<bool>>(),
                "lockout": parts.get(4).map(|s| s == "1").unwrap_or(false)
            })
        };
        let service_search = {
            let parts = parse_command_parts(&send_raw_command(state, "SSG", false).await?, "SSG");
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
            json!({ "groups": groups })
        };
        let custom_search = {
            let parts = parse_command_parts(&send_raw_command(state, "CSG", false).await?, "CSG");
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
            json!({ "groups": groups })
        };
        let mut custom_search_ranges = Vec::new();
        for idx in 1..=10 {
            let response = send_raw_command(state, &format!("CSP,{}", idx), false).await?;
            let mut parts = parse_command_parts(&response, "CSP");
            if parts.first().and_then(|s| s.parse::<u8>().ok()) == Some(idx) {
                parts.remove(0);
            }
            let lower = parts
                .first()
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0)
                / 10000.0;
            let upper = parts
                .get(1)
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.0)
                / 10000.0;
            custom_search_ranges.push(json!({ "index": idx, "lower": lower, "upper": upper }));
        }
        let weather = {
            let parts = parse_command_parts(&send_raw_command(state, "WXS", false).await?, "WXS");
            json!({ "priority": parts.first().map(|s| s == "1").unwrap_or(false) })
        };
        let contrast = {
            let parts = parse_command_parts(&send_raw_command(state, "CNT", false).await?, "CNT");
            json!({ "level": parts.first().and_then(|s| s.parse::<u8>().ok()).unwrap_or(0) })
        };

        Ok::<Value, ApiError>(json!({
            "firmware": firmware,
            "squelch": squelch,
            "backlight": backlight,
            "battery": battery,
            "key_beep": key_beep,
            "priority": priority,
            "search": search,
            "close_call": close_call,
            "service_search": service_search,
            "custom_search": custom_search,
            "custom_search_ranges": custom_search_ranges,
            "weather": weather,
            "contrast": contrast
        }))
    }
    .await;
    let _ = send_raw_command(state, "EPG", false).await;
    result
}

async fn read_channel_from_scanner(state: &AppState, index: u16) -> Result<ChannelData, ApiError> {
    let in_program_mode = state.program_mode_active.load(Ordering::Relaxed);
    if !in_program_mode {
        let _ = send_raw_command(state, "PRG", false).await?;
    }
    let response = send_raw_command(state, &format!("CIN,{}", index), false).await;
    if !in_program_mode {
        let _ = send_raw_command(state, "EPG", false).await;
    }
    let response = response?;
    parse_cin_response(index, &response)
        .ok_or_else(|| ApiError::BadRequest("channel_read_failed".to_string()))
}

async fn write_channel_to_scanner(
    state: &AppState,
    channel: &ChannelData,
) -> Result<ChannelData, ApiError> {
    fn looks_like_frequency(value: &str) -> bool {
        if value.is_empty() {
            return false;
        }
        value.contains('.')
            || (value.chars().all(|c| c.is_ascii_digit())
                && value.parse::<i64>().unwrap_or(0) >= 10000)
    }
    fn format_frequency(value: f64, template: &str) -> String {
        if template.contains('.') {
            format!("{:.4}", value)
        } else {
            let raw = (value * 10000.0).round() as i64;
            let width = if template.chars().all(|c| c.is_ascii_digit()) {
                std::cmp::max(8, template.len())
            } else {
                8
            };
            format!("{:0width$}", raw, width = width)
        }
    }
    fn format_tone_value(value: Option<f64>) -> String {
        match value {
            None => "0".to_string(),
            Some(v) if v.fract() == 0.0 => format!("{}", v as i64),
            Some(v) => format!("{}", v),
        }
    }

    let in_program_mode = state.program_mode_active.load(Ordering::Relaxed);
    if !in_program_mode {
        let _ = send_raw_command(state, "PRG", false).await?;
    }
    let raw = send_raw_command(state, &format!("CIN,{}", channel.index), false).await;
    let raw = raw?;
    let mut parts = raw
        .split(',')
        .map(|s| s.trim().to_string())
        .collect::<Vec<String>>();
    if parts
        .first()
        .map(|p| p.eq_ignore_ascii_case("CIN"))
        .unwrap_or(false)
    {
        parts.remove(0);
    }
    if parts
        .first()
        .and_then(|v| v.parse::<u16>().ok())
        .map(|v| v == channel.index)
        .unwrap_or(false)
    {
        parts.remove(0);
    }
    if parts.is_empty() {
        if !in_program_mode {
            let _ = send_raw_command(state, "EPG", false).await;
        }
        return Err(ApiError::BadRequest("channel_read_failed".to_string()));
    }

    let has_bank = parts.len() >= 8
        && parts
            .last()
            .and_then(|v| v.parse::<u8>().ok())
            .map(|v| v <= 10)
            .unwrap_or(false);
    let has_tone = if parts.len() == 7 {
        let lockout_candidate = parts.get(3).map(|s| s.as_str()).unwrap_or("");
        let delay_candidate = parts.get(4).map(|s| s.as_str()).unwrap_or("");
        let priority_candidate = parts.get(5).map(|s| s.as_str()).unwrap_or("");
        let bank_candidate = parts.get(6).map(|s| s.as_str()).unwrap_or("");
        !(matches!(lockout_candidate, "0" | "1")
            && delay_candidate.parse::<u8>().is_ok()
            && matches!(priority_candidate, "0" | "1")
            && bank_candidate
                .parse::<u8>()
                .map(|v| v <= 10)
                .unwrap_or(false))
    } else {
        parts.len() >= 8
    };

    let template_freq = if parts.len() > 1 && looks_like_frequency(&parts[1]) {
        parts[1].clone()
    } else {
        parts
            .first()
            .cloned()
            .unwrap_or_else(|| "00000000".to_string())
    };

    let alpha_tag = channel
        .alpha_tag
        .replace(',', " ")
        .trim()
        .chars()
        .take(16)
        .collect::<String>();
    let modulation = if channel.modulation.is_empty() {
        "AUTO".to_string()
    } else {
        channel.modulation.to_uppercase()
    };
    let delay_value = channel.delay.to_string();
    let lockout_value = if channel.lockout { "1" } else { "0" }.to_string();
    let priority_value = if channel.priority { "1" } else { "0" }.to_string();
    let bank_value = channel.bank.to_string();
    let tone_value = format_tone_value(channel.tone_squelch);

    let mut values = if has_tone {
        vec![
            alpha_tag,
            format_frequency(channel.frequency, &template_freq),
            modulation,
            tone_value,
            delay_value,
            lockout_value,
            priority_value,
        ]
    } else {
        vec![
            alpha_tag,
            format_frequency(channel.frequency, &template_freq),
            modulation,
            lockout_value,
            delay_value,
            priority_value,
            bank_value.clone(),
        ]
    };
    if has_tone && has_bank {
        values.push(bank_value);
    }

    let write_cmd = format!("CIN,{},{}", channel.index, values.join(","));
    let write_response = send_raw_command(state, &write_cmd, false).await;
    let read_response = send_raw_command(state, &format!("CIN,{}", channel.index), false).await;
    if !in_program_mode {
        let _ = send_raw_command(state, "EPG", false).await;
    }

    let write_response = write_response?;
    let upper = write_response.trim().to_uppercase();
    if !(upper == "OK" || upper.ends_with(",OK") || upper.contains("OK")) {
        return Err(ApiError::BadRequest(if write_response.trim().is_empty() {
            "channel_write_failed".to_string()
        } else {
            write_response.trim().to_string()
        }));
    }
    let read_response = read_response?;
    parse_cin_response(channel.index, &read_response)
        .ok_or_else(|| ApiError::BadRequest("channel_readback_failed".to_string()))
}

async fn set_channel_lockout_on_scanner(
    state: &AppState,
    index: u16,
    locked: bool,
) -> Result<ChannelData, ApiError> {
    let in_program_mode = state.program_mode_active.load(Ordering::Relaxed);
    if !in_program_mode {
        let _ = send_raw_command(state, "PRG", false).await?;
    }
    let response = send_raw_command(state, &format!("CIN,{}", index), false).await;
    let response = response?;

    let mut parts = response
        .split(',')
        .map(|s| s.trim().to_string())
        .collect::<Vec<String>>();
    if parts
        .first()
        .map(|p| p.eq_ignore_ascii_case("CIN"))
        .unwrap_or(false)
    {
        parts.remove(0);
    }
    if parts
        .first()
        .and_then(|v| v.parse::<u16>().ok())
        .map(|v| v == index)
        .unwrap_or(false)
    {
        parts.remove(0);
    }
    while parts.len() < 7 {
        parts.push(String::new());
    }

    let has_tone = if parts.len() == 7 {
        let lockout_candidate = parts.get(3).map(|s| s.as_str()).unwrap_or("");
        let delay_candidate = parts.get(4).map(|s| s.as_str()).unwrap_or("");
        let priority_candidate = parts.get(5).map(|s| s.as_str()).unwrap_or("");
        let bank_candidate = parts.get(6).map(|s| s.as_str()).unwrap_or("");
        !(matches!(lockout_candidate, "0" | "1")
            && delay_candidate.parse::<u8>().is_ok()
            && matches!(priority_candidate, "0" | "1")
            && bank_candidate.parse::<u8>().is_ok())
    } else {
        parts.len() >= 8
    };
    let lockout_idx = if has_tone { 5 } else { 3 };
    if parts.len() <= lockout_idx {
        if !in_program_mode {
            let _ = send_raw_command(state, "EPG", false).await;
        }
        return Err(ApiError::BadRequest("lockout_failed".to_string()));
    }
    parts[lockout_idx] = if locked { "1" } else { "0" }.to_string();

    let write_cmd = format!("CIN,{},{}", index, parts.join(","));
    let write_response = send_raw_command(state, &write_cmd, false).await;
    let read_response = send_raw_command(state, &format!("CIN,{}", index), false).await;
    if !in_program_mode {
        let _ = send_raw_command(state, "EPG", false).await;
    }

    let write_response = write_response?;
    let upper = write_response.trim().to_uppercase();
    if !(upper == "OK" || upper.ends_with(",OK")) {
        return Err(ApiError::BadRequest("lockout_failed".to_string()));
    }
    let read_response = read_response?;
    parse_cin_response(index, &read_response)
        .ok_or_else(|| ApiError::BadRequest("lockout_failed".to_string()))
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};

    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{:08x}", t % 0x1_0000_0000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Method, Request};
    use std::path::PathBuf;
    use tower::util::ServiceExt;

    async fn json_body(response: axum::response::Response) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("read response body");
        serde_json::from_slice(&bytes).expect("valid json")
    }

    #[tokio::test]
    async fn health_endpoint_returns_ok() {
        let app = router(default_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/health")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(body["status"], "ok");
    }

    #[tokio::test]
    async fn settings_all_requires_scanner_when_disconnected() {
        let app = router(default_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/settings/all")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json_body(response).await;
        assert_eq!(body["error"], "device_disconnected");
    }

    #[tokio::test]
    async fn preferences_reset_alias_matches() {
        let app = router(default_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/preferences/reset")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert!(body.get("theme").is_some());
        assert!(body.get("mqtt_enabled").is_some());
    }

    #[tokio::test]
    async fn lockout_frequency_endpoint_present() {
        let app = router(default_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/lockouts/162.55")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        let body = json_body(response).await;
        assert_eq!(body["error"], "device_disconnected");
    }

    #[tokio::test]
    async fn analytics_activity_log_returns_array() {
        let app = router(default_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/analytics/activity-log?limit=10")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert!(body.as_array().is_some());
    }

    fn temp_db_file(name: &str) -> PathBuf {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        std::env::temp_dir().join(format!("bearpaw-test-{}-{}.db", name, ts))
    }

    #[test]
    fn preferences_db_migration_sets_schema_version() {
        let path = temp_db_file("prefs-migration");
        {
            let conn = rusqlite::Connection::open(&path).expect("create temp prefs db");
            conn.execute(
                "CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL)",
                [],
            )
            .expect("create legacy prefs table");
        }
        init_preferences_db(path.to_str().expect("path to string"));
        let conn = rusqlite::Connection::open(&path).expect("reopen prefs db");
        let user_version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(user_version, PREFERENCES_SCHEMA_VERSION);
    }

    #[test]
    fn analytics_db_migration_sets_schema_version_and_table() {
        let path = temp_db_file("analytics-migration");
        {
            let conn = rusqlite::Connection::open(&path).expect("create temp analytics db");
            conn.execute("PRAGMA user_version = 0", [])
                .expect("set legacy version");
        }
        init_analytics_db(path.to_str().expect("path to string"));
        let conn = rusqlite::Connection::open(&path).expect("reopen analytics db");
        let user_version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(user_version, ANALYTICS_SCHEMA_VERSION);
        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='scan_hits'",
                [],
                |row| row.get(0),
            )
            .expect("query table");
        assert_eq!(table_exists, 1);
    }
}
