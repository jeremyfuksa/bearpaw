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

#[derive(Serialize)]
pub(crate) struct ForgetResponse {
    channels: usize,
    bank_names: usize,
    hits: usize,
    /// Activity history was left alone because another profile has the same
    /// model, and history is keyed by model.
    history_kept: bool,
}

/// Forget a profile: its cached channels, bank names and profile row, and its
/// activity history where that history is its alone.
///
/// REFUSED for the LOADED profile -- connected or merely unplugged. Its
/// channels are still in the shadow, and the periodic `flush_channel_cache`
/// would write them straight back under a profile that no longer exists.
/// `DeviceInfo.scanner_id` survives an unplug on purpose
/// (`identity_survives_a_disconnect_so_the_flush_finds_its_profile`), so
/// "connected" is the wrong test.
///
/// The device lock is held for the whole operation so a scanner cannot be
/// plugged in and resolve to this profile halfway through.
///
/// Two databases, so not one transaction. The profile goes first because it is
/// what Forget is about; if the history delete then fails, what remains is
/// orphaned history that ages out under retention -- never a half-deleted
/// profile.
pub(crate) async fn delete_scanner(
    State(state): State<AppState>,
    Path(scanner_id): Path<String>,
) -> Result<Json<ForgetResponse>, ApiError> {
    let device = state
        .device
        .read()
        .map_err(|_| ApiError::Internal("device_lock_poisoned".to_string()))?;
    if device.scanner_id.as_deref() == Some(scanner_id.as_str()) {
        return Err(ApiError::Conflict("scanner_loaded".to_string()));
    }

    let forgotten = scanner_registry::forget_profile(&state.preferences_db_path, &scanner_id)
        .map_err(|_| ApiError::Internal("forget_failed".to_string()))?
        .ok_or_else(|| ApiError::NotFound("scanner_not_found".to_string()))?;

    let mut hits = 0;
    if !forgotten.history_shared {
        hits = super::super::delete_analytics_hits_for_model(
            &state.analytics_db_path,
            &forgotten.model,
        );
        // The in-memory log is a second copy of `scan_hits`, loaded at start.
        // Without this the dashboard keeps showing the history until restart.
        if let Ok(mut log) = state.analytics_log.lock() {
            log.retain(|hit| {
                !hit.scanner_id
                    .as_deref()
                    .is_some_and(|m| m.eq_ignore_ascii_case(&forgotten.model))
            });
        }
    }
    drop(device);

    Ok(Json(ForgetResponse {
        channels: forgotten.channels,
        bank_names: forgotten.bank_names,
        hits,
        history_kept: forgotten.history_shared,
    }))
}

#[cfg(test)]
mod tests {
    use super::super::super::{
        default_state, epoch_now, insert_analytics_hit, open_sqlite, router, ActivityHit,
    };
    use super::*;
    use crate::state::ScannerMode;
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

    // ---- Forget (#417) ----

    fn seed_profile_data(state: &AppState, scanner_id: &str) {
        let conn = open_sqlite(&state.preferences_db_path).unwrap();
        for index in 1..=3 {
            conn.execute(
                "INSERT INTO channel_memory
                     (scanner_id, channel_index, frequency, delay, lockout, priority, synced_at)
                 VALUES (?1, ?2, 146.52, 2, 0, 0, 1.0)",
                rusqlite::params![scanner_id, index],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO bank_names (scanner_id, bank, name) VALUES (?1, 1, 'Ham')",
            rusqlite::params![scanner_id],
        )
        .unwrap();
    }

    fn seed_hit(state: &AppState, id: &str, model: Option<&str>) {
        let hit = ActivityHit {
            id: id.to_string(),
            timestamp: epoch_now(),
            frequency: 146.52,
            channel: Some(1),
            alpha_tag: None,
            rssi: 30,
            duration: 5.0,
            modulation: "NFM".to_string(),
            mode: ScannerMode::Scan,
            bank: Some(1),
            session_id: "s".to_string(),
            ended_at: epoch_now(),
            scanner_id: model.map(str::to_string),
        };
        insert_analytics_hit(&state.analytics_db_path, &hit);
        state.analytics_log.lock().unwrap().push(hit);
    }

    fn rows(state: &AppState, table: &str, scanner_id: &str) -> i64 {
        open_sqlite(&state.preferences_db_path)
            .unwrap()
            .query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE scanner_id = ?1"),
                rusqlite::params![scanner_id],
                |r| r.get(0),
            )
            .unwrap()
    }

    fn sorted(mut models: Vec<Option<String>>) -> Vec<Option<String>> {
        models.sort();
        models
    }

    fn db_hits(state: &AppState) -> Vec<Option<String>> {
        let conn = open_sqlite(&state.analytics_db_path).unwrap();
        let mut stmt = conn.prepare("SELECT scanner_id FROM scan_hits").unwrap();
        let models = stmt.query_map([], |r| r.get(0)).unwrap();
        sorted(models.map(Result::unwrap).collect())
    }

    fn memory_hits(state: &AppState) -> Vec<Option<String>> {
        let log = state.analytics_log.lock().unwrap();
        sorted(log.iter().map(|h| h.scanner_id.clone()).collect())
    }

    /// REGRESSION GUARD (#417): the LOADED profile cannot be forgotten --
    /// connected, or unplugged with its channels still in the shadow. The
    /// periodic flush would write them straight back. Asserts the rows
    /// survive, not just the status: a handler that deleted and THEN returned
    /// 409 passes a status-only check.
    #[tokio::test]
    async fn forgetting_the_loaded_scanner_is_refused_and_deletes_nothing() {
        for status in ["connected", "disconnected"] {
            let state = default_state();
            let a = profile(&state.preferences_db_path, "BC125AT", "0001");
            seed_profile_data(&state, &a);
            seed_hit(&state, "1", Some("BC125AT"));
            load(&state, &a, status);

            let uri = format!("/api/v1/scanners/{a}");
            let (code, body) = request(&state, Method::DELETE, &uri, None).await;
            assert_eq!(code, StatusCode::CONFLICT, "{status}");
            assert_eq!(body["error"], "scanner_loaded");
            assert_eq!(rows(&state, "scanners", &a), 1, "{status}: profile kept");
            assert_eq!(
                rows(&state, "channel_memory", &a),
                3,
                "{status}: channels kept"
            );
            assert_eq!(rows(&state, "bank_names", &a), 1, "{status}: names kept");
            assert_eq!(db_hits(&state).len(), 1, "{status}: history kept");
            assert_eq!(memory_hits(&state).len(), 1, "{status}: log kept");
        }
    }

    /// #417: Forget removes exactly one profile's rows. A second profile with
    /// its own data survives, so a delete that ignored `scanner_id` fails.
    #[tokio::test]
    async fn forget_removes_only_that_profiles_rows() {
        let state = default_state();
        let a = profile(&state.preferences_db_path, "BC125AT", "0001");
        let b = profile(&state.preferences_db_path, "BC75XLT", "020D43D8");
        seed_profile_data(&state, &a);
        seed_profile_data(&state, &b);
        load(&state, &a, "connected");

        let uri = format!("/api/v1/scanners/{b}");
        let (code, body) = request(&state, Method::DELETE, &uri, None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(body["channels"], 3);
        assert_eq!(body["bank_names"], 1);
        for table in ["scanners", "channel_memory", "bank_names"] {
            assert_eq!(rows(&state, table, &b), 0, "{table}: forgotten");
        }
        assert_eq!(rows(&state, "scanners", &a), 1);
        assert_eq!(rows(&state, "channel_memory", &a), 3);
        assert_eq!(rows(&state, "bank_names", &a), 1);

        let (code, _) = request(&state, Method::DELETE, &uri, None).await;
        assert_eq!(code, StatusCode::NOT_FOUND, "a second forget finds nothing");
    }

    /// #417: with no other profile of that model, Forget deletes the model's
    /// history -- from SQLite AND the in-memory log, a second copy the
    /// dashboard reads. Unattributed (pre-#440) and other-model hits survive.
    #[tokio::test]
    async fn forget_deletes_history_when_the_model_is_unique() {
        let state = default_state();
        let a = profile(&state.preferences_db_path, "BC125AT", "0001");
        let b = profile(&state.preferences_db_path, "BC75XLT", "020D43D8");
        load(&state, &a, "connected");
        seed_hit(&state, "1", Some("BC125AT"));
        seed_hit(&state, "2", Some("BC75XLT"));
        seed_hit(&state, "3", None);

        let uri = format!("/api/v1/scanners/{b}");
        let (code, body) = request(&state, Method::DELETE, &uri, None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(body["hits"], 1);
        assert_eq!(body["history_kept"], false);
        let expected = sorted(vec![Some("BC125AT".to_string()), None]);
        assert_eq!(db_hits(&state), expected);
        assert_eq!(memory_hits(&state), expected);
    }

    /// #417: where another profile has the same model the history cannot be
    /// told apart, so Forget keeps all of it and says so.
    #[tokio::test]
    async fn forget_keeps_history_when_the_model_is_shared() {
        let state = default_state();
        let a = profile(&state.preferences_db_path, "BC125AT", "0001");
        let x = profile(&state.preferences_db_path, "BC75XLT", "AAAA");
        profile(&state.preferences_db_path, "BC75XLT", "BBBB");
        load(&state, &a, "connected");
        seed_hit(&state, "1", Some("BC75XLT"));
        seed_hit(&state, "2", None);

        let uri = format!("/api/v1/scanners/{x}");
        let (code, body) = request(&state, Method::DELETE, &uri, None).await;
        assert_eq!(code, StatusCode::OK);
        assert_eq!(body["hits"], 0);
        assert_eq!(body["history_kept"], true);
        assert_eq!(db_hits(&state).len(), 2);
        assert_eq!(memory_hits(&state).len(), 2);
        assert_eq!(
            rows(&state, "scanners", &x),
            0,
            "the profile is still forgotten"
        );
    }
}
