#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, path::PathBuf};

use serde::Serialize;
use tauri::Emitter;
use tauri::Manager;

#[derive(Default)]
struct BackendRuntimeState {
    running: AtomicBool,
    bind: Mutex<String>,
    started_at_ms: Mutex<Option<u128>>,
    last_error: Mutex<Option<String>>,
    config_path: Mutex<Option<String>>,
    serial_target: Mutex<Option<String>>,
}

struct ShellState {
    backend: Arc<BackendRuntimeState>,
}

#[derive(Serialize, Clone)]
struct ShellInfo {
    product_name: String,
    version: String,
    backend_bind: String,
    is_desktop: bool,
}

#[derive(Serialize, Clone)]
struct BackendStatus {
    running: bool,
    bind: String,
    started_at_ms: Option<u128>,
    last_error: Option<String>,
    config_path: Option<String>,
    serial_target: Option<String>,
}

fn now_epoch_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn capture_backend_status(state: &BackendRuntimeState) -> BackendStatus {
    let bind = state
        .bind
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| "127.0.0.1:8000".to_string());
    let started_at_ms = state.started_at_ms.lock().ok().and_then(|v| *v);
    let last_error = state.last_error.lock().ok().and_then(|v| v.clone());
    let config_path = state.config_path.lock().ok().and_then(|v| v.clone());
    let serial_target = state.serial_target.lock().ok().and_then(|v| v.clone());

    BackendStatus {
        running: state.running.load(Ordering::Relaxed),
        bind,
        started_at_ms,
        last_error,
        config_path,
        serial_target,
    }
}

fn resolve_config_path() -> Option<String> {
    if let Ok(explicit) = env::var("BEARPAW_CONFIG") {
        let explicit_path = PathBuf::from(explicit);
        if explicit_path.exists() {
            return Some(explicit_path.to_string_lossy().into_owned());
        }
    }

    // In production bundles, check the app data directory for user config
    if let Ok(data_dir) = env::var("BEARPAW_DATA_DIR") {
        let user_cfg = PathBuf::from(&data_dir).join("config.yaml");
        if user_cfg.exists() {
            return Some(user_cfg.to_string_lossy().into_owned());
        }
    }

    // Dev-time paths relative to the source tree
    let mut candidates =
        vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend/config.yaml")];
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd.join("../../backend/config.yaml"));
        candidates.push(cwd.join("../backend/config.yaml"));
        candidates.push(cwd.join("backend/config.yaml"));
    }

    // Check next to the running executable (bundled installs)
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            candidates.push(exe_dir.join("config.yaml"));
        }
    }

    for candidate in candidates {
        if candidate.exists() {
            return Some(candidate.to_string_lossy().into_owned());
        }
    }
    None
}

fn start_backend_runtime(
    state: Arc<BackendRuntimeState>,
    shutdown_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let config_path = resolve_config_path();
    let cfg = bearpaw_api::load_config(config_path.as_deref());
    let api_state = bearpaw_api::default_state();
    let bind = format!("{}:{}", cfg.api.host, cfg.api.port);
    let resolved_serial = bearpaw_api::resolve_serial_port(&cfg);
    let serial_port = resolved_serial
        .clone()
        .map(|p| (p, cfg.device.baud.unwrap_or(115200)));

    let mut startup_issue = None;
    if config_path.is_none() {
        startup_issue =
            Some("Config file not found; using defaults and auto-detect scanner".to_string());
    }
    if resolved_serial.is_none() {
        startup_issue = Some(
            "Scanner port not resolved from config/auto-detect; API running without poll loop"
                .to_string(),
        );
    }

    if let Ok(mut slot) = state.bind.lock() {
        *slot = bind.clone();
    }
    if let Ok(mut slot) = state.started_at_ms.lock() {
        *slot = Some(now_epoch_ms());
    }
    if let Ok(mut slot) = state.last_error.lock() {
        *slot = startup_issue;
    }
    if let Ok(mut slot) = state.config_path.lock() {
        *slot = config_path;
    }
    if let Ok(mut slot) = state.serial_target.lock() {
        *slot = resolved_serial;
    }
    state.running.store(true, Ordering::Relaxed);

    thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(rt) => rt,
            Err(err) => {
                state.running.store(false, Ordering::Relaxed);
                if let Ok(mut slot) = state.last_error.lock() {
                    *slot = Some(format!("tokio runtime init failed: {err}"));
                }
                return;
            }
        };

        let shutdown = async move {
            let _ = shutdown_rx.await;
        };

        let result = runtime.block_on(async {
            bearpaw_api::run_server_with_shutdown(&bind, api_state, serial_port, shutdown).await
        });
        state.running.store(false, Ordering::Relaxed);
        if let Err(err) = result {
            if let Ok(mut slot) = state.last_error.lock() {
                *slot = Some(err.to_string());
            }
        }
    });
}

fn start_status_broadcaster(app_handle: tauri::AppHandle, state: Arc<BackendRuntimeState>) {
    thread::spawn(move || loop {
        let snapshot = capture_backend_status(&state);
        let _ = app_handle.emit("shell://backend-status", snapshot);
        thread::sleep(Duration::from_secs(2));
    });
}

#[tauri::command]
fn shell_info(app: tauri::AppHandle, state: tauri::State<'_, ShellState>) -> ShellInfo {
    let bind = state
        .backend
        .bind
        .lock()
        .map(|s| s.clone())
        .unwrap_or_else(|_| "127.0.0.1:8000".to_string());
    let pkg = app.package_info();
    ShellInfo {
        product_name: pkg.name.clone(),
        version: pkg.version.to_string(),
        backend_bind: bind,
        is_desktop: true,
    }
}

#[tauri::command]
fn backend_status(state: tauri::State<'_, ShellState>) -> BackendStatus {
    capture_backend_status(&state.backend)
}

fn main() {
    let backend_state = Arc::new(BackendRuntimeState::default());
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let shutdown_tx = Arc::new(Mutex::new(Some(shutdown_tx)));

    tauri::Builder::default()
        .manage(ShellState {
            backend: backend_state.clone(),
        })
        .setup(move |app| {
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&data_dir);
                env::set_var("BEARPAW_DATA_DIR", data_dir.to_string_lossy().to_string());

                // Set log dir inside app data so logs don't scatter to CWD
                let log_dir = data_dir.join("logs");
                let _ = std::fs::create_dir_all(&log_dir);
                env::set_var("BEARPAW_LOG_DIR", log_dir.to_string_lossy().to_string());
            }

            // Initialize logging after env vars are set so BEARPAW_LOG_DIR is resolved
            let _logging = bearpaw_api::init_backend_logging("bearpaw-desktop")
                .expect("backend logging initialization failed");
            // Leak the guard so it lives for the process lifetime
            std::mem::forget(_logging);

            start_backend_runtime(backend_state.clone(), shutdown_rx);
            start_status_broadcaster(app.handle().clone(), backend_state.clone());
            Ok(())
        })
        .on_event(move |_app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = &event {
                // Signal the backend to shut down gracefully
                if let Ok(mut tx) = shutdown_tx.lock() {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![shell_info, backend_status])
        .run(tauri::generate_context!())
        .expect("error while running bearpaw application");
}
