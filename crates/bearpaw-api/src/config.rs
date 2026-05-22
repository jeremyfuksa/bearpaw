//! Configuration for port, baud, API bind address.

use serde::Deserialize;
use std::fs;
use std::path::Path;

/// Known Uniden scanner USB IDs probed during plug-and-play autodetect.
/// All current entries are Uniden America Corp. (`0x1965`).
/// See docs/SCANNER_PROTOCOL_REFERENCE.md §1 for the list.
const KNOWN_SCANNER_USB_IDS: &[(u16, u16)] = &[
    (0x1965, 0x0017), // BC125AT, BCT125AT (shared PID)
                      // Other Uniden 125/126 family PIDs (0x0016–0x001A) can be added here
                      // as they're confirmed.
];

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
    pub transport: Option<String>,
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
            transport: None,
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
    if path.ends_with(".toml") {
        toml::from_str(&raw).unwrap_or_default()
    } else {
        serde_yaml::from_str(&raw).unwrap_or_default()
    }
}

/// Resolve serial port from config: explicit port first, then USB auto-detect.
pub fn resolve_serial_port(cfg: &Config) -> Option<String> {
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

    // First-pass: score available serial ports and pick the highest scorer
    // if any look like a Uniden USB-serial endpoint.
    let candidates: Vec<_> = serialport::available_ports()
        .unwrap_or_default()
        .into_iter()
        .filter(|p| !is_blocked_port(p))
        .collect();
    let mut scored: Vec<(i32, String)> = candidates
        .iter()
        .filter_map(|p| score_port(p).map(|score| (score, p.port_name.clone())))
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    if let Some((score, name)) = scored.first() {
        if *score > 0 {
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
