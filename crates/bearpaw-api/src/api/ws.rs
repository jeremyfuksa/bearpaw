use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use serde_json::json;
use std::sync::atomic::Ordering;

use crate::state::LiveState;

use super::{epoch_now, track_analytics_transition, AppState};

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

pub(crate) fn broadcast_state_update(state: &AppState, live: &LiveState) {
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
