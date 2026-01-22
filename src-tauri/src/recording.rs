use rodio::{OutputStream, OutputStreamHandle, OutputStreamSettings, Sink, Source};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::State;
use tempfile::NamedTempFile;

#[derive(Debug, Serialize, Deserialize)]
pub struct RecordingConfig {
    pub output_path: String,
    pub format: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub device_index: Option<usize>,
}

impl Default for RecordingConfig {
    fn default() -> Self {
        Self {
            output_path: "./recordings".to_string(),
            format: "wav".to_string(),
            sample_rate: 44100,
            channels: 1,
            device_index: None,
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

#[derive(Debug, Serialize, Deserialize)]
pub struct AudioDevice {
    pub index: usize,
    pub name: String,
    pub channels: u16,
    pub sample_rate: u32,
}

struct RecordingState {
    active: Option<RecordingSession>,
    config: RecordingConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordingStartParams {
    pub frequency: Option<f64>,
    pub alpha_tag: Option<String>,
}

impl RecordingState {
    fn new(config: RecordingConfig) -> Self {
        Self {
            active: None,
            config,
        }
    }

    pub fn list_audio_devices(&self) -> Vec<AudioDevice> {
        let mut devices = Vec::new();
        if let Ok(host) = cpal::default_host() {
            for device_index in 0..host.output_devices().len() {
                if let Some(device) = host.output_devices().get(device_index) {
                    devices.push(AudioDevice {
                        index: device_index,
                        name: device.name().into(),
                        channels: device.max_output_channels() as u16,
                        sample_rate: device.default_output_config().sample_rate().0,
                    });
                }
            }
        }
        devices
    }

    pub fn get_output_path(&self, filename: &str) -> PathBuf {
        let mut path = PathBuf::from(&self.config.output_path);
        path.push(filename);
        path
    }

    pub fn get_filename(&self, frequency: Option<f64>) -> String {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let time_str = chrono::offset::Utc::timestamp_opt(timestamp, 0)
            .unwrap()
            .format("%Y%m%d_%H%M%S");

        let freq_str = if let Some(freq) = frequency {
            format!("_{:.4}MHz", freq)
        } else {
            String::new()
        };

        format!("recording_{}{}.{}", time_str, freq_str, self.config.format)
    }
}

#[derive(Debug)]
struct RecordingSession {
    id: String,
    filename: String,
    temp_file: NamedTempFile<File>,
    start_time: u64,
    frequency: Option<f64>,
    alpha_tag: Option<String>,
}

impl RecordingSession {
    fn new(params: RecordingStartParams, config: &RecordingConfig) -> Self {
        let filename = config.get_filename(params.frequency);
        let temp_file = NamedTempFile::new().unwrap();

        Self {
            id: filename.clone(),
            filename: filename.clone(),
            temp_file,
            start_time: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_secs(),
            frequency: params.frequency,
            alpha_tag: params.alpha_tag,
        }
    }

    fn duration(&self) -> f64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            - self.start_time
    }

    pub fn to_info(&self, path: &Path, size: u64) -> RecordingInfo {
        RecordingInfo {
            id: self.id.clone(),
            filename: self.filename.clone(),
            path: path.to_string_lossy().into(),
            start_time: self.start_time,
            end_time: Some(
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_secs(),
            ),
            duration: self.duration(),
            size_bytes: size,
            frequency: self.frequency,
            alpha_tag: self.alpha_tag.clone(),
        }
    }
}

type RecordingStateMutex = Mutex<RecordingState>;

#[tauri::command]
pub fn start_recording(
    state: State<RecordingStateMutex>,
    params: RecordingStartParams,
) -> Result<String, String> {
    let mut state = state.lock().unwrap();

    if state.active.is_some() {
        return Err("Recording already active".to_string());
    }

    let temp_file = NamedTempFile::new().unwrap();
    let filename = state.get_filename(params.frequency);
    let start_time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs();

    state.active = Some(RecordingSession::new(params, &state.config));

    Ok(filename)
}

#[tauri::command]
pub fn stop_recording(state: State<RecordingStateMutex>) -> Result<RecordingInfo, String> {
    let mut state = state.lock().unwrap();

    let session = state.active.take().ok_or("No active recording")?;

    let duration = session.duration();
    let temp_path = session.temp_file.path().to_path_buf();
    let output_path = state.get_output_path(&session.filename);

    std::fs::create_dir_all(output_path.parent().unwrap())?;

    std::fs::rename(&temp_path, &output_path)
        .map_err(|e| format!("Failed to rename recording: {}", e))?;

    let size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    let info = session.to_info(&output_path, size);

    Ok(info)
}

#[tauri::command]
pub fn get_recording_status(state: State<RecordingStateMutex>) -> Result<RecordingStatus, String> {
    let state = state.lock().unwrap();

    let (recording, duration) = if let Some(session) = &state.active {
        (session.id.clone(), session.duration())
    } else {
        (String::new(), 0.0)
    };

    Ok(RecordingStatus {
        state: if state.active.is_some() {
            "recording".to_string()
        } else {
            "idle".to_string()
        },
        current_recording: Some(recording),
        duration,
        config: RecordingConfig {
            output_path: state.config.output_path.clone(),
            format: state.config.format.clone(),
            sample_rate: state.config.sample_rate,
            channels: state.config.channels,
            device_index: state.config.device_index,
        },
    })
}

#[tauri::command]
pub fn list_recordings(state: State<RecordingStateMutex>) -> Result<Vec<RecordingInfo>, String> {
    let state = state.lock().unwrap();
    let recordings_dir = Path::new(&state.config.output_path);

    if !recordings_dir.exists() {
        return Ok(Vec::new());
    }

    let mut recordings = Vec::new();

    for entry in std::fs::read_dir(&recordings_dir)
        .map_err(|e| format!("Failed to read recordings directory: {}", e))?
    {
        let path = entry.path();
        let filename = entry.file_name();

        if path.extension().map_or("", |e| e.to_lowercase()) != "wav" {
            continue;
        }

        let metadata = std::fs::metadata(&path).unwrap_or_else(|_| std::fs::Metadata {
            is_dir: false,
            is_file: true,
            is_symlink: false,
            size: 0,
            modified: SystemTime::UNIX_EPOCH,
            accessed: SystemTime::UNIX_EPOCH,
            created: SystemTime::UNIX_EPOCH,
        });

        let modified = metadata
            .modified()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();

        recordings.push(RecordingInfo {
            id: filename.clone(),
            filename: filename.clone(),
            path: path.to_string_lossy().into(),
            start_time: modified,
            end_time: None,
            duration: 0.0,
            size_bytes: metadata.len(),
            frequency: None,
            alpha_tag: None,
        });
    }

    recordings.sort_by(|a, b| b.start_time.partial_cmp(&a.start_time).unwrap());
    Ok(recordings)
}

#[tauri::command]
pub fn delete_recording(
    state: State<RecordingStateMutex>,
    filename: String,
) -> Result<bool, String> {
    let state = state.lock().unwrap();
    let path = state.get_output_path(&filename);

    if !path.exists() {
        return Ok(false);
    }

    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete recording: {}", e))?;

    Ok(true)
}

#[tauri::command]
pub fn update_recording_config(
    state: State<RecordingStateMutex>,
    config: RecordingConfig,
) -> Result<(), String> {
    let mut state = state.lock().unwrap();
    state.config = config;
    Ok(())
}

#[tauri::command]
pub fn get_recording_config(state: State<RecordingStateMutex>) -> Result<RecordingConfig, String> {
    let state = state.lock().unwrap();
    Ok(state.config.clone())
}

#[derive(Debug, Serialize, Deserialize)]
pub struct RecordingStatus {
    pub state: String,
    pub current_recording: Option<String>,
    pub duration: f64,
    pub config: RecordingConfig,
}

mod cpal {
    pub use rodio::cpal;
}

mod chrono {
    pub use chrono;
}
