//! Serial port transport: open, send command, read response.

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
}
