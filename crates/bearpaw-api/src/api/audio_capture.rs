//! Explicit start/stop/status for the one host input. Nothing starts capture at
//! launch, nothing consumes its frames, and nothing is written to disk yet:
//! **recording still does not work in the app**.
//!
//! Selection is a discovery id (`index:name`, see `audio::device_id`), which is
//! only meaningful within one enumeration and topology. A stored id that no
//! longer resolves is refused by name rather than replaced with the default
//! input, so the UI can say which input is gone instead of quietly capturing a
//! different one.

use std::sync::mpsc::Receiver;
use std::sync::Arc;

use axum::{extract::State, Json};
use serde_json::{json, Value};

use super::{ApiError, AppState};
use crate::audio::{
    capture::{Capture, CaptureStatus, Frames},
    list_input_devices, AudioDeviceInfo,
};

/// Preferences key holding the selected input's discovery id. Empty means
/// nothing has been chosen; it is never silently resolved to a default input.
pub(crate) const PREFERENCE_KEY: &str = "audio_input_device";

/// One running capture. Keeping the receiver alive with the handle mirrors how
/// the next slice will own it; dropping both stops the stream.
pub(crate) trait Session: Send {
    fn status(&self) -> CaptureStatus;
}

impl Session for (Capture, Receiver<Frames>) {
    fn status(&self) -> CaptureStatus {
        self.0.status()
    }
}

/// Everything that touches audio hardware, behind one seam so the lifecycle is
/// testable without a device.
pub(crate) trait Host: Send + Sync {
    fn inputs(&self) -> Result<Vec<AudioDeviceInfo>, String>;
    fn spawn(&self, id: &str) -> Result<Box<dyn Session>, String>;
}

struct RealHost;

impl Host for RealHost {
    fn inputs(&self) -> Result<Vec<AudioDeviceInfo>, String> {
        list_input_devices()
    }

    fn spawn(&self, id: &str) -> Result<Box<dyn Session>, String> {
        Capture::spawn(id.to_string())
            .map(|capture| Box::new(capture) as Box<dyn Session>)
            .map_err(|e| e.to_string())
    }
}

/// Owns at most one capture. Every operation is safe to call in any order.
pub(crate) struct CaptureService {
    host: Arc<dyn Host>,
    session: Option<Box<dyn Session>>,
    /// Status of the session that is gone, so a stopped or failed start still
    /// reports the device it used and the error it hit.
    last: CaptureStatus,
}

impl CaptureService {
    pub(crate) fn new() -> Self {
        Self::with_host(Arc::new(RealHost))
    }

    pub(crate) fn with_host(host: Arc<dyn Host>) -> Self {
        Self {
            host,
            session: None,
            last: CaptureStatus::default(),
        }
    }

    pub(crate) fn status(&self) -> CaptureStatus {
        let mut status = match &self.session {
            Some(session) => session.status(),
            None => {
                let mut last = self.last.clone();
                last.running = false;
                last.connected = false;
                last
            }
        };
        // A session handle whose worker has exited is still a stopped capture.
        status.connected &= status.running;
        status
    }

    /// Idempotent: a running capture is returned untouched and the host is not
    /// touched, so re-posting start neither re-enumerates nor switches inputs.
    /// Changing the selection therefore takes effect on the next stop/start.
    ///
    /// Callers serialise this (the state holds one mutex), which is what makes
    /// "check running, then spawn" safe.
    pub(crate) fn start(&mut self, selected: Option<&str>) -> Result<CaptureStatus, ApiError> {
        if self.status().running {
            return Ok(self.status());
        }
        // A worker that died is never reused; drop it before spawning again.
        self.session = None;
        match self.spawn(selected) {
            Ok(session) => {
                self.session = Some(session);
                Ok(self.status())
            }
            Err(error) => {
                // A start that never opened a stream is still an answer to
                // "why is nothing running?", so keep it for the status route.
                self.last = CaptureStatus {
                    last_error: Some(error_message(&error)),
                    ..self.last.clone()
                };
                Err(error)
            }
        }
    }

    fn spawn(&self, selected: Option<&str>) -> Result<Box<dyn Session>, ApiError> {
        // Ids are opaque: a device name can begin or end with spaces, and
        // discovery puts the name in verbatim. Trim only to ask "is anything
        // selected?"; the stored id reaches lookup and spawn unchanged.
        let id = selected
            .filter(|id| !id.trim().is_empty())
            .ok_or_else(|| ApiError::BadRequest("audio_input_required".into()))?;
        let inputs = self.host.inputs().map_err(ApiError::Internal)?;
        if !inputs.iter().any(|input| input.id == id) {
            // Ids are topology-sensitive. Name the failure; do not fall back to
            // the default input or the first one that happens to be present.
            //
            // Known limit, not an oversight: an id is `index:name`, so two
            // same-named inputs that exchange enumeration positions between
            // launches each still resolve -- to the sibling. The id cannot
            // express the difference, and refusing every duplicated name would
            // also refuse a selection the user just made from a fresh list.
            // Telling them apart needs a stable per-device identity in
            // discovery, which this slice deliberately does not change.
            return Err(ApiError::NotFound("audio_input_not_found".into()));
        }
        self.host
            .spawn(id)
            .map_err(|e| ApiError::Internal(format!("audio_capture_start_failed: {e}")))
    }

    /// Idempotent. Dropping the handle only signals its owner thread, which
    /// closes the device on its own schedule; this never joins a slow close.
    pub(crate) fn stop(&mut self) -> CaptureStatus {
        let status = self.status();
        self.session = None;
        self.last = status;
        self.last.running = false;
        self.last.connected = false;
        self.status()
    }
}

fn error_message(error: &ApiError) -> String {
    match error {
        ApiError::BadRequest(m) | ApiError::NotFound(m) | ApiError::Internal(m) => m.clone(),
        _ => "audio_capture_start_failed".to_string(),
    }
}

fn response(status: CaptureStatus) -> Json<Value> {
    Json(json!({
        "running": status.running,
        "connected": status.connected,
        "device_name": status.device_name,
        "last_error": status.last_error,
        "dropped_frames": status.dropped_frames,
    }))
}

// Enumeration, the device open and a queued close can each block for seconds,
// so they run off the async workers. Unlike discovery there is no HTTP timeout:
// timing out a start would report failure while a detached task went on to open
// a stream nobody owns.
async fn run(
    state: AppState,
    op: impl FnOnce(&mut CaptureService) -> Result<CaptureStatus, ApiError> + Send + 'static,
) -> Result<Json<Value>, ApiError> {
    tokio::task::spawn_blocking(move || {
        let mut service = state.audio_capture.lock().unwrap();
        op(&mut service).map(response)
    })
    .await
    .map_err(|e| ApiError::Internal(format!("audio_capture_task_failed: {e}")))?
}

pub(crate) async fn start(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let selected = state
        .preferences
        .lock()
        .unwrap()
        .get(PREFERENCE_KEY)
        .and_then(Value::as_str)
        .map(str::to_string);
    run(state, move |service| service.start(selected.as_deref())).await
}

pub(crate) async fn stop(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    run(state, |service| Ok(service.stop())).await
}

pub(crate) async fn status(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    run(state, |service| Ok(service.status())).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    // Replaces the real host so no audio device, permission or OS call is needed.
    struct FakeHost {
        inputs: Vec<String>,
        spawns: AtomicUsize,
        last_id: std::sync::Mutex<Option<String>>,
        fail_spawn: bool,
        drop_frames: u64,
    }

    impl Host for FakeHost {
        fn inputs(&self) -> Result<Vec<AudioDeviceInfo>, String> {
            Ok(self.inputs.iter().map(|id| input(id)).collect())
        }

        fn spawn(&self, id: &str) -> Result<Box<dyn Session>, String> {
            self.spawns.fetch_add(1, Ordering::SeqCst);
            *self.last_id.lock().unwrap() = Some(id.to_string());
            if self.fail_spawn {
                return Err("device busy".into());
            }
            Ok(Box::new(FakeSession(CaptureStatus {
                running: true,
                connected: true,
                device_name: id.split(':').nth(1).map(str::to_string),
                last_error: None,
                dropped_frames: self.drop_frames,
            })))
        }
    }

    struct FakeSession(CaptureStatus);

    impl Session for FakeSession {
        fn status(&self) -> CaptureStatus {
            self.0.clone()
        }
    }

    fn input(id: &str) -> AudioDeviceInfo {
        AudioDeviceInfo {
            id: id.into(),
            name: id.split(':').nth(1).unwrap_or(id).into(),
            channels: 2,
            sample_rate: 48_000,
        }
    }

    fn host(ids: &[&str]) -> Arc<FakeHost> {
        Arc::new(FakeHost {
            inputs: ids.iter().map(|id| id.to_string()).collect(),
            spawns: AtomicUsize::new(0),
            last_id: std::sync::Mutex::new(None),
            fail_spawn: false,
            drop_frames: 0,
        })
    }

    #[test]
    fn a_running_capture_is_not_started_twice() {
        let host = host(&["0:USB", "1:Built-in"]);
        let mut service = CaptureService::with_host(host.clone());
        let first = service.start(Some("0:USB")).unwrap();
        assert!(first.running);
        assert!(first.connected);
        assert_eq!(first.device_name.as_deref(), Some("USB"));

        // A different selection while running is ignored until stop/start.
        let second = service.start(Some("1:Built-in")).unwrap();
        assert_eq!(host.spawns.load(Ordering::SeqCst), 1);
        assert_eq!(second.device_name.as_deref(), Some("USB"));
    }

    #[test]
    fn starting_with_nothing_selected_names_the_missing_input() {
        let host = host(&["0:USB"]);
        let mut service = CaptureService::with_host(host.clone());
        for selected in [None, Some(""), Some("   ")] {
            let error = service.start(selected).unwrap_err();
            assert!(matches!(
                error,
                ApiError::BadRequest(message) if message == "audio_input_required"
            ));
        }
        assert_eq!(host.spawns.load(Ordering::SeqCst), 0);
        let status = service.status();
        assert!(!status.running);
        assert_eq!(status.last_error.as_deref(), Some("audio_input_required"));
    }

    #[test]
    fn a_stale_id_is_refused_without_falling_back_to_another_input() {
        // The stored id names an index that the current enumeration no longer
        // uses, which is what a replugged or reordered input looks like.
        let host = host(&["0:Built-in", "1:USB"]);
        let mut service = CaptureService::with_host(host.clone());
        let error = service.start(Some("4:USB")).unwrap_err();
        assert!(matches!(
            error,
            ApiError::NotFound(message) if message == "audio_input_not_found"
        ));
        assert_eq!(host.spawns.load(Ordering::SeqCst), 0);
        assert!(!service.status().running);
        assert_eq!(
            service.status().last_error.as_deref(),
            Some("audio_input_not_found")
        );
    }

    #[test]
    fn an_id_is_passed_through_verbatim_including_surrounding_whitespace() {
        // Discovery builds the id from the device name unmodified, and a name may
        // legitimately end in a space. Trimming before lookup would report an
        // available input as missing for a selection saved exactly as offered.
        let host = host(&["0:USB ", "1:Built-in"]);
        let mut service = CaptureService::with_host(host.clone());
        service.start(Some("0:USB ")).unwrap();
        assert_eq!(
            host.last_id.lock().unwrap().as_deref(),
            Some("0:USB "),
            "the id must reach spawn unchanged"
        );
        // A trimmed value is a different id, and is not found.
        let mut other = CaptureService::with_host(host.clone());
        assert!(matches!(
            other.start(Some("0:USB")).unwrap_err(),
            ApiError::NotFound(message) if message == "audio_input_not_found"
        ));
    }

    #[test]
    fn a_duplicated_name_resolves_only_by_its_indexed_id() {
        // Identical adapters share a name and differ only by enumeration index,
        // which is the whole reason the id carries the index. This pins that the
        // index is honoured verbatim, so a name-only match is never invented.
        let host = host(&["0:USB", "1:USB"]);
        let mut service = CaptureService::with_host(host.clone());
        service.start(Some("1:USB")).unwrap();
        assert_eq!(host.last_id.lock().unwrap().as_deref(), Some("1:USB"));
        service.stop();
        service.start(Some("0:USB")).unwrap();
        assert_eq!(host.last_id.lock().unwrap().as_deref(), Some("0:USB"));
        service.stop();
        // The bare name is not an id, however tempting a prefix match would be.
        assert!(matches!(
            service.start(Some("USB")).unwrap_err(),
            ApiError::NotFound(message) if message == "audio_input_not_found"
        ));
    }

    #[test]
    fn a_host_failure_surfaces_in_status_and_can_be_retried() {
        let host = Arc::new(FakeHost {
            inputs: vec!["0:USB".to_string()],
            spawns: AtomicUsize::new(0),
            last_id: std::sync::Mutex::new(None),
            fail_spawn: true,
            drop_frames: 0,
        });
        let mut service = CaptureService::with_host(host.clone());
        let error = service.start(Some("0:USB")).unwrap_err();
        assert!(matches!(
            error,
            ApiError::Internal(message) if message.contains("audio_capture_start_failed")
        ));
        assert!(!service.status().running);
        assert!(service.status().last_error.is_some());
        // A failed start leaves nothing behind, so the next one tries again.
        assert!(service.start(Some("0:USB")).is_err());
        assert_eq!(host.spawns.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn stop_is_idempotent_and_keeps_what_the_capture_reported() {
        let host = Arc::new(FakeHost {
            inputs: vec!["0:USB".to_string()],
            spawns: AtomicUsize::new(0),
            last_id: std::sync::Mutex::new(None),
            fail_spawn: false,
            drop_frames: 12,
        });
        let mut service = CaptureService::with_host(host.clone());
        service.start(Some("0:USB")).unwrap();
        let stopped = service.stop();
        assert!(!stopped.running);
        assert!(!stopped.connected);
        assert_eq!(stopped.device_name.as_deref(), Some("USB"));
        assert_eq!(stopped.dropped_frames, 12);

        // Stopping twice is a no-op, and never re-enters the host.
        let again = service.stop();
        assert!(!again.running);
        assert_eq!(again.device_name.as_deref(), Some("USB"));
        assert_eq!(again.dropped_frames, 12);
        assert_eq!(host.spawns.load(Ordering::SeqCst), 1);
        assert!(!service.status().running);
    }

    #[test]
    fn a_stopped_capture_starts_again() {
        let host = host(&["0:USB"]);
        let mut service = CaptureService::with_host(host.clone());
        service.start(Some("0:USB")).unwrap();
        service.stop();
        let restarted = service.start(Some("0:USB")).unwrap();
        assert!(restarted.running && restarted.connected);
        assert_eq!(host.spawns.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_worker_that_died_reports_a_stopped_capture() {
        struct DeadSession;
        impl Session for DeadSession {
            fn status(&self) -> CaptureStatus {
                CaptureStatus::default() // running and connected both false
            }
        }
        let mut service = CaptureService {
            host: Arc::new(FakeHost {
                inputs: vec!["0:USB".to_string()],
                spawns: AtomicUsize::new(0),
                last_id: std::sync::Mutex::new(None),
                fail_spawn: false,
                drop_frames: 0,
            }),
            session: Some(Box::new(DeadSession)),
            last: CaptureStatus::default(),
        };
        let status = service.status();
        assert!(!status.running && !status.connected);
        // Start treats it as stopped and replaces the handle.
        assert!(service.start(Some("0:USB")).unwrap().running);
    }

    #[test]
    fn the_status_payload_is_the_documented_shape() {
        let Json(value) = response(CaptureStatus {
            running: true,
            connected: false,
            device_name: Some("USB".into()),
            last_error: Some("device lost".into()),
            dropped_frames: 3,
        });
        assert_eq!(
            value,
            json!({
                "running": true,
                "connected": false,
                "device_name": "USB",
                "last_error": "device lost",
                "dropped_frames": 3,
            })
        );
        let Json(empty) = response(CaptureStatus::default());
        assert_eq!(
            empty,
            json!({
                "running": false,
                "connected": false,
                "device_name": null,
                "last_error": null,
                "dropped_frames": 0,
            })
        );
    }

    async fn call(
        app: axum::Router,
        method: axum::http::Method,
        uri: &str,
        body: Option<Value>,
    ) -> (axum::http::StatusCode, Value) {
        use axum::body::Body;
        use tower::util::ServiceExt;
        let request = axum::http::Request::builder()
            .method(method)
            .uri(uri)
            .header("content-type", "application/json")
            .body(body.map_or_else(Body::empty, |value| Body::from(value.to_string())))
            .unwrap();
        let response = app.oneshot(request).await.unwrap();
        let status = response.status();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    // No hardware is touched by any route here: the shipped default selects no
    // input, so start refuses before enumeration.
    #[tokio::test]
    async fn the_routes_report_and_refuse_with_the_api_error_envelope() {
        let state = crate::api::default_state();
        let app = crate::api::router(state.clone());

        let (status, body) = call(
            app.clone(),
            axum::http::Method::GET,
            "/api/v1/audio/capture/status",
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(
            body,
            json!({
                "running": false,
                "connected": false,
                "device_name": null,
                "last_error": null,
                "dropped_frames": 0,
            })
        );

        let (status, body) = call(
            app.clone(),
            axum::http::Method::POST,
            "/api/v1/audio/capture/start",
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(body["error"], "audio_input_required");
        assert_eq!(body["code"], 400);
        assert_eq!(body["error"], body["message"]);

        let (status, body) = call(
            app,
            axum::http::Method::POST,
            "/api/v1/audio/capture/stop",
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["running"], false);
    }

    #[tokio::test]
    async fn the_selected_input_round_trips_through_preferences() {
        let state = crate::api::default_state();
        // Unset by default: naming no input is the shipped state, not a guess.
        assert_eq!(
            state.preferences.lock().unwrap().get(PREFERENCE_KEY),
            Some(&json!(""))
        );

        let uri = format!("/api/v1/preferences/{PREFERENCE_KEY}");
        let (status, body) = call(
            crate::api::router(state.clone()),
            axum::http::Method::PUT,
            &uri,
            Some(json!({"value": "1:USB Line In"})),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["value"], "1:USB Line In");

        let (status, body) = call(
            crate::api::router(state),
            axum::http::Method::GET,
            &uri,
            None,
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::OK);
        assert_eq!(body["value"], "1:USB Line In");
    }
}
