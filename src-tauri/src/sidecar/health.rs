use std::time::Duration;
use tokio::time::interval;
use tauri::{AppHandle, Emitter};

const HEALTH_CHECK_URL: &str = "http://127.0.0.1:8000/api/v1/status";
const CHECK_INTERVAL: Duration = Duration::from_secs(5);
const MAX_FAILURES: u32 = 3;

pub struct HealthMonitor {
    app_handle: AppHandle,
    failure_count: u32,
}

impl HealthMonitor {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            failure_count: 0,
        }
    }

    pub fn start(self) {
        tokio::spawn(async move {
            let mut ticker = interval(CHECK_INTERVAL);
            let mut monitor = self;

            loop {
                ticker.tick().await;

                let is_healthy = check_health().await;

                if is_healthy {
                    monitor.failure_count = 0;
                    let _ = monitor.app_handle.emit("sidecar:health", "healthy");
                } else {
                    monitor.failure_count += 1;
                    let _ = monitor.app_handle.emit("sidecar:health", "unhealthy");

                    if monitor.failure_count >= MAX_FAILURES {
                        let _ = monitor.app_handle.emit("sidecar:crash", "Backend health check failed");
                        monitor.failure_count = 0;
                    }
                }
            }
        });
    }
}

async fn check_health() -> bool {
    match reqwest::get(HEALTH_CHECK_URL).await {
        Ok(response) => response.status().is_success(),
        Err(_) => false,
    }
}
