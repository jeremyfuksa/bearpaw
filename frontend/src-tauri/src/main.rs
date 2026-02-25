#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Start Bearpaw Rust API server in a background thread (127.0.0.1:8000).
    // Frontend dev server proxies /api and /ws to this port.
    let cfg = bearpaw_api::load_config(Some("../../backend/config.yaml"));
    let state = bearpaw_api::default_state();
    let bind = format!("{}:{}", cfg.api.host, cfg.api.port);
    let serial_port = bearpaw_api::resolve_serial_port(&cfg).map(|p| (p, cfg.device.baud.unwrap_or(115200)));
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("Tokio runtime");
        rt.block_on(async {
            let _ = bearpaw_api::run_server(&bind, state, serial_port).await;
        });
    });
    // Give the server a moment to bind
    std::thread::sleep(std::time::Duration::from_millis(200));

    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running bearpaw application");
}
