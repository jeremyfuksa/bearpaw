//! Serial port transport: open, send command, read response.

use std::thread;
use std::time::Duration;

use serialport::{ClearBuffer, SerialPort};
use thiserror::Error;
use tracing::warn;

#[derive(Debug, Error)]
pub enum TransportError {
    #[error("serial open failed: {0}")]
    Open(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

impl TransportError {
    /// True if this error indicates the serial port is no longer reachable —
    /// the device node has been removed (unplug, kernel reset). The poll
    /// loop uses this to decide between "retry the same handle" (false) and
    /// "drop the handle and re-open the transport" (true).
    pub fn is_device_gone(&self) -> bool {
        match self {
            // `serialport::new(...).open()` failed at the OS layer — typically
            // ENOENT, which is what we see on unplug.
            TransportError::Open(_) => true,
            TransportError::Io(e) => {
                // Error kinds that unambiguously mean the node is gone.
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound
                        | std::io::ErrorKind::BrokenPipe
                        | std::io::ErrorKind::ConnectionAborted
                        | std::io::ErrorKind::ConnectionReset
                        | std::io::ErrorKind::UnexpectedEof
                ) {
                    return true;
                }
                // Never treat a plain read timeout (or an interrupted /
                // would-block syscall) as a death certificate — those are
                // normal transient conditions and must NOT force a reconnect.
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                        | std::io::ErrorKind::WouldBlock
                ) {
                    return false;
                }
                // REGRESSION GUARD: BUG_AUDIT H10 — on Linux a removed
                // ttyACM*/ttyUSB* node yields EIO (5) or ENXIO (6), which std
                // maps to ErrorKind::Uncategorized/Other and we previously
                // classified as transient. The poll loop then warned at 5 Hz
                // forever and never reconnected. Match the raw errno so unplug
                // is detected. See `is_device_gone_classifies_linux_unplug_errno`.
                matches!(e.raw_os_error(), Some(5) | Some(6))
            }
        }
    }
}

/// Serial transport: one command at a time, response until `\r`.
pub struct SerialTransport {
    port_name: String,
    baud: u32,
    timeout_ms: u64,
    /// Assert DTR after opening the port. Off by default — asserting DTR on
    /// open has caused intermittent disconnects on macOS/Linux. See
    /// `docs/BC125AT_PROTOCOL.md` §1 "Open-time discipline" and
    /// `docs/SCANNER_PROTOCOL_REFERENCE.md` §1.
    assert_dtr_on_open: bool,
}

impl SerialTransport {
    pub fn new(port_name: impl Into<String>, baud: u32) -> Self {
        Self {
            port_name: port_name.into(),
            baud,
            timeout_ms: 500,
            assert_dtr_on_open: false,
        }
    }

    /// Opt in to asserting DTR on open. Only enable this if the OS or
    /// adapter is known to require it; the BC125AT itself does not.
    pub fn with_dtr_on_open(mut self, assert: bool) -> Self {
        self.assert_dtr_on_open = assert;
        self
    }

    /// Returns true if `open()` will assert DTR after constructing the port.
    pub fn asserts_dtr_on_open(&self) -> bool {
        self.assert_dtr_on_open
    }

    pub fn open(&self) -> Result<Box<dyn SerialPort>, TransportError> {
        let mut port = serialport::new(&self.port_name, self.baud)
            .timeout(Duration::from_millis(self.timeout_ms))
            .open()
            .map_err(|e| TransportError::Open(e.to_string()))?;
        if self.assert_dtr_on_open {
            port.write_data_terminal_ready(true)
                .map_err(|e| TransportError::Open(e.to_string()))?;
        }
        // Drop stale bytes from a previous session so the first response
        // isn't corrupted. Non-fatal if the OS doesn't support it; we just
        // warn and continue. See docs/BC125AT_PROTOCOL.md §1 "Open-time
        // discipline" and docs/SCANNER_PROTOCOL_REFERENCE.md §13 gap 7.
        if let Err(e) = port.clear(ClearBuffer::Input) {
            warn!(
                "Failed to drain serial input buffer on open ({}): {}",
                self.port_name, e
            );
        }
        Ok(port)
    }

    /// Send ASCII command + `\r`, read until `\r`, return line without `\r`.
    /// Uses the transport's default timeout (`timeout_ms`, 500ms).
    pub fn send(&self, port: &mut dyn SerialPort, cmd: &str) -> Result<String, TransportError> {
        self.send_with_timeout(port, cmd, Duration::from_millis(self.timeout_ms))
    }

    /// Like `send` but overrides the port's read timeout for the duration
    /// of this single command. The previous timeout is restored on return
    /// (including the error paths).
    ///
    /// Use this for the small set of commands that the BC125AT documents
    /// as long-running — primarily `CLR` (factory reset, ~30 seconds, per
    /// docs/BC125AT_PROTOCOL.md §5.2). Do **not** use this to paper over
    /// general latency problems.
    pub fn send_with_timeout(
        &self,
        port: &mut dyn SerialPort,
        cmd: &str,
        timeout: Duration,
    ) -> Result<String, TransportError> {
        let original_timeout = port.timeout();
        port.set_timeout(timeout)
            .map_err(|e| TransportError::Open(e.to_string()))?;
        let result = self.send_inner(port, cmd);
        // Restore even if send_inner failed — otherwise a CLR-style call
        // would leave the port stuck on a 30s timeout for all subsequent
        // commands.
        let _ = port.set_timeout(original_timeout);
        result
    }

    /// Read and discard any stale bytes stranded in the input buffer by a
    /// previous timed-out response. Without this, those leftover bytes become
    /// the *next* command's reply and shift every request/response pair out of
    /// alignment — the desync class CLAUDE.md pitfalls 2–3 warn about. Serial
    /// analogue of `UsbTransport::drain_input`.
    ///
    /// REGRESSION GUARD: BUG_AUDIT H10 — the serial path only drained once at
    /// open(), never before each command. Best-effort and non-blocking: it
    /// gates each read on `bytes_to_read()` (so it returns immediately when the
    /// buffer is empty), uses a tiny read timeout as a backstop, and restores
    /// the port's prior timeout on return.
    fn drain_input(&self, port: &mut dyn SerialPort) {
        let saved = port.timeout();
        if port.set_timeout(Duration::from_millis(2)).is_err() {
            return;
        }
        let mut buf = [0u8; 128];
        // Safety cap (~20 KB) so a device steadily emitting data can't spin
        // here forever, matching UsbTransport::drain_input.
        for _ in 0..160 {
            match port.bytes_to_read() {
                Ok(0) => break,
                Ok(_) => {}
                Err(_) => break,
            }
            match port.read(&mut buf) {
                Ok(0) => break,
                Ok(_) => continue,
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut => break,
                Err(_) => break,
            }
        }
        let _ = port.set_timeout(saved);
    }

    fn send_inner(&self, port: &mut dyn SerialPort, cmd: &str) -> Result<String, TransportError> {
        // Clear any bytes stranded by a previous timed-out response before we
        // write, so this command's reply isn't shifted by stale input.
        self.drain_input(port);

        // BC125AT wire format: CR-only (`\r`, 0x0D) terminator, never CRLF.
        // A stray LF leaves a byte in the input buffer and turns the next
        // command into ERR. See docs/BC125AT_PROTOCOL.md §2 and §3.
        let mut buf = cmd.as_bytes().to_vec();
        buf.push(b'\r');
        port.write_all(&buf)?;
        port.flush()?;

        // Commands are not pipelined — wait for the single-line response
        // terminated by `\r`. See docs/BC125AT_PROTOCOL.md §3.
        let mut out = Vec::new();
        loop {
            let mut b = [0u8; 1];
            if port.read(&mut b)? == 0 {
                break;
            }
            if b[0] == b'\r' {
                break;
            }
            out.push(b[0]);
        }
        Ok(String::from_utf8_lossy(&out).trim().to_string())
    }

    /// Send command + `\r`, then read multiline response (until 50ms idle).
    pub fn send_and_read_multiline(
        &self,
        port: &mut dyn SerialPort,
        cmd: &str,
    ) -> Result<String, TransportError> {
        let mut buf = cmd.as_bytes().to_vec();
        buf.push(b'\r');
        port.write_all(&buf)?;
        port.flush()?;
        self.read_response_multiline(port)
    }

    /// Read a full multiline response: read bytes until idle for 50ms.
    pub fn read_response_multiline(
        &self,
        port: &mut dyn SerialPort,
    ) -> Result<String, TransportError> {
        use std::time::Instant;
        let idle_timeout = Duration::from_millis(50);
        // Overall deadline so a device that stops answering *without* raising
        // an I/O error (a wedged-but-open port — another program left the
        // scanner in PRG, a half-dead cable) can't spin the poll thread
        // forever. Scaled off the per-read timeout with a 2s floor; with the
        // default 500ms timeout this is 2s. Mirrors the USB transport, which
        // errors on timeout-with-no-data (transport_usb.rs read_multiline).
        //
        // REGRESSION GUARD: BUG_AUDIT C7 — the Ok(0)/TimedOut arms used to
        // `continue` unconditionally while `out` was still empty, so a silent
        // device hung this function (and every STS poll) indefinitely. A
        // timeout/EOF with an empty buffer past the deadline MUST return Err;
        // the completed-line path (non-empty buffer, idle elapsed) is
        // unchanged.
        let overall_deadline = Duration::from_millis(self.timeout_ms.saturating_mul(4).max(2000));
        let start = Instant::now();
        let mut out = Vec::new();
        let mut last = Instant::now();
        let mut b = [0u8; 64];
        loop {
            match port.read(&mut b) {
                Ok(0) => {
                    if !out.is_empty() && last.elapsed() >= idle_timeout {
                        break;
                    }
                    if out.is_empty() && start.elapsed() >= overall_deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "serial multiline read produced no data before deadline",
                        )
                        .into());
                    }
                    thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Ok(n) => {
                    out.extend_from_slice(&b[..n]);
                    last = Instant::now();
                }
                Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {
                    if !out.is_empty() && last.elapsed() >= idle_timeout {
                        break;
                    }
                    if out.is_empty() && start.elapsed() >= overall_deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "serial multiline read produced no data before deadline",
                        )
                        .into());
                    }
                    continue;
                }
                Err(e) => return Err(e.into()),
            }
        }
        Ok(String::from_utf8_lossy(&out)
            .trim()
            .replace('\r', "\n")
            .trim()
            .to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_does_not_assert_dtr_by_default() {
        let t = SerialTransport::new("/dev/null", 115200);
        assert!(!t.asserts_dtr_on_open());
    }

    #[test]
    fn with_dtr_on_open_flips_the_flag() {
        let t = SerialTransport::new("/dev/null", 115200).with_dtr_on_open(true);
        assert!(t.asserts_dtr_on_open());

        let t = SerialTransport::new("/dev/null", 115200).with_dtr_on_open(false);
        assert!(!t.asserts_dtr_on_open());
    }

    #[test]
    fn is_device_gone_classifies_unplug_errors() {
        let err = TransportError::Io(std::io::Error::from(std::io::ErrorKind::NotFound));
        assert!(err.is_device_gone(), "ENOENT means device went away");

        let err = TransportError::Io(std::io::Error::from(std::io::ErrorKind::BrokenPipe));
        assert!(err.is_device_gone(), "EPIPE means device went away");

        let err = TransportError::Open("port disappeared".to_string());
        assert!(err.is_device_gone(), "open failure = device gone");
    }

    #[test]
    fn is_device_gone_does_not_classify_transient_errors_as_dead() {
        // TimedOut is a normal read timeout, not a death certificate.
        let err = TransportError::Io(std::io::Error::from(std::io::ErrorKind::TimedOut));
        assert!(!err.is_device_gone());

        let err = TransportError::Io(std::io::Error::from(std::io::ErrorKind::Interrupted));
        assert!(!err.is_device_gone());
    }

    #[test]
    fn is_device_gone_classifies_linux_unplug_errno() {
        // A removed ttyACM*/ttyUSB* node on Linux surfaces as EIO (5) or
        // ENXIO (6), which std maps to Uncategorized/Other. These mean the
        // device is gone and must trigger a reconnect. (BUG_AUDIT H10)
        let eio = TransportError::Io(std::io::Error::from_raw_os_error(5));
        assert!(eio.is_device_gone(), "EIO means the tty node went away");

        let enxio = TransportError::Io(std::io::Error::from_raw_os_error(6));
        assert!(enxio.is_device_gone(), "ENXIO means the tty node went away");
    }

    #[test]
    fn is_device_gone_ignores_unrelated_errno() {
        // A genuinely transient / unrelated errno (e.g. ENOSPC = 28) must NOT
        // be classified as the device disappearing — otherwise a stray error
        // would force a needless reconnect. Guards the errno match above from
        // being widened accidentally.
        let enospc = TransportError::Io(std::io::Error::from_raw_os_error(28));
        assert!(!enospc.is_device_gone());

        // EINTR (4) / EAGAIN (11) are transient syscall conditions.
        let eintr = TransportError::Io(std::io::Error::from_raw_os_error(4));
        assert!(!eintr.is_device_gone());
        let eagain = TransportError::Io(std::io::Error::from_raw_os_error(11));
        assert!(!eagain.is_device_gone());
    }

    // NOTE: `read_response_multiline`'s no-data deadline (BUG_AUDIT C7) and
    // `drain_input` (H10) are not unit-tested here because `dyn SerialPort`
    // has no lightweight in-memory implementation to construct (it requires a
    // real OS handle, control-line state, etc.). The behavior is covered by
    // the REGRESSION GUARD comments at each site; exercise them with a real or
    // stubbed port at the integration layer if one becomes available.
}
