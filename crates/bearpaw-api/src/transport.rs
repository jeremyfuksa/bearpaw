//! Serial port transport: open, send command, read response.

use std::thread;
use std::time::Duration;

use serialport::SerialPort;
use thiserror::Error;

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
}

impl SerialTransport {
    pub fn new(port_name: impl Into<String>, baud: u32) -> Self {
        Self {
            port_name: port_name.into(),
            baud,
            timeout_ms: 500,
        }
    }

    pub fn open(&self) -> Result<Box<dyn SerialPort>, TransportError> {
        let mut port = serialport::new(&self.port_name, self.baud)
            .timeout(Duration::from_millis(self.timeout_ms))
            .open()
            .map_err(|e| TransportError::Open(e.to_string()))?;
        port.write_data_terminal_ready(true)
            .map_err(|e| TransportError::Open(e.to_string()))?;
        Ok(port)
    }

    /// Send ASCII command + `\r`, read until `\r`, return line without `\r`.
    pub fn send(&self, port: &mut dyn SerialPort, cmd: &str) -> Result<String, TransportError> {
        let mut buf = cmd.as_bytes().to_vec();
        buf.push(b'\r');
        port.write_all(&buf)?;
        port.flush()?;

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
