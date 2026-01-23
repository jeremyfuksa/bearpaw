use crate::config::get_recordings_dir;
use crate::recording::{
    get_filename, get_output_path, list_audio_devices, AudioDevice, RecordingConfig, RecordingInfo,
    RecordingStartParams, SharedBuffer,
};
use std::sync::Arc;
use tauri::State;

pub type RecordingState = std::sync::Arc<std::sync::Mutex<Option<ActiveRecording>>>;

pub struct ActiveRecording {
    pub filename: String,
    pub start_time: u64,
    pub params: RecordingStartParams,
    pub buffer: SharedBuffer,
}

pub type RecordingConfigState = std::sync::Arc<std::sync::Mutex<RecordingConfig>>;

#[tauri::command]
pub fn list_audio_devices_cmd() -> Result<Vec<AudioDevice>, String> {
    Ok(list_audio_devices())
}

#[tauri::command]
pub fn start_recording(
    state: State<'_, RecordingState>,
    config: State<'_, RecordingConfigState>,
    params: RecordingStartParams,
) -> Result<String, String> {
    let config_guard = config.lock().unwrap();
    let mut state_guard = state.lock().unwrap();

    if state_guard.is_some() {
        return Err("Recording already active".to_string());
    }

    let filename = get_filename(&config_guard, &params);
    let output_path = get_output_path(&config_guard, &filename);
    let sample_rate = config_guard.sample_rate;
    let preroll_seconds = config_guard.preroll_seconds;
    drop(config_guard);

    std::fs::create_dir_all(output_path.parent().unwrap())
        .map_err(|e| format!("Failed to create recordings directory: {}", e))?;

    let buffer = Arc::new(std::sync::Mutex::new(
        crate::recording::buffer::AudioBuffer::new(sample_rate, Some(preroll_seconds)),
    ));

    let active = ActiveRecording {
        filename: filename.clone(),
        start_time: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs(),
        params: params.clone(),
        buffer: Arc::clone(&buffer),
    };

    *state_guard = Some(active);
    drop(state_guard);

    Ok(filename)
}

#[tauri::command]
pub fn get_recording_status(
    state: State<'_, RecordingState>,
    config: State<'_, RecordingConfigState>,
) -> Result<RecordingStatus, String> {
    let config_guard = config.lock().unwrap();
    let state_guard = state.lock().unwrap();

    let (recording, duration) = if let Some(active) = state_guard.as_ref() {
        (
            active.filename.clone(),
            (std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_secs()
                - active.start_time) as f64,
        )
    } else {
        (String::new(), 0.0)
    };

    Ok(RecordingStatus {
        state: if state_guard.is_some() {
            "recording".to_string()
        } else {
            "idle".to_string()
        },
        current_recording: if !recording.is_empty() {
            Some(recording)
        } else {
            None
        },
        duration,
        config: config_guard.clone(),
    })
}

#[tauri::command]
pub fn list_recordings(
    config: State<'_, RecordingConfigState>,
) -> Result<Vec<RecordingInfo>, String> {
    let config_guard = config.lock().unwrap();
    let output_path = config_guard.output_path.clone();
    let recordings_dir = std::path::Path::new(&output_path);
    drop(config_guard);

    if !recordings_dir.exists() {
        return Ok(Vec::new());
    }

    let mut recordings = Vec::new();

    for entry in std::fs::read_dir(&recordings_dir)
        .map_err(|e| format!("Failed to read recordings directory: {}", e))?
    {
        let path = entry
            .map_err(|e| format!("Failed to read entry: {}", e))?
            .path();
        let filename = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();

        if path
            .extension()
            .map_or(false, |e| e.to_string_lossy() != "wav")
        {
            continue;
        }

        let metadata = match std::fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => continue,
        };

        let modified = metadata
            .modified()
            .unwrap_or(std::time::SystemTime::UNIX_EPOCH)
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        recordings.push(RecordingInfo {
            id: filename.clone(),
            filename,
            path: path.to_string_lossy().to_string(),
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
pub fn get_recording_config(
    config: State<'_, RecordingConfigState>,
) -> Result<RecordingConfig, String> {
    let config_guard = config.lock().unwrap();
    Ok(config_guard.clone())
}

#[tauri::command]
pub fn delete_recording(
    config: State<'_, RecordingConfigState>,
    filename: String,
) -> Result<bool, String> {
    let config_guard = config.lock().unwrap();
    let path = std::path::Path::new(&config_guard.output_path).join(&filename);
    drop(config_guard);

    if !path.exists() {
        return Ok(false);
    }

    std::fs::remove_file(&path).map_err(|e| format!("Failed to delete recording: {}", e))?;

    Ok(true)
}

#[tauri::command]
pub fn stop_recording(
    state: State<'_, RecordingState>,
    config: State<'_, RecordingConfigState>,
) -> Result<RecordingInfo, String> {
    let config_guard = config.lock().unwrap();
    let mut state_guard = state.lock().unwrap();

    let active = state_guard.take().ok_or("No active recording")?;

    let output_path = get_output_path(&config_guard, &active.filename);
    drop(config_guard);

    let end_time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();

    let duration = (end_time - active.start_time) as f64;

    let size = std::fs::metadata(&output_path)
        .map(|m| m.len())
        .unwrap_or(0);

    let info = RecordingInfo {
        id: active.filename.clone(),
        filename: active.filename.clone(),
        path: output_path.to_string_lossy().to_string(),
        start_time: active.start_time,
        end_time: Some(end_time),
        duration,
        size_bytes: size,
        frequency: active.params.frequency,
        alpha_tag: active.params.alpha_tag,
    };

    drop(state_guard);

    Ok(info)
}

#[tauri::command]
pub fn update_recording_config(
    config: State<'_, RecordingConfigState>,
    new_config: RecordingConfig,
) -> Result<(), String> {
    let mut config_guard = config.lock().unwrap();
    *config_guard = new_config;
    Ok(())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
pub struct RecordingStatus {
    pub state: String,
    pub current_recording: Option<String>,
    pub duration: f64,
    pub config: RecordingConfig,
}
