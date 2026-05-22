use axum::extract::State;
use axum::response::Json;
use serde_json::{json, Value};

use super::super::{
    parse_glf_response, send_raw_command, ApiError, AppState, ProgramModeGuard,
};

pub(crate) async fn debug_glg(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let response = send_raw_command(&state, "GLG", true).await?;
    Ok(Json(json!({ "response": response })))
}

pub(crate) async fn debug_scg(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _prg = ProgramModeGuard::enter(&state).await?;
    let response = send_raw_command(&state, "SCG", false).await;
    Ok(Json(json!({ "response": response? })))
}

pub(crate) async fn debug_glf(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let _prg = ProgramModeGuard::enter(&state).await?;
    let result = async {
        let mut responses = Vec::new();
        let first = send_raw_command(&state, "GLF,***", false).await?;
        responses.push(format!("GLF,*** => {}", first.trim()));
        let mut next = parse_glf_response(&first);
        if next.is_none() {
            let plain = send_raw_command(&state, "GLF", false).await?;
            responses.push(format!("GLF => {}", plain.trim()));
            next = parse_glf_response(&plain);
        }
        for _ in 0..20 {
            let Some(value) = next else { break };
            let response = send_raw_command(&state, &format!("GLF,{}", value), false).await?;
            responses.push(format!("GLF,{} => {}", value, response.trim()));
            next = parse_glf_response(&response);
        }
        Ok::<Vec<String>, ApiError>(responses)
    }
    .await;
    Ok(Json(json!({ "responses": result? })))
}
