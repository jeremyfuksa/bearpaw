use axum::extract::{Path, Query, State};
use axum::response::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::super::{
    command_sender, read_frequency_lockouts_from_scanner, send_raw_command,
    set_channel_lockout_on_scanner, ApiError, AppState, ProgramModeGuard,
};

#[derive(Deserialize)]
pub(crate) struct LockoutsQuery {
    include_frequencies: Option<bool>,
}

#[derive(Serialize)]
pub(crate) struct LockoutsResponse {
    frequencies: Vec<f64>,
    channels: Vec<u16>,
    temporary_channels: Vec<Value>,
}

pub(crate) async fn get_lockouts(
    State(state): State<AppState>,
    Query(query): Query<LockoutsQuery>,
) -> Result<Json<LockoutsResponse>, ApiError> {
    let include_frequencies = query.include_frequencies.unwrap_or(true);
    let mut channels: Vec<u16> = {
        let shadow = state.shadow.read().unwrap();
        shadow
            .channels
            .values()
            .filter(|c| c.lockout)
            .map(|c| c.index)
            .collect()
    };
    channels.sort_unstable();

    let mut temporary_channels: Vec<Value> = {
        let temp = state.temporary_lockouts.read().unwrap();
        temp.iter()
            .map(|(channel, frequency)| json!({ "channel": channel, "frequency": frequency }))
            .collect()
    };
    temporary_channels.sort_by(|a, b| {
        a.get("channel")
            .and_then(Value::as_u64)
            .cmp(&b.get("channel").and_then(Value::as_u64))
    });

    let mut frequencies = Vec::new();
    if include_frequencies {
        let _ = command_sender(&state)?;
        let from_scanner = read_frequency_lockouts_from_scanner(&state).await?;
        let mut raw = state.frequency_lockouts.write().unwrap();
        raw.clear();
        raw.extend(from_scanner.iter().copied());
        let raw = state.frequency_lockouts.read().unwrap();
        frequencies = raw
            .iter()
            .map(|f| *f as f64 / 10000.0)
            .collect::<Vec<f64>>();
        frequencies.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    }

    Ok(Json(LockoutsResponse {
        frequencies,
        channels,
        temporary_channels,
    }))
}

pub(crate) async fn get_lockout_status(
    State(state): State<AppState>,
    Path(frequency): Path<f64>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let raw = (frequency * 10000.0).round().max(0.0) as u32;
    let from_scanner = read_frequency_lockouts_from_scanner(&state).await?;
    let mut set = state.frequency_lockouts.write().unwrap();
    set.clear();
    set.extend(from_scanner.iter().copied());
    let locked = state.frequency_lockouts.read().unwrap().contains(&raw);
    Ok(Json(json!({ "frequency": frequency, "locked": locked })))
}

pub(crate) async fn clear_temporary_lockouts(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let channels = state
        .temporary_lockouts
        .read()
        .unwrap()
        .keys()
        .copied()
        .collect::<Vec<u16>>();
    let mut cleared = Vec::new();
    let mut failed = Vec::new();
    for channel in channels {
        match set_channel_lockout_on_scanner(&state, channel, false).await {
            Ok(updated) => {
                state
                    .shadow
                    .write()
                    .unwrap()
                    .channels
                    .insert(channel, updated);
                state.temporary_lockouts.write().unwrap().remove(&channel);
                cleared.push(channel);
            }
            Err(_) => failed.push(channel),
        }
    }
    cleared.sort_unstable();
    failed.sort_unstable();
    Ok(Json(json!({ "cleared": cleared, "failed": failed })))
}

pub(crate) async fn clear_global_lockouts(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let mut cleared = Vec::new();
    let existing = read_frequency_lockouts_from_scanner(&state).await?;
    let _prg = ProgramModeGuard::enter(&state).await?;
    for frequency in &existing {
        let _ = send_raw_command(&state, &format!("ULF,{}", frequency), false).await;
        cleared.push(*frequency as f64 / 10000.0);
    }
    cleared.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    state.frequency_lockouts.write().unwrap().clear();
    Ok(Json(json!({ "cleared": cleared, "failed": [] })))
}

#[derive(Deserialize)]
pub(crate) struct ClearChannelLockoutsRequest {
    channels: Option<Vec<u16>>,
}

pub(crate) async fn clear_channel_lockouts(
    State(state): State<AppState>,
    Json(body): Json<ClearChannelLockoutsRequest>,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    let targets: Vec<u16> = match body.channels {
        Some(channels) if !channels.is_empty() => channels,
        _ => {
            let shadow = state.shadow.read().unwrap();
            shadow
                .channels
                .values()
                .filter(|c| c.lockout)
                .map(|c| c.index)
                .collect()
        }
    };

    let mut cleared = Vec::new();
    let mut failed = Vec::new();
    for id in targets {
        match set_channel_lockout_on_scanner(&state, id, false).await {
            Ok(updated) => {
                state.shadow.write().unwrap().channels.insert(id, updated);
                cleared.push(id);
            }
            Err(_) => failed.push(id),
        }
    }
    cleared.sort_unstable();
    failed.sort_unstable();
    Ok(Json(json!({ "cleared": cleared, "failed": failed })))
}
