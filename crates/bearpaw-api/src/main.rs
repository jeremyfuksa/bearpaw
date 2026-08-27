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
    let assert_dtr = cfg.device.assert_dtr_on_open;
    // Detection returns the rate that actually produced an MDL reply, which can
    // differ from `device.baud` -- the BC75XLT speaks 57600 where the BC125AT
    // family speaks 115200. Using the configured rate here would reopen at a
    // rate detection just proved wrong.
    let serial = config::resolve_scanner_port(&cfg).map(|r| (r.port_name, r.baud, assert_dtr));

    run_server(&bind, state, serial).await
}
