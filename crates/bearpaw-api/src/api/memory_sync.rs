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
use crate::protocol::{classify_response, parse_cin_response, ScannerReply};
use crate::state::ChannelData;
use crate::transport::SerialTransport;
use crate::transport_usb::{UsbSession, UsbTransport};

const PRG_CMD: &str = "PRG";
const EPG_CMD: &str = "EPG";

/// Result of one command sent by the sync loop. The two transports have
/// different error types, so their wrappers collapse them into this shared
/// shape: a reply, a fatal device-gone error, or a soft/transient error.
enum SendOutcome {
    Reply(String),
    Gone,
    Soft,
}

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
        match transport.send(port, cmd) {
            Ok(s) => SendOutcome::Reply(s),
            Err(e) if e.is_device_gone() => SendOutcome::Gone,
            Err(_) => SendOutcome::Soft,
        }
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
        match transport.send(session, cmd) {
            Ok(s) => SendOutcome::Reply(s),
            Err(e) if e.is_device_gone() => SendOutcome::Gone,
            Err(_) => SendOutcome::Soft,
        }
    })
}

/// Shared orchestration: `PRG` → `CIN,1..max` → `EPG`.
///
/// Error handling (see issue #134):
/// - `PRG` is verified; if the scanner refuses it (`NG`/`ERR`/no reply) the
///   sync aborts with an error instead of walking 500 CINs that all fail.
/// - A device-gone error at any point aborts with an error so the poll loop
///   marks the session dead (rather than burning ~500 timeouts).
/// - The cached channel map is replaced ONLY after a clean, complete walk.
///   A partial walk (disconnect, PRG refusal) leaves the previous cache
///   intact — it must never be overwritten with partial/empty data.
///
/// On any hard failure this returns `Err`; the caller (`run_serial`/`run_usb`
/// call sites in `poll.rs`) runs `finish()` and broadcasts "Sync failed".
/// The cancel and success paths return `Ok` and call `finish()` themselves.
fn run<F>(
    state: &AppState,
    task_id: &str,
    max_channels: u16,
    mut send: F,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    F: FnMut(&str) -> SendOutcome,
{
    progress(state, task_id, 0, "Entering program mode...");
    // Verify PRG actually took. A refused PRG (scanner in a menu → `PRG,NG`)
    // would otherwise make every CIN reply `NG`, and the old code cached 500
    // phantom "NG" channels over the real data.
    match send(PRG_CMD) {
        SendOutcome::Reply(resp) => {
            if !matches!(classify_response(&resp), ScannerReply::Ok) {
                return Err(format!("scanner refused PRG: {:?}", resp.trim()).into());
            }
        }
        SendOutcome::Gone => return Err("device disconnected entering program mode".into()),
        SendOutcome::Soft => return Err("no response to PRG".into()),
    }
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
        match send(&cmd) {
            SendOutcome::Reply(resp) => {
                if let Some(ch) = parse_cin_response(idx, &resp) {
                    channels.insert(idx, ch);
                }
            }
            // Device unplugged mid-walk: bail WITHOUT touching the cache so the
            // previously-synced channels survive. The poll loop will mark the
            // session dead and reconnect.
            SendOutcome::Gone => {
                return Err(format!("device disconnected during sync at channel {}", idx).into());
            }
            // Transient error on a single channel: skip it and keep going.
            SendOutcome::Soft => {}
        }
        if idx.is_multiple_of(10) {
            // Cap in-progress percent below 100 so the ONLY percent-100 message
            // is the final "Sync complete" after the cache write — the frontend
            // keys completion on percent>=100 (see #137).
            let pct = (((idx as f64 / max_channels as f64) * 100.0) as u8).min(99);
            progress(
                state,
                task_id,
                pct,
                &format!("Syncing channel {}/{}", idx, max_channels),
            );
        }
    }

    progress(state, task_id, 99, "Exiting program mode...");
    let _ = send(EPG_CMD);
    thread::sleep(Duration::from_millis(100));

    let now = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    // Clean full walk completed — safe to replace the cache now.
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
