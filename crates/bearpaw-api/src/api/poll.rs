//! Blocking serial poll loop: drain control commands, then STS -> LiveState -> broadcast.

use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use serde_json::json;
use tracing::{debug, error, info, warn};

use std::collections::HashMap;

use crate::api::track_analytics_transition;
use crate::api::AppState;
use crate::api::ControlCommand;
use crate::protocol::{
    livestate_from_sts, parse_cin_response, parse_mdl_response, parse_sts_response,
};
use crate::state::{ChannelData, LiveState};
use crate::transport::{SerialTransport, TransportError};
use crate::transport_usb::UsbTransport;

const POLL_INTERVAL_MS: u64 = 200;
const STS_CMD: &str = "STS";
const MDL_CMD: &str = "MDL";
const KEY_HOLD: &str = "KEY,H,P";
const KEY_SCAN: &str = "KEY,S,P";
const PRG_CMD: &str = "PRG";
const EPG_CMD: &str = "EPG";

/// Spawn a blocking thread: open serial, process command channel + STS poll, broadcast state.
pub fn spawn_poll_loop(
    state: AppState,
    port_name: String,
    baud: u32,
    cmd_rx: std::sync::mpsc::Receiver<ControlCommand>,
) {
    thread::spawn(move || {
        if let Err(e) = run_poll_loop(state.clone(), &port_name, baud, cmd_rx) {
            error!("Poll loop exited: {}", e);
            if let Ok(mut d) = state.device.write() {
                d.connection_status = "disconnected".to_string();
                d.diagnostic_message = Some(e.to_string());
            }
        }
    });
}

fn run_poll_loop(
    state: AppState,
    port_name: &str,
    baud: u32,
    cmd_rx: std::sync::mpsc::Receiver<ControlCommand>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    if let Some((vid, pid)) = parse_usb_target(port_name) {
        return run_poll_loop_usb(state, vid, pid, cmd_rx);
    }

    let transport = SerialTransport::new(port_name, baud);
    let mut port = transport.open().map_err(|e| e.to_string())?;

    info!("Serial opened: {} @ {} baud", port_name, baud);
    if let Ok(mut d) = state.device.write() {
        d.port = Some(port_name.to_string());
        d.connection_status = "connected".to_string();
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
            }
        }
        thread::sleep(Duration::from_millis(120));
    }
    if !mdl_set {
        warn!("Unable to read valid MDL response after retries (serial)");
    }

    let mut commanded_mode: String = "SCAN".to_string();

    loop {
        // Drain control commands (hold, scan, direct, start sync)
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                ControlCommand::Hold => {
                    let _ = transport.send(port.as_mut(), KEY_HOLD);
                    commanded_mode = "HOLD".to_string();
                }
                ControlCommand::Scan => {
                    let _ = transport.send(port.as_mut(), KEY_SCAN);
                    commanded_mode = "SCAN".to_string();
                }
                ControlCommand::Direct {
                    frequency,
                    modulation,
                } => {
                    let do_cmd = format!("DO,{:.4},{}", frequency, modulation);
                    let _ = transport.send(port.as_mut(), &do_cmd);
                    commanded_mode = "DIRECT".to_string();
                }
                ControlCommand::StartSync {
                    task_id,
                    max_channels,
                } => {
                    if let Err(e) =
                        run_memory_sync(&state, &transport, port.as_mut(), &task_id, max_channels)
                    {
                        warn!("Memory sync failed: {}", e);
                        finish_sync(&state);
                        send_progress(&state, &task_id, 0, &format!("Sync failed: {}", e));
                    }
                }
                ControlCommand::Raw {
                    command,
                    multiline,
                    reply,
                } => {
                    let response = if multiline {
                        transport
                            .send_and_read_multiline(port.as_mut(), &command)
                            .map_err(|e| e.to_string())
                    } else {
                        transport
                            .send(port.as_mut(), &command)
                            .map_err(|e| e.to_string())
                    };
                    let _ = reply.send(response);
                }
            }
        }

        // STS (multiline response)
        let resp = match transport.send_and_read_multiline(port.as_mut(), STS_CMD) {
            Ok(r) => r,
            Err(TransportError::Io(e)) => {
                warn!("STS read error: {}", e);
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                continue;
            }
            Err(e) => return Err(e.into()),
        };

        if !process_sts_frame(&state, &commanded_mode, &resp, "serial") {
            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            continue;
        }

        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }
}

fn run_poll_loop_usb(
    state: AppState,
    vid: u16,
    pid: u16,
    cmd_rx: std::sync::mpsc::Receiver<ControlCommand>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let transport = UsbTransport::new(vid, pid);
    let mut session = transport.open().map_err(|e| e.to_string())?;

    info!("USB opened: {:04x}:{:04x}", vid, pid);
    if let Ok(mut d) = state.device.write() {
        d.port = Some(format!("usb:{:04x}:{:04x}", vid, pid));
        d.connection_status = "connected".to_string();
    }

    let port_label = format!("usb:{:04x}:{:04x}", vid, pid);
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
            }
        }
        thread::sleep(Duration::from_millis(120));
    }
    if !mdl_set {
        warn!("Unable to read valid MDL response after retries (usb)");
    }

    let mut commanded_mode: String = "SCAN".to_string();
    loop {
        while let Ok(cmd) = cmd_rx.try_recv() {
            match cmd {
                ControlCommand::Hold => {
                    let _ = transport.send(&mut session, KEY_HOLD);
                    commanded_mode = "HOLD".to_string();
                }
                ControlCommand::Scan => {
                    let _ = transport.send(&mut session, KEY_SCAN);
                    commanded_mode = "SCAN".to_string();
                }
                ControlCommand::Direct {
                    frequency,
                    modulation,
                } => {
                    let do_cmd = format!("DO,{:.4},{}", frequency, modulation);
                    let _ = transport.send(&mut session, &do_cmd);
                    commanded_mode = "DIRECT".to_string();
                }
                ControlCommand::StartSync {
                    task_id,
                    max_channels,
                } => {
                    if let Err(e) = run_memory_sync_usb(
                        &state,
                        &transport,
                        &mut session,
                        &task_id,
                        max_channels,
                    ) {
                        warn!("Memory sync failed: {}", e);
                        finish_sync(&state);
                        send_progress(&state, &task_id, 0, &format!("Sync failed: {}", e));
                    }
                }
                ControlCommand::Raw {
                    command,
                    multiline,
                    reply,
                } => {
                    let response = if multiline {
                        transport
                            .send_and_read_multiline(&mut session, &command)
                            .map_err(|e| e.to_string())
                    } else {
                        transport
                            .send(&mut session, &command)
                            .map_err(|e| e.to_string())
                    };
                    let _ = reply.send(response);
                }
            }
        }

        let resp = match transport.send_and_read_multiline(&mut session, STS_CMD) {
            Ok(r) => r,
            Err(e) => {
                warn!("STS read error (usb): {}", e);
                thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
                continue;
            }
        };

        if !process_sts_frame(&state, &commanded_mode, &resp, "usb") {
            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            continue;
        }
        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }
}

fn update_device_info_from_mdl(state: &AppState, mdl_resp: &str, port_label: &str) {
    if let Some(model) = parse_mdl_response(mdl_resp) {
        if let Ok(mut d) = state.device.write() {
            d.model = Some(model);
            d.port = Some(port_label.to_string());
            d.connection_status = "connected".to_string();
            d.diagnostic_code = None;
            d.diagnostic_message = None;
        }
    } else {
        warn!("Invalid MDL response ignored: {}", mdl_resp.trim());
    }
}

fn process_sts_frame(state: &AppState, commanded_mode: &str, resp: &str, source: &str) -> bool {
    let map = parse_sts_response(resp);
    if map.is_empty() {
        debug!("Empty STS response ({})", source);
        return false;
    }

    let mut live = livestate_from_sts(&map);
    live.mode = commanded_mode.to_string();
    broadcast_live_update(state, live);
    true
}

fn broadcast_live_update(state: &AppState, live: LiveState) {
    let prev_squelch_open = state.live.read().map(|g| g.squelch_open).unwrap_or(false);
    let seq = state.sequence.fetch_add(1, Ordering::Relaxed);

    track_analytics_transition(state, &live, prev_squelch_open);

    if let Ok(mut g) = state.live.write() {
        *g = live.clone();
    }

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

/// Run full memory sync: PRG -> CIN 1..max_channels -> EPG; update shadow, broadcast progress.
fn run_memory_sync(
    state: &AppState,
    transport: &SerialTransport,
    port: &mut dyn serialport::SerialPort,
    task_id: &str,
    max_channels: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    send_progress(state, task_id, 0, "Entering program mode...");
    let _ = transport.send(port, PRG_CMD);
    thread::sleep(Duration::from_millis(100));

    let mut channels: HashMap<u16, ChannelData> = HashMap::new();
    for idx in 1..=max_channels {
        if state
            .sync_cancel_requested
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            let _ = transport.send(port, EPG_CMD);
            finish_sync(state);
            send_progress(state, task_id, 0, "Sync cancelled");
            return Ok(());
        }
        let cmd = format!("CIN,{}", idx);
        let resp = transport.send(port, &cmd).unwrap_or_default();
        if let Some(ch) = parse_cin_response(idx, &resp) {
            channels.insert(idx, ch);
        }
        if idx % 10 == 0 {
            let pct = ((idx as f64 / max_channels as f64) * 100.0) as u8;
            send_progress(
                state,
                task_id,
                pct,
                &format!("Syncing channel {}/{}", idx, max_channels),
            );
        }
    }

    send_progress(state, task_id, 100, "Exiting program mode...");
    let _ = transport.send(port, EPG_CMD);
    thread::sleep(Duration::from_millis(100));

    let now = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    if let Ok(mut shadow) = state.shadow.write() {
        shadow.channels = channels;
        shadow.last_sync = now;
    }
    finish_sync(state);
    send_progress(state, task_id, 100, "Sync complete");
    Ok(())
}

fn run_memory_sync_usb(
    state: &AppState,
    transport: &UsbTransport,
    session: &mut crate::transport_usb::UsbSession,
    task_id: &str,
    max_channels: u16,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    send_progress(state, task_id, 0, "Entering program mode...");
    let _ = transport.send(session, PRG_CMD);
    thread::sleep(Duration::from_millis(100));

    let mut channels: HashMap<u16, ChannelData> = HashMap::new();
    for idx in 1..=max_channels {
        if state
            .sync_cancel_requested
            .load(std::sync::atomic::Ordering::Relaxed)
        {
            let _ = transport.send(session, EPG_CMD);
            finish_sync(state);
            send_progress(state, task_id, 0, "Sync cancelled");
            return Ok(());
        }
        let cmd = format!("CIN,{}", idx);
        let resp = transport.send(session, &cmd).unwrap_or_default();
        if let Some(ch) = parse_cin_response(idx, &resp) {
            channels.insert(idx, ch);
        }
        if idx % 10 == 0 {
            let pct = ((idx as f64 / max_channels as f64) * 100.0) as u8;
            send_progress(
                state,
                task_id,
                pct,
                &format!("Syncing channel {}/{}", idx, max_channels),
            );
        }
    }

    send_progress(state, task_id, 100, "Exiting program mode...");
    let _ = transport.send(session, EPG_CMD);
    thread::sleep(Duration::from_millis(100));

    let now = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);
    if let Ok(mut shadow) = state.shadow.write() {
        shadow.channels = channels;
        shadow.last_sync = now;
    }
    finish_sync(state);
    send_progress(state, task_id, 100, "Sync complete");
    Ok(())
}

fn finish_sync(state: &AppState) {
    state
        .sync_cancel_requested
        .store(false, std::sync::atomic::Ordering::Relaxed);
    state.sync_task_id.lock().unwrap().take();
}

fn parse_usb_target(target: &str) -> Option<(u16, u16)> {
    let rest = target.strip_prefix("usb:")?;
    let mut parts = rest.split(':');
    let vid = u16::from_str_radix(parts.next()?, 16).ok()?;
    let pid = u16::from_str_radix(parts.next()?, 16).ok()?;
    Some((vid, pid))
}
