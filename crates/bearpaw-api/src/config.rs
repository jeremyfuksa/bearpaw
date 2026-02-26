//! Configuration for port, baud, API bind address.

use serde::Deserialize;
use std::fs;
use std::path::Path;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub device: DeviceConfig,
    #[serde(default)]
    pub api: ApiConfig,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct DeviceConfig {
    pub port: Option<String>,
    pub baud: Option<u32>,
    pub transport: Option<String>,
    #[serde(default = "default_auto_detect")]
    pub auto_detect: bool,
    pub usb_vid: Option<u16>,
    pub usb_pid: Option<u16>,
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
    if !cfg.device.auto_detect {
        return None;
    }
    let ports = serialport::available_ports().ok()?;
    let candidates: Vec<_> = ports.into_iter().filter(|p| !is_blocked_port(p)).collect();
    if candidates.is_empty() {
        return None;
    }

    // Prefer VID/PID match when configured. If configured but not present, do not
    // fall back to random ports (prevents opening debug/Bluetooth consoles).
    if let (Some(vid), Some(pid)) = (cfg.device.usb_vid, cfg.device.usb_pid) {
        for p in &candidates {
            if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                if info.vid == vid && info.pid == pid {
                    return Some(p.port_name.clone());
                }
            }
        }
        // macOS may expose the USB device without creating a serial TTY.
        // Return a USB pseudo-target so poll loop can use direct bulk endpoints.
        return Some(format!("usb:{:04x}:{:04x}", vid, pid));
    }

    // If transport is explicitly USB, require a USB-ish serial endpoint.
    let transport_usb = cfg
        .device
        .transport
        .as_deref()
        .map(|t| t.eq_ignore_ascii_case("usb"))
        .unwrap_or(false);

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
    if transport_usb {
        return None;
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
