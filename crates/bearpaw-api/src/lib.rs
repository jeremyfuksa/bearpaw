//! Bearpaw backend API: serial transport, Uniden protocol, REST + WebSocket.
//!
//! Used by the Tauri desktop app (in-process server) or as a standalone binary.

pub mod api;
pub mod config;
pub mod logging;
pub mod protocol;
pub mod state;
pub mod transport;
pub mod transport_usb;

pub use api::{default_state, run_server, spawn_poll_loop};
pub use config::{load_config, resolve_serial_port, Config};
pub use logging::{init_backend_logging, LoggingGuard};
pub use state::{DeviceInfo, LiveState};
pub use transport::SerialTransport;
pub use transport_usb::UsbTransport;
