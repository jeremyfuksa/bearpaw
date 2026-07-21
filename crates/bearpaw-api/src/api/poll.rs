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
const KEY_HOLD: &str = "KEY,H,P";
const KEY_SCAN: &str = "KEY,S,P";

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

    let mut first_open = true;
    loop {
        let mut port = match transport.open() {
            Ok(p) => p,
            Err(e) => {
                if first_open {
                    return Err(e.to_string().into());
                }
                mark_disconnected(&state, &format!("serial open failed: {}", e));
                thread::sleep(reconnect_backoff);
                reconnect_backoff = next_backoff(reconnect_backoff);
                continue;
            }
        };
        first_open = false;
        reconnect_backoff = Duration::from_millis(RECONNECT_BACKOFF_INITIAL_MS);

        info!("Serial opened: {} @ {} baud", port_name, baud);
        if let Ok(mut d) = state.device.write() {
            d.port = Some(port_name.to_string());
            d.connection_status = "connected".to_string();
            d.diagnostic_code = None;
            d.diagnostic_message = None;
        }

        // Device info: model from MDL (with retry because some scanners can return
        // stale command echoes immediately after connection).
        let mut mdl_set = false;
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
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(120));
        }
        if !mdl_set {
            warn!("Unable to read valid MDL response after retries (serial)");
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

    // Outer reconnect loop. Returns only if the initial open fails (so the
    // caller's error path can surface it); otherwise loops forever, opening
    // and re-opening the session as the scanner appears/disappears.
    let mut first_open = true;
    loop {
        let mut session = match transport.open() {
            Ok(s) => s,
            Err(e) => {
                if first_open {
                    return Err(e.to_string().into());
                }
                // Subsequent opens after a reconnect: device probably still
                // gone. Mark disconnected, back off, retry.
                mark_disconnected(&state, &format!("USB open failed: {}", e));
                thread::sleep(reconnect_backoff);
                reconnect_backoff = next_backoff(reconnect_backoff);
                continue;
            }
        };
        first_open = false;
        reconnect_backoff = Duration::from_millis(RECONNECT_BACKOFF_INITIAL_MS);

        info!("USB opened: {:04x}:{:04x}", vid, pid);
        if let Ok(mut d) = state.device.write() {
            d.port = Some(port_label.clone());
            d.connection_status = "connected".to_string();
            d.diagnostic_code = None;
            d.diagnostic_message = None;
        }

        let mut mdl_set = false;
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
                        break;
                    }
                }
            }
            thread::sleep(Duration::from_millis(120));
        }
        if !mdl_set {
            warn!("Unable to read valid MDL response after retries (usb)");
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

fn update_device_info_from_mdl(state: &AppState, mdl_resp: &str, port_label: &str) {
    if let Some(model) = parse_mdl_response(mdl_resp) {
        let mut transitioned_to_connected = false;
        if let Ok(mut d) = state.device.write() {
            if d.connection_status != "connected" {
                transitioned_to_connected = true;
            }
            d.model = Some(model.clone());
            d.port = Some(port_label.to_string());
            d.connection_status = "connected".to_string();
            d.diagnostic_code = None;
            d.diagnostic_message = None;
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
    /// Count of ticks where STS.sql and GLG.sql disagreed. Should be 0 in
    /// normal operation; non-zero values may indicate a parser bug.
    squelch_disagreements: u64,
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
            squelch_disagreements: 0,
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

    // Cross-check squelch polarity between STS and GLG.
    if let (Some(s), Some(g)) = (sts.as_ref(), glg.as_ref()) {
        if s.squelch_open != g.squelch_open {
            poll.squelch_disagreements += 1;
            if poll.squelch_disagreements.is_multiple_of(10) {
                // DIAGNOSTIC (#202): dump the raw STS + GLG frames on
                // disagreement to tell a misparse (find_sts_tail_start anchored
                // on the wrong field) apart from benign scan-cycle timing skew
                // (STS and GLG are separate round-trips ~ms apart). Remove once
                // the cause is confirmed.
                warn!(
                    "STS.sql != GLG.sql {} times ({}): STS={}, GLG={} — investigate parser. raw_sts={:?} raw_glg={:?} sts_sig_lvl={}",
                    poll.squelch_disagreements,
                    source,
                    s.squelch_open,
                    g.squelch_open,
                    sts_resp.map(|r| r.trim()),
                    glg_resp.map(|r| r.trim()),
                    s.sig_lvl,
                );
            }
        }
    }

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
}
