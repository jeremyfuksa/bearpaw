//! HTTP/WebSocket origin and host hardening.
//!
//! Bearpaw binds to a loopback port and has no authentication, so the
//! browser-origin attacker is the primary threat: any page the user visits
//! can `fetch('http://127.0.0.1:8000/...')` cross-origin unless we both
//! restrict CORS to known-good frontend origins *and* reject requests whose
//! `Host` header is not a loopback name we expect. The second check closes
//! the DNS-rebinding path that would otherwise reach the API through an
//! attacker-controlled hostname.

use std::collections::HashSet;
use std::sync::Arc;

use axum::{
    extract::Request,
    http::{header, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use tower_http::cors::CorsLayer;

/// Frontend origins that may talk to the API. The Tauri webview origin
/// differs by platform (`tauri://localhost` on macOS/Linux,
/// `http(s)://tauri.localhost` on Windows). `localhost:5173` is the Vite
/// dev server.
const ALLOWED_ORIGINS: &[&str] = &[
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:5173",
];

pub(crate) fn cors_layer() -> CorsLayer {
    let origins: Vec<HeaderValue> = ALLOWED_ORIGINS
        .iter()
        .map(|s| s.parse().expect("static origin parses"))
        .collect();
    CorsLayer::new()
        .allow_origin(origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([header::CONTENT_TYPE])
}

/// Build the `Host` header allowlist for a given bind address. Browsers
/// rebound via DNS will send the attacker hostname, not a loopback name,
/// so anything outside this set gets a 400.
pub(crate) fn allowed_hosts_for_bind(bind: &str) -> Arc<HashSet<String>> {
    let port = bind
        .rsplit(':')
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(8000);
    let mut set = HashSet::new();
    set.insert(format!("127.0.0.1:{}", port));
    set.insert(format!("localhost:{}", port));
    set.insert(format!("[::1]:{}", port));
    set.insert(bind.to_ascii_lowercase());
    Arc::new(set)
}

pub(crate) async fn validate_host(
    allowed: Arc<HashSet<String>>,
    req: Request,
    next: Next,
) -> Response {
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_ascii_lowercase());
    match host {
        Some(h) if allowed.contains(&h) => next.run(req).await,
        _ => (StatusCode::BAD_REQUEST, "host_not_allowed").into_response(),
    }
}

/// Reject any character that would break the ASCII line protocol on the
/// wire. The BC125AT terminates commands on `\r`, so an embedded control
/// character in a user-supplied field (alpha tag, modulation, etc.) lets the
/// caller terminate the legitimate command early and inject a new one —
/// e.g. `\rCLR` to wipe channel memory from inside an open PRG bracket.
/// Restricting to printable ASCII (0x20..0x7E) plus excluding 0x7F also
/// matches what the device's keypad-driven alpha-tag editor can produce.
pub(crate) fn validate_wire_field(value: &str) -> Result<(), &'static str> {
    if value
        .chars()
        .any(|c| (c as u32) < 0x20 || (c as u32) >= 0x7F)
    {
        return Err("contains_control_char");
    }
    Ok(())
}

/// Last-line check in `send_raw_command`: a wire-bound command must not
/// contain its own terminator. This is defense-in-depth — every handler
/// that builds a command from user input should validate fields with
/// `validate_wire_field` first.
pub(crate) fn validate_wire_command(cmd: &str) -> Result<(), &'static str> {
    if cmd.bytes().any(|b| b == b'\r' || b == b'\n' || b == 0) {
        return Err("embedded_terminator");
    }
    Ok(())
}

/// Whether a WebSocket upgrade with this `Origin` header should be accepted.
/// `None` means no Origin header — browsers always send one for WS upgrades,
/// so absence implies a non-browser client, which we allow. Same allowlist
/// as the CORS layer.
pub(crate) fn ws_origin_allowed(origin: Option<&str>) -> bool {
    match origin {
        None => true,
        Some(o) => {
            let lower = o.to_ascii_lowercase();
            ALLOWED_ORIGINS.iter().any(|allowed| *allowed == lower)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_allowlist_covers_loopback_variants() {
        let allowed = allowed_hosts_for_bind("127.0.0.1:8000");
        assert!(allowed.contains("127.0.0.1:8000"));
        assert!(allowed.contains("localhost:8000"));
        assert!(allowed.contains("[::1]:8000"));
        assert!(!allowed.contains("evil.example:8000"));
    }

    #[test]
    fn host_allowlist_tracks_custom_port() {
        let allowed = allowed_hosts_for_bind("127.0.0.1:9090");
        assert!(allowed.contains("127.0.0.1:9090"));
        assert!(allowed.contains("localhost:9090"));
        assert!(!allowed.contains("127.0.0.1:8000"));
    }

    #[test]
    fn wire_field_rejects_control_chars() {
        assert!(validate_wire_field("CLEAN").is_ok());
        assert!(validate_wire_field("with space").is_ok());
        assert!(validate_wire_field("X\rCLR").is_err());
        assert!(validate_wire_field("X\nfoo").is_err());
        assert!(validate_wire_field("\x00null").is_err());
        // 0x7F (DEL) is not printable ASCII.
        assert!(validate_wire_field("hi\x7F").is_err());
        // Non-ASCII high bytes are out of the protocol's alphabet.
        assert!(validate_wire_field("café").is_err());
    }

    #[test]
    fn wire_command_rejects_terminators() {
        assert!(validate_wire_command("STS").is_ok());
        assert!(validate_wire_command("KEY,H,P").is_ok());
        assert!(validate_wire_command("KEY,\rCLR").is_err());
        assert!(validate_wire_command("KEY,A\nB").is_err());
        assert!(validate_wire_command("\0").is_err());
    }

    #[test]
    fn ws_origin_allows_known_frontends_and_missing() {
        assert!(ws_origin_allowed(None));
        assert!(ws_origin_allowed(Some("tauri://localhost")));
        assert!(ws_origin_allowed(Some("http://localhost:5173")));
        assert!(ws_origin_allowed(Some("HTTP://localhost:5173")));
        assert!(!ws_origin_allowed(Some("https://evil.example")));
        assert!(!ws_origin_allowed(Some("http://127.0.0.1:8000")));
    }
}
