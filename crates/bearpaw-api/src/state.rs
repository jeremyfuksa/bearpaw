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
    /// Tone squelch decoded from the live GLG frame during an active hit.
    /// `None` / defaulted while the squelch is closed (tone is meaningless
    /// when no signal is present). Mirrors `ChannelData`'s tone shape plus a
    /// pre-formatted DCS label so the frontend needs no DCS table.
    #[serde(default)]
    pub tone_squelch_kind: ToneSquelchKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone_squelch: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone_dcs_code: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tone_dcs_label: Option<String>,
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
    // REGRESSION GUARD: channeldata_index_serde_default (tests in this file) —
    // the frontend PUT /memory/channels/{index} body omits `index` (the path
    // carries it, and put_memory_channel overwrites body.index from the path).
    // Without a serde default, axum rejects every channel edit with 422
    // "missing field `index`". See issue #131.
    #[serde(default)]
    pub index: u16,
    pub frequency: f64,
    pub modulation: String,
    pub alpha_tag: String,
    /// CIN delay field. Valid values per docs/BC125AT_PROTOCOL.md §5.3 and
    /// docs/SCANNER_PROTOCOL_REFERENCE.md §4: `-10, -5, 0, 1, 2, 3, 4, 5`
    /// (seconds). Negative values are pre-delays — the scanner backs up
    /// the audio buffer when a hit occurs. Signed to preserve those.
    pub delay: i8,
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

impl ChannelData {
    /// True when this is a *programmed* channel that is locked out.
    ///
    /// Empty slots read back from the scanner as `,00000000,AUTO,0,2,1,0` —
    /// a factory-default `lockout=1` bit on a channel that holds no frequency.
    /// That bit is meaningless (there is nothing to lock), and the scanner
    /// refuses to clear it: a `CIN,...,0` write to an empty slot returns
    /// `CIN,OK` but no-ops, leaving `lockout=1`. Treating the bare bit as a
    /// real lockout inflates the "locked channels" list with every unprogrammed
    /// slot and makes the clear sweep spin on writes that can never stick
    /// (surfaced by the `lockout not persisted` field warning on empty ch 469).
    /// A channel is only meaningfully locked when it actually has a frequency.
    pub fn is_active_lockout(&self) -> bool {
        self.lockout && self.frequency > 0.0
    }
}

/// Cached channel memory from last sync.
#[derive(Clone, Debug, Default)]
pub struct ShadowState {
    pub channels: HashMap<u16, ChannelData>,
    pub last_sync: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    // REGRESSION GUARD: see issue #131. The frontend sends channel-edit PUT
    // bodies without an `index` field. If ChannelData::index loses its
    // #[serde(default)], this deserialization fails and every channel edit
    // 422s before the handler runs.
    #[test]
    fn channeldata_deserializes_without_index() {
        let body = r#"{
            "frequency": 146.52,
            "modulation": "FM",
            "alpha_tag": "Simplex",
            "delay": 2,
            "lockout": false,
            "priority": false,
            "bank": 1
        }"#;
        let ch: ChannelData = serde_json::from_str(body).expect("must deserialize without index");
        assert_eq!(
            ch.index, 0,
            "missing index defaults to 0 (handler overwrites from path)"
        );
        assert_eq!(ch.frequency, 146.52);
        assert_eq!(ch.alpha_tag, "Simplex");
    }

    // REGRESSION GUARD: an empty slot reads back as `,00000000,AUTO,0,2,1,0`
    // (factory lockout=1, freq 0). It must NOT count as a locked channel — the
    // scanner won't clear that bit, so counting it inflates the locked list and
    // makes the clear sweep fail on ch 469 with `lockout not persisted`.
    #[test]
    fn is_active_lockout_ignores_empty_slots() {
        let empty_locked = ChannelData {
            frequency: 0.0,
            lockout: true,
            ..Default::default()
        };
        assert!(
            !empty_locked.is_active_lockout(),
            "empty slot (freq 0) with factory lockout=1 is not a real lockout"
        );

        let real_locked = ChannelData {
            frequency: 146.64,
            lockout: true,
            ..Default::default()
        };
        assert!(
            real_locked.is_active_lockout(),
            "programmed channel with lockout=1 is a real lockout"
        );

        let real_unlocked = ChannelData {
            frequency: 146.64,
            lockout: false,
            ..Default::default()
        };
        assert!(
            !real_unlocked.is_active_lockout(),
            "programmed channel with lockout=0 is not locked"
        );
    }
}
