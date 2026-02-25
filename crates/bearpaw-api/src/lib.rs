//! Bearpaw backend API: serial transport, Uniden protocol, REST + WebSocket.
//!
//! Used by the Tauri desktop app (in-process server) or as a standalone binary.

pub mod api;
pub mod config;
pub mod protocol;
pub mod scheduler;
pub mod state;
pub mod transport;

pub use api::{default_state, run_server, spawn_poll_loop};
pub use config::{load_config, resolve_serial_port, Config};
pub use state::{DeviceInfo, LiveState};
pub use transport::SerialTransport;
