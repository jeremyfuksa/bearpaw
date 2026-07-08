use axum::extract::{Query, State};
use axum::response::Json;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::protocol::{classify_response, ScannerReply};

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
        // Take the write lock once, update the cache, and read the values back
        // off the SAME guard. Re-locking with .read() while this write guard is
        // still alive deadlocks — std::sync::RwLock is not reentrant. See #133.
        {
            let mut raw = state.frequency_lockouts.write().unwrap();
            raw.clear();
            raw.extend(from_scanner.iter().copied());
            frequencies = raw
                .iter()
                .map(|f| *f as f64 / 10000.0)
                .collect::<Vec<f64>>();
        }
        frequencies.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    }

    Ok(Json(LockoutsResponse {
        frequencies,
        channels,
        temporary_channels,
    }))
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
    let mut failed = Vec::new();
    let existing = read_frequency_lockouts_from_scanner(&state).await?;
    let _prg = ProgramModeGuard::enter(&state).await?;
    for frequency in &existing {
        // ULF takes the 8-digit zero-padded 100 Hz encoding, same as LOF —
        // verified on hardware 2026-07-08 (glf-walk-probe capture, #142).
        // Classify the reply instead of ignoring it: a refused ULF must show
        // up in `failed`, not be reported as cleared.
        let reply = send_raw_command(&state, &format!("ULF,{:08}", frequency), false).await;
        let ok = matches!(
            reply.map(|r| classify_response(&r)),
            Ok(ScannerReply::Ok)
        );
        if ok {
            cleared.push(*frequency as f64 / 10000.0);
        } else {
            failed.push(*frequency as f64 / 10000.0);
        }
    }
    cleared.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    failed.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    // Only forget lockouts we actually removed; failures stay cached so a
    // retry can find them.
    if failed.is_empty() {
        state.frequency_lockouts.write().unwrap().clear();
    } else {
        let cleared_raw: Vec<u32> = existing
            .iter()
            .copied()
            .filter(|f| cleared.contains(&(*f as f64 / 10000.0)))
            .collect();
        let mut cache = state.frequency_lockouts.write().unwrap();
        cache.retain(|f| !cleared_raw.contains(f));
    }
    Ok(Json(json!({ "cleared": cleared, "failed": failed })))
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
