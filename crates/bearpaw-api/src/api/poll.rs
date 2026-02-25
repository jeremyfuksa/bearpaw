//! Blocking serial poll loop: drain control commands, then STS -> LiveState -> broadcast.

use std::sync::atomic::Ordering;
use std::thread;
use std::time::Duration;

use serde_json::json;
use tracing::{debug, error, info, warn};

use crate::api::ControlCommand;
use crate::api::AppState;
use crate::protocol::{livestate_from_sts, parse_mdl_response, parse_sts_response};
use crate::transport::{SerialTransport, TransportError};

const POLL_INTERVAL_MS: u64 = 200;
const STS_CMD: &str = "STS";
const MDL_CMD: &str = "MDL";
const KEY_HOLD: &str = "KEY,H,P";
const KEY_SCAN: &str = "KEY,S,P";

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
    let transport = SerialTransport::new(port_name, baud);
    let mut port = transport.open().map_err(|e| e.to_string())?;

    info!("Serial opened: {} @ {} baud", port_name, baud);

    // Device info: model from MDL
    {
        let mdl_resp = transport.send(port.as_mut(), MDL_CMD)?;
        if let Some(model) = parse_mdl_response(&mdl_resp) {
            if let Ok(mut d) = state.device.write() {
                d.model = Some(model);
                d.port = Some(port_name.to_string());
                d.connection_status = "connected".to_string();
                d.diagnostic_code = None;
                d.diagnostic_message = None;
            }
        }
    }

    let mut commanded_mode: String = "SCAN".to_string();

    loop {
        // Drain control commands (hold, scan, direct)
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
                ControlCommand::Direct { frequency, modulation } => {
                    let do_cmd = format!("DO,{:.4},{}", frequency, modulation);
                    let _ = transport.send(port.as_mut(), &do_cmd);
                    commanded_mode = "DIRECT".to_string();
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

        let map = parse_sts_response(&resp);
        if map.is_empty() {
            debug!("Empty STS response");
            thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
            continue;
        }

        let mut live = livestate_from_sts(&map);
        live.mode = commanded_mode.clone();
        let seq = state.sequence.fetch_add(1, Ordering::Relaxed);

        {
            if let Ok(mut g) = state.live.write() {
                *g = live.clone();
            }
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
                "volume": live.volume,
                "battery": live.battery,
                "stale": live.stale,
            }
        });
        let s = msg.to_string();
        if state.ws_tx.send(s).is_err() {
            // no subscribers
        }

        thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
    }
}
