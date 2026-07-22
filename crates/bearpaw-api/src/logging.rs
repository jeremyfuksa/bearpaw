use std::path::PathBuf;

use tracing::Level;
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::Layer;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

pub struct LoggingGuard {
    _file_guard: WorkerGuard,
    _error_guard: WorkerGuard,
}

fn default_log_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BEARPAW_LOG_DIR") {
        return PathBuf::from(dir);
    }
    PathBuf::from("logs")
}

pub fn init_backend_logging(service_name: &str) -> Result<LoggingGuard, String> {
    let log_dir = default_log_dir();
    std::fs::create_dir_all(&log_dir)
        .map_err(|e| format!("failed to create log dir {}: {}", log_dir.display(), e))?;

    let backend_file = tracing_appender::rolling::daily(
        &log_dir,
        format!("{}-backend.log", service_name.to_lowercase()),
    );
    let backend_error_file = tracing_appender::rolling::daily(
        &log_dir,
        format!("{}-backend-error.log", service_name.to_lowercase()),
    );
    let (backend_writer, file_guard) = tracing_appender::non_blocking(backend_file);
    let (error_writer, error_guard) = tracing_appender::non_blocking(backend_error_file);

    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| {
        EnvFilter::new("bearpaw_api=warn,bearpaw_desktop=warn,axum=warn,tower_http=warn")
    });

    let stdout_layer = fmt::layer()
        .with_target(true)
        .with_thread_ids(true)
        .with_thread_names(true)
        .with_line_number(true)
        .with_file(true)
        .with_filter(filter.clone());

    let file_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_thread_names(true)
        .with_line_number(true)
        .with_file(true)
        .with_writer(backend_writer)
        .with_filter(filter);

    let error_file_layer = fmt::layer()
        .with_ansi(false)
        .with_target(true)
        .with_thread_ids(true)
        .with_thread_names(true)
        .with_line_number(true)
        .with_file(true)
        .with_writer(error_writer)
        .with_filter(tracing_subscriber::filter::filter_fn(|metadata| {
            *metadata.level() == Level::ERROR
        }));

    tracing_subscriber::registry()
        .with(stdout_layer)
        .with(file_layer)
        .with(error_file_layer)
        .try_init()
        .map_err(|e| format!("failed to init tracing subscriber: {}", e))?;

    std::panic::set_hook(Box::new(move |panic_info| {
        let location = panic_info
            .location()
            .map(|loc| format!("{}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_else(|| "unknown-location".to_string());
        tracing::error!("panic at {}: {}", location, panic_info);
    }));

    tracing::info!(
        service = %service_name,
        log_dir = %log_dir.display(),
        "backend logging initialized"
    );

    Ok(LoggingGuard {
        _file_guard: file_guard,
        _error_guard: error_guard,
    })
}
