//! Phase 1 wire capture: connect to BC125AT via direct USB (rusb), issue a
//! sequence of commands, and dump raw responses to stdout for fixture creation.
//!
//! Run:
//!   cargo run -p bearpaw-api --example wire_capture > docs/wire_captures/DATE/raw.txt
//!
//! The output is intentionally machine-greppable: each command is preceded by
//! "==> CMD\r" and the response by "<== <bytes>\r" with `\r` and non-printable
//! bytes shown in `\xNN` form so we can see the actual wire shape.

use bearpaw_api::transport_usb::{UsbSession, UsbTransport};
use std::thread;
use std::time::Duration;

const VID: u16 = 0x1965;
const PID: u16 = 0x0017;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let transport = UsbTransport::new(VID, PID);
    let mut session = transport.open()?;

    eprintln!("USB opened: {:04x}:{:04x}", VID, PID);

    // Identification
    capture(&transport, &mut session, "MDL", false);
    capture(&transport, &mut session, "VER", false);

    // Live state, multiple samples under whatever conditions the scanner is in.
    for i in 0..5 {
        eprintln!("--- sample {} ---", i + 1);
        capture(&transport, &mut session, "STS", true);
        capture(&transport, &mut session, "GLG", false);
        capture(&transport, &mut session, "PWR", false);
        thread::sleep(Duration::from_millis(500));
    }

    // Volume and squelch settings
    capture(&transport, &mut session, "VOL", false);
    capture(&transport, &mut session, "SQL", false);

    // Programming mode: read first 5 channels and bank mask
    capture(&transport, &mut session, "PRG", false);
    thread::sleep(Duration::from_millis(120));
    for ch in 1..=5 {
        capture(&transport, &mut session, &format!("CIN,{}", ch), false);
    }
    capture(&transport, &mut session, "SCG", false);
    capture(&transport, &mut session, "SSG", false);
    capture(&transport, &mut session, "EPG", false);

    Ok(())
}

fn capture(transport: &UsbTransport, session: &mut UsbSession, cmd: &str, multiline: bool) {
    println!("==> {}", escape(cmd.as_bytes()));
    let result = if multiline {
        transport.send_and_read_multiline(session, cmd)
    } else {
        transport.send(session, cmd)
    };
    match result {
        Ok(resp) => println!("<== {}", escape(resp.as_bytes())),
        Err(e) => println!("<!! {}", e),
    }
    println!();
}

fn escape(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        match b {
            b'\r' => out.push_str("\\r"),
            b'\n' => out.push_str("\\n"),
            b'\t' => out.push_str("\\t"),
            0x20..=0x7E => out.push(b as char),
            other => out.push_str(&format!("\\x{:02x}", other)),
        }
    }
    out
}
