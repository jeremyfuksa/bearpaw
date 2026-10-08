//! Known scanner profiles (#417): list them and name them.
//!
//! The list is what Bearpaw has STORED, not what is plugged in. One scanner is
//! connected at a time; the rest are profiles waiting for their radio.

use axum::extract::{Path, State};
use axum::response::Json;
use serde::{Deserialize, Serialize};

use super::super::{poll::broadcast_device_info, scanner_registry, ApiError, AppState};

/// Longest display name accepted, in characters.
const DISPLAY_NAME_MAX_CHARS: usize = 64;

#[derive(Serialize)]
pub(crate) struct ScannerProfile {
    scanner_id: String,
    model: String,
    display_name: Option<String>,
    last_seen: f64,
    synced_at: Option<f64>,
    channels: i64,
    bank_names: i64,
    history_shared: bool,
    /// This profile's memory is the one in the shadow. True for the connected
    /// scanner, and still true after it is unplugged: `DeviceInfo.scanner_id`
    /// deliberately survives a disconnect so the cache flush finds its profile
    /// (`identity_survives_a_disconnect_so_the_flush_finds_its_profile`).
    loaded: bool,
    /// Loaded AND currently connected.
    connected: bool,
}

pub(crate) async fn get_scanners(State(state): State<AppState>) -> Json<Vec<ScannerProfile>> {
    let (loaded_id, is_connected) = state
        .device
        .read()
        .map(|d| (d.scanner_id.clone(), d.connection_status == "connected"))
        .unwrap_or((None, false));
    let profiles = scanner_registry::list_profiles(&state.preferences_db_path)
        .into_iter()
        .map(|p| {
            let loaded = loaded_id.as_deref() == Some(p.scanner_id.as_str());
            ScannerProfile {
                scanner_id: p.scanner_id,
                model: p.model,
                display_name: p.display_name,
                last_seen: p.last_seen,
                synced_at: p.synced_at,
                channels: p.channels,
                bank_names: p.bank_names,
                history_shared: p.history_shared,
                loaded,
                connected: loaded && is_connected,
            }
        })
        .collect();
    Json(profiles)
}

#[derive(Serialize, Deserialize)]
pub(crate) struct RenameBody {
    display_name: Option<String>,
}

/// Name a profile. The name is trimmed; blank or `null` clears it, and the UI
/// falls back to the model.
pub(crate) async fn patch_scanner(
    State(state): State<AppState>,
    Path(scanner_id): Path<String>,
    Json(body): Json<RenameBody>,
) -> Result<Json<RenameBody>, ApiError> {
    let name = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string);
    if name.as_deref().is_some_and(|n| {
        n.chars().count() > DISPLAY_NAME_MAX_CHARS || n.chars().any(char::is_control)
    }) {
        return Err(ApiError::BadRequest("display_name_invalid".to_string()));
    }

    let found = scanner_registry::set_display_name(
        &state.preferences_db_path,
        &scanner_id,
        name.as_deref(),
    )
    .map_err(|_| ApiError::Internal("display_name_persistence_failed".to_string()))?;
    if !found {
        return Err(ApiError::NotFound("scanner_not_found".to_string()));
    }

    // The loaded profile's name also lives on DeviceInfo, so the Device tab and
    // the reconnect announcement see it without refetching.
    let is_loaded = match state.device.write() {
        Ok(mut d) if d.scanner_id.as_deref() == Some(scanner_id.as_str()) => {
            d.display_name = name.clone();
            true
        }
        _ => false,
    };
    if is_loaded {
        broadcast_device_info(&state);
    }
    Ok(Json(RenameBody { display_name: name }))
}

#[cfg(test)]
mod tests {
    use super::super::super::{default_state, router};
    use super::*;
    use axum::body::{to_bytes, Body};
    use axum::http::{Method, Request, StatusCode};
    use serde_json::{json, Value};
    use tower::ServiceExt;

    async fn request(
        state: &AppState,
        method: Method,
        uri: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        if body.is_some() {
            req = req.header("content-type", "application/json");
        }
        let response = router(state.clone())
            .oneshot(
                req.body(
                    body.map(|b| Body::from(b.to_string()))
                        .unwrap_or_else(Body::empty),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (
            status,
            serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        )
    }

    fn profile(path: &str, model: &str, serial: &str) -> String {
        scanner_registry::resolve_scanner(path, model, Some(serial)).unwrap()
    }

    fn load(state: &AppState, scanner_id: &str, status: &str) {
        let mut d = state.device.write().unwrap();
        d.scanner_id = Some(scanner_id.to_string());
        d.connection_status = status.to_string();
    }

    /// #417: `loaded` and `connected` are different facts. An unplugged
    /// scanner is still loaded -- its channels are in the shadow and the flush
    /// still writes them -- and Forget must treat it as such. A build that
    /// derived both from one flag would pass a connected-only test.
    #[tokio::test]
    async fn the_list_marks_the_loaded_profile_connected_or_not() {
        let state = default_state();
        let a = profile(&state.preferences_db_path, "BC125AT", "0001");
        let b = profile(&state.preferences_db_path, "BC75XLT", "020D43D8");

        load(&state, &a, "connected");
        let (status, list) = request(&state, Method::GET, "/api/v1/scanners", None).await;
        assert_eq!(status, StatusCode::OK);
        let row = |list: &Value, id: &str| {
            list.as_array()
                .unwrap()
                .iter()
                .find(|r| r["scanner_id"] == id)
                .unwrap()
                .clone()
        };
        assert_eq!(row(&list, &a)["loaded"], true);
        assert_eq!(row(&list, &a)["connected"], true);
        assert_eq!(row(&list, &b)["loaded"], false);
        assert_eq!(row(&list, &b)["connected"], false);

        load(&state, &a, "disconnected");
        let (_, list) = request(&state, Method::GET, "/api/v1/scanners", None).await;
        assert_eq!(row(&list, &a)["loaded"], true, "unplugged is still loaded");
        assert_eq!(row(&list, &a)["connected"], false);
    }

    /// #417: renaming the LOADED profile updates DeviceInfo too, so the name
    /// reaches the Device tab and the reconnect announcement. Renaming another
    /// profile must not touch DeviceInfo at all.
    #[tokio::test]
    async fn renaming_the_loaded_profile_updates_device_info() {
        let state = default_state();
        let a = profile(&state.preferences_db_path, "BC125AT", "0001");
        let b = profile(&state.preferences_db_path, "BC75XLT", "020D43D8");
        load(&state, &a, "connected");

        let (status, body) = request(
            &state,
            Method::PATCH,
            &format!("/api/v1/scanners/{a}"),
            Some(json!({ "display_name": "  Base  " })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["display_name"], "Base", "names are trimmed");
        assert_eq!(
            state.device.read().unwrap().display_name.as_deref(),
            Some("Base")
        );

        request(
            &state,
            Method::PATCH,
            &format!("/api/v1/scanners/{b}"),
            Some(json!({ "display_name": "Truck" })),
        )
        .await;
        assert_eq!(
            state.device.read().unwrap().display_name.as_deref(),
            Some("Base"),
            "another profile's name must not land on the loaded one"
        );
        assert_eq!(
            scanner_registry::display_name(&state.preferences_db_path, &b).as_deref(),
            Some("Truck")
        );
    }

    #[tokio::test]
    async fn a_blank_name_clears_it() {
        let state = default_state();
        let a = profile(&state.preferences_db_path, "BC125AT", "0001");
        let uri = format!("/api/v1/scanners/{a}");
        request(
            &state,
            Method::PATCH,
            &uri,
            Some(json!({ "display_name": "Base" })),
        )
        .await;

        let (status, body) = request(
            &state,
            Method::PATCH,
            &uri,
            Some(json!({ "display_name": "   " })),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["display_name"], Value::Null);
        assert_eq!(
            scanner_registry::display_name(&state.preferences_db_path, &a),
            None
        );
    }

    #[tokio::test]
    async fn a_rename_is_refused_for_a_bad_name_or_an_unknown_profile() {
        let state = default_state();
        let a = profile(&state.preferences_db_path, "BC125AT", "0001");
        let uri = format!("/api/v1/scanners/{a}");

        let too_long = "x".repeat(DISPLAY_NAME_MAX_CHARS + 1);
        let (status, _) = request(
            &state,
            Method::PATCH,
            &uri,
            Some(json!({ "display_name": too_long })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        let (status, _) = request(
            &state,
            Method::PATCH,
            &uri,
            Some(json!({ "display_name": "a\nb" })),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(
            scanner_registry::display_name(&state.preferences_db_path, &a),
            None,
            "a refused name is not stored"
        );

        let (status, _) = request(
            &state,
            Method::PATCH,
            "/api/v1/scanners/no-such-id",
            Some(json!({ "display_name": "x" })),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND);
    }
}
