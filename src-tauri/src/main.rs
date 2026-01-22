#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Child;
use std::sync::Mutex;
use tauri::Manager;
mod recording;
use recording::{RecordingConfig, RecordingState};

// Store Python backend process
struct BackendProcess(Mutex<Option<Child>>);

// Store recording state
type RecordingAppState = Mutex<Option<RecordingState>>;

#[derive(Clone, serde::Serialize)]
struct AppState {
    #[serde(skip)]
    backend: BackendProcess,
    #[serde(skip)]
    recording: RecordingAppState,
}

fn main() {
    let config = RecordingConfig::default();
    let recording_state = RecordingState::new(config.clone());

    tauri::Builder::default()
        .manage(AppState {
            backend: BackendProcess(Mutex::new(None)),
            recording: Mutex::new(recording_state),
        })
        .setup(|app| {
            // Spawn Python backend on startup
            #[cfg(debug_assertions)]
            {
                // Development: Start backend manually
                println!("Development mode: Start backend manually in separate terminal with:");
                println!("cd backend && source .venv/bin/activate && python -m scanner_bridge --config config.yaml");
            }

            #[cfg(not(debug_assertions))]
            {
                // Production: Spawn sidecar
                let resource_path = app.path().resource_dir()
                    .expect("Failed to get resource directory");

                let bin_path = resource_path.join("binaries").join("scanner-bridge");

                // Use platform-specific executable extension
                #[cfg(target_os = "windows")]
                let bin_path = bin_path.with_extension("exe");

                println!("Spawning backend: {:?}", bin_path);

                let child = std::process::Command::new(&bin_path)
                    .current_dir(resource_path)
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped())
                    .spawn()
                    .expect("Failed to start Python backend");

                app.manage(BackendProcess(Mutex::new(Some(child))));

                println!("Backend spawned successfully on {}", bin_path.display());
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api: _, .. } => {
                    // Gracefully shutdown backend
                    if let Some(backend) = window.try_state::<BackendProcess>() {
                        let mut process = backend.0.lock().unwrap();
                        if let Some(mut child) = process.take() {
                            println!("Shutting down backend process...");
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                    window.close().unwrap();
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            start_recording,
            stop_recording,
            get_recording_status,
            list_recordings,
            delete_recording,
            list_audio_devices,
            update_recording_config,
            get_recording_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
