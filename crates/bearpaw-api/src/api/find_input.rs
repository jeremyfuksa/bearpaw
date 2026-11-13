//! Find the scanner's audio input (#930): open the squelch so the scanner plays
//! steady hiss, and see which host input gets loud.
//!
//! Each input is compared with itself, quiet then hissing, so a microphone that
//! hears the room cannot win by being loud. The user hears nothing: a cable in
//! the headphone jack silences the scanner's speaker.

use std::sync::atomic::Ordering;
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use axum::extract::State;
use axum::Json;
use serde::Serialize;
use tracing::warn;

use super::control::ControlCommand;
use super::poll::parse_sql_response;
use super::{command_sender, ApiError, AppState};
use crate::audio::meter::{InputLevel, InputMeter};
use crate::protocol::{classify_response, ScannerReply};

/// How much louder the hiss must be than the same input's quiet reading.
const MIN_RISE_DB: f64 = 12.0;
/// How loud the hiss must be at all, so a dead input's noise floor cannot rise
/// past `MIN_RISE_DB` on nothing.
const MIN_HISS_DBFS: f64 = -50.0;
/// Inputs take a moment to start delivering, and the hiss to start after
/// `SQL,0`. What arrives in this window is thrown away.
const SETTLE: Duration = Duration::from_millis(300);
const QUIET_WINDOW: Duration = Duration::from_millis(700);
const HISS_WINDOW: Duration = Duration::from_millis(1000);

#[derive(Debug, Serialize)]
pub(crate) struct FoundInput {
    /// The input that heard the hiss, or `None` when none clearly did.
    input: Option<String>,
    inputs: Vec<InputReading>,
}

#[derive(Debug, Serialize)]
struct InputReading {
    id: String,
    name: String,
    quiet_dbfs: Option<f64>,
    hiss_dbfs: Option<f64>,
    /// The hiss's peak, 0.0..=1.0: near 1.0 the recording would clip.
    hiss_peak: f32,
}

/// A restore that could not reach the radio, sent when that model reconnects.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct PendingSquelch {
    model: Option<String>,
    level: u8,
}

pub(crate) async fn post_find_input(
    State(state): State<AppState>,
) -> Result<Json<FoundInput>, ApiError> {
    let sender = command_sender(&state)?;
    if state.model_is_unlisted() {
        return Err(ApiError::BadRequest("unsupported_model".to_string()));
    }
    // Program mode silences the audio, and a sync holds the wire.
    if state.sync_task_id.lock().unwrap().is_some() {
        return Err(ApiError::Conflict("sync_in_progress".to_string()));
    }
    if state.program_mode_active.load(Ordering::Relaxed) {
        return Err(ApiError::Conflict("program_mode_active".to_string()));
    }
    // A second check would read the first one's SQL,0 as the user's squelch
    // and "restore" it to 0.
    if state.find_input_running.swap(true, Ordering::SeqCst) {
        return Err(ApiError::Conflict("find_input_in_progress".to_string()));
    }
    // Runs to the end even if the caller hangs up, so the squelch is restored.
    tokio::task::spawn_blocking(move || {
        let _running = Running(&state);
        let meter = InputMeter::open_all().map_err(ApiError::Internal)?;
        find_input(&state, sender, |settle, window| {
            std::thread::sleep(settle);
            meter.take();
            std::thread::sleep(window);
            meter.take()
        })
    })
    .await
    .map_err(|e| ApiError::Internal(format!("find_input_task_failed: {e}")))?
    .map(Json)
}

struct Running<'a>(&'a AppState);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.find_input_running.store(false, Ordering::SeqCst);
    }
}

/// The check, with listening injected: `listen(settle, window)` discards
/// `settle` of audio, then returns every input's level over `window`.
fn find_input(
    state: &AppState,
    sender: Sender<ControlCommand>,
    mut listen: impl FnMut(Duration, Duration) -> Vec<InputLevel>,
) -> Result<FoundInput, ApiError> {
    let quiet = listen(SETTLE, QUIET_WINDOW);
    let hiss = {
        let _open = OpenSquelch::open(state, sender)?;
        listen(SETTLE, HISS_WINDOW)
    };
    let input = pick_input(&quiet, &hiss);
    let inputs = hiss
        .into_iter()
        .map(|h| InputReading {
            quiet_dbfs: quiet.iter().find(|q| q.id == h.id).and_then(|q| q.rms_dbfs),
            hiss_dbfs: h.rms_dbfs,
            hiss_peak: h.peak,
            id: h.id,
            name: h.name,
        })
        .collect();
    Ok(FoundInput { input, inputs })
}

/// The input whose level rose most when the squelch opened, if any rose
/// clearly. An input missing from the quiet reading cannot be compared.
fn pick_input(quiet: &[InputLevel], hiss: &[InputLevel]) -> Option<String> {
    hiss.iter()
        .filter_map(|h| {
            let loud = h.rms_dbfs?;
            let before = quiet.iter().find(|q| q.id == h.id)?.rms_dbfs?;
            let rise = loud - before;
            (loud >= MIN_HISS_DBFS && rise >= MIN_RISE_DB).then_some((rise, &h.id))
        })
        .max_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, id)| id.clone())
}

/// RAII guard: the squelch is open (`SQL,0`) while this lives, and goes back
/// to the level the scanner reported on every way out.
///
/// The restore value comes from the scanner's own `SQL` reply, never from the
/// UI, and the guard exists before `SQL,0` is sent, so a lost reply to a write
/// the scanner took is still restored.
struct OpenSquelch<'a> {
    state: &'a AppState,
    sender: Sender<ControlCommand>,
    restore: u8,
}

impl<'a> OpenSquelch<'a> {
    fn open(state: &'a AppState, sender: Sender<ControlCommand>) -> Result<Self, ApiError> {
        let reply = send_blocking(&sender, "SQL").map_err(ApiError::BadRequest)?;
        let restore = parse_sql_response(&reply)
            .ok_or_else(|| ApiError::BadRequest("squelch_read_failed".to_string()))?;
        // REGRESSION GUARD (`the_hiss_is_never_logged_as_a_hit`): the level
        // drops to 0 BEFORE the wire, because `is_hit` ignores an open squelch
        // only at level 0 (#722). Otherwise two seconds of hiss are a hit.
        set_level(state, 0);
        let guard = Self {
            state,
            sender,
            restore,
        };
        let reply = send_blocking(&guard.sender, "SQL,0").map_err(ApiError::BadRequest)?;
        if !squelch_written(&reply) {
            return Err(ApiError::BadRequest(format!(
                "squelch_open_refused: {}",
                reply.trim()
            )));
        }
        // Again: the poll loop's own SQL refresh can land between the first
        // set and the write and put the old level back.
        set_level(state, 0);
        Ok(guard)
    }
}

impl Drop for OpenSquelch<'_> {
    fn drop(&mut self) {
        let command = format!("SQL,{}", self.restore);
        match send_blocking(&self.sender, &command) {
            Ok(reply) if squelch_written(&reply) => set_level(self.state, self.restore),
            outcome => {
                warn!(?outcome, "squelch not restored; will retry on reconnect");
                let model = self.state.device.read().unwrap().model.clone();
                *self.state.pending_squelch.lock().unwrap() = Some(PendingSquelch {
                    model,
                    level: self.restore,
                });
            }
        }
    }
}

/// The restore owed to the scanner that just connected, if the check that
/// owes it ran on the same model. Called before the connect-time `SQL` read,
/// which then reads the restored value back.
pub(crate) fn take_pending_squelch(state: &AppState) -> Option<u8> {
    let model = state.device.read().unwrap().model.clone();
    let mut pending = state.pending_squelch.lock().unwrap();
    if pending.as_ref().is_some_and(|p| p.model == model) {
        pending.take().map(|p| p.level)
    } else {
        None
    }
}

fn set_level(state: &AppState, level: u8) {
    if let Ok(mut live) = state.live.write() {
        live.squelch_level = level;
    }
}

/// Some firmwares echo `SQL,<n>` instead of `SQL,OK` (see `set_squelch`).
fn squelch_written(reply: &str) -> bool {
    match classify_response(reply) {
        ScannerReply::Ok => true,
        ScannerReply::Data(d) => d.to_uppercase().starts_with("SQL,"),
        _ => false,
    }
}

/// One queued command and its reply, from a thread that may block.
fn send_blocking(sender: &Sender<ControlCommand>, command: &str) -> Result<String, String> {
    let (reply_tx, reply_rx) = std::sync::mpsc::channel();
    let timeout = Duration::from_secs(3);
    sender
        .send(ControlCommand::Raw {
            command: command.to_string(),
            multiline: false,
            reply: reply_tx,
            deadline: Instant::now() + timeout,
        })
        .map_err(|_| "send_failed".to_string())?;
    reply_rx
        .recv_timeout(timeout)
        .map_err(|_| "command_timeout".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::tests::FakeScanner;
    use std::sync::{Arc, Mutex};

    fn level(id: &str, db: f64) -> InputLevel {
        InputLevel {
            id: id.to_string(),
            name: id.to_string(),
            rms_dbfs: Some(db),
            peak: 0.5,
        }
    }

    /// A scanner at squelch `level` that accepts writes, unless `refuse`
    /// matches the command.
    fn scanner(state: &AppState, level: u8, refuse: &'static str) -> FakeScanner {
        FakeScanner::attach(state, move |c| match c {
            c if c == refuse => Err("command_timeout".to_string()),
            "SQL" => Ok(format!("SQL,{level}")),
            _ => Ok("SQL,OK".to_string()),
        })
    }

    fn sender(state: &AppState) -> Sender<ControlCommand> {
        command_sender(state).unwrap()
    }

    #[test]
    fn the_input_that_rises_is_picked_not_the_loudest() {
        // The room mic is louder throughout; only the cable's input changes.
        let quiet = [level("0:Mic", -30.0), level("1:USB", -90.0)];
        let hiss = [level("0:Mic", -29.0), level("1:USB", -35.0)];
        assert_eq!(pick_input(&quiet, &hiss).as_deref(), Some("1:USB"));
    }

    #[test]
    fn nothing_is_picked_when_no_input_rises_clearly_or_loudly() {
        let quiet = [level("0:A", -60.0), level("1:B", -110.0)];
        // A rises 8 dB, too little. B rises 50 dB but stays under -50 dBFS.
        let hiss = [level("0:A", -52.0), level("1:B", -60.0)];
        assert_eq!(pick_input(&quiet, &hiss), None);
        // Loud enough, but a room mic that got 8 dB louder is not the cable.
        let quiet = [level("0:Mic", -48.0)];
        let hiss = [level("0:Mic", -40.0)];
        assert_eq!(pick_input(&quiet, &hiss), None);
        // An input with no quiet reading cannot be compared.
        assert_eq!(pick_input(&[], &[level("0:A", -10.0)]), None);
    }

    #[test]
    fn the_squelch_is_opened_and_restored_to_the_scanners_own_level() {
        let state = crate::api::default_state();
        state.live.write().unwrap().squelch_level = 9; // the UI's idea; stale
        let fake = scanner(&state, 4, "");
        let found = find_input(&state, sender(&state), |_, _| vec![level("0:USB", -90.0)]).unwrap();
        assert_eq!(found.input, None);
        assert_eq!(fake.transcript(), ["SQL", "SQL,0", "SQL,4"]);
        assert_eq!(state.live.read().unwrap().squelch_level, 4);
        assert!(state.pending_squelch.lock().unwrap().is_none());
    }

    #[test]
    fn a_refused_open_still_restores() {
        let state = crate::api::default_state();
        let fake = scanner(&state, 3, "SQL,0");
        let result = find_input(&state, sender(&state), |_, _| Vec::new());
        assert!(result.is_err());
        // The SQL,0 reply was lost, not refused: the scanner may have taken it.
        assert_eq!(fake.transcript(), ["SQL", "SQL,0", "SQL,3"]);
        assert_eq!(state.live.read().unwrap().squelch_level, 3);
    }

    #[test]
    fn an_unreadable_squelch_is_never_opened() {
        let state = crate::api::default_state();
        let fake = scanner(&state, 0, "SQL");
        assert!(find_input(&state, sender(&state), |_, _| Vec::new()).is_err());
        assert_eq!(fake.transcript(), ["SQL"]);
    }

    #[test]
    fn the_hiss_is_never_logged_as_a_hit() {
        let state = crate::api::default_state();
        state.live.write().unwrap().squelch_level = 2; // read at connect
        let levels = Arc::new(Mutex::new(Vec::new()));
        let (seen, fake_state) = (levels.clone(), state.clone());
        let _fake = FakeScanner::attach(&state, move |c| {
            if c == "SQL,0" {
                // The level the poll loop sees as the hiss starts...
                seen.lock()
                    .unwrap()
                    .push(fake_state.live.read().unwrap().squelch_level);
                // ...and its ~2 s SQL refresh landing just before the write.
                fake_state.live.write().unwrap().squelch_level = 2;
            }
            Ok(if c == "SQL" { "SQL,2" } else { "SQL,OK" }.to_string())
        });
        let (seen, check_state) = (levels.clone(), state.clone());
        find_input(&state, sender(&state), move |_, _| {
            seen.lock()
                .unwrap()
                .push(check_state.live.read().unwrap().squelch_level);
            Vec::new()
        })
        .unwrap();
        // Quiet at 2; 0 when SQL,0 reaches the radio; 0 for the whole hiss,
        // which `is_hit` ignores (#722).
        assert_eq!(*levels.lock().unwrap(), [2, 0, 0]);
    }

    #[test]
    fn a_restore_that_cannot_reach_the_radio_waits_for_the_same_model() {
        let state = crate::api::default_state();
        state.device.write().unwrap().model = Some("BC125AT".to_string());
        let _fake = scanner(&state, 5, "SQL,5");
        find_input(&state, sender(&state), |_, _| Vec::new()).unwrap();
        assert_eq!(state.live.read().unwrap().squelch_level, 0);

        state.device.write().unwrap().model = Some("BC75XLT".to_string());
        assert_eq!(take_pending_squelch(&state), None, "not another radio's");
        state.device.write().unwrap().model = Some("BC125AT".to_string());
        assert_eq!(take_pending_squelch(&state), Some(5));
        assert_eq!(take_pending_squelch(&state), None, "sent once");
    }
}
