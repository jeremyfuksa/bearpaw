//! Standalone binary: run Bearpaw API server (no Tauri).
//! Usage: bearpaw --config config.yaml

use bearpaw_api::{config, default_state, init_backend_logging, run_server};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _logging = init_backend_logging("bearpaw")
        .map_err(|e| format!("logging initialization failed: {}", e))?;

    let mut config_path: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--config" {
            config_path = args.next();
        }
    }

    let cfg = config::load_config(config_path.as_deref());
    let bind = format!("{}:{}", cfg.api.host, cfg.api.port);
    let state = default_state();
    let baud = cfg.device.baud.unwrap_or(115200);
    let assert_dtr = cfg.device.assert_dtr_on_open;
    let serial = config::resolve_serial_port(&cfg).map(|p| (p, baud, assert_dtr));

    run_server(&bind, state, serial).await
}
