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
    // Prefer VID/PID match when configured.
    if let (Some(vid), Some(pid)) = (cfg.device.usb_vid, cfg.device.usb_pid) {
        for p in &ports {
            if let serialport::SerialPortType::UsbPort(info) = &p.port_type {
                if info.vid == vid && info.pid == pid {
                    return Some(p.port_name.clone());
                }
            }
        }
    }
    // Fallback to first USB port, then first available port.
    for p in &ports {
        if matches!(p.port_type, serialport::SerialPortType::UsbPort(_)) {
            return Some(p.port_name.clone());
        }
    }
    ports.first().map(|p| p.port_name.clone())
}
