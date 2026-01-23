use tauri::State;
use crate::sidecar::SidecarManager;

pub type SidecarState = std::sync::Arc<SidecarManager>;

#[tauri::command]
pub async fn spawn_sidecar(state: State<'_, SidecarState>) -> Result<(), String> {
    state.spawn().await
}

#[tauri::command]
pub async fn kill_sidecar(state: State<'_, SidecarState>) -> Result<(), String> {
    state.kill().await
}

#[tauri::command]
pub async fn restart_sidecar(state: State<'_, SidecarState>) -> Result<(), String> {
    state.restart().await
}
