//! Read-only scanner diagnostic (#895).
//!
//! Sends a fixed list of read commands to whatever scanner is connected,
//! including one Bearpaw does not list, and reports the replies so an owner can
//! paste them into an issue.

use std::sync::atomic::Ordering;

use axum::{extract::State, Json};
use serde::Serialize;
use serde_json::{json, Value};

use super::{send_queued, ApiError, AppState};

/// The ONLY commands the diagnostic sends.
///
/// REGRESSION GUARD (#895, `the_diagnostic_never_sends_program_mode_or_writes`,
/// `an_unlisted_scanner_gets_exactly_the_diagnostic_commands`): every entry is
/// a bare read, valid outside program mode, with no argument. No `PRG` (an
/// SDS150 accepts it with no `EPG` and needs a power cycle), no write, no
/// `CIN`. The list is fixed in code and nothing user-supplied reaches the wire.
/// Adding a command here is a decision about what an unverified scanner may be
/// sent, so both tests must be re-read, not just updated.
pub(crate) const DIAGNOSTIC_COMMANDS: &[&str] = &["MDL", "VER", "STS", "GLG", "PWR", "VOL", "SQL"];

#[derive(Debug, Serialize)]
pub(crate) struct DiagnosticLine {
    command: String,
    reply: Option<String>,
    error: Option<String>,
}

/// Carries no USB serial number and no port path: both identify the owner's
/// machine or unit, and the report is meant to be pasted publicly.
#[derive(Debug, Serialize)]
pub(crate) struct DiagnosticReport {
    model: Option<String>,
    firmware: Option<String>,
    link: String,
    bearpaw_version: &'static str,
    lines: Vec<DiagnosticLine>,
}

impl DiagnosticReport {
    pub(crate) fn to_text(&self) -> String {
        let mut out = format!(
            "Bearpaw {}\nModel: {}\nFirmware: {}\nLink: {}\n\n",
            self.bearpaw_version,
            self.model.as_deref().unwrap_or("unknown"),
            self.firmware.as_deref().unwrap_or("unknown"),
            self.link,
        );
        for line in &self.lines {
            match (&line.reply, &line.error) {
                (Some(reply), _) => out.push_str(&format!("{} -> {}\n", line.command, reply)),
                (None, Some(error)) => {
                    out.push_str(&format!("{} -> (error: {})\n", line.command, error))
                }
                (None, None) => out.push_str(&format!("{} -> (no reply)\n", line.command)),
            }
        }
        out
    }
}

fn error_text(err: &ApiError) -> String {
    match err {
        ApiError::NoScanner => "device_disconnected".to_string(),
        ApiError::SendFailed => "command_channel_closed".to_string(),
        ApiError::BadRequest(m)
        | ApiError::NotFound(m)
        | ApiError::Conflict(m)
        | ApiError::Internal(m) => m.clone(),
    }
}

/// One share of `AppState::diagnostics_running` (#907). A count, so the
/// first of two overlapping runs to finish cannot resume the search early.
struct SearchPause(std::sync::Arc<std::sync::atomic::AtomicUsize>);

impl SearchPause {
    fn new(state: &AppState) -> Self {
        state.diagnostics_running.fetch_add(1, Ordering::SeqCst);
        Self(state.diagnostics_running.clone())
    }
}

impl Drop for SearchPause {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

/// `VER,Version 1.06.06` -> `Version 1.06.06`. `None` for an empty or
/// error reply, so the header falls back to "unknown" rather than "ERR".
fn firmware_from_ver(reply: &str) -> Option<String> {
    let value = reply.strip_prefix("VER,")?.trim();
    (!value.is_empty()).then(|| value.to_string())
}

pub(crate) async fn run_diagnostic(state: &AppState) -> Result<DiagnosticReport, ApiError> {
    // Same refusals as `ProgramModeGuard::enter`, for the same reason: a sync
    // owns the wire for its duration, and a bracket's replies are not ours.
    if state.sync_task_id.lock().unwrap().is_some() {
        return Err(ApiError::Conflict("sync_in_progress".to_string()));
    }
    if *state.program_mode_holders.lock().unwrap() > 0
        || state.program_mode_active.load(Ordering::Relaxed)
    {
        return Err(ApiError::Conflict("program_mode_active".to_string()));
    }
    // Fails with 503 before anything is sent when no scanner is connected.
    super::command_sender(state)?;

    // Holds off the poll loop's supported-scanner search for the run (#907),
    // released on every exit by Drop.
    let _search_paused = SearchPause::new(state);

    let mut lines = Vec::with_capacity(DIAGNOSTIC_COMMANDS.len());
    for command in DIAGNOSTIC_COMMANDS {
        let line = match send_queued(state, command, false).await {
            Ok(reply) => DiagnosticLine {
                command: command.to_string(),
                reply: Some(reply.trim().to_string()),
                error: None,
            },
            Err(err) => DiagnosticLine {
                command: command.to_string(),
                reply: None,
                error: Some(error_text(&err)),
            },
        };
        lines.push(line);
    }

    // The header's firmware comes from the VER reply this run just read (#908):
    // `DeviceInfo.firmware` is never populated, so it alone printed "unknown"
    // directly above a line holding the version.
    let firmware = lines
        .iter()
        .find(|l| l.command == "VER")
        .and_then(|l| l.reply.as_deref())
        .and_then(firmware_from_ver);

    let device = state.device.read().unwrap();
    let link = match (device.vid, device.pid) {
        (Some(vid), Some(pid)) => format!("usb {vid:04x}:{pid:04x}"),
        _ => "serial".to_string(),
    };
    Ok(DiagnosticReport {
        model: device.model.clone(),
        firmware: firmware.or_else(|| device.firmware.clone()),
        link,
        bearpaw_version: env!("CARGO_PKG_VERSION"),
        lines,
    })
}

pub(crate) async fn post_diagnostic(
    State(state): State<AppState>,
) -> Result<Json<Value>, ApiError> {
    let report = run_diagnostic(&state).await?;
    let text = report.to_text();
    Ok(Json(json!({ "report": report, "text": text })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tests::FakeScanner;
    use crate::api::{default_state, router};
    use axum::body::{to_bytes, Body};
    use axum::http::{Method, Request, StatusCode};
    use tower::util::ServiceExt;

    async fn post_diagnostic(state: &AppState) -> (StatusCode, String) {
        let response = router(state.clone())
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/api/v1/diagnostic")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        let status = response.status();
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        (status, String::from_utf8(body.to_vec()).unwrap())
    }

    fn unlisted_state() -> AppState {
        let state = default_state();
        state.device.write().unwrap().model = Some("SDS150".to_string());
        state
    }

    #[tokio::test]
    async fn an_unlisted_scanner_gets_exactly_the_diagnostic_commands() {
        let state = unlisted_state();
        let fake = FakeScanner::attach(&state, |c| Ok(format!("{c},OK")));
        let (status, _) = post_diagnostic(&state).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(fake.transcript(), DIAGNOSTIC_COMMANDS);
        assert!(!fake.transcript().iter().any(|c| c == "PRG"));
    }

    /// #907: the run marks itself so the poll loop's supported-scanner search
    /// stands down, and unmarks itself when done.
    #[tokio::test]
    async fn a_diagnostic_holds_off_the_scanner_search_only_while_it_runs() {
        let state = unlisted_state();
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let (s, counter) = (seen.clone(), state.diagnostics_running.clone());
        let _fake = FakeScanner::attach(&state, move |c| {
            s.lock().unwrap().push(counter.load(Ordering::Relaxed));
            Ok(format!("{c},OK"))
        });
        let (status, _) = post_diagnostic(&state).await;
        assert_eq!(status, StatusCode::OK);
        let seen = seen.lock().unwrap();
        assert_eq!(seen.len(), DIAGNOSTIC_COMMANDS.len());
        assert!(
            seen.iter().all(|&n| n == 1),
            "every command must go out while the search is held off"
        );
        assert_eq!(state.diagnostics_running.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn a_refused_diagnostic_does_not_hold_off_the_search() {
        let state = unlisted_state();
        *state.program_mode_holders.lock().unwrap() = 1;
        let (status, _) = post_diagnostic(&state).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(state.diagnostics_running.load(Ordering::Relaxed), 0);
    }

    /// #908: `DeviceInfo.firmware` is never populated, so the header said
    /// "unknown" directly above a `VER` line holding the answer.
    #[tokio::test]
    async fn the_report_header_takes_firmware_from_the_ver_reply() {
        let state = unlisted_state();
        let _fake = FakeScanner::attach(&state, |c| match c {
            "VER" => Ok("VER,Version 1.06.06".to_string()),
            other => Ok(format!("{other},OK")),
        });
        let (status, body) = post_diagnostic(&state).await;
        assert_eq!(status, StatusCode::OK);
        let json: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(json["report"]["firmware"], "Version 1.06.06");
        assert!(json["text"]
            .as_str()
            .unwrap()
            .contains("Firmware: Version 1.06.06\n"));
    }

    #[tokio::test]
    async fn a_failed_ver_leaves_the_firmware_unknown() {
        let state = unlisted_state();
        let _fake = FakeScanner::attach(&state, |c| match c {
            "VER" => Err("command_timeout".to_string()),
            other => Ok(format!("{other},OK")),
        });
        let (_, body) = post_diagnostic(&state).await;
        let json: Value = serde_json::from_str(&body).unwrap();
        assert!(json["report"]["firmware"].is_null());
        assert!(json["text"]
            .as_str()
            .unwrap()
            .contains("Firmware: unknown\n"));
    }

    #[test]
    fn the_diagnostic_never_sends_program_mode_or_writes() {
        for cmd in DIAGNOSTIC_COMMANDS {
            assert!(!cmd.contains(','), "{cmd} carries an argument");
            assert!(
                !["PRG", "EPG", "CLR", "DCH", "WIN", "CIN"].contains(cmd),
                "{cmd} is not a read"
            );
        }
    }

    #[tokio::test]
    async fn the_report_carries_no_serial_or_port() {
        let state = unlisted_state();
        {
            let mut d = state.device.write().unwrap();
            d.serial_number = Some("SECRET123".to_string());
            d.port = Some("/dev/cu.usbserial-SECRET".to_string());
        }
        let _fake = FakeScanner::attach(&state, |c| Ok(format!("{c},OK")));
        let (status, body) = post_diagnostic(&state).await;
        assert_eq!(status, StatusCode::OK);
        assert!(!body.contains("SECRET"), "{body}");
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(!json["text"].as_str().unwrap().contains("SECRET"));
    }

    #[tokio::test]
    async fn a_command_that_times_out_is_recorded_and_the_probe_continues() {
        let state = unlisted_state();
        let fake = FakeScanner::attach(&state, |c| {
            if c == "GLG" {
                Err("command_timeout".to_string())
            } else {
                Ok(format!("{c},OK"))
            }
        });
        let (status, body) = post_diagnostic(&state).await;
        assert_eq!(status, StatusCode::OK);
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let lines = json["report"]["lines"].as_array().unwrap();
        let cmds: Vec<&str> = lines
            .iter()
            .map(|l| l["command"].as_str().unwrap())
            .collect();
        assert_eq!(cmds, DIAGNOSTIC_COMMANDS);
        let glg = lines.iter().find(|l| l["command"] == "GLG").unwrap();
        assert_eq!(glg["error"], "command_timeout");
        assert!(glg["reply"].is_null());
        assert!(json["text"]
            .as_str()
            .unwrap()
            .contains("GLG -> (error: command_timeout)"));
        assert_eq!(fake.transcript(), DIAGNOSTIC_COMMANDS);
    }

    #[tokio::test]
    async fn the_diagnostic_waits_for_a_program_mode_bracket() {
        let state = unlisted_state();
        let fake = FakeScanner::attach(&state, |c| Ok(format!("{c},OK")));
        *state.program_mode_holders.lock().unwrap() = 1;
        let (status, _) = post_diagnostic(&state).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(fake.transcript().is_empty());
    }

    #[tokio::test]
    async fn the_diagnostic_waits_for_a_memory_sync() {
        let state = unlisted_state();
        let fake = FakeScanner::attach(&state, |c| Ok(format!("{c},OK")));
        *state.sync_task_id.lock().unwrap() = Some("task".to_string());
        let (status, body) = post_diagnostic(&state).await;
        assert_eq!(status, StatusCode::CONFLICT);
        assert!(body.contains("sync_in_progress"), "{body}");
        assert!(fake.transcript().is_empty());
    }

    #[tokio::test]
    async fn no_scanner_is_a_503() {
        let state = unlisted_state();
        let (status, _) = post_diagnostic(&state).await;
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
    }
}
