use axum::Json;
use serde::Serialize;
use std::time::Duration;

use super::super::ApiError;
use crate::audio::{list_input_devices, AudioDeviceInfo};

#[derive(Serialize)]
pub(crate) struct AudioDevices {
    devices: Vec<AudioDeviceInfo>,
}

pub(crate) async fn get_audio_devices() -> Result<Json<AudioDevices>, ApiError> {
    discover(list_input_devices, Duration::from_secs(5)).await
}

// Host audio APIs may block. Keep discovery off the async runtime's workers
// and distinguish both host failures and worker failures from an empty host.
async fn discover(
    query: impl FnOnce() -> Result<Vec<AudioDeviceInfo>, String> + Send + 'static,
    deadline: Duration,
) -> Result<Json<AudioDevices>, ApiError> {
    // A timeout bounds the HTTP wait, not the underlying OS call: Tokio cannot
    // cancel a blocking task once started.
    let devices = tokio::time::timeout(deadline, tokio::task::spawn_blocking(query))
        .await
        .map_err(|_| ApiError::Internal("audio_discovery_timeout".into()))?
        .map_err(|e| ApiError::Internal(format!("audio_discovery_task_failed: {e}")))?
        .map_err(ApiError::Internal)?;
    Ok(Json(AudioDevices { devices }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{body::to_bytes, http::StatusCode, response::IntoResponse};
    use serde_json::{json, Value};

    async fn response(result: Result<Json<AudioDevices>, ApiError>) -> (StatusCode, Value) {
        let response = result.into_response();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&body).unwrap())
    }

    #[tokio::test]
    async fn device_response_preserves_cpal_format_and_empty_hosts() {
        let result = discover(
            || {
                Ok(vec![AudioDeviceInfo {
                    id: "0:USB Input".into(),
                    name: "USB Input".into(),
                    channels: 2,
                    sample_rate: 48_000,
                }])
            },
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(
            response(result).await,
            (
                StatusCode::OK,
                json!({
                    "devices": [{"id": "0:USB Input", "name": "USB Input", "channels": 2, "sample_rate": 48000}]
                })
            )
        );
        assert_eq!(
            response(discover(|| Ok(vec![]), Duration::from_secs(5)).await).await,
            (StatusCode::OK, json!({"devices": []}))
        );
    }

    #[tokio::test]
    async fn enumeration_and_worker_failures_use_the_api_error_envelope() {
        let host = discover(
            || Err("audio_enumerate_failed: unavailable".into()),
            Duration::from_secs(5),
        )
        .await;
        let worker = discover(|| panic!("failed worker"), Duration::from_secs(5)).await;
        for result in [host, worker] {
            let (status, body) = response(result).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(body["code"], 500);
            assert_eq!(body["error"], body["message"]);
            assert!(body["error"].as_str().unwrap().starts_with("audio_"));
            assert!(body.get("devices").is_none());
        }
    }

    #[tokio::test]
    async fn a_blocked_query_times_out_with_the_api_error_envelope() {
        let (release, wait) = std::sync::mpsc::channel::<()>();
        let result = discover(
            move || {
                let _ = wait.recv();
                Ok(vec![])
            },
            Duration::from_millis(10),
        )
        .await;
        // Release the worker even when the assertion fails; runtime shutdown
        // otherwise waits for this deliberately blocked task.
        let _ = release.send(());
        assert_eq!(
            response(result).await,
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({"error": "audio_discovery_timeout", "message": "audio_discovery_timeout", "code": 500})
            )
        );
    }
}
