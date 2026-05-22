//! In-memory state: LiveState (current receiver), DeviceInfo (connection), ShadowState (channels).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// What the scanner is currently doing, from the controller's point of view.
///
/// Mode is tracked by the command scheduler — it's not a wire field. The
/// scanner doesn't report mode; we know what we last commanded it to do.
/// Programming is the special case the user can't command directly: it's
/// entered for the duration of a memory sync, bank read, or settings read.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScannerMode {
    /// Scanner cycling through channels.
    #[default]
    #[serde(rename = "SCAN")]
    Scan,
    /// Stopped on one frequency (user-initiated).
    #[serde(rename = "HOLD")]
    Hold,
    /// Tuned to a manual frequency (via DO command).
    #[serde(rename = "DIRECT")]
    Direct,
    /// In PRG mode for memory / settings access. Live polling is suspended.
    /// Serialized as "PGM" for wire compatibility.
    #[serde(rename = "PGM")]
    Programming,
}

impl ScannerMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ScannerMode::Scan => "SCAN",
            ScannerMode::Hold => "HOLD",
            ScannerMode::Direct => "DIRECT",
            ScannerMode::Programming => "PGM",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.trim().to_uppercase().as_str() {
            "HOLD" => ScannerMode::Hold,
            "DIRECT" => ScannerMode::Direct,
            "PROGRAMMING" | "PGM" | "PRG" => ScannerMode::Programming,
            _ => ScannerMode::Scan,
        }
    }
}

impl std::fmt::Display for ScannerMode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Current scanner receiver state (from STS/GLG poll).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct LiveState {
    pub timestamp: f64,
    pub frequency: f64,
    pub modulation: String,
    pub squelch_open: bool,
    pub rssi: u8,
    pub mode: ScannerMode,
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
