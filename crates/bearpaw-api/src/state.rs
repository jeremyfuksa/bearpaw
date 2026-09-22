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
    #[serde(default)]
    pub squelch_level: u8,
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
    /// Which stored profile this scanner is (#414).
    ///
    /// Lives here beside `model` and `capabilities` for the same reason they
    /// do: all three are resolved from one `MDL` reply, and a reader that saw
    /// a BC75XLT's model beside a BC125AT's profile would be reading a
    /// contradiction. One lock, one answer.
    ///
    /// `None` until the first successful `MDL`, and if the profile database is
    /// unusable it stays `None` -- the cache then falls back to the shared
    /// placeholder key, which is exactly the pre-#414 behaviour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanner_id: Option<String>,
    /// A problem with the CONNECTION, cleared the moment one succeeds.
    ///
    /// Correct for `usb_detected_no_serial_endpoint`, `unsupported_model` and
    /// friends: connecting is what resolves them, so the connect path in
    /// `api::poll` blanks this pair on every successful open. Anything whose
    /// cause a connection does NOT fix belongs in `data_diagnostic_*` instead.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic_message: Option<String>,
    /// A problem with the stored DATA, true regardless of the scanner and
    /// cleared only when its cause is.
    ///
    /// REGRESSION GUARD (`migration_diagnostic_survives_a_connect`): a failed
    /// migration used to be written into `diagnostic_code`, which the connect
    /// path clears on every successful open -- so the one channel #418 chose
    /// to carry it was wiped before any user could see it, and only stayed
    /// visible for someone whose scanner was ALSO unplugged. Two more gates
    /// compounded it: `App.tsx` renders `diagnostic_message` only while
    /// `connection_status === "disconnected"`, and `DeviceTab` only if you
    /// visit that tab -- no reason to, with a scanner working fine.
    ///
    /// The split is structural rather than an exception list in the connect
    /// path: a `code != "migration_failed"` check would need every future
    /// persistent diagnostic to remember to add itself, and the one that
    /// forgets reintroduces exactly this bug. Two fields with two lifetimes
    /// mean the connect path CANNOT reach this one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_diagnostic_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_diagnostic_message: Option<String>,
    /// Something the user should know about their stored data that is NOT a
    /// problem. Set once, on the launch that upgraded the database.
    ///
    /// Deliberately NOT `data_diagnostic_*`. That pair means "something is
    /// wrong" and the UI renders it as a fault; a successful upgrade dressed as
    /// a fault teaches people to ignore the channel that also carries real
    /// failures. Two meanings, two fields.
    ///
    /// Self-clearing without any "dismissed" flag: it is only set when a
    /// migration actually ran, and the next launch finds the schema current and
    /// sets nothing. Nothing to persist and nothing to reset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_notice_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_notice_message: Option<String>,
    /// Memory model and feature set of the connected scanner, resolved from the
    /// `MDL` reply at connect. Lives on `DeviceInfo` rather than as a sibling
    /// `AppState` field so `model` and `capabilities` are always read under one
    /// lock -- a separate lock would let a reader observe a BC75XLT model with
    /// BC125AT capabilities in the window between two writes.
    ///
    /// `None` until a scanner identifies itself. Consumers that need a value
    /// before connect use `ScannerCapabilities::default()` (the BC125AT
    /// family), which preserves today's behavior.
    ///
    /// `skip_deserializing` because `ScannerCapabilities` is deliberately
    /// Serialize-only -- see the note on that type. `DeviceInfo` is only ever
    /// serialized outward (`Json<DeviceInfo>` is a response body, never a
    /// request body), so nothing is lost.
    #[serde(skip_serializing_if = "Option::is_none", skip_deserializing)]
    pub capabilities: Option<crate::protocol::capabilities::ScannerCapabilities>,
}

impl DeviceInfo {
    /// Clear the CONNECTION diagnostic, leaving the data diagnostic alone.
    ///
    /// REGRESSION GUARD (`clearing_a_connection_diagnostic_leaves_the_data_one`):
    /// every connect path calls this instead of assigning the two fields
    /// inline. Inline assignment is how the bug happened -- three separate
    /// sites in `api::poll` each blanked `diagnostic_*`, which was correct
    /// until a second kind of diagnostic moved in beside it. Routing the clear
    /// through one method means a future persistent diagnostic is safe by
    /// default rather than safe only if whoever adds it remembers all three
    /// sites.
    pub fn clear_connection_diagnostic(&mut self) {
        self.diagnostic_code = None;
        self.diagnostic_message = None;
    }
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
