use axum::extract::State;
use axum::response::Json;

use crate::state::{DeviceInfo, LiveState};

use super::super::AppState;

pub(crate) async fn get_status(State(state): State<AppState>) -> Json<LiveState> {
    Json(state.live.read().unwrap().clone())
}

pub(crate) async fn get_device_info(State(state): State<AppState>) -> Json<DeviceInfo> {
    Json(state.device.read().unwrap().clone())
}
