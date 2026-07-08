use axum::extract::State;
use axum::response::Json;
use serde_json::{json, Value};

use crate::state::{DeviceInfo, LiveState};

use super::super::{epoch_now, AppState};

/// Liveness probe. Documented in docs/API_SPEC.md §3.1 and referenced by the
/// frontend contract test, but previously unrouted (#150). Returns 200 as long
/// as the HTTP server is up — it says nothing about scanner connectivity;
/// `/status` and `/device/info` carry that.
pub(crate) async fn get_health() -> Json<Value> {
    Json(json!({
        "status": "ok",
        "version": env!("CARGO_PKG_VERSION"),
        "timestamp": epoch_now(),
    }))
}

pub(crate) async fn get_status(State(state): State<AppState>) -> Json<LiveState> {
    Json(state.live.read().unwrap().clone())
}

pub(crate) async fn get_device_info(State(state): State<AppState>) -> Json<DeviceInfo> {
    Json(state.device.read().unwrap().clone())
}
