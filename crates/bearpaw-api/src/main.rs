//! Standalone binary: run Bearpaw API server (no Tauri).
//! Usage: bearpaw --config config.yaml (config optional for Phase 1)

use bearpaw_api::{config::Config, default_state, run_server};
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::from_default_env().add_directive("bearpaw_api=info".parse()?))
        .init();

    let config = Config::default();
    let bind = format!("{}:{}", config.api.host, config.api.port);
    let state = default_state();

    run_server(&bind, state).await
}
