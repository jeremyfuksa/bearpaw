//! Configuration for port, baud, API bind address.

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use tracing::{debug, warn};

/// Known Uniden scanner USB IDs probed during plug-and-play autodetect.
/// All current entries are Uniden America Corp. (`0x1965`).
/// See docs/SCANNER_PROTOCOL_REFERENCE.md §1 for the list.
const KNOWN_SCANNER_USB_IDS: &[(u16, u16)] = &[
    (0x1965, 0x0017), // BC125AT, BCT125AT (shared PID)
                      // Other Uniden 125/126 family PIDs (0x0016–0x001A) can be added here
                      // as they're confirmed.
];

/// Model names returned by `MDL` that we accept as a real Uniden scanner.
/// Used by the autodetect MDL-probe step to confirm a candidate serial
/// port is the scanner before committing to it. See
/// `docs/BC125AT_PROTOCOL.md` §5.1.
const ACCEPTED_MDL_MODELS: &[&str] = &["BC125AT", "BCT125AT", "UBC125XLT", "UBC126AT", "AE125H"];

/// Sidecar filename for the most-recently-confirmed scanner. Lets us prefer
/// the same physical unit across reconnects when multiple scanners would
/// otherwise tie.
const LAST_SCANNER_CACHE_FILE: &str = "last_scanner.json";

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub device: DeviceConfig,
    #[serde(default)]
    pub api: ApiConfig,
}

#[derive(Clone, Debug, Deserialize)]
pub struct DeviceConfig {
    pub port: Option<String>,
    pub baud: Option<u32>,
    #[serde(default = "default_auto_detect")]
    pub auto_detect: bool,
    pub usb_vid: Option<u16>,
    pub usb_pid: Option<u16>,
    /// Assert DTR after opening the serial port. Default `false` — asserting
    /// DTR on open has caused intermittent disconnects on macOS/Linux and
    /// the BC125AT itself does not require it. Set to `true` only if your
    /// host/adapter combination demands it.
    #[serde(default)]
    pub assert_dtr_on_open: bool,
}

impl Default for DeviceConfig {
    fn default() -> Self {
        Self {
            port: None,
            baud: None,
            auto_detect: default_auto_detect(),
            usb_vid: None,
            usb_pid: None,
            assert_dtr_on_open: false,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
pub struct ApiConfig {
    #[serde(default = "default_api_host")]
    pub host: String,
    #[serde(default = "default_api_port")]
    pub port: u16,
}

fn default_api_host() -> String {
    "127.0.0.1".to_string()
}

fn default_api_port() -> u16 {
    8000
}

fn default_auto_detect() -> bool {
    true
}

impl Default for ApiConfig {
    fn default() -> Self {
        Self {
            host: default_api_host(),
            port: default_api_port(),
        }
    }
}

/// Load config from YAML or TOML path. Falls back to default on read/parse errors.
pub fn load_config(path: Option<&str>) -> Config {
    let Some(path) = path else {
        return Config::default();
    };
    let p = Path::new(path);
    let Ok(raw) = fs::read_to_string(p) else {
        return Config::default();
    };
    // A config file that EXISTS but doesn't parse is a startup error, not a
    // silent fall-through to defaults (#143) — running with defaults when the
    // user explicitly configured usb_vid/usb_pid means "scanner not found"
    // with no hint why.
    let cfg: Config = if path.ends_with(".toml") {
        match toml::from_str(&raw) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("error: failed to parse config {}: {}", path, e);
                std::process::exit(2);
            }
        }
    } else {
        match serde_yaml::from_str(&raw) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("error: failed to parse config {}: {}", path, e);
                std::process::exit(2);
            }
        }
    };
    if cfg.device.usb_vid.is_some() != cfg.device.usb_pid.is_some() {
        eprintln!(
            "warning: config sets only one of device.usb_vid / device.usb_pid — both are required for the direct-USB path; ignoring"
        );
    }
    cfg
}

/// Resolve serial port from config: explicit port first, then USB auto-detect.
///
/// Precedence:
/// 1. `device.port` in config (explicit override; user gets exactly what they ask for).
/// 2. `device.usb_vid` + `device.usb_pid` (explicit USB target; matched against
///    serial enumeration first, then falls back to the `usb:` pseudo-target).
/// 3. Cached-serial-number lookup from the last successful autodetect.
/// 4. Scored serial-port candidates, with an MDL probe to confirm the winner
///    is actually a scanner before committing.
/// 5. Direct USB probe for known Uniden VID/PIDs (macOS no-CDC-bind fallback).
pub fn resolve_serial_port(cfg: &Config) -> Option<String> {
    let baud = cfg.device.baud.unwrap_or(115200);

    if let Some(port) = cfg.device.port.clone() {
        if !port.is_empty() {
            return Some(port);
        }
    }

    // VID/PID-configured path: try matching a serial TTY first, otherwise fall back
    // to the USB pseudo-target so the poll loop uses direct bulk endpoints. Runs even
    // when auto_detect is false or no serial candidates exist (macOS sometimes
    // enumerates the device at the USB level without binding AppleUSBCDCACMData).
    if let (Some(vid), Some(pid)) = (cfg.device.usb_vid, cfg.device.usb_pid) {
        if let Ok(ports) = serialport::available_ports() {
            for p in ports.iter().filter(|p| !is_blocked_port(p)) {
                if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                    if info.vid == vid && info.pid == pid {
                        return Some(p.port_name.clone());
                    }
                }
            }
        }
        return Some(format!("usb:{:04x}:{:04x}", vid, pid));
    }

    if !cfg.device.auto_detect {
        return None;
    }

    let available: Vec<_> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !is_blocked_port(p))
        .collect();

    // Cached-serial-number step: if we've successfully identified a scanner
    // in a previous session and it's still plugged in, prefer it. Lets the
    // user keep multiple Uniden scanners attached without surprises.
    if let Some(cache) = load_last_scanner_cache() {
        for p in &available {
            if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                if info.serial_number.as_deref() == Some(cache.serial_number.as_str())
                    && probe_mdl_on_port(&p.port_name, baud).is_some()
                {
                    debug!(
                        "resolved scanner via cached serial number {}: {}",
                        cache.serial_number, p.port_name
                    );
                    return Some(p.port_name.clone());
                }
            }
        }
    }

    // Scored-and-MDL-probed step: score the available ports, then in
    // descending score order, MDL-probe each candidate. The first one that
    // replies with a valid `MDL,<model>` we accept (per ACCEPTED_MDL_MODELS).
    // If no candidate responds, fall through to the USB-direct probe so
    // macOS no-CDC-bind still works.
    let mut scored: Vec<(i32, String)> = available
        .iter()
        .filter_map(|p| score_port(p).map(|score| (score, p.port_name.clone())))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    for (score, name) in &scored {
        if *score <= 0 {
            break;
        }
        if probe_mdl_on_port(name, baud).is_some() {
            return Some(name.clone());
        }
    }

    // Second-pass: probe USB directly for any known Uniden scanner. This is
    // the path hit when macOS sees the device but never binds
    // AppleUSBCDCACMData, leaving no /dev/cu.usbmodem* serial node.
    if let Some((vid, pid)) = probe_known_scanner_via_usb() {
        return Some(format!("usb:{:04x}:{:04x}", vid, pid));
    }

    None
}

/// Walk rusb's device list and return the first VID/PID matching a known
/// Uniden scanner. Returns None on enumeration error or no match.
fn probe_known_scanner_via_usb() -> Option<(u16, u16)> {
    use rusb::UsbContext;
    let ctx = rusb::Context::new().ok()?;
    let devices = ctx.devices().ok()?;
    for dev in devices.iter() {
        let Ok(desc) = dev.device_descriptor() else {
            continue;
        };
        for &(vid, pid) in KNOWN_SCANNER_USB_IDS {
            if desc.vendor_id() == vid && desc.product_id() == pid {
                return Some((vid, pid));
            }
        }
    }
    None
}

fn is_blocked_port(p: &serialport::SerialPortInfo) -> bool {
    let n = p.port_name.to_lowercase();
    if n.contains("debug-console") || n.contains("bluetooth") || n.contains("incoming-port") {
        return true;
    }
    if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
        let product = info.product.as_deref().unwrap_or_default().to_lowercase();
        if product.contains("bluetooth") || product.contains("debug") {
            return true;
        }
    }
    false
}

fn score_port(p: &serialport::SerialPortInfo) -> Option<i32> {
    let n = p.port_name.to_lowercase();
    let mut score = 0;
    match &p.port_type {
        serialport::SerialPortType::UsbPort(info) => {
            score += 20;
            let product = info.product.as_deref().unwrap_or_default().to_lowercase();
            let manufacturer = info
                .manufacturer
                .as_deref()
                .unwrap_or_default()
                .to_lowercase();
            if product.contains("uniden") || manufacturer.contains("uniden") {
                score += 100;
            }
            if product.contains("usb") {
                score += 10;
            }
        }
        _ => {}
    }
    if n.contains("usbmodem")
        || n.contains("usbserial")
        || n.contains("/dev/cu.usb")
        || n.contains("/dev/tty.usb")
    {
        score += 30;
    }
    if n.contains("soundcore") {
        score -= 50;
    }
    Some(score)
}

/// Briefly open a serial port, send `MDL\r`, and return the model name if
/// the response is a known Uniden scanner. Used by the autodetect path to
/// avoid committing to a port that scored well but isn't actually our
/// hardware (e.g. an unrelated USB-serial device).
///
/// Best-effort and tolerant: any open/read/parse failure returns None so
/// the caller falls through to the next candidate. Does **not** assert DTR
/// (per Phase 9b) and uses a 500 ms read timeout (default).
fn probe_mdl_on_port(port_name: &str, baud: u32) -> Option<String> {
    use crate::transport::SerialTransport;
    let transport = SerialTransport::new(port_name, baud);
    let mut port = transport.open().ok()?;
    let response = transport.send(port.as_mut(), "MDL").ok()?;
    let model = crate::protocol::parse_mdl_response(&response)?;
    if ACCEPTED_MDL_MODELS
        .iter()
        .any(|known| model.eq_ignore_ascii_case(known))
    {
        debug!("MDL probe on {}: matched model {}", port_name, model);
        Some(model)
    } else {
        debug!(
            "MDL probe on {}: model {:?} not in accepted list",
            port_name, model
        );
        None
    }
}

/// On-disk record of the most-recently-confirmed scanner. Lets autodetect
/// prefer the same physical unit across reconnects.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct LastScannerCache {
    /// USB serial number reported by `serialport::UsbPortInfo`. Stable per
    /// physical scanner unit; lets us distinguish two BC125ATs plugged into
    /// the same host.
    serial_number: String,
    /// Last-known port path (`/dev/cu.usbmodemXXX`, `COM3`, etc). Recorded
    /// for debugging; the serial number is the actual lookup key.
    port_name: String,
    /// Model returned by `MDL` when we last confirmed this unit.
    model: String,
}

fn last_scanner_cache_path() -> PathBuf {
    crate::api::default_data_dir().join(LAST_SCANNER_CACHE_FILE)
}

fn load_last_scanner_cache() -> Option<LastScannerCache> {
    let path = last_scanner_cache_path();
    let mut file = fs::File::open(&path).ok()?;
    let mut buf = String::new();
    file.read_to_string(&mut buf).ok()?;
    match serde_json::from_str::<LastScannerCache>(&buf) {
        Ok(cache) => Some(cache),
        Err(e) => {
            warn!("ignoring malformed scanner cache at {:?}: {}", path, e);
            None
        }
    }
}

/// Persist the most-recently-confirmed scanner so a future startup can
/// prefer it. Called from `update_device_info_from_mdl` in the poll loop
/// once MDL has confirmed a port works.
///
/// Best-effort: any I/O error is logged but not surfaced. The autodetect
/// path degrades gracefully to scoring + MDL-probe if the cache is missing
/// or unreadable.
pub fn save_last_scanner_cache(serial_number: &str, port_name: &str, model: &str) {
    let cache = LastScannerCache {
        serial_number: serial_number.to_string(),
        port_name: port_name.to_string(),
        model: model.to_string(),
    };
    let path = last_scanner_cache_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let json = match serde_json::to_string_pretty(&cache) {
        Ok(s) => s,
        Err(e) => {
            warn!("failed to serialise scanner cache: {}", e);
            return;
        }
    };
    match fs::File::create(&path) {
        Ok(mut file) => {
            if let Err(e) = file.write_all(json.as_bytes()) {
                warn!("failed to write scanner cache {:?}: {}", path, e);
            }
        }
        Err(e) => warn!("failed to create scanner cache {:?}: {}", path, e),
    }
}

/// Find the USB serial number for a port that was just confirmed via MDL.
/// Returns None if the port isn't a USB serial device or has no serial
/// number reported. Public so the poll loop can call it when committing
/// to a port.
pub fn usb_serial_for_port(port_name: &str) -> Option<String> {
    let ports = serialport::available_ports().ok()?;
    for p in ports {
        if p.port_name == port_name {
            if let serialport::SerialPortType::UsbPort(info) = p.port_type {
                return info.serial_number;
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_roundtrip_via_serde() {
        let cache = LastScannerCache {
            serial_number: "0001".to_string(),
            port_name: "/dev/cu.usbmodem14101".to_string(),
            model: "BC125AT".to_string(),
        };
        let json = serde_json::to_string(&cache).expect("serialize");
        let parsed: LastScannerCache = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.serial_number, "0001");
        assert_eq!(parsed.port_name, "/dev/cu.usbmodem14101");
        assert_eq!(parsed.model, "BC125AT");
    }

    #[test]
    fn malformed_cache_returns_none() {
        // Write garbage to the cache path and confirm load_last_scanner_cache
        // returns None instead of panicking. Uses test-mode default_data_dir.
        let path = last_scanner_cache_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&path, b"not json at all");
        assert!(load_last_scanner_cache().is_none());
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn accepted_models_includes_bc125at_family() {
        assert!(ACCEPTED_MDL_MODELS.contains(&"BC125AT"));
        assert!(ACCEPTED_MDL_MODELS.contains(&"BCT125AT"));
        assert!(ACCEPTED_MDL_MODELS.contains(&"UBC125XLT"));
    }
}
