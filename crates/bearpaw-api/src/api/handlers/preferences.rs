use axum::extract::{Path, State};
use axum::response::Json;
use serde_json::{json, Value};

use super::super::{
    default_preferences, reset_preferences_db, save_preference_to_db, save_preferences_to_db,
    ApiError, AppState, PreferencePersistenceError,
};

fn persistence_failed(error: PreferencePersistenceError) -> ApiError {
    tracing::error!(error = %error, "failed to persist preferences");
    ApiError::Internal("preference_persistence_failed".to_string())
}

pub(crate) async fn get_preferences(State(state): State<AppState>) -> Json<Value> {
    Json(Value::Object(state.preferences.lock().unwrap().clone()))
}

pub(crate) async fn get_preference(
    State(state): State<AppState>,
    Path(key): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let prefs = state.preferences.lock().unwrap();
    let value = prefs
        .get(&key)
        .cloned()
        .ok_or_else(|| ApiError::NotFound(format!("Unknown preference: {}", key)))?;
    Ok(Json(json!({ "key": key, "value": value })))
}

pub(crate) async fn put_preference(
    State(state): State<AppState>,
    Path(key): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let value = body
        .get("value")
        .cloned()
        .ok_or_else(|| ApiError::BadRequest("value_required".to_string()))?;
    save_preference_to_db(&state.preferences_db_path, &key, &value).map_err(persistence_failed)?;
    state
        .preferences
        .lock()
        .unwrap()
        .insert(key.clone(), value.clone());
    Ok(Json(json!({ "key": key, "value": value })))
}

pub(crate) async fn put_preferences(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let Value::Object(map) = body else {
        return Err(ApiError::BadRequest(
            "invalid_preferences_payload".to_string(),
        ));
    };
    save_preferences_to_db(&state.preferences_db_path, &map).map_err(persistence_failed)?;
    let mut prefs = state.preferences.lock().unwrap();
    prefs.extend(map);
    Ok(Json(Value::Object(prefs.clone())))
}

pub(crate) async fn reset_preferences(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    reset_preferences_db(&state.preferences_db_path).map_err(persistence_failed)?;
    *state.preferences.lock().unwrap() = default_preferences();
    Ok(Json(Value::Object(
        state.preferences.lock().unwrap().clone(),
    )))
}
