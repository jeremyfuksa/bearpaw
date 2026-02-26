# Backend Logging

The Rust backend now uses structured tracing with both console and rotating file output.

## Log Files

By default, logs are written to:

- `logs/bearpaw-backend.log` (standalone backend binary)
- `logs/bearpaw-backend-error.log` (standalone backend errors only)
- `logs/bearpaw-desktop-backend.log` (Tauri app backend)
- `logs/bearpaw-desktop-backend-error.log` (Tauri app backend errors only)

Files rotate daily.

## Configuration

Use environment variables:

- `BEARPAW_LOG_DIR` to override log directory.
- `RUST_LOG` to override log filtering.

Default filter:

`bearpaw_api=debug,bearpaw_desktop=info,axum=info,tower_http=info`

## What Is Logged

- Backend startup/shutdown and bind address.
- HTTP request/response tracing for API routes.
- Scanner command execution timing, response sizes, and failures.
- Poll loop warnings/errors.
- Panic hook output with file/line location.

