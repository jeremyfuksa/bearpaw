//! Direct USB transport for scanners when no serial TTY is exposed.

use std::time::Duration;

use rusb::{Context, DeviceHandle, UsbContext};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum UsbTransportError {
    #[error("usb device not found: {0:04x}:{1:04x}")]
    NotFound(u16, u16),
    #[error("usb error: {0}")]
    Usb(#[from] rusb::Error),
}

pub struct UsbSession {
    pub _ctx: Context,
    pub handle: DeviceHandle<Context>,
}

pub struct UsbTransport {
    vid: u16,
    pid: u16,
    timeout_ms: u64,
    data_interface: u8,
    ep_in: u8,
    ep_out: u8,
}

impl UsbTransport {
    pub fn new(vid: u16, pid: u16) -> Self {
        Self {
            vid,
            pid,
            timeout_ms: 500,
            data_interface: 1,
            ep_in: 0x81,
            ep_out: 0x02,
        }
    }

    pub fn open(&self) -> Result<UsbSession, UsbTransportError> {
        let ctx = Context::new()?;
        let devices = ctx.devices()?;
        for dev in devices.iter() {
            let desc = dev.device_descriptor()?;
            if desc.vendor_id() == self.vid && desc.product_id() == self.pid {
                let handle = dev.open()?;
                let _ = handle.set_active_configuration(1);
                for intf in [0u8, self.data_interface] {
                    if handle.kernel_driver_active(intf).unwrap_or(false) {
                        let _ = handle.detach_kernel_driver(intf);
                    }
                }
                handle.claim_interface(self.data_interface)?;
                return Ok(UsbSession { _ctx: ctx, handle });
            }
        }
        Err(UsbTransportError::NotFound(self.vid, self.pid))
    }

    pub fn send(&self, session: &mut UsbSession, cmd: &str) -> Result<String, UsbTransportError> {
        let mut payload = cmd.as_bytes().to_vec();
        payload.push(b'\r');
        session.handle.write_bulk(
            self.ep_out,
            &payload,
            Duration::from_millis(self.timeout_ms),
        )?;
        self.read_line(session)
    }

    pub fn send_and_read_multiline(
        &self,
        session: &mut UsbSession,
        cmd: &str,
    ) -> Result<String, UsbTransportError> {
        let mut payload = cmd.as_bytes().to_vec();
        payload.push(b'\r');
        session.handle.write_bulk(
            self.ep_out,
            &payload,
            Duration::from_millis(self.timeout_ms),
        )?;
        self.read_multiline(session)
    }

    fn read_line(&self, session: &mut UsbSession) -> Result<String, UsbTransportError> {
        let mut out = Vec::new();
        let mut buf = [0u8; 64];
        loop {
            match session
                .handle
                .read_bulk(self.ep_in, &mut buf, Duration::from_millis(self.timeout_ms))
            {
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    if out.contains(&b'\r') {
                        break;
                    }
                }
                Err(rusb::Error::Timeout) => {
                    if !out.is_empty() {
                        break;
                    }
                    return Err(UsbTransportError::Usb(rusb::Error::Timeout));
                }
                Err(e) => return Err(UsbTransportError::Usb(e)),
            }
        }
        let s = sanitize_usb_ascii(&out);
        Ok(s.trim().trim_end_matches('\r').to_string())
    }

    fn read_multiline(&self, session: &mut UsbSession) -> Result<String, UsbTransportError> {
        let mut out = Vec::new();
        let mut buf = [0u8; 128];
        let mut had_data = false;
        loop {
            match session
                .handle
                .read_bulk(self.ep_in, &mut buf, Duration::from_millis(80))
            {
                Ok(n) => {
                    out.extend_from_slice(&buf[..n]);
                    had_data = true;
                }
                Err(rusb::Error::Timeout) => {
                    if had_data {
                        break;
                    }
                    return Err(UsbTransportError::Usb(rusb::Error::Timeout));
                }
                Err(e) => return Err(UsbTransportError::Usb(e)),
            }
        }
        let s = sanitize_usb_ascii(&out);
        Ok(s.trim().replace('\r', "\n").trim().to_string())
    }
}

fn sanitize_usb_ascii(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for b in bytes {
        if *b == b'\r' || *b == b'\n' || (32..=126).contains(b) {
            out.push(*b as char);
        }
    }
    out
}

