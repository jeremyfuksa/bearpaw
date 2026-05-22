use axum::extract::{Path, State};
use axum::response::Json;
use serde_json::{json, Value};

use super::super::{
    default_preferences, reset_preferences_db, save_preference_to_db, ApiError, AppState,
};

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
    state
        .preferences
        .lock()
        .unwrap()
        .insert(key.clone(), value.clone());
    save_preference_to_db(&state.preferences_db_path, &key, &value);
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
    let mut prefs = state.preferences.lock().unwrap();
    for (k, v) in map {
        save_preference_to_db(&state.preferences_db_path, &k, &v);
        prefs.insert(k, v);
    }
    Ok(Json(Value::Object(prefs.clone())))
}

pub(crate) async fn reset_preferences(State(state): State<AppState>) -> Json<Value> {
    reset_preferences_db(&state.preferences_db_path);
    *state.preferences.lock().unwrap() = default_preferences();
    Json(Value::Object(state.preferences.lock().unwrap().clone()))
}
