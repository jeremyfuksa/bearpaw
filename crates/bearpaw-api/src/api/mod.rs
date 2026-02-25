//! Axum REST + WebSocket server.
//!
//! Phase 4: compatibility endpoints and pragmatic stubs to keep frontend working
//! while the Rust backend reaches full parity.

mod control;
mod poll;

pub use control::{
    validate_frequency, validate_modulation, ControlCommand, FrequencyRequest,
};
pub use poll::spawn_poll_loop;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use tracing::info;

use crate::state::{ChannelData, DeviceInfo, LiveState, ShadowState};

#[derive(Clone)]
pub struct AppState {
    pub live: Arc<std::sync::RwLock<LiveState>>,
    pub device: Arc<std::sync::RwLock<DeviceInfo>>,
    pub shadow: Arc<std::sync::RwLock<ShadowState>>,
    pub banks: Arc<std::sync::RwLock<Vec<bool>>>,
    pub preferences: Arc<Mutex<Map<String, Value>>>,
    pub ws_tx: broadcast::Sender<String>,
    pub sequence: Arc<AtomicU64>,
    pub command_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<ControlCommand>>>>,
}

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/status", get(get_status))
        .route("/api/v1/device/info", get(get_device_info))
        .route("/api/v1/banks", get(get_banks).post(set_banks))
        .route("/api/v1/commands/hold", post(post_hold))
        .route("/api/v1/commands/scan", post(post_scan))
        .route("/api/v1/commands/key", post(post_key))
        .route("/api/v1/commands/lockout", post(post_lockout))
        .route("/api/v1/frequency", post(post_frequency))
        .route("/api/v1/volume", post(stub_ok))
        .route("/api/v1/squelch", get(get_squelch).post(stub_ok))
        .route("/api/v1/config", get(get_config))
        .route("/api/v1/settings/all", get(get_config))
        .route("/api/v1/settings/backlight", get(stub_obj).post(stub_ok))
        .route("/api/v1/settings/battery", get(stub_obj).post(stub_ok))
        .route("/api/v1/settings/key-beep", get(stub_obj).post(stub_ok))
        .route("/api/v1/settings/priority", get(stub_obj).post(stub_ok))
        .route("/api/v1/settings/search", get(stub_obj).post(stub_ok))
        .route("/api/v1/settings/close-call", get(stub_obj).post(stub_ok))
        .route("/api/v1/settings/service-search", get(stub_obj).post(stub_ok))
        .route("/api/v1/settings/custom-search", get(stub_obj).post(stub_ok))
        .route(
            "/api/v1/settings/custom-search/ranges/:index",
            get(stub_custom_range).post(stub_ok),
        )
        .route("/api/v1/settings/weather", get(stub_obj).post(stub_ok))
        .route("/api/v1/settings/contrast", get(stub_obj).post(stub_ok))
        .route("/api/v1/lockouts", get(get_lockouts))
        .route("/api/v1/lockouts/temporary/clear", post(clear_lockouts))
        .route("/api/v1/lockouts/clear", post(clear_lockouts))
        .route("/api/v1/lockouts/channels/clear", post(clear_lockouts))
        .route("/api/v1/memory/channels", get(get_memory_channels))
        .route(
            "/api/v1/memory/channels/:index",
            get(get_memory_channel).put(put_memory_channel),
        )
        .route("/api/v1/memory/sync", post(post_memory_sync))
        .route("/api/v1/memory/sync/cancel", post(cancel_memory_sync))
        .route("/api/v1/memory/program-mode/start", post(stub_ok))
        .route("/api/v1/memory/program-mode/end", post(stub_ok))
        .route("/api/v1/memory/export/bc125at_ss", get(export_stub))
        .route("/api/v1/memory/export/csv", get(export_csv_stub))
        .route("/api/v1/memory/import/csv", post(import_csv_stub))
        .route("/api/v1/preferences", get(get_preferences).put(set_preferences).post(reset_preferences))
        .route("/api/v1/preferences/:key", get(get_preference).put(set_preference))
        .route("/api/v1/analytics/busiest-channels", get(analytics_busiest))
        .route("/api/v1/analytics/session-stats", get(analytics_session_stats))
        .route("/api/v1/analytics/hourly-heatmap", get(analytics_hourly_heatmap))
        .route("/api/v1/analytics/cleanup", post(analytics_cleanup))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

async fn get_status(State(state): State<AppState>) -> Json<LiveState> {
    Json(state.live.read().unwrap().clone())
}

async fn get_device_info(State(state): State<AppState>) -> Json<DeviceInfo> {
    Json(state.device.read().unwrap().clone())
}

#[derive(Serialize)]
struct BanksResponse {
    banks: Vec<bool>,
}

#[derive(Deserialize)]
struct BanksRequest {
    banks: Vec<bool>,
}

async fn get_banks(State(state): State<AppState>) -> Json<BanksResponse> {
    Json(BanksResponse {
        banks: state.banks.read().unwrap().clone(),
    })
}

async fn set_banks(
    State(state): State<AppState>,
    Json(body): Json<BanksRequest>,
) -> Json<BanksResponse> {
    let mut banks = body.banks;
    if banks.len() < 10 {
        banks.resize(10, true);
    }
    banks.truncate(10);
    *state.banks.write().unwrap() = banks.clone();
    Json(BanksResponse { banks })
}

async fn post_hold(State(state): State<AppState>) -> Result<StatusCode, ApiError> {
    let tx = state.command_tx.lock().unwrap();
    let tx = tx.as_ref().ok_or(ApiError::NoScanner)?;
    tx.send(ControlCommand::Hold).map_err(|_| ApiError::SendFailed)?;
    Ok(StatusCode::OK)
}

async fn post_scan(State(state): State<AppState>) -> Result<StatusCode, ApiError> {
    let tx = state.command_tx.lock().unwrap();
    let tx = tx.as_ref().ok_or(ApiError::NoScanner)?;
    tx.send(ControlCommand::Scan).map_err(|_| ApiError::SendFailed)?;
    Ok(StatusCode::OK)
}

#[derive(Deserialize)]
struct KeyRequest {
    key: String,
}

async fn post_key(
    State(state): State<AppState>,
    Json(body): Json<KeyRequest>,
) -> Result<StatusCode, ApiError> {
    let cmd = match body.key.to_uppercase().as_str() {
        "H" => ControlCommand::Hold,
        "S" => ControlCommand::Scan,
        _ => return Err(ApiError::BadRequest("Unsupported key".to_string())),
    };
    let tx = state.command_tx.lock().unwrap();
    let tx = tx.as_ref().ok_or(ApiError::NoScanner)?;
    tx.send(cmd).map_err(|_| ApiError::SendFailed)?;
    Ok(StatusCode::OK)
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
    if body.mode == "temporary" {
        return Ok(Json(json!({
            "frequency": body.frequency.unwrap_or(0.0),
            "locked": true,
            "channel": body.channel
        })));
    }
    if body.mode == "permanent" {
        let index = body.channel.unwrap_or(1);
        let mut shadow = state.shadow.write().unwrap();
        let ch = shadow.channels.entry(index).or_insert(ChannelData {
            index,
            frequency: 0.0,
            modulation: "FM".to_string(),
            alpha_tag: String::new(),
            delay: 2,
            lockout: false,
            priority: false,
            tone_squelch: None,
            bank: 0,
        });
        ch.lockout = !ch.lockout;
        return Ok(Json(json!({ "channel": ch })));
    }
    Err(ApiError::BadRequest("Invalid lockout mode".to_string()))
}

#[derive(Deserialize)]
struct MemoryChannelsQuery {
    bank: Option<u8>,
    lockout: Option<bool>,
}

// Frontend expects a raw array from GET /memory/channels.
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
    let shadow = state.shadow.read().unwrap();
    shadow
        .channels
        .get(&index)
        .cloned()
        .map(Json)
        .ok_or(ApiError::NotFound("Channel not found".to_string()))
}

async fn put_memory_channel(
    State(state): State<AppState>,
    Path(index): Path<u16>,
    Json(mut body): Json<ChannelData>,
) -> Result<Json<ChannelData>, ApiError> {
    body.index = index;
    state.shadow.write().unwrap().channels.insert(index, body.clone());
    Ok(Json(body))
}

#[derive(Serialize)]
struct MemorySyncResponse {
    status: &'static str,
    task_id: String,
    estimated_duration: f64,
}

async fn post_memory_sync(
    State(state): State<AppState>,
) -> Result<(StatusCode, Json<MemorySyncResponse>), ApiError> {
    use std::sync::mpsc::Sender;
    let task_id = format!("sync-{}", uuid_simple());
    let tx = state.command_tx.lock().unwrap();
    let tx: &Sender<ControlCommand> = tx.as_ref().ok_or(ApiError::NoScanner)?;
    tx.send(ControlCommand::StartSync {
        task_id: task_id.clone(),
        max_channels: 500,
    })
    .map_err(|_| ApiError::SendFailed)?;
    Ok((
        StatusCode::ACCEPTED,
        Json(MemorySyncResponse {
            status: "started",
            task_id,
            estimated_duration: 60.0,
        }),
    ))
}

async fn cancel_memory_sync() -> StatusCode {
    // Phase 4 compatibility: accepted no-op (real cancellation can be added with CancelSync command).
    StatusCode::OK
}

#[derive(Serialize)]
struct LockoutsResponse {
    frequencies: Vec<f64>,
    channels: Vec<u16>,
    temporary_channels: Vec<Value>,
}

async fn get_lockouts() -> Json<LockoutsResponse> {
    Json(LockoutsResponse {
        frequencies: vec![],
        channels: vec![],
        temporary_channels: vec![],
    })
}

async fn clear_lockouts() -> Json<Value> {
    Json(json!({ "cleared": [], "failed": [] }))
}

async fn get_squelch() -> Json<Value> {
    Json(json!({ "level": 0 }))
}

async fn get_config() -> Json<Value> {
    Json(json!({}))
}

async fn stub_obj() -> Json<Value> {
    Json(json!({}))
}

async fn stub_custom_range(Path(index): Path<u8>) -> Json<Value> {
    Json(json!({ "index": index, "lower": 0, "upper": 0 }))
}

async fn stub_ok() -> StatusCode {
    StatusCode::OK
}

async fn export_stub() -> impl IntoResponse {
    (StatusCode::OK, "Not implemented yet\n")
}

async fn export_csv_stub() -> impl IntoResponse {
    (StatusCode::OK, "index,frequency,modulation,alpha_tag,delay,lockout,priority,tone_squelch,bank\n")
}

async fn import_csv_stub() -> Json<Value> {
    Json(json!({ "imported": 0, "errors": [] }))
}

async fn get_preferences(State(state): State<AppState>) -> Json<Value> {
    Json(Value::Object(state.preferences.lock().unwrap().clone()))
}

async fn get_preference(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let prefs = state.preferences.lock().unwrap();
    let value = prefs.get(&key).cloned().unwrap_or(Value::Null);
    Ok(Json(json!({ "key": key, "value": value })))
}

async fn set_preference(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> Json<Value> {
    let value = body.get("value").cloned().unwrap_or(Value::Null);
    state.preferences.lock().unwrap().insert(key.clone(), value.clone());
    Json(json!({ "key": key, "value": value }))
}

async fn set_preferences(State(state): State<AppState>, Json(body): Json<Value>) -> Json<Value> {
    if let Value::Object(map) = body {
        let mut prefs = state.preferences.lock().unwrap();
        for (k, v) in map {
            prefs.insert(k, v);
        }
        return Json(Value::Object(prefs.clone()));
    }
    Json(Value::Object(state.preferences.lock().unwrap().clone()))
}

async fn reset_preferences(State(state): State<AppState>) -> Json<Value> {
    *state.preferences.lock().unwrap() = default_preferences();
    Json(Value::Object(state.preferences.lock().unwrap().clone()))
}

async fn analytics_busiest() -> Json<Value> {
    Json(json!({ "channels": [] }))
}

async fn analytics_session_stats() -> Json<Value> {
    Json(json!({
        "total_hits": 0,
        "unique_channels": 0,
        "active_time_seconds": 0
    }))
}

async fn analytics_hourly_heatmap() -> Json<Value> {
    Json(json!({
        "heatmap": [],
        "stats": { "min": 0, "max": 0, "avg": 0 }
    }))
}

async fn analytics_cleanup() -> StatusCode {
    StatusCode::OK
}

#[derive(Debug)]
pub enum ApiError {
    NoScanner,
    SendFailed,
    BadRequest(String),
    NotFound(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match &self {
            ApiError::NoScanner => (StatusCode::SERVICE_UNAVAILABLE, "Scanner not connected"),
            ApiError::SendFailed => (StatusCode::SERVICE_UNAVAILABLE, "Command channel closed"),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.as_str()),
            ApiError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.as_str()),
        };
        (status, Json(json!({ "error": message, "message": message }))).into_response()
    }
}

async fn ws_handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> axum::response::Response {
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
    if let Some((port_name, baud)) = serial_port {
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        state.command_tx = Arc::new(Mutex::new(Some(cmd_tx)));
        spawn_poll_loop(state.clone(), port_name, baud, cmd_rx);
    }
    let listener = tokio::net::TcpListener::bind(bind).await?;
    info!("Bearpaw API listening on http://{}", bind);
    axum::serve(listener, router(state).into_make_service()).await?;
    Ok(())
}

pub fn default_state() -> AppState {
    let (ws_tx, _) = broadcast::channel(64);
    AppState {
        live: Arc::new(std::sync::RwLock::new(LiveState::default())),
        device: Arc::new(std::sync::RwLock::new(DeviceInfo {
            connection_status: "disconnected".to_string(),
            ..Default::default()
        })),
        shadow: Arc::new(std::sync::RwLock::new(ShadowState::default())),
        banks: Arc::new(std::sync::RwLock::new(vec![true; 10])),
        preferences: Arc::new(Mutex::new(default_preferences())),
        ws_tx,
        sequence: Arc::new(AtomicU64::new(0)),
        command_tx: Arc::new(Mutex::new(None)),
    }
}

fn default_preferences() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("theme".to_string(), Value::String("night".to_string()));
    m.insert("displayMode".to_string(), Value::String("frequency".to_string()));
    m.insert("reduced_motion".to_string(), Value::Bool(false));
    m.insert("hit_min_duration".to_string(), Value::from(2));
    m.insert("start_dashboard_mode".to_string(), Value::Bool(false));
    m.insert("auto_connect".to_string(), Value::Bool(false));
    m.insert("check_updates".to_string(), Value::Bool(true));
    m.insert("recording_buffer_size".to_string(), Value::from(30));
    m.insert("data_retention_days".to_string(), Value::from(30));
    m.insert("audio_output_device".to_string(), Value::String("default".to_string()));
    m.insert("recordings_path".to_string(), Value::String("./recordings".to_string()));
    m.insert("mqtt_enabled".to_string(), Value::Bool(false));
    m.insert("mqtt_host".to_string(), Value::String("127.0.0.1".to_string()));
    m.insert("mqtt_port".to_string(), Value::from(1883));
    m.insert("mqtt_topic_prefix".to_string(), Value::String("scanner".to_string()));
    m.insert("mqtt_qos".to_string(), Value::from(0));
    m.insert("mqtt_retain".to_string(), Value::Bool(false));
    m
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    format!("{:08x}", t % 0x1_0000_0000)
}
