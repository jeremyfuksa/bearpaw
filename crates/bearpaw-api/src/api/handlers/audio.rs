use axum::Json;
use serde::Serialize;

use super::super::ApiError;
use crate::audio::{list_input_devices, AudioDeviceInfo};

#[derive(Serialize)]
pub(crate) struct AudioDevices {
    devices: Vec<AudioDeviceInfo>,
}

pub(crate) async fn get_audio_devices() -> Result<Json<AudioDevices>, ApiError> {
    discover(list_input_devices).await
}

// Host audio APIs may block. Keep discovery off the async runtime's workers
// and distinguish both host failures and worker failures from an empty host.
async fn discover(
    query: impl FnOnce() -> Result<Vec<AudioDeviceInfo>, String> + Send + 'static,
) -> Result<Json<AudioDevices>, ApiError> {
    let devices = tokio::task::spawn_blocking(query)
        .await
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
    async fn device_response_preserves_native_format_and_empty_hosts() {
        let result = discover(|| {
            Ok(vec![AudioDeviceInfo {
                name: "USB Input".into(),
                channels: 2,
                sample_rate: 48_000,
            }])
        })
        .await;
        assert_eq!(
            response(result).await,
            (
                StatusCode::OK,
                json!({
                    "devices": [{"name": "USB Input", "channels": 2, "sample_rate": 48000}]
                })
            )
        );
        assert_eq!(
            response(discover(|| Ok(vec![])).await).await,
            (StatusCode::OK, json!({"devices": []}))
        );
    }

    #[tokio::test]
    async fn enumeration_and_worker_failures_use_the_api_error_envelope() {
        let host = discover(|| Err("audio_enumerate_failed: unavailable".into())).await;
        let worker = discover(|| panic!("failed worker")).await;
        for result in [host, worker] {
            let (status, body) = response(result).await;
            assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
            assert_eq!(body["code"], 500);
            assert_eq!(body["error"], body["message"]);
            assert!(body["error"].as_str().unwrap().starts_with("audio_"));
            assert!(body.get("devices").is_none());
        }
    }
}
