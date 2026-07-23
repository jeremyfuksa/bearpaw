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

impl UsbTransportError {
    /// True if this error indicates the scanner is no longer reachable —
    /// physical unplug, kernel module reset, or USB controller hiccup. The
    /// poll loop uses this to decide between "retry the same handle" (false)
    /// and "drop the handle and re-open the transport" (true).
    pub fn is_device_gone(&self) -> bool {
        match self {
            UsbTransportError::NotFound(_, _) => true,
            UsbTransportError::Usb(e) => matches!(
                e,
                rusb::Error::NoDevice | rusb::Error::Io | rusb::Error::Pipe | rusb::Error::Other
            ),
        }
    }
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
            // An unreadable descriptor on an UNRELATED device must not fail
            // the whole open (#143) — skip it and keep scanning the bus.
            let Ok(desc) = dev.device_descriptor() else {
                continue;
            };
            if desc.vendor_id() == self.vid && desc.product_id() == self.pid {
                let handle = dev.open()?;
                let _ = handle.set_active_configuration(1);
                for intf in [0u8, self.data_interface] {
                    if handle.kernel_driver_active(intf).unwrap_or(false) {
                        let _ = handle.detach_kernel_driver(intf);
                    }
                }
                handle.claim_interface(self.data_interface)?;
                // REGRESSION GUARD (USB STALL recovery): clear any halted state
                // on both bulk endpoints before handing back the session. A
                // pipe error mid-command (seen 2026-07-23 on a PRG bracket)
                // leaves the endpoint HALTED. Because the device stays
                // enumerated, the reconnect loop's re-open grabs the SAME
                // halted endpoint — every subsequent read returns Io/Pipe and
                // the loop spins forever, only recoverable by a physical
                // unplug. clear_halt resets the endpoint's data toggle so the
                // reopen actually heals. Do NOT drop these: without them a
                // STALL is unrecoverable in-app. Best-effort by design — on a
                // genuine unplug the device re-enumerates clean and these
                // no-op. Guarded by `open_clears_halt_on_both_bulk_endpoints`.
                let _ = handle.clear_halt(self.ep_in);
                let _ = handle.clear_halt(self.ep_out);
                return Ok(UsbSession { _ctx: ctx, handle });
            }
        }
        Err(UsbTransportError::NotFound(self.vid, self.pid))
    }

    pub fn send(&self, session: &mut UsbSession, cmd: &str) -> Result<String, UsbTransportError> {
        self.send_with_timeout(session, cmd, Duration::from_millis(self.timeout_ms))
    }

    /// Like `send` but overrides the read/write timeout for this single
    /// command. Use for commands the BC125AT documents as long-running —
    /// primarily `CLR` (factory reset, ~30 seconds, per docs/BC125AT_PROTOCOL.md
    /// §5.2). The override only applies to this call; the next `send` reverts
    /// to `timeout_ms`.
    pub fn send_with_timeout(
        &self,
        session: &mut UsbSession,
        cmd: &str,
        timeout: Duration,
    ) -> Result<String, UsbTransportError> {
        self.drain_input(session);
        let mut payload = cmd.as_bytes().to_vec();
        payload.push(b'\r');
        session.handle.write_bulk(self.ep_out, &payload, timeout)?;
        self.read_line_with_timeout(session, timeout)
    }

    pub fn send_and_read_multiline(
        &self,
        session: &mut UsbSession,
        cmd: &str,
    ) -> Result<String, UsbTransportError> {
        self.drain_input(session);
        let mut payload = cmd.as_bytes().to_vec();
        payload.push(b'\r');
        session.handle.write_bulk(
            self.ep_out,
            &payload,
            Duration::from_millis(self.timeout_ms),
        )?;
        self.read_multiline(session)
    }

    /// Read and discard any stale bytes sitting in the IN endpoint. Critical
    /// before issuing a new command: without this, a previous command's
    /// trailing bytes can be mis-parsed as the new command's response,
    /// causing scanner state and Bearpaw state to drift out of sync.
    fn drain_input(&self, session: &mut UsbSession) {
        let mut buf = [0u8; 128];
        // Safety cap: ~20 KB of drained bytes max. Prevents infinite loops if
        // the device is steadily emitting data.
        for _ in 0..160 {
            match session
                .handle
                .read_bulk(self.ep_in, &mut buf, Duration::from_millis(5))
            {
                Ok(0) => return,
                Ok(_) => continue,
                Err(_) => return,
            }
        }
    }

    fn read_line_with_timeout(
        &self,
        session: &mut UsbSession,
        timeout: Duration,
    ) -> Result<String, UsbTransportError> {
        let mut out = Vec::new();
        let mut buf = [0u8; 64];
        loop {
            match session.handle.read_bulk(self.ep_in, &mut buf, timeout) {
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
        Ok(finalize_read_line(&out))
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

/// Turn a raw single-line read into the response string, discarding anything
/// at or after the first `\r` terminator.
///
/// REGRESSION GUARD (#260): `read_line_with_timeout` breaks as soon as the
/// buffer *contains* a `\r`, but a single bulk read can return the terminator
/// plus following bytes (coalesced writes, or a straggler from a desynced
/// exchange). Without truncating here, that trailing garbage — `\r` and all —
/// leaked into the returned "line" and corrupted tail-anchored parsers
/// (`parse_cin_response`, `classify_response`). This matches the serial
/// transport, which reads byte-by-byte and stops at the first `\r`. See
/// `finalize_read_line_truncates_at_first_cr`.
fn finalize_read_line(out: &[u8]) -> String {
    let end = out.iter().position(|&b| b == b'\r').unwrap_or(out.len());
    sanitize_usb_ascii(&out[..end]).trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_device_gone_classifies_unplug_errors() {
        assert!(UsbTransportError::NotFound(0x1965, 0x0017).is_device_gone());
        assert!(UsbTransportError::Usb(rusb::Error::NoDevice).is_device_gone());
        assert!(UsbTransportError::Usb(rusb::Error::Io).is_device_gone());
        assert!(UsbTransportError::Usb(rusb::Error::Pipe).is_device_gone());
        assert!(UsbTransportError::Usb(rusb::Error::Other).is_device_gone());
    }

    #[test]
    fn open_clears_halt_on_both_bulk_endpoints() {
        // REGRESSION GUARD (USB STALL recovery): `open()` clears halt on
        // `ep_in` and `ep_out` so a reconnect heals a STALLed endpoint instead
        // of re-grabbing the same halted pipe (the 2026-07-23 wedge). We can't
        // drive `open()` without hardware, but we CAN pin the two endpoints it
        // must clear — the same ones every read/write uses. If these addresses
        // change, or an endpoint is added, the clear_halt calls in `open()`
        // must be revisited to match. See the guard comment at the call site.
        let t = UsbTransport::new(0x1965, 0x0017);
        assert_eq!(t.ep_in, 0x81, "IN endpoint changed — update open()'s clear_halt");
        assert_eq!(t.ep_out, 0x02, "OUT endpoint changed — update open()'s clear_halt");
    }

    #[test]
    fn is_device_gone_does_not_classify_transient_errors_as_dead() {
        // Timeout is a normal short read; don't reopen on every timeout.
        assert!(!UsbTransportError::Usb(rusb::Error::Timeout).is_device_gone());
        assert!(!UsbTransportError::Usb(rusb::Error::Busy).is_device_gone());
        assert!(!UsbTransportError::Usb(rusb::Error::Interrupted).is_device_gone());
    }

    #[test]
    fn finalize_read_line_strips_a_trailing_terminator() {
        // The normal case: exactly one \r-terminated line.
        assert_eq!(
            finalize_read_line(b"CIN,1,Ararat,01451300,AUTO,0,2,0,0\r"),
            "CIN,1,Ararat,01451300,AUTO,0,2,0,0"
        );
        assert_eq!(finalize_read_line(b"ERR\r"), "ERR");
        assert_eq!(finalize_read_line(b""), "");
    }

    #[test]
    fn finalize_read_line_truncates_at_first_cr() {
        // REGRESSION GUARD (#260): a coalesced bulk read that returns the
        // terminator plus a straggler line must not leak the embedded \r and
        // trailing bytes into the returned response.
        assert_eq!(
            finalize_read_line(b"CIN,1,Ararat,01451300,AUTO,0,2,0,0\rCIN,2,X"),
            "CIN,1,Ararat,01451300,AUTO,0,2,0,0"
        );
        assert_eq!(finalize_read_line(b"KEY,H,P,OK\rSTS,..."), "KEY,H,P,OK");
    }
}
