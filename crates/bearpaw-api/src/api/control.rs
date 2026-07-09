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
    StartSync {
        task_id: String,
        max_channels: u16,
    },
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

#[cfg(test)]
mod tests {
    use super::should_execute_queued;
    use std::time::{Duration, Instant};

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

/// Frequency range for BC125AT (MHz).
pub const FREQ_MIN: f64 = 25.0;
pub const FREQ_MAX: f64 = 512.0;

pub fn validate_frequency(freq: f64) -> Result<(), String> {
    if !freq.is_finite() || freq < FREQ_MIN || freq > FREQ_MAX {
        return Err(format!(
            "Frequency must be between {} and {} MHz",
            FREQ_MIN, FREQ_MAX
        ));
    }
    Ok(())
}
