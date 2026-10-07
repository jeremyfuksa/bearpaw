//! Control commands sent from API to poll loop: Hold, Scan, memory sync,
//! raw wire commands.

/// Command for the poll thread to send to the scanner.
#[derive(Clone, Debug)]
pub enum ControlCommand {
    /// Press Hold (KEY,H,P). Reply carries the scanner's raw response so the
    /// HTTP handler can validate the OK ack.
    Hold {
        reply: Option<std::sync::mpsc::Sender<Result<String, String>>>,
        /// Discard-after instant (#139) — see `Raw::deadline`.
        deadline: std::time::Instant,
    },
    /// Press Scan (KEY,S,P).
    Scan {
        reply: Option<std::sync::mpsc::Sender<Result<String, String>>>,
        /// Discard-after instant (#139) — see `Raw::deadline`.
        deadline: std::time::Instant,
    },
    /// Run full memory sync (PRG -> CIN 1..max_channels -> EPG); progress via WebSocket.
    StartSync { task_id: String, max_channels: u16 },
    /// Send a raw scanner command and return raw response to API caller.
    Raw {
        command: String,
        multiline: bool,
        reply: std::sync::mpsc::Sender<Result<String, String>>,
        /// Discard-after instant (#139). `send_raw_command` gives up on the
        /// reply after 3 s, but the command used to stay queued and execute
        /// whenever the poll thread next drained — a timed-out PRG could put
        /// the scanner into program mode minutes later with nothing to take
        /// it out. The poll loop checks this before executing.
        deadline: std::time::Instant,
    },
}

/// Whether a queued `Raw` command should still execute when the poll thread
/// drains it (#139).
///
/// Expired commands are discarded — with one exception: `EPG` always
/// executes, even late. EPG is the program-mode bracket-closer; discarding a
/// late EPG is exactly the "scanner stuck in Remote Mode until power-cycle"
/// failure this deadline exists to prevent, just from the other direction.
pub fn should_execute_queued(command: &str, deadline: std::time::Instant) -> bool {
    if command.trim().eq_ignore_ascii_case("EPG") {
        return true;
    }
    std::time::Instant::now() <= deadline
}

/// Keep `program_mode_active` in step with the bracket commands the poll
/// thread has just executed. Call it before replying, so the caller's own
/// handling of the reply comes after.
///
/// REGRESSION GUARD (#598): the flag clears only AFTER the EPG has actually
/// gone out. `ProgramModeGuard::drop` used to clear it up front and then queue
/// the EPG fire-and-forget, so the poll loop resumed polling a radio that had
/// not left PRG yet. Cleared whether or not the write succeeded: a failed EPG
/// still ends the bracket as far as this process is concerned.
///
/// REGRESSION GUARD (#695, `a_prg_after_a_stale_epg_leaves_polling_suspended`):
/// a PRG sets it again. A guard entering while an earlier guard's EPG is still
/// queued sets the flag, and that EPG then clears it. `ProgramModeGuard::enter`
/// clears the flag itself if the PRG is refused.
pub fn track_program_mode(flag: &std::sync::atomic::AtomicBool, command: &str) {
    let command = command.trim();
    if command.eq_ignore_ascii_case("EPG") {
        flag.store(false, std::sync::atomic::Ordering::Relaxed);
    } else if command.eq_ignore_ascii_case("PRG") {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::{should_execute_queued, track_program_mode};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    /// REGRESSION GUARD (#695): an old bracket's EPG must not leave the next
    /// bracket unflagged.
    ///
    /// A guard's Drop only queues its EPG. A caller entering straight after --
    /// `clear_temporary_lockouts` does, once per channel -- sets the flag and
    /// queues its PRG behind that EPG. The EPG then clears the flag, and unless
    /// the PRG sets it again the poll loop sends STS/GLG inside the new bracket.
    #[test]
    fn a_prg_after_a_stale_epg_leaves_polling_suspended() {
        let flag = AtomicBool::new(true);
        track_program_mode(&flag, "EPG");
        assert!(!flag.load(Ordering::Relaxed), "an EPG ends the bracket");
        track_program_mode(&flag, "PRG");
        assert!(
            flag.load(Ordering::Relaxed),
            "the PRG queued behind it opens a new one, and polling must stay suspended"
        );
    }

    #[test]
    fn unexpired_commands_execute() {
        let deadline = Instant::now() + Duration::from_secs(3);
        assert!(should_execute_queued("KEY,S,P", deadline));
        assert!(should_execute_queued("PRG", deadline));
    }

    #[test]
    fn expired_commands_are_discarded() {
        let deadline = Instant::now() - Duration::from_secs(1);
        assert!(!should_execute_queued("KEY,S,P", deadline));
        assert!(
            !should_execute_queued("PRG", deadline),
            "a stale PRG must never fire — it strands the scanner in Remote Mode (#139)"
        );
    }

    #[test]
    fn epg_always_executes_even_expired() {
        let deadline = Instant::now() - Duration::from_secs(60);
        assert!(should_execute_queued("EPG", deadline));
        assert!(should_execute_queued("epg", deadline));
        assert!(should_execute_queued(" EPG ", deadline));
    }
}
