//! Axum REST + WebSocket server.
//!
//! Phase 1: GET /api/v1/status, GET /api/v1/device/info, WebSocket /ws, poll loop.

mod poll;

pub use poll::spawn_poll_loop;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Json,
    routing::get,
    Router,
};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::info;

use crate::state::{DeviceInfo, LiveState};

/// Shared app state for Axum. Uses std::sync::RwLock so the blocking poll thread can write.
#[derive(Clone)]
pub struct AppState {
    pub live: Arc<std::sync::RwLock<LiveState>>,
    pub device: Arc<std::sync::RwLock<DeviceInfo>>,
    pub ws_tx: broadcast::Sender<String>,
    pub sequence: Arc<AtomicU64>,
}

/// Build router and state. Caller runs with `axum::serve`.
pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/api/v1/status", get(get_status))
        .route("/api/v1/device/info", get(get_device_info))
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
/// spawns a blocking poll loop that sends STS and broadcasts state_update.
pub async fn run_server(
    bind: &str,
    state: AppState,
    serial_port: Option<(String, u32)>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some((port_name, baud)) = serial_port {
        spawn_poll_loop(state.clone(), port_name, baud);
    }
    let listener = tokio::net::TcpListener::bind(bind).await?;
    info!("Bearpaw API listening on http://{}", bind);
    axum::serve(listener, router(state).into_make_service()).await?;
    Ok(())
}

/// Create default AppState (stub live/device, 16-capacity broadcast).
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
    }
}
