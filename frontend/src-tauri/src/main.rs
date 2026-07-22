#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use std::{env, path::PathBuf};

use serde::Serialize;
use tauri::image::Image;
use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// Menu-item IDs emitted as Tauri events when the user clicks them.
///
/// The frontend subscribes to these via `@tauri-apps/api/event::listen`
/// (wired up in PR-B). Each ID also becomes the menu item's accessible
/// label so screen readers and Tauri's built-in event naming line up.
mod menu_ids {
    // View menu — navigate between the three top-level tabs.
    pub const NAV_SCAN: &str = "bearpaw:nav:scan";
    pub const NAV_DEVICE: &str = "bearpaw:nav:device";
    pub const NAV_CHANNELS: &str = "bearpaw:nav:channels";

    // Scanner menu — actions on the physical scanner.
    pub const CMD_HOLD: &str = "bearpaw:cmd:hold";
    pub const CMD_SCAN: &str = "bearpaw:cmd:scan";
    pub const CMD_SYNC_MEMORY: &str = "bearpaw:cmd:sync-memory";

    // Help menu — external links. The About item is a PredefinedMenuItem
    // that opens the OS-native About panel, so it has no event ID.
    pub const HELP_DOCS: &str = "bearpaw:help:docs";
    pub const HELP_ISSUES: &str = "bearpaw:help:issues";
    // Reveals the current backend log file in the OS file manager. Handled
    // entirely in the Rust shell (see on_menu_event) — no frontend event.
    pub const HELP_SHOW_LOGS: &str = "bearpaw:help:show-logs";
}

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

    // Check next to the running executable (bundled installs)
    if let Ok(exe) = env::current_exe() {
        if let Some(exe_dir) = exe.parent() {
            let exe_cfg = exe_dir.join("config.yaml");
            if exe_cfg.exists() {
                return Some(exe_cfg.to_string_lossy().into_owned());
            }
        }
    }

    // No explicit config: fall back to the Rust backend's built-in defaults,
    // which include USB auto-detect for Uniden VID/PID 0x1965:0x0017.
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
    let baud = cfg.device.baud.unwrap_or(115200);
    let assert_dtr = cfg.device.assert_dtr_on_open;
    let serial_port = resolved_serial.clone().map(|p| (p, baud, assert_dtr));

    // `last_error` drives the status-bar "(error)" badge in the UI, so it
    // must only hold real failures. "No config file found" is benign —
    // auto-detect handles it — and `config_path = None` is already exposed
    // in BackendStatus for any caller that cares. Scanner-not-resolved
    // *does* block the app's main job, so it still surfaces.
    let startup_issue = if resolved_serial.is_none() {
        Some(
            "Scanner port not resolved from config/auto-detect; API running without poll loop"
                .to_string(),
        )
    } else {
        None
    };

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

/// Build the native macOS menu bar. The first submenu (the "app" menu) is
/// populated by Tauri with the standard `Bearpaw › About / Hide / Quit`
/// entries. Then our three custom submenus: View, Scanner, Help.
///
/// Each user-action item has a stable string ID that the frontend listens
/// for via `@tauri-apps/api/event::listen(id, ...)`. We don't wire any
/// behaviour to them here; the `on_menu_event` handler below just emits the
/// ID and lets the frontend dispatch.
fn build_menu<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    // Build once and reuse for both the Apple submenu About and the
    // Help → About entry, so the two open the same native panel.
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("Bearpaw"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .authors(Some(vec!["Jeremy Fuksa".to_string()]))
        .website(Some("https://github.com/jeremyfuksa/bearpaw"))
        .website_label(Some("github.com/jeremyfuksa/bearpaw"))
        .comments(Some(
            "Desktop control interface for the Uniden BC125AT scanner.",
        ))
        .copyright(Some("© 2026 Jeremy Fuksa"))
        .icon(Image::from_bytes(include_bytes!("../icons/icon.png")).ok())
        .build();

    // Apple menu — the standard macOS app submenu. About/Hide/Quit live
    // here per platform convention. Tauri's PredefinedMenuItem variants
    // fill in the localised labels.
    let app_submenu = SubmenuBuilder::new(app, "Bearpaw")
        .item(&PredefinedMenuItem::about(
            app,
            Some("About Bearpaw"),
            Some(about_metadata.clone()),
        )?)
        .separator()
        .item(&PredefinedMenuItem::hide(app, None)?)
        .item(&PredefinedMenuItem::hide_others(app, None)?)
        .item(&PredefinedMenuItem::show_all(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;

    // View: navigate between the three top-level tabs. ⌘1/⌘2/⌘3 match
    // common Mac muscle memory (Safari, Finder, etc.).
    let view_submenu = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id(menu_ids::NAV_SCAN, "Scan")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(menu_ids::NAV_DEVICE, "Device")
                .accelerator("CmdOrCtrl+2")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(menu_ids::NAV_CHANNELS, "Channels")
                .accelerator("CmdOrCtrl+3")
                .build(app)?,
        )
        .build()?;

    // Scanner: actions on the physical scanner. Matches the existing
    // keyboard-shortcut handlers in useKeyboardShortcuts.ts where possible.
    let scanner_submenu = SubmenuBuilder::new(app, "Scanner")
        .item(
            &MenuItemBuilder::with_id(menu_ids::CMD_HOLD, "Hold")
                .accelerator("CmdOrCtrl+H")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id(menu_ids::CMD_SCAN, "Scan")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id(menu_ids::CMD_SYNC_MEMORY, "Sync Memory")
                .accelerator("CmdOrCtrl+Y")
                .build(app)?,
        )
        .build()?;

    // Help: external links + the same native About panel that the Apple
    // submenu opens. Both items use `PredefinedMenuItem::about` so the
    // window/title/contents are identical.
    let help_submenu = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id(menu_ids::HELP_DOCS, "Documentation").build(app)?)
        .item(&MenuItemBuilder::with_id(menu_ids::HELP_ISSUES, "GitHub Issues").build(app)?)
        .item(&MenuItemBuilder::with_id(menu_ids::HELP_SHOW_LOGS, "Show Log Files").build(app)?)
        .separator()
        .item(&PredefinedMenuItem::about(
            app,
            Some("About Bearpaw"),
            Some(about_metadata),
        )?)
        .build()?;

    MenuBuilder::new(app)
        .item(&app_submenu)
        .item(&view_submenu)
        .item(&scanner_submenu)
        .item(&help_submenu)
        .build()
}

/// Reveal the current backend log file in the OS file manager so beta
/// users can attach it to a GitHub issue. Best-effort: any failure is
/// logged to stderr and swallowed — this is a diagnostic convenience,
/// not a critical path.
///
/// Targets the most-recently-modified `*.log.*` file rather than a
/// computed date: `tracing_appender::rolling::daily` writes files named
/// `bearpaw-desktop-backend.log.YYYY-MM-DD`, and the newest-modified one
/// is always the file currently being written, regardless of rotation.
fn reveal_logs<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let log_dir = match env::var("BEARPAW_LOG_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => {
            eprintln!("bearpaw: BEARPAW_LOG_DIR not set; cannot reveal logs");
            return;
        }
    };

    let newest = std::fs::read_dir(&log_dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .contains(".log.")
        })
        .filter_map(|entry| {
            let modified = entry.metadata().ok()?.modified().ok()?;
            Some((entry.path(), modified))
        })
        .max_by_key(|(_, modified)| *modified)
        .map(|(path, _)| path);

    let opener = app.opener();
    let result = match newest {
        Some(file) => opener.reveal_item_in_dir(file),
        None => opener.open_path(log_dir.to_string_lossy().to_string(), None::<&str>),
    };

    if let Err(err) = result {
        eprintln!("bearpaw: failed to reveal logs: {}", err);
    }
}

/// Platform-specific data dir for the legacy `com.uniden.bearpaw`
/// bundle identifier. Returns `None` if the platform's home/data env
/// var isn't set (best-effort — migration just doesn't run).
fn legacy_app_data_dir() -> Option<PathBuf> {
    const LEGACY_ID: &str = "com.uniden.bearpaw";

    #[cfg(target_os = "macos")]
    {
        return env::var("HOME").ok().map(|home| {
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join(LEGACY_ID)
        });
    }

    #[cfg(target_os = "windows")]
    {
        return env::var("APPDATA")
            .ok()
            .map(|p| PathBuf::from(p).join(LEGACY_ID));
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        if let Ok(xdg) = env::var("XDG_DATA_HOME") {
            return Some(PathBuf::from(xdg).join(LEGACY_ID));
        }
        env::var("HOME")
            .ok()
            .map(|h| PathBuf::from(h).join(".local").join("share").join(LEGACY_ID))
    }
}

fn copy_dir_contents(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        let ft = entry.file_type()?;
        if ft.is_dir() {
            copy_dir_contents(&from, &to)?;
        } else if ft.is_file() {
            std::fs::copy(&from, &to)?;
        }
        // Symlinks deliberately skipped — keep the migration boring.
    }
    Ok(())
}

/// One-shot migration for the `com.uniden.bearpaw` →
/// `com.jeremyfuksa.bearpaw` bundle-ID rename: if the new app-data
/// directory is empty and the old one exists, copy the contents over.
/// The old directory is left in place so the user can verify and
/// delete it manually. Best-effort: failures are logged to stderr and
/// don't block startup.
fn migrate_legacy_app_data_dir(new_dir: &std::path::Path) {
    let Some(old_dir) = legacy_app_data_dir() else {
        return;
    };
    if !old_dir.is_dir() || old_dir == new_dir {
        return;
    }
    let new_empty = std::fs::read_dir(new_dir)
        .map(|mut it| it.next().is_none())
        .unwrap_or(true);
    if !new_empty {
        return;
    }
    if let Err(err) = copy_dir_contents(&old_dir, new_dir) {
        eprintln!(
            "bearpaw: failed to migrate legacy data from {:?} to {:?}: {}",
            old_dir, new_dir, err
        );
    } else {
        eprintln!(
            "bearpaw: migrated legacy app data from {:?} to {:?}",
            old_dir, new_dir
        );
    }
}

fn main() {
    let backend_state = Arc::new(BackendRuntimeState::default());
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let shutdown_tx = Arc::new(Mutex::new(Some(shutdown_tx)));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ShellState {
            backend: backend_state.clone(),
        })
        .setup(move |app| {
            if let Ok(data_dir) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&data_dir);
                migrate_legacy_app_data_dir(&data_dir);
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

            // Build and install the native menu bar. PR-A only wires the
            // menus + emits events on click; the frontend handlers that
            // make them functional land in PR-B.
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            start_backend_runtime(backend_state.clone(), shutdown_rx);
            start_status_broadcaster(app.handle().clone(), backend_state.clone());
            Ok(())
        })
        .on_menu_event(|app, event| {
            // The menu-item ID is also the event name we emit. Frontend
            // subscribes via `listen("bearpaw:nav:scan", ...)` etc.
            let id = event.id().as_ref();
            // Show Log Files is handled entirely in the shell — reveal the
            // current backend log in the OS file manager, no frontend hop.
            if id == menu_ids::HELP_SHOW_LOGS {
                reveal_logs(app);
                return;
            }
            if let Err(err) = app.emit(id, ()) {
                eprintln!("failed to emit menu event {}: {}", id, err);
            }
        })
        .invoke_handler(tauri::generate_handler![shell_info, backend_status])
        .build(tauri::generate_context!())
        .expect("error while building bearpaw application")
        .run(move |_app, event| {
            // Tauri 2 moved the run-event callback from Builder::on_event
            // to a closure passed to AppHandle::run. Signal the backend to
            // shut down gracefully when the OS asks the app to quit.
            if let tauri::RunEvent::ExitRequested { .. } = &event {
                if let Ok(mut tx) = shutdown_tx.lock() {
                    if let Some(tx) = tx.take() {
                        let _ = tx.send(());
                    }
                }
            }
        });
}
