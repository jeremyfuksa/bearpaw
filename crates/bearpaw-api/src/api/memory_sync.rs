//! Memory sync orchestration: PRG → CIN 1..max → EPG, broadcast progress,
//! cancellable mid-loop.
//!
//! The serial and USB poll loops share this logic. They differ only in the
//! transport type, so the inner loop is generic over a "send a command, get
//! back a response string" closure and the two public entry points
//! (`run_serial`, `run_usb`) just wrap the closure to the right transport.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use serde_json::json;

use super::AppState;
use crate::protocol::parse_cin_response;
use crate::state::ChannelData;
use crate::transport::SerialTransport;
use crate::transport_usb::{UsbSession, UsbTransport};

const PRG_CMD: &str = "PRG";
const EPG_CMD: &str = "EPG";

/// Run a memory sync over the serial transport. Blocks until done or
/// `state.sync_cancel_requested` is set.
pub(super) fn run_serial(
    state: &AppState,
    transport: &SerialTransport,
    port: &mut dyn serialport::SerialPort,
    task_id: &str,
    max_channels: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    run(state, task_id, max_channels, |cmd| {
        transport.send(port, cmd).unwrap_or_default()
    })
}

/// Run a memory sync over the USB direct-bulk transport.
pub(super) fn run_usb(
    state: &AppState,
    transport: &UsbTransport,
    session: &mut UsbSession,
    task_id: &str,
    max_channels: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    run(state, task_id, max_channels, |cmd| {
        transport.send(session, cmd).unwrap_or_default()
    })
}

/// Shared orchestration. `send` should write `cmd\r` and return the trimmed
/// response, or an empty string on transport error. Errors at the transport
/// level become empty responses here; the CIN parser tolerates them and
/// just leaves the channel slot empty in the shadow state.
fn run<F>(
    state: &AppState,
    task_id: &str,
    max_channels: u16,
    mut send: F,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    F: FnMut(&str) -> String,
{
    progress(state, task_id, 0, "Entering program mode...");
    let _ = send(PRG_CMD);
    thread::sleep(Duration::from_millis(100));

    let mut channels: HashMap<u16, ChannelData> = HashMap::new();
    for idx in 1..=max_channels {
        if state.sync_cancel_requested.load(Ordering::Relaxed) {
            let _ = send(EPG_CMD);
            finish(state);
            progress(state, task_id, 0, "Sync cancelled");
            return Ok(());
        }
        let cmd = format!("CIN,{}", idx);
        let resp = send(&cmd);
        if let Some(ch) = parse_cin_response(idx, &resp) {
            channels.insert(idx, ch);
        }
        if idx.is_multiple_of(10) {
            let pct = ((idx as f64 / max_channels as f64) * 100.0) as u8;
            progress(
                state,
                task_id,
                pct,
                &format!("Syncing channel {}/{}", idx, max_channels),
            );
        }
    }

    progress(state, task_id, 100, "Exiting program mode...");
    let _ = send(EPG_CMD);
    thread::sleep(Duration::from_millis(100));

    let now = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    if let Ok(mut shadow) = state.shadow.write() {
        shadow.channels = channels;
        shadow.last_sync = now;
    }
    finish(state);
    progress(state, task_id, 100, "Sync complete");
    Ok(())
}

/// Clear the sync flags so the next request can start.
pub(super) fn finish(state: &AppState) {
    state.sync_cancel_requested.store(false, Ordering::Relaxed);
    state.sync_task_id.lock().unwrap().take();
}

fn progress(state: &AppState, task_id: &str, percent: u8, message: &str) {
    let msg = json!({
        "type": "progress",
        "task_id": task_id,
        "percent": percent,
        "message": message,
    });
    let _ = state.ws_tx.send(msg.to_string());
}
