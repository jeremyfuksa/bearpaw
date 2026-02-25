//! Uniden scanner protocol: MDL, STS, GLG, command encoding.
//!
//! Phase 1: MDL + STS (and BC125AT GLG fallback) to build LiveState.

use crate::state::LiveState;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("parse error: {0}")]
    Parse(String),
}

/// Parse STS key-value response (lines like "FRQ,146.9700") into a map.
pub fn parse_sts_response(response: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in response.lines() {
        let line = line.trim();
        if let Some((k, v)) = line.split_once(',') {
            out.insert(k.trim().to_uppercase(), v.trim().to_string());
        }
    }
    out
}

/// Build LiveState from STS key-value map. Uses current timestamp.
pub fn livestate_from_sts(map: &HashMap<String, String>) -> LiveState {
    let now = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);

    let frequency = map
        .get("FRQ")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0.0);
    let modulation = map
        .get("MOD")
        .cloned()
        .unwrap_or_else(|| "FM".to_string());
    let squelch_open = map.get("SQL").map(|s| s.trim() == "0").unwrap_or(false);
    let rssi = map
        .get("RSSI")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0) as u8;
    let channel = map.get("CH").and_then(|s| s.parse().ok());
    let volume = map.get("VOL").and_then(|s| s.parse().ok()).unwrap_or(0) as u8;
    let battery = map.get("BAT").and_then(|s| s.parse().ok());

    // Mode: infer from other state if needed; default SCAN
    let mode = map.get("MODE").cloned().unwrap_or_else(|| "SCAN".to_string());

    LiveState {
        timestamp: now,
        frequency,
        modulation,
        squelch_open,
        rssi,
        mode,
        channel,
        alpha_tag: None,
        volume,
        battery,
        stale: false,
    }
}

/// MDL response: "MDL,BC125AT" -> "BC125AT"
pub fn parse_mdl_response(response: &str) -> Option<String> {
    let line = response.lines().next()?.trim();
    let (_cmd, model) = line.split_once(',')?;
    Some(model.trim().to_string())
}
