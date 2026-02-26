//! In-memory state: LiveState (current receiver), DeviceInfo (connection), ShadowState (channels).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Current scanner receiver state (from STS/GLG poll).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LiveState {
    pub timestamp: f64,
    pub frequency: f64,
    pub modulation: String,
    pub squelch_open: bool,
    pub rssi: u8,
    pub mode: String,
    pub channel: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha_tag: Option<String>,
    pub volume: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub battery: Option<u8>,
    #[serde(default)]
    pub stale: bool,
}

/// Device and connection info.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub model: Option<String>,
    pub port: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub vid: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub connection_status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub serial_number: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_message: Option<String>,
}

/// One channel from scanner memory (CIN read).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ChannelData {
    pub index: u16,
    pub frequency: f64,
    pub modulation: String,
    pub alpha_tag: String,
    pub delay: u8,
    pub lockout: bool,
    pub priority: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone_squelch: Option<f64>,
    pub bank: u8,
}

/// Cached channel memory from last sync.
#[derive(Clone, Debug, Default)]
pub struct ShadowState {
    pub channels: HashMap<u16, ChannelData>,
    pub last_sync: f64,
}
