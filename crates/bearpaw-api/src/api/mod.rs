//! Axum REST + WebSocket server.
//!
//! Phase 1+2: status, device/info, WebSocket, poll loop, control (hold/scan/direct).

mod control;
mod poll;

pub use control::{
    ControlCommand, FrequencyRequest, validate_frequency, validate_modulation,
};
pub use poll::spawn_poll_loop;

use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Json},
    routing::{get, post},
    Router,
};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};
use tokio::sync::broadcast;
use tracing::info;

use crate::state::{DeviceInfo, LiveState};

/// Shared app state. Uses std::sync::RwLock for live/device (poll thread writes).
/// command_tx is Some when a serial port is active; handlers send control commands there.
#[derive(Clone)]
pub struct AppState {
    pub live: Arc<std::sync::RwLock<LiveState>>,
    pub device: Arc<std::sync::RwLock<DeviceInfo>>,
    pub ws_tx: broadcast::Sender<String>,
    pub sequence: Arc<AtomicU64>,
    /// When Some, poll loop is running; send control commands here.
    pub command_tx: Arc<Mutex<Option<std::sync::mpsc::Sender<ControlCommand>>>>,
}

/// Build router and state. Caller runs with `axum::serve`.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/status", get(get_status))
        .route("/api/v1/device/info", get(get_device_info))
        .route("/api/v1/commands/hold", post(post_hold))
        .route("/api/v1/commands/scan", post(post_scan))
        .route("/api/v1/frequency", post(post_frequency))
        .route("/ws", get(ws_handler))
        .with_state(state)
}

async fn get_status(State(state): State<AppState>) -> Json<LiveState> {
    let live = state.live.read().unwrap().clone();
    Json(live)
}

async fn get_device_info(State(state): State<AppState>) -> Json<DeviceInfo> {
    let device = state.device.read().unwrap().clone();
    Json(device)
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
    let live = state.live.read().unwrap().clone();
    Ok(Json(live))
}

#[derive(Debug)]
pub enum ApiError {
    NoScanner,
    SendFailed,
    BadRequest(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> axum::response::Response {
        let (status, message) = match &self {
            ApiError::NoScanner => (StatusCode::SERVICE_UNAVAILABLE, "Scanner not connected"),
            ApiError::SendFailed => (StatusCode::SERVICE_UNAVAILABLE, "Command channel closed"),
            ApiError::BadRequest(msg) => (StatusCode::BAD_REQUEST, msg.as_str()),
        };
        (status, Json(serde_json::json!({ "error": message }))).into_response()
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
                if socket.send(Message::Text(msg)).await.is_err() {
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

/// Run the API server on the given bind address. If `serial_port` is Some(port, baud),
/// creates command channel, spawns poll loop, then serves.
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

/// Create default AppState (stub live/device, 16-capacity broadcast, no command_tx).
pub fn default_state() -> AppState {
    let (ws_tx, _) = broadcast::channel(16);
    AppState {
        live: Arc::new(std::sync::RwLock::new(LiveState::default())),
        device: Arc::new(std::sync::RwLock::new(DeviceInfo {
            connection_status: "disconnected".to_string(),
            ..Default::default()
        })),
        ws_tx,
        sequence: Arc::new(AtomicU64::new(0)),
        command_tx: Arc::new(Mutex::new(None)),
    }
}
