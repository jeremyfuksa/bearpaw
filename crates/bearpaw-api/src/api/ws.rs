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
    let origin = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if !ws_origin_allowed(origin) {
        return (StatusCode::FORBIDDEN, "origin_not_allowed").into_response();
    }
    ws.on_upgrade(move |socket| handle_socket(state.clone(), socket))
}

async fn handle_socket(state: AppState, mut socket: WebSocket) {
    use tokio::sync::broadcast::error::RecvError;

    let mut rx = state.ws_tx.subscribe();
    loop {
        tokio::select! {
            // REGRESSION GUARD: see issue #141. Match the full Result here, not
            // `Ok(msg) = rx.recv()`. With the `Ok(..)` pattern, a
            // RecvError::Lagged (the broadcast channel is bounded and the poll
            // loop produces ~5-10 msgs/s) makes the arm's pattern fail to match,
            // and tokio::select! then DISABLES this branch for the rest of the
            // call — forwarding silently stops until the client sends a frame.
            result = rx.recv() => {
                match result {
                    Ok(msg) => {
                        if socket.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                    // Client fell behind and skipped `n` messages. The next
                    // full state_update carries the current state, so just
                    // keep going rather than tearing down the socket.
                    Err(RecvError::Lagged(_)) => continue,
                    // Sender dropped: server is shutting down.
                    Err(RecvError::Closed) => break,
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
