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

    fn send_inner(
        &self,
        port: &mut dyn SerialPort,
        cmd: &str,
    ) -> Result<String, TransportError> {
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
        let mut out = Vec::new();
        let mut last = Instant::now();
        let mut b = [0u8; 64];
        loop {
            match port.read(&mut b) {
                Ok(0) => {
                    if !out.is_empty() && last.elapsed() >= idle_timeout {
                        break;
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
}
