//! One-time hardware probe: settle the GLF global-lockout walk (#142).
//!
//! `docs/BC125AT_PROTOCOL.md` documents GLF as a bare-command cursor
//! iterator (send `GLF` repeatedly until `GLF,-1`), while Bearpaw's walk
//! sends parameterized `GLF,***` / `GLF,<value>` forms. This probe adds two
//! known lockouts, exercises both forms, removes the lockouts, and prints
//! what the firmware actually replies.
//!
//! Run with the backend STOPPED (exclusive USB access):
//!   cargo run -p bearpaw-api --example glf_walk_probe

use bearpaw_api::transport_usb::UsbTransport;

fn main() {
    let transport = UsbTransport::new(0x1965, 0x0017);
    let mut session = transport.open().expect("open");
    let mut send = |cmd: &str| -> String {
        let r = transport.send(&mut session, cmd).expect("send");
        println!("==> {cmd}\n<== {}", r.trim());
        r.trim().to_string()
    };

    send("MDL");
    send("VER");
    send("PRG");

    // Baseline: walk whatever is there with the documented bare form.
    println!("--- baseline walk (bare GLF, documented form) ---");
    let mut baseline = Vec::new();
    for _ in 0..110 {
        let r = send("GLF");
        if r.ends_with(",-1") || r == "-1" {
            break;
        }
        baseline.push(r);
    }
    println!("--- baseline lockouts: {baseline:?}");

    // Add two probe lockouts (462.5625 and 467.5625 MHz — FRS ch1/ch9,
    // harmless to lock out momentarily; removed below).
    println!("--- add probe lockouts ---");
    send("LOF,04625625");
    send("LOF,04675625");

    // Documented walk: bare GLF until -1.
    println!("--- bare-GLF walk with probes present ---");
    let mut seen = Vec::new();
    for _ in 0..110 {
        let r = send("GLF");
        if r.ends_with(",-1") || r == "-1" {
            break;
        }
        seen.push(r);
    }
    println!("--- walk saw: {seen:?}");

    // What do the parameterized forms (what Bearpaw currently sends) return?
    println!("--- parameterized forms (current Bearpaw behavior) ---");
    send("GLF,***");
    send("GLF,04625625");

    // Remove the probe lockouts, confirm the walk is back to baseline.
    println!("--- cleanup ---");
    send("ULF,04625625");
    send("ULF,04675625");
    let mut after = Vec::new();
    for _ in 0..110 {
        let r = send("GLF");
        if r.ends_with(",-1") || r == "-1" {
            break;
        }
        after.push(r);
    }
    send("EPG");

    println!();
    println!("=== RESULTS ===");
    println!("baseline: {baseline:?}");
    println!("with probes: {seen:?}");
    println!("after cleanup: {after:?}");
    assert_eq!(baseline, after, "CLEANUP FAILED — lockout list altered!");
}
