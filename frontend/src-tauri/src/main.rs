#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Start Bearpaw Rust API server in a background thread (127.0.0.1:8000).
    // Frontend dev server proxies /api and /ws to this port.
    let state = bearpaw_api::default_state();
    let bind = "127.0.0.1:8000".to_string();
    let serial_port: Option<(String, u32)> = None; // TODO: from config or discovery
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
