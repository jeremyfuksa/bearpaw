use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::AppHandle;
use crate::config::get_config_dir;

pub struct SidecarManager {
    child: Arc<Mutex<Option<Child>>>,
    app_handle: AppHandle,
}

impl SidecarManager {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            child: Arc::new(Mutex::new(None)),
            app_handle,
        }
    }

    pub async fn spawn(&self) -> Result<(), String> {
        let config_dir = get_config_dir();
        std::fs::create_dir_all(&config_dir)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;

        let config_path = config_dir.join("config.yaml");
        ensure_default_config(&config_path)?;
        let sidecar_path = get_sidecar_path()?;

        let child = Command::new(&sidecar_path)
            .arg("--config")
            .arg(&config_path)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

        let mut child_guard = self.child.lock().await;
        *child_guard = Some(child);
        drop(child_guard);

        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;

        Ok(())
    }

    pub async fn kill(&self) -> Result<(), String> {
        let mut child_guard = self.child.lock().await;
        if let Some(mut child) = child_guard.take() {
            child.kill()
                .map_err(|e| format!("Failed to kill sidecar: {}", e))?;
            let _ = child.wait();
        }
        Ok(())
    }

    pub async fn restart(&self) -> Result<(), String> {
        self.kill().await?;
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
        self.spawn().await
    }
}

fn yaml_single_quoted(path: &Path) -> String {
    let value = path.to_string_lossy().replace('\'', "''");
    format!("'{value}'")
}

fn ensure_default_config(config_path: &Path) -> Result<(), String> {
    if config_path.exists() {
        return Ok(());
    }

    let config_dir = config_path
        .parent()
        .ok_or_else(|| "Config path has no parent directory".to_string())?;

    let scanner_db = config_dir.join("scanner.db");
    let analytics_db = config_dir.join("analytics.db");

    let yaml = format!(
        "device:\n  auto_detect: true\n\
api:\n  host: \"127.0.0.1\"\n  port: 8000\n\
state:\n  persistence: \"sqlite\"\n  db_path: {}\n\
analytics:\n  enabled: true\n  db_path: {}\n  retention_days: 30\n  cleanup_interval_hours: 24\n  min_hit_duration: 1.0\n\
logging:\n  level: \"INFO\"\n  format: \"%(levelname)s %(message)s\"\n",
        yaml_single_quoted(&scanner_db),
        yaml_single_quoted(&analytics_db),
    );

    std::fs::write(config_path, yaml)
        .map_err(|e| format!("Failed to write default config: {}", e))?;

    Ok(())
}

fn get_sidecar_path() -> Result<std::path::PathBuf, String> {
    let exe_dir = std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {}", e))?
        .parent()
        .ok_or("Failed to get parent directory")?
        .to_path_buf();

    #[cfg(target_os = "windows")]
    let mut sidecar_path = exe_dir.join("scanner-bridge.exe");

    #[cfg(not(target_os = "windows"))]
    let mut sidecar_path = exe_dir.join("scanner-bridge");

    if !sidecar_path.exists() {
        if let Ok(entries) = std::fs::read_dir(exe_dir.join("binaries")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.file_name().map_or(false, |n| n.to_string_lossy().contains("scanner-bridge")) {
                    sidecar_path = path;
                    break;
                }
            }
        }
    }

    if !sidecar_path.exists() {
        return Err(format!(
            "Sidecar binary not found. Looked for {}",
            sidecar_path.display()
        ));
    }

    Ok(sidecar_path)
}
