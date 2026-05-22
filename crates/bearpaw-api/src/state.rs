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

/// Kind of tone squelch carried on a channel. The BC125AT wire field is an
/// integer code 0–231; this enum lets the API surface its meaning explicitly
/// rather than overloading the Hz field with sentinel values.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToneSquelchKind {
    /// No tone configured (code 0) or unknown (default).
    #[default]
    None,
    /// CTCSS (codes 64–113); `ChannelData.tone_squelch` carries Hz.
    Ctcss,
    /// DCS digital code (codes 128–231); see `tone_dcs_code`.
    Dcs,
    /// Scanner identifies tone on each hit (code 127).
    Search,
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
    /// Frequency in Hz when `tone_squelch_kind == Ctcss`. None otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone_squelch: Option<f64>,
    /// Discriminator: ctcss / dcs / search / none. Default = none.
    #[serde(default)]
    pub tone_squelch_kind: ToneSquelchKind,
    /// DCS code when `tone_squelch_kind == Dcs`. None otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone_dcs_code: Option<u16>,
    pub bank: u8,
}

/// Cached channel memory from last sync.
#[derive(Clone, Debug, Default)]
pub struct ShadowState {
    pub channels: HashMap<u16, ChannelData>,
    pub last_sync: f64,
}
