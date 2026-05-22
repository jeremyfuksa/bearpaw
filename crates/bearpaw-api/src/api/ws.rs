use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::IntoResponse;
use serde_json::json;

use super::security::ws_origin_allowed;
use super::{epoch_now, AppState};

pub(crate) async fn ws_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> axum::response::Response {
    // Browsers always send Origin on a WS upgrade. The CORS layer does not
    // run on the upgrade response, so the origin check has to live here.
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok());
    if !ws_origin_allowed(origin) {
        return (StatusCode::FORBIDDEN, "origin_not_allowed").into_response();
    }
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
