//! One-time hardware probe: settle the CIN **write-side** field order.
//!
//! The decompiled reference (`docs/BC125AT_PROTOCOL.md`) claims the CIN write
//! order swaps delay/lockout relative to the read order. Our captures confirm
//! the READ order on fw 1.06.06 (`..., tone, delay, lockout, priority`) but
//! are silent on writes — which is why CIN writes were deferred by the audit
//! (docs/SCANNER_PROTOCOL_REFERENCE.md §4).
//!
//! Method: find an empty channel, write a probe payload whose delay-slot and
//! lockout-slot values are valid under BOTH orderings but distinguishable on
//! read-back (delay-slot=1, lockout-slot=0), read it back with the known read
//! order, and see which slot each value landed in. Restores the original
//! channel afterwards and exits program mode even on failure.
//!
//! Run with the backend STOPPED (exclusive USB access):
//!   cargo run -p bearpaw-api --example cin_write_probe
//!
//! Result recorded in docs/wire_captures/ and
//! docs/wire_captures/2026-05-21/audit-reconciliation.md.

use bearpaw_api::transport_usb::UsbTransport;

const VID: u16 = 0x1965;
const PID: u16 = 0x0017;

fn main() {
    let transport = UsbTransport::new(VID, PID);
    let mut session = match transport.open() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("open failed: {e}");
            std::process::exit(1);
        }
    };
    let mut send = |cmd: &str| -> String {
        let reply = transport
            .send(&mut session, cmd)
            .unwrap_or_else(|e| panic!("send {cmd} failed: {e}"));
        println!("==> {cmd}");
        println!("<== {}", reply.trim());
        reply.trim().to_string()
    };

    let mdl = send("MDL");
    assert!(mdl.starts_with("MDL,"), "not a BC125AT-family scanner");
    let ver = send("VER");

    // Find an empty scratch channel, scanning down from 500.
    send("PRG");
    let mut scratch: Option<(u16, String)> = None;
    for idx in (490..=500).rev() {
        let raw = send(&format!("CIN,{idx}"));
        // Empty channels read back with frequency 00000000.
        if raw.contains(",00000000,") {
            scratch = Some((idx, raw));
            break;
        }
    }
    let Some((idx, original)) = scratch else {
        send("EPG");
        eprintln!("no empty channel found in 490-500; aborting untouched");
        std::process::exit(1);
    };
    println!("--- scratch channel {idx}; original: {original}");

    // Probe: tone-slot=76 (100.0 Hz), delay-slot=1, lockout-slot=0.
    // Both 0 and 1 are valid for delay AND lockout, so the write succeeds
    // under either ordering; the read-back (known order: tone, delay,
    // lockout, priority) shows which slot each value landed in.
    let write = send(&format!("CIN,{idx},WRTPROBE,01462500,FM,76,1,0,0"));
    let readback = send(&format!("CIN,{idx}"));

    // Restore. An originally-empty channel (freq 00000000) is recreated with
    // DCH — rewriting its payload does NOT work, because the empty name field
    // means "unchanged" on the wire (empirically confirmed by this probe's
    // first run: the restore write left "WRTPROBE" in place). For a populated
    // original, rewrite it with any empty name normalised to 16 spaces (the
    // documented "clear" encoding).
    let restored = if original.contains(",00000000,") {
        send(&format!("DCH,{idx}"));
        send(&format!("CIN,{idx}"))
    } else {
        let original_payload = original
            .strip_prefix(&format!("CIN,{idx},"))
            .unwrap_or(&original)
            .to_string();
        send(&format!("CIN,{idx},{original_payload}"));
        send(&format!("CIN,{idx}"))
    };
    send("EPG");

    println!();
    println!("=== RESULTS (fw {ver}) ===");
    println!("write reply : {write}");
    println!("read-back   : {readback}");
    println!("restored    : {restored} (original: {original})");
    let fields: Vec<&str> = readback.split(',').collect();
    // CIN,idx,name,freq,mod,tone,delay,lockout,priority
    if fields.len() >= 9 {
        let (tone, delay, lockout) = (fields[5], fields[6], fields[7]);
        println!("tone-slot={tone} delay-slot={delay} lockout-slot={lockout}");
        match (delay, lockout) {
            ("1", "0") => println!("VERDICT: write order == read order (tone, delay, lockout, priority)"),
            ("0", "1") => println!("VERDICT: write order SWAPS delay/lockout vs read order"),
            _ => println!("VERDICT: inconclusive — inspect raw lines above"),
        }
        println!(
            "tone round-trip: wrote code 76 (100.0 Hz), read back {}",
            tone
        );
    }
    assert_eq!(restored, original, "RESTORE FAILED — channel {idx} altered!");
}
