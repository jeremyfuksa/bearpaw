use axum::extract::State;
use axum::response::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use std::time::Duration;

use crate::protocol::index_to_bank;
use crate::state::ChannelData;

use super::super::{
    command_sender, send_raw_command, set_channel_lockout_on_scanner, set_setting_section,
    ApiError, AppState, ControlCommand, ProgramModeGuard,
};

/// Send a Hold or Scan ControlCommand to the poll loop and wait for its
/// scanner-side reply. The poll loop updates commanded_mode inside the same
/// match arm that issues the KEY write, so on success the next poll tick
/// broadcasts the new mode — no separate live.mode write needed here.
async fn send_mode_command(
    state: &AppState,
    make_cmd: impl FnOnce(
            Option<std::sync::mpsc::Sender<Result<String, String>>>,
        ) -> ControlCommand
        + Send
        + 'static,
    error_tag: &'static str,
) -> Result<(), ApiError> {
    let sender = command_sender(state)?;
    tokio::task::spawn_blocking(move || -> Result<(), ApiError> {
        let (reply_tx, reply_rx) = std::sync::mpsc::channel();
        sender
            .send(make_cmd(Some(reply_tx)))
            .map_err(|_| ApiError::SendFailed)?;
        let response = match reply_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(r)) => r,
            Ok(Err(m)) => return Err(ApiError::BadRequest(m)),
            Err(_) => return Err(ApiError::BadRequest("command_timeout".to_string())),
        };
        let upper = response.trim().to_uppercase();
        if !(upper == "OK" || upper.ends_with(",OK")) {
            return Err(ApiError::BadRequest(format!("{}_failed", error_tag)));
        }
        Ok(())
    })
    .await
    .map_err(|_| ApiError::SendFailed)?
}

pub(crate) async fn post_hold(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    send_mode_command(&state, |reply| ControlCommand::Hold { reply }, "hold").await?;
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn post_scan(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    send_mode_command(&state, |reply| ControlCommand::Scan { reply }, "scan").await?;
    Ok(Json(json!({ "status": "ok" })))
}

#[derive(Deserialize)]
pub(crate) struct KeyRequest {
    key: String,
}

pub(crate) async fn post_key(
    State(state): State<AppState>,
    Json(body): Json<KeyRequest>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let key = body.key.to_uppercase();
    let cmd = match key.as_str() {
        "H" => Some(ControlCommand::Hold { reply: None }),
        "S" => Some(ControlCommand::Scan { reply: None }),
        _ => None,
    };
    if let Some(cmd) = cmd {
        let tx = state.command_tx.lock().unwrap();
        let tx = tx.as_ref().ok_or(ApiError::NoScanner)?;
        tx.send(cmd).map_err(|_| ApiError::SendFailed)?;
    } else {
        let primary = send_raw_command(&state, &format!("KEY,{},P", key), false).await;
        if primary.is_err() {
            let _ = send_raw_command(&state, &format!("KEY,{}", key), false).await?;
        }
    }
    Ok(Json(json!({ "status": "ok" })))
}

#[derive(Deserialize)]
pub(crate) struct LockoutRequest {
    mode: String,
    frequency: Option<f64>,
    channel: Option<u16>,
}

pub(crate) async fn post_lockout(
    State(state): State<AppState>,
    Json(body): Json<LockoutRequest>,
) -> Result<Json<Value>, ApiError> {
    match body.mode.as_str() {
        "temporary" => {
            let live = state.live.read().unwrap().clone();
            let channel = body
                .channel
                .or(live.channel)
                .ok_or_else(|| ApiError::BadRequest("channel_required".to_string()))?;
            let frequency = body.frequency.unwrap_or(live.frequency);
            let was_locked = state
                .temporary_lockouts
                .read()
                .unwrap()
                .contains_key(&channel);
            let locked = if was_locked {
                if command_sender(&state).is_ok() {
                    let updated = set_channel_lockout_on_scanner(&state, channel, false).await?;
                    state
                        .shadow
                        .write()
                        .unwrap()
                        .channels
                        .insert(channel, updated);
                }
                state.temporary_lockouts.write().unwrap().remove(&channel);
                false
            } else {
                if command_sender(&state).is_ok() {
                    let updated = set_channel_lockout_on_scanner(&state, channel, true).await?;
                    state
                        .shadow
                        .write()
                        .unwrap()
                        .channels
                        .insert(channel, updated);
                }
                state
                    .temporary_lockouts
                    .write()
                    .unwrap()
                    .insert(channel, frequency);
                true
            };
            Ok(Json(json!({
                "mode": "temporary",
                "frequency": frequency,
                "locked": locked,
                "channel": channel
            })))
        }
        "permanent" => {
            let live = state.live.read().unwrap().clone();
            let index = body
                .channel
                .or(live.channel)
                .ok_or_else(|| ApiError::BadRequest("channel_required".to_string()))?;
            let updated = if command_sender(&state).is_ok() {
                let current = {
                    let shadow = state.shadow.read().unwrap();
                    shadow
                        .channels
                        .get(&index)
                        .map(|c| c.lockout)
                        .unwrap_or(false)
                };
                set_channel_lockout_on_scanner(&state, index, !current).await?
            } else {
                let mut shadow = state.shadow.write().unwrap();
                let ch = shadow.channels.entry(index).or_insert(ChannelData {
                    index,
                    frequency: live.frequency,
                    modulation: live.modulation,
                    alpha_tag: live.alpha_tag.unwrap_or_default(),
                    delay: 2,
                    lockout: false,
                    priority: false,
                    tone_squelch: None,
                    tone_squelch_kind: Default::default(),
                    tone_dcs_code: None,
                    bank: index_to_bank(index),
                });
                ch.lockout = !ch.lockout;
                ch.clone()
            };
            state
                .shadow
                .write()
                .unwrap()
                .channels
                .insert(index, updated.clone());
            state.temporary_lockouts.write().unwrap().remove(&index);
            Ok(Json(json!({ "mode": "permanent", "channel": updated })))
        }
        _ => Err(ApiError::BadRequest("invalid_lockout_mode".to_string())),
    }
}

pub(crate) async fn get_volume(State(state): State<AppState>) -> Json<Value> {
    if command_sender(&state).is_ok() {
        if let Ok(response) = send_raw_command(&state, "VOL", false).await {
            let mut parts = response.split(',').map(|s| s.trim()).collect::<Vec<&str>>();
            if parts.first().map(|p| p.eq_ignore_ascii_case("VOL")) == Some(true) {
                parts.remove(0);
            }
            if let Some(first) = parts.first() {
                if let Ok(volume) = first.parse::<u8>() {
                    if let Ok(mut live) = state.live.write() {
                        live.volume = volume.min(15);
                    }
                }
            }
        }
    }
    let volume = state.live.read().unwrap().volume;
    Json(json!({ "volume": volume }))
}

#[derive(Deserialize)]
pub(crate) struct VolumeRequest {
    volume: u8,
}

pub(crate) async fn set_volume(
    State(state): State<AppState>,
    Json(body): Json<VolumeRequest>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if body.volume > 15 {
        return Err(ApiError::BadRequest("volume_out_of_range".to_string()));
    }
    let response = send_raw_command(&state, &format!("VOL,{}", body.volume), false).await?;
    let upper = response.trim().to_uppercase();
    if !(upper == "OK" || upper.ends_with(",OK") || upper.starts_with("VOL,")) {
        return Err(ApiError::BadRequest("volume_failed".to_string()));
    }
    let mut live = state.live.write().unwrap();
    live.volume = body.volume;
    let seq = state.sequence.fetch_add(1, Ordering::Relaxed);
    let msg = json!({
        "type": "state_update",
        "timestamp": live.timestamp,
        "sequence": seq,
        "data": { "volume": body.volume }
    });
    let _ = state.ws_tx.send(msg.to_string());
    Ok(Json(json!({ "status": "ok" })))
}

pub(crate) async fn get_squelch(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let _prg = ProgramModeGuard::enter(&state).await?;
    let response = send_raw_command(&state, "SQL", false).await;
    let response = response?;
    let mut parts = response.split(',').map(|s| s.trim()).collect::<Vec<&str>>();
    if parts.first().map(|p| p.eq_ignore_ascii_case("SQL")) == Some(true) {
        parts.remove(0);
    }
    let level = parts
        .first()
        .and_then(|s| s.parse::<u8>().ok())
        .unwrap_or(0);
    let value = json!({ "level": level });
    set_setting_section(&state, "squelch", value.clone());
    Ok(Json(value))
}

#[derive(Deserialize)]
pub(crate) struct SquelchRequest {
    level: u8,
}

pub(crate) async fn set_squelch(
    State(state): State<AppState>,
    Json(body): Json<SquelchRequest>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    if body.level > 15 {
        return Err(ApiError::BadRequest("squelch_out_of_range".to_string()));
    }
    let _prg = ProgramModeGuard::enter(&state).await?;
    let response = send_raw_command(&state, &format!("SQL,{}", body.level), false).await;
    let response = response?;
    let upper = response.trim().to_uppercase();
    if !(upper == "OK" || upper.ends_with(",OK") || upper.starts_with("SQL,")) {
        return Err(ApiError::BadRequest("squelch_failed".to_string()));
    }
    set_setting_section(&state, "squelch", json!({ "level": body.level }));
    Ok(Json(json!({ "status": "ok" })))
}
