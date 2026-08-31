//! Axum REST + WebSocket server.
//!
//! Compatibility-first API surface so the Rust backend can replace the Python backend
//! without frontend contract regressions.

mod channel_cache;
mod control;
mod handlers;
mod memory_sync;
mod poll;
mod program_mode;
mod scanner_registry;
mod security;
mod ws;

pub(crate) use program_mode::ProgramModeGuard;
pub(crate) use ws::broadcast_banks_update;

pub use control::{validate_frequency, ControlCommand};
pub use poll::spawn_poll_loop;

use axum::{
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{delete, get, post},
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

use crate::protocol::capabilities::ScannerCapabilities;
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

impl AppState {
    /// Capabilities of the connected scanner, or the BC125AT-family defaults.
    ///
    /// Defaults rather than `None` so callers never handle a third state that
    /// exists only between process start and the first `MDL` reply. Matches
    /// the frontend's `useScannerCapabilities()` fallback for the same reason.
    /// The profile key for whichever scanner is attached.
    ///
    /// Falls back to the shared placeholder when no profile has been resolved --
    /// before the first `MDL`, or when the profile database could not be
    /// written. That fallback IS the pre-#414 behaviour, so an unusable
    /// registry degrades to one shared cache rather than to no cache.
    pub fn scanner_id(&self) -> String {
        self.device
            .read()
            .ok()
            .and_then(|d| d.scanner_id.clone())
            .unwrap_or_else(|| channel_cache::PLACEHOLDER_SCANNER_ID.to_string())
    }

    pub fn capabilities(&self) -> crate::protocol::capabilities::ScannerCapabilities {
        self.device
            .read()
            .ok()
            .and_then(|d| d.capabilities)
            .unwrap_or_default()
    }

    /// Channel memory with `bank` filled in for the connected scanner.
    ///
    /// REGRESSION GUARD: `channels_with_banks_derives_per_model`, paired with
    /// `cin_does_not_derive_bank` in protocol/mod.rs. See the third-rail table
    /// in CLAUDE.md — either guard alone passes while banks are broken.
    ///
    /// `parse_cin_response` leaves `bank` at 0 because it is a pure function
    /// with no access to the capability descriptor, and the wire carries no
    /// bank field to begin with. This is where the derivation belongs: banks
    /// are 50 channels wide on the BC125AT family and 30 on the BC75XLT, so a
    /// fixed divisor misfiles every BC75XLT channel above 30.
    ///
    /// Measured on hardware before the fix: 7 of 11 sampled BC75XLT channels
    /// were in the wrong bank, and channel 300 reported bank 6 instead of 10.
    /// See #401.
    pub fn channels_with_banks(&self) -> Vec<ChannelData> {
        let caps = self.capabilities();
        let mut channels: Vec<ChannelData> = match self.shadow.read() {
            Ok(shadow) => shadow.channels.values().cloned().collect(),
            Err(_) => return Vec::new(),
        };
        for c in &mut channels {
            c.bank = caps.index_to_bank(c.index);
        }
        channels.sort_by_key(|c| c.index);
        channels
    }

    /// One channel with `bank` filled in. See `channels_with_banks`.
    pub fn channel_with_bank(&self, index: u16) -> Option<ChannelData> {
        let caps = self.capabilities();
        let mut c = self
            .shadow
            .read()
            .ok()
            .and_then(|s| s.channels.get(&index).cloned())?;
        c.bank = caps.index_to_bank(c.index);
        Some(c)
    }
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
    /// Model of the scanner that heard this hit, or `None` for rows recorded
    /// before Bearpaw tracked which radio was attached.
    ///
    /// Model, not a per-unit identifier: a BC125AT reports a hardcoded USB
    /// serial of "0001", and on macOS it has no serial node at all (the
    /// direct-USB path), so there is no reliable per-unit key to record. This
    /// separates a BC125AT from a BC75XLT, which is the distinction that makes
    /// channel numbers comparable. Telling two units of the SAME model apart
    /// needs the identity work in #414.
    pub scanner_id: Option<String>,
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

const PREFERENCES_SCHEMA_VERSION: i32 = 3;

/// How often the channel cache is snapshotted to SQLite.
///
/// The flush writes the WHOLE map unconditionally — that is what makes it
/// impossible to miss one of the eleven `shadow.channels` mutation sites — so
/// the interval is the only lever on how much redundant writing an idle app
/// does. At 5 s an 8-hour session would run ~5,760 transactions and keep the
/// disk awake for nothing.
///
/// 30 s is safe because this is not the only flush: a completed memory sync
/// persists immediately, and shutdown persists before exit. Those cover the two
/// moments worth protecting. What this interval actually bounds is how much a
/// *hard kill* (SIGKILL, panic, power loss) can lose — and losing it costs a
/// re-sync, never data, because every write reaches the scanner first.
const CHANNEL_CACHE_FLUSH_SECS: u64 = 30;
const ANALYTICS_SCHEMA_VERSION: i32 = 2;

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
            "/api/v1/settings/custom-search/ranges/{index}",
            get(handlers::settings::get_custom_range).post(handlers::settings::set_custom_range),
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
            "/api/v1/lockouts/frequencies",
            delete(handlers::lockouts::remove_global_lockout),
        )
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
            "/api/v1/memory/channels/{index}",
            get(handlers::memory::get_memory_channel).put(handlers::memory::put_memory_channel),
        )
        .route(
            "/api/v1/memory/channels/{index}/priority",
            post(handlers::memory::put_memory_channel_priority),
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
            "/api/v1/memory/export/bc75xlt_ss",
            get(handlers::exports::export_bc75xlt_ss_file),
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
            "/api/v1/memory/import/bc75xlt_ss",
            post(handlers::import_ss::import_bc75xlt_ss),
        )
        .route(
            "/api/v1/preferences",
            get(handlers::preferences::get_preferences).put(handlers::preferences::put_preferences),
        )
        .route(
            "/api/v1/preferences/reset",
            post(handlers::preferences::reset_preferences),
        )
        .route(
            "/api/v1/preferences/{key}",
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

    // Periodic channel-cache snapshot. Sleeps FIRST so a fresh start does not
    // write before the first sync has produced anything; the flush's own
    // empty-map guard makes that harmless either way, but there is no reason to
    // open the database to learn there is nothing to write.
    let flush_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(CHANNEL_CACHE_FLUSH_SECS)).await;
            let s = flush_state.clone();
            // spawn_blocking: this is synchronous SQLite on a runtime worker.
            let _ =
                tokio::task::spawn_blocking(move || channel_cache::flush_channel_cache(&s)).await;
        }
    });

    // `router(state)` moves the state, so take the shutdown handle first.
    let shutdown_state = state.clone();

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
    // Final flush before exit. This is the one that makes a clean quit lose
    // nothing: without it, up to CHANNEL_CACHE_FLUSH_SECS of channel edits
    // would be absent from the cache on next launch, and the user would see
    // stale values for changes they watched succeed.
    channel_cache::flush_channel_cache(&shutdown_state);
    info!("Bearpaw API server shut down gracefully");
    Ok(())
}

pub fn default_state() -> AppState {
    let preferences_db_path = resolve_db_path("BEARPAW_PREFERENCES_DB", "scanner.db");
    let analytics_db_path = resolve_db_path("BEARPAW_ANALYTICS_DB", "analytics.db");
    // A migration failure must reach the user rather than starting degraded.
    // DeviceTab already renders `diagnostic_message` ungated (#396), so this
    // surfaces with no frontend change. Bearpaw is offline-first and starts
    // with no network, so this cannot be an error dialog or a stall -- the
    // diagnostic channel is the right surface.
    let migration_error = init_preferences_db(&preferences_db_path)
        .err()
        .or_else(|| init_analytics_db(&analytics_db_path).err());
    if let Some(err) = &migration_error {
        tracing::error!("database migration failed: {}", err);
    }
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
            // `data_diagnostic_*`, NOT `diagnostic_*`: a failed migration is
            // not resolved by connecting a scanner, and the connect path in
            // `api::poll` blanks the connection pair on every successful open.
            // See the field docs on DeviceInfo.
            data_diagnostic_code: migration_error
                .as_ref()
                .map(|_| "migration_failed".to_string()),
            data_diagnostic_message: migration_error.as_ref().map(|e| e.to_string()),
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
    // #273: gates the automatic update check the desktop shell runs at
    // launch. Defaults on — an existing install with no stored value keeps
    // the behaviour it shipped with — but the app is offline-first, so a
    // user who wants zero network traffic needs a way to turn it off.
    m.insert("check_updates_on_launch".to_string(), Value::Bool(true));
    // #413 follow-on: whether channel memory is re-read from the scanner at
    // every connect, or rendered from the SQLite cache until the user asks.
    //
    // Defaults ON, which is the pre-cache behaviour. A user poll (n=20,
    // 2026-08-30) found 45% program their scanner on its own keypad "all the
    // time" and 65% do so at least sometimes -- for them the cache is stale
    // before Bearpaw opens, and being quietly wrong is worse than being
    // visibly slow. A full walk costs ~5 s on a BC125AT over direct USB.
    //
    // Users who only program from a computer turn it off and get the instant
    // startup the cache was built for; their cache is never stale.
    m.insert("reread_memory_on_connect".to_string(), Value::Bool(true));
    // Whether the Scan page's analytics count only the connected scanner
    // ("scanner", the default) or every scanner ever attached ("all").
    //
    // Defaults to per-scanner because a channel number means something
    // different on each radio, so a summed "busiest channel" mixes
    // incompatible memory maps. A user with one scanner sees no difference
    // either way; a user with two gets the correct aggregation without having
    // to know the setting exists.
    m.insert(
        "analytics_scope".to_string(),
        Value::String("scanner".to_string()),
    );
    m.insert("start_dashboard_mode".to_string(), Value::Bool(true));
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
                    // Read at hit-close rather than stored on ActiveHit: the
                    // model cannot change mid-hit (a swap drops the port and
                    // ends the hit), and reading here keeps the one source of
                    // truth -- DeviceInfo -- as the only place a model lives.
                    scanner_id: state.device.read().ok().and_then(|d| d.model.clone()),
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

fn init_preferences_db(path: &str) -> Result<(), MigrationError> {
    match open_sqlite(path) {
        Some(conn) => migrate_preferences_db(path, &conn),
        // Unopenable is not a migration failure -- every read and write below
        // already degrades to defaults when the file cannot be opened.
        None => Ok(()),
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

fn init_analytics_db(path: &str) -> Result<(), MigrationError> {
    match open_sqlite(path) {
        Some(conn) => migrate_analytics_db(path, &conn),
        None => Ok(()),
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
            "SELECT id, timestamp, frequency, channel, alpha_tag, modulation, rssi, duration, mode, bank, session_id, ended_at, scanner_id
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
                let scanner_id: Option<String> = row.get(12)?;
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
                    scanner_id,
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
            "INSERT INTO scan_hits (timestamp, frequency, channel, alpha_tag, modulation, rssi, duration, mode, bank, session_id, ended_at, scanner_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
                hit.ended_at,
                hit.scanner_id
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

/// Per-call unique database path, for tests only.
///
/// `resolve_db_path` falls back to a fixed filesystem path when its env var is
/// unset, so every `default_state()` in the suite shared the same two SQLite
/// files. Rust runs tests in parallel threads, so 29 constructors contended on
/// those handles — and `preferences_reset_alias_matches` deletes every
/// preference row, which another test could observe mid-run. The suite passed
/// with `--test-threads=1` and failed intermittently without it.
///
/// Files land under one PID-scoped directory so a run's leftovers are
/// identifiable; the OS temp cleaner reclaims them. See #410.
#[cfg(test)]
fn unique_test_db_path(default_file: &str) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("bearpaw-test-dbs-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir.join(format!("{n}-{default_file}"))
        .to_string_lossy()
        .into_owned()
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
    // An explicit env var still wins above, so a test that wants a specific
    // file (the migration tests do) keeps getting it.
    fallback_db_path(default_file)
}

/// Where a database lives when no env var names one.
///
/// REGRESSION GUARD: `each_state_gets_its_own_databases`. See the third-rail
/// table in CLAUDE.md — a shared path here made the whole suite flaky under
/// parallel execution.
///
/// Split by cfg rather than branched inside `resolve_db_path` so neither build
/// carries the other's path logic.
#[cfg(not(test))]
fn fallback_db_path(default_file: &str) -> String {
    default_data_dir()
        .join(default_file)
        .to_string_lossy()
        .into_owned()
}

#[cfg(test)]
fn fallback_db_path(default_file: &str) -> String {
    unique_test_db_path(default_file)
}

/// Why a migration could not run. Carried to the caller so a failure surfaces
/// as a diagnostic rather than a silently half-migrated database.
#[derive(Debug)]
pub(crate) enum MigrationError {
    /// The stored `user_version` is NEWER than this build understands.
    ///
    /// Migrations are forward-only, so there is nothing to do but stop. This is
    /// reachable through ordinary use, not just prereleases: reinstalling a
    /// previous version after a bad release, two machines sharing a data
    /// directory, or restoring a machine from backup while the data directory
    /// is newer than the restored app.
    FromTheFuture {
        found: i32,
        supported: i32,
        /// Most recent pre-upgrade backup beside this database, if one exists.
        ///
        /// Forward-only migrations make "restore the .bak" the documented way
        /// back, so a user told to do that has to be able to find the file.
        /// A future-version database never migrates and so never makes its own
        /// backup -- but an EARLIER upgrade on this machine usually did.
        backup: Option<String>,
    },
    /// The pre-migration backup could not be written. Forward-only migrations
    /// make that backup the ONLY recovery path, so proceeding without it would
    /// destroy the fallback exactly when it is most needed.
    BackupFailed { path: String, source: String },
    /// A migration step failed. The version is deliberately NOT bumped, so the
    /// next launch retries rather than running against a schema that does not
    /// match what the code expects.
    StepFailed { version: i32, source: String },
}

impl std::fmt::Display for MigrationError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MigrationError::FromTheFuture {
                found,
                supported,
                backup,
            } => {
                write!(
                    f,
                    "This data was created by a newer version of Bearpaw (schema v{found}; \
                     this build supports v{supported}). Install a newer Bearpaw to use it, \
                     or move your data directory aside to start fresh."
                )?;
                if let Some(path) = backup {
                    write!(f, " A pre-upgrade backup exists at {path}.")?;
                }
                Ok(())
            }
            MigrationError::BackupFailed { path, source } => write!(
                f,
                "Could not write the pre-upgrade database backup to {path} ({source}). \
                 Bearpaw stopped rather than upgrading without a way back."
            ),
            MigrationError::StepFailed { version, source } => write!(
                f,
                "Database upgrade to v{version} failed ({source}). Your data was left \
                 as it was and the upgrade will be retried next launch."
            ),
        }
    }
}

/// Copy the database aside before migrating.
///
/// Forward-only migrations (see #418) make this backup the only recovery path,
/// so a failure here ABORTS the migration -- it used to be `let _ =`, which
/// discarded the fallback precisely when it mattered. Returns the backup path
/// so a failure message can name it.
///
/// Nothing in Bearpaw deletes these files. Pruning them to reclaim disk would
/// remove the documented way back from an upgrade.
///
/// REGRESSION GUARD (`the_backup_includes_uncheckpointed_wal_data`): this is
/// `VACUUM INTO`, run through SQLite, NOT `std::fs::copy` (#574).
///
/// `open_sqlite` sets `journal_mode = WAL`, so a committed transaction lives in
/// the `-wal` sidecar until something checkpoints it. Copying the main file
/// alone silently dropped every uncommitted-to-main frame -- and restoring such
/// a backup over a database whose newer `-wal` still sat beside it produced a
/// MISMATCHED PAIR rather than the old database. The 30-second channel-cache
/// flush makes the at-risk volume much larger than when this was written.
///
/// `VACUUM INTO` is consistent by construction: SQLite reads through its own
/// MVCC snapshot, so the WAL is included without anyone having to get a
/// checkpoint ordering right. It also emits ONE self-contained file, which
/// matters because the recovery instruction is "put this file back" -- a
/// backup that needed its own sidecars to be complete would recreate the
/// mismatched-pair problem at restore time.
///
/// Preserving `user_version` is load-bearing, not incidental: the version is
/// what tells the pre-migration build which schema it is looking at, and a
/// backup that lost it would make that build re-run every migration. The guard
/// asserts it.
///
/// Takes the live connection rather than reopening `path`: a second connection
/// would see the same WAL but adds a failure mode for nothing, and the caller
/// (`migrate_preferences_db`) already holds one.
fn backup_db_if_needed(
    conn: &rusqlite::Connection,
    path: &str,
    label: &str,
    from_version: i32,
    target_version: i32,
) -> Result<Option<PathBuf>, MigrationError> {
    if from_version >= target_version {
        return Ok(None);
    }
    let source = PathBuf::from(path);
    if !source.exists() {
        return Ok(None);
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
    conn.execute("VACUUM INTO ?1", [backup_path.to_string_lossy().as_ref()])
        .map_err(|e| MigrationError::BackupFailed {
            path: backup_path.display().to_string(),
            source: e.to_string(),
        })?;
    Ok(Some(backup_path))
}

fn schema_version(conn: &rusqlite::Connection) -> i32 {
    conn.pragma_query_value(None, "user_version", |row| row.get::<usize, i32>(0))
        .unwrap_or(0)
}

/// REGRESSION GUARD: `a_failed_step_leaves_the_version_unchanged`,
/// `a_partly_failing_step_rolls_back_entirely`. See the third-rail table in
/// CLAUDE.md.
///
/// Run one migration step inside a transaction, bumping `user_version` only if
/// every statement succeeded.
///
/// The version bump lives INSIDE the transaction on purpose. It used to run
/// unconditionally after a `let _ = conn.execute(...)`, so a failed step still
/// marked the database migrated -- the next launch read the new version, skipped
/// the migration, and queried a schema that did not exist. See #418.
fn run_migration_step(
    conn: &rusqlite::Connection,
    version: i32,
    sql: &str,
) -> Result<(), MigrationError> {
    let fail = |e: rusqlite::Error| MigrationError::StepFailed {
        version,
        source: e.to_string(),
    };
    conn.execute_batch("BEGIN").map_err(fail)?;
    let result = conn
        .execute_batch(sql)
        .and_then(|()| conn.pragma_update(None, "user_version", version));
    match result {
        Ok(()) => conn.execute_batch("COMMIT").map_err(fail),
        Err(e) => {
            // Roll back before reporting: leaving the transaction open would
            // hold a write lock for the life of the connection.
            let _ = conn.execute_batch("ROLLBACK");
            Err(fail(e))
        }
    }
}

/// Refuse to run against a database from a newer Bearpaw.
///
/// Migrations are forward-only, so there is no down path -- and running old
/// code against a newer schema is silent misbehaviour rather than a clean stop.
fn check_not_from_the_future(
    path: &str,
    current: i32,
    supported: i32,
) -> Result<(), MigrationError> {
    if current > supported {
        return Err(MigrationError::FromTheFuture {
            found: current,
            supported,
            backup: newest_backup_for(path),
        });
    }
    Ok(())
}

/// Most recently modified `*.bak` sitting beside `path`, if any.
///
/// Best-effort and deliberately quiet: this only enriches an error message, so
/// an unreadable directory just means no path is named.
fn newest_backup_for(path: &str) -> Option<String> {
    let db = PathBuf::from(path);
    let dir = db.parent()?;
    let stem = db.file_name()?.to_str()?;
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name();
        let name = name.to_str().unwrap_or_default();
        if !name.starts_with(stem) || !name.ends_with(".bak") {
            continue;
        }
        let modified = entry.metadata().ok().and_then(|m| m.modified().ok());
        if let Some(modified) = modified {
            if best.as_ref().is_none_or(|(t, _)| modified > *t) {
                best = Some((modified, entry.path()));
            }
        }
    }
    best.map(|(_, p)| p.display().to_string())
}

fn migrate_preferences_db(path: &str, conn: &rusqlite::Connection) -> Result<(), MigrationError> {
    let current = schema_version(conn);
    check_not_from_the_future(path, current, PREFERENCES_SCHEMA_VERSION)?;
    if current > 0 || has_user_tables(conn) {
        backup_db_if_needed(
            conn,
            path,
            "preferences",
            current,
            PREFERENCES_SCHEMA_VERSION,
        )?;
    }
    if current < 1 {
        run_migration_step(
            conn,
            1,
            "CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL);",
        )?;
    }
    if current < 2 {
        run_migration_step(
            conn,
            2,
            "
            CREATE TABLE IF NOT EXISTS channel_memory (
                scanner_id       TEXT NOT NULL,
                channel_index    INTEGER NOT NULL,
                frequency        REAL NOT NULL,
                modulation       TEXT NOT NULL DEFAULT '',
                alpha_tag        TEXT NOT NULL DEFAULT '',
                delay            INTEGER NOT NULL,
                lockout          INTEGER NOT NULL,
                priority         INTEGER NOT NULL,
                tone_kind        TEXT NOT NULL DEFAULT 'none',
                tone_squelch_hz  REAL,
                tone_dcs_code    INTEGER,
                synced_at        REAL NOT NULL,
                PRIMARY KEY (scanner_id, channel_index)
            );
            ",
        )?;
    }
    if current < 3 {
        // #414: one row per physical scanner Bearpaw has seen.
        //
        // `scanner_id` is a generated key, NOT a discriminator. Recognition has
        // to come from what the hardware volunteers, and a generated id would
        // have to live either on the scanner (whose only writable storage is
        // channel memory, wiped by a factory reset) or on the host (circular --
        // the lookup key would be the thing we lack). So `match_index` does the
        // recognising and `scanner_id` is a stable internal key, which means
        // renaming a scanner or adding a better signal later does not rewrite
        // every foreign key.
        //
        // ACCEPTED LIMITATION: two units of the SAME model share one profile.
        // A BC125AT reports usb_serial `0001` for every unit -- it is a firmware
        // constant, not a per-unit id (measured on hardware 2026-08-26). Only
        // the BC75XLT has a real serial, and only because its CP2104 bridge is
        // programmed per-unit by Silicon Labs. Correct and permanent for one
        // BC125AT plus one BC75XLT; detectable and fixable if a second
        // same-model unit ever appears, because the real key is a UUID.
        run_migration_step(
            conn,
            3,
            "
            CREATE TABLE IF NOT EXISTS scanners (
                scanner_id   TEXT PRIMARY KEY,
                match_index  TEXT NOT NULL UNIQUE,
                model        TEXT NOT NULL,
                usb_serial   TEXT,
                display_name TEXT,
                first_seen   REAL NOT NULL,
                last_seen    REAL NOT NULL
            );
            ",
        )?;
    }
    Ok(())
}

fn migrate_analytics_db(path: &str, conn: &rusqlite::Connection) -> Result<(), MigrationError> {
    let current = schema_version(conn);
    check_not_from_the_future(path, current, ANALYTICS_SCHEMA_VERSION)?;
    if current > 0 || has_user_tables(conn) {
        backup_db_if_needed(conn, path, "analytics", current, ANALYTICS_SCHEMA_VERSION)?;
    }
    if current < 1 {
        run_migration_step(
            conn,
            1,
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
        )?;
    }
    if current < 2 {
        // Attribute each hit to the scanner that heard it. Without this, two
        // radios' activity pools into one table and `analytics_busiest` groups
        // by (frequency, channel) across both -- but a channel number means
        // something different on each radio, so the same frequency splits into
        // two rows when the two hold it in different slots, and two different
        // channels merge when slot numbers happen to coincide.
        //
        // Existing rows are left NULL rather than guessed. The tempting
        // heuristic -- "it has an alpha tag, so it came from an alpha-tag
        // scanner" -- is true but not specific enough to be useful: it
        // identifies the FAMILY, and writing "BC125AT" would mislabel the four
        // other members (BCT125AT, UBC125XLT, UBC126AT, AE125H). Their owners
        // would then connect a UBC125XLT, fail to match "BC125AT", and watch
        // their whole history vanish from scoped views. NULL means "recorded
        // before Bearpaw tracked this", which is exactly what is known.
        run_migration_step(
            conn,
            2,
            "
            ALTER TABLE scan_hits ADD COLUMN scanner_id TEXT;
            CREATE INDEX IF NOT EXISTS idx_hits_scanner ON scan_hits(scanner_id);
            ",
        )?;
    }
    Ok(())
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

pub(crate) async fn read_frequency_lockouts_walk(state: &AppState) -> Result<Vec<u32>, ApiError> {
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
    let caps = state.capabilities();
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
        // Skipped entirely when the scanner has no such command. A BC75XLT
        // replies ERR to BLT/BSV/CNT/WXS, so sending them meant four
        // guaranteed-failing round-trips and four logged errors on EVERY
        // GET /settings -- which the Device tab issues on every visit. The
        // field is Null either way; this just stops asking. See #432.
        let backlight = if !caps.has_backlight_control {
            Value::Null
        } else {
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
        let battery = if !caps.has_battery_save {
            Value::Null
        } else {
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
        // `get_config` does not open a program-mode bracket, and on a scanner
        // where KBP is program-mode-only the reply is `KBP,NG` -- "invalid at
        // this time". The read cannot succeed here, so skip it rather than
        // burn a round-trip on a guaranteed failure. The dedicated
        // `get_key_beep` endpoint DOES bracket and still works.
        //
        // Deliberately not solved by bracketing the whole snapshot: PRG parks
        // the scanner in HOLD at ch1 (see the "Leaving the Device page resumes
        // scan" third rail), and this runs on every Device tab visit for every
        // model.
        let key_beep = if caps.key_beep_needs_program_mode {
            Value::Null
        } else {
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
                Some(flags) if flags.len() >= 10 && flags.chars().all(|c| c == '0' || c == '1') => {
                    let groups = flags
                        .chars()
                        .take(10)
                        .map(|c| c == '0')
                        .collect::<Vec<bool>>();
                    json!({ "groups": groups })
                }
                _ => Value::Null,
            }
        }
        // `SSG` is absent from the BC75XLT's command table -- that model has
        // service search but no way to enable or disable a band remotely. Skip
        // the read rather than burn a guaranteed-ERR round-trip inside the
        // bracket, the same reasoning as the `KBP` skip above. This runs on
        // every Device tab visit.
        let service_search = if !caps.has_service_search_groups {
            Value::Null
        } else {
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
        let weather = if !caps.has_weather_alert {
            Value::Null
        } else {
            let resp = send_raw_command(state, "WXS", false).await?;
            let parts = parse_command_parts(&resp, "WXS");
            match usable(&resp).then(|| parts.first().cloned()).flatten() {
                Some(v) if v == "0" || v == "1" => json!({ "priority": v == "1" }),
                _ => Value::Null,
            }
        };
        let contrast = if !caps.has_contrast {
            Value::Null
        } else {
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
/// Build a `CIN` write payload for a scanner with the given capabilities.
///
/// The BC75XLT keeps the BC125AT's field POSITIONS and marks three of them
/// `[RSV]` (reserved) — per the vendor spec its set form is
/// `CIN,[INDEX],[RSV],[FRQ],[RSV],[RSV],[DLY],[LOUT],[PRI]`. Writing a
/// 16-space tag, `AUTO`, and a tone code into reserved fields is not merely
/// pointless: the spec says *"The set command is aborted if any format error
/// is detected"*, so one rejected field silently discards the frequency,
/// lockout, and priority in the same command.
///
/// Empty is the correct value there — *"In set command, only `,` parameters
/// are not changed"* — so an empty field means "leave alone", which is exactly
/// what a reserved field wants.
pub(crate) fn build_cin_write_payload_for(
    channel: &ChannelData,
    caps: &ScannerCapabilities,
) -> Result<String, ApiError> {
    // Delay is a genuinely different quantity between families, not a wider
    // and narrower range of one. The BC125AT takes signed seconds
    // (negatives are pre-delays); the BC75XLT takes a boolean. Sending 2 to a
    // BC75XLT aborts the whole write. See #402.
    if !caps.accepts_delay(channel.delay) {
        return Err(ApiError::BadRequest("delay_out_of_range".to_string()));
    }

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

    // Reserved fields go out empty. See the note on this function.
    let alpha_field = if caps.has_alpha_tags {
        alpha_tag.as_str()
    } else {
        ""
    };
    let mod_field = if caps.has_per_channel_modulation {
        modulation.as_str()
    } else {
        ""
    };
    let tone_field = if caps.has_tone_squelch {
        tone_code.to_string()
    } else {
        String::new()
    };

    Ok(format!(
        "{},{},{},{},{},{},{}",
        alpha_field,
        freq,
        mod_field,
        tone_field,
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
    let payload = build_cin_write_payload_for(channel, &state.capabilities())?;
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
fn readback_matches(
    wrote: &ChannelData,
    readback: &ChannelData,
    wrote_alpha: &str,
    caps: &ScannerCapabilities,
) -> bool {
    if wrote.frequency.abs() < 0.00005 {
        // A cleared slot must match the factory-empty signature EXCEPT for a
        // priority bit the firmware would not let us clear.
        //
        // REGRESSION GUARD (`clearing_a_priority_channel_is_not_a_failure`):
        // the firmware refuses an in-place priority 1->0 CIN write -- see
        // `clear_channel_priority`, which exists because DCH+rewrite is the
        // only mechanism. So clearing a channel that IS the bank's priority
        // channel writes priority=1, reads back priority=1, and used to fail
        // `is_factory_empty`'s `!priority` term: a 400 `channel_not_persisted`
        // AFTER the write had already landed, with the shadow-cache update
        // skipped so the backend's view went stale too. Observed on hardware
        // 2026-08-27 clearing channel 271 -- the wrote and read_back strings
        // in the warning were byte-identical.
        //
        // The non-clear path below already carries exactly this tolerance
        // (`priority_ok`). This branch short-circuited before reaching it.
        // `is_factory_empty` itself stays strict: it describes what the
        // scanner stamps on a slot, and `clear_channel_priority` depends on
        // that strictness to detect a stuck priority bit.
        let stuck_priority = wrote.priority && readback.priority;
        return is_factory_empty(readback, caps)
            || (stuck_priority && is_factory_empty_ignoring_priority(readback, caps));
    }
    let priority_ok = readback.priority == wrote.priority || (!wrote.priority && readback.priority); // refused clear — see guard above
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

/// Strict persisted-check for `clear_channel_priority`. `readback_matches`
/// carries a deliberate tolerance (PR #198) that treats a refused in-place
/// priority downgrade (wrote 0, read back 1) as a match — correct for the
/// plain CIN write path, where that refusal is expected and priority isn't
/// the thing being verified. `clear_channel_priority`'s entire purpose is to
/// force priority to 0 via DCH+rewrite, so that tolerance must not apply
/// here: a stuck priority bit is exactly the failure this function exists to
/// catch, and `readback_matches` alone would silently report it as success.
fn priority_clear_persisted(
    rewritten: &ChannelData,
    readback: &ChannelData,
    wrote_alpha: &str,
    caps: &ScannerCapabilities,
) -> bool {
    readback_matches(rewritten, readback, wrote_alpha, caps) && !readback.priority
}

/// The fixed tail the scanner stamps on any channel with no frequency:
/// delay=2, lockout=1, priority=0, no tone (`...,00000000,AUTO,0,2,1,0`). See
/// `readback_matches` for the capture citations. Only the tail is checked: the
/// alpha and modulation slots of an empty channel read back as "AUTO" on this
/// firmware (parse_cin_response fills alpha_tag="AUTO", modulation="AUTO"), but
/// those aren't part of the forced-empty invariant — what matters is that the
/// scanner ignored the delay/lockout/priority we sent and forced these values.
fn is_factory_empty(ch: &ChannelData, caps: &ScannerCapabilities) -> bool {
    is_factory_empty_ignoring_priority(ch, caps) && !ch.priority
}

/// `is_factory_empty` without the priority term.
///
/// Split out for the one caller that must tolerate a priority bit the
/// firmware refused to clear (see `readback_matches`). Everything else --
/// including `clear_channel_priority`, whose whole purpose is to force
/// priority to 0 -- keeps the strict predicate.
fn is_factory_empty_ignoring_priority(ch: &ChannelData, caps: &ScannerCapabilities) -> bool {
    ch.frequency.abs() < 0.00005
        // Model-dependent: the BC125AT family reports 2 for a cleared slot, a
        // BC75XLT reports 0 (`CIN,299 -> CIN,299,,00000000,,,0,1,0`, hardware
        // 2026-08-26). Hardcoding 2 made this predicate un-satisfiable on a
        // BC75XLT, so `readback_matches` failed every zero-frequency write --
        // returning 400 `channel_not_persisted` AFTER the write had already
        // succeeded on the wire, and skipping the shadow-cache update so the
        // backend's view went stale too. That hit not just an explicit clear
        // but any bulk upload or reorder whose write-set included an empty
        // slot. See #402 and the third-rail note on `buildEmptyDraft`.
        && ch.delay == caps.cleared_delay
        && ch.lockout
        && ch.tone_squelch_kind == crate::state::ToneSquelchKind::None
}

/// The index of the bank's current priority channel, if any. A bank holds
/// 0 or 1 priority channel (one-per-bank). `bank` is 1..=10.
fn bank_priority_index(
    channels: &std::collections::HashMap<u16, ChannelData>,
    bank: u8,
    caps: &ScannerCapabilities,
) -> Option<u16> {
    channels
        .values()
        .filter(|c| c.priority && caps.index_to_bank(c.index) == bank)
        .map(|c| c.index)
        .min()
}

/// Decide the swap: which channel (if any) must be cleared, and which is set.
/// Returns (old_to_clear, new_to_set). old is Some only when a DIFFERENT
/// channel in the same bank currently holds priority.
fn plan_priority_swap(
    channels: &std::collections::HashMap<u16, ChannelData>,
    index: u16,
    caps: &ScannerCapabilities,
) -> (Option<u16>, u16) {
    // Bank width is model-dependent. With the BC125AT's fixed /50 this
    // collapsed a BC75XLT's 300 channels into six 50-wide windows straddling
    // the real 30-channel boundaries -- so setting priority on CH31 (real bank
    // 2) would look up the holder of window 1-50 and clear CH5, a channel in a
    // DIFFERENT bank that the user never touched. That clear is a destructive
    // DCH-plus-rewrite (see the DATA-LOSS SAFETY note below), and the real
    // bank-2 conflict was never planned for at all.
    //
    // The frontend already derived this correctly via `deriveBankFromIndex`
    // (#401), so the confirmation dialog named the right channel while the
    // backend modified a different one.
    let bank = caps.index_to_bank(index);
    let old = bank_priority_index(channels, bank, caps).filter(|&old| old != index);
    (old, index)
}

pub(crate) async fn write_channel_to_scanner(
    state: &AppState,
    channel: &ChannelData,
) -> Result<ChannelData, ApiError> {
    let payload = build_cin_write_payload_for(channel, &state.capabilities())?;

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
    let persisted = readback_matches(channel, &readback, &wrote_alpha, &state.capabilities());
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
    clear_channel_priority_locked(state, index).await
}

/// Body of `clear_channel_priority`, assuming the caller already holds a
/// `ProgramModeGuard`. Does NOT enter one itself — used by `set_channel_priority`
/// so the clear-old + set-new swap runs inside a single bracket instead of two.
async fn clear_channel_priority_locked(
    state: &AppState,
    index: u16,
) -> Result<ChannelData, ApiError> {
    // 1. Read the full channel first. Never DCH an unread channel.
    let current = read_channel_from_scanner(state, index).await?;

    // 2. No-op if nothing to clear.
    //
    // REGRESSION GUARD (`a_no_op_priority_clear_heals_a_stale_shadow`): store
    // the read even though nothing is being changed. Reaching here means the
    // radio says this channel does NOT hold priority -- which is exactly the
    // state a stale shadow produces, because a plain `CIN` write can set
    // priority and displace the bank's previous holder without naming it (the
    // #198 guard above). The read is already paid for, and since #413 a stale
    // flag is no longer cleared by the next launch's sync: it is flushed to
    // SQLite and re-adopted at every connect. Storing it here is what makes
    // this path self-healing rather than a permanent disagreement.
    if !needs_priority_clear(&current) {
        state
            .shadow
            .write()
            .unwrap()
            .channels
            .insert(index, current.clone());
        return Ok(current);
    }

    // 3. Build the rewrite payload (same fields, priority off) BEFORE deleting,
    //    so a payload-build error can't strand us post-DCH.
    let mut rewritten = current.clone();
    rewritten.priority = false;
    let payload = build_cin_write_payload_for(&rewritten, &state.capabilities())?;

    // 4. DCH — wipe to factory-empty.
    match classify_response(&send_raw_command(state, &format!("DCH,{index}"), false).await?) {
        ScannerReply::Ok => {}
        _ => {
            return Err(ApiError::BadRequest(
                "priority_clear_dch_failed".to_string(),
            ))
        }
    }

    // 5. Rewrite with priority=0.
    let write_cmd = format!("CIN,{index},{payload}");
    match classify_response(&send_raw_command(state, &write_cmd, false).await?) {
        ScannerReply::Ok => {}
        _ => {
            return Err(ApiError::BadRequest(
                "priority_clear_rewrite_failed".to_string(),
            ))
        }
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
    if !priority_clear_persisted(&rewritten, &readback, &wrote_alpha, &state.capabilities()) {
        warn!(
            index = index,
            wrote = %write_cmd,
            read_back = %read_response.trim(),
            "priority clear rewrite not persisted as sent"
        );
        return Err(ApiError::BadRequest(
            "priority_clear_not_persisted".to_string(),
        ));
    }
    // REGRESSION GUARD (`a_priority_clear_updates_the_shadow`): store the
    // verified readback. `set_channel_priority` inserts into the shadow at
    // every step of a swap; this function returned the same class of value and
    // dropped it, so the cache kept showing a priority flag the radio had just
    // wiped. Under #413 that survives a restart instead of dying with the
    // session.
    state
        .shadow
        .write()
        .unwrap()
        .channels
        .insert(index, readback.clone());
    Ok(readback)
}

/// Set `index` as its bank's priority channel, enforcing one-per-bank.
/// Clears the bank's current priority channel first (if a different one
/// exists), then sets `index`. Atomic: if the clear fails, `index` is NOT
/// set. Returns every channel changed (cleared-old first, then the new one).
pub(crate) async fn set_channel_priority(
    state: &AppState,
    index: u16,
) -> Result<Vec<ChannelData>, ApiError> {
    let caps = state.capabilities();
    let (old_to_clear, new_to_set) = {
        let shadow = state.shadow.read().unwrap();
        plan_priority_swap(&shadow.channels, index, &caps)
    };

    let _guard = ProgramModeGuard::enter(state).await?; // ONE bracket for the whole swap
    let mut changed = Vec::new();

    // REGRESSION GUARD (priority swap atomicity): on a model where Bearpaw
    // clears, clear the OLD priority channel BEFORE setting the new one, inside
    // a SINGLE program-mode bracket, and propagate the clear's error with `?` so
    // a failed clear ABORTS the swap. Setting first, ignoring the clear error, or
    // dropping/re-entering the guard between clear and set can leave a bank with
    // two priority channels, a DCH-deleted channel, or an interleaved command
    // mid-swap. See the priority spec.
    //
    // `has_priority_clear` is false where the RADIO owns the swap. A BC75XLT has
    // no `DCH` and refuses an in-place clear, but moves the flag within a bank
    // itself -- measured in both directions on hardware 2026-08-28, see
    // docs/wire_captures/2026-08-28/findings.md §8. Running the clear there was
    // not merely unnecessary, it was the one step that could not work: every
    // swap failed with `priority_clear_dch_failed` (#479).
    if let Some(old) = old_to_clear {
        if caps.has_priority_clear {
            let cleared = clear_channel_priority_locked(state, old).await?; // locked: no inner guard
            state
                .shadow
                .write()
                .unwrap()
                .channels
                .insert(old, cleared.clone());
            changed.push(cleared);
        }
        // Otherwise the old channel is cleared by the SET below, as a side
        // effect. It is re-read after that write, not before -- reading first
        // reports a state the next command undoes.
    }

    // Set the new priority channel with a plain CIN write (SET works in place).
    let current = read_channel_from_scanner(state, new_to_set).await?;
    if current.frequency.abs() < 0.00005 {
        return Err(ApiError::BadRequest(
            "priority_set_empty_channel".to_string(),
        ));
    }
    let mut wrote = current.clone();
    wrote.priority = true;
    let payload = build_cin_write_payload_for(&wrote, &state.capabilities())?;
    let write_cmd = format!("CIN,{new_to_set},{payload}");
    match classify_response(&send_raw_command(state, &write_cmd, false).await?) {
        ScannerReply::Ok => {}
        _ => return Err(ApiError::BadRequest("priority_set_failed".to_string())),
    }
    let read_response = send_raw_command(state, &format!("CIN,{new_to_set}"), false).await?;
    let readback = parse_cin_response(new_to_set, &read_response)
        .ok_or_else(|| ApiError::BadRequest("priority_set_readback_failed".to_string()))?;
    if !readback.priority {
        return Err(ApiError::BadRequest(
            "priority_set_not_persisted".to_string(),
        ));
    }
    state
        .shadow
        .write()
        .unwrap()
        .channels
        .insert(new_to_set, readback.clone());
    changed.push(readback);

    // Where the firmware owns the swap, the old channel dropped its flag as a
    // side effect of the write above. Re-read it: without this the shadow cache
    // -- and so the UI -- keeps showing a priority channel the radio has already
    // cleared, which is the same stale-view failure #402 produced by a different
    // route.
    //
    // REGRESSION GUARD (priority swap atomicity): this read is INFORMATIONAL and
    // its error must not propagate. See
    // `priority_swap_survives_a_failed_post_set_reread`. The write above
    // has already been sent and verified by readback, so the swap is committed
    // before this line runs -- a `?` here reports a failure for a change the
    // scanner has made, on the one model whose bridge is documented to `ERR` a
    // first command (CLAUDE.md backend pitfall #11). The clear-before-set read
    // higher up is the opposite case and DOES propagate: nothing is committed
    // yet there, so failing aborts the swap as the atomicity contract requires.
    if let Some(old) = old_to_clear {
        if !caps.has_priority_clear {
            match read_channel_from_scanner(state, old).await {
                Ok(cleared) => {
                    if cleared.priority {
                        // Contradicts the 2026-08-28 measurement. Report the truth
                        // rather than a tidy fiction: the requested channel DID get
                        // priority, so this is not a failed request, but the bank now
                        // holds two and nothing here can fix that.
                        tracing::warn!(
                            old,
                            new = new_to_set,
                            "firmware did not clear the previous priority channel; bank now holds two"
                        );
                    }
                    state
                        .shadow
                        .write()
                        .unwrap()
                        .channels
                        .insert(old, cleared.clone());
                    // Contract: cleared-old first, then the new one.
                    changed.insert(0, cleared);
                }
                Err(err) => {
                    // Same principle as the branch above, one step further: we
                    // cannot even observe the old channel. Leave its cache entry
                    // alone and omit it from `changed` rather than writing a
                    // cleared state the scanner never confirmed. The entry stays
                    // stale until the next refresh, which is a visible and
                    // recoverable view -- unlike a fabricated one.
                    tracing::warn!(
                        old,
                        new = new_to_set,
                        ?err,
                        "could not re-read the previous priority channel after the swap; \
                         its cached state may be stale until the next refresh"
                    );
                }
            }
        }
    }
    Ok(changed)
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
    let payload = match build_cin_write_payload_for(&updated, &state.capabilities()) {
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
    use crate::protocol::capabilities::BC125AT_FAMILY;
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

    // ---------------------------------------------------------------------
    // Fake scanner (#249)
    //
    // There is no `Transport` trait to mock: `send_raw_command` reaches the
    // hardware by pushing `ControlCommand::Raw` down the `command_tx` mpsc
    // channel, and the poll loop (which owns the serial/USB handle) answers on
    // the enclosed `reply` channel. So the injection seam is that channel —
    // a fake scanner is just a thread draining `command_rx`.
    //
    // This is a better seam than a transport trait would be: it intercepts
    // whole wire commands and returns whole wire responses, which is exactly
    // the granularity the atomicity contract is written in ("a failed DCH must
    // abort the swap"). It also needs no production code change.
    //
    // `fail_on` injects "connects fine, but this round-trip fails" — the
    // failure mode the priority-swap abort path is built to survive.
    struct FakeScanner {
        /// Every command the fake received, in order. The atomicity assertion
        /// is about ORDER (clear before set) and ABSENCE (no set after a
        /// failed clear), so the transcript is the thing under test.
        transcript: Arc<Mutex<Vec<String>>>,
        _thread: std::thread::JoinHandle<()>,
    }

    impl FakeScanner {
        /// Attach a fake scanner to `state`. `responder` maps a wire command to
        /// the reply the scanner would send; returning `Err` simulates a failed
        /// round-trip (the poll loop's error path), NOT a disconnect.
        fn attach<F>(state: &AppState, responder: F) -> Self
        where
            F: Fn(&str) -> Result<String, String> + Send + 'static,
        {
            let (tx, rx) = std::sync::mpsc::channel::<ControlCommand>();
            *state.command_tx.lock().unwrap() = Some(tx);
            let transcript = Arc::new(Mutex::new(Vec::new()));
            let recorded = transcript.clone();

            let thread = std::thread::spawn(move || {
                while let Ok(cmd) = rx.recv() {
                    // `Raw` carries its command string directly. The typed
                    // variants don't: the poll loop is what turns
                    // `ControlCommand::Hold` into the `KEY_HOLD` wire bytes, and
                    // the loop owns the serial handle so it can't run here. We
                    // record the same constant the loop would send, which keeps
                    // the transcript in wire terms for every command path.
                    match cmd {
                        ControlCommand::Raw { command, reply, .. } => {
                            recorded.lock().unwrap().push(command.clone());
                            // Ignore send errors: `send_raw_command` gives up
                            // after 3 s and drops the receiver, which is a
                            // legitimate (if slow) outcome rather than a
                            // fake-scanner bug.
                            let _ = reply.send(responder(&command));
                        }
                        ControlCommand::Hold { reply, .. } => {
                            recorded
                                .lock()
                                .unwrap()
                                .push(super::poll::KEY_HOLD.to_string());
                            if let Some(r) = reply {
                                let _ = r.send(responder(super::poll::KEY_HOLD));
                            }
                        }
                        ControlCommand::Scan { reply, .. } => {
                            recorded
                                .lock()
                                .unwrap()
                                .push(super::poll::KEY_SCAN.to_string());
                            if let Some(r) = reply {
                                let _ = r.send(responder(super::poll::KEY_SCAN));
                            }
                        }
                        _ => {}
                    }
                }
            });

            FakeScanner {
                transcript,
                _thread: thread,
            }
        }

        fn transcript(&self) -> Vec<String> {
            self.transcript.lock().unwrap().clone()
        }

        /// The transcript, with the program-mode bracket guaranteed complete.
        ///
        /// `PRG` is sent through `send_raw_command`, which awaits its reply, so
        /// it is always recorded by the time a response returns. `EPG` is not:
        /// `ProgramModeGuard::drop` fires it down the command channel without
        /// awaiting, because Drop cannot await. Reading the transcript the
        /// instant the response returns therefore races the fake scanner's
        /// thread -- invisible on a fast idle machine, an unreproducible
        /// failure on a loaded CI runner.
        ///
        /// Waits only when a bracket was actually opened. Commands valid in any
        /// mode (`VOL`, `SQL`) never open one, so waiting for their EPG would
        /// burn the whole timeout on every such test.
        fn transcript_with_closed_bracket(&self) -> Vec<String> {
            let t = self.transcript();
            if !t.iter().any(|c| c == "PRG") {
                return t;
            }
            self.transcript_once_seen("EPG")
        }

        /// The transcript, once `command` appears in it.
        ///
        /// `EPG` is sent fire-and-forget from `ProgramModeGuard::drop` -- it
        /// goes down the command channel without awaiting a reply, by design,
        /// because Drop cannot await. So a test that reads the transcript the
        /// instant the HTTP response returns is racing the fake scanner's
        /// thread. That race is invisible on a fast idle machine and shows up
        /// on a loaded CI runner as an unreproducible failure, which is the
        /// worst shape a test failure can take.
        ///
        /// Waits rather than sleeping a fixed amount: the assertion is "EPG
        /// eventually arrives", so the test should express exactly that.
        fn transcript_once_seen(&self, command: &str) -> Vec<String> {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                let t = self.transcript();
                if t.iter().any(|c| c == command) || std::time::Instant::now() > deadline {
                    return t;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        }

        /// Commands the fake saw, keeping only those starting with `prefix`.
        fn commands_starting_with(&self, prefix: &str) -> Vec<String> {
            self.transcript()
                .into_iter()
                .filter(|c| c.starts_with(prefix))
                .collect()
        }
    }

    /// A scanner that answers every command successfully, except those matching
    /// `fail_on`, which come back `ERR` — the "connects fine, but this
    /// round-trip fails" case from #249.
    ///
    /// CIN reads are answered in the field order verified against hardware
    /// (docs/wire_captures/2026-07-08): tag, freq, mod, tone, delay, lockout,
    /// priority. `priority_of` decides the priority bit per channel index so a
    /// test can describe the bank's starting state.
    fn scanner_responder(
        fail_on: Option<&'static str>,
        priority_of: fn(u16) -> bool,
    ) -> impl Fn(&str) -> Result<String, String> + Send + 'static {
        move |command: &str| {
            if let Some(pattern) = fail_on {
                if command.starts_with(pattern) {
                    return Ok("ERR\r".to_string());
                }
            }
            if command == "PRG" {
                return Ok("PRG,OK\r".to_string());
            }
            if command == "EPG" {
                return Ok("EPG,OK\r".to_string());
            }
            // A bare `CIN,<idx>` is a READ; `CIN,<idx>,<payload>` is a WRITE.
            if let Some(rest) = command.strip_prefix("CIN,") {
                let mut fields = rest.splitn(2, ',');
                let index: u16 = fields.next().unwrap_or("").parse().unwrap_or(0);
                match fields.next() {
                    // Write: ack it, and echo the written priority bit back on
                    // the following read so read-back-verify passes.
                    Some(payload) => {
                        let wrote_priority = payload.rsplit(',').next() == Some("1");
                        WROTE_PRIORITY.with(|w| {
                            w.borrow_mut().insert(index, wrote_priority);
                        });
                        return Ok("CIN,OK\r".to_string());
                    }
                    None => {
                        let priority = WROTE_PRIORITY
                            .with(|w| w.borrow().get(&index).copied())
                            .unwrap_or_else(|| priority_of(index));
                        return Ok(format!(
                            "CIN,{index},Test Chan,01451300,FM,0,2,0,{}\r",
                            if priority { 1 } else { 0 }
                        ));
                    }
                }
            }
            if command.starts_with("DCH,") {
                return Ok("DCH,OK\r".to_string());
            }
            Ok("OK\r".to_string())
        }
    }

    thread_local! {
        /// Per-channel priority bit as last WRITTEN by the fake, so a
        /// write→read-back round-trip is self-consistent. Thread-local because
        /// the fake scanner runs on its own thread, one per test.
        static WROTE_PRIORITY: std::cell::RefCell<HashMap<u16, bool>> =
            std::cell::RefCell::new(HashMap::new());
    }

    // REGRESSION GUARD (#132): CIN write order is name, freq, mod, tone,
    // delay, lockout, priority — verified against hardware 2026-07-08
    // (docs/wire_captures/2026-07-08/cin-write-order-probe.txt). The old
    // has_tone heuristic emitted lockout/delay/priority/bank for tone=0
    // channels, putting bank in the scanner's priority field.
    #[test]
    fn cin_payload_uses_verified_field_order_for_tone_0() {
        let payload =
            build_cin_write_payload_for(&test_channel(), &ScannerCapabilities::default()).unwrap();
        assert_eq!(payload, "Test Chan,01451300,FM,0,2,0,1");
    }

    #[test]
    fn cin_payload_encodes_ctcss_as_wire_code_not_hz() {
        let mut ch = test_channel();
        ch.tone_squelch_kind = crate::state::ToneSquelchKind::Ctcss;
        ch.tone_squelch = Some(100.0);
        let payload = build_cin_write_payload_for(&ch, &ScannerCapabilities::default()).unwrap();
        // 100.0 Hz is wire code 76. Writing "100" would be 189.9 Hz.
        assert_eq!(payload, "Test Chan,01451300,FM,76,2,0,1");
    }

    #[test]
    fn cin_payload_preserves_dcs_code() {
        let mut ch = test_channel();
        ch.tone_squelch_kind = crate::state::ToneSquelchKind::Dcs;
        ch.tone_dcs_code = Some(151);
        let payload = build_cin_write_payload_for(&ch, &ScannerCapabilities::default()).unwrap();
        assert_eq!(payload, "Test Chan,01451300,FM,151,2,0,1");
    }

    #[test]
    fn cin_payload_rejects_non_canonical_ctcss_hz() {
        let mut ch = test_channel();
        ch.tone_squelch_kind = crate::state::ToneSquelchKind::Ctcss;
        ch.tone_squelch = Some(100.5);
        assert!(build_cin_write_payload_for(&ch, &ScannerCapabilities::default()).is_err());
    }

    #[test]
    fn cin_payload_rejects_modulation_injection() {
        let mut ch = test_channel();
        ch.modulation = "FM,0,0,1,0".to_string();
        assert!(build_cin_write_payload_for(&ch, &ScannerCapabilities::default()).is_err());
    }

    #[test]
    fn cin_payload_clears_empty_alpha_with_16_spaces() {
        // An empty wire field means "unchanged" (2026-07-08 probe), so a
        // cleared name must go out as 16 spaces or the old name survives.
        let mut ch = test_channel();
        ch.alpha_tag = String::new();
        let payload = build_cin_write_payload_for(&ch, &ScannerCapabilities::default()).unwrap();
        assert_eq!(payload, "                ,01451300,FM,0,2,0,1");
    }

    #[test]
    fn cin_payload_sanitizes_alpha_commas_and_length() {
        let mut ch = test_channel();
        ch.alpha_tag = "A,B,C this name is way too long".to_string();
        let payload = build_cin_write_payload_for(&ch, &ScannerCapabilities::default()).unwrap();
        assert!(payload.starts_with("A B C this name "));
        assert_eq!(payload.split(',').count(), 7);
    }

    #[test]
    fn cin_payload_preserves_negative_predelay() {
        let mut ch = test_channel();
        ch.delay = -10;
        let payload = build_cin_write_payload_for(&ch, &ScannerCapabilities::default()).unwrap();
        assert_eq!(payload, "Test Chan,01451300,FM,0,-10,0,1");
    }

    /// What the scanner reads back for an empty slot, as `parse_cin_response`
    /// produces it -- per model, because the two families do not agree.
    ///
    /// ```text
    /// BC125AT  CIN,10,AUTO,00000000,AUTO,0,2,1,0  -> alpha "AUTO", mod "AUTO", delay 2
    /// BC75XLT  CIN,299,,00000000,,,0,1,0          -> alpha "",     mod "",     delay 0
    /// ```
    ///
    /// This used to hardcode the BC125AT signature, so every test built on it
    /// asserted BC125AT behaviour only and the BC75XLT path through
    /// `readback_matches` was unguarded -- the #435 pattern exactly. Lockout is
    /// `true` on both, so it stays a literal.
    fn factory_empty_readback(caps: &ScannerCapabilities) -> ChannelData {
        ChannelData {
            index: 10,
            frequency: 0.0,
            // An empty CIN field stays empty; it is `[RSV]` on a BC75XLT.
            modulation: if caps.has_per_channel_modulation {
                "AUTO".to_string()
            } else {
                String::new()
            },
            alpha_tag: if caps.has_alpha_tags {
                "AUTO".to_string()
            } else {
                String::new()
            },
            delay: caps.cleared_delay,
            lockout: true,
            priority: false,
            tone_squelch: None,
            tone_squelch_kind: crate::state::ToneSquelchKind::None,
            tone_dcs_code: None,
            bank: 1,
        }
    }

    /// Both descriptors, for tests that must not pass by agreeing with one.
    const BOTH_MODELS: [ScannerCapabilities; 2] =
        [BC125AT_FAMILY, crate::protocol::capabilities::BC75XLT];

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

    #[test]
    fn priority_clear_persisted_rejects_stuck_priority_bit() {
        // clear_channel_priority always writes priority=false; a readback of
        // true means the DCH+rewrite failed to clear it. readback_matches's
        // refused-downgrade tolerance must NOT paper over that here.
        let mut rewritten = test_channel();
        rewritten.priority = false;
        let wrote_alpha = rewritten.alpha_tag.clone();

        let mut readback = rewritten.clone();
        readback.priority = true; // stuck bit
        assert!(!priority_clear_persisted(
            &rewritten,
            &readback,
            &wrote_alpha,
            &BC125AT_FAMILY
        ));

        // Sanity: a genuinely persisted clear (readback.priority == false,
        // everything else matching) must still pass.
        let mut readback_ok = rewritten.clone();
        readback_ok.priority = false;
        assert!(priority_clear_persisted(
            &rewritten,
            &readback_ok,
            &wrote_alpha,
            &BC125AT_FAMILY
        ));
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
        //
        // Run against BOTH models. The delay we "send" is picked as any valid
        // value that is NOT this model's cleared delay, so it genuinely
        // diverges on each -- hardcoding 0 would make the BC75XLT case a
        // no-divergence test, since 0 IS its cleared delay.
        for caps in BOTH_MODELS {
            let sent_delay = *caps
                .valid_delays
                .iter()
                .find(|d| **d != caps.cleared_delay)
                .expect("every model has a delay other than its cleared one");
            let mut wrote = factory_empty_readback(&caps);
            wrote.delay = sent_delay;
            wrote.lockout = false;
            let readback = factory_empty_readback(&caps);
            let alpha = readback.alpha_tag.clone();
            assert!(
                readback_matches(&wrote, &readback, &alpha, &caps),
                "cleared slot must verify on a scanner with cleared_delay={}",
                caps.cleared_delay
            );
        }
    }

    #[test]
    fn readback_rejects_forced_lockout_on_programmed_channel() {
        // A programmed channel (freq != 0) must NOT get the empty-channel pass:
        // if we wrote lockout=0 and it read back 1, that's a real mismatch.
        let mut readback = test_channel();
        readback.lockout = true;
        let mut wrote = test_channel();
        wrote.lockout = false;
        assert!(!readback_matches(
            &wrote,
            &readback,
            "Test Chan",
            &BC125AT_FAMILY
        ));
    }

    #[test]
    fn readback_rejects_empty_write_that_did_not_go_factory_empty() {
        // Freq 0 but the read-back is NOT the factory signature (delay 5) —
        // something genuinely wrong; do not silently pass it.
        //
        // 5 is not a valid delay on either model's cleared slot, so this reads
        // the same on both -- and running both proves the rejection is not an
        // accident of the BC125AT's cleared_delay being 2.
        for caps in BOTH_MODELS {
            let mut wrote = factory_empty_readback(&caps);
            wrote.delay = caps.cleared_delay;
            let mut readback = factory_empty_readback(&caps);
            readback.delay = 5;
            let alpha = readback.alpha_tag.clone();
            assert!(
                !readback_matches(&wrote, &readback, &alpha, &caps),
                "a non-factory delay must not pass as cleared (cleared_delay={})",
                caps.cleared_delay
            );
        }
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
        assert!(readback_matches(
            &wrote,
            &readback,
            "Test Chan",
            &BC125AT_FAMILY
        ));
    }

    #[test]
    fn readback_rejects_unexpected_priority_set() {
        // The tolerance is one-directional: we did NOT ask to clear (wrote
        // priority=true) yet it read back false — a real failure, still caught.
        let mut wrote = test_channel();
        wrote.priority = true;
        let mut readback = test_channel();
        readback.priority = false;
        assert!(!readback_matches(
            &wrote,
            &readback,
            "Test Chan",
            &BC125AT_FAMILY
        ));
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
        assert!(!readback_matches(
            &wrote,
            &readback,
            "Test Chan",
            &BC125AT_FAMILY
        ));
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

    #[tokio::test]
    async fn priority_endpoint_rejects_out_of_range_index() {
        let app = router(default_state());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/memory/channels/999/priority")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"priority":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    async fn post_lockout_channel(
        caps: crate::protocol::capabilities::ScannerCapabilities,
        mode: &str,
        channel: u16,
    ) -> StatusCode {
        let state = default_state();
        state.device.write().unwrap().capabilities = Some(caps);
        router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/commands/lockout")
                    .header("content-type", "application/json")
                    .body(Body::from(format!(
                        r#"{{"mode":"{mode}","channel":{channel}}}"#
                    )))
                    .unwrap(),
            )
            .await
            .unwrap()
            .status()
    }

    // REGRESSION GUARD (#143): post_lockout must range-check the channel index.
    #[tokio::test]
    async fn post_lockout_rejects_out_of_range_channel() {
        let state = default_state();
        let response = router(state)
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

    /// REGRESSION GUARD (#435): the bound follows the CONNECTED scanner.
    ///
    /// The guard above posts channel 600, which is out of range on both
    /// families -- so it passed whether the bound read `ScannerCapabilities` or
    /// a hardcoded 500, and it did in fact hide a hardcoded 500 in
    /// `handlers::commands`. Channel 350 is the index where the models
    /// disagree: valid on a BC125AT, past the end of a BC75XLT's 300. This is
    /// the CH31 lesson from #429 applied to the lockout bound.
    ///
    /// Both modes are covered because both are reachable from the same UI
    /// control and each carried its own copy of the literal.
    #[tokio::test]
    async fn post_lockout_bound_follows_the_connected_scanner() {
        use crate::protocol::capabilities::{BC125AT_FAMILY, BC75XLT};

        for mode in ["temporary", "permanent"] {
            assert_eq!(
                post_lockout_channel(BC75XLT, mode, 350).await,
                StatusCode::BAD_REQUEST,
                "{mode}: channel 350 is past the end of a BC75XLT's 300"
            );
            assert_ne!(
                post_lockout_channel(BC125AT_FAMILY, mode, 350).await,
                StatusCode::BAD_REQUEST,
                "{mode}: channel 350 is valid on a BC125AT -- a bound that \
                 rejects it everywhere is just a different wrong constant"
            );
        }
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

    /// REGRESSION GUARD (#410): every `default_state()` gets its own databases.
    ///
    /// They used to share one fixed path, so 29 constructors contended on two
    /// SQLite files under parallel test execution — and
    /// `preferences_reset_alias_matches` deletes every preference row, which a
    /// concurrently-running test could observe mid-assertion. The suite passed
    /// with `--test-threads=1` and failed intermittently without it, which is
    /// the worst shape a CI failure can take: it trains people to rerun.
    ///
    /// Adding tests made it MORE likely to fire, which punished exactly the
    /// behaviour we want.
    #[test]
    fn each_state_gets_its_own_databases() {
        let a = default_state();
        let b = default_state();

        assert_ne!(
            *a.preferences_db_path, *b.preferences_db_path,
            "two states must not share a preferences database"
        );
        assert_ne!(
            *a.analytics_db_path, *b.analytics_db_path,
            "two states must not share an analytics database"
        );

        // And writes must not cross over. A deliberately non-default value, so
        // the assertion cannot pass by matching what a fresh database returns.
        let sentinel = Value::from("only-in-a");
        save_preference_to_db(&a.preferences_db_path, "theme", &sentinel);
        assert_eq!(
            load_preferences_from_db(&a.preferences_db_path)
                .get("theme")
                .and_then(Value::as_str),
            Some("only-in-a"),
            "precondition: the write landed in a"
        );
        assert_ne!(
            load_preferences_from_db(&b.preferences_db_path)
                .get("theme")
                .and_then(Value::as_str),
            Some("only-in-a"),
            "a write to one state's database must not appear in another's"
        );
    }

    // ---------------------------------------------------------------------
    // Migration hardening (#418)
    //
    // These exist because #412 will add ALTER TABLE migrations against tables
    // holding a user's accumulated activity history and preferences. Until
    // then the only migration is CREATE TABLE IF NOT EXISTS on an empty
    // database, where nothing can be lost -- which is exactly why the error
    // handling was never exercised.

    /// REGRESSION GUARD: a database from a NEWER Bearpaw is refused, not
    /// silently run against.
    ///
    /// Migrations are forward-only, so there is no down path. Without the
    /// ceiling check no `current < N` branch matches, migration is skipped, and
    /// the old code queries a schema with columns it does not know about.
    ///
    /// Reachable through ordinary use: reinstalling a previous version after a
    /// bad release, two machines sharing a data directory, or restoring a
    /// machine from backup while the data directory is newer.
    #[test]
    fn a_database_from_the_future_is_refused() {
        let path = temp_db_file("future-schema");
        {
            let conn = rusqlite::Connection::open(&path).expect("create db");
            conn.pragma_update(None, "user_version", PREFERENCES_SCHEMA_VERSION + 5)
                .expect("set future version");
        }
        let err = init_preferences_db(path.to_str().unwrap())
            .expect_err("a future schema version must be refused");
        assert!(matches!(err, MigrationError::FromTheFuture { .. }));

        let msg = err.to_string();
        assert!(
            msg.contains("newer version of Bearpaw"),
            "message must name the situation: {msg}"
        );
        assert!(
            msg.contains("data directory"),
            "message must give the user something to do: {msg}"
        );
    }

    /// The refusal names a real backup file when one exists beside the
    /// database.
    ///
    /// Forward-only migrations make "restore the .bak" the documented way back
    /// (#418), so a user told to do that has to be able to find the file. A
    /// future-version database never migrates and so never makes its own
    /// backup — but an earlier upgrade on this machine usually did.
    #[test]
    fn the_refusal_names_an_existing_backup() {
        let path = temp_db_file("future-with-backup");
        {
            let conn = rusqlite::Connection::open(&path).expect("create db");
            conn.pragma_update(None, "user_version", PREFERENCES_SCHEMA_VERSION + 1)
                .expect("set future version");
        }
        // A backup an earlier upgrade would have left behind.
        let backup = PathBuf::from(format!(
            "{}.v0-to-v1.preferences.1.bak",
            path.to_str().unwrap()
        ));
        std::fs::write(&backup, b"old").expect("write fake backup");

        let err = init_preferences_db(path.to_str().unwrap()).expect_err("must refuse");
        let msg = err.to_string();

        assert!(
            msg.contains(backup.to_str().unwrap()),
            "the refusal must name the backup so the user can find it: {msg}"
        );

        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::remove_file(&path);
    }

    /// No backup, no claim of one. Naming a file that does not exist is worse
    /// than saying nothing.
    #[test]
    fn the_refusal_omits_the_backup_line_when_there_is_none() {
        let path = temp_db_file("future-no-backup");
        {
            let conn = rusqlite::Connection::open(&path).expect("create db");
            conn.pragma_update(None, "user_version", PREFERENCES_SCHEMA_VERSION + 1)
                .expect("set future version");
        }
        let err = init_preferences_db(path.to_str().unwrap()).expect_err("must refuse");
        let msg = err.to_string();
        assert!(
            !msg.contains("backup exists at"),
            "must not claim a backup that is not there: {msg}"
        );
        assert!(
            msg.contains("data directory"),
            "still gives a next step: {msg}"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// The paired half: a database at or below the supported version still
    /// migrates. A ceiling that refused everything would pass the test above.
    #[test]
    fn a_current_database_is_not_refused_as_from_the_future() {
        let path = temp_db_file("ceiling");
        let p = path.to_str().unwrap();
        assert!(check_not_from_the_future(p, 0, 1).is_ok());
        assert!(check_not_from_the_future(p, 1, 1).is_ok(), "equal is fine");
        assert!(check_not_from_the_future(p, 2, 1).is_err());
    }

    /// A v1 preferences database gains `channel_memory` and reports v2, and
    /// existing preference rows survive the step.
    ///
    /// The columns are asserted by name because the schema is the contract
    /// Task 2 and #414 both build on: a silently renamed column would not fail
    /// a round-trip test that uses the same names on both sides.
    #[test]
    fn preferences_v1_migrates_to_channel_memory_v2() {
        let path = temp_db_file("channel-memory-v1-to-v2");
        {
            let conn = rusqlite::Connection::open(&path).expect("create db");
            conn.execute_batch(
                "CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL);",
            )
            .expect("v1 schema");
            conn.execute(
                "INSERT INTO preferences (key, value, updated_at) VALUES ('theme', '\"dark\"', 0)",
                [],
            )
            .expect("seed a preference");
            conn.pragma_update(None, "user_version", 1)
                .expect("mark as v1");
        }

        init_preferences_db(path.to_str().unwrap()).expect("migration must succeed");

        let conn = rusqlite::Connection::open(&path).expect("reopen");
        // Every pending step runs, so a v1 database lands on the current
        // version, not on 2. Compared against the constant so a future bump
        // does not fail this test for a reason unrelated to what it checks.
        assert_eq!(
            schema_version(&conn),
            PREFERENCES_SCHEMA_VERSION,
            "a v1 database must be brought fully up to date"
        );

        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('channel_memory')")
            .expect("table must exist")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query columns")
            .flatten()
            .collect();
        for expected in [
            "scanner_id",
            "channel_index",
            "frequency",
            "modulation",
            "alpha_tag",
            "delay",
            "lockout",
            "priority",
            "tone_kind",
            "tone_squelch_hz",
            "tone_dcs_code",
            "synced_at",
        ] {
            assert!(
                cols.iter().any(|c| c == expected),
                "missing column {expected}: {cols:?}"
            );
        }
        assert!(
            !cols.iter().any(|c| c == "bank"),
            "bank must NOT be persisted -- it is derived per connected model by \
             channels_with_banks, and a stored bank reproduces the bank-derivation \
             bug when a cache is read under a different model: {cols:?}"
        );

        let theme: String = conn
            .query_row(
                "SELECT value FROM preferences WHERE key = 'theme'",
                [],
                |r| r.get(0),
            )
            .expect("existing preferences must survive the migration");
        assert_eq!(theme, "\"dark\"");
    }

    /// Running the migration twice is a no-op rather than an error.
    #[test]
    fn channel_memory_migration_is_idempotent() {
        let path = temp_db_file("channel-memory-idempotent");
        let p = path.to_str().unwrap();
        init_preferences_db(p).expect("first run");
        init_preferences_db(p).expect("second run must be a no-op");

        let conn = rusqlite::Connection::open(&path).expect("reopen");
        // Compared against the constant, not a literal: a version bump should
        // require touching the migration and nothing else. Hardcoding the
        // number here made the bump to 3 fail this test for no reason.
        assert_eq!(schema_version(&conn), PREFERENCES_SCHEMA_VERSION);
    }

    /// A v2 database gains the `scanners` table and keeps its channel memory.
    ///
    /// The columns are asserted by name for the same reason as the v2 test: the
    /// schema is the contract #415 through #417 build on, and a silently
    /// renamed column would not fail a round-trip test that uses the same names
    /// on both sides.
    #[test]
    fn preferences_v2_migrates_to_scanners_v3() {
        let path = temp_db_file("scanners-v2-to-v3");
        let p = path.to_str().unwrap();

        // Build a real v2 database, then wind the version back so the v3 step
        // is the only one left to run.
        init_preferences_db(p).expect("build current schema");
        {
            let conn = rusqlite::Connection::open(&path).expect("reopen");
            conn.execute(
                "INSERT INTO channel_memory
                     (scanner_id, channel_index, frequency, modulation, alpha_tag,
                      delay, lockout, priority, tone_kind, synced_at)
                 VALUES ('_default', 1, 146.52, 'FM', 'KEEP ME', 2, 0, 0, 'none', 1.0)",
                [],
            )
            .expect("seed cached channel memory");
            conn.execute("DROP TABLE scanners", []).expect("undo v3");
            conn.pragma_update(None, "user_version", 2)
                .expect("mark as v2");
        }

        init_preferences_db(p).expect("migration must succeed");

        let conn = rusqlite::Connection::open(&path).expect("reopen");
        assert_eq!(schema_version(&conn), PREFERENCES_SCHEMA_VERSION);

        let cols: Vec<String> = conn
            .prepare("SELECT name FROM pragma_table_info('scanners')")
            .expect("scanners table must exist")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query columns")
            .filter_map(Result::ok)
            .collect();
        for expected in [
            "scanner_id",
            "match_index",
            "model",
            "usb_serial",
            "display_name",
            "first_seen",
            "last_seen",
        ] {
            assert!(
                cols.iter().any(|c| c == expected),
                "scanners must carry `{expected}`: {cols:?}"
            );
        }

        // The cache survives. Orphaning a user's channel memory on an upgrade
        // would cost them a re-sync and look like data loss.
        let tag: String = conn
            .query_row(
                "SELECT alpha_tag FROM channel_memory WHERE channel_index = 1",
                [],
                |r| r.get(0),
            )
            .expect("cached channel memory must survive the step");
        assert_eq!(tag, "KEEP ME");
    }

    /// REGRESSION GUARD: a failed step must NOT bump `user_version`.
    ///
    /// The bump used to run unconditionally after `let _ = conn.execute(...)`,
    /// so a failed step marked the database migrated -- the next launch read
    /// the new version, skipped the migration, and queried a schema that did
    /// not exist. The failure was invisible until a query hit a missing column.
    #[test]
    fn a_failed_step_leaves_the_version_unchanged() {
        let path = temp_db_file("failed-step");
        let conn = rusqlite::Connection::open(&path).expect("create db");

        let err = run_migration_step(&conn, 1, "THIS IS NOT VALID SQL;")
            .expect_err("invalid SQL must fail the step");
        assert!(matches!(err, MigrationError::StepFailed { version: 1, .. }));

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(
            version, 0,
            "a failed step must leave the version alone so the next launch retries"
        );
    }

    /// REGRESSION GUARD: a multi-statement step is atomic.
    ///
    /// A step that creates a table and then fails must leave NEITHER behind --
    /// a half-applied schema is a state no version of the code expects.
    #[test]
    fn a_partly_failing_step_rolls_back_entirely() {
        let path = temp_db_file("partial-step");
        let conn = rusqlite::Connection::open(&path).expect("create db");

        let err = run_migration_step(
            &conn,
            1,
            "CREATE TABLE migration_probe (id INTEGER);
             THIS IS NOT VALID SQL;",
        )
        .expect_err("the second statement must fail the step");
        assert!(matches!(err, MigrationError::StepFailed { .. }));

        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='migration_probe'",
                [],
                |row| row.get(0),
            )
            .expect("query table");
        assert_eq!(
            table_exists, 0,
            "the first statement must roll back with the second"
        );

        // The connection must be usable afterwards -- a left-open transaction
        // would hold a write lock for the life of the connection.
        conn.execute_batch("CREATE TABLE after_rollback (id INTEGER);")
            .expect("connection must not be stuck in a transaction");
    }

    /// A successful step commits both the schema change and the version.
    #[test]
    fn a_successful_step_commits_schema_and_version_together() {
        let path = temp_db_file("good-step");
        let conn = rusqlite::Connection::open(&path).expect("create db");

        run_migration_step(&conn, 3, "CREATE TABLE ok_probe (id INTEGER);").expect("step");

        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, 3);
        let table_exists: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='ok_probe'",
                [],
                |row| row.get(0),
            )
            .expect("query table");
        assert_eq!(table_exists, 1);
    }

    /// Build a v1 analytics database with rows in it, exactly as a user
    /// upgrading from a pre-scanner_id build would have.
    #[cfg(test)]
    fn seed_v1_analytics_db(path: &std::path::Path, rows: &[(f64, Option<&str>)]) {
        let conn = rusqlite::Connection::open(path).expect("create v1 analytics db");
        conn.execute_batch(
            "
            CREATE TABLE scan_hits (
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
            PRAGMA user_version = 1;
            ",
        )
        .expect("seed v1 schema");
        for (freq, tag) in rows {
            conn.execute(
                "INSERT INTO scan_hits (timestamp, frequency, alpha_tag, modulation, rssi, duration, mode, session_id, ended_at)
                 VALUES (1.0, ?1, ?2, 'NFM', 30, 5.0, 'SCAN', 'seed', 6.0)",
                rusqlite::params![freq, tag],
            )
            .expect("seed row");
        }
    }

    /// A v1 database carrying real hits must reach v2 with every row intact.
    ///
    /// Migrations are forward-only (#418), so a step that drops rows on the way
    /// up is unrecoverable except from the pre-migration `.bak`.
    #[test]
    fn analytics_v1_upgrades_to_v2_without_losing_hits() {
        let path = temp_db_file("analytics-v1-to-v2");
        seed_v1_analytics_db(&path, &[(146.7, Some("KC FIRE 1")), (154.1, None)]);

        init_analytics_db(path.to_str().expect("path to string")).expect("migrate");

        let conn = rusqlite::Connection::open(&path).expect("reopen");
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, 2, "the step must bump the version");
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM scan_hits", [], |row| row.get(0))
            .expect("count rows");
        assert_eq!(rows, 2, "no hit may be lost on the way to v2");
        let _ = std::fs::remove_file(&path);
    }

    /// REGRESSION GUARD: the v2 step must NOT guess at which scanner recorded
    /// an existing hit.
    ///
    /// The tempting heuristic is "it carries an alpha tag, so it came from an
    /// alpha-tag scanner" -- true, but it identifies the FAMILY, not the model.
    /// Writing "BC125AT" would mislabel the four other members (BCT125AT,
    /// UBC125XLT, UBC126AT, AE125H); their owners would connect a UBC125XLT,
    /// fail to match, and watch their whole history drop out of scoped views.
    /// NULL is the honest answer and the only one that cannot be wrong.
    #[test]
    fn the_v2_step_does_not_guess_a_scanner_for_existing_hits() {
        let path = temp_db_file("analytics-no-guess");
        seed_v1_analytics_db(&path, &[(146.7, Some("KC FIRE 1")), (154.1, None)]);

        init_analytics_db(path.to_str().expect("path to string")).expect("migrate");

        let conn = rusqlite::Connection::open(&path).expect("reopen");
        let attributed: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM scan_hits WHERE scanner_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .expect("count attributed");
        assert_eq!(
            attributed, 0,
            "a tagged hit proves the family, not the model -- leave it NULL"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// Migrating twice must be a no-op, not a duplicate-column failure.
    ///
    /// `ALTER TABLE ... ADD COLUMN` errors if the column already exists, and
    /// `run_migration_step` correctly refuses to bump the version on a failed
    /// step -- so an unguarded re-run would wedge the database at v1 forever,
    /// reporting a migration error on every launch.
    #[test]
    fn migrating_an_already_v2_analytics_db_is_a_no_op() {
        let path = temp_db_file("analytics-v2-twice");
        seed_v1_analytics_db(&path, &[(146.7, Some("KC FIRE 1"))]);

        let p = path.to_str().expect("path to string");
        init_analytics_db(p).expect("first migrate");
        init_analytics_db(p).expect("second migrate must be a no-op");

        let conn = rusqlite::Connection::open(&path).expect("reopen");
        let version: i32 = conn
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(version, ANALYTICS_SCHEMA_VERSION);
        let _ = std::fs::remove_file(&path);
    }

    /// A hit round-trips through SQLite carrying the model that heard it.
    #[test]
    fn a_hit_persists_and_reloads_its_scanner_id() {
        let path = temp_db_file("analytics-scanner-id");
        let p = path.to_str().expect("path to string").to_string();
        init_analytics_db(&p).expect("migrate");

        let hit = ActivityHit {
            id: "1".to_string(),
            timestamp: 100.0,
            frequency: 146.7,
            channel: Some(12),
            alpha_tag: None,
            rssi: 36,
            duration: 5.0,
            modulation: "NFM".to_string(),
            mode: ScannerMode::Scan,
            bank: Some(1),
            session_id: "s".to_string(),
            ended_at: 105.0,
            scanner_id: Some("BC75XLT".to_string()),
        };
        insert_analytics_hit(&p, &hit);

        let loaded = load_analytics_hits_from_db(&p);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].scanner_id.as_deref(), Some("BC75XLT"));
        let _ = std::fs::remove_file(&path);
    }

    /// REGRESSION GUARD: a failed backup aborts the migration.
    ///
    /// Forward-only migrations make the pre-migration backup the ONLY recovery
    /// path. It used to be `let _ = std::fs::copy(...)`, which proceeded on
    /// failure -- destroying the fallback exactly when it is most needed.
    ///
    /// Simulated with an unwritable parent directory.
    #[test]
    fn a_failed_backup_aborts_the_migration() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!(
            "bearpaw-ro-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("create dir");
        let path = dir.join("prefs.db");
        // The connection stays open across the backup now that the backup runs
        // through SQLite rather than the filesystem (#574).
        let conn = rusqlite::Connection::open(&path).expect("create db");
        conn.execute(
            "CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL)",
            [],
        )
        .expect("create table");
        // Read+execute only: the existing file stays readable, but a new file
        // cannot be created alongside it.
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o500))
            .expect("make dir read-only");

        let result = backup_db_if_needed(&conn, path.to_str().unwrap(), "preferences", 0, 1);

        // Restore permissions before asserting so a failure still cleans up.
        drop(conn);
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
        let _ = std::fs::remove_dir_all(&dir);

        let err = result.expect_err("an unwritable backup must abort the migration");
        assert!(matches!(err, MigrationError::BackupFailed { .. }));
        assert!(
            err.to_string().contains("backup"),
            "message must name the backup: {err}"
        );
    }

    /// REGRESSION GUARD (#574): the pre-migration backup must contain data that
    /// is still sitting in the write-ahead log.
    ///
    /// `open_sqlite` sets `journal_mode = WAL` and `synchronous = NORMAL`, so a
    /// committed transaction lives in the `-wal` sidecar until something
    /// checkpoints it. The backup was `std::fs::copy` of the main file alone --
    /// the `-wal` and `-shm` sidecars were not copied and no checkpoint was
    /// forced, so the ONLY recovery path from a forward-only migration could be
    /// missing the most recent committed state.
    ///
    /// Restoring it was worse than incomplete: dropping the `.bak` over
    /// `preferences.db` while a newer `-wal` still sat beside it produces a
    /// MISMATCHED PAIR, not the old database.
    ///
    /// The existing backup tests assert that a file is CREATED, and that its
    /// absence aborts. Never what is inside it -- the same shape as the
    /// `synced_at` bug from #537: a guard that checks a value exists cannot
    /// notice the value is wrong.
    ///
    /// The 30-second channel-cache flush (#413) makes the volume of at-risk WAL
    /// frames much larger than it was when this code was written, and v2/v3 are
    /// the first migrations to run against a database holding real channel
    /// memory. Before that, the worst case was losing preferences.
    #[test]
    fn the_backup_includes_uncheckpointed_wal_data() {
        let path = temp_db_file("wal-backup");
        let path_str = path.to_str().expect("path").to_string();

        // Exactly what `open_sqlite` configures.
        let conn = rusqlite::Connection::open(&path).expect("create db");
        conn.pragma_update(None, "journal_mode", "WAL")
            .expect("wal");
        conn.pragma_update(None, "synchronous", "NORMAL")
            .expect("synchronous");
        conn.execute(
            "CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL)",
            [],
        )
        .expect("create table");
        conn.pragma_update(None, "user_version", 2)
            .expect("set version");

        // Checkpoint the SCHEMA into the main file, so the only thing left in
        // the WAL is the row below. Without this the backup would be missing
        // the table too, and the test would prove a blunter point than the one
        // #574 is about: committed data that the copy cannot see.
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .expect("checkpoint");

        // Committed, and deliberately NOT checkpointed. The connection stays
        // open, so these frames are still in `-wal` when the backup runs --
        // which is the state a SIGKILL, panic or power loss leaves behind.
        conn.execute(
            "INSERT INTO preferences (key, value, updated_at) VALUES ('theme', 'dark', 1.0)",
            [],
        )
        .expect("insert");
        assert!(
            std::path::Path::new(&format!("{path_str}-wal")).exists(),
            "precondition: the WAL sidecar must be hot for this test to mean \
             anything"
        );

        let backup = backup_db_if_needed(&conn, &path_str, "preferences", 2, 3)
            .expect("the backup must succeed")
            .expect("a database at v2 going to v3 must be backed up");

        // Open the backup ALONE. No sidecar travels with it, which is the whole
        // point: whatever the recovery path can read has to already be in this
        // one file.
        let restored = rusqlite::Connection::open(&backup).expect("open backup");
        let value: String = restored
            .query_row(
                "SELECT value FROM preferences WHERE key = 'theme'",
                [],
                |row| row.get(0),
            )
            .expect("the committed row must be IN the backup, not just in the original's WAL");
        assert_eq!(value, "dark");

        let version: i32 = restored
            .pragma_query_value(None, "user_version", |row| row.get(0))
            .expect("read user_version");
        assert_eq!(
            version, 2,
            "the backup must carry the schema version it was taken at -- \
             restoring it is how a user gets back to the pre-migration app, \
             and a version of 0 would make that build re-run every migration"
        );

        drop(conn);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&backup);
    }

    /// The backup path appears in the failure message, because forward-only
    /// migrations make "restore the .bak" the documented way back and a user
    /// told to do that has to be able to find the file.
    #[test]
    fn a_successful_backup_lands_next_to_the_database() {
        let path = temp_db_file("backup-made");
        let conn = rusqlite::Connection::open(&path).expect("create db");
        conn.execute("CREATE TABLE probe (id INTEGER)", [])
            .expect("create table");
        let backup = backup_db_if_needed(&conn, path.to_str().unwrap(), "preferences", 0, 1)
            .expect("backup must succeed")
            .expect("a backup must be made when migrating an existing database");

        assert!(backup.exists(), "backup file must exist at {backup:?}");
        assert_eq!(
            backup.parent(),
            path.parent(),
            "backup must land beside the database so a user can find it"
        );
        assert!(backup.to_string_lossy().contains("v0-to-v1"));
        let _ = std::fs::remove_file(&backup);
        let _ = std::fs::remove_file(&path);
    }

    /// No backup is made when there is nothing to migrate.
    #[test]
    fn no_backup_is_made_when_already_current() {
        let path = temp_db_file("no-backup");
        let conn = rusqlite::Connection::open(&path).expect("create db");
        conn.execute("CREATE TABLE probe (id INTEGER)", [])
            .expect("create table");
        let backup = backup_db_if_needed(&conn, path.to_str().unwrap(), "preferences", 1, 1)
            .expect("no-op must succeed");
        assert!(backup.is_none(), "already-current needs no backup");
        let _ = std::fs::remove_file(&path);
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
        init_preferences_db(path.to_str().expect("path to string")).expect("migrate");
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
        init_analytics_db(path.to_str().expect("path to string")).expect("migrate");
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
        assert_eq!(bank_priority_index(&ch, 1, &BC125AT_FAMILY), Some(2));
        assert_eq!(bank_priority_index(&ch, 2, &BC125AT_FAMILY), None); // bank 2 empty
    }

    #[test]
    fn plan_priority_swap_identifies_old_and_new() {
        use std::collections::HashMap;
        let mut ch = HashMap::new();
        let mut c2 = test_channel();
        c2.index = 2;
        c2.priority = true; // current bank-1 priority
        ch.insert(2, c2);
        // Setting CH9 (also bank 1) must clear CH2 and set CH9.
        assert_eq!(plan_priority_swap(&ch, 9, &BC125AT_FAMILY), (Some(2), 9));
        // Setting the channel that is ALREADY priority: no clear needed.
        assert_eq!(plan_priority_swap(&ch, 2, &BC125AT_FAMILY), (None, 2));
        // Bank with no current priority: nothing to clear.
        let empty = HashMap::new();
        assert_eq!(plan_priority_swap(&empty, 9, &BC125AT_FAMILY), (None, 9));
    }

    /// REGRESSION GUARD: the priority swap must use the CONNECTED scanner's
    /// bank width.
    ///
    /// The existing planner tests use channels 2 and 9, which are bank 1 under
    /// BOTH a /50 and a /30 divisor — so they pass whether or not the math is
    /// model-aware and guarded nothing. This one picks indices where the two
    /// models DISAGREE.
    ///
    /// With the BC125AT's fixed /50, a BC75XLT's 300 channels collapsed into
    /// six 50-wide windows straddling the real 30-channel boundaries. Setting
    /// priority on CH31 (real bank 2) looked up the holder of window 1–50 and
    /// planned to clear CH5 — a channel in a DIFFERENT bank the user never
    /// touched — and that clear is a destructive DCH-plus-rewrite.
    ///
    /// The frontend already derived this correctly (#401), so the confirmation
    /// dialog named the right channel while the backend modified another one.
    #[test]
    fn priority_swap_uses_the_connected_scanner_bank_width() {
        use crate::protocol::capabilities::BC75XLT;
        use std::collections::HashMap;

        let mut ch = HashMap::new();
        // CH5 is bank 1 on both models. CH55 is bank 2 on a BC75XLT and bank 2
        // on a BC125AT — but only CH5 shares a /50 window with CH31.
        for (index, priority) in [(5u16, true), (55u16, true)] {
            let mut c = test_channel();
            c.index = index;
            c.priority = priority;
            ch.insert(index, c);
        }

        // CH31: bank 1 on a BC125AT (1–50), bank 2 on a BC75XLT (31–60).
        let (old, new) = plan_priority_swap(&ch, 31, &BC125AT_FAMILY);
        assert_eq!(
            (old, new),
            (Some(5), 31),
            "BC125AT: CH31 is in bank 1 with CH5 — unchanged behaviour"
        );

        let (old, new) = plan_priority_swap(&ch, 31, &BC75XLT);
        assert_eq!(
            (old, new),
            (Some(55), 31),
            "BC75XLT: CH31 is in bank 2 with CH55. Clearing CH5 would wipe \
             priority on a channel in a different bank via a destructive \
             DCH-plus-rewrite."
        );
    }

    /// REGRESSION GUARD: the empty-slot signature is model-dependent.
    ///
    /// `readback_matches` short-circuits to `is_factory_empty` for ANY write
    /// whose frequency is 0. With `delay == 2` hardcoded, that predicate was
    /// un-satisfiable on a BC75XLT — so every zero-frequency write returned
    /// 400 `channel_not_persisted` AFTER succeeding on the wire, and the
    /// handler skipped its shadow-cache update so the backend's own view went
    /// stale. That hit not just an explicit clear but any bulk upload or
    /// reorder whose write-set included an empty slot.
    /// REGRESSION GUARD: clearing a channel that IS the bank's priority
    /// channel must not report failure.
    ///
    /// The firmware refuses an in-place priority 1->0 CIN write (see
    /// `clear_channel_priority`, which exists because DCH+rewrite is the only
    /// mechanism). So the clear writes priority=1 and reads back priority=1,
    /// which `is_factory_empty`'s `!priority` term rejected -- returning 400
    /// `channel_not_persisted` AFTER the write had already landed on the wire,
    /// and skipping the shadow-cache update so the backend went stale too.
    ///
    /// Observed on hardware 2026-08-27 clearing channel 271 on a BC75XLT:
    /// `wrote=CIN,271,,00000000,,,0,1,1 read_back=CIN,271,,00000000,,,0,1,1`
    /// -- byte-identical, and still reported as not persisted. Not
    /// model-specific: a BC125AT clearing its priority channel hits it too.
    /// REGRESSION GUARD: a single-channel read must derive the bank.
    ///
    /// `parse_cin_response` leaves `bank: 0` deliberately -- it is pure, has no
    /// capability descriptor, and the wire carries no bank field (membership
    /// comes from SCG). So every boundary that hands a channel outward has to
    /// derive it. `channels_with_banks` does that for the list endpoint;
    /// `get_memory_channel`'s wire path did not, so the same channel reported
    /// bank 10 from the list and bank 0 from a direct read.
    ///
    /// Not cosmetic: the bulk-upload loop calls this per channel and, on a
    /// write mismatch, feeds the result straight into the frontend's channel
    /// list -- writing bank 0 over a correct value. CLAUDE.md notes that a
    /// frontend/backend bank disagreement "is how a priority swap clears the
    /// wrong bank".
    #[tokio::test]
    async fn a_single_channel_read_derives_its_bank() {
        use crate::protocol::capabilities::BC75XLT;

        let state = default_state();
        state.device.write().unwrap().capabilities = Some(BC75XLT);
        let _scanner = FakeScanner::attach(&state, |cmd: &str| {
            if cmd == "CIN,271" {
                // A cleared slot as this hardware reports it (2026-08-27).
                Ok("CIN,271,,00000000,,,0,1,1".to_string())
            } else {
                Ok("OK".to_string())
            }
        });

        let channel = super::handlers::memory::get_memory_channel(
            axum::extract::State(state.clone()),
            axum::extract::Path(271u16),
        )
        .await
        .expect("read should succeed")
        .0;

        // 30 channels per bank on a BC75XLT: 271 -> bank 10, never 0.
        assert_eq!(
            channel.bank,
            BC75XLT.index_to_bank(271),
            "the wire read must derive the bank, like the list endpoint does"
        );
        assert_ne!(channel.bank, 0, "bank 0 is the parser's placeholder");
    }

    /// REGRESSION GUARD (#507): a VALUE-level guard on the `C-Freq` row.
    ///
    /// `bc125at_ss_export_matches_the_reference_file_shape` compares
    /// run-length-encoded (section, field_count, run) triples and never looks
    /// at values, which was the right call for the positional bug it was
    /// written for (#461) and is why the tone column shipped broken for months
    /// (#516): Bearpaw wrote `100.0`, Uniden reads `C100.0`, and every export
    /// of a toned channel silently lost it while the golden test stayed green.
    ///
    /// This asserts ONE row with every column set to a distinct non-default
    /// value, so a change to ANY of them has to update a test deliberately
    /// rather than slipping through. Per-column bespoke tests were the previous
    /// answer and only ever covered the column someone had already broken.
    #[tokio::test]
    async fn bc125at_ss_export_pins_every_c_freq_column() {
        let state = default_state();
        {
            let mut shadow = state.shadow.write().unwrap();
            for idx in 1..=500u16 {
                shadow.channels.insert(
                    idx,
                    ChannelData {
                        index: idx,
                        ..Default::default()
                    },
                );
            }
            shadow.channels.insert(
                250,
                ChannelData {
                    index: 250,
                    frequency: 154.5,
                    modulation: "NFM".to_string(),
                    alpha_tag: "FULL FIELD".to_string(),
                    tone_squelch_kind: crate::state::ToneSquelchKind::Ctcss,
                    tone_squelch: Some(141.3),
                    tone_dcs_code: None,
                    lockout: true,
                    delay: 5,
                    priority: true,
                    bank: 5,
                },
            );
        }
        let _scanner = FakeScanner::attach(&state, |cmd: &str| {
            Ok(match cmd {
                "BLT" => "BLT,AF".to_string(),
                "KBP" => "KBP,99,0".to_string(),
                "BSV" => "BSV,2".to_string(),
                "PRI" => "PRI,0".to_string(),
                "SCG" => "SCG,1111111111".to_string(),
                "SCO" => "SCO,1,0".to_string(),
                "CLC" => "CLC,0,0,0,11111,0".to_string(),
                "WXS" => "WXS,0".to_string(),
                "CNT" => "CNT,8".to_string(),
                "VOL" => "VOL,14".to_string(),
                "SQL" => "SQL,6".to_string(),
                c if c.starts_with("CSP,") => format!("{c},25000000,27995000"),
                c if c.starts_with("SSP,") => format!("{c},0"),
                _ => "OK".to_string(),
            })
        });

        let response =
            super::handlers::exports::export_bc125at_ss_file(axum::extract::State(state.clone()))
                .await
                .expect("export should succeed");
        let body = axum::response::IntoResponse::into_response(response);
        let bytes = axum::body::to_bytes(body.into_body(), usize::MAX)
            .await
            .expect("body");
        let out = String::from_utf8(bytes.to_vec()).expect("utf8");

        // idx, name, freqHz, modulation, tone, lockout, delay, priority
        assert!(
            out.contains("C-Freq\t250\tFULL FIELD\t154500000\tNFM\tC141.3\tOn\t5\tOn\r\n"),
            "every C-Freq column must serialise exactly as Uniden writes it"
        );

        // And the default row, which pins the `Auto` casing (#507) plus the
        // cleared-slot shape every untouched channel takes.
        assert!(
            out.contains("C-Freq\t1\t\t0\tAuto\tOff\tOff\t0\tOff\r\n"),
            "an unprogrammed channel must use Uniden's `Auto`, not the wire's `AUTO`"
        );
        assert!(
            !out.contains("\tAUTO\t"),
            "the wire's upper-case AUTO must never reach the file"
        );
    }

    /// REGRESSION GUARD (#459): `AvoidFreqs` must reach the file, and must sit
    /// BETWEEN `GeneralSearch` and the first `Conventional`.
    ///
    /// Position is load-bearing in this format -- #461 was a pure ordering bug
    /// that no field-count comparison could see -- so a builder that emits the
    /// right line in the wrong place is still a broken file. The unit tests
    /// next to `build_avoid_freqs_line` cover the field packing; this covers
    /// that it is called at all, and where.
    #[tokio::test]
    async fn bc125at_ss_export_writes_avoid_freqs_between_search_and_banks() {
        let state = default_state();
        {
            let mut shadow = state.shadow.write().unwrap();
            for idx in 1..=500u16 {
                shadow.channels.insert(
                    idx,
                    ChannelData {
                        index: idx,
                        ..Default::default()
                    },
                );
            }
        }
        // GLF is a cursor: successive bare calls step the list, then -1 ends it.
        // A stateless fake would loop until the 110-iteration bound.
        let glf_calls = std::sync::Mutex::new(0usize);
        let _scanner = FakeScanner::attach(&state, move |cmd: &str| {
            Ok(match cmd {
                "GLF" => {
                    let mut n = glf_calls.lock().unwrap();
                    *n += 1;
                    match *n {
                        1 => "GLF,01167333".to_string(),
                        2 => "GLF,01228833".to_string(),
                        _ => "GLF,-1".to_string(),
                    }
                }
                "BLT" => "BLT,AF".to_string(),
                "KBP" => "KBP,99,0".to_string(),
                "BSV" => "BSV,2".to_string(),
                "PRI" => "PRI,0".to_string(),
                "SCG" => "SCG,1111111111".to_string(),
                "SCO" => "SCO,1,0".to_string(),
                "CLC" => "CLC,0,0,0,11111,0".to_string(),
                "WXS" => "WXS,0".to_string(),
                "CNT" => "CNT,8".to_string(),
                "VOL" => "VOL,14".to_string(),
                "SQL" => "SQL,6".to_string(),
                c if c.starts_with("CSP,") => format!("{c},25000000,27995000"),
                c if c.starts_with("SSP,") => format!("{c},0"),
                _ => "OK".to_string(),
            })
        });

        let response =
            super::handlers::exports::export_bc125at_ss_file(axum::extract::State(state.clone()))
                .await
                .expect("export should succeed");
        let body = axum::response::IntoResponse::into_response(response);
        let bytes = axum::body::to_bytes(body.into_body(), usize::MAX)
            .await
            .expect("body");
        let out = String::from_utf8(bytes.to_vec()).expect("utf8");

        let keys: Vec<&str> = out
            .split("\r\n")
            .filter(|l| !l.is_empty())
            .map(|l| l.split('\t').next().unwrap_or(""))
            .collect();

        let avoid = keys
            .iter()
            .position(|k| *k == "AvoidFreqs")
            .expect("AvoidFreqs must be emitted when the lockout list is non-empty");
        let search = keys
            .iter()
            .position(|k| *k == "GeneralSearch")
            .expect("GeneralSearch");
        let first_bank = keys
            .iter()
            .position(|k| *k == "Conventional")
            .expect("Conventional");

        assert!(
            search < avoid && avoid < first_bank,
            "AvoidFreqs must sit between GeneralSearch and the first Conventional, got \
             GeneralSearch={search} AvoidFreqs={avoid} Conventional={first_bank}"
        );
        assert_eq!(
            keys.iter().filter(|k| **k == "AvoidFreqs").count(),
            1,
            "exactly one AvoidFreqs line"
        );
        assert!(
            out.contains("AvoidFreqs\t\t116733300\t122883300\t"),
            "values packed from field 2 in walk order, integer Hz"
        );
    }

    /// REGRESSION GUARD (#516): the tone column must reach the FILE, not just
    /// the helper. `ss_tone_label` is unit-tested next to itself; this asserts
    /// the emitted `C-Freq` line, so a future refactor that stops calling it
    /// (or calls `dcs_code_to_label` again) fails here.
    ///
    /// The golden shape test cannot cover this: it compares section and
    /// field-count runs, and every reference file is `Off` on all 500 rows.
    #[tokio::test]
    async fn bc125at_ss_export_writes_unidens_tone_spellings() {
        let state = default_state();
        {
            let mut shadow = state.shadow.write().unwrap();
            for idx in 1..=500u16 {
                shadow.channels.insert(
                    idx,
                    ChannelData {
                        index: idx,
                        ..Default::default()
                    },
                );
            }
            shadow.channels.insert(
                429,
                ChannelData {
                    index: 429,
                    frequency: 123.0,
                    modulation: "AM".to_string(),
                    tone_squelch_kind: crate::state::ToneSquelchKind::Ctcss,
                    tone_squelch: Some(100.0),
                    ..Default::default()
                },
            );
            shadow.channels.insert(
                430,
                ChannelData {
                    index: 430,
                    frequency: 462.5625,
                    modulation: "NFM".to_string(),
                    tone_squelch_kind: crate::state::ToneSquelchKind::Dcs,
                    tone_dcs_code: Some(128),
                    ..Default::default()
                },
            );
        }
        let _scanner = FakeScanner::attach(&state, |cmd: &str| {
            Ok(match cmd {
                "BLT" => "BLT,AF".to_string(),
                "KBP" => "KBP,99,0".to_string(),
                "BSV" => "BSV,2".to_string(),
                "PRI" => "PRI,0".to_string(),
                "SCG" => "SCG,1111111111".to_string(),
                "SCO" => "SCO,1,0".to_string(),
                "CLC" => "CLC,0,0,0,11111,0".to_string(),
                "WXS" => "WXS,0".to_string(),
                "CNT" => "CNT,8".to_string(),
                "VOL" => "VOL,14".to_string(),
                "SQL" => "SQL,6".to_string(),
                c if c.starts_with("CSP,") => format!("{c},25000000,27995000"),
                c if c.starts_with("SSP,") => format!("{c},0"),
                _ => "OK".to_string(),
            })
        });

        let response =
            super::handlers::exports::export_bc125at_ss_file(axum::extract::State(state.clone()))
                .await
                .expect("export should succeed");
        let body = axum::response::IntoResponse::into_response(response);
        let bytes = axum::body::to_bytes(body.into_body(), usize::MAX)
            .await
            .expect("body");
        let out = String::from_utf8(bytes.to_vec()).expect("utf8");

        // Measured against BC125AT SS reading a real radio, 2026-08-29.
        assert!(
            out.contains("C-Freq\t429\t\t123000000\tAM\tC100.0\t"),
            "CTCSS must be written as C100.0"
        );
        assert!(
            out.contains("C-Freq\t430\t\t462562500\tNFM\tD023\t"),
            "DCS must be written as D023"
        );
        assert!(
            !out.contains("DCS 023"),
            "the UI's `DCS 023` label must never reach the file"
        );
    }

    /// GOLDEN TEST: the `.bc125at_ss` we write must match the shape of a file
    /// written by Uniden's own tool.
    ///
    /// `fixtures/blank.bc125at_ss` is a `New` -> `Save As` from the real
    /// software: 500 empty channels and nothing else, so it is pure structure
    /// with no operator data in it at all.
    ///
    /// REGRESSION GUARD: banks and channels INTERLEAVE. Bearpaw emitted all ten
    /// `Conventional` lines and then all 500 `C-Freq` lines. That survived
    /// review of three real files because the analysis aggregated lines by
    /// section NAME regardless of position, which makes grouped and
    /// interleaved indistinguishable. Only a sequence-exact comparison shows
    /// it -- which is what this test is.
    #[tokio::test]
    async fn bc125at_ss_export_matches_the_reference_file_shape() {
        let state = default_state();
        {
            let mut shadow = state.shadow.write().unwrap();
            for idx in 1..=500u16 {
                shadow.channels.insert(
                    idx,
                    ChannelData {
                        index: idx,
                        ..Default::default()
                    },
                );
            }
        }
        let _scanner = FakeScanner::attach(&state, |cmd: &str| {
            Ok(match cmd {
                "BLT" => "BLT,AF".to_string(),
                "KBP" => "KBP,99,0".to_string(),
                "BSV" => "BSV,2".to_string(),
                "PRI" => "PRI,0".to_string(),
                "SCG" => "SCG,1111111111".to_string(),
                "SCO" => "SCO,1,0".to_string(),
                "CLC" => "CLC,0,0,0,11111,0".to_string(),
                "WXS" => "WXS,0".to_string(),
                "CNT" => "CNT,8".to_string(),
                "VOL" => "VOL,14".to_string(),
                "SQL" => "SQL,6".to_string(),
                c if c.starts_with("CSP,") => format!("{c},25000000,27995000"),
                c if c.starts_with("SSP,") => format!("{c},0"),
                _ => "OK".to_string(),
            })
        });

        let response =
            super::handlers::exports::export_bc125at_ss_file(axum::extract::State(state.clone()))
                .await
                .map_err(|e| format!("{e:?}"))
                .expect("export should succeed");
        let body = axum::response::IntoResponse::into_response(response);
        let bytes = axum::body::to_bytes(body.into_body(), usize::MAX)
            .await
            .expect("body");
        let ours = String::from_utf8(bytes.to_vec()).expect("utf8");

        let reference = include_str!("../../fixtures/blank.bc125at_ss");

        // Run-length encoded so a mismatch prints a readable diff.
        let shape = |text: &str| -> Vec<(String, usize, usize)> {
            let mut out: Vec<(String, usize, usize)> = Vec::new();
            for l in text.split("\r\n").filter(|l| !l.is_empty()) {
                let f: Vec<&str> = l.split('\t').collect();
                let key = f[0].to_string();
                match out.last_mut() {
                    Some((k, n, run)) if *k == key && *n == f.len() => *run += 1,
                    _ => out.push((key, f.len(), 1)),
                }
            }
            out
        };

        let ours_shape = shape(&ours);
        let ref_shape = shape(reference);

        // The load-bearing assertion: ten Conventional RUNS, not one.
        let conventional_runs = ours_shape
            .iter()
            .filter(|(k, _, _)| k == "Conventional")
            .count();
        assert_eq!(
            conventional_runs, 10,
            "each bank line must be followed by its own channels, not batched"
        );

        // `AvoidFreqs` is absent from a file with no lockouts (confirmed by the
        // blank), and Bearpaw never emits it (#459), so the shapes line up.
        assert_eq!(
            ours_shape, ref_shape,
            "section order and per-section field counts must match the reference"
        );

        // Uniden's own typo, present in every real file. It must NOT be fixed.
        assert!(ours.contains("Custom\t1\tSearch Bnak1\t"));
    }

    /// GOLDEN TEST: the `.bc75xlt_ss` we write must match the shape of a file
    /// written by Uniden's own tool.
    ///
    /// `fixtures/sample.bc75xlt_ss` is a real export with the channel
    /// frequencies replaced by neutral values -- the structure is byte-identical
    /// to the original, which carried a real operator's call sign and
    /// programming and does not belong in a public repository.
    ///
    /// Asserts the things that would make Uniden's software reject the file:
    /// section order, per-section field counts, CRLF, and the `Search Bank`
    /// spelling (the BC125AT tool writes `Search Bnak`; this one does not).
    #[tokio::test]
    async fn bc75xlt_ss_export_matches_the_reference_file_shape() {
        use crate::protocol::capabilities::BC75XLT;

        let state = default_state();
        state.device.write().unwrap().capabilities = Some(BC75XLT);
        {
            let mut shadow = state.shadow.write().unwrap();
            for idx in 1..=300u16 {
                let mut ch = ChannelData {
                    index: idx,
                    ..Default::default()
                };
                if idx <= 251 {
                    ch.frequency = 146.0 + f64::from(idx - 1) * 0.025;
                }
                // A REAL wire value for this model (boolean), not the 2 the
                // file carries -- otherwise this test passes whether or not
                // the exporter writes the constant.
                ch.delay = if idx <= 251 { 1 } else { 0 };
                shadow.channels.insert(idx, ch);
            }
        }
        // Exactly the replies this model gave on the wire, 2026-08-26.
        let _scanner = FakeScanner::attach(&state, |cmd: &str| {
            Ok(match cmd {
                "KBP" => "KBP,,0".to_string(),
                "SQL" => "SQL,2".to_string(),
                "PRI" => "PRI,0".to_string(),
                "SCO" => "SCO,2,,0".to_string(),
                "CLC" => "CLC,2,1,1,11101,".to_string(),
                "SCG" => "SCG,1111111111".to_string(),
                _ => "OK".to_string(),
            })
        });

        let response =
            super::handlers::exports::export_bc75xlt_ss_file(axum::extract::State(state.clone()))
                .await
                .map_err(|e| format!("{e:?}"))
                .expect("export should succeed");
        let body = axum::response::IntoResponse::into_response(response);
        let bytes = axum::body::to_bytes(body.into_body(), usize::MAX)
            .await
            .expect("body");
        let ours = String::from_utf8(bytes.to_vec()).expect("utf8");

        let reference = include_str!("../../fixtures/sample.bc75xlt_ss");

        // CRLF everywhere, including the trailing one.
        assert_eq!(
            ours.matches('\n').count(),
            ours.matches("\r\n").count(),
            "no bare LF may survive"
        );

        // Run-length encoded so a mismatch prints a readable diff rather than
        // 336 tuples.
        let shape = |text: &str| -> Vec<(String, usize, usize)> {
            let mut out: Vec<(String, usize, usize)> = Vec::new();
            for l in text.split("\r\n").filter(|l| !l.is_empty()) {
                let f: Vec<&str> = l.split('\t').collect();
                let key = f[0].to_string();
                match out.last_mut() {
                    Some((k, n, run)) if *k == key && *n == f.len() => *run += 1,
                    _ => out.push((key, f.len(), 1)),
                }
            }
            out
        };
        assert_eq!(
            shape(&ours),
            shape(reference),
            "section order and per-section field counts must match the reference file"
        );

        // Uniden fixed their "Search Bnak" typo in this tool. The BC125AT
        // writer must keep it; this one must not have it.
        assert!(ours.contains("Custom\t1\tSearch Bank1\t"));
        assert!(!ours.contains("Bnak"));

        // The reserved columns go out empty, as the real file has them.
        // Delay 2 despite the channel carrying wire delay 1: the tool writes a
        // constant here, and a file echoing the boolean would not match.
        assert!(ours.contains("C-Freq\t1\t\t146000000\t\t\tOff\t2\tOff\r\n"));
        assert!(
            !ours.contains("\tOff\t1\tOff"),
            "the wire delay must never reach the file"
        );
    }

    #[test]
    fn clearing_a_priority_channel_is_not_a_failure() {
        use crate::protocol::capabilities::BC75XLT;

        // What the upload sends for a clear of a priority channel...
        let mut wrote = test_channel();
        wrote.frequency = 0.0;
        wrote.priority = true;

        // ...and what the radio reports back: cleared, but priority stuck on.
        let mut readback = test_channel();
        readback.frequency = 0.0;
        readback.delay = BC75XLT.cleared_delay;
        readback.lockout = true;
        readback.priority = true;
        readback.tone_squelch_kind = crate::state::ToneSquelchKind::None;

        assert!(
            readback_matches(&wrote, &readback, "", &BC75XLT),
            "the write landed exactly as sent; a priority bit the firmware \
             refuses to clear must not be reported as a failed write"
        );

        // The strict predicate must stay strict -- clear_channel_priority
        // depends on it to detect exactly this stuck bit.
        assert!(
            !is_factory_empty(&readback, &BC75XLT),
            "is_factory_empty itself must still require priority to be clear"
        );
    }

    /// The tolerance is narrow: it applies only when we DELIBERATELY wrote
    /// priority=1. A clear that asked for priority=0 and read back 1 is a
    /// genuine failure and must still be reported.
    #[test]
    fn a_clear_that_did_not_ask_for_priority_still_fails_on_a_stuck_bit() {
        use crate::protocol::capabilities::BC75XLT;

        let mut wrote = test_channel();
        wrote.frequency = 0.0;
        wrote.priority = false;

        let mut readback = test_channel();
        readback.frequency = 0.0;
        readback.delay = BC75XLT.cleared_delay;
        readback.lockout = true;
        readback.priority = true;
        readback.tone_squelch_kind = crate::state::ToneSquelchKind::None;

        assert!(
            !readback_matches(&wrote, &readback, "", &BC75XLT),
            "we did not write the priority bit, so its being set is a real \
             mismatch, not a firmware refusal"
        );
    }

    /// The other fields still have to match. Tolerating the priority bit must
    /// not turn the clear check into "anything with frequency 0 passes".
    #[test]
    fn a_clear_with_the_wrong_delay_still_fails() {
        use crate::protocol::capabilities::BC75XLT;

        let mut wrote = test_channel();
        wrote.frequency = 0.0;
        wrote.priority = true;

        let mut readback = test_channel();
        readback.frequency = 0.0;
        readback.delay = 2; // a BC125AT value, wrong for this model
        readback.lockout = true;
        readback.priority = true;
        readback.tone_squelch_kind = crate::state::ToneSquelchKind::None;

        assert!(!readback_matches(&wrote, &readback, "", &BC75XLT));
    }

    #[test]
    fn factory_empty_signature_follows_the_model() {
        use crate::protocol::capabilities::BC75XLT;

        let mut cleared = test_channel();
        cleared.frequency = 0.0;
        cleared.lockout = true;
        cleared.priority = false;
        cleared.tone_squelch_kind = crate::state::ToneSquelchKind::None;

        // As a BC125AT reports a cleared slot.
        cleared.delay = 2;
        assert!(is_factory_empty(&cleared, &BC125AT_FAMILY));
        assert!(
            !is_factory_empty(&cleared, &BC75XLT),
            "delay 2 is not what a BC75XLT reports for an empty slot"
        );

        // As a BC75XLT reports one: CIN,299 -> CIN,299,,00000000,,,0,1,0
        cleared.delay = 0;
        assert!(is_factory_empty(&cleared, &BC75XLT));
        assert!(
            !is_factory_empty(&cleared, &BC125AT_FAMILY),
            "delay 0 is not what a BC125AT reports either — this is not a \
             sentinel, it is a real per-model value"
        );
    }

    /// REGRESSION GUARD (#479): the swap sends `DCH` only where `DCH` exists.
    ///
    /// A BC75XLT has no `DCH` and refuses an in-place priority clear, so the
    /// clear step failed and aborted every swap -- by design, per the atomicity
    /// guard. It needs no clear: its firmware moves the flag within a bank
    /// itself (hardware 2026-08-28, findings.md §8).
    ///
    /// Paired on purpose. Asserting only the BC75XLT half would pass for a
    /// build that never cleared on ANY model, which would silently leave a
    /// BC125AT bank holding two priority channels.
    async fn priority_swap_transcript(
        caps: crate::protocol::capabilities::ScannerCapabilities,
    ) -> Vec<String> {
        let state = default_state();
        state.device.write().unwrap().capabilities = Some(caps);
        {
            let mut shadow = state.shadow.write().unwrap();
            for (index, priority) in [(2u16, true), (9u16, false)] {
                shadow.channels.insert(
                    index,
                    ChannelData {
                        index,
                        frequency: 146.52,
                        priority,
                        ..Default::default()
                    },
                );
            }
        }
        // Delay 0, not the shared responder's 2. Delay is a boolean on a
        // BC75XLT, so a channel carrying 2 cannot exist there and
        // `build_cin_write_payload_for` rejects it before the wire -- the swap
        // would fail for a reason that has nothing to do with the clear. 0 is
        // valid on both models, so the pair differs ONLY by capabilities.
        let scanner = FakeScanner::attach(&state, |command: &str| {
            if command == "PRG" {
                return Ok("PRG,OK\r".to_string());
            }
            if command == "EPG" {
                return Ok("EPG,OK\r".to_string());
            }
            if command.starts_with("DCH,") {
                return Ok("DCH,OK\r".to_string());
            }
            if let Some(rest) = command.strip_prefix("CIN,") {
                let mut fields = rest.splitn(2, ',');
                let index: u16 = fields.next().unwrap_or("").parse().unwrap_or(0);
                match fields.next() {
                    Some(payload) => {
                        let wrote_priority = payload.rsplit(',').next() == Some("1");
                        WROTE_PRIORITY.with(|w| {
                            w.borrow_mut().insert(index, wrote_priority);
                        });
                        return Ok("CIN,OK\r".to_string());
                    }
                    None => {
                        let priority = WROTE_PRIORITY
                            .with(|w| w.borrow().get(&index).copied())
                            .unwrap_or(index == 2);
                        return Ok(format!(
                            "CIN,{index},,01451300,,,0,0,{}\r",
                            if priority { 1 } else { 0 }
                        ));
                    }
                }
            }
            Ok("OK\r".to_string())
        });
        let _ = set_channel_priority(&state, 9).await;
        scanner.transcript_with_closed_bracket()
    }

    /// Seed one channel into the shadow with the given priority flag.
    fn shadow_with_priority(state: &AppState, index: u16, priority: bool) {
        state.shadow.write().unwrap().channels.insert(
            index,
            ChannelData {
                index,
                frequency: 145.13,
                priority,
                ..Default::default()
            },
        );
    }

    fn shadow_priority(state: &AppState, index: u16) -> Option<bool> {
        state
            .shadow
            .read()
            .unwrap()
            .channels
            .get(&index)
            .map(|c| c.priority)
    }

    /// REGRESSION GUARD: a priority clear writes its verified result to the
    /// shadow, so the cache stops disagreeing with the radio.
    ///
    /// `clear_channel_priority_locked` read the channel, ran DCH+rewrite,
    /// read-back-verified, and then RETURNED the readback without storing it.
    /// Its sibling `set_channel_priority` inserts into the shadow three times.
    /// The asymmetry was invisible until #413: the stale flag used to be
    /// cleared by the next launch's memory sync, and is now flushed to SQLite
    /// within CHANNEL_CACHE_FLUSH_SECS and re-adopted at every connect.
    #[tokio::test]
    async fn a_priority_clear_updates_the_shadow() {
        let state = default_state();
        shadow_with_priority(&state, 5, true);

        // Priority starts set on the radio and is cleared by the DCH+rewrite.
        let cleared = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = cleared.clone();
        let _scanner = FakeScanner::attach(&state, move |command: &str| {
            if command == "PRG" {
                return Ok("PRG,OK\r".to_string());
            }
            if command == "EPG" {
                return Ok("EPG,OK\r".to_string());
            }
            if command.starts_with("DCH,") {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
                return Ok("DCH,OK\r".to_string());
            }
            if let Some(rest) = command.strip_prefix("CIN,") {
                let mut fields = rest.splitn(2, ',');
                let index: u16 = fields.next().unwrap_or("").parse().unwrap_or(0);
                if fields.next().is_some() {
                    return Ok("CIN,OK\r".to_string());
                }
                let priority = !flag.load(std::sync::atomic::Ordering::Relaxed);
                return Ok(format!(
                    "CIN,{index},,01451300,,,0,0,{}\r",
                    if priority { 1 } else { 0 }
                ));
            }
            Ok("OK\r".to_string())
        });

        let result = clear_channel_priority(&state, 5).await;
        assert!(result.is_ok(), "the clear must succeed: {result:?}");

        assert_eq!(
            shadow_priority(&state, 5),
            Some(false),
            "the verified readback must land in the shadow, not be returned and dropped"
        );
    }

    /// REGRESSION GUARD: the no-op branch heals a shadow that is already stale.
    ///
    /// `needs_priority_clear` short-circuits when the radio says the channel
    /// does not hold priority -- which is exactly the state a stale shadow
    /// produces, because something else displaced the flag on hardware (a plain
    /// `CIN` write can set priority and displace the bank's previous holder,
    /// see the #198 guard). Returning early without storing that read leaves the
    /// cache wrong forever under #413. The read is already paid for; storing it
    /// is free.
    #[tokio::test]
    async fn a_no_op_priority_clear_heals_a_stale_shadow() {
        let state = default_state();
        // The shadow believes channel 5 holds priority; the radio disagrees.
        shadow_with_priority(&state, 5, true);

        let _scanner = FakeScanner::attach(&state, |command: &str| {
            if command == "PRG" {
                return Ok("PRG,OK\r".to_string());
            }
            if command == "EPG" {
                return Ok("EPG,OK\r".to_string());
            }
            if command.starts_with("DCH,") {
                panic!("a channel the radio does not flag must never be DCH-wiped");
            }
            if let Some(rest) = command.strip_prefix("CIN,") {
                let index: u16 = rest.split(',').next().unwrap_or("").parse().unwrap_or(0);
                return Ok(format!("CIN,{index},,01451300,,,0,0,0\r"));
            }
            Ok("OK\r".to_string())
        });

        let result = clear_channel_priority(&state, 5).await;
        assert!(result.is_ok(), "a no-op clear is success: {result:?}");

        assert_eq!(
            shadow_priority(&state, 5),
            Some(false),
            "a clear that finds nothing to clear must still correct the cache"
        );
    }

    #[tokio::test]
    async fn priority_swap_skips_the_clear_where_the_firmware_owns_it() {
        use crate::protocol::capabilities::BC75XLT;

        let sent = priority_swap_transcript(BC75XLT).await;
        assert!(
            !sent.iter().any(|c| c.starts_with("DCH")),
            "a BC75XLT has no DCH; sending one aborts the whole swap: {sent:?}"
        );
        assert!(
            sent.iter().any(|c| c.starts_with("CIN,9,")),
            "the new priority channel must still be written: {sent:?}"
        );
        // The old channel is re-read AFTER the set, so the shadow cache does
        // not keep showing a priority channel the radio already cleared.
        let set_at = sent.iter().position(|c| c.starts_with("CIN,9,")).unwrap();
        let reread_at = sent.iter().rposition(|c| c == "CIN,2");
        assert!(
            reread_at.is_some_and(|at| at > set_at),
            "the auto-cleared channel must be re-read after the set: {sent:?}"
        );
    }

    #[tokio::test]
    async fn priority_swap_still_clears_where_bearpaw_owns_it() {
        let sent = priority_swap_transcript(BC125AT_FAMILY).await;
        assert!(
            sent.iter().any(|c| c.starts_with("DCH,2")),
            "a BC125AT firmware does not auto-swap; the old channel must be \
             explicitly cleared or the bank keeps two: {sent:?}"
        );
    }

    // REGRESSION GUARD (priority swap atomicity): where the FIRMWARE owns the
    // swap, the post-set re-read of the old channel is informational -- it
    // refreshes the shadow cache after the radio's own auto-clear. A failed
    // re-read must not fail the swap. By the time it runs, the `CIN` write has
    // already been sent AND verified by readback, so propagating its error
    // reports a failure for a change the scanner has committed: the user sees
    // the swap fail, retries, and the bank was right the first time.
    //
    // This mirrors the `warn!` in the same branch that declines to call a
    // missed auto-clear a failed request. Both say the same thing: the
    // requested channel DID get priority, so report the truth rather than a
    // tidy fiction.
    //
    // The BC75XLT is the model where this bites, and not by coincidence -- it
    // is the CP210x scanner, where a first-command-after-open `ERR` is
    // documented behaviour (CLAUDE.md backend pitfall #11), so the transient
    // this guards against is expected rather than hypothetical.
    #[tokio::test]
    async fn priority_swap_survives_a_failed_post_set_reread() {
        use crate::protocol::capabilities::BC75XLT;

        let state = default_state();
        state.device.write().unwrap().capabilities = Some(BC75XLT);
        {
            let mut shadow = state.shadow.write().unwrap();
            for (index, priority) in [(2u16, true), (9u16, false)] {
                shadow.channels.insert(
                    index,
                    ChannelData {
                        index,
                        frequency: 146.52,
                        priority,
                        ..Default::default()
                    },
                );
            }
        }

        let _scanner = FakeScanner::attach(&state, |command: &str| match command {
            "PRG" => Ok("PRG,OK\r".to_string()),
            "EPG" => Ok("EPG,OK\r".to_string()),
            // The informational re-read of the auto-cleared old channel: the
            // one round-trip this test fails. `ERR` does not parse as a CIN
            // frame, so `read_channel_from_scanner` gives `channel_read_failed`.
            "CIN,2" => Ok("ERR\r".to_string()),
            // Both the pre-read and the post-write readback of the new channel.
            // A fixed reply is enough: the pre-read is only checked for a
            // non-zero frequency, the readback only for the priority bit.
            "CIN,9" => Ok("CIN,9,,01451300,,,0,0,1\r".to_string()),
            _ => Ok("CIN,OK\r".to_string()),
        });

        let changed = set_channel_priority(&state, 9)
            .await
            .expect("a swap whose CIN write succeeded must not be reported as failed");

        assert!(
            changed.iter().any(|c| c.index == 9 && c.priority),
            "the newly-set priority channel must still be reported: {changed:?}"
        );
        assert!(
            !changed.iter().any(|c| c.index == 2),
            "the old channel could not be read, so it must not be reported as \
             changed -- fabricating a cleared state asserts something the \
             scanner never confirmed: {changed:?}"
        );
        assert!(
            state
                .shadow
                .read()
                .unwrap()
                .channels
                .get(&9)
                .is_some_and(|c| c.priority),
            "the committed write must reach the shadow cache"
        );
    }

    #[test]
    fn plan_priority_swap_orders_clear_before_set() {
        // The planner half of the atomicity contract: it must identify the
        // old-to-clear target so the swap clears it BEFORE setting the new one.
        // The abort-on-failure half is now covered end-to-end by
        // `failed_priority_clear_aborts_the_swap` (#249), which drives a fake
        // scanner that ERRs the DCH round-trip.
        use std::collections::HashMap;
        let mut ch = HashMap::new();
        let mut c2 = test_channel();
        c2.index = 2;
        c2.priority = true;
        ch.insert(2, c2);
        let (old, new) = plan_priority_swap(&ch, 9, &BC125AT_FAMILY);
        assert_eq!(
            old,
            Some(2),
            "old priority channel must be identified so the swap clears it before setting the new one"
        );
        assert_eq!(new, 9);
    }

    /// Seed the shadow cache so `plan_priority_swap` sees CH2 as bank 1's
    /// current priority channel and CH9 as the new target.
    fn seed_bank_with_priority_on_two(state: &AppState) {
        let mut shadow = state.shadow.write().unwrap();
        for index in [2u16, 9u16] {
            let mut ch = test_channel();
            ch.index = index;
            ch.bank = 1;
            ch.priority = index == 2;
            shadow.channels.insert(index, ch);
        }
    }

    // REGRESSION GUARD (priority swap atomicity, #249): the abort-path half of
    // the contract that `plan_priority_swap_orders_clear_before_set` could only
    // prove structurally. A failed clear must ABORT the swap — the new channel
    // is never set — so the bank can't end up with two priority channels or a
    // DCH-deleted, unrestored one. Enforced by the `?` on
    // `clear_channel_priority_locked(...).await?` in `set_channel_priority`.
    #[tokio::test]
    async fn failed_priority_clear_aborts_the_swap() {
        let state = default_state();
        seed_bank_with_priority_on_two(&state);
        // The clear's DCH round-trip fails: connected, but the command ERRs.
        let scanner = FakeScanner::attach(&state, scanner_responder(Some("DCH,"), |i| i == 2));

        let result = set_channel_priority(&state, 9).await;

        assert!(
            result.is_err(),
            "a failed clear must surface as an error, not a partial success"
        );

        // The load-bearing assertion: no CIN WRITE to the new channel. A write
        // is `CIN,9,<payload>`; a read is bare `CIN,9`.
        let writes: Vec<String> = scanner
            .commands_starting_with("CIN,9,")
            .into_iter()
            .collect();
        assert!(
            writes.is_empty(),
            "new priority channel must NOT be set after a failed clear, but saw: {writes:?}"
        );

        // And the shadow cache must not claim CH9 became priority.
        let shadow = state.shadow.read().unwrap();
        assert!(
            !shadow.channels.get(&9).map(|c| c.priority).unwrap_or(false),
            "shadow cache must not record the aborted set"
        );
    }

    // The clear runs BEFORE the set, inside one program-mode bracket.
    #[tokio::test]
    async fn priority_swap_clears_old_before_setting_new() {
        let state = default_state();
        seed_bank_with_priority_on_two(&state);
        let scanner = FakeScanner::attach(&state, scanner_responder(None, |i| i == 2));

        let changed = set_channel_priority(&state, 9)
            .await
            .expect("swap should succeed when every round-trip is OK");

        let transcript = scanner.transcript();
        let dch_at = transcript.iter().position(|c| c.starts_with("DCH,2"));
        let set_at = transcript.iter().position(|c| c.starts_with("CIN,9,"));
        assert!(
            dch_at.is_some(),
            "expected a DCH clearing CH2: {transcript:?}"
        );
        assert!(
            set_at.is_some(),
            "expected a CIN write setting CH9: {transcript:?}"
        );
        assert!(
            dch_at < set_at,
            "clear must precede set, got transcript: {transcript:?}"
        );

        // Both the cleared-old and the set-new channel come back.
        assert_eq!(changed.len(), 2, "expected cleared-old then set-new");
        assert_eq!(changed[0].index, 2);
        assert!(!changed[0].priority, "old channel must come back cleared");
        assert_eq!(changed[1].index, 9);
        assert!(changed[1].priority, "new channel must come back set");
    }

    // Endpoint happy path (#249): `true` sets and `false` clears, through HTTP.
    #[tokio::test]
    async fn priority_endpoint_sets_and_clears_over_http() {
        let state = default_state();
        seed_bank_with_priority_on_two(&state);
        let _scanner = FakeScanner::attach(&state, scanner_responder(None, |i| i == 2));

        let app = router(state.clone());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/memory/channels/9/priority")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"priority":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "set-priority should succeed");
        let body = json_body(response).await;
        let changed = body["changed"].as_array().expect("changed array");
        assert!(
            changed
                .iter()
                .any(|c| c["index"] == 9 && c["priority"] == true),
            "response should report CH9 as the new priority channel: {body}"
        );

        // Now clear it back through the same endpoint.
        let app = router(state.clone());
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/memory/channels/9/priority")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"priority":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200, "clear-priority should succeed");
        let body = json_body(response).await;
        let changed = body["changed"].as_array().expect("changed array");
        assert!(
            changed
                .iter()
                .any(|c| c["index"] == 9 && c["priority"] == false),
            "response should report CH9 as cleared: {body}"
        );
    }

    // ---------------------------------------------------------------------
    // Route manifest (frontend contract, part A)
    //
    // The frontend's contract test used to assert string literals against
    // regexes of themselves (`expect('/api/v1/health').toMatch(/health$/)`),
    // which passes whether or not the route exists. This test is the real
    // half: it probes the actual router and writes the surviving paths to
    // `target/api-route-manifest.json`, which the TS contract test reads.
    //
    // A path is "routed" if it answers anything but a *routing* 404. We
    // cannot assert 200 — most handlers need a connected scanner and
    // correctly return 503. We also cannot treat every 404 as missing:
    // `GET /memory/channels/1` legitimately 404s with `{"error":"not_found"}`
    // when the channel isn't cached. Axum's routing 404 has an empty body,
    // a handler's has a JSON error — so the body is what separates "no such
    // route" (the drift this guards: renames, axum 0.8 `{param}` migrations,
    // a handler dropped from the router) from "route ran, found nothing".
    const FRONTEND_ROUTES: &[(&str, &str)] = &[
        ("GET", "/api/v1/health"),
        ("GET", "/api/v1/status"),
        ("GET", "/api/v1/device/info"),
        ("GET", "/api/v1/banks"),
        ("POST", "/api/v1/banks"),
        ("POST", "/api/v1/commands/hold"),
        ("POST", "/api/v1/commands/scan"),
        ("POST", "/api/v1/commands/key"),
        ("POST", "/api/v1/commands/lockout"),
        ("GET", "/api/v1/volume"),
        ("POST", "/api/v1/volume"),
        ("GET", "/api/v1/squelch"),
        ("POST", "/api/v1/squelch"),
        ("GET", "/api/v1/settings/all"),
        ("GET", "/api/v1/settings/backlight"),
        ("POST", "/api/v1/settings/backlight"),
        ("GET", "/api/v1/settings/battery"),
        ("POST", "/api/v1/settings/battery"),
        ("GET", "/api/v1/settings/key-beep"),
        ("POST", "/api/v1/settings/key-beep"),
        ("GET", "/api/v1/settings/priority"),
        ("POST", "/api/v1/settings/priority"),
        ("GET", "/api/v1/settings/search"),
        ("GET", "/api/v1/settings/close-call"),
        ("POST", "/api/v1/settings/close-call"),
        ("GET", "/api/v1/settings/service-search"),
        ("POST", "/api/v1/settings/service-search"),
        ("GET", "/api/v1/settings/custom-search"),
        ("POST", "/api/v1/settings/custom-search"),
        ("GET", "/api/v1/settings/weather"),
        ("GET", "/api/v1/settings/contrast"),
        ("POST", "/api/v1/settings/contrast"),
        ("POST", "/api/v1/lockouts/temporary/clear"),
        ("POST", "/api/v1/lockouts/clear"),
        ("POST", "/api/v1/lockouts/channels/clear"),
        ("GET", "/api/v1/lockouts"),
        ("DELETE", "/api/v1/lockouts/frequencies"),
        ("GET", "/api/v1/memory/channels"),
        ("POST", "/api/v1/memory/sync"),
        ("POST", "/api/v1/memory/sync/cancel"),
        ("GET", "/api/v1/memory/sync/status"),
        ("POST", "/api/v1/memory/program-mode/start"),
        ("POST", "/api/v1/memory/program-mode/end"),
        ("GET", "/api/v1/memory/export/csv"),
        ("GET", "/api/v1/memory/export/bc125at_ss"),
        ("GET", "/api/v1/memory/export/bc75xlt_ss"),
        ("GET", "/api/v1/preferences"),
        ("POST", "/api/v1/preferences"),
        ("POST", "/api/v1/preferences/reset"),
        ("GET", "/api/v1/analytics/activity-log"),
        ("GET", "/api/v1/analytics/busiest-channels"),
        ("GET", "/api/v1/analytics/hourly-heatmap"),
        ("GET", "/api/v1/analytics/session-stats"),
        // Path-param routes, probed with a concrete value.
        ("GET", "/api/v1/memory/channels/1"),
        ("POST", "/api/v1/memory/channels/1/priority"),
        ("GET", "/api/v1/settings/custom-search/ranges/1"),
        ("POST", "/api/v1/settings/custom-search/ranges/1"),
        ("PUT", "/api/v1/memory/channels/1"),
        ("POST", "/api/v1/settings/search"),
        ("POST", "/api/v1/settings/weather"),
        ("POST", "/api/v1/memory/import/csv"),
        // Both SS import routes were absent from this list -- the manifest
        // never covered them, so route drift on either would have gone unseen.
        ("POST", "/api/v1/memory/import/bc125at_ss"),
        ("POST", "/api/v1/memory/import/bc75xlt_ss"),
        ("GET", "/api/v1/preferences/theme"),
        ("PUT", "/api/v1/preferences/theme"),
        ("PUT", "/api/v1/preferences"),
    ];

    #[tokio::test]
    async fn frontend_routes_are_all_routed_and_manifest_is_written() {
        let mut missing = Vec::new();
        let mut manifest = Vec::new();

        for (method, path) in FRONTEND_ROUTES {
            let app = router(default_state());
            let response = app
                .oneshot(
                    Request::builder()
                        .method(*method)
                        .uri(*path)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            let status = response.status();
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            if status == StatusCode::NOT_FOUND && body.is_empty() {
                missing.push(format!("{method} {path}"));
            } else {
                manifest.push(serde_json::json!({ "method": method, "path": path }));
            }
        }

        assert!(
            missing.is_empty(),
            "these paths are called by the frontend but 404 on the real router: {missing:#?}"
        );

        // The manifest is COMMITTED (not written to gitignored target/) so the
        // frontend CI job can read it without a Rust toolchain — the two jobs
        // are independent and the frontend one has no cargo. Committing it also
        // makes drift visible: this test rewrites the file, so a route change
        // that isn't reflected in the checked-in manifest shows up as a dirty
        // working tree in CI rather than passing silently.
        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../frontend/src/test/fixtures/api-route-manifest.json");
        let rendered = serde_json::to_string_pretty(&serde_json::json!({ "routes": manifest }))
            .unwrap()
            + "\n";
        let existing = std::fs::read_to_string(&out).unwrap_or_default();
        if existing != rendered {
            std::fs::write(&out, &rendered).expect("write route manifest");
            panic!(
                "api-route-manifest.json was stale and has been regenerated. \
                 Commit the updated file: {}",
                out.display()
            );
        }
    }

    /// REGRESSION GUARD (#432): a settings command is never sent to a scanner
    /// that does not implement it.
    ///
    /// A BC75XLT replies `ERR` to BLT, BSV, CNT, and WXS (settings probe
    /// 2026-08-26). `GET /settings` fires on every Device tab visit, so
    /// sending them meant four guaranteed-failing round-trips and four logged
    /// errors each time — and KBP is program-mode-only on that model, which
    /// `get_config` does not bracket.
    ///
    /// `SSG` joined the list for a different reason: it is absent from the
    /// BC75XLT's command table entirely, so that model has no service-search
    /// avoid mask to read.
    #[tokio::test]
    async fn settings_snapshot_skips_commands_the_scanner_lacks() {
        use crate::protocol::capabilities::BC75XLT;

        let state = default_state();
        state.device.write().unwrap().capabilities = Some(BC75XLT);
        let fake = FakeScanner::attach(&state, scanner_responder(None, |_| false));

        let _ = read_settings_snapshot_from_scanner(&state).await;
        let sent = fake.transcript();

        for cmd in ["BLT", "BSV", "CNT", "WXS", "KBP", "SSG"] {
            assert!(
                !sent.iter().any(|c| c == cmd),
                "{cmd} must not be sent to a scanner that cannot answer it: {sent:?}"
            );
        }
        // The commands it DOES implement still go out — a gate that skipped
        // everything would pass the assertions above.
        assert!(
            sent.iter().any(|c| c == "VER"),
            "supported reads must still happen: {sent:?}"
        );
    }

    /// The paired half: a BC125AT-family scanner still gets all of them.
    #[tokio::test]
    async fn settings_snapshot_still_reads_everything_on_a_bc125at() {
        let state = default_state();
        state.device.write().unwrap().capabilities = Some(BC125AT_FAMILY);
        let fake = FakeScanner::attach(&state, scanner_responder(None, |_| false));

        let _ = read_settings_snapshot_from_scanner(&state).await;
        let sent = fake.transcript();

        for cmd in ["BLT", "BSV", "CNT", "WXS", "KBP", "SSG"] {
            assert!(
                sent.iter().any(|c| c == cmd),
                "{cmd} must still be read on a BC125AT: {sent:?}"
            );
        }
    }

    /// REGRESSION GUARD (#402): a CIN write must not put values in fields the
    /// scanner reserves, and must not send a delay the scanner rejects.
    ///
    /// The BC75XLT's set form is
    /// `CIN,[INDEX],[RSV],[FRQ],[RSV],[RSV],[DLY],[LOUT],[PRI]`. The vendor
    /// spec says *"The set command is aborted if any format error is
    /// detected"*, so a rejected reserved field does not merely fail to set
    /// that field -- it silently discards the frequency, lockout, and priority
    /// in the same command. An empty field is the correct value: *"In set
    /// command, only `,` parameters are not changed."*
    #[test]
    fn cin_write_leaves_reserved_fields_empty_on_a_bc75xlt() {
        use crate::protocol::capabilities::{BC125AT_FAMILY, BC75XLT};

        let mut ch = test_channel();
        ch.alpha_tag = "Ararat UHF".to_string();
        ch.modulation = "FM".to_string();
        ch.delay = 2;

        let bc125 = build_cin_write_payload_for(&ch, &BC125AT_FAMILY).unwrap();
        let parts: Vec<&str> = bc125.split(',').collect();
        assert_eq!(parts[0].trim(), "Ararat UHF", "tag is written on a BC125AT");
        assert_eq!(parts[2], "FM", "modulation is written on a BC125AT");
        assert!(!parts[3].is_empty(), "tone code is written on a BC125AT");

        // Same channel, boolean delay so it is writable on this model.
        ch.delay = 1;
        let bc75 = build_cin_write_payload_for(&ch, &BC75XLT).unwrap();
        let parts: Vec<&str> = bc75.split(',').collect();
        assert_eq!(parts.len(), 7, "field COUNT is identical across models");
        assert_eq!(parts[0], "", "alpha tag field is [RSV]");
        assert_eq!(parts[2], "", "modulation field is [RSV]");
        assert_eq!(parts[3], "", "tone field is [RSV]");
        assert_eq!(parts[4], "1", "delay still goes on the wire");
        assert_eq!(
            parts[1],
            bc125.split(',').collect::<Vec<_>>()[1],
            "frequency unchanged"
        );
    }

    /// A delay the model cannot accept must be refused BEFORE the wire.
    ///
    /// Sending 2 to a BC75XLT is a format error, and a format error aborts the
    /// whole set command -- so this is not "the delay does not take", it is
    /// "the entire channel write is silently discarded".
    #[test]
    fn cin_write_refuses_a_delay_the_model_rejects() {
        use crate::protocol::capabilities::{BC125AT_FAMILY, BC75XLT};

        let mut ch = test_channel();

        ch.delay = 2;
        assert!(build_cin_write_payload_for(&ch, &BC125AT_FAMILY).is_ok());
        assert!(
            build_cin_write_payload_for(&ch, &BC75XLT).is_err(),
            "delay 2 is a format error on a BC75XLT and aborts the whole write"
        );

        ch.delay = -5;
        assert!(
            build_cin_write_payload_for(&ch, &BC125AT_FAMILY).is_ok(),
            "negative delays are pre-delays on the BC125AT family"
        );
        assert!(build_cin_write_payload_for(&ch, &BC75XLT).is_err());

        for d in [0, 1] {
            ch.delay = d;
            assert!(
                build_cin_write_payload_for(&ch, &BC75XLT).is_ok(),
                "delay {d} is valid on a BC75XLT"
            );
        }
    }

    /// REGRESSION GUARD (#401): banks follow the connected scanner's memory
    /// model, not a fixed divisor.
    ///
    /// Paired with `cin_does_not_derive_bank` in protocol/mod.rs. That one
    /// asserts the parser leaves `bank` unset; this one asserts it gets set
    /// correctly afterwards. Either alone would pass while banks were broken.
    ///
    /// The numbers come from hardware. Before the fix, 7 of 11 sampled BC75XLT
    /// channels were misfiled and channel 300 reported bank 6 instead of 10.
    /// Note channel 60 lands in bank 2 under BOTH models -- roughly a third of
    /// channels are correct by coincidence, which is why a spot check misses
    /// this.
    #[test]
    fn channels_with_banks_derives_per_model() {
        use crate::protocol::capabilities::{BC125AT_FAMILY, BC75XLT};

        fn state_with(caps: crate::protocol::capabilities::ScannerCapabilities) -> AppState {
            let state = default_state();
            state.device.write().unwrap().capabilities = Some(caps);
            {
                let mut shadow = state.shadow.write().unwrap();
                for index in [1u16, 30, 31, 60, 61, 300] {
                    shadow.channels.insert(
                        index,
                        ChannelData {
                            index,
                            frequency: 146.52,
                            ..Default::default()
                        },
                    );
                }
            }
            state
        }

        let bc125 = state_with(BC125AT_FAMILY);
        let banks: Vec<(u16, u8)> = bc125
            .channels_with_banks()
            .iter()
            .map(|c| (c.index, c.bank))
            .collect();
        assert_eq!(
            banks,
            vec![(1, 1), (30, 1), (31, 1), (60, 2), (61, 2), (300, 6)],
            "BC125AT family: banks of 50 -- unchanged from before #401"
        );

        let bc75 = state_with(BC75XLT);
        let banks: Vec<(u16, u8)> = bc75
            .channels_with_banks()
            .iter()
            .map(|c| (c.index, c.bank))
            .collect();
        assert_eq!(
            banks,
            vec![(1, 1), (30, 1), (31, 2), (60, 2), (61, 3), (300, 10)],
            "BC75XLT: banks of 30 -- channel 31 is bank 2, not 1; 300 is bank 10, not 6"
        );
    }

    /// Channel-index bounds follow the model too. A BC75XLT has no channel
    /// 301, so accepting one means a guaranteed `CIN,ERR` round-trip.
    #[test]
    fn channel_bounds_follow_the_model() {
        use crate::protocol::capabilities::{BC125AT_FAMILY, BC75XLT};

        let state = default_state();
        state.device.write().unwrap().capabilities = Some(BC75XLT);
        assert_eq!(state.capabilities().channel_count, 300);

        state.device.write().unwrap().capabilities = Some(BC125AT_FAMILY);
        assert_eq!(state.capabilities().channel_count, 500);

        // No scanner connected: BC125AT-family defaults preserve today's
        // behaviour rather than leaving callers with a third state to handle.
        let fresh = default_state();
        assert_eq!(fresh.capabilities().channel_count, 500);
    }

    /// Serialize every capability descriptor to a committed fixture the
    /// frontend asserts against.
    ///
    /// Same mechanism as the route manifest above and for the same reason: a
    /// hand-written TypeScript fixture passes whether or not it matches what
    /// Rust actually emits, so it cannot catch the drift it exists to catch.
    /// Renaming a field or changing `valid_delays` from a list to a range
    /// fails here (stale fixture, dirty tree in CI) instead of silently
    /// producing `undefined` in the UI.
    #[test]
    fn capability_manifest_is_written_for_the_frontend() {
        use crate::protocol::capabilities::ScannerCapabilities;

        let mut manifest = serde_json::Map::new();
        for model in crate::config::ACCEPTED_MDL_MODELS {
            let caps = ScannerCapabilities::for_model(model)
                .unwrap_or_else(|| panic!("{model} is allowlisted but has no descriptor"));
            manifest.insert(
                model.to_string(),
                serde_json::to_value(caps).expect("capabilities serialize"),
            );
        }

        let out = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../frontend/src/test/fixtures/scanner-capabilities.json");
        let rendered =
            serde_json::to_string_pretty(&serde_json::Value::Object(manifest)).unwrap() + "\n";
        let existing = std::fs::read_to_string(&out).unwrap_or_default();
        if existing != rendered {
            std::fs::write(&out, &rendered).expect("write capability manifest");
            panic!(
                "scanner-capabilities.json was stale and has been regenerated. \
                 Commit the updated file: {}",
                out.display()
            );
        }
    }

    // ---------------------------------------------------------------------
    // Command path (frontend contract, part B)
    //
    // These answer "does clicking HOLD actually hold the scanner?" at the
    // highest fidelity available without hardware: an HTTP request goes into
    // the real router, and we assert the exact wire command that reaches the
    // scanner. The frontend component tests stop at "the button called its
    // prop"; these pick up at the HTTP boundary the client posts to.
    //
    // What this does NOT prove: that the physical BC125AT honors KEY,H,P.
    // FakeScanner believes whatever the responder says. Per the repo's
    // captures-win rule, only a wire capture or manual testing settles that.

    async fn post_empty(app: Router, uri: &str) -> StatusCode {
        app.oneshot(
            Request::builder()
                .method(Method::POST)
                .uri(uri)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
    }

    // The wire strings the poll loop sends, pinned against
    // docs/SCANNER_PROTOCOL_REFERENCE.md. The command-path tests below assert
    // literals; this is where the constants themselves are checked, so a
    // rename shows up here as one obvious failure instead of silently moving
    // both sides of every other assertion.
    #[test]
    fn key_constants_match_the_documented_wire_commands() {
        assert_eq!(poll::KEY_HOLD, "KEY,H,P");
        assert_eq!(poll::KEY_SCAN, "KEY,S,P");
    }

    #[tokio::test]
    async fn post_hold_sends_key_hold_to_the_scanner() {
        let state = default_state();
        let fake = FakeScanner::attach(&state, |_| Ok("KEY,OK".to_string()));
        let status = post_empty(router(state), "/api/v1/commands/hold").await;
        assert_eq!(status, StatusCode::OK);
        // Asserted as a LITERAL, not against poll::KEY_HOLD. Comparing the
        // constant to itself would pass even if the constant changed — the
        // wire string is the contract with the hardware, so it's spelled out.
        assert_eq!(
            fake.transcript(),
            vec!["KEY,H,P".to_string()],
            "POST /commands/hold must put exactly one KEY,H,P on the wire"
        );
    }

    #[tokio::test]
    async fn post_scan_sends_key_scan_to_the_scanner() {
        let state = default_state();
        let fake = FakeScanner::attach(&state, |_| Ok("KEY,OK".to_string()));
        let status = post_empty(router(state), "/api/v1/commands/scan").await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fake.transcript(), vec!["KEY,S,P".to_string()]);
    }

    #[tokio::test]
    async fn post_key_h_routes_through_the_same_hold_path() {
        // The UI's keypad sends POST /commands/key {"key":"H"} while the HOLD
        // button sends POST /commands/hold. Both must reach the same wire
        // command, or the two controls silently diverge.
        let state = default_state();
        let fake = FakeScanner::attach(&state, |_| Ok("KEY,OK".to_string()));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/commands/key")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"key":"H"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        // post_key is fire-and-forget (reply: None), so the command lands on
        // the channel without the handler awaiting it.
        for _ in 0..50 {
            if !fake.transcript().is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(fake.transcript(), vec!["KEY,H,P".to_string()]);
    }

    #[tokio::test]
    async fn hold_without_a_scanner_is_503_and_sends_nothing() {
        // No FakeScanner attached: command_tx is None. The handler must refuse
        // rather than hang or claim success.
        let state = default_state();
        *state.command_tx.lock().unwrap() = None;
        let status = post_empty(router(state), "/api/v1/commands/hold").await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }

    #[tokio::test]
    async fn post_key_rejects_a_key_outside_the_allowlist() {
        let state = default_state();
        let fake = FakeScanner::attach(&state, |_| Ok("KEY,OK".to_string()));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/commands/key")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"key":"; rm -rf /"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            fake.transcript().is_empty(),
            "a rejected key must never reach the wire"
        );
    }

    #[tokio::test]
    async fn setting_a_channel_priority_writes_it_to_the_scanner() {
        // The channel-edit path the UI's priority toggle drives. Asserts the
        // PRG bracket and that a CIN write for the target channel happens
        // inside it — the ordering the priority-swap guard depends on.
        let state = default_state();
        let fake = FakeScanner::attach(&state, scanner_responder(None, |_| false));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/memory/channels/5/priority")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"priority":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let transcript = fake.transcript_with_closed_bracket();
        assert!(
            transcript.iter().any(|c| c == "PRG"),
            "priority write must open a program-mode bracket: {transcript:?}"
        );
        assert!(
            transcript.iter().any(|c| c == "EPG"),
            "priority write must close the program-mode bracket: {transcript:?}"
        );
        assert!(
            transcript.iter().any(|c| c.starts_with("CIN,5,")),
            "expected a CIN write for channel 5: {transcript:?}"
        );
    }

    // ---------------------------------------------------------------------
    // Settings write paths
    //
    // One test per setting the Device tab can change, asserting the EXACT wire
    // command that reaches the scanner. These are the writes where a wrong
    // argument silently misconfigures the radio: the value is accepted, the
    // API returns 200, and nothing looks wrong until you read the front panel.
    //
    // Every assertion spells the wire string out as a literal. Comparing
    // against the handler's own format! would pass if the format changed.

    /// POST a JSON body to `uri` and return (status, wire transcript).
    async fn post_json_capture(uri: &str, body: &'static str) -> (StatusCode, Vec<String>) {
        let state = default_state();
        let fake = FakeScanner::attach(&state, |_| Ok("OK".to_string()));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        // Wait for the bracket to close before reading. EPG is fire-and-forget
        // from ProgramModeGuard::drop, so reading immediately races the fake
        // scanner's thread -- invisible locally, an unreproducible CI failure
        // under load. Only wait when the request succeeded: a rejected body
        // never opens a bracket, and those tests assert an EMPTY transcript.
        (response.status(), fake.transcript_with_closed_bracket())
    }

    /// The wire commands a settings write issues, with the PRG/EPG bracket
    /// stripped. Every settings write runs inside ProgramModeGuard, so the
    /// bracket is asserted once (below) rather than in all eleven tests.
    fn settings_payload(transcript: &[String]) -> Vec<String> {
        transcript
            .iter()
            .filter(|c| *c != "PRG" && *c != "EPG")
            .cloned()
            .collect()
    }

    /// A DELETE with a JSON body, which `post_json_capture` cannot send.
    async fn delete_json_capture(uri: &str, body: &'static str) -> (StatusCode, Vec<String>) {
        let state = default_state();
        let fake = FakeScanner::attach(&state, |_| Ok("OK".to_string()));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::DELETE)
                    .uri(uri)
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        (response.status(), fake.transcript())
    }

    #[tokio::test]
    async fn remove_global_lockout_sends_ulf_in_the_wire_encoding() {
        let (status, t) =
            delete_json_capture("/api/v1/lockouts/frequencies", r#"{"frequency":146.52}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["ULF,01465200"]);
        assert_eq!(t.first().map(String::as_str), Some("PRG"));
        assert_eq!(t.last().map(String::as_str), Some("EPG"));
    }

    /// REGRESSION GUARD (#522): validate BEFORE the wire, like every other
    /// frequency write (#402). A `LOF` outside the scanner's coverage is a
    /// value it cannot tune, and the vendor spec aborts on a format error --
    /// so it is rejected here rather than sent hopefully.
    #[tokio::test]
    async fn a_frequency_outside_coverage_never_reaches_the_wire() {
        // 700 MHz is outside every BC125AT band (25-54, 108-174, 225-380, 400-512).
        // Asserted on DELETE because that is the only verb this route has: the
        // add path was removed in #531, and the guard lives in the shared
        // `lockout_wire_value`.
        let (status, t) =
            delete_json_capture("/api/v1/lockouts/frequencies", r#"{"frequency":700.0}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(t.is_empty(), "nothing may be sent: {t:?}");
    }

    /// REGRESSION GUARD (#522): `covers_frequency` returns TRUE for 0.0,
    /// because 0 is the clear sentinel on the channel-write path. There is no
    /// such sentinel here -- a lockout on 0 Hz is meaningless -- so the zero
    /// case must be rejected explicitly rather than inherited from that helper.
    /// Reusing `covers_frequency` alone would send `LOF,00000000`.
    #[tokio::test]
    async fn zero_is_rejected_rather_than_inherited_as_the_clear_sentinel() {
        let (status, t) =
            delete_json_capture("/api/v1/lockouts/frequencies", r#"{"frequency":0}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(t.is_empty(), "nothing may be sent for 0: {t:?}");

        let (status, t) =
            delete_json_capture("/api/v1/lockouts/frequencies", r#"{"frequency":-5.0}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(t.is_empty(), "nothing may be sent for a negative: {t:?}");
    }

    #[tokio::test]
    async fn settings_writes_run_inside_a_program_mode_bracket() {
        let (status, transcript) =
            post_json_capture("/api/v1/settings/backlight", r#"{"event":"AO"}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            transcript.first().map(String::as_str),
            Some("PRG"),
            "a settings write must open program mode first: {transcript:?}"
        );
        assert_eq!(
            transcript.last().map(String::as_str),
            Some("EPG"),
            "a settings write must close program mode: {transcript:?}"
        );
    }

    #[tokio::test]
    async fn set_backlight_sends_blt() {
        let (status, t) =
            post_json_capture("/api/v1/settings/backlight", r#"{"event":"SQ"}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["BLT,SQ"]);
    }

    #[tokio::test]
    async fn set_backlight_rejects_an_unknown_event_without_touching_the_wire() {
        let (status, t) =
            post_json_capture("/api/v1/settings/backlight", r#"{"event":"XX"}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            settings_payload(&t).is_empty(),
            "a rejected backlight event must not reach the scanner: {t:?}"
        );
    }

    #[tokio::test]
    async fn set_battery_sends_bsv() {
        let (status, t) =
            post_json_capture("/api/v1/settings/battery", r#"{"charge_time":10}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["BSV,10"]);
    }

    #[tokio::test]
    async fn set_key_beep_encodes_level_and_lock() {
        // KBP,<level>,<lock> — lock is 1/0, not true/false.
        let (status, t) =
            post_json_capture("/api/v1/settings/key-beep", r#"{"level":7,"lock":true}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["KBP,7,1"]);
    }

    #[tokio::test]
    async fn set_key_beep_lock_false_is_zero() {
        let (status, t) =
            post_json_capture("/api/v1/settings/key-beep", r#"{"level":0,"lock":false}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["KBP,0,0"]);
    }

    #[tokio::test]
    async fn set_key_beep_rejects_an_out_of_range_level() {
        let (status, t) = post_json_capture("/api/v1/settings/key-beep", r#"{"level":42}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(settings_payload(&t).is_empty());
    }

    #[tokio::test]
    async fn set_priority_sends_pri() {
        let (status, t) = post_json_capture("/api/v1/settings/priority", r#"{"mode":2}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["PRI,2"]);
    }

    #[tokio::test]
    async fn set_search_encodes_delay_and_code_search() {
        let (status, t) = post_json_capture(
            "/api/v1/settings/search",
            r#"{"delay":3,"code_search":true}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["SCO,3,1"]);
    }

    #[tokio::test]
    async fn set_close_call_encodes_all_five_fields_in_order() {
        // CLC,<mode>,<alert_beep>,<alert_light>,<band_mask>,<lockout>.
        // Field order here is the whole contract — the band mask sitting in
        // the wrong slot is invisible from the API's 200 response.
        let (status, t) = post_json_capture(
            "/api/v1/settings/close-call",
            r#"{"mode":2,"alert_beep":true,"alert_light":false,"band":[true,false,true,false,true],"lockout":true}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["CLC,2,1,0,10101,1"]);
    }

    #[tokio::test]
    async fn set_close_call_rejects_a_band_mask_that_is_not_five_entries() {
        let (status, t) = post_json_capture(
            "/api/v1/settings/close-call",
            r#"{"mode":1,"band":[true,false]}"#,
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(settings_payload(&t).is_empty());
    }

    #[tokio::test]
    async fn set_service_search_sends_ssg() {
        let (status, t) = post_json_capture(
            "/api/v1/settings/service-search",
            r#"{"groups":[true,false,true,false,true,false,true,false,true,false]}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let payload = settings_payload(&t);
        assert_eq!(payload.len(), 1, "expected one SSG write: {payload:?}");
        assert!(
            payload[0].starts_with("SSG,"),
            "expected an SSG write: {payload:?}"
        );
    }

    /// The write half of the same guard: a stale client that still POSTs the
    /// service-search mask gets a named error instead of a bare `ERR` off the
    /// wire, and nothing reaches the scanner.
    #[tokio::test]
    async fn set_service_search_is_refused_without_ssg() {
        use crate::protocol::capabilities::BC75XLT;

        let state = default_state();
        state.device.write().unwrap().capabilities = Some(BC75XLT);
        let fake = FakeScanner::attach(&state, |_| Ok("OK".to_string()));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/settings/service-search")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"groups":[true,false,true,false,true,false,true,false,true,false]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            settings_payload(&fake.transcript()).is_empty(),
            "nothing may reach a scanner with no SSG command"
        );
    }

    /// A model whose `KBP` beep field is `[RSV]` must never be sent one. The
    /// vendor spec aborts the whole set command on a format error, so a write
    /// here would take the key lock down with it.
    #[tokio::test]
    async fn set_key_beep_is_refused_without_a_beep_field() {
        use crate::protocol::capabilities::BC75XLT;

        let state = default_state();
        state.device.write().unwrap().capabilities = Some(BC75XLT);
        let fake = FakeScanner::attach(&state, |_| Ok("OK".to_string()));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/settings/key-beep")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"level":1,"lock":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            settings_payload(&fake.transcript()).is_empty(),
            "nothing may reach a scanner whose KBP beep field is reserved"
        );
    }

    /// REGRESSION GUARD: the `CSG` write echoes the field count the READ
    /// reported.
    ///
    /// A BC125AT answers a bare mask; a BC75XLT answers
    /// `CSG,<mask>,[DLY],[DIR]` and rejects the bare form -- `CSG,0111010101`
    /// -> `CSG,ERR`, hardware 2026-08-28. Because a format error aborts the
    /// whole set command, sending the BC125AT shape made every custom-search
    /// bank toggle a silent no-op on that model: the API returned 200 and
    /// nothing changed on the radio.
    ///
    /// Both shapes are pinned. Either alone passes while the other is broken,
    /// and the trailing fields carry a search delay and direction Bearpaw does
    /// not model -- write back anything but what was read and they are lost.
    fn csg_responder(
        read: &'static str,
    ) -> impl Fn(&str) -> Result<String, String> + Send + 'static {
        move |cmd: &str| {
            if cmd == "CSG" {
                Ok(read.to_string())
            } else {
                Ok("OK".to_string())
            }
        }
    }

    async fn csg_write_for(read: &'static str) -> Vec<String> {
        let state = default_state();
        let fake = FakeScanner::attach(&state, csg_responder(read));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/settings/custom-search")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"groups":[true,false,false,false,true,false,true,false,true,false]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        settings_payload(&fake.transcript_with_closed_bracket())
            .into_iter()
            .filter(|c| c != "CSG")
            .collect()
    }

    #[tokio::test]
    async fn set_custom_search_sends_the_bare_mask_when_the_read_is_bare() {
        assert_eq!(
            csg_write_for("CSG,0111010101").await,
            vec!["CSG,0111010101"],
            "a BC125AT-shaped read must produce a BC125AT-shaped write"
        );
    }

    #[tokio::test]
    async fn set_custom_search_carries_the_trailing_fields_the_read_reported() {
        assert_eq!(
            csg_write_for("CSG,0111010101,1,0").await,
            vec!["CSG,0111010101,1,0"],
            "a BC75XLT-shaped read must produce a BC75XLT-shaped write, \
             delay and direction preserved"
        );
    }

    /// REGRESSION GUARD: a reserved `CLC` field goes out EMPTY, never `0`.
    ///
    /// Field 5 (`hit_scan`) is reserved on a BC75XLT -- written `1` it reads
    /// back empty (hardware 2026-08-28). It is accepted without an error and
    /// silently discarded, so nothing but a read-back reveals the failure.
    /// CLAUDE.md pitfall #9: an empty field means "leave unchanged", while a
    /// value in a reserved slot risks the format error that aborts the whole
    /// set command. The UI hides that control, so the `lockout` arriving here
    /// is a default rather than a user choice -- writing it would be inventing
    /// an answer.
    ///
    /// Paired with the BC125AT case: a guard that emptied the field for every
    /// model would pass alone while silently dropping a real setting.
    async fn clc_write_for(caps: crate::protocol::capabilities::ScannerCapabilities) -> String {
        let state = default_state();
        state.device.write().unwrap().capabilities = Some(caps);
        let fake = FakeScanner::attach(&state, |_| Ok("OK".to_string()));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/settings/close-call")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"mode":1,"alert_beep":true,"alert_light":true,"band":[true,true,true,false,true],"lockout":true}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let payload = settings_payload(&fake.transcript_with_closed_bracket());
        assert_eq!(payload.len(), 1, "expected one CLC write: {payload:?}");
        payload.into_iter().next().unwrap()
    }

    #[tokio::test]
    async fn close_call_leaves_a_reserved_hit_scan_field_empty() {
        use crate::protocol::capabilities::BC75XLT;
        assert_eq!(clc_write_for(BC75XLT).await, "CLC,1,1,1,11101,");
    }

    #[tokio::test]
    async fn close_call_still_writes_hit_scan_where_it_is_settable() {
        assert_eq!(clc_write_for(BC125AT_FAMILY).await, "CLC,1,1,1,11101,1");
    }

    #[tokio::test]
    async fn set_weather_sends_wxs() {
        let (status, t) =
            post_json_capture("/api/v1/settings/weather", r#"{"priority":true}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["WXS,1"]);
    }

    #[tokio::test]
    async fn set_contrast_sends_cnt() {
        let (status, t) = post_json_capture("/api/v1/settings/contrast", r#"{"level":12}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["CNT,12"]);
    }

    #[tokio::test]
    async fn set_custom_range_sends_csp_with_index_and_bounds() {
        let (status, t) = post_json_capture(
            "/api/v1/settings/custom-search/ranges/3",
            r#"{"lower":25.0,"upper":28.0}"#,
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        let payload = settings_payload(&t);
        assert_eq!(payload.len(), 1, "expected one CSP write: {payload:?}");
        assert!(
            payload[0].starts_with("CSP,3,"),
            "CSP must carry the range index it was addressed with: {payload:?}"
        );
    }

    // ---------------------------------------------------------------------
    // Bank enable mask (SCG)
    //
    // The BC125AT inverts this: '1' means DISABLED, '0' means enabled. It is
    // the single most-warned-about pitfall in CLAUDE.md, it is invisible from
    // the API (both directions return plain booleans), and getting it backwards
    // turns every bank toggle in the UI into its opposite. Both directions are
    // pinned here with literal masks.

    /// A fake that models the real SCG contract: a write stores the mask, and
    /// the readback (#157 verifies the write by re-reading inside the same PRG
    /// bracket) returns what was stored. A responder that answers "SCG,OK" to
    /// the readback fails `banks_readback_invalid` — the handler is stricter
    /// than a naive fake expects.
    fn bank_responder() -> impl Fn(&str) -> Result<String, String> + Send + 'static {
        let stored = Arc::new(Mutex::new(String::from("1111111111")));
        move |cmd: &str| {
            if let Some(mask) = cmd.strip_prefix("SCG,") {
                *stored.lock().unwrap() = mask.to_string();
                Ok("SCG,OK".to_string())
            } else if cmd == "SCG" {
                Ok(format!("SCG,{}", stored.lock().unwrap()))
            } else {
                Ok("OK".to_string())
            }
        }
    }

    #[tokio::test]
    async fn set_banks_inverts_enabled_to_zero_on_the_wire() {
        // Bank 1 enabled, rest disabled -> "0111111111".
        let mut banks = [false; 10];
        banks[0] = true;
        let body = format!(
            r#"{{"banks":[{}]}}"#,
            banks
                .iter()
                .map(|b| b.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
        let state = default_state();
        let fake = FakeScanner::attach(&state, bank_responder());
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/banks")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            settings_payload(&fake.transcript()),
            vec!["SCG,0111111111", "SCG"],
            "enabled banks must be '0' on the wire — '1' is DISABLED"
        );
    }

    /// REGRESSION GUARD (#402): an all-disabled bank mask is refused before it
    /// reaches the wire.
    ///
    /// Vendor spec, SCG: *"It can not set all channel strage banks to '1'."*
    /// Without this the scanner replies with a bare ERR that the UI surfaces as
    /// a generic failure, giving the user nothing to act on. Note the wire
    /// inversion — all-disabled is every `banks` entry FALSE, which becomes
    /// "1111111111".
    #[tokio::test]
    async fn set_banks_refuses_an_all_disabled_mask_without_touching_the_wire() {
        let body = format!(r#"{{"banks":[{}]}}"#, ["false"; 10].join(","));
        let state = default_state();
        let fake = FakeScanner::attach(&state, bank_responder());
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/banks")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            fake.transcript().is_empty(),
            "a mask the scanner cannot accept must not reach the wire: {:?}",
            fake.transcript()
        );
    }

    /// The paired half: a mask with at least one bank enabled still works.
    /// A guard that rejected everything would pass the test above.
    #[tokio::test]
    async fn set_banks_still_accepts_a_mask_with_one_bank_enabled() {
        let mut banks = ["false"; 10];
        banks[9] = "true";
        let body = format!(r#"{{"banks":[{}]}}"#, banks.join(","));
        let state = default_state();
        let fake = FakeScanner::attach(&state, bank_responder());
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/banks")
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            settings_payload(&fake.transcript()),
            vec!["SCG,1111111110", "SCG"]
        );
    }

    #[tokio::test]
    async fn set_banks_all_enabled_is_all_zeroes() {
        let state = default_state();
        let fake = FakeScanner::attach(&state, bank_responder());
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/banks")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"banks":[true,true,true,true,true,true,true,true,true,true]}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            settings_payload(&fake.transcript()),
            vec!["SCG,0000000000", "SCG"]
        );
    }

    #[tokio::test]
    async fn get_banks_decodes_zero_as_enabled() {
        // The scanner reports "0111111111": bank 1 enabled, 2-10 disabled.
        let state = default_state();
        let _fake = FakeScanner::attach(&state, |cmd| {
            if cmd == "SCG" {
                Ok("SCG,0111111111".to_string())
            } else {
                Ok("OK".to_string())
            }
        });
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::GET)
                    .uri("/api/v1/banks")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = json_body(response).await;
        assert_eq!(
            body["banks"],
            serde_json::json!([
                true, false, false, false, false, false, false, false, false, false
            ]),
            "'0' is ENABLED — a decode that returns [false, true, ...] has the mask backwards"
        );
    }

    #[tokio::test]
    async fn set_banks_rejects_a_mask_that_is_not_ten_banks() {
        let state = default_state();
        let fake = FakeScanner::attach(&state, |_| Ok("SCG,OK".to_string()));
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/banks")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"banks":[true,false,true]}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        assert!(
            settings_payload(&fake.transcript()).is_empty(),
            "a malformed bank mask must never reach the scanner"
        );
    }

    // ---------------------------------------------------------------------
    // Volume / squelch / channel writes and their validation
    //
    // The remaining hardware-writing controls. Each pairs a "the right bytes
    // go out" test with a "bad input never reaches the wire" test, because a
    // rejected value that still hits the scanner is the failure mode that
    // silently reprograms the radio.

    #[tokio::test]
    async fn set_volume_sends_vol() {
        let (status, t) = post_json_capture("/api/v1/volume", r#"{"volume":9}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["VOL,9"]);
    }

    #[tokio::test]
    async fn set_volume_rejects_out_of_range_without_touching_the_wire() {
        let (status, t) = post_json_capture("/api/v1/volume", r#"{"volume":99}"#).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(settings_payload(&t).is_empty());
    }

    #[tokio::test]
    async fn set_squelch_rejects_a_malformed_body_without_touching_the_wire() {
        // `SquelchRequest.level` is a u8, so 300 fails serde before the handler
        // runs — axum answers 422, not the handler's 400. Either way the wire
        // must stay clean, which is what this pins.
        let (status, t) = post_json_capture("/api/v1/squelch", r#"{"level":300}"#).await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(settings_payload(&t).is_empty());
    }

    #[tokio::test]
    async fn set_squelch_sends_sql() {
        let (status, t) = post_json_capture("/api/v1/squelch", r#"{"level":5}"#).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(settings_payload(&t), vec!["SQL,5"]);
    }

    /// A fake that stores CIN writes and echoes them on read-back. The channel
    /// write path verifies itself by re-reading the slot inside the same PRG
    /// bracket (`channel_not_persisted` otherwise), so a fake that answers a
    /// fixed CIN fails even when the write was correct.
    fn channel_responder() -> impl Fn(&str) -> Result<String, String> + Send + 'static {
        let stored: Arc<Mutex<std::collections::HashMap<String, String>>> =
            Arc::new(Mutex::new(std::collections::HashMap::new()));
        move |cmd: &str| {
            if let Some(rest) = cmd.strip_prefix("CIN,") {
                let mut parts = rest.splitn(2, ',');
                let idx = parts.next().unwrap_or_default().to_string();
                match parts.next() {
                    // Write: `CIN,<idx>,<fields...>` — remember the payload.
                    Some(fields) => {
                        stored.lock().unwrap().insert(idx, fields.to_string());
                        Ok("CIN,OK".to_string())
                    }
                    // Read: `CIN,<idx>` — echo whatever was written there.
                    None => {
                        let map = stored.lock().unwrap();
                        let fields = map
                            .get(&idx)
                            .cloned()
                            .unwrap_or_else(|| "Empty,00000000,FM,0,2,0,0".to_string());
                        Ok(format!("CIN,{idx},{fields}"))
                    }
                }
            } else {
                Ok("OK".to_string())
            }
        }
    }

    /// PUT a channel body and return (status, wire transcript).
    async fn put_channel_capture(index: u16, body: String) -> (StatusCode, Vec<String>) {
        let state = default_state();
        let fake = FakeScanner::attach(&state, channel_responder());
        let response = router(state)
            .oneshot(
                Request::builder()
                    .method(Method::PUT)
                    .uri(format!("/api/v1/memory/channels/{index}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        (response.status(), fake.transcript_with_closed_bracket())
    }

    fn channel_body(frequency: f64, tag: &str, delay: i64, bank: u8) -> String {
        format!(
            r#"{{"index":1,"frequency":{frequency},"modulation":"FM","alpha_tag":"{tag}","delay":{delay},"lockout":false,"priority":false,"bank":{bank},"tone_code":0}}"#
        )
    }

    #[tokio::test]
    async fn writing_a_channel_sends_a_cin_for_that_index_inside_a_bracket() {
        let (status, t) = put_channel_capture(7, channel_body(146.52, "TEST CHAN", 2, 1)).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(t.first().map(String::as_str), Some("PRG"));
        assert_eq!(t.last().map(String::as_str), Some("EPG"));
        // The full payload, not just the prefix: frequency is encoded as
        // 100 Hz units, zero-padded to 8 digits (146.52 MHz -> 01465200). A
        // scaling bug there writes a valid-looking but wrong frequency, which
        // no status code would reveal.
        assert!(
            t.contains(&"CIN,7,TEST CHAN,01465200,FM,0,2,0,0".to_string()),
            "unexpected CIN payload: {t:?}"
        );
    }

    #[tokio::test]
    async fn writing_a_channel_puts_the_alpha_tag_on_the_wire() {
        let (status, t) = put_channel_capture(3, channel_body(146.52, "FIREGROUND", 2, 1)).await;
        assert_eq!(status, StatusCode::OK);
        let cin = t
            .iter()
            .find(|c| c.starts_with("CIN,3,"))
            .unwrap_or_else(|| panic!("no CIN write in {t:?}"));
        assert!(
            cin.contains("FIREGROUND"),
            "the alpha tag must reach the scanner: {cin}"
        );
    }

    #[tokio::test]
    async fn writing_a_channel_rejects_a_frequency_outside_coverage() {
        // 800 MHz is outside the BC125AT's 25-512 MHz coverage (#143).
        let (status, t) = put_channel_capture(1, channel_body(800.0, "TOO HIGH", 2, 1)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(
            !t.iter().any(|c| c.starts_with("CIN,1,")),
            "an out-of-range frequency must never be written: {t:?}"
        );
    }

    #[tokio::test]
    async fn writing_a_channel_rejects_an_over_long_alpha_tag() {
        // The BC125AT's alpha tag is 16 characters.
        let (status, t) = put_channel_capture(
            1,
            channel_body(146.52, "THIS TAG IS FAR TOO LONG TO FIT", 2, 1),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!t.iter().any(|c| c.starts_with("CIN,1,")), "{t:?}");
    }

    #[tokio::test]
    async fn writing_a_channel_rejects_a_comma_in_the_alpha_tag() {
        // A comma would split into an extra CIN field and corrupt the write.
        let (status, t) = put_channel_capture(1, channel_body(146.52, "BAD,TAG", 2, 1)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!t.iter().any(|c| c.starts_with("CIN,1,")), "{t:?}");
    }

    #[tokio::test]
    async fn writing_a_channel_rejects_an_out_of_range_index() {
        let (status, t) = put_channel_capture(501, channel_body(146.52, "OOB", 2, 1)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(t.is_empty(), "index 501 must not open a bracket: {t:?}");
    }

    #[tokio::test]
    async fn writing_a_channel_rejects_an_invalid_delay() {
        let (status, t) = put_channel_capture(1, channel_body(146.52, "OK TAG", 99, 1)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!t.iter().any(|c| c.starts_with("CIN,1,")), "{t:?}");
    }

    #[tokio::test]
    async fn writing_a_channel_rejects_an_out_of_range_bank() {
        let (status, t) = put_channel_capture(1, channel_body(146.52, "OK TAG", 2, 99)).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert!(!t.iter().any(|c| c.starts_with("CIN,1,")), "{t:?}");
    }
}
