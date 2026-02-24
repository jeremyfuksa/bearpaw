#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod sidecar;
mod recording;
mod config;

use tauri::Manager;

#[tokio::main]
async fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let app_handle = app.handle().clone();

            let sidecar_manager = sidecar::SidecarManager::new(app_handle.clone());
            let sidecar_state = std::sync::Arc::new(sidecar_manager);

            #[cfg(not(debug_assertions))]
            {
                let manager = sidecar_state.clone();
                tokio::spawn(async move {
                    if let Err(e) = manager.spawn().await {
                        eprintln!("Failed to spawn sidecar: {}", e);
                    }
                });
            }

            app.manage(sidecar_state);
            app.manage(std::sync::Arc::new(std::sync::Mutex::new(None::<commands::recording::ActiveRecording>)));
            app.manage(std::sync::Arc::new(std::sync::Mutex::new(recording::RecordingConfig::default())));

            #[cfg(not(debug_assertions))]
            {
                let health_monitor = sidecar::HealthMonitor::new(app_handle);
                health_monitor.start();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api: _, .. } = event {
                #[cfg(not(debug_assertions))]
                {
                    if let Some(sidecar) = window.try_state::<commands::sidecar::SidecarState>() {
                        let manager = sidecar.inner().clone();
                        tokio::spawn(async move {
                            let _ = manager.kill().await;
                        });
                    }
                }
                window.close().unwrap();
            }
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::sidecar::spawn_sidecar,
            commands::sidecar::kill_sidecar,
            commands::sidecar::restart_sidecar,
            commands::recording::list_audio_devices_cmd,
            commands::recording::start_recording,
            commands::recording::stop_recording,
            commands::recording::get_recording_status,
            commands::recording::list_recordings,
            commands::recording::delete_recording,
            commands::recording::update_recording_config,
            commands::recording::get_recording_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
