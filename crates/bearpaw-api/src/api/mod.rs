//! Axum REST + WebSocket server.
//!
//! Phase 1: GET /api/v1/status, GET /api/v1/device/info, WebSocket /ws.

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::Json,
    routing::get,
    Router,
};
use std::sync::Arc;
use tokio::sync::broadcast;
use tracing::info;

use crate::state::{DeviceInfo, LiveState};

/// Shared app state for Axum.
#[derive(Clone)]
pub struct AppState {
    pub live: Arc<tokio::sync::RwLock<LiveState>>,
    pub device: Arc<tokio::sync::RwLock<DeviceInfo>>,
    pub ws_tx: broadcast::Sender<Vec<u8>>,
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
    let live = state.live.read().await;
    Json(live.clone())
}

async fn get_device_info(State(state): State<AppState>) -> Json<DeviceInfo> {
    let device = state.device.read().await;
    Json(device.clone())
}

async fn ws_handler(State(state): State<AppState>, ws: WebSocketUpgrade) -> axum::response::Response {
    ws.on_upgrade(move |socket| handle_socket(state.clone(), socket))
}

async fn handle_socket(state: AppState, mut socket: WebSocket) {
    let mut rx = state.ws_tx.subscribe();
    loop {
        tokio::select! {
            Ok(msg) = rx.recv() => {
                if socket.send(Message::Binary(msg)).await.is_err() {
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

/// Run the API server on the given bind address. Returns when the server is listening.
/// Spawn this in a Tokio task from Tauri or from main.
pub async fn run_server(
    bind: &str,
    state: AppState,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let listener = tokio::net::TcpListener::bind(bind).await?;
    info!("Bearpaw API listening on http://{}", bind);
    axum::serve(listener, router(state).into_make_service()).await?;
    Ok(())
}

/// Create default AppState (stub live/device, 16-capacity broadcast).
pub fn default_state() -> AppState {
    let (ws_tx, _) = broadcast::channel(16);
    AppState {
        live: Arc::new(tokio::sync::RwLock::new(LiveState::default())),
        device: Arc::new(tokio::sync::RwLock::new(DeviceInfo {
            connection_status: "disconnected".to_string(),
            ..Default::default()
        })),
        ws_tx,
    }
}
