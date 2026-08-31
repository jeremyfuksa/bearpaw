//! Blocking serial poll loop: drain control commands, then STS -> LiveState -> broadcast.

use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use serde_json::json;
use tracing::{debug, error, info, warn};

use crate::api::track_analytics_transition;
use crate::api::AppState;
use crate::api::ControlCommand;
use crate::protocol::{
    livestate_from_frames, parse_glg_response, parse_mdl_response, parse_pwr_response,
    parse_sts_frame, PwrFrame,
};
use crate::state::{LiveState, ScannerMode};
use crate::transport::SerialTransport;
use crate::transport_usb::UsbTransport;

const POLL_INTERVAL_MS: u64 = 200;
/// Send PWR every Nth tick (200ms × 3 = ~600ms cadence).
const PWR_INTERVAL_TICKS: u32 = 3;
/// First reconnect attempt fires this many ms after a disconnect is
/// detected. Subsequent attempts back off via `next_backoff` up to
/// `RECONNECT_BACKOFF_MAX_MS`.
const RECONNECT_BACKOFF_INITIAL_MS: u64 = 500;
/// Cap on the reconnect backoff. Past this point the poll loop retries on
/// a fixed cadence so a forgotten unplugged scanner doesn't tie up the
/// USB subsystem.
const RECONNECT_BACKOFF_MAX_MS: u64 = 5_000;
const STS_CMD: &str = "STS";
const GLG_CMD: &str = "GLG";
const PWR_CMD: &str = "PWR";
const MDL_CMD: &str = "MDL";
// pub(crate) so the command-path tests assert against the SAME constants the
// poll loop sends. A test that hardcoded "KEY,H,P" would keep passing if the
// loop started sending something else.
pub(crate) const KEY_HOLD: &str = "KEY,H,P";
pub(crate) const KEY_SCAN: &str = "KEY,S,P";

/// Spawn a blocking thread: open serial, process command channel + STS poll, broadcast state.
pub fn spawn_poll_loop(
    state: AppState,
    port_name: String,
    baud: u32,
    assert_dtr: bool,
    cmd_rx: std::sync::mpsc::Receiver<ControlCommand>,
) {
    thread::spawn(move || {
        // catch_unwind (#143): a panic inside the poll loop (e.g. a poisoned
        // mutex unwrap) unwinds the thread WITHOUT hitting the Err branch —
        // the UI stayed "connected" forever while every command timed out.
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            run_poll_loop(state.clone(), &port_name, baud, assert_dtr, cmd_rx)
        }));
        let message = match result {
            Ok(Ok(())) => return,
            Ok(Err(e)) => e.to_string(),
            Err(panic) => {
                let text = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_else(|| "poll thread panicked".to_string());
                format!("poll thread panicked: {}", text)
            }
        };
        error!("Poll loop exited: {}", message);
        if let Ok(mut d) = state.device.write() {
            d.connection_status = "disconnected".to_string();
            d.diagnostic_message = Some(message);
        }
    });
}

fn run_poll_loop(
    state: AppState,
    port_name: &str,
    baud: u32,
    assert_dtr: bool,
    cmd_rx: std::sync::mpsc::Receiver<ControlCommand>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some((vid, pid)) = parse_usb_target(port_name) {
        return run_poll_loop_usb(state, vid, pid, cmd_rx);
    }

    let transport = SerialTransport::new(port_name, baud).with_dtr_on_open(assert_dtr);

    // Loop-spanning state. Preserved across reconnects.
    let mut commanded_mode = ScannerMode::Scan;
    let mut tick: u32 = 0;
    let mut poll_state = PollState::new();
    let mut reconnect_backoff = Duration::from_millis(RECONNECT_BACKOFF_INITIAL_MS);

    loop {
        let mut port = match transport.open() {
            Ok(p) => p,
            Err(e) => {
                // REGRESSION GUARD (#513): a failed FIRST open must retry like
                // any other, not kill the thread. This used to `return Err` on
                // `first_open`, so starting Bearpaw while the scanner was
                // unplugged -- or wedged -- left the process serving a
                // permanently disconnected API, recoverable only by relaunching.
                // A device that vanished MID-session was handled correctly; the
                // very first open was the one path with no retry.
                //
                // Nothing is lost by retrying. The old fatal path set
                // connection_status and diagnostic_message via the caller;
                // `mark_disconnected` sets both, plus `diagnostic_code` and the
                // liveState `stale` flag the frontend keys its disconnect UI
                // on. So the failure is MORE visible now, and it heals itself
                // when the scanner appears.
                mark_disconnected(&state, &format!("serial open failed: {}", e));
                thread::sleep(reconnect_backoff);
                reconnect_backoff = next_backoff(reconnect_backoff);
                continue;
            }
        };
        reconnect_backoff = Duration::from_millis(RECONNECT_BACKOFF_INITIAL_MS);

        info!("Serial opened: {} @ {} baud", port_name, baud);
        mark_port_opened(&state, port_name);

        // Device info: model from MDL (with retry because some scanners can return
        // stale command echoes immediately after connection).
        let mut mdl_set = false;
        let mut device_gone = false;
        for attempt in 1..=5 {
            match transport.send(port.as_mut(), MDL_CMD) {
                Ok(mdl_resp) => {
                    if crate::protocol::parse_mdl_response(&mdl_resp).is_some() {
                        update_device_info_from_mdl(&state, &mdl_resp, port_name);
                        mdl_set = true;
                        break;
                    }
                    warn!(
                        "Invalid MDL response on serial attempt {}: {}",
                        attempt,
                        mdl_resp.trim()
                    );
                }
                Err(err) => {
                    warn!("MDL read failed on serial attempt {}: {}", attempt, err);
                    if err.is_device_gone() {
                        device_gone = true;
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(120));
        }
        if !mdl_set {
            warn!("Unable to read valid MDL response after retries (serial)");
            // REGRESSION GUARD (`a_vanished_device_is_never_announced_as_connected`):
            // announce a connect ONLY if the device is still there.
            //
            // The port being open makes "connected with no model" the honest
            // status for a scanner whose MDL is merely garbled -- that is why
            // this fallback exists (#539). It is the wrong answer when the
            // retry loop broke out because the device VANISHED: that branch
            // would tell the frontend the scanner arrived, moments before the
            // poll loop marks it disconnected again. Since #551 this also
            // BROADCASTS, so a wedged link (the documented USB STALL case)
            // becomes a connect/disconnect storm at reconnect-backoff rate.
            if should_announce_connect(mdl_set, device_gone) {
                mark_connected_without_model(&state, port_name);
            }
        }

        // Initial volume query. Writes to `state.live.volume` so the first
        // poll tick (and the UI) sees the real scanner volume rather than 0.
        if let Ok(vol_resp) = transport.send(port.as_mut(), "VOL") {
            if let Some(v) = parse_vol_response(&vol_resp) {
                if let Ok(mut live) = state.live.write() {
                    live.volume = v;
                }
            }
        }

        let mut session_dead = false;
        while !session_dead {
            // Drain control commands (hold, scan, direct, start sync)
            while let Ok(cmd) = cmd_rx.try_recv() {
                match cmd {
                    ControlCommand::Hold { reply, deadline } => {
                        // #139: don't press keys the caller gave up on.
                        if !super::control::should_execute_queued(KEY_HOLD, deadline) {
                            warn!("discarding expired queued Hold");
                            if let Some(r) = reply {
                                let _ = r.send(Err("command_expired".to_string()));
                            }
                            continue;
                        }
                        let response = transport.send(port.as_mut(), KEY_HOLD).map_err(|e| {
                            if e.is_device_gone() {
                                session_dead = true;
                            }
                            e.to_string()
                        });
                        if response.is_ok() {
                            commanded_mode = ScannerMode::Hold;
                        }
                        if let Some(r) = reply {
                            let _ = r.send(response);
                        }
                    }
                    ControlCommand::Scan { reply, deadline } => {
                        if !super::control::should_execute_queued(KEY_SCAN, deadline) {
                            warn!("discarding expired queued Scan");
                            if let Some(r) = reply {
                                let _ = r.send(Err("command_expired".to_string()));
                            }
                            continue;
                        }
                        let response = transport.send(port.as_mut(), KEY_SCAN).map_err(|e| {
                            if e.is_device_gone() {
                                session_dead = true;
                            }
                            e.to_string()
                        });
                        if response.is_ok() {
                            commanded_mode = ScannerMode::Scan;
                        }
                        if let Some(r) = reply {
                            let _ = r.send(response);
                        }
                    }
                    ControlCommand::StartSync {
                        task_id,
                        max_channels,
                    } => {
                        if let Err(e) = super::memory_sync::run_serial(
                            &state,
                            &transport,
                            port.as_mut(),
                            &task_id,
                            max_channels,
                        ) {
                            warn!("Memory sync failed: {}", e);
                            super::memory_sync::finish(&state);
                            send_progress(&state, &task_id, 0, &format!("Sync failed: {}", e));
                        }
                    }
                    ControlCommand::Raw {
                        command,
                        multiline,
                        reply,
                        deadline,
                    } => {
                        // #139: the HTTP caller gave up on this command long
                        // ago — executing it now would surprise the user (or,
                        // for a stale PRG, strand the scanner in Remote Mode).
                        if !super::control::should_execute_queued(&command, deadline) {
                            warn!(command = %command, "discarding expired queued command");
                            let _ = reply.send(Err("command_expired".to_string()));
                            continue;
                        }
                        let response = if multiline {
                            transport
                                .send_and_read_multiline(port.as_mut(), &command)
                                .map_err(|e| {
                                    if e.is_device_gone() {
                                        session_dead = true;
                                    }
                                    e.to_string()
                                })
                        } else {
                            transport.send(port.as_mut(), &command).map_err(|e| {
                                if e.is_device_gone() {
                                    session_dead = true;
                                }
                                e.to_string()
                            })
                        };
                        let _ = reply.send(response);
                    }
                }
                if session_dead {
                    break;
                }
            }
            if session_dead {
                break;
            }

            // When the scanner is in program mode (PRG entered via an API
            // handler), the operational commands STS/GLG/PWR will get NG replies
            // and their bytes will collide with the bracket's subsequent CIN/SCG
            // reads on the bulk endpoint. Skip the live-state fetch entirely and
            // just keep draining the command channel until EPG runs.
            if state.program_mode_active.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                continue;
            }

            let sts_resp = match transport.send_and_read_multiline(port.as_mut(), STS_CMD) {
                Ok(r) => Some(r),
                Err(e) => {
                    if e.is_device_gone() {
                        session_dead = true;
                    } else {
                        warn!("STS read error: {}", e);
                    }
                    None
                }
            };
            if session_dead {
                break;
            }

            let glg_resp = match transport.send(port.as_mut(), GLG_CMD) {
                Ok(r) => Some(r),
                Err(e) => {
                    if e.is_device_gone() {
                        session_dead = true;
                    } else {
                        warn!("GLG read error: {}", e);
                    }
                    None
                }
            };
            if session_dead {
                break;
            }

            let pwr_resp = if tick.is_multiple_of(PWR_INTERVAL_TICKS) {
                match transport.send(port.as_mut(), PWR_CMD) {
                    Ok(r) => Some(r),
                    Err(e) => {
                        if e.is_device_gone() {
                            session_dead = true;
                        } else {
                            warn!("PWR read error: {}", e);
                        }
                        None
                    }
                }
            } else {
                None
            };
            if session_dead {
                break;
            }
            tick = tick.wrapping_add(1);

            process_poll_tick(
                &state,
                &mut poll_state,
                commanded_mode,
                sts_resp.as_deref(),
                glg_resp.as_deref(),
                pwr_resp.as_deref(),
                "serial",
            );

            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }

        warn!(
            "Serial session ended for {} — scanner disconnected. Will attempt to reconnect.",
            port_name
        );
        mark_disconnected(&state, "scanner disconnected");
        thread::sleep(reconnect_backoff);
        reconnect_backoff = next_backoff(reconnect_backoff);
    }
}

fn run_poll_loop_usb(
    state: AppState,
    vid: u16,
    pid: u16,
    cmd_rx: std::sync::mpsc::Receiver<ControlCommand>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let transport = UsbTransport::new(vid, pid);
    let port_label = format!("usb:{:04x}:{:04x}", vid, pid);

    // Loop-spanning state. Preserved across reconnects so the user's
    // commanded mode survives a brief unplug/replug. Volume lives in
    // `state.live.volume` — that's the single source of truth for both
    // poll-initiated reads and user-driven `set_volume` writes.
    let mut commanded_mode = ScannerMode::Scan;
    let mut tick: u32 = 0;
    let mut poll_state = PollState::new();
    let mut reconnect_backoff = Duration::from_millis(RECONNECT_BACKOFF_INITIAL_MS);

    // Outer reconnect loop. Loops forever, opening and re-opening the session
    // as the scanner appears and disappears -- including before it has ever
    // appeared (#513).
    loop {
        let mut session = match transport.open() {
            Ok(s) => s,
            Err(e) => {
                // REGRESSION GUARD (#513): see the matching comment in
                // `run_poll_loop`. A failed FIRST open retries like any other.
                // Observed on macOS: with the scanner off the bus, this logged
                // `Poll loop exited: usb device not found` once and the thread
                // ended, so plugging the scanner back in did nothing until the
                // app was relaunched.
                mark_disconnected(&state, &format!("USB open failed: {}", e));
                thread::sleep(reconnect_backoff);
                reconnect_backoff = next_backoff(reconnect_backoff);
                continue;
            }
        };
        reconnect_backoff = Duration::from_millis(RECONNECT_BACKOFF_INITIAL_MS);

        info!("USB opened: {:04x}:{:04x}", vid, pid);
        mark_port_opened(&state, &port_label);

        let mut mdl_set = false;
        let mut device_gone = false;
        for attempt in 1..=5 {
            match transport.send(&mut session, MDL_CMD) {
                Ok(mdl_resp) => {
                    if crate::protocol::parse_mdl_response(&mdl_resp).is_some() {
                        update_device_info_from_mdl(&state, &mdl_resp, &port_label);
                        mdl_set = true;
                        break;
                    }
                    warn!(
                        "Invalid MDL response on usb attempt {}: {}",
                        attempt,
                        mdl_resp.trim()
                    );
                }
                Err(err) => {
                    warn!("MDL read failed on usb attempt {}: {}", attempt, err);
                    if err.is_device_gone() {
                        device_gone = true;
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(120));
        }
        if !mdl_set {
            warn!("Unable to read valid MDL response after retries (usb)");
            // See the serial path: a device that vanished must not be
            // announced as connected. This transport is the one the USB STALL
            // wedge actually happens on.
            if should_announce_connect(mdl_set, device_gone) {
                mark_connected_without_model(&state, &port_label);
            }
        }

        // Initial volume query. Writes to `state.live.volume` so the first
        // poll tick (and the UI) sees the real scanner volume rather than 0.
        if let Ok(vol_resp) = transport.send(&mut session, "VOL") {
            if let Some(v) = parse_vol_response(&vol_resp) {
                if let Ok(mut live) = state.live.write() {
                    live.volume = v;
                }
            }
        }

        // Inner per-session loop. Breaks out (to the outer reconnect loop)
        // the moment any transport call signals the device is gone.
        let mut session_dead = false;
        while !session_dead {
            while let Ok(cmd) = cmd_rx.try_recv() {
                match cmd {
                    ControlCommand::Hold { reply, deadline } => {
                        // #139: see the serial drain.
                        if !super::control::should_execute_queued(KEY_HOLD, deadline) {
                            warn!("discarding expired queued Hold");
                            if let Some(r) = reply {
                                let _ = r.send(Err("command_expired".to_string()));
                            }
                            continue;
                        }
                        let response = transport.send(&mut session, KEY_HOLD).map_err(|e| {
                            if e.is_device_gone() {
                                session_dead = true;
                            }
                            e.to_string()
                        });
                        if response.is_ok() {
                            commanded_mode = ScannerMode::Hold;
                        }
                        if let Some(r) = reply {
                            let _ = r.send(response);
                        }
                    }
                    ControlCommand::Scan { reply, deadline } => {
                        if !super::control::should_execute_queued(KEY_SCAN, deadline) {
                            warn!("discarding expired queued Scan");
                            if let Some(r) = reply {
                                let _ = r.send(Err("command_expired".to_string()));
                            }
                            continue;
                        }
                        let response = transport.send(&mut session, KEY_SCAN).map_err(|e| {
                            if e.is_device_gone() {
                                session_dead = true;
                            }
                            e.to_string()
                        });
                        if response.is_ok() {
                            commanded_mode = ScannerMode::Scan;
                        }
                        if let Some(r) = reply {
                            let _ = r.send(response);
                        }
                    }
                    ControlCommand::StartSync {
                        task_id,
                        max_channels,
                    } => {
                        if let Err(e) = super::memory_sync::run_usb(
                            &state,
                            &transport,
                            &mut session,
                            &task_id,
                            max_channels,
                        ) {
                            warn!("Memory sync failed: {}", e);
                            super::memory_sync::finish(&state);
                            send_progress(&state, &task_id, 0, &format!("Sync failed: {}", e));
                        }
                    }
                    ControlCommand::Raw {
                        command,
                        multiline,
                        reply,
                        deadline,
                    } => {
                        // #139: see the serial drain — expired commands are
                        // discarded instead of executing arbitrarily late.
                        if !super::control::should_execute_queued(&command, deadline) {
                            warn!(command = %command, "discarding expired queued command");
                            let _ = reply.send(Err("command_expired".to_string()));
                            continue;
                        }
                        let response = if multiline {
                            transport
                                .send_and_read_multiline(&mut session, &command)
                                .map_err(|e| {
                                    if e.is_device_gone() {
                                        session_dead = true;
                                    }
                                    e.to_string()
                                })
                        } else {
                            transport.send(&mut session, &command).map_err(|e| {
                                if e.is_device_gone() {
                                    session_dead = true;
                                }
                                e.to_string()
                            })
                        };
                        let _ = reply.send(response);
                    }
                }
                if session_dead {
                    break;
                }
            }
            if session_dead {
                break;
            }

            // Skip live-state fetch while scanner is in program mode (see
            // serial-path comment for rationale).
            if state.program_mode_active.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                continue;
            }

            let sts_resp = match transport.send_and_read_multiline(&mut session, STS_CMD) {
                Ok(r) => Some(r),
                Err(e) => {
                    if e.is_device_gone() {
                        session_dead = true;
                    } else {
                        warn!("STS read error (usb): {}", e);
                    }
                    None
                }
            };
            if session_dead {
                break;
            }

            let glg_resp = match transport.send(&mut session, GLG_CMD) {
                Ok(r) => Some(r),
                Err(e) => {
                    if e.is_device_gone() {
                        session_dead = true;
                    } else {
                        warn!("GLG read error (usb): {}", e);
                    }
                    None
                }
            };
            if session_dead {
                break;
            }

            let pwr_resp = if tick.is_multiple_of(PWR_INTERVAL_TICKS) {
                match transport.send(&mut session, PWR_CMD) {
                    Ok(r) => Some(r),
                    Err(e) => {
                        if e.is_device_gone() {
                            session_dead = true;
                        } else {
                            warn!("PWR read error (usb): {}", e);
                        }
                        None
                    }
                }
            } else {
                None
            };
            if session_dead {
                break;
            }
            tick = tick.wrapping_add(1);

            if !process_poll_tick(
                &state,
                &mut poll_state,
                commanded_mode,
                sts_resp.as_deref(),
                glg_resp.as_deref(),
                pwr_resp.as_deref(),
                "usb",
            ) {
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                continue;
            }
            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }

        // Session dropped here. Log once (not per failed poll) and let the
        // outer loop reopen with backoff.
        warn!(
            "USB session ended for {} — scanner disconnected. Will attempt to reconnect.",
            port_label
        );
        mark_disconnected(&state, "scanner disconnected");
        thread::sleep(reconnect_backoff);
        reconnect_backoff = next_backoff(reconnect_backoff);
    }
}

/// Record that a port opened, WITHOUT claiming the scanner is connected.
///
/// REGRESSION GUARD (#539, `opening_a_port_does_not_claim_connected`): this
/// function must never set `connection_status`. It used to, inline in both
/// poll loops, and that made the connect-side broadcast in
/// `update_device_info_from_mdl` dead code -- the flag it gates on asks whether
/// the status was already "connected", which this write guaranteed. The
/// user-visible result was that a replug never told the frontend the scanner
/// came back, so the UI read "disconnected" for the rest of the session.
///
/// The status now flips when the `MDL` reply lands, so "connected" means "we
/// know which radio this is" rather than "a file descriptor opened" -- which is
/// also what the channel-cache capacity guard needs, since it cannot run
/// before the model is known.
///
/// Extracted from the two loops rather than left inline SO THAT it is
/// testable: a guard that rebuilds this sequence by hand passes whether or not
/// the loops still set the status.
fn mark_port_opened(state: &AppState, port_label: &str) {
    if let Ok(mut d) = state.device.write() {
        d.port = Some(port_label.to_string());
        d.clear_connection_diagnostic();
    }
}

/// After the MDL retries gave up, should the frontend be told a scanner is here?
///
/// Extracted from both poll loops SO THAT it can be tested: `run_poll_loop` has
/// no fake transport, so a guard written against the loop cannot exist, and a
/// guard written against `mark_connected_without_model` alone cannot see which
/// branch reached it -- which is exactly how this shipped wrong.
///
/// Yes when the scanner answered nothing intelligible but is still there: the
/// port is open, the loop is about to poll it, and "connected, model unknown"
/// is the honest report (#539).
///
/// No when the retries ended because the device VANISHED. Announcing a connect
/// there tells the frontend the scanner arrived moments before the poll loop
/// marks it gone again -- and since #551 that announcement is broadcast, so a
/// wedged link turns into a connect/disconnect storm at reconnect-backoff rate.
///
/// Test: `a_vanished_device_is_never_announced_as_connected`.
fn should_announce_connect(mdl_set: bool, device_gone: bool) -> bool {
    !mdl_set && !device_gone
}

/// Report connected when the port is open but `MDL` never answered.
///
/// The #539 fix moved the "connected" flip to the MDL chokepoint so the
/// connect edge is a real edge. That leaves the five-failed-attempts path with
/// no one to set the status, and the poll loop is about to start polling
/// regardless -- so a scanner whose MDL is garbled would read as permanently
/// disconnected. Connected with no model is the honest answer there, and it is
/// what the code did before #539.
///
/// Broadcasts on the edge, for the same reason the MDL path does.
///
/// Test: `an_unidentified_scanner_still_reports_connected`.
fn mark_connected_without_model(state: &AppState, port_label: &str) {
    let mut changed = false;
    if let Ok(mut d) = state.device.write() {
        if d.connection_status != "connected" {
            d.connection_status = "connected".to_string();
            changed = true;
        }
        d.port = Some(port_label.to_string());
    }
    if changed {
        broadcast_device_info(state);
    }
}

/// Flip DeviceInfo into the disconnected state with a diagnostic message.
/// Idempotent — safe to call from each reconnect-loop iteration even if
/// the previous iteration already marked the device disconnected.
///
/// Broadcasts the new state over the WebSocket so the frontend's
/// connection indicator updates immediately. Without this, the indicator
/// stays green until the next REST `/device/info` fetch happens to land,
/// which is rarely polled (frontend asks once on mount).
fn mark_disconnected(state: &AppState, reason: &str) {
    let mut changed = false;
    if let Ok(mut d) = state.device.write() {
        if d.connection_status != "disconnected" {
            d.connection_status = "disconnected".to_string();
            changed = true;
        }
        d.diagnostic_code = Some("scanner_disconnected".to_string());
        d.diagnostic_message = Some(reason.to_string());
    }
    // Also flag liveState as stale so the frontend's "stale" UI fires
    // (the frontend treats `stale: true` as a disconnect indicator).
    if let Ok(mut live) = state.live.write() {
        live.stale = true;
    }

    // Only broadcast on edge transitions. The reconnect loop calls this
    // every iteration during a long disconnect; we don't want to spam the
    // WS with identical messages.
    if changed {
        broadcast_device_info(state);
        broadcast_state_stale(state);
    }
}

/// Push the current DeviceInfo over the WebSocket. The frontend listens
/// for `{type: "device_info", data: ...}` and updates its store.
fn broadcast_device_info(state: &AppState) {
    let info = match state.device.read() {
        Ok(d) => d.clone(),
        Err(_) => return,
    };
    let msg = json!({
        "type": "device_info",
        "data": info,
    });
    let _ = state.ws_tx.send(msg.to_string());
}

/// Fire the `state_stale` event the frontend's WS handler watches for.
/// Belt-and-suspenders with the `device_info` broadcast above — the
/// frontend's `useConnectionStatus` checks both signals independently.
fn broadcast_state_stale(state: &AppState) {
    let timestamp = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    let msg = json!({
        "type": "event",
        "event": "state_stale",
        "timestamp": timestamp,
    });
    let _ = state.ws_tx.send(msg.to_string());
}

/// Double the reconnect delay, capped at RECONNECT_BACKOFF_MAX_MS, so a
/// persistently-unplugged scanner doesn't spin the USB subsystem.
fn next_backoff(current: Duration) -> Duration {
    let doubled_ms = current
        .as_millis()
        .saturating_mul(2)
        .min(RECONNECT_BACKOFF_MAX_MS as u128) as u64;
    Duration::from_millis(doubled_ms)
}

/// Record the model reported by `MDL` and flip the device to `connected`.
///
/// REGRESSION GUARD (unsupported-model gate): this is the single chokepoint
/// where every connection path -- autodetect, explicit `device.port`, and
/// explicit `usb_vid`/`usb_pid` -- records a model. The allowlist check lives
/// HERE rather than in `config::resolve_serial_port` because the two explicit
/// config paths short-circuit discovery entirely and never run an `MDL` probe
/// (#389). Moving this check back to discovery-time reopens that hole, and the
/// macOS setup documented in `CLAUDE.md` *is* the explicit-config path, so the
/// hole would be the default posture rather than an edge case.
///
/// An unsupported scanner is allowed to connect but is flagged with the
/// `unsupported_model` diagnostic. It is deliberately not refused: an explicit
/// `device.port` is the user overriding detection on purpose, and a hard
/// refusal would remove the only escape hatch for a compatible-but-unlisted
/// model. The diagnostic is what the UI surfaces instead.
///
/// Tests: `unsupported_model_sets_diagnostic_and_keeps_connection`,
/// `supported_model_clears_diagnostic`.
fn update_device_info_from_mdl(state: &AppState, mdl_resp: &str, port_label: &str) {
    if let Some(model) = parse_mdl_response(mdl_resp) {
        let supported = crate::config::is_supported_model(&model);
        // Resolve the memory model here, at the one function every connection
        // path funnels through (see #396). Falls back to the BC125AT family for
        // an unrecognised model, matching the "connect with a diagnostic rather
        // than refuse" posture -- see ScannerCapabilities::for_model_or_default.
        let caps = crate::protocol::capabilities::ScannerCapabilities::for_model_or_default(&model);
        if !supported {
            // warn! rather than debug!: this is the one outcome where the user
            // has done nothing wrong and needs to know why memory operations
            // may behave oddly. Mirrors config::probe_mdl_on_port's warning on
            // the autodetect path.
            warn!(
                "Scanner on {} reports model {:?}, which Bearpaw does not support. \
                 Supported models: {}. Bearpaw targets the conventional analog 125/126 \
                 family; channel-memory operations assume {} \
                 and may misbehave on other hardware. Please report this model at \
                 https://github.com/jeremyfuksa/bearpaw/issues so support can be considered.",
                port_label,
                model,
                crate::config::supported_models_list(),
                caps.capacity_summary()
            );
        }
        let mut transitioned_to_connected = false;
        if let Ok(mut d) = state.device.write() {
            if d.connection_status != "connected" {
                transitioned_to_connected = true;
            }
            d.model = Some(model.clone());
            d.capabilities = Some(caps);
            d.port = Some(port_label.to_string());
            d.connection_status = "connected".to_string();
            if supported {
                d.clear_connection_diagnostic();
            } else {
                d.diagnostic_code = Some("unsupported_model".to_string());
                d.diagnostic_message = Some(format!(
                    "This scanner reports model {}, which Bearpaw does not support yet. \
                     Supported models: {}. Channel memory operations assume {} \
                     and may not work correctly on this hardware.",
                    model,
                    crate::config::supported_models_list(),
                    caps.capacity_summary()
                ));
            }
        }
        // Cache the USB serial number so autodetect can prefer this
        // physical unit on reconnect. Best-effort: skipped silently for
        // the `usb:` pseudo-target (macOS no-CDC-bind path) and any port
        // without a USB serial number reported.
        if !port_label.starts_with("usb:") {
            if let Some(serial) = crate::config::usb_serial_for_port(port_label) {
                crate::config::save_last_scanner_cache(&serial, port_label, &model);
            }
        }
        // Resolve WHICH radio this is before touching its cached memory (#414).
        //
        // Order matters and is not arbitrary: the profile has to exist before
        // the cache is keyed on it, and the pre-#414 rows have to be adopted
        // before the load runs, or the first launch after upgrading finds an
        // empty profile and re-syncs for nothing.
        //
        // A serial the transport cannot read is passed through as None rather
        // than guessed at -- `match_index` records it explicitly, so a scanner
        // whose serial failed to read gets its own stable profile instead of
        // colliding with a real one.
        let usb_serial = crate::config::usb_serial_for_port(port_label);
        let previous_id = state.device.read().ok().and_then(|d| d.scanner_id.clone());
        let resolved = super::scanner_registry::resolve_scanner(
            &state.preferences_db_path,
            &model,
            usb_serial.as_deref(),
        );
        if let Ok(mut d) = state.device.write() {
            d.scanner_id = resolved.clone();
            if d.serial_number.is_none() {
                d.serial_number = usb_serial.clone();
            }
        }

        // REGRESSION GUARD (`a_different_radio_does_not_inherit_the_last_ones_channels`):
        // a DIFFERENT scanner on the same port means the shadow belongs to the
        // radio that just left. Clear it.
        //
        // Nothing else does. `mark_disconnected` touches DeviceInfo and
        // `live.stale` only, and `load_channel_cache`'s "a populated shadow
        // wins" rule -- correct for a reconnect of the SAME radio -- then
        // declines to load, so the capacity guard never sees the stale map
        // either. The next flush writes that map under the NEW scanner_id,
        // and `save_channels` DELETEs the target profile's rows before
        // inserting. Reproduced: a BC75XLT's 300 channels landed in a
        // BC125AT's profile.
        //
        // Reachable wherever two units share a port string across a replug --
        // two CP210x radios both landing on /dev/ttyUSB0, say. Same-capacity
        // units are the worst case, because the capacity guard cannot catch it
        // on the next launch either: 300 == 300.
        //
        // Only on a CHANGE. `previous_id.is_some()` keeps the first connect of
        // a session from wiping channels a handler read off the wire before any
        // MDL landed.
        if previous_id.is_some() && previous_id != resolved {
            if let Ok(mut shadow) = state.shadow.write() {
                shadow.channels.clear();
                shadow.last_sync = 0.0;
            }
            info!("scanner changed; cleared the previous radio's channel memory");
        }
        if let Some(id) = resolved.as_deref() {
            super::channel_cache::adopt_placeholder_cache(
                &state.preferences_db_path,
                id,
                caps.channel_count,
            );
        }

        // Adopt cached channel memory now that we know WHICH radio this is.
        //
        // REGRESSION GUARD (`a_cache_from_a_larger_scanner_is_discarded`,
        // `a_cache_from_a_smaller_scanner_is_discarded`,
        // `a_matching_cache_is_loaded_on_connect`,
        // `a_reconnect_does_not_overwrite_live_channels`): this must run HERE
        // and nowhere earlier. The capacity guard compares the cache against
        // `channel_count`, and before the `MDL` reply is parsed there is no
        // model -- `AppState::capabilities()` answers with the BC125AT default
        // of 500, which would wave a 500-row cache onto a BC75XLT.
        //
        // Use the local `caps`, never `state.capabilities()`: that takes
        // `device.read()`, and this function held `device.write()` until the
        // block above closed. Same-thread read-while-write on a std `RwLock`
        // deadlocks.
        //
        // Deliberately NOT gated on `transitioned_to_connected`. That flag is
        // always false in production -- both poll loops set
        // `connection_status = "connected"` when the port opens, before the
        // MDL probe -- so gating on it would pass every unit test and never
        // fire on hardware. See #539. `load_channel_cache` does its own
        // gating on an empty shadow, which is the honest condition anyway:
        // load only when there is nothing live to lose.
        let adopted = super::channel_cache::load_channel_cache(state, caps.channel_count);
        if adopted > 0 {
            info!(
                "Adopted {} cached channels for {}; no memory sync needed to \
                 render the channel list",
                adopted, model
            );
        }
        // Push the new state to the frontend so its indicator flips back
        // to green without waiting for a REST poll. Only broadcast on
        // edge transitions so we don't spam the WS with identical messages
        // on every poll tick.
        if transitioned_to_connected {
            broadcast_device_info(state);
        }
    } else {
        warn!("Invalid MDL response ignored: {}", mdl_resp.trim());
    }
}

/// Mutable per-loop state carried across poll ticks.
struct PollState {
    /// Last successfully parsed PWR frame — carried forward on ticks that
    /// don't poll PWR so RSSI stays continuous rather than flickering to 0.
    last_pwr: Option<PwrFrame>,
    /// Count of STS responses that failed to parse (truncation, garbage).
    /// Logged periodically — these are normal under the firmware's documented
    /// "occasionally drops or truncates STS" behavior.
    dropped_sts: u64,
    /// Consecutive ticks where EVERY parse failed (#149): the port is open
    /// but the scanner isn't producing anything usable. After
    /// STALE_AFTER_FAILED_TICKS of this, the display is marked stale so the
    /// UI stops showing a frozen frequency as live.
    consecutive_failed_ticks: u32,
    /// True once the parse-failure staleness has been broadcast, so a long
    /// outage doesn't spam identical state_stale events.
    stale_broadcast: bool,
}

impl PollState {
    fn new() -> Self {
        Self {
            last_pwr: None,
            dropped_sts: 0,
            consecutive_failed_ticks: 0,
            stale_broadcast: false,
        }
    }
}

/// Ticks of all-parse-failure before the live display is marked stale
/// (#149). 15 ticks x 200ms = ~3s — long enough to ride out the firmware's
/// documented occasional STS truncation, short enough that a wedged scanner
/// doesn't show a frozen "live" frequency for minutes.
const STALE_AFTER_FAILED_TICKS: u32 = 15;

/// One poll tick's worth of parsed responses, assembled into LiveState.
///
/// Returns `false` if all three parses failed and nothing should be broadcast.
fn process_poll_tick(
    state: &AppState,
    poll: &mut PollState,
    commanded_mode: ScannerMode,
    sts_resp: Option<&str>,
    glg_resp: Option<&str>,
    pwr_resp: Option<&str>,
    source: &str,
) -> bool {
    // Read the authoritative volume from shared state rather than a local
    // poll-thread cache. Previously the poll loop held its own `volume`
    // var (refreshed once at startup) and stamped it into every poll
    // frame, which clobbered user-initiated `set_volume` writes ~200ms
    // after they landed.
    let volume = state.live.read().map(|g| g.volume).unwrap_or(0);
    let sts = sts_resp.and_then(parse_sts_frame);
    let glg = glg_resp.and_then(parse_glg_response);

    // PWR sampled this tick (if any); else fall back to the last good sample
    // so RSSI stays continuous across non-PWR ticks.
    let pwr_this_tick = pwr_resp.and_then(parse_pwr_response);
    if let Some(p) = pwr_this_tick.as_ref() {
        poll.last_pwr = Some(p.clone());
    }
    let pwr_effective = pwr_this_tick.as_ref().or(poll.last_pwr.as_ref());

    // Track STS truncation (asked for it, got something, but didn't parse).
    if sts_resp.is_some() && sts.is_none() {
        poll.dropped_sts += 1;
        if poll.dropped_sts.is_multiple_of(50) {
            warn!(
                "STS parse drops accumulating ({}): {} total — firmware truncation is documented but verify the parser",
                source, poll.dropped_sts
            );
        }
    }

    // STS.sql and GLG.sql can legitimately differ on a given tick: they're
    // separate round-trips ~50ms apart (STS uses send_and_read_multiline),
    // and during SCAN the squelch can open/close inside that gap. The #202
    // diagnostic confirmed this is timing skew, not a misparse, so there's no
    // cross-check here — livestate_from_frames prefers GLG for squelch_open.

    if sts.is_none() && glg.is_none() && pwr_effective.is_none() {
        debug!("All poll-tick parses failed ({})", source);
        // Time-based staleness (#149): live.stale used to flip only on a
        // hard disconnect, so persistent parse failures (scanner wedged,
        // half-dead cable) froze the display silently with stale=false.
        poll.consecutive_failed_ticks = poll.consecutive_failed_ticks.saturating_add(1);
        if poll.consecutive_failed_ticks >= STALE_AFTER_FAILED_TICKS && !poll.stale_broadcast {
            warn!(
                "no parseable scanner responses for {} consecutive ticks ({}) — marking live state stale",
                poll.consecutive_failed_ticks, source
            );
            if let Ok(mut live) = state.live.write() {
                live.stale = true;
            }
            broadcast_state_stale(state);
            poll.stale_broadcast = true;
        }
        return false;
    }
    poll.consecutive_failed_ticks = 0;
    poll.stale_broadcast = false;

    let live = livestate_from_frames(
        sts.as_ref(),
        glg.as_ref(),
        pwr_effective,
        commanded_mode,
        volume,
    );
    broadcast_live_update(state, live);
    true
}

fn broadcast_live_update(state: &AppState, live: LiveState) {
    let prev_squelch_open = state.live.read().map(|g| g.squelch_open).unwrap_or(false);

    track_analytics_transition(state, &live, prev_squelch_open);

    if let Ok(mut g) = state.live.write() {
        *g = live.clone();
    }

    // Take-and-send under the shared lock (#143) so a concurrent producer
    // (e.g. set_volume) can't interleave sequence numbers out of order.
    let _send_guard = state.sequence_send.lock().unwrap();
    let seq = state.sequence.fetch_add(1, Ordering::Relaxed);
    let msg = json!({
        "type": "state_update",
        "sequence": seq,
        "timestamp": live.timestamp,
        "data": {
            "timestamp": live.timestamp,
            "frequency": live.frequency,
            "modulation": live.modulation,
            "squelch_open": live.squelch_open,
            "rssi": live.rssi,
            "mode": live.mode,
            "channel": live.channel,
            "alpha_tag": live.alpha_tag,
            "volume": live.volume,
            "battery": live.battery,
            "stale": live.stale,
            "tone_squelch_kind": live.tone_squelch_kind,
            "tone_squelch": live.tone_squelch,
            "tone_dcs_code": live.tone_dcs_code,
            "tone_dcs_label": live.tone_dcs_label,
        }
    });
    let _ = state.ws_tx.send(msg.to_string());

    if live.squelch_open && !prev_squelch_open {
        let event = json!({
            "type": "event",
            "timestamp": live.timestamp,
            "event": "scan_hit",
            "data": {
                "frequency": live.frequency,
                "channel": live.channel,
                "alpha_tag": live.alpha_tag,
                "rssi": live.rssi,
            }
        });
        let _ = state.ws_tx.send(event.to_string());
    }
}

fn send_progress(state: &AppState, task_id: &str, percent: u8, message: &str) {
    let msg = json!({
        "type": "progress",
        "task_id": task_id,
        "percent": percent,
        "message": message,
    });
    let _ = state.ws_tx.send(msg.to_string());
}

fn parse_usb_target(target: &str) -> Option<(u16, u16)> {
    let rest = target.strip_prefix("usb:")?;
    let mut parts = rest.split(':');
    let vid = u16::from_str_radix(parts.next()?, 16).ok()?;
    let pid = u16::from_str_radix(parts.next()?, 16).ok()?;
    Some((vid, pid))
}

/// Parse `VOL,n` response. Returns None for malformed input.
fn parse_vol_response(resp: &str) -> Option<u8> {
    let line = resp.lines().find(|l| !l.trim().is_empty())?.trim();
    let line = line.strip_suffix('\r').unwrap_or(line);
    let (head, val) = line.split_once(',')?;
    if !head.eq_ignore_ascii_case("VOL") {
        return None;
    }
    val.trim().parse::<u8>().ok().map(|v| v.min(15))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// REGRESSION GUARD (#389): an unsupported scanner must be flagged with a
    /// diagnostic at the point of CONNECTION, not the point of discovery.
    ///
    /// The allowlist used to be enforced only in `config::probe_mdl_on_port`,
    /// which runs during autodetect. Both explicit-config paths — `device.port`
    /// and `usb_vid`/`usb_pid` — short-circuit before any probe, so an
    /// unsupported scanner configured explicitly reported plain `connected`
    /// with no warning and no diagnostic. That is the documented macOS setup,
    /// so it was the default posture rather than an edge case.
    ///
    /// This drives `update_device_info_from_mdl` directly because that is the
    /// one function every connection path funnels through.
    #[test]
    fn unsupported_model_sets_diagnostic_and_keeps_connection() {
        let state = crate::api::default_state();
        // SDS100 is a real Uniden trunking scanner with a genuinely different
        // memory model (systems/sites/groups, not a flat channel list), so it
        // stays unsupported. This test previously used BC75XLT, which became
        // supported in #400 -- pick a model that will not migrate into the
        // allowlist and silently void the guard.
        update_device_info_from_mdl(&state, "MDL,SDS100", "/dev/cu.test");

        let d = state.device.read().unwrap();
        assert_eq!(
            d.model.as_deref(),
            Some("SDS100"),
            "the reported model must still be recorded so the UI can name it"
        );
        assert_eq!(
            d.connection_status, "connected",
            "an unsupported scanner is allowed to connect: an explicit device.port \
             is the user overriding detection on purpose, and refusing removes the \
             only escape hatch for a compatible-but-unlisted model"
        );
        assert_eq!(
            d.diagnostic_code.as_deref(),
            Some("unsupported_model"),
            "the diagnostic is what the UI surfaces in place of a hard refusal"
        );
        assert!(
            d.diagnostic_message
                .as_deref()
                .unwrap_or_default()
                .contains("SDS100"),
            "the message must name the offending model, not just say 'unsupported'"
        );
    }

    /// The capability descriptor must be resolved at the same chokepoint that
    /// records the model, and stored on the same struct under the same lock.
    ///
    /// Storing capabilities as a sibling `AppState` field would let a reader
    /// observe a BC75XLT model alongside BC125AT capabilities in the window
    /// between two writes -- a race that is rare, non-deterministic, and
    /// produces exactly the silent bank misfiling this descriptor exists to
    /// prevent. Reading them under one lock makes that state unrepresentable.
    /// State for the capability tests below.
    ///
    /// These exercise `DeviceInfo` alone, but `AppState` has no lighter
    /// constructor and `..default_state()` would still run the full one. Left
    /// as a named helper so a future lighter constructor has one call site to
    /// change rather than three.
    ///
    /// Note `default_state()` opens two SQLite databases at process-wide paths.
    /// That is a pre-existing source of parallel-test contention -- the suite
    /// passes with `--test-threads=1` and can fail without it -- and is out of
    /// scope here. Tracked separately rather than worked around in this PR.
    fn device_only_state() -> AppState {
        crate::api::default_state()
    }

    #[test]
    fn connect_resolves_capabilities_alongside_the_model() {
        use crate::protocol::capabilities::{BC125AT_FAMILY, BC75XLT};

        let state = device_only_state();
        update_device_info_from_mdl(&state, "MDL,BC125AT", "/dev/cu.test");
        {
            let d = state.device.read().unwrap();
            assert_eq!(d.model.as_deref(), Some("BC125AT"));
            assert_eq!(d.capabilities, Some(BC125AT_FAMILY));
        }

        // Reconnecting as a different model must REPLACE the descriptor, not
        // leave the previous scanner's memory model in place.
        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/cu.test");
        {
            let d = state.device.read().unwrap();
            assert_eq!(d.model.as_deref(), Some("BC75XLT"));
            assert_eq!(
                d.capabilities,
                Some(BC75XLT),
                "capabilities must follow the currently-connected scanner"
            );
        }
    }

    /// An unrecognised model still gets a usable descriptor rather than `None`.
    ///
    /// #396 lets an unsupported scanner connect with a diagnostic instead of
    /// refusing it. That escape hatch only works if the memory model is
    /// populated -- consumers would otherwise have to handle `None` everywhere,
    /// and the natural handling (skip the operation) would break the very
    /// override the diagnostic posture exists to preserve.
    #[test]
    fn unknown_model_still_gets_a_capability_descriptor() {
        use crate::protocol::capabilities::BC125AT_FAMILY;

        let state = device_only_state();
        update_device_info_from_mdl(&state, "MDL,SDS100", "/dev/cu.test");

        let d = state.device.read().unwrap();
        assert_eq!(d.diagnostic_code.as_deref(), Some("unsupported_model"));
        assert_eq!(
            d.capabilities,
            Some(BC125AT_FAMILY),
            "unknown hardware falls back to the larger memory model: a scanner \
             with fewer channels returns ERR past its end, which parsers already \
             reject, whereas guessing too small would silently hide channels"
        );
    }

    /// The unsupported-model diagnostic quotes the memory model it assumes.
    /// That number used to be hardcoded prose ("500 channels across 10 banks")
    /// in two places; it is now derived, so it cannot drift from the descriptor
    /// actually in force.
    #[test]
    fn unsupported_diagnostic_quotes_the_assumed_memory_model() {
        let state = device_only_state();
        update_device_info_from_mdl(&state, "MDL,SDS100", "/dev/cu.test");

        let d = state.device.read().unwrap();
        let msg = d.diagnostic_message.as_deref().unwrap_or_default();
        assert!(
            msg.contains("500 channels across 10 banks of 50"),
            "diagnostic must state the assumed capacity, got: {msg}"
        );
    }

    /// Paired with the guard above: a supported model must CLEAR the
    /// diagnostic. Without this, a scanner that reconnects after an
    /// unsupported one would inherit a stale `unsupported_model` flag,
    /// because the connect path only ever cleared diagnostics before the
    /// MDL probe ran.
    #[test]
    fn supported_model_clears_diagnostic() {
        let state = crate::api::default_state();
        update_device_info_from_mdl(&state, "MDL,SDS100", "/dev/cu.test");
        assert_eq!(
            state.device.read().unwrap().diagnostic_code.as_deref(),
            Some("unsupported_model"),
            "precondition: the unsupported flag is set"
        );

        update_device_info_from_mdl(&state, "MDL,BC125AT", "/dev/cu.test");

        let d = state.device.read().unwrap();
        assert_eq!(d.model.as_deref(), Some("BC125AT"));
        assert_eq!(d.connection_status, "connected");
        assert_eq!(
            d.diagnostic_code, None,
            "a supported model must clear the stale unsupported_model diagnostic"
        );
        assert_eq!(d.diagnostic_message, None);
    }

    /// REGRESSION GUARD: a data diagnostic must survive a successful connect.
    ///
    /// A failed migration used to be written into `diagnostic_code`, which
    /// every connect path blanks on a successful open -- so the channel #418
    /// chose specifically to carry it was wiped before any user could see it.
    /// It stayed visible only for someone whose scanner was ALSO unplugged,
    /// which inverts the intent: the warning survived exactly when it mattered
    /// least. Two further gates compounded it -- `App.tsx` renders
    /// `diagnostic_message` only while disconnected, and `DeviceTab` only if
    /// you visit that tab, which nothing prompts you to do when the scanner is
    /// working.
    ///
    /// Observed 2026-08-27 by running a v1 build against a v2 database: the
    /// error logged correctly and `GET /device/info` reported
    /// `diagnostic_code: null` the whole time.
    #[test]
    fn migration_diagnostic_survives_a_connect() {
        let state = crate::api::default_state();
        {
            let mut d = state.device.write().unwrap();
            d.data_diagnostic_code = Some("migration_failed".to_string());
            d.data_diagnostic_message = Some("schema v2; this build supports v1".to_string());
            d.diagnostic_code = Some("unsupported_model".to_string());
            d.diagnostic_message = Some("some connection problem".to_string());
        }

        update_device_info_from_mdl(&state, "MDL,BC125AT", "/dev/cu.test");

        let d = state.device.read().unwrap();
        assert_eq!(
            d.diagnostic_code, None,
            "connecting DOES resolve a connection diagnostic -- that half must still clear"
        );
        assert_eq!(
            d.data_diagnostic_code.as_deref(),
            Some("migration_failed"),
            "connecting a scanner does not fix a database, so the data diagnostic must persist"
        );
        assert_eq!(
            d.data_diagnostic_message.as_deref(),
            Some("schema v2; this build supports v1")
        );
    }

    /// The clear method must be incapable of touching the data pair. This is
    /// the structural half of the guard above: three separate sites in this
    /// file used to blank the fields inline, and an inline assignment is what
    /// makes a future persistent diagnostic unsafe by default.
    #[test]
    fn clearing_a_connection_diagnostic_leaves_the_data_one() {
        let mut d = crate::state::DeviceInfo {
            diagnostic_code: Some("unsupported_model".to_string()),
            diagnostic_message: Some("connection".to_string()),
            data_diagnostic_code: Some("migration_failed".to_string()),
            data_diagnostic_message: Some("data".to_string()),
            ..Default::default()
        };

        d.clear_connection_diagnostic();

        assert_eq!(d.diagnostic_code, None);
        assert_eq!(d.diagnostic_message, None);
        assert_eq!(d.data_diagnostic_code.as_deref(), Some("migration_failed"));
        assert_eq!(d.data_diagnostic_message.as_deref(), Some("data"));
    }

    /// The allowlist comparison is case-insensitive (`eq_ignore_ascii_case`).
    /// This pins that the gate at the connect chokepoint uses the same
    /// comparison as the autodetect probe — an exact-match `.contains()` here
    /// would reject a valid lowercase reply and flag a supported scanner as
    /// unsupported.
    #[test]
    fn model_match_is_case_insensitive_at_connect() {
        let state = crate::api::default_state();
        update_device_info_from_mdl(&state, "MDL,bc125at", "/dev/cu.test");

        let d = state.device.read().unwrap();
        assert_eq!(
            d.diagnostic_code, None,
            "a lowercase but supported model must not be flagged unsupported"
        );
    }

    #[test]
    fn next_backoff_doubles_until_cap() {
        let start = Duration::from_millis(RECONNECT_BACKOFF_INITIAL_MS);
        let mut current = start;
        for _ in 0..20 {
            let next = next_backoff(current);
            assert!(next >= current, "backoff must be non-decreasing");
            assert!(
                next.as_millis() <= RECONNECT_BACKOFF_MAX_MS as u128,
                "backoff must be capped at {} ms, got {} ms",
                RECONNECT_BACKOFF_MAX_MS,
                next.as_millis()
            );
            current = next;
        }
        // After enough doublings we should be sitting at the cap.
        assert_eq!(current.as_millis(), RECONNECT_BACKOFF_MAX_MS as u128);
    }

    // ---- Channel-cache adoption on connect (#413 PR 3) --------------------

    /// Write `count` channels into THIS state's own cache database.
    ///
    /// Seeding `state.preferences_db_path` rather than a private temp file is
    /// the whole point: the connect path reads that path and nothing else, so a
    /// test that seeds a `migrated_db()`-style path of its own asserts an empty
    /// shadow and passes for a build with no load at all. That is the shape of
    /// the two failed `buildEmptyDraft` guard attempts recorded in CLAUDE.md.
    fn seed_cache(state: &AppState, count: u16, synced_at: f64) {
        crate::api::channel_cache::save_channels(
            &state.preferences_db_path,
            crate::api::channel_cache::PLACEHOLDER_SCANNER_ID,
            &channel_map(count),
            synced_at,
        );
    }

    /// `count` channels, indexed 1..=count, as a completed walk would leave
    /// them: every slot the radio has gets a row, which is what makes
    /// `max(index) == channel_count` the capacity signal the guard relies on.
    fn channel_map(count: u16) -> std::collections::HashMap<u16, crate::state::ChannelData> {
        use crate::state::ChannelData;
        let mut map = std::collections::HashMap::new();
        for index in 1..=count {
            map.insert(
                index,
                ChannelData {
                    index,
                    frequency: 146.0 + (index as f64) / 1000.0,
                    modulation: "FM".to_string(),
                    alpha_tag: format!("CH{index}"),
                    ..Default::default()
                },
            );
        }
        map
    }

    fn shadow_len(state: &AppState) -> usize {
        state.shadow.read().unwrap().channels.len()
    }

    /// REGRESSION GUARD: a cache matching the connected scanner is adopted,
    /// so the channel list renders without a 30-45 s memory sync.
    ///
    /// This is the positive half of the capacity guard and it is not optional:
    /// every negative assertion below ("this cache is discarded") also passes
    /// for a build that never loads anything at all.
    #[test]
    fn a_matching_cache_is_loaded_on_connect() {
        let state = crate::api::default_state();
        seed_cache(&state, 300, 1_000_000_000.0);

        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/cu.test");

        assert_eq!(
            shadow_len(&state),
            300,
            "a 300-channel cache must be adopted by a 300-channel scanner"
        );
        let shadow = state.shadow.read().unwrap();
        assert_eq!(
            shadow.channels.get(&1).map(|c| c.alpha_tag.as_str()),
            Some("CH1"),
            "the adopted rows must be the cached ones"
        );
    }

    /// REGRESSION GUARD: a cache written by a BIGGER scanner is discarded.
    ///
    /// Without this, a BC125AT's 500-row cache loads onto a BC75XLT and 200
    /// channels the radio does not have render as real. Nothing panics --
    /// `index_to_bank` returns 0 above `channel_count` while the frontend's
    /// `deriveBankFromIndex` clamps to `bankCount`, so the phantoms land in
    /// bank 10 of a radio whose bank 10 holds 30 channels -- and `export_csv`
    /// writes all 500 rows to the user's file. Plausible-looking and silent,
    /// which is exactly what the bank-derivation third rail warns about.
    #[test]
    fn a_cache_from_a_larger_scanner_is_discarded() {
        let state = crate::api::default_state();
        seed_cache(&state, 500, 1_000_000_000.0);

        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/cu.test");

        assert_eq!(
            shadow_len(&state),
            0,
            "a 500-channel cache must not render on a 300-channel scanner"
        );
    }

    /// REGRESSION GUARD: a cache written by a SMALLER scanner is discarded too.
    ///
    /// Paired with the test above on purpose, and it is the one that pins the
    /// guard to `!=` rather than `>`. A `>` comparison passes the larger-cache
    /// test and silently admits this one: a BC75XLT's 300 rows load onto a
    /// BC125AT, and because the frontend suppresses its startup sync whenever
    /// channels exist, the wrong radio's memory renders and never refreshes.
    /// Both directions are the same mistake.
    #[test]
    fn a_cache_from_a_smaller_scanner_is_discarded() {
        let state = crate::api::default_state();
        seed_cache(&state, 300, 1_000_000_000.0);

        update_device_info_from_mdl(&state, "MDL,BC125AT", "/dev/cu.test");

        assert_eq!(
            shadow_len(&state),
            0,
            "a 300-channel cache must not render on a 500-channel scanner"
        );
    }

    /// REGRESSION GUARD: a reconnect must not overwrite live channel memory.
    ///
    /// Nothing clears `shadow.channels` on disconnect (`mark_disconnected`
    /// touches `DeviceInfo` and `live.stale` only), and the reconnect loop
    /// re-runs this function on every successful reopen -- every few seconds
    /// for a flapping USB link. An unconditional load would stomp edits made
    /// this session with rows up to CHANNEL_CACHE_FLUSH_SECS old.
    #[test]
    fn a_reconnect_does_not_overwrite_live_channels() {
        use crate::state::ChannelData;
        let state = crate::api::default_state();
        seed_cache(&state, 300, 1_000_000_000.0);

        // First connect adopts the cache.
        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/cu.test");
        assert_eq!(shadow_len(&state), 300, "precondition: cache adopted");

        // The user edits a channel; it is on the radio but not yet flushed.
        state.shadow.write().unwrap().channels.insert(
            1,
            ChannelData {
                index: 1,
                alpha_tag: "EDITED".to_string(),
                ..Default::default()
            },
        );

        // The scanner drops and comes back.
        mark_disconnected(&state, "unplugged");
        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/cu.test");

        assert_eq!(
            state
                .shadow
                .read()
                .unwrap()
                .channels
                .get(&1)
                .map(|c| c.alpha_tag.as_str()),
            Some("EDITED"),
            "a reconnect must not replace live memory with the older cache"
        );
    }

    /// REGRESSION GUARD: adopting a cache restores WHEN the radio was read.
    ///
    /// `shadow.last_sync` is what the periodic flush re-persists and what PR 4
    /// reports. Leaving it at its 0.0 default would make the next flush stamp
    /// "now" (the `epoch_now()` fallback), erasing the real age of the memory
    /// within one flush interval of launch -- and a staleness indicator that
    /// always reads "moments ago" is worse than none.
    #[test]
    fn a_loaded_cache_restores_the_sync_time() {
        let state = crate::api::default_state();
        seed_cache(&state, 300, 1_000_000_000.0);

        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/cu.test");

        assert_eq!(
            state.shadow.read().unwrap().last_sync,
            1_000_000_000.0,
            "the adopted cache's sync time must survive into the shadow"
        );
    }

    /// REGRESSION GUARD: channels survive a restart, and the app does not
    /// reset how old it says they are.
    ///
    /// This is #413's headline acceptance criterion -- "channels survive a
    /// restart with no memory sync" -- and it is the one thing none of the
    /// other guards actually prove. `each_state_gets_its_own_databases` gives
    /// every test state a private database, which is what keeps the suite
    /// parallel-safe, but it also means the flush and the load are only ever
    /// exercised against files the other never sees. Both halves can be green
    /// while the pair is broken.
    ///
    /// So this drives the real sequence: session A completes a sync and
    /// flushes; session B -- a fresh process pointed at the SAME database --
    /// connects and adopts.
    ///
    /// Then B flushes again, because that is what a running app does every
    /// CHANNEL_CACHE_FLUSH_SECS, and the recorded age has to survive it.
    /// Without that last assertion the app reports "synced moments ago" 30
    /// seconds after every launch -- the #538 bug arriving by a different
    /// route, and invisible to every other guard here.
    #[test]
    fn channels_survive_a_restart_and_keep_their_age() {
        use crate::api::channel_cache::{
            flush_channel_cache, last_synced_at, PLACEHOLDER_SCANNER_ID,
        };
        const SYNCED_AT: f64 = 1_000_000_000.0;

        // --- Session A: a completed sync, then a flush. ---
        let a = crate::api::default_state();
        {
            let mut shadow = a.shadow.write().unwrap();
            shadow.channels = channel_map(300);
            shadow.last_sync = SYNCED_AT;
        }
        flush_channel_cache(&a);

        // --- Session B: a fresh process on the same database. ---
        let mut b = crate::api::default_state();
        b.preferences_db_path = a.preferences_db_path.clone();
        assert!(
            b.shadow.read().unwrap().channels.is_empty(),
            "precondition: a new session starts with no channel memory"
        );

        update_device_info_from_mdl(&b, "MDL,BC75XLT", "/dev/cu.test");

        assert_eq!(
            shadow_len(&b),
            300,
            "a restart must adopt the previous session's channels with no sync"
        );
        assert_eq!(
            b.shadow.read().unwrap().last_sync,
            SYNCED_AT,
            "the restored memory must carry the time the RADIO was read"
        );

        // --- And the periodic flush must not relabel it as fresh. ---
        //
        // Read under the RESOLVED profile, not the placeholder. Since #414 the
        // connect above adopts the pre-identity rows onto this scanner's own
        // key, so the placeholder is empty afterwards -- which is the adoption
        // working, and this assertion went red until it followed the move.
        flush_channel_cache(&b);
        assert_eq!(
            last_synced_at(&b.preferences_db_path, &b.scanner_id()),
            Some(SYNCED_AT),
            "a flush in the new session must preserve the original sync time, \
             not stamp the restart"
        );
    }

    /// REGRESSION GUARD (#539): reconnecting must broadcast that the scanner
    /// came back.
    ///
    /// `broadcast_device_info` has two callers: `mark_disconnected` and this
    /// one, gated on `transitioned_to_connected`. Both poll loops used to set
    /// `connection_status = "connected"` when the PORT OPENED, before the MDL
    /// probe -- so by the time this function tested the flag it was always
    /// already "connected", the gate was always false, and the connect-side
    /// broadcast was dead code.
    ///
    /// The user-visible result: after any unplug/replug, the frontend kept the
    /// "disconnected" value it received on the disconnect edge. Both of its
    /// `getDeviceInfo` fetches are mount-only, and `useConnectionStatus`
    /// returns 'disconnected' whenever `deviceInfo.connection_status` says so
    /// -- regardless of WebSocket health or `stale` clearing. The UI read
    /// disconnected for the rest of the session while the radio worked fine.
    ///
    /// Proven by running this sequence against the old code: the disconnect
    /// broadcast fired and the reconnect produced `[]`.
    #[test]
    fn a_reconnect_broadcasts_that_the_scanner_came_back() {
        let state = crate::api::default_state();

        // A live session.
        update_device_info_from_mdl(&state, "MDL,BC125AT", "/dev/cu.test");
        assert_eq!(
            state.device.read().unwrap().connection_status,
            "connected",
            "precondition: connected after the first MDL"
        );

        let mut rx = state.ws_tx.subscribe();

        // The scanner is unplugged.
        mark_disconnected(&state, "unplugged");
        let first = rx.try_recv().expect("a disconnect must broadcast");
        assert!(
            first.contains("\"connection_status\":\"disconnected\""),
            "expected a disconnect broadcast, got {first}"
        );
        while rx.try_recv().is_ok() {} // drain state_stale

        // It comes back. This mirrors what both poll loops do on a successful
        // open -- port and diagnostics, but NOT the status -- and then the MDL
        // reply arrives.
        mark_port_opened(&state, "/dev/cu.test");
        update_device_info_from_mdl(&state, "MDL,BC125AT", "/dev/cu.test");

        let mut msgs = Vec::new();
        while let Ok(m) = rx.try_recv() {
            msgs.push(m);
        }
        assert!(
            msgs.iter()
                .any(|m| m.contains("\"connection_status\":\"connected\"")),
            "the frontend must be told the scanner came back; broadcasts: {msgs:?}"
        );
    }

    /// REGRESSION GUARD (#539): opening a port must NOT claim connected.
    ///
    /// This is the half the reconnect guard above cannot cover. That test
    /// drives `mark_port_opened` too, but a test that instead rebuilt the
    /// port-open sequence by hand would pass whether or not the real loops
    /// still set the status -- measured: reintroducing
    /// `connection_status = "connected"` into the serial loop left the whole
    /// suite green until this assertion existed.
    ///
    /// "connected" has to mean "we know which radio this is". The channel-cache
    /// capacity guard depends on it too: it cannot run before the model is
    /// known, and `AppState::capabilities()` answers with the BC125AT default
    /// until then.
    #[test]
    fn opening_a_port_does_not_claim_connected() {
        let state = crate::api::default_state();
        assert_eq!(
            state.device.read().unwrap().connection_status,
            "disconnected",
            "precondition"
        );

        mark_port_opened(&state, "/dev/cu.test");

        let d = state.device.read().unwrap();
        assert_eq!(
            d.connection_status, "disconnected",
            "an open file descriptor is not a known scanner"
        );
        assert_eq!(
            d.port.as_deref(),
            Some("/dev/cu.test"),
            "the port is recorded"
        );
    }

    /// A scanner that never answers `MDL` still reports connected.
    ///
    /// Paired with the guard above so the fix cannot be "only announce a model
    /// we recognise". The port is open and the poll loop is running, so the
    /// honest status is connected even though the model is unknown -- that is
    /// the pre-#539 behaviour and it must survive. Without this, a scanner
    /// whose MDL is garbled reads as permanently disconnected, which is a
    /// worse bug than the one being fixed.
    #[test]
    fn an_unidentified_scanner_still_reports_connected() {
        let state = crate::api::default_state();
        mark_connected_without_model(&state, "/dev/cu.test");

        let d = state.device.read().unwrap();
        assert_eq!(d.connection_status, "connected");
        assert_eq!(d.port.as_deref(), Some("/dev/cu.test"));
    }

    /// REGRESSION GUARD (#414): connecting resolves a real profile, and the
    /// cache is keyed on it rather than on the shared placeholder.
    #[test]
    fn connecting_resolves_a_profile_and_keys_the_cache_on_it() {
        let state = crate::api::default_state();
        assert_eq!(
            state.scanner_id(),
            "_default",
            "precondition: no profile before the first MDL"
        );

        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/cu.test");

        let id = state.scanner_id();
        assert_ne!(id, "_default", "a connect must resolve a real profile");
        assert_eq!(
            state.device.read().unwrap().scanner_id.as_deref(),
            Some(id.as_str()),
            "the id must live on DeviceInfo, beside the model it was resolved with"
        );
    }

    /// REGRESSION GUARD (#414): channels cached before profiles existed are
    /// adopted onto the scanner they belong to, not orphaned.
    ///
    /// Everything cached pre-#414 sits under `_default`. Nothing looks that key
    /// up any more, so without the move a user who upgrades silently loses
    /// their cache and pays a re-sync on the next launch.
    #[test]
    fn pre_identity_cached_channels_are_adopted_on_connect() {
        let state = crate::api::default_state();
        // 300 rows, exactly a BC75XLT's memory.
        crate::api::channel_cache::save_channels(
            &state.preferences_db_path,
            "_default",
            &channel_map(300),
            1_000_000_000.0,
        );

        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/cu.test");

        let id = state.scanner_id();
        assert_eq!(
            crate::api::channel_cache::load_channels(&state.preferences_db_path, &id).len(),
            300,
            "the rows must now live under this scanner's profile"
        );
        assert!(
            crate::api::channel_cache::load_channels(&state.preferences_db_path, "_default")
                .is_empty(),
            "and must no longer sit under the placeholder"
        );
        assert_eq!(
            shadow_len(&state),
            300,
            "and must be loaded into the shadow"
        );
    }

    /// REGRESSION GUARD (#414): a placeholder cache from a DIFFERENT radio is
    /// left alone.
    ///
    /// Adoption is a one-way move. If a user's pre-#414 cache came from their
    /// BC125AT and they plug the BC75XLT in first, re-keying blindly would hand
    /// 500 BC125AT channels to the BC75XLT's profile -- where the capacity
    /// guard discards them at load, and the BC125AT never finds them again
    /// because they now live under someone else's key. Silent, permanent, and
    /// exactly the shape of loss the whole cache exists to avoid.
    ///
    /// Paired with the guard above on purpose: asserting only that adoption
    /// happens also passes for a build that adopts unconditionally.
    #[test]
    fn a_placeholder_cache_from_another_radio_is_not_adopted() {
        let state = crate::api::default_state();
        // 500 rows -- a BC125AT's memory, not a BC75XLT's.
        crate::api::channel_cache::save_channels(
            &state.preferences_db_path,
            "_default",
            &channel_map(500),
            1_000_000_000.0,
        );

        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/cu.test");

        assert_eq!(
            crate::api::channel_cache::load_channels(&state.preferences_db_path, "_default").len(),
            500,
            "the other radio's cache must stay where the right scanner can find it"
        );
        assert_eq!(
            shadow_len(&state),
            0,
            "and must not render on the wrong scanner"
        );
    }

    /// A profile that already has its own channels is never overwritten by the
    /// placeholder rows.
    #[test]
    fn adoption_never_overwrites_a_profile_that_has_memory() {
        let state = crate::api::default_state();
        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/cu.test");
        let id = state.scanner_id();

        // This profile already synced once.
        crate::api::channel_cache::save_channels(
            &state.preferences_db_path,
            &id,
            &channel_map(300),
            2_000_000_000.0,
        );
        // And a stale placeholder set is still lying around.
        crate::api::channel_cache::save_channels(
            &state.preferences_db_path,
            "_default",
            &channel_map(300),
            1_000_000_000.0,
        );

        let moved = crate::api::channel_cache::adopt_placeholder_cache(
            &state.preferences_db_path,
            &id,
            300,
        );

        assert_eq!(
            moved, 0,
            "a profile with its own memory must not be rewritten"
        );
        assert_eq!(
            crate::api::channel_cache::last_synced_at(&state.preferences_db_path, &id),
            Some(2_000_000_000.0),
            "its own, newer sync time must survive"
        );
    }
    /// REGRESSION GUARD: a device that VANISHED must never be announced as
    /// connected.
    ///
    /// Both MDL retry loops break out early when the transport reports the
    /// device is gone, and the very next statement used to run the
    /// "connected, model unknown" fallback -- so the one branch that had just
    /// learned the scanner left was the branch that said it arrived. Harmless
    /// while nothing listened; #551 made that state BROADCAST, which turns a
    /// wedged link (the documented USB STALL wedge) into a connect/disconnect
    /// storm at reconnect-backoff rate, roughly 2 Hz.
    ///
    /// Asserted on the predicate rather than the loop because `run_poll_loop`
    /// has no fake transport. A guard on `mark_connected_without_model` alone
    /// cannot see which branch called it -- which is how this shipped.
    #[test]
    fn a_vanished_device_is_never_announced_as_connected() {
        // The scanner is still there, just not answering intelligibly. The
        // port is open and about to be polled, so connected-with-no-model is
        // the honest report -- this is the #539 case the fallback exists for.
        assert!(
            should_announce_connect(false, false),
            "a garbled MDL must still report connected"
        );

        // The transport said the device is gone. Saying "connected" here is a
        // lie the poll loop will contradict within a tick.
        assert!(
            !should_announce_connect(false, true),
            "a vanished device must NOT be announced as connected"
        );

        // A successful MDL means update_device_info_from_mdl already announced
        // it, with a model. The fallback must not fire a second time.
        assert!(!should_announce_connect(true, false));
        assert!(!should_announce_connect(true, true));
    }

    /// REGRESSION GUARD: a DIFFERENT radio must not inherit the last one's
    /// channels, and must not overwrite its profile with them.
    ///
    /// Found by review, then reproduced: connect a BC75XLT, sync 300 channels,
    /// then connect a BC125AT on the same port string. Nothing clears
    /// `shadow.channels` on disconnect, so the BC75XLT's map was still in
    /// memory; `load_channel_cache` declined to load ("a populated shadow
    /// wins", which is correct for a reconnect of the SAME radio) so the
    /// capacity guard never saw it; and the next flush wrote those 300
    /// channels under the BC125AT's `scanner_id`, DELETEing that profile's own
    /// rows first.
    ///
    /// Reachable wherever two units share a port string across a replug -- two
    /// CP210x radios both landing on `/dev/ttyUSB0`. Two same-capacity units
    /// are the worst case: the capacity guard cannot catch it on the next
    /// launch either, because the counts match.
    ///
    /// The existing reconnect guard passes both connects the SAME model, so it
    /// exercised a same-radio reconnect and never an identity change. This is
    /// the case no test in the suite covered.
    #[test]
    fn a_different_radio_does_not_inherit_the_last_ones_channels() {
        let state = crate::api::default_state();

        // Radio A: 300 channels, synced and persisted.
        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/ttyUSB0");
        let id_a = state.scanner_id();
        {
            let mut shadow = state.shadow.write().unwrap();
            shadow.channels = channel_map(300);
            shadow.last_sync = 1_000_000_000.0;
        }
        crate::api::channel_cache::flush_channel_cache(&state);

        // Radio B arrives on the same port string.
        update_device_info_from_mdl(&state, "MDL,BC125AT", "/dev/ttyUSB0");
        let id_b = state.scanner_id();
        assert_ne!(id_a, id_b, "precondition: a different radio");

        assert_eq!(
            shadow_len(&state),
            0,
            "the departed radio's channels must not still be in memory"
        );

        // And a flush must not write them into B's profile.
        crate::api::channel_cache::flush_channel_cache(&state);
        assert!(
            crate::api::channel_cache::load_channels(&state.preferences_db_path, &id_b).is_empty(),
            "the new radio's profile must not be filled with the old radio's channels"
        );
        assert_eq!(
            crate::api::channel_cache::load_channels(&state.preferences_db_path, &id_a).len(),
            300,
            "and the departed radio's own cache must survive intact"
        );
    }

    /// Paired with the guard above: reconnecting the SAME radio must KEEP its
    /// channels. Clearing unconditionally would throw away live edits on every
    /// USB blip -- a flapping link reconnects every few seconds.
    #[test]
    fn the_same_radio_reconnecting_keeps_its_channels() {
        let state = crate::api::default_state();
        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/ttyUSB0");
        state.shadow.write().unwrap().channels = channel_map(300);

        mark_disconnected(&state, "unplugged");
        update_device_info_from_mdl(&state, "MDL,BC75XLT", "/dev/ttyUSB0");

        assert_eq!(
            shadow_len(&state),
            300,
            "the same radio's live channel memory must survive a replug"
        );
    }
}
