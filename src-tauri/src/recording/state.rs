use crate::config::get_recordings_dir;
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordingConfig {
    pub output_path: String,
    pub format: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub device_index: Option<usize>,
    pub preroll_seconds: usize,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            output_path: get_recordings_dir().to_string_lossy().to_string(),
            format: "wav".to_string(),
            sample_rate: 44100,
            channels: 1,
            device_index: None,
            preroll_seconds: 10,
        }
    }
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordingInfo {
    pub id: String,
    pub filename: String,
    pub path: String,
    pub start_time: u64,
    pub end_time: Option<u64>,
    pub duration: f64,
    pub size_bytes: u64,
    pub frequency: Option<f64>,
    pub alpha_tag: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RecordingStartParams {
    pub frequency: Option<f64>,
    pub alpha_tag: Option<String>,
}

pub fn get_filename(config: &RecordingConfig, params: &RecordingStartParams) -> String {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let time_str = chrono::DateTime::<chrono::Utc>::from_timestamp(timestamp as i64, 0)
        .unwrap()
        .format("%Y%m%d_%H%M%S");

    let freq_str = if let Some(freq) = params.frequency {
        format!("_{:.4}MHz", freq)
    } else {
        String::new()
    };

    format!("recording_{}{}.{}", time_str, freq_str, config.format)
}

pub fn get_output_path(config: &RecordingConfig, filename: &str) -> PathBuf {
    let mut path = PathBuf::from(&config.output_path);
    path.push(filename);
    path
}
