//! Hardware probe: capture the Close Call (`CLC`) mode digit mapping.
//!
//! Origin (#241): the app mapped wire mode `1 = DND / 2 = Priority` while both
//! protocol references said `1 = Priority / 2 = DND` (docs/BC125AT_PROTOCOL.md
//! §7.6 and its CLC field table), and no `CLC` capture existed to break the tie.
//! Captures on 2026-08-03 settled it in the references' favour; the app's map
//! was inverted and was fixed in PR #337.
//!
//! This probe is kept as the reusable template for any "which digit means which
//! label" question (see #341 for the same question on `PRI`).
//!
//! Method: READ-ONLY. This probe never writes to the scanner. The operator sets
//! Close Call mode from the radio's own keypad, and the probe reads `CLC` back
//! and reports the mode digit the hardware actually returns. Doing it from the
//! keypad (not via a `CLC` write) is the whole point — a write would only prove
//! the scanner echoes back whatever digit we sent, which tells us nothing about
//! which digit means which mode.
//!
//! ALL THREE modes are prompted (Priority, DND, Off) — the baseline read is not
//! a substitute for probing Off. The first 2026-08-03 capture started from a
//! baseline that already held the mode being tested, so that step observed no
//! transition and the finding leaned on elimination. Every mode here is entered
//! from a different one, so every reading is a real transition. Off is prompted
//! LAST for the same reason: entering it from DND guarantees a transition no
//! matter where the operator started.
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
///
/// Verified on hardware 2026-08-03 (fw 1.06.06): this sequence successfully
/// changed the mode, confirmed by the wire read moving 1 -> 2 for `CC DND`
/// (docs/wire_captures/2026-08-03/clc-mode-probe.txt). Not guesswork — but the
/// menu wording can differ across firmware, so trust the radio's display over
/// this text if they disagree.
const KEYPAD_STEPS: &str = "      1. Press [Func] then [Close Call] (the .../CC key) to open the CC menu.
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
    //
    // NOT a probe step: this is whatever the radio happened to be left in, so
    // it proves nothing about which digit means which mode. Every mode below is
    // prompted explicitly — see the ordering note there.
    let baseline = read_clc_mode(&mut send);
    println!(
        "--- baseline CC mode digit (before any changes, NOT a probe step): {}",
        baseline.as_deref().unwrap_or("<unparsed>")
    );

    // Probe each mode by NAME as the radio's own menu labels it. The digit is
    // what we're trying to learn, so it must never appear in the prompt.
    //
    // Order is deliberate: Off LAST. If Off were prompted first and the radio
    // already sat in Off, that step would observe no transition and would be
    // consistent with "the mode never changed" — the exact weakness that made
    // the first 2026-08-03 capture lean on elimination. Entering Off from DND
    // guarantees a real transition no matter where the operator started.
    let priority = probe_mode(&mut send, "CC Priority");
    let dnd = probe_mode(&mut send, "CC DND");
    let off = probe_mode(&mut send, "CC Off");

    println!();
    println!("=== RESULTS (fw {ver}) ===");
    for (label, digit) in [
        ("CC Priority", &priority),
        ("CC DND", &dnd),
        ("CC Off", &off),
    ] {
        println!(
            "keypad `{label:<11}` -> wire mode digit {}",
            digit.as_deref().unwrap_or("<unparsed>")
        );
    }
    println!();

    // Every mode must have parsed AND all three must be distinct. A duplicate
    // means a menu step silently didn't take (the radio stayed where it was),
    // which is the most likely operator error and must not read as a result.
    let all: Vec<Option<&str>> = vec![priority.as_deref(), dnd.as_deref(), off.as_deref()];
    let parsed: Vec<&str> = all.iter().flatten().copied().collect();
    let mut distinct = parsed.clone();
    distinct.sort_unstable();
    distinct.dedup();

    if parsed.len() != 3 {
        println!("VERDICT: INCONCLUSIVE — a mode did not parse.");
        println!("  => Inspect the raw CLC replies above; re-run.");
    } else if distinct.len() != 3 {
        println!("VERDICT: INCONCLUSIVE — two modes reported the SAME digit.");
        println!("  => A menu step almost certainly didn't take: the radio stayed");
        println!("     where it was. Re-run and confirm the display shows the");
        println!("     requested mode before pressing Enter at each prompt.");
    } else {
        match (priority.as_deref(), dnd.as_deref(), off.as_deref()) {
            (Some("1"), Some("2"), Some("0")) => {
                println!("VERDICT: 0 = Off, 1 = Priority, 2 = DND — matches the REFERENCES.");
                println!("  => Confirms the shipped mapping in DeviceTab.tsx");
                println!("     (CLOSE_CALL_MODE_TO_WIRE). No code change needed.");
            }
            (Some("2"), Some("1"), Some("0")) => {
                println!("VERDICT: 0 = Off, 2 = Priority, 1 = DND — CONTRADICTS the shipped map.");
                println!("  => The Priority/DND fix from #241 would be wrong for this");
                println!("     firmware. Do NOT ignore this: re-run to confirm, then");
                println!("     flip CLOSE_CALL_MODE_TO_WIRE and record it in");
                println!("     audit-reconciliation.md.");
            }
            (p, d, o) => {
                println!("VERDICT: UNEXPECTED mapping (Priority={p:?}, DND={d:?}, Off={o:?}).");
                println!("  => All three are distinct, so the menu steps took — but this");
                println!("     is not a mapping either reference predicts. Capture it");
                println!("     verbatim and reconcile before changing any code.");
            }
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
