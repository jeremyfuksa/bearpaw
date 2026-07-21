//! One-time hardware probe: find how to CLEAR a channel's priority flag.
//!
//! Established facts (docs/wire_captures/2026-05-21/audit-reconciliation.md,
//! 2026-07-21 finding): a CIN write can SET priority (false->true) but CANNOT
//! clear it (true->false is refused — the scanner keeps priority=1). Yet banks
//! CAN have zero priority channels (banks 2/3 on this unit do), so a clear
//! mechanism exists that is NOT the CIN priority field. This probe hunts it.
//!
//! Method: pick an EMPTY scratch channel (490-500), program it with a test
//! frequency and priority=1, confirm the set stuck, then try each candidate
//! clear mechanism in order (safest first), reading back after each. Stops at
//! the first that reads back priority=0. Restores the scratch channel to
//! factory-empty (DCH) at the end, and exits program mode even on failure.
//!
//! Run with the backend STOPPED (exclusive USB access):
//!   cargo run -p bearpaw-api --example priority_clear_probe
//!
//! Record the result in docs/wire_captures/ and audit-reconciliation.md.

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

    // priority is field 8 (0-indexed 7 after CIN,idx): name,freq,mod,tone,delay,lockout,priority
    let priority_of = |cin: &str| -> Option<&'static str> {
        let f: Vec<&str> = cin.split(',').collect();
        // CIN,idx,name,freq,mod,tone,delay,lockout,priority => len 9
        match f.get(8).map(|s| s.trim()) {
            Some("1") => Some("1"),
            Some("0") => Some("0"),
            _ => None,
        }
    };

    let mdl = send("MDL");
    assert!(mdl.starts_with("MDL,"), "not a BC125AT-family scanner");
    let ver = send("VER");

    send("PRG");

    // Find an empty scratch channel, scanning down from 500.
    let mut scratch: Option<u16> = None;
    for idx in (490..=500).rev() {
        let raw = send(&format!("CIN,{idx}"));
        if raw.contains(",00000000,") {
            scratch = Some(idx);
            break;
        }
    }
    let Some(idx) = scratch else {
        send("EPG");
        eprintln!("no empty channel found in 490-500; aborting untouched");
        std::process::exit(1);
    };
    println!("--- using empty scratch channel {idx}");

    // Helper: read CH idx and return its priority slot.
    let read_priority = |send: &mut dyn FnMut(&str) -> String| -> Option<&'static str> {
        let raw = send(&format!("CIN,{idx}"));
        priority_of(&raw)
    };

    // Step 0: program the scratch channel with a test freq + priority=1.
    // 146.5200 MHz = 01465200; delay 2, lockout 0, priority 1.
    let set = send(&format!("CIN,{idx},PRIPROBE,01465200,FM,0,2,0,1"));
    println!("set-priority write reply: {set}");
    let after_set = read_priority(&mut send);
    println!("priority after set: {after_set:?}");
    if after_set != Some("1") {
        // If we can't even set priority on a fresh channel, the whole premise
        // is wrong — bail loudly and clean up.
        send(&format!("DCH,{idx}"));
        send("EPG");
        eprintln!(
            "FAILED to SET priority on scratch channel {idx} (got {after_set:?}); \
             cannot test clearing. Cleaned up."
        );
        std::process::exit(1);
    }

    println!();
    println!("=== CLEAR CANDIDATES (each followed by a read-back) ===");
    let mut winner: Option<String> = None;

    // Candidate 1: plain CIN write with priority=0 (baseline — expected to fail,
    // confirms the refusal reproduces in this probe).
    println!("\n[1] CIN priority=0 (baseline, expected refused):");
    send(&format!("CIN,{idx},PRIPROBE,01465200,FM,0,2,0,0"));
    if read_priority(&mut send) == Some("0") {
        winner = Some("CIN priority=0 (plain rewrite)".into());
    }

    // Candidate 2: DCH (delete) then re-create with priority=0. DCH restores
    // factory-empty (priority=1 for empty!), so this tests whether re-writing a
    // freshly-deleted slot with priority=0 sticks (fresh channel, no prior 1).
    if winner.is_none() {
        println!("\n[2] DCH then CIN with priority=0 on the fresh slot:");
        send(&format!("DCH,{idx}"));
        send(&format!("CIN,{idx},PRIPROBE,01465200,FM,0,2,0,0"));
        if read_priority(&mut send) == Some("0") {
            winner = Some("DCH then CIN priority=0 (recreate)".into());
        } else {
            // Re-establish priority=1 for the remaining candidates.
            send(&format!("CIN,{idx},PRIPROBE,01465200,FM,0,2,0,1"));
            println!("re-set priority=1: {:?}", read_priority(&mut send));
        }
    }

    // Candidate 3: KEY-menu emulation of "Set Priority -> Priority Off".
    // Path (manual p.41): Hold, enter channel, Pgm/E (menu), scroll to
    // "Set Priority", E, scroll to "Priority Off", E. We must EXIT program mode
    // first (KEY is an operational command; the menu is a front-panel flow).
    // This is the riskiest candidate — blind scroll counts can land on the
    // wrong menu item — so it runs last and we verify + restore carefully.
    if winner.is_none() {
        println!("\n[3] KEY-menu emulation (Priority Off via front panel):");
        println!("    NOTE: blind menu navigation; verify the read-back carefully.");
        send("EPG"); // leave program mode for the KEY flow
                     // Hold, then enter the channel digits.
        send("KEY,H,P");
        for d in idx.to_string().chars() {
            send(&format!("KEY,{d},P"));
        }
        // Enter the channel menu.
        send("KEY,E,P");
        // Scroll to "Set Priority". Menu order is not documented; we step down a
        // few times and rely on the read-back to tell us if we guessed wrong.
        // (If this candidate is needed, we'll refine the scroll count from the
        // physical menu order the user reports.)
        send("KEY,V,P");
        send("KEY,E,P");
        // Toggle to "Priority Off" (scroll once) and confirm.
        send("KEY,V,P");
        send("KEY,E,P");
        // Back out to a safe state.
        send("KEY,S,P"); // return to scan
        send("PRG");
        if read_priority(&mut send) == Some("0") {
            winner = Some("KEY-menu Priority Off (front-panel emulation)".into());
        }
    }

    // Restore: scratch channel back to factory-empty.
    println!("\n=== RESTORE ===");
    send("PRG");
    send(&format!("DCH,{idx}"));
    let restored = send(&format!("CIN,{idx}"));
    send("EPG");

    println!();
    println!("=== RESULTS (fw {ver}) ===");
    match &winner {
        Some(w) => println!("PRIORITY CLEAR MECHANISM FOUND: {w}"),
        None => println!(
            "NO clear mechanism found among candidates. \
             Priority may be front-panel-menu only with an undiscovered scroll \
             path, or a separate list command. Inspect the raw log above."
        ),
    }
    println!("scratch {idx} restored to: {restored}");
    assert!(
        restored.contains(",00000000,"),
        "RESTORE FAILED — scratch channel {idx} is not factory-empty!"
    );
}
