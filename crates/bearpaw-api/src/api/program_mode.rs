//! RAII guard for the scanner's PRG (program) mode.
//!
//! The BC125AT exposes memory/settings only while in program mode, entered
//! with `PRG\r` and exited with `EPG\r`. Any handler that needs to read or
//! write memory has to bracket its work in a `PRG`/`EPG` pair. See
//! `docs/BC125AT_PROTOCOL.md` §4 ("Operating modes & state machine") for
//! the protocol's view of this transaction.
//!
//! Two things about this are easy to get wrong:
//!
//! 1. **Leaks.** If anything between PRG and EPG returns early, the scanner
//!    is stuck in program mode (LCD shows "Remote Mode / Keypad Lock") until
//!    the next EPG or a power cycle.
//! 2. **Poll-loop interference.** While the scanner is in PRG mode, the
//!    operational `STS`/`GLG`/`PWR` commands the poll loop normally issues
//!    every 200 ms come back `NG` and their bytes collide with the bracket's
//!    own reads on the bulk endpoint. The poll loop must suspend itself.
//!
//! `ProgramModeGuard` owns both concerns. Construct it before any
//! PRG-only work; drop it (explicitly or at scope exit) to leave program
//! mode. The Drop impl sends EPG and clears the suspend flag even if the
//! caller panicked or returned an error in the middle.

use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use tracing::warn;

use super::send_raw_command;
use super::ApiError;
use super::AppState;
use crate::protocol::{classify_response, ScannerReply};

/// Delay after `PRG,OK` (and after `EPG` is queued in Drop) for the
/// scanner's mode transition to settle. Without this, the next command
/// — especially a memory-sync `CIN,1` — can race the mode transition
/// and come back `NG`. Empirically 50–100 ms is enough; we use 100 to
/// have headroom.
const MODE_TRANSITION_SETTLE: Duration = Duration::from_millis(100);

/// RAII guard. Entering scope sends `PRG` and asserts the
/// `program_mode_active` flag (which suspends the poll loop's
/// STS/GLG/PWR fetches). Dropping the guard sends `EPG` and clears the
/// flag.
///
/// The guard is `!Send` deliberately — it must be dropped on the same
/// task that constructed it. Use it inside a single async handler; do
/// not stash it in a future that can be cancelled across an `.await`
/// point on another task.
pub struct ProgramModeGuard {
    state: AppState,
    flag: Arc<AtomicBool>,
    /// True if PRG entry succeeded. Drop should only send EPG in that case.
    active: bool,
}

impl ProgramModeGuard {
    /// Enter program mode. On success, the guard's drop will exit program
    /// mode. On failure (PRG returned an error), the guard is still
    /// returned but in an inactive state — drop is a no-op — and the
    /// caller's `?` will propagate the error up.
    ///
    /// Refuses to enter while a memory sync is in progress: sync runs PRG
    /// directly on the poll thread and holds the bulk endpoint for the
    /// duration, so a concurrent PRG from a handler would queue behind it
    /// and time out (we observed 3 s timeouts during Phase 9-verify). 409
    /// Conflict here lets the frontend retry once the sync finishes.
    pub async fn enter(state: &AppState) -> Result<Self, ApiError> {
        if state.sync_task_id.lock().unwrap().is_some() {
            // `sync_in_progress`, matching the six other sites and the three
            // places API_SPEC documents this 409. This guard used to answer
            // `memory_sync_in_progress` -- the only occurrence anywhere, and
            // undocumented -- so a client handling the documented string got a
            // generic failure from the one guard that fires most often.
            return Err(ApiError::Conflict("sync_in_progress".to_string()));
        }
        let flag = state.program_mode_active.clone();
        // Set the flag *before* sending PRG so the poll loop suspends as
        // early as possible. If PRG fails, the Drop impl will clear it.
        flag.store(true, Ordering::Relaxed);
        let mut guard = Self {
            state: state.clone(),
            flag,
            active: false,
        };
        match send_raw_command(state, "PRG", false).await {
            Ok(resp) => {
                // REGRESSION GUARD (#140): a transport-level Ok is not enough —
                // the scanner can answer `PRG,NG`/`ERR` (e.g. it's in a menu).
                // Treating that as success leaves an "active" guard that
                // suspends polling and whose Drop sends a spurious EPG, while
                // every subsequent CIN/SCG fails. Require an actual OK.
                if !matches!(classify_response(&resp), ScannerReply::Ok) {
                    // guard.active stays false → Drop clears the flag, no EPG.
                    return Err(ApiError::BadRequest(format!(
                        "program_mode_refused: {}",
                        resp.trim()
                    )));
                }
                guard.active = true;
                // Let the LCD/firmware settle on the new mode before the
                // caller fires its first PRG-only command. Skipping this
                // makes the immediately-following CIN/SCG come back NG on
                // some firmware revisions.
                tokio::time::sleep(MODE_TRANSITION_SETTLE).await;
                Ok(guard)
            }
            Err(e) => {
                // Drop will clear the flag.
                Err(e)
            }
        }
    }
}

impl Drop for ProgramModeGuard {
    fn drop(&mut self) {
        // REGRESSION GUARD (`the_flag_survives_a_drop_that_queued_an_epg`):
        // the flag is NOT cleared here when an EPG is on its way (#598).
        //
        // It used to be cleared unconditionally, up front, and the EPG queued
        // afterwards. The poll loop yields STS/GLG on this flag, so it resumed
        // polling a radio that had not left PRG yet -- a window exactly as wide
        // as the queue backlog, and a plausible source of the STS parse drops
        // logged on hardware.
        //
        // The poll loop clears it after the EPG actually goes out, which is the
        // ordering `send_raw_command` already used for the EPGs it sends
        // itself. A Drop cannot await a reply, which is why this path had its
        // own, wrong, copy of the logic.
        //
        // The flag is still cleared HERE in every case where no EPG will
        // arrive, because then nothing else ever would: the stuck flag freezes
        // the live display, which is the hazard the original comment named and
        // it has not gone away.
        if !self.active {
            // PRG never succeeded; nothing to EPG.
            self.flag.store(false, Ordering::Relaxed);
            return;
        }

        // Send EPG synchronously via the channel. We're in Drop so we
        // can't await; fire-and-forget through the same mechanism
        // send_raw_command uses, but without waiting for the reply.
        let tx = self.state.command_tx.lock().ok().and_then(|g| g.clone());
        let queued = match tx {
            Some(tx) => {
                let (reply_tx, _) = std::sync::mpsc::channel();
                tx.send(crate::api::control::ControlCommand::Raw {
                    command: "EPG".to_string(),
                    multiline: false,
                    reply: reply_tx,
                    // EPG is exempt from expiry in the drain (see
                    // control::should_execute_queued), but give it a generous
                    // deadline anyway so the intent is explicit: the bracket
                    // closer must run no matter how late.
                    deadline: std::time::Instant::now() + std::time::Duration::from_secs(60),
                })
                .is_ok()
                // Don't block on the reply: the poll thread executes EPG on its
                // next drain and clears the flag there (#598).
            }
            None => {
                warn!("ProgramModeGuard dropped with no command channel; EPG not sent");
                false
            }
        };

        // Nothing is coming to clear it, so clear it here. Covers a missing
        // sender and a receiver that has hung up -- in both cases the poll loop
        // will never see the EPG, and a flag left set freezes the live display.
        if !queued {
            self.flag.store(false, Ordering::Relaxed);
        }
    }
}
