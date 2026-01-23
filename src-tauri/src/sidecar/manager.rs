use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{AppHandle, Emitter};
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

fn get_sidecar_path() -> Result<std::path::PathBuf, String> {
    let resource_dir = std::env::current_exe()
        .map_err(|e| format!("Failed to get exe path: {}", e))?
        .parent()
        .ok_or("Failed to get parent directory")?
        .to_path_buf();

    #[cfg(target_os = "windows")]
    let mut sidecar_path = resource_dir.join("binaries").join("scanner-bridge.exe");

    #[cfg(not(target_os = "windows"))]
    let mut sidecar_path = resource_dir.join("binaries").join("scanner-bridge");

    if !sidecar_path.exists() {
        #[cfg(target_os = "windows")]
        let _sidecar_name = "scanner-bridge.exe";

        #[cfg(not(target_os = "windows"))]
        let _sidecar_name = "scanner-bridge";

        if let Ok(entries) = std::fs::read_dir(resource_dir.join("binaries")) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.file_name().map_or(false, |n| n.to_string_lossy().contains("scanner-bridge")) {
                    sidecar_path = path;
                    break;
                }
            }
        }
    }

    Ok(sidecar_path)
}
