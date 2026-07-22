//! One-time hardware probe: settle two write-side behaviors on fw 1.06.06.
//!
//! Two open questions, neither yet captured on this hardware:
//!
//!   A. CHANNEL LOCKOUT 1->0. Clearing a channel's lockout via a plain CIN
//!      write (the current `set_channel_lockout_on_scanner` path) fails in the
//!      field: `POST /lockouts/channels/clear` logs `lockout write not
//!      persisted as sent index=469 wanted=false read_back=true` — the write
//!      gets CIN,OK but the read-back still shows lockout=1. This is the SAME
//!      signature as the priority 1->0 refusal (audit-reconciliation.md,
//!      2026-07-21), but lockout is a different field and has never been probed:
//!      the cin-write-order-probe only ever wrote lockout=0 onto an already-0
//!      channel, never a real 1->0 downgrade. This probe tests whether the
//!      firmware guards the lockout 1->0 transition like it guards priority, and
//!      if so whether DCH+recreate clears it (priority's fix).
//!
//!   B. KEY BEEP "on" wire value. The Device tab toggle sends `KBP,1` for "on"
//!      and `KBP,99` for "off" (frontend applyKeyBeep). The decompiled reference
//!      (BC125AT_PROTOCOL.md §7.7) says key-beep ON = wire `0` (Auto), OFF = `99`
//!      — it never mentions `1`. In the field the toggle "does nothing" (moves,
//!      no error, beep unchanged), consistent with the scanner ignoring `KBP,1`.
//!      This probe writes 1, 0, and 99 in turn and reads each back to learn the
//!      canonical "on" value and whether `1` is honored, normalized, or dropped.
//!
//! Both are read-back-driven: we only trust what CIN / KBP report after a write.
//!
//! Run with the backend STOPPED (exclusive USB access):
//!   cargo run -p bearpaw-api --example lockout_keybeep_probe
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

    // lockout is field 7 (0-indexed 6 after CIN,idx):
    // CIN,idx,name,freq,mod,tone,delay,lockout,priority => len 9, lockout at [7].
    let lockout_of = |cin: &str| -> Option<&'static str> {
        let f: Vec<&str> = cin.split(',').collect();
        match f.get(7).map(|s| s.trim()) {
            Some("1") => Some("1"),
            Some("0") => Some("0"),
            _ => None,
        }
    };
    // KBP reply is `KBP,<beep>,<keylock>`; return the beep field verbatim.
    let beep_of = |kbp: &str| -> Option<String> {
        let f: Vec<&str> = kbp.split(',').collect();
        f.get(1).map(|s| s.trim().to_string())
    };

    let mdl = send("MDL");
    assert!(mdl.starts_with("MDL,"), "not a BC125AT-family scanner");
    let ver = send("VER");

    // ===================================================================
    // PART B FIRST (KBP) — it needs program mode but no scratch channel, and
    // it's the lower-risk of the two. Record the beep field's original value so
    // we can restore it exactly.
    // ===================================================================
    send("PRG");
    let kbp_orig = send("KBP");
    let beep_orig = beep_of(&kbp_orig).unwrap_or_else(|| "0".to_string());
    let lock_orig = {
        let f: Vec<&str> = kbp_orig.split(',').collect();
        f.get(2).map(|s| s.trim().to_string()).unwrap_or_else(|| "0".to_string())
    };
    println!("--- KBP original: beep={beep_orig} keylock={lock_orig}");

    println!("\n=== PART B: KEY BEEP wire value ===");
    let mut kbp_results: Vec<(String, String)> = Vec::new();
    for probe_val in ["1", "0", "99"] {
        send(&format!("KBP,{probe_val},{lock_orig}"));
        let readback = beep_of(&send("KBP")).unwrap_or_else(|| "??".to_string());
        println!("    wrote beep={probe_val} -> read back beep={readback}");
        kbp_results.push((probe_val.to_string(), readback));
    }
    // Restore the original beep value.
    send(&format!("KBP,{beep_orig},{lock_orig}"));
    let kbp_restored = beep_of(&send("KBP")).unwrap_or_else(|| "??".to_string());
    println!("--- KBP restored to beep={kbp_restored} (wanted {beep_orig})");

    // ===================================================================
    // PART A (CHANNEL LOCKOUT 1->0). Still in program mode from PART B.
    // ===================================================================
    println!("\n=== PART A: CHANNEL LOCKOUT 1->0 ===");

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

    let read_lockout = |send: &mut dyn FnMut(&str) -> String| -> Option<&'static str> {
        let raw = send(&format!("CIN,{idx}"));
        lockout_of(&raw)
    };

    // Step 0: program the scratch channel with a test freq + lockout=1,
    // priority=0. 146.5200 MHz = 01465200; delay 2, lockout 1, priority 0.
    let set = send(&format!("CIN,{idx},LOCKPROBE,01465200,FM,0,2,1,0"));
    println!("set-lockout write reply: {set}");
    let after_set = read_lockout(&mut send);
    println!("lockout after set: {after_set:?}");
    if after_set != Some("1") {
        send(&format!("DCH,{idx}"));
        send("EPG");
        eprintln!(
            "FAILED to SET lockout=1 on scratch channel {idx} (got {after_set:?}); \
             cannot test clearing. Cleaned up."
        );
        std::process::exit(1);
    }

    let mut winner: Option<String> = None;

    // Candidate 1: plain CIN write with lockout=0 (this is the exact path the
    // failing /lockouts/channels/clear endpoint uses). Expected to be refused if
    // lockout mirrors priority.
    println!("\n[1] CIN lockout=0 (plain rewrite — current clear path):");
    send(&format!("CIN,{idx},LOCKPROBE,01465200,FM,0,2,0,0"));
    if read_lockout(&mut send) == Some("0") {
        winner = Some("CIN lockout=0 (plain rewrite)".into());
    }

    // Candidate 2: DCH (delete) then re-create with lockout=0 — priority's fix.
    // DCH restores factory-empty (lockout=0 for empty), so this writes a fresh
    // slot that never held lockout=1.
    if winner.is_none() {
        println!("\n[2] DCH then CIN with lockout=0 on the fresh slot:");
        send(&format!("DCH,{idx}"));
        send(&format!("CIN,{idx},LOCKPROBE,01465200,FM,0,2,0,0"));
        if read_lockout(&mut send) == Some("0") {
            winner = Some("DCH then CIN lockout=0 (recreate)".into());
        }
    }

    // Restore: scratch channel back to factory-empty.
    println!("\n=== RESTORE ===");
    send(&format!("DCH,{idx}"));
    let restored = send(&format!("CIN,{idx}"));
    send("EPG");

    println!();
    println!("=== RESULTS (fw {ver}) ===");
    println!("[B] KEY BEEP round-trips (wrote -> read back):");
    for (wrote, back) in &kbp_results {
        println!("      KBP,{wrote} -> {back}");
    }
    println!("    (ON is whichever value the scanner keeps and that is NOT 99.)");
    println!();
    println!("[A] LOCKOUT 1->0 clear mechanism:");
    match &winner {
        Some(w) => println!("      FOUND: {w}"),
        None => println!(
            "      NONE of the candidates cleared lockout. Inspect the raw log \
             above — lockout may need a front-panel KEY flow like priority did."
        ),
    }
    println!("scratch {idx} restored to: {restored}");
    assert!(
        restored.contains(",00000000,"),
        "RESTORE FAILED — scratch channel {idx} is not factory-empty!"
    );
}
