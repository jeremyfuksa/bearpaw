//! Uniden scanner protocol: MDL, STS, GLG, CIN (channel read).
//!
//! Phase 1: MDL + STS. Phase 3: CIN parse for memory sync.

use crate::state::{ChannelData, LiveState};
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

    let frequency = map.get("FRQ").and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let modulation = map.get("MOD").cloned().unwrap_or_else(|| "FM".to_string());
    let squelch_open = map.get("SQL").map(|s| s.trim() == "0").unwrap_or(false);
    let rssi = map.get("RSSI").and_then(|s| s.parse().ok()).unwrap_or(0) as u8;
    let channel = map.get("CH").and_then(|s| s.parse().ok());
    let volume = map.get("VOL").and_then(|s| s.parse().ok()).unwrap_or(0) as u8;
    let battery = map.get("BAT").and_then(|s| s.parse().ok());

    // Mode: infer from other state if needed; default SCAN
    let mode = map
        .get("MODE")
        .cloned()
        .unwrap_or_else(|| "SCAN".to_string());

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

/// Parse CIN response into ChannelData.
/// Format: CIN,67,Police Dispatch,01469700,NFM,0,2,1,5 (index, alpha_tag, freq*10000, mod, lockout, delay, priority, bank).
/// Also accepts name-first: CIN,67,Police Dispatch,146.9700,NFM,... or fewer fields.
pub fn parse_cin_response(index: u16, response: &str) -> Option<ChannelData> {
    let parts: Vec<&str> = response.trim().split(',').map(|s| s.trim()).collect();
    let mut p = parts.as_slice();
    if p.first().map(|s| *s == "CIN") == Some(true) {
        p = &p[1..];
    }
    if p.first().map(|s| s.parse::<u16>().ok()) == Some(Some(index)) {
        p = &p[1..];
    }
    if p.is_empty() {
        return Some(ChannelData {
            index,
            frequency: 0.0,
            modulation: "FM".to_string(),
            alpha_tag: String::new(),
            delay: 2,
            lockout: false,
            priority: false,
            tone_squelch: None,
            bank: 0,
        });
    }
    let parse_freq = |s: &str| -> f64 {
        if s.is_empty() {
            return 0.0;
        }
        if let Ok(n) = s.parse::<u32>() {
            if n >= 10000 {
                return n as f64 / 10000.0;
            }
        }
        s.parse().unwrap_or(0.0)
    };
    let alpha_tag = p.get(0).unwrap_or(&"").to_string();
    let freq_raw = p.get(1).copied().unwrap_or("");
    let frequency = parse_freq(freq_raw);
    let modulation = p
        .get(2)
        .map(|s| s.to_uppercase())
        .filter(|s| ["FM", "AM", "NFM", "AUTO"].contains(&s.as_str()))
        .unwrap_or_else(|| "FM".to_string());
    let lockout = p.get(3).map(|s| *s == "1").unwrap_or(false);
    let delay = p.get(4).and_then(|s| s.parse().ok()).unwrap_or(2) as u8;
    let priority = p.get(5).map(|s| *s == "1").unwrap_or(false);
    let bank = p.get(6).and_then(|s| s.parse().ok()).unwrap_or(0) as u8;
    Some(ChannelData {
        index,
        frequency,
        modulation,
        alpha_tag,
        delay,
        lockout,
        priority,
        tone_squelch: None,
        bank,
    })
}
