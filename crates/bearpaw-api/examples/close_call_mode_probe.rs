//! One-time hardware probe: resolve the Close Call (`CLC`) mode digit mapping.
//!
//! Open question (#241): the app maps wire mode `1 = DND / 2 = Priority`
//! (frontend/src/app/components/views/DeviceTab.tsx), while both protocol
//! references say `1 = Priority / 2 = DND` (docs/BC125AT_PROTOCOL.md §7.6 and
//! its CLC field table). There is NO `CLC` capture in docs/wire_captures/, so
//! the references are second-source only and CLAUDE.md's captures-win rule
//! leaves this unresolvable from documents alone. If the references are right,
//! the two menu items are swapped on the wire.
//!
//! Method: READ-ONLY. This probe never writes to the scanner. The operator sets
//! Close Call mode from the radio's own keypad, and the probe reads `CLC` back
//! and reports the mode digit the hardware actually returns. Doing it from the
//! keypad (not via a `CLC` write) is the whole point — a write would only prove
//! the scanner echoes back whatever digit we sent, which tells us nothing about
//! which digit means which mode.
//!
//! Each read is its own PRG/EPG bracket, so the scanner is never sitting in
//! program mode while the operator works the keypad (the front panel is
//! unresponsive in program mode, and a bracket held open across an unbounded
//! human pause is exactly the wedge we don't want).
//!
//! Run with the backend STOPPED (exclusive USB access):
//!   cargo run -p bearpaw-api --example close_call_mode_probe
//!
//! Tee the output into a capture file, e.g.:
//!   cargo run -p bearpaw-api --example close_call_mode_probe \
//!     2>&1 | tee docs/wire_captures/$(date +%F)/clc-mode-probe.txt
//!
//! Record the verdict in docs/wire_captures/2026-05-21/audit-reconciliation.md.

use bearpaw_api::transport_usb::UsbTransport;
use std::io::{BufRead, Write};

const VID: u16 = 0x1965;
const PID: u16 = 0x0017;

/// Keypad path the operator follows for each mode, from the BC125AT manual's
/// Close Call menu. Printed verbatim in the prompt so the run is self-contained.
const KEYPAD_STEPS: &str = "\
      1. Press [Func] then [Close Call] (the .../CC key) to open the CC menu.
      2. Select `CC Mode` and press [E].
      3. Choose the mode named below, press [E] to confirm.
      4. Back out with [Scan/Srch] until the radio is scanning again.";

fn main() {
    let transport = UsbTransport::new(VID, PID);
    let mut session = match transport.open() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("open failed: {e}");
            eprintln!("(is the backend still running? it holds the USB handle exclusively)");
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

    println!();
    println!("=== Close Call mode probe (#241) ===");
    println!("READ-ONLY: this probe never writes scanner settings.");
    println!("You will set each mode on the KEYPAD; the probe reads CLC back.");

    // Read the starting mode so the operator can restore it at the end. This is
    // also the first proof that CLC parses the way settings.rs expects.
    let baseline = read_clc_mode(&mut send);
    println!(
        "--- baseline CC mode digit (before any changes): {}",
        baseline.as_deref().unwrap_or("<unparsed>")
    );

    // Probe each mode by NAME as the radio's own menu labels it. The digit is
    // what we're trying to learn, so it must never appear in the prompt.
    let priority = probe_mode(&mut send, "CC Priority");
    let dnd = probe_mode(&mut send, "CC DND");

    println!();
    println!("=== RESULTS (fw {ver}) ===");
    println!(
        "keypad `CC Priority` -> wire mode digit {}",
        priority.as_deref().unwrap_or("<unparsed>")
    );
    println!(
        "keypad `CC DND`      -> wire mode digit {}",
        dnd.as_deref().unwrap_or("<unparsed>")
    );
    println!();

    match (priority.as_deref(), dnd.as_deref()) {
        (Some("1"), Some("2")) => {
            println!("VERDICT: 1 = Priority, 2 = DND — matches the REFERENCES.");
            println!("  => The app's map is INVERTED. Fix #241: flip the four Record");
            println!("     literals in DeviceTab.tsx (read map ~240-244; write maps");
            println!("     ~497, ~516, ~548) so cc_priority=1 and cc_dnd=2.");
        }
        (Some("2"), Some("1")) => {
            println!("VERDICT: 2 = Priority, 1 = DND — matches the CURRENT APP.");
            println!("  => The app is correct and both references are wrong for this");
            println!("     hardware. Close #241 with no code change and record the");
            println!("     disagreement in audit-reconciliation.md.");
        }
        (a, b) => {
            println!("VERDICT: INCONCLUSIVE (Priority={a:?}, DND={b:?}).");
            println!("  => Unexpected/duplicate digits usually mean a menu step was");
            println!("     missed and the mode didn't actually change. Re-run and");
            println!("     confirm the radio's display shows the requested mode");
            println!("     before pressing Enter at each prompt.");
        }
    }

    println!();
    println!(
        "--- restore: set CC mode back to its original setting on the keypad \
         (baseline digit was {}).",
        baseline.as_deref().unwrap_or("<unparsed>")
    );
    println!("--- no scanner settings were written by this probe.");
}

/// Prompt the operator to select `label` on the keypad, then read the resulting
/// mode digit. Returns `None` if the reply didn't parse.
fn probe_mode(send: &mut dyn FnMut(&str) -> String, label: &str) -> Option<String> {
    println!();
    println!("--- STEP: set Close Call mode to `{label}` on the radio's keypad.");
    println!("{KEYPAD_STEPS}");
    println!("    Confirm the radio's display shows `{label}` before continuing.");
    wait_for_enter();
    let mode = read_clc_mode(send);
    println!(
        "--- `{label}` reads back as mode digit {}",
        mode.as_deref().unwrap_or("<unparsed>")
    );
    mode
}

/// Read `CLC` inside its own PRG/EPG bracket and return the mode field.
///
/// `CLC,<mode>,<alert_beep>,<alert_light>,<band>,<lockout>` — mode is the first
/// field after the echoed command, matching `get_close_call` in
/// crates/bearpaw-api/src/api/handlers/settings.rs.
///
/// The bracket is opened and closed per read so the scanner is never left in
/// program mode while the operator is at the keypad.
fn read_clc_mode(send: &mut dyn FnMut(&str) -> String) -> Option<String> {
    send("PRG");
    let raw = send("CLC");
    send("EPG");

    let fields: Vec<&str> = raw.split(',').collect();
    if fields.first().map(|s| s.trim()) != Some("CLC") {
        println!("--- WARNING: unexpected reply to CLC: {raw}");
        return None;
    }
    fields
        .get(1)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Block until the operator presses Enter. Reads stdin so the pause is explicit
/// rather than a fixed sleep the operator has to race.
fn wait_for_enter() {
    print!("    Press Enter when the radio is set... ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
}
