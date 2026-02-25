//! Control commands sent from API to poll loop: Hold, Scan, Direct tune.

use serde::Deserialize;

/// Command for the poll thread to send to the scanner.
#[derive(Clone, Debug)]
pub enum ControlCommand {
    Hold,
    Scan,
    Direct {
        frequency: f64,
        modulation: String,
    },
    /// Run full memory sync (PRG -> CIN 1..max_channels -> EPG); progress via WebSocket.
    StartSync { task_id: String, max_channels: u16 },
}

/// Request body for POST /api/v1/frequency
#[derive(Deserialize)]
pub struct FrequencyRequest {
    pub frequency: f64,
    #[serde(default = "default_modulation")]
    pub modulation: String,
}

fn default_modulation() -> String {
    "FM".to_string()
}

/// Frequency range for BC125AT/SR30C (MHz).
pub const FREQ_MIN: f64 = 25.0;
pub const FREQ_MAX: f64 = 512.0;

pub const MODES: &[&str] = &["FM", "AM", "NFM", "AUTO"];

pub fn validate_frequency(freq: f64) -> Result<(), String> {
    if !freq.is_finite() || freq < FREQ_MIN || freq > FREQ_MAX {
        return Err(format!(
            "Frequency must be between {} and {} MHz",
            FREQ_MIN, FREQ_MAX
        ));
    }
    Ok(())
}

pub fn validate_modulation(modulation: &str) -> Result<(), String> {
    let m = modulation.to_uppercase();
    if MODES.iter().any(|&s| s == m) {
        Ok(())
    } else {
        Err(format!(
            "Modulation must be one of: {}",
            MODES.join(", ")
        ))
    }
}
