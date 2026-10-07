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

use std::sync::atomic::Ordering;
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

/// RAII guard: one share of the open program-mode bracket.
///
/// The first guard sends `PRG` and asserts the `program_mode_active` flag
/// (which suspends the poll loop's STS/GLG/PWR fetches). A guard taken while a
/// bracket is open joins it: no `PRG`. The `EPG` goes out when the LAST guard
/// drops.
///
/// REGRESSION GUARD (#695,
/// `a_joined_request_keeps_the_bracket_open_after_the_opener_leaves`): joining
/// used to read the global flag, and a joiner held nothing open, so the opener
/// could send `EPG` while the joiner still had a `CIN` to send. Counting shares
/// makes one rule cover all three ways a bracket is shared: a guard further up
/// the same call stack, the session `program_mode_start` holds open across
/// requests, and an unrelated request that overlaps in time.
pub struct ProgramModeGuard {
    state: AppState,
}

impl ProgramModeGuard {
    /// Enter program mode, or join the bracket that is already open.
    ///
    /// Refuses to enter while a memory sync is in progress: sync runs PRG
    /// directly on the poll thread and holds the bulk endpoint for the
    /// duration, so a concurrent PRG from a handler would queue behind it
    /// and time out (we observed 3 s timeouts during Phase 9-verify). 409
    /// Conflict here lets the frontend retry once the sync finishes. A sync
    /// sets `program_mode_active` too, and is not a bracket anyone may join.
    pub async fn enter(state: &AppState) -> Result<Self, ApiError> {
        // Held until the PRG is answered and settled: a second caller must not
        // join a bracket that is not open yet.
        let _opening = state.program_mode_opening.lock().await;
        // REGRESSION GUARD (#695,
        // `a_sync_registered_during_the_opening_wait_is_refused`): checked
        // AFTER the wait above. Checked before it, a sync that registered
        // during the wait got this caller queued behind the whole walk.
        if state.sync_task_id.lock().unwrap().is_some() {
            // `sync_in_progress`, matching the six other sites and the three
            // places API_SPEC documents this 409. This guard used to answer
            // `memory_sync_in_progress` -- the only occurrence anywhere, and
            // undocumented -- so a client handling the documented string got a
            // generic failure from the one guard that fires most often.
            return Err(ApiError::Conflict("sync_in_progress".to_string()));
        }
        {
            let mut holders = state.program_mode_holders.lock().unwrap();
            if *holders > 0 {
                *holders += 1;
                return Ok(Self {
                    state: state.clone(),
                });
            }
        }

        let flag = &state.program_mode_active;
        // Set the flag *before* sending PRG so the poll loop suspends as
        // early as possible.
        flag.store(true, Ordering::Relaxed);
        let resp = match send_raw_command(state, "PRG", false).await {
            Ok(resp) => resp,
            Err(e) => {
                // REGRESSION GUARD (#724,
                // `a_prg_that_fails_without_a_reply_is_followed_by_an_epg`):
                // an error here is ambiguous. Both transports write the command
                // before reading its reply, so a lost or late reply can follow
                // a PRG the scanner accepted. No guard is built, so no Drop will
                // ever send the EPG -- send it now. An EPG to a radio that never
                // entered program mode is harmless; a radio left in Remote Mode
                // needs a power cycle. The poll thread clears the flag when the
                // EPG goes out, whichever way the PRG went.
                if !queue_epg(state) {
                    flag.store(false, Ordering::Relaxed);
                }
                return Err(e);
            }
        };
        // REGRESSION GUARD (#140): a transport-level Ok is not enough —
        // the scanner can answer `PRG,NG`/`ERR`. (Not from its menu or
        // mid direct entry: a BC125AT accepts PRG in both -- see
        // audit-reconciliation Conflict 6.) Treating that as success leaves a
        // guard that suspends polling and whose Drop sends a spurious EPG,
        // while every subsequent CIN/SCG fails. Require an actual OK.
        if !matches!(classify_response(&resp), ScannerReply::Ok) {
            flag.store(false, Ordering::Relaxed);
            return Err(ApiError::BadRequest(format!(
                "program_mode_refused: {}",
                resp.trim()
            )));
        }
        *state.program_mode_holders.lock().unwrap() = 1;
        let guard = Self {
            state: state.clone(),
        };
        // Let the LCD/firmware settle on the new mode before the
        // caller fires its first PRG-only command. Skipping this
        // makes the immediately-following CIN/SCG come back NG on
        // some firmware revisions.
        tokio::time::sleep(MODE_TRANSITION_SETTLE).await;
        Ok(guard)
    }
}

impl Drop for ProgramModeGuard {
    fn drop(&mut self) {
        // The count stays locked until the EPG is queued, so a caller that
        // then finds the bracket closed queues its PRG behind this EPG.
        let mut holders = self.state.program_mode_holders.lock().unwrap();
        *holders -= 1;
        if *holders > 0 {
            // Someone else is still inside the bracket; they send the EPG.
            return;
        }

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

        // Nothing is coming to clear it, so clear it here. Covers a missing
        // sender and a receiver that has hung up -- in both cases the poll loop
        // will never see the EPG, and a flag left set freezes the live display.
        if !queue_epg(&self.state) {
            self.state
                .program_mode_active
                .store(false, Ordering::Relaxed);
        }
    }
}

/// Queue an `EPG` without waiting for its reply, and say whether it was queued.
///
/// Fire-and-forget through the same channel `send_raw_command` uses: a Drop
/// cannot await. The poll thread executes the EPG on its next drain and clears
/// `program_mode_active` there (#598). When this returns false nothing will
/// clear the flag, so the caller must.
fn queue_epg(state: &AppState) -> bool {
    let tx = state.command_tx.lock().ok().and_then(|g| g.clone());
    match tx {
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
        }
        None => {
            warn!("no command channel; EPG not sent");
            false
        }
    }
}
