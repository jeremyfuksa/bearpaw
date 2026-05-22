use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use serde_json::json;

use super::{epoch_now, AppState};

pub(crate) async fn ws_handler(
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
