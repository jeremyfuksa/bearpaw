use axum::extract::State;
use axum::response::Json;
use serde_json::{json, Value};

use crate::state::{DeviceInfo, LiveState, ScannerMode};

use super::super::{broadcast_state_update, epoch_now, AppState};

pub(crate) async fn get_status(State(state): State<AppState>) -> Json<LiveState> {
    Json(state.live.read().unwrap().clone())
}

pub(crate) async fn get_health() -> Json<Value> {
    Json(json!({ "status": "ok" }))
}

pub(crate) async fn get_device_info(State(state): State<AppState>) -> Json<DeviceInfo> {
    Json(state.device.read().unwrap().clone())
}

pub(crate) async fn simulate_hit(State(state): State<AppState>) -> Json<Value> {
    let now = epoch_now();
    let live = LiveState {
        timestamp: now,
        frequency: 162.55,
        modulation: "FM".to_string(),
        squelch_open: true,
        rssi: 75,
        mode: ScannerMode::Scan,
        channel: Some(1),
        alpha_tag: Some("Test Channel".to_string()),
        volume: 5,
        battery: None,
        stale: false,
    };
    broadcast_state_update(&state, &live);

    let state_for_close = state.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let close_live = LiveState {
            timestamp: epoch_now(),
            frequency: 162.55,
            modulation: "FM".to_string(),
            squelch_open: false,
            rssi: 0,
            mode: ScannerMode::Scan,
            channel: Some(1),
            alpha_tag: Some("Test Channel".to_string()),
            volume: 5,
            battery: None,
            stale: false,
        };
        broadcast_state_update(&state_for_close, &close_live);
    });

    Json(json!({ "message": "Simulated hit", "frequency": 162.550, "duration": 2 }))
}
