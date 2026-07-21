//! Axum REST + WebSocket server.
//!
//! Compatibility-first API surface so the Rust backend can replace the Python backend
//! without frontend contract regressions.

mod control;
mod handlers;
mod memory_sync;
mod poll;
mod program_mode;
mod security;
mod ws;

pub(crate) use program_mode::ProgramModeGuard;
pub(crate) use ws::broadcast_banks_update;

pub use control::{validate_frequency, ControlCommand};
pub use poll::spawn_poll_loop;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::broadcast;
use tower_http::trace::{DefaultMakeSpan, DefaultOnRequest, DefaultOnResponse, TraceLayer};
use tracing::{info, warn};

use crate::protocol::{classify_response, parse_cin_response, tones, ScannerReply};
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
    /// Held across sequence take + ws_tx.send so two producers can't take
    /// ascending sequence numbers and send them out of order (#143) — the
    /// frontend's monotonic gate would silently drop the later-arriving
    /// lower-sequence update.
    pub sequence_send: Arc<Mutex<()>>,
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
        .route("/api/v1/health", get(handlers::status::get_health))
        .route("/api/v1/status", get(handlers::status::get_status))
        .route(
            "/api/v1/device/info",
            get(handlers::status::get_device_info),
        )
        .route(
            "/api/v1/banks",
            get(handlers::banks::get_banks).post(handlers::banks::set_banks),
        )
        .route("/api/v1/commands/hold", post(handlers::commands::post_hold))
        .route("/api/v1/commands/scan", post(handlers::commands::post_scan))
        .route("/api/v1/commands/key", post(handlers::commands::post_key))
        .route(
            "/api/v1/commands/lockout",
            post(handlers::commands::post_lockout),
        )
        .route(
            "/api/v1/volume",
            get(handlers::commands::get_volume).post(handlers::commands::set_volume),
        )
        .route(
            "/api/v1/squelch",
            get(handlers::commands::get_squelch).post(handlers::commands::set_squelch),
        )
        .route("/api/v1/config", get(handlers::settings::get_config))
        .route("/api/v1/settings/all", get(handlers::settings::get_config))
        .route(
            "/api/v1/settings/backlight",
            get(handlers::settings::get_backlight).post(handlers::settings::set_backlight),
        )
        .route(
            "/api/v1/settings/battery",
            get(handlers::settings::get_battery).post(handlers::settings::set_battery),
        )
        .route(
            "/api/v1/settings/key-beep",
            get(handlers::settings::get_key_beep).post(handlers::settings::set_key_beep),
        )
        .route(
            "/api/v1/settings/priority",
            get(handlers::settings::get_priority).post(handlers::settings::set_priority),
        )
        .route(
            "/api/v1/settings/search",
            get(handlers::settings::get_search).post(handlers::settings::set_search),
        )
        .route(
            "/api/v1/settings/close-call",
            get(handlers::settings::get_close_call).post(handlers::settings::set_close_call),
        )
        .route(
            "/api/v1/settings/service-search",
            get(handlers::settings::get_service_search)
                .post(handlers::settings::set_service_search),
        )
        .route(
            "/api/v1/settings/custom-search",
            get(handlers::settings::get_custom_search).post(handlers::settings::set_custom_search),
        )
        .route(
            "/api/v1/settings/custom-search/ranges/:index",
            get(handlers::settings::get_custom_range).post(handlers::settings::set_custom_range),
        )
        .route(
            "/api/v1/settings/custom-search/defaults",
            get(handlers::settings::get_custom_search_defaults),
        )
        .route(
            "/api/v1/settings/weather",
            get(handlers::settings::get_weather).post(handlers::settings::set_weather),
        )
        .route(
            "/api/v1/settings/contrast",
            get(handlers::settings::get_contrast).post(handlers::settings::set_contrast),
        )
        .route("/api/v1/lockouts", get(handlers::lockouts::get_lockouts))
        .route(
            "/api/v1/lockouts/temporary/clear",
            post(handlers::lockouts::clear_temporary_lockouts),
        )
        .route(
            "/api/v1/lockouts/clear",
            post(handlers::lockouts::clear_global_lockouts),
        )
        .route(
            "/api/v1/lockouts/channels/clear",
            post(handlers::lockouts::clear_channel_lockouts),
        )
        .route(
            "/api/v1/memory/channels",
            get(handlers::memory::get_memory_channels),
        )
        .route(
            "/api/v1/memory/channels/:index",
            get(handlers::memory::get_memory_channel).put(handlers::memory::put_memory_channel),
        )
        .route(
            "/api/v1/memory/sync",
            post(handlers::memory::post_memory_sync),
        )
        .route(
            "/api/v1/memory/sync/status",
            get(handlers::memory::get_memory_sync_status),
        )
        .route(
            "/api/v1/memory/sync/cancel",
            post(handlers::memory::cancel_memory_sync),
        )
        .route(
            "/api/v1/memory/program-mode/start",
            post(handlers::memory::program_mode_start),
        )
        .route(
            "/api/v1/memory/program-mode/end",
            post(handlers::memory::program_mode_end),
        )
        .route(
            "/api/v1/memory/export/bc125at_ss",
            get(handlers::exports::export_bc125at_ss_file),
        )
        .route(
            "/api/v1/memory/export/csv",
            get(handlers::exports::export_csv),
        )
        .route(
            "/api/v1/memory/import/csv",
            post(handlers::exports::import_csv),
        )
        .route(
            "/api/v1/memory/import/bc125at_ss",
            post(handlers::import_ss::import_bc125at_ss),
        )
        .route(
            "/api/v1/preferences",
            get(handlers::preferences::get_preferences)
                .put(handlers::preferences::put_preferences),
        )
        .route(
            "/api/v1/preferences/reset",
            post(handlers::preferences::reset_preferences),
        )
        .route(
            "/api/v1/preferences/:key",
            get(handlers::preferences::get_preference).put(handlers::preferences::put_preference),
        )
        .route(
            "/api/v1/analytics/busiest-channels",
            get(handlers::analytics::analytics_busiest),
        )
        .route(
            "/api/v1/analytics/session-stats",
            get(handlers::analytics::analytics_session_stats),
        )
        .route(
            "/api/v1/analytics/hourly-heatmap",
            get(handlers::analytics::analytics_hourly_heatmap),
        )
        .route(
            "/api/v1/analytics/activity-log",
            get(handlers::analytics::analytics_activity_log),
        )
        .route(
            "/api/v1/analytics/cleanup",
            post(handlers::analytics::analytics_cleanup),
        )
        .route("/ws", get(ws::ws_handler))
        .layer(security::cors_layer())
        .layer(
            TraceLayer::new_for_http()
                .make_span_with(DefaultMakeSpan::new().level(tracing::Level::INFO))
                .on_request(DefaultOnRequest::new().level(tracing::Level::INFO))
                .on_response(DefaultOnResponse::new().level(tracing::Level::INFO)),
        )
        .with_state(state)
}

pub(crate) fn command_sender(
    state: &AppState,
) -> Result<std::sync::mpsc::Sender<ControlCommand>, ApiError> {
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
    // Last-line check: a fully-formed wire command must not contain its own
    // terminator. Handlers that build commands from user input validate the
    // raw fields first; this catches any path that forgets to.
    if security::validate_wire_command(command).is_err() {
        warn!(
            command = %command.escape_debug().to_string(),
            "rejected wire command containing embedded terminator"
        );
        return Err(ApiError::BadRequest("invalid_command".to_string()));
    }
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
                // Matches the recv_timeout below: once the HTTP caller has
                // given up, the queued command must not execute later (#139).
                deadline: std::time::Instant::now() + Duration::from_secs(3),
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

pub(crate) fn split_command_parts(response: &str) -> Vec<String> {
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

pub(crate) fn flags_to_bools(flags: &str) -> Vec<bool> {
    flags.trim().chars().map(|ch| ch == '0').collect()
}

pub(crate) fn on_off(value: &str) -> &'static str {
    if value == "1" {
        "On"
    } else {
        "Off"
    }
}

pub(crate) fn csv_escape(value: &str) -> String {
    if value.contains(',') || value.contains('"') || value.contains('\n') {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_string()
    }
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

pub async fn run_server(
    bind: &str,
    state: AppState,
    serial_port: Option<(String, u32, bool)>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    run_server_with_shutdown(bind, state, serial_port, std::future::pending()).await
}

/// Like `run_server` but accepts a shutdown future. When the future resolves,
/// the server drains in-flight requests and exits cleanly.
///
/// `serial_port` is `(port_or_usb_target, baud, assert_dtr_on_open)`. The
/// DTR flag is only honoured by the serial transport; the USB transport
/// ignores it.
pub async fn run_server_with_shutdown(
    bind: &str,
    mut state: AppState,
    serial_port: Option<(String, u32, bool)>,
    shutdown: impl std::future::Future<Output = ()> + Send + 'static,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some((port_name, baud, assert_dtr)) = serial_port {
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel();
        state.command_tx = Arc::new(Mutex::new(Some(cmd_tx)));
        spawn_poll_loop(state.clone(), port_name, baud, assert_dtr, cmd_rx);
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
    let allowed_hosts = security::allowed_hosts_for_bind(bind);
    let app = router(state).layer(axum::middleware::from_fn(move |req, next| {
        let allowed = allowed_hosts.clone();
        async move { security::validate_host(allowed, req, next).await }
    }));
    axum::serve(listener, app.into_make_service())
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
        sequence_send: Arc::new(Mutex::new(())),
        command_tx: Arc::new(Mutex::new(None)),
        program_mode_forced_hold: Arc::new(AtomicBool::new(false)),
        program_mode_active: Arc::new(AtomicBool::new(false)),
    }
}

pub(crate) fn default_preferences() -> Map<String, Value> {
    let mut m = Map::new();
    m.insert("theme".to_string(), Value::String("dark".to_string()));
    m.insert(
        "displayMode".to_string(),
        Value::String("frequency".to_string()),
    );
    m.insert("reduced_motion".to_string(), Value::Bool(false));
    m.insert("hit_min_duration".to_string(), Value::from(2));
    m.insert("start_dashboard_mode".to_string(), Value::Bool(true));
    m.insert("check_updates".to_string(), Value::Bool(true));
    m.insert("recording_buffer_size".to_string(), Value::from(30));
    m.insert("data_retention_days".to_string(), Value::from(30));
    m.insert(
        "audio_output_device".to_string(),
        Value::String("default".to_string()),
    );
    m.insert(
        "recordings_path".to_string(),
        Value::String("./recordings".to_string()),
    );
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

pub(crate) fn get_setting_section(state: &AppState, key: &str, fallback: Value) -> Value {
    state
        .settings
        .read()
        .unwrap()
        .get(key)
        .cloned()
        .unwrap_or(fallback)
}

pub(crate) fn set_setting_section(state: &AppState, key: &str, value: Value) {
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

pub(crate) fn min_hit_duration(state: &AppState) -> f64 {
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

pub(crate) fn save_preference_to_db(path: &str, key: &str, value: &Value) {
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

pub(crate) fn reset_preferences_db(path: &str) {
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

pub(crate) fn cleanup_analytics_db(path: &str, retention_days: u32) -> usize {
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

pub(crate) fn default_data_dir() -> PathBuf {
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

pub(crate) fn epoch_now() -> f64 {
    use std::time::{SystemTime, UNIX_EPOCH};

    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub(crate) fn day_hour(ts: f64) -> (u32, u32) {
    let total_hours = (ts / 3600.0).floor() as i64;
    let hour = ((total_hours % 24) + 24) % 24;
    let days_since_epoch = total_hours.div_euclid(24);
    // 1970-01-01 was Thursday. Shift so Monday=0 .. Sunday=6 like Python weekday().
    let day = ((days_since_epoch + 3) % 7 + 7) % 7;
    (day as u32, hour as u32)
}

pub(crate) fn parse_glf_response(response: &str) -> Option<u32> {
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

pub(crate) fn parse_command_parts(response: &str, command: &str) -> Vec<String> {
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

pub(crate) async fn read_frequency_lockouts_from_scanner(
    state: &AppState,
) -> Result<Vec<u32>, ApiError> {
    let _ = send_raw_command(state, "PRG", false).await?;
    // REGRESSION GUARD (#138): run the GLF walk in a helper so EPG is ALWAYS
    // sent afterward, even if a GLF read errors mid-walk. A `?` that returned
    // early before the EPG would strand the scanner in program mode and leave
    // the poll loop suspended (program_mode_active never clears).
    let result = read_frequency_lockouts_walk(state).await;
    let _ = send_raw_command(state, "EPG", false).await;
    result
}

async fn read_frequency_lockouts_walk(state: &AppState) -> Result<Vec<u32>, ApiError> {
    // GLF is a bare-command cursor iterator: send `GLF` repeatedly and the
    // scanner steps through its lockout list, replying `GLF,<freq8>` per
    // entry and `GLF,-1` at the end. Verified on hardware 2026-07-08
    // (docs/wire_captures/2026-07-08/glf-walk-probe.txt, fw 1.06.06,
    // reproducible via `cargo run -p bearpaw-api --example glf_walk_probe`).
    // The parameterized forms this walk used to send (`GLF,***`,
    // `GLF,<value>`) are answered with a payload-less `GLF,OK` and do NOT
    // iterate — that's why at most one lockout was ever read (#142). The
    // firmware caps the list at 100 entries; 110 bounds a runaway loop.
    let mut values = Vec::new();
    for _ in 0..110 {
        let response = send_raw_command(state, "GLF", false).await?;
        if matches!(classify_response(&response), ScannerReply::EndOfList) {
            break;
        }
        let Some(value) = parse_glf_response(&response) else {
            break;
        };
        values.push(value);
    }
    Ok(values)
}

pub(crate) async fn read_settings_snapshot_from_scanner(
    state: &AppState,
) -> Result<Value, ApiError> {
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
    // Per-section strictness (#143): a section whose reply is NG/ERR or whose
    // primary field doesn't parse becomes `null` instead of a fabricated
    // zero/default. `get_config` merges only non-null sections over the
    // cached settings, so one flaky read can no longer permanently overwrite
    // a good cached value.
    fn usable(response: &str) -> bool {
        !matches!(
            classify_response(response),
            ScannerReply::Ng | ScannerReply::Err
        )
    }
    let result = async {
        let squelch = {
            let resp = send_raw_command(state, "SQL", false).await?;
            let parts = parse_command_parts(&resp, "SQL");
            match usable(&resp)
                .then(|| parts.first().and_then(|s| s.parse::<u8>().ok()))
                .flatten()
            {
                Some(level) => json!({ "level": level }),
                None => Value::Null,
            }
        };
        let backlight = {
            let resp = send_raw_command(state, "BLT", false).await?;
            let parts = parse_command_parts(&resp, "BLT");
            match usable(&resp).then(|| parts.first().cloned()).flatten() {
                Some(event)
                    if matches!(
                        event.to_uppercase().as_str(),
                        "AO" | "AF" | "KY" | "SQ" | "KS"
                    ) =>
                {
                    json!({ "event": event })
                }
                _ => Value::Null,
            }
        };
        let battery = {
            let resp = send_raw_command(state, "BSV", false).await?;
            let parts = parse_command_parts(&resp, "BSV");
            match usable(&resp)
                .then(|| parts.first().and_then(|s| s.parse::<u8>().ok()))
                .flatten()
            {
                Some(v) => json!({ "charge_time": v }),
                None => Value::Null,
            }
        };
        let key_beep = {
            let resp = send_raw_command(state, "KBP", false).await?;
            let parts = parse_command_parts(&resp, "KBP");
            match usable(&resp)
                .then(|| parts.first().and_then(|s| s.parse::<i32>().ok()))
                .flatten()
            {
                Some(level) => json!({
                    "level": level,
                    "lock": parts.get(1).map(|s| s == "1").unwrap_or(false)
                }),
                None => Value::Null,
            }
        };
        let priority = {
            let resp = send_raw_command(state, "PRI", false).await?;
            let parts = parse_command_parts(&resp, "PRI");
            match usable(&resp)
                .then(|| parts.first().and_then(|s| s.parse::<u8>().ok()))
                .flatten()
            {
                Some(mode) => json!({ "mode": mode }),
                None => Value::Null,
            }
        };
        let search = {
            let resp = send_raw_command(state, "SCO", false).await?;
            let parts = parse_command_parts(&resp, "SCO");
            match usable(&resp)
                .then(|| parts.first().and_then(|s| s.parse::<i32>().ok()))
                .flatten()
            {
                Some(delay) => json!({
                    "delay": delay,
                    "code_search": parts.get(1).map(|s| s == "1").unwrap_or(false)
                }),
                None => Value::Null,
            }
        };
        let close_call = {
            let resp = send_raw_command(state, "CLC", false).await?;
            let parts = parse_command_parts(&resp, "CLC");
            match usable(&resp)
                .then(|| parts.first().and_then(|s| s.parse::<u8>().ok()))
                .flatten()
            {
                Some(mode) => {
                    let band_raw = parts.get(3).cloned().unwrap_or_else(|| "00000".to_string());
                    json!({
                        "mode": mode,
                        "alert_beep": parts.get(1).map(|s| s == "1").unwrap_or(false),
                        "alert_light": parts.get(2).map(|s| s == "1").unwrap_or(false),
                        "band": band_raw.chars().take(5).map(|c| c == '1').collect::<Vec<bool>>(),
                        "lockout": parts.get(4).map(|s| s == "1").unwrap_or(false)
                    })
                }
                None => Value::Null,
            }
        };
        fn group_mask(resp: &str, cmd: &str) -> Value {
            let parts = parse_command_parts(resp, cmd);
            match parts.first() {
                Some(flags)
                    if flags.len() >= 10 && flags.chars().all(|c| c == '0' || c == '1') =>
                {
                    let groups = flags.chars().take(10).map(|c| c == '0').collect::<Vec<bool>>();
                    json!({ "groups": groups })
                }
                _ => Value::Null,
            }
        }
        let service_search = {
            let resp = send_raw_command(state, "SSG", false).await?;
            if usable(&resp) {
                group_mask(&resp, "SSG")
            } else {
                Value::Null
            }
        };
        let custom_search = {
            let resp = send_raw_command(state, "CSG", false).await?;
            if usable(&resp) {
                group_mask(&resp, "CSG")
            } else {
                Value::Null
            }
        };
        let mut custom_search_ranges = Vec::new();
        for idx in 1..=10 {
            let response = send_raw_command(state, &format!("CSP,{}", idx), false).await?;
            if !usable(&response) {
                continue;
            }
            let mut parts = parse_command_parts(&response, "CSP");
            if parts.first().and_then(|s| s.parse::<u8>().ok()) == Some(idx) {
                parts.remove(0);
            }
            let (Some(lower), Some(upper)) = (
                parts.first().and_then(|s| s.parse::<f64>().ok()),
                parts.get(1).and_then(|s| s.parse::<f64>().ok()),
            ) else {
                continue;
            };
            custom_search_ranges.push(json!({
                "index": idx,
                "lower": lower / 10000.0,
                "upper": upper / 10000.0
            }));
        }
        let weather = {
            let resp = send_raw_command(state, "WXS", false).await?;
            let parts = parse_command_parts(&resp, "WXS");
            match usable(&resp).then(|| parts.first().cloned()).flatten() {
                Some(v) if v == "0" || v == "1" => json!({ "priority": v == "1" }),
                _ => Value::Null,
            }
        };
        let contrast = {
            let resp = send_raw_command(state, "CNT", false).await?;
            let parts = parse_command_parts(&resp, "CNT");
            match usable(&resp)
                .then(|| parts.first().and_then(|s| s.parse::<u8>().ok()))
                .flatten()
            {
                Some(level) => json!({ "level": level }),
                None => Value::Null,
            }
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

pub(crate) async fn read_channel_from_scanner(
    state: &AppState,
    index: u16,
) -> Result<ChannelData, ApiError> {
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

/// Build the payload (everything after `CIN,<index>,`) for a CIN write.
///
/// Wire order — verified against this hardware 2026-07-08
/// (`docs/wire_captures/2026-07-08/cin-write-order-probe.txt`): write order
/// equals read order, `name, freq, mod, tone, delay, lockout, priority`.
/// No bank field exists on the wire (bank comes from `SCG`).
///
/// Encoding rules this enforces (#132):
/// - Tone goes on the wire as the 0–231 CODE, never Hz. CTCSS Hz is encoded
///   via `tones::ctcss_hz_to_code`; DCS uses `tone_dcs_code`; unknown values
///   are a validation error rather than a silent wrong tone.
/// - An empty alpha tag is written as 16 spaces — an empty wire field means
///   "leave unchanged", so writing `""` would keep the old name (empirically
///   confirmed by the 2026-07-08 probe).
/// - Modulation is whitelisted (comma injection through this field reached
///   the wire before).
pub(crate) fn build_cin_write_payload(channel: &ChannelData) -> Result<String, ApiError> {
    let alpha_tag = channel
        .alpha_tag
        .replace(',', " ")
        .trim()
        .chars()
        .take(16)
        .collect::<String>();
    let alpha_tag = if alpha_tag.is_empty() {
        " ".repeat(16)
    } else {
        alpha_tag
    };

    let modulation = if channel.modulation.is_empty() {
        "AUTO".to_string()
    } else {
        channel.modulation.trim().to_uppercase()
    };
    if !matches!(modulation.as_str(), "AUTO" | "AM" | "FM" | "NFM") {
        return Err(ApiError::BadRequest("modulation_invalid".to_string()));
    }

    use crate::state::ToneSquelchKind;
    let tone_code: u16 = match channel.tone_squelch_kind {
        ToneSquelchKind::None => 0,
        ToneSquelchKind::Search => 127,
        ToneSquelchKind::Ctcss => {
            let hz = channel
                .tone_squelch
                .ok_or_else(|| ApiError::BadRequest("tone_missing".to_string()))?;
            tones::ctcss_hz_to_code(hz)
                .ok_or_else(|| ApiError::BadRequest("tone_invalid".to_string()))?
        }
        ToneSquelchKind::Dcs => {
            let code = channel
                .tone_dcs_code
                .ok_or_else(|| ApiError::BadRequest("tone_missing".to_string()))?;
            if tones::dcs_code_to_number(code).is_none() {
                return Err(ApiError::BadRequest("tone_invalid".to_string()));
            }
            code
        }
    };

    // 8-digit zero-padded integer in units of 100 Hz — the only frequency
    // shape observed on the wire (capture: `01451300` = 145.13 MHz).
    let freq = format!("{:08}", (channel.frequency * 10000.0).round() as i64);

    Ok(format!(
        "{},{},{},{},{},{},{}",
        alpha_tag,
        freq,
        modulation,
        tone_code,
        channel.delay,
        if channel.lockout { "1" } else { "0" },
        if channel.priority { "1" } else { "0" },
    ))
}

/// Write one channel without the per-channel read-back verify, for bulk
/// import. The caller MUST already hold a `ProgramModeGuard` — this sends only
/// `CIN,<idx>,...` and checks the reply, matching Uniden Sentinel's bulk-write
/// path (one wire command per channel). Correctness is recovered by a single
/// full read-back after the whole import, not per channel — 500 inline
/// read-backs are what made import take ~8 minutes instead of ~30 seconds.
pub(crate) async fn write_channel_no_readback(
    state: &AppState,
    channel: &ChannelData,
) -> Result<(), ApiError> {
    let payload = build_cin_write_payload(channel)?;
    let write_cmd = format!("CIN,{},{}", channel.index, payload);
    match classify_response(&send_raw_command(state, &write_cmd, false).await?) {
        ScannerReply::Ok => Ok(()),
        ScannerReply::Ng => Err(ApiError::BadRequest("channel_write_wrong_mode".to_string())),
        _ => Err(ApiError::BadRequest("channel_write_rejected".to_string())),
    }
}

/// Read-back-verify comparison: does the channel we read back match what we
/// wrote? `wrote_alpha` is the sanitised alpha (comma-stripped, 16-char cap,
/// trimmed) that actually went to the wire.
///
/// REGRESSION GUARD (#195, #197): writing an empty channel (freq 0) is a no-op
/// on this hardware — the scanner DISCARDS every programmed field for a slot
/// with no frequency and re-stamps the fixed factory-empty signature
/// `,00000000,AUTO,0,2,1,0` (mod=AUTO, tone=0, delay=2, lockout=1, priority=0).
/// Verified across every empty-channel capture we have: CIN,3 and CIN,10
/// (docs/wire_captures/2026-05-21/raw.txt + live log), CIN,500 and the DCH
/// factory-restore (docs/wire_captures/2026-07-08/cin-write-order-probe.txt).
///
/// This surfaced once drag-reorder (#195) started pulling empty slots into the
/// upload write-set. #196 first tolerated only the forced lockout=1; the scanner
/// also forces delay=2 (and any other field), so a reorder that touched delay
/// still tripped a false channel_not_persisted (#197). The complete rule: when
/// we wrote freq 0, accept the read-back iff it IS the factory-empty signature —
/// don't compare it against what we sent.
///
/// REGRESSION GUARD (#198): priority is bank-exclusive ("one priority channel
/// per bank max"). On this firmware a CIN write can SET priority (false→true,
/// displacing the bank's previous priority channel) but CANNOT CLEAR it
/// (true→false is refused — the scanner keeps priority=1 and we'd otherwise
/// report a false channel_not_persisted). Captured live: CH9 wrote priority=0,
/// read back priority=1, isolated single write, reproducible (see
/// docs/wire_captures/2026-05-21/audit-reconciliation.md, 2026-07-21 finding).
/// So on a programmed channel, accept a read-back priority=1 when we wrote 0.
/// Removing priority is a separate, unimplemented mechanism (radio-side / a
/// dedicated command); the UI is being reworked to model one-per-bank.
fn readback_matches(wrote: &ChannelData, readback: &ChannelData, wrote_alpha: &str) -> bool {
    if wrote.frequency.abs() < 0.00005 {
        return is_factory_empty(readback);
    }
    let priority_ok = readback.priority == wrote.priority
        || (!wrote.priority && readback.priority); // refused clear — see guard above
    (readback.frequency - wrote.frequency).abs() < 0.00005
        && readback.alpha_tag.trim() == wrote_alpha
        && readback.delay == wrote.delay
        && readback.lockout == wrote.lockout
        && priority_ok
}

/// A channel needs an actual DCH+rewrite clear only if it is programmed
/// (freq != 0) and currently priority. Empty or already-non-priority
/// channels are a no-op.
fn needs_priority_clear(ch: &ChannelData) -> bool {
    ch.frequency.abs() >= 0.00005 && ch.priority
}

/// The fixed tail the scanner stamps on any channel with no frequency:
/// delay=2, lockout=1, priority=0, no tone (`...,00000000,AUTO,0,2,1,0`). See
/// `readback_matches` for the capture citations. Only the tail is checked: the
/// alpha and modulation slots of an empty channel read back as "AUTO" on this
/// firmware (parse_cin_response fills alpha_tag="AUTO", modulation="AUTO"), but
/// those aren't part of the forced-empty invariant — what matters is that the
/// scanner ignored the delay/lockout/priority we sent and forced these values.
fn is_factory_empty(ch: &ChannelData) -> bool {
    ch.frequency.abs() < 0.00005
        && ch.delay == 2
        && ch.lockout
        && !ch.priority
        && ch.tone_squelch_kind == crate::state::ToneSquelchKind::None
}

/// The index of the bank's current priority channel, if any. A bank holds
/// 0 or 1 priority channel (one-per-bank). `bank` is 1..=10.
fn bank_priority_index(
    channels: &std::collections::HashMap<u16, ChannelData>,
    bank: u8,
) -> Option<u16> {
    channels
        .values()
        .filter(|c| c.priority && crate::protocol::index_to_bank(c.index) == bank)
        .map(|c| c.index)
        .min()
}

pub(crate) async fn write_channel_to_scanner(
    state: &AppState,
    channel: &ChannelData,
) -> Result<ChannelData, ApiError> {
    let payload = build_cin_write_payload(channel)?;

    let in_program_mode = state.program_mode_active.load(Ordering::Relaxed);
    if !in_program_mode {
        let _ = send_raw_command(state, "PRG", false).await?;
    }
    let write_cmd = format!("CIN,{},{}", channel.index, payload);
    let write_response = send_raw_command(state, &write_cmd, false).await;
    let read_response = send_raw_command(state, &format!("CIN,{}", channel.index), false).await;
    // REGRESSION GUARD (#138): EPG must be sent before any early return so
    // the scanner isn't left stuck in program mode with polling suspended.
    if !in_program_mode {
        let _ = send_raw_command(state, "EPG", false).await;
    }

    match classify_response(&write_response?) {
        ScannerReply::Ok => {}
        ScannerReply::Ng => {
            return Err(ApiError::BadRequest("channel_write_wrong_mode".to_string()));
        }
        _ => return Err(ApiError::BadRequest("channel_write_rejected".to_string())),
    }

    let read_response = read_response?;
    let readback = parse_cin_response(channel.index, &read_response)
        .ok_or_else(|| ApiError::BadRequest("channel_readback_failed".to_string()))?;

    // Read-back-verify: the scanner replied OK, but OK does not prove the
    // fields persisted as sent. Compare what came back against what we wrote
    // and refuse to report success on a mismatch. Alpha comparison is on the
    // sanitised value (comma-stripped, 16-char cap, trimmed) because that is
    // what actually went to the wire.
    let wrote_alpha = channel
        .alpha_tag
        .replace(',', " ")
        .trim()
        .chars()
        .take(16)
        .collect::<String>();
    let persisted = readback_matches(channel, &readback, &wrote_alpha);
    if !persisted {
        warn!(
            index = channel.index,
            wrote = %write_cmd,
            read_back = %read_response.trim(),
            "CIN write not persisted as sent"
        );
        return Err(ApiError::BadRequest("channel_not_persisted".to_string()));
    }
    Ok(readback)
}

/// Clear a channel's priority. The firmware refuses an in-place priority
/// 1->0 CIN write, so the only mechanism is DCH (wipe to factory-empty)
/// then rewrite the channel with priority=0 (verified: #203 probe).
///
/// DATA-LOSS SAFETY: DCH deletes the channel. We read the full channel
/// FIRST, abort before DCH if the read fails, then rewrite from the saved
/// copy and read-back-verify. All inside one ProgramModeGuard.
pub(crate) async fn clear_channel_priority(
    state: &AppState,
    index: u16,
) -> Result<ChannelData, ApiError> {
    let _guard = ProgramModeGuard::enter(state).await?;

    // 1. Read the full channel first. Never DCH an unread channel.
    let current = read_channel_from_scanner(state, index).await?;

    // 2. No-op if nothing to clear.
    if !needs_priority_clear(&current) {
        return Ok(current);
    }

    // 3. Build the rewrite payload (same fields, priority off) BEFORE deleting,
    //    so a payload-build error can't strand us post-DCH.
    let mut rewritten = current.clone();
    rewritten.priority = false;
    let payload = build_cin_write_payload(&rewritten)?;

    // 4. DCH — wipe to factory-empty.
    match classify_response(&send_raw_command(state, &format!("DCH,{index}"), false).await?) {
        ScannerReply::Ok => {}
        _ => return Err(ApiError::BadRequest("priority_clear_dch_failed".to_string())),
    }

    // 5. Rewrite with priority=0.
    let write_cmd = format!("CIN,{index},{payload}");
    match classify_response(&send_raw_command(state, &write_cmd, false).await?) {
        ScannerReply::Ok => {}
        _ => return Err(ApiError::BadRequest("priority_clear_rewrite_failed".to_string())),
    }

    // 6. Read-back-verify the rewrite.
    let read_response = send_raw_command(state, &format!("CIN,{index}"), false).await?;
    let readback = parse_cin_response(index, &read_response)
        .ok_or_else(|| ApiError::BadRequest("priority_clear_readback_failed".to_string()))?;
    let wrote_alpha = rewritten
        .alpha_tag
        .replace(',', " ")
        .trim()
        .chars()
        .take(16)
        .collect::<String>();
    if !readback_matches(&rewritten, &readback, &wrote_alpha) {
        warn!(
            index = index,
            wrote = %write_cmd,
            read_back = %read_response.trim(),
            "priority clear rewrite not persisted as sent"
        );
        return Err(ApiError::BadRequest("priority_clear_not_persisted".to_string()));
    }
    Ok(readback)
}

pub(crate) async fn set_channel_lockout_on_scanner(
    state: &AppState,
    index: u16,
    locked: bool,
) -> Result<ChannelData, ApiError> {
    // Read the channel through the real parser, flip the lockout bit, and
    // write it back through the same fixed-order builder every other CIN
    // write uses. The old positional-index surgery guessed the lockout slot
    // with the has_tone heuristic and, for the common tone=0 layout, wrote
    // into the TONE field instead (#132) — "unlock" reported success while
    // leaving the channel locked.
    let in_program_mode = state.program_mode_active.load(Ordering::Relaxed);
    if !in_program_mode {
        let _ = send_raw_command(state, "PRG", false).await?;
    }
    let response = send_raw_command(state, &format!("CIN,{}", index), false).await;
    // REGRESSION GUARD (#138): send EPG before propagating a read error so the
    // scanner isn't left in program mode with polling suspended.
    let response = match response {
        Ok(r) => r,
        Err(e) => {
            if !in_program_mode {
                let _ = send_raw_command(state, "EPG", false).await;
            }
            return Err(e);
        }
    };
    let channel = match parse_cin_response(index, &response) {
        Some(c) => c,
        None => {
            if !in_program_mode {
                let _ = send_raw_command(state, "EPG", false).await;
            }
            return Err(ApiError::BadRequest("lockout_failed".to_string()));
        }
    };

    let mut updated = channel;
    updated.lockout = locked;
    let payload = match build_cin_write_payload(&updated) {
        Ok(p) => p,
        Err(e) => {
            if !in_program_mode {
                let _ = send_raw_command(state, "EPG", false).await;
            }
            return Err(e);
        }
    };

    let write_cmd = format!("CIN,{},{}", index, payload);
    let write_response = send_raw_command(state, &write_cmd, false).await;
    let read_response = send_raw_command(state, &format!("CIN,{}", index), false).await;
    if !in_program_mode {
        let _ = send_raw_command(state, "EPG", false).await;
    }

    match classify_response(&write_response?) {
        ScannerReply::Ok => {}
        _ => return Err(ApiError::BadRequest("lockout_failed".to_string())),
    }
    let read_response = read_response?;
    let readback = parse_cin_response(index, &read_response)
        .ok_or_else(|| ApiError::BadRequest("lockout_failed".to_string()))?;
    if readback.lockout != locked {
        warn!(
            index,
            wanted = locked,
            read_back = readback.lockout,
            "lockout write not persisted as sent"
        );
        return Err(ApiError::BadRequest("lockout_not_persisted".to_string()));
    }
    Ok(readback)
}

pub(crate) fn uuid_simple() -> String {
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

    fn test_channel() -> ChannelData {
        ChannelData {
            index: 42,
            frequency: 145.13,
            modulation: "FM".to_string(),
            alpha_tag: "Test Chan".to_string(),
            delay: 2,
            lockout: false,
            priority: true,
            tone_squelch: None,
            tone_squelch_kind: crate::state::ToneSquelchKind::None,
            tone_dcs_code: None,
            bank: 1,
        }
    }

    // REGRESSION GUARD (#132): CIN write order is name, freq, mod, tone,
    // delay, lockout, priority — verified against hardware 2026-07-08
    // (docs/wire_captures/2026-07-08/cin-write-order-probe.txt). The old
    // has_tone heuristic emitted lockout/delay/priority/bank for tone=0
    // channels, putting bank in the scanner's priority field.
    #[test]
    fn cin_payload_uses_verified_field_order_for_tone_0() {
        let payload = build_cin_write_payload(&test_channel()).unwrap();
        assert_eq!(payload, "Test Chan,01451300,FM,0,2,0,1");
    }

    #[test]
    fn cin_payload_encodes_ctcss_as_wire_code_not_hz() {
        let mut ch = test_channel();
        ch.tone_squelch_kind = crate::state::ToneSquelchKind::Ctcss;
        ch.tone_squelch = Some(100.0);
        let payload = build_cin_write_payload(&ch).unwrap();
        // 100.0 Hz is wire code 76. Writing "100" would be 189.9 Hz.
        assert_eq!(payload, "Test Chan,01451300,FM,76,2,0,1");
    }

    #[test]
    fn cin_payload_preserves_dcs_code() {
        let mut ch = test_channel();
        ch.tone_squelch_kind = crate::state::ToneSquelchKind::Dcs;
        ch.tone_dcs_code = Some(151);
        let payload = build_cin_write_payload(&ch).unwrap();
        assert_eq!(payload, "Test Chan,01451300,FM,151,2,0,1");
    }

    #[test]
    fn cin_payload_rejects_non_canonical_ctcss_hz() {
        let mut ch = test_channel();
        ch.tone_squelch_kind = crate::state::ToneSquelchKind::Ctcss;
        ch.tone_squelch = Some(100.5);
        assert!(build_cin_write_payload(&ch).is_err());
    }

    #[test]
    fn cin_payload_rejects_modulation_injection() {
        let mut ch = test_channel();
        ch.modulation = "FM,0,0,1,0".to_string();
        assert!(build_cin_write_payload(&ch).is_err());
    }

    #[test]
    fn cin_payload_clears_empty_alpha_with_16_spaces() {
        // An empty wire field means "unchanged" (2026-07-08 probe), so a
        // cleared name must go out as 16 spaces or the old name survives.
        let mut ch = test_channel();
        ch.alpha_tag = String::new();
        let payload = build_cin_write_payload(&ch).unwrap();
        assert_eq!(payload, "                ,01451300,FM,0,2,0,1");
    }

    #[test]
    fn cin_payload_sanitizes_alpha_commas_and_length() {
        let mut ch = test_channel();
        ch.alpha_tag = "A,B,C this name is way too long".to_string();
        let payload = build_cin_write_payload(&ch).unwrap();
        assert!(payload.starts_with("A B C this name "));
        assert_eq!(payload.split(',').count(), 7);
    }

    #[test]
    fn cin_payload_preserves_negative_predelay() {
        let mut ch = test_channel();
        ch.delay = -10;
        let payload = build_cin_write_payload(&ch).unwrap();
        assert_eq!(payload, "Test Chan,01451300,FM,0,-10,0,1");
    }

    /// What the scanner reads back for any empty slot: the factory-empty
    /// signature `AUTO,00000000,AUTO,0,2,1,0` as parse_cin_response produces it
    /// (alpha_tag="AUTO", delay=2, lockout=1, priority=0, no tone).
    fn factory_empty_readback() -> ChannelData {
        ChannelData {
            index: 10,
            frequency: 0.0,
            modulation: "AUTO".to_string(),
            alpha_tag: "AUTO".to_string(),
            delay: 2,
            lockout: true,
            priority: false,
            tone_squelch: None,
            tone_squelch_kind: crate::state::ToneSquelchKind::None,
            tone_dcs_code: None,
            bank: 1,
        }
    }

    fn empty_channel_readback() -> ChannelData {
        let mut c = test_channel();
        c.frequency = 0.0;
        c.priority = false;
        c
    }

    #[test]
    fn needs_priority_clear_only_when_programmed_and_priority() {
        let mut ch = test_channel(); // freq 145.13
        ch.priority = true;
        assert!(needs_priority_clear(&ch)); // programmed + priority => clear needed

        ch.priority = false;
        assert!(!needs_priority_clear(&ch)); // not priority => no-op

        let empty = empty_channel_readback(); // freq 0 (helper below)
        assert!(!needs_priority_clear(&empty)); // empty slot => no-op
    }

    // REGRESSION GUARD (#195, #197): writing an empty channel (freq 0) is a
    // no-op — the scanner discards every programmed field and re-stamps the
    // factory-empty signature `,00000000,AUTO,0,2,1,0`. When we wrote freq 0,
    // the verify must accept the read-back iff it IS that signature, NOT compare
    // it against what we sent. #196 tolerated only lockout; the scanner also
    // forces delay=2, so a reorder touching delay still tripped a false
    // channel_not_persisted (this is the exact CIN,10 live-log case).
    #[test]
    fn readback_accepts_factory_empty_ignoring_sent_delay_and_lockout() {
        // Live repro: wrote CIN,10,...,0,0,0 (delay 0, lockout 0, prio 0),
        // scanner forced ...,2,1,0. Both delay AND lockout diverge.
        let mut wrote = factory_empty_readback();
        wrote.delay = 0;
        wrote.lockout = false;
        let readback = factory_empty_readback(); // delay=2, lockout=1
        assert!(readback_matches(&wrote, &readback, "AUTO"));
    }

    #[test]
    fn readback_rejects_forced_lockout_on_programmed_channel() {
        // A programmed channel (freq != 0) must NOT get the empty-channel pass:
        // if we wrote lockout=0 and it read back 1, that's a real mismatch.
        let mut readback = test_channel();
        readback.lockout = true;
        let mut wrote = test_channel();
        wrote.lockout = false;
        assert!(!readback_matches(&wrote, &readback, "Test Chan"));
    }

    #[test]
    fn readback_rejects_empty_write_that_did_not_go_factory_empty() {
        // Freq 0 but the read-back is NOT the factory signature (delay 5) —
        // something genuinely wrong; do not silently pass it.
        let mut wrote = factory_empty_readback();
        wrote.delay = 0;
        let mut readback = factory_empty_readback();
        readback.delay = 5;
        assert!(!readback_matches(&wrote, &readback, "AUTO"));
    }

    // REGRESSION GUARD (#198): priority is bank-exclusive — a programmed
    // channel accepts SET but refuses CLEAR via CIN. Wrote priority=0, scanner
    // kept priority=1; that must NOT be a channel_not_persisted (live CH9 case).
    #[test]
    fn readback_accepts_refused_priority_clear_on_programmed_channel() {
        let mut wrote = test_channel(); // freq 145.13
        wrote.priority = false; // we tried to clear
        let mut readback = test_channel();
        readback.priority = true; // scanner refused, kept it on
        assert!(readback_matches(&wrote, &readback, "Test Chan"));
    }

    #[test]
    fn readback_rejects_unexpected_priority_set() {
        // The tolerance is one-directional: we did NOT ask to clear (wrote
        // priority=true) yet it read back false — a real failure, still caught.
        let mut wrote = test_channel();
        wrote.priority = true;
        let mut readback = test_channel();
        readback.priority = false;
        assert!(!readback_matches(&wrote, &readback, "Test Chan"));
    }

    #[test]
    fn readback_still_catches_other_mismatch_when_priority_clear_refused() {
        // Even when a priority clear is legitimately refused, a genuine
        // divergence in another field (delay) must still fail the verify.
        let mut wrote = test_channel();
        wrote.priority = false;
        wrote.delay = 1;
        let mut readback = test_channel();
        readback.priority = true; // refused clear (tolerated)
        readback.delay = 5; // real mismatch (must fail)
        assert!(!readback_matches(&wrote, &readback, "Test Chan"));
    }

    // REGRESSION GUARD (#150): /health is documented and referenced by the
    // frontend contract test; it must be routed and return 200 regardless of
    // scanner connectivity.
    #[tokio::test]
    async fn health_returns_ok_without_scanner() {
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
        assert!(body.get("version").is_some());
        assert!(body.get("timestamp").is_some());
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

    // REGRESSION GUARD (#143): out-of-range channel indexes must be rejected
    // with 400 before any scanner round-trip, not sent to the wire as CIN,0 /
    // CIN,501.
    #[tokio::test]
    async fn get_memory_channel_rejects_out_of_range_index() {
        for idx in ["0", "501", "60000"] {
            let app = router(default_state());
            let response = app
                .oneshot(
                    Request::builder()
                        .method(Method::GET)
                        .uri(format!("/api/v1/memory/channels/{idx}"))
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                response.status(),
                StatusCode::BAD_REQUEST,
                "index {idx} must be rejected"
            );
            let body = json_body(response).await;
            assert_eq!(body["error"], "channel_out_of_range");
        }
    }

    // REGRESSION GUARD (#143): post_lockout must range-check the channel index.
    #[tokio::test]
    async fn post_lockout_rejects_out_of_range_channel() {
        let app = router(default_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/commands/lockout")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"mode":"temporary","channel":600}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let body = json_body(response).await;
        assert_eq!(body["error"], "channel_out_of_range");
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

    #[tokio::test]
    async fn custom_search_defaults_returns_ten_ranges() {
        let app = router(default_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/settings/custom-search/defaults")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        let ranges = body.get("ranges").and_then(|v| v.as_array()).unwrap();
        assert_eq!(ranges.len(), 10);
        // Spot-check the first entry (25.0–27.995 MHz, "CB / 11m").
        assert_eq!(ranges[0].get("index"), Some(&serde_json::json!(1)));
        assert_eq!(ranges[0].get("lower"), Some(&serde_json::json!(25.0)));
        assert_eq!(ranges[0].get("label"), Some(&serde_json::json!("CB / 11m")));
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

    #[tokio::test]
    async fn import_ss_route_is_registered() {
        let app = router(default_state());
        // A GET on a POST-only route returns 405, proving the path is mounted.
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/memory/import/bc125at_ss")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[test]
    fn bank_priority_index_finds_the_one_priority_channel() {
        use std::collections::HashMap;
        let mut ch = HashMap::new();
        // Bank 1 = indices 1..=50. CH2 is priority; CH9 is not.
        let mut c2 = test_channel();
        c2.index = 2;
        c2.priority = true;
        let mut c9 = test_channel();
        c9.index = 9;
        c9.priority = false;
        ch.insert(2, c2);
        ch.insert(9, c9);
        assert_eq!(bank_priority_index(&ch, 1), Some(2));
        assert_eq!(bank_priority_index(&ch, 2), None); // bank 2 empty
    }
}
