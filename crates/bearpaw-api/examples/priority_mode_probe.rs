//! Hardware probe: capture the Priority scan (`PRI`) mode digit mapping.
//!
//! Open question (#341): the wire accepts `PRI` modes 0-3
//! (Off/On/Plus/DND) per docs/BC125AT_PROTOCOL.md §7.5 and its command
//! summary (`PRI,<0|1|2|3>`), and the backend already validates `(0..=3)` in
//! api/handlers/settings.rs::set_priority. But the frontend models only 0-2 —
//! mode 3 (Priority DND) has no UI entry, so a radio left in that mode cannot
//! be seen or set from the app.
//!
//! There is NO `PRI` capture in docs/wire_captures/, so both sources above are
//! second-source only and CLAUDE.md's captures-win rule says a reference alone
//! is not authority to add a user-facing mapping. This probe produces the
//! missing ground truth.
//!
//! Sibling of close_call_mode_probe.rs, which resolved the same class of
//! question for `CLC` (#241). Every design decision here was paid for by that
//! probe getting it wrong first — see the ordering and transition notes below.
//!
//! PRECONDITION — at least one channel must be flagged priority. Field report
//! (2026-08-03): on a radio with none, selecting any priority mode shows
//! "Priority Scan: No Channel" and the selection does NOT stick, so every read
//! would return the unchanged digit and the run would be worthless. The probe
//! checks this read-only up front and aborts with instructions rather than
//! collecting meaningless data.
//!
//! It deliberately does NOT set the flag itself. Priority is bank-exclusive,
//! and per audit-reconciliation.md (2026-07-21) clearing it is refused in place
//! and needs a destructive DCH + full rewrite — so which channel to mutate is
//! the operator's call, not this probe's. That also keeps the probe read-only.
//!
//! Method: READ-ONLY. This probe never writes to the scanner. The operator sets
//! the priority mode from the radio's own keypad, and the probe reads `PRI`
//! back and reports the digit the hardware actually returns. Doing it from the
//! keypad (not via a `PRI` write) is the whole point — a write would only prove
//! the scanner echoes back whatever digit we sent, which tells us nothing about
//! which digit means which mode.
//!
//! ALL FOUR modes are prompted. The baseline read is NOT a substitute for
//! probing a mode: it is just wherever the operator left the radio, so it
//! proves nothing about which digit means what.
//!
//! Prompt order is COMPUTED from the baseline, not fixed. A step that starts
//! from the mode it is testing observes no transition, and a no-change read
//! cannot be distinguished from "the menu step silently didn't take." Whichever
//! mode the baseline already holds is therefore prompted LAST, so every step is
//! entered from a different mode. The CLC probe shipped twice with this bug
//! before it was caught, so the results section reports per-step transitions
//! explicitly rather than leaving a reader to reconstruct them from the log.
//!
//! Each read is its own PRG/EPG bracket, so the scanner is never sitting in
//! program mode while the operator works the keypad (the front panel is
//! unresponsive in program mode, and a bracket held open across an unbounded
//! human pause is exactly the wedge we don't want).
//!
//! Run with the backend STOPPED (exclusive USB access):
//!   cargo run -p bearpaw-api --example priority_mode_probe
//!
//! Tee the output into a capture file, e.g.:
//!   cargo run -p bearpaw-api --example priority_mode_probe \
//!     2>&1 | tee docs/wire_captures/$(date +%F)/pri-mode-probe.txt
//!
//! Record the verdict in docs/wire_captures/2026-05-21/audit-reconciliation.md.

use bearpaw_api::transport_usb::UsbTransport;
use std::io::{BufRead, Write};

const VID: u16 = 0x1965;
const PID: u16 = 0x0017;

/// The four modes as the radio's own menu labels them, in reference order
/// (Off/On/Plus/DND). The digit each maps to is what we're here to learn, so it
/// must never appear in a prompt.
const MODES: [&str; 4] = [
    "Priority Off",
    "Priority Scan (on)",
    "Priority Plus",
    "Priority DND",
];

/// Keypad path the operator follows for each mode, from the BC125AT manual's
/// priority menu. Printed verbatim in the prompt so the run is self-contained.
///
/// NOT hardware-verified — unlike the CLC probe's equivalent, no run has yet
/// confirmed this path on real hardware. Menu wording differs across firmware;
/// trust the radio's display over this text, and correct this constant if the
/// steps turn out wrong, since it becomes the record of how the capture was
/// taken.
const KEYPAD_STEPS: &str = "      1. Press [Func] then [1/Pri] to open the priority menu.
      2. Step through the priority modes with the rotary/arrow keys.
      3. Select the mode named below and press [E] to confirm.
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
    println!("=== Priority scan mode probe (#341) ===");
    println!("READ-ONLY: this probe never writes scanner settings.");
    println!("You will set each mode on the KEYPAD; the probe reads PRI back.");

    // PRECONDITION: at least one channel must be flagged priority.
    //
    // Field report (2026-08-03): selecting any priority mode on a radio with no
    // priority channel shows "Priority Scan: No Channel" and the mode does NOT
    // stick. Every probe step would then read back the unchanged digit and the
    // transition check would flag all four as NO TRANSITION — a wasted run that
    // looks like a hardware answer. Refuse to start instead.
    //
    // Checked read-only by walking CIN. We do NOT set the flag ourselves:
    // priority is bank-exclusive and, per audit-reconciliation.md (2026-07-21),
    // clearing it back is refused in place and needs a destructive DCH+rewrite.
    // Choosing which channel to mutate is the operator's call, not ours.
    if !has_priority_channel(&mut send) {
        println!();
        println!("ABORT: no channel is flagged priority on this scanner.");
        println!();
        println!("  The radio refuses to enter any priority mode without one —");
        println!("  it shows \"Priority Scan: No Channel\" and the menu selection");
        println!("  does not stick, so every reading below would be meaningless.");
        println!();
        println!("  Flag ONE channel priority first, then re-run:");
        println!("    - in Bearpaw: Channels tab -> edit a channel -> Priority");
        println!("    - or on the radio: Hold on the channel, [Func] + [1/Pri]");
        println!();
        println!("  Pick a channel you are happy to leave flagged: clearing the");
        println!("  flag afterwards is refused in place and needs a DCH + full");
        println!("  rewrite (see docs/wire_captures/2026-05-21/");
        println!("  audit-reconciliation.md, 2026-07-21 finding).");
        println!();
        println!("  Nothing was written; the scanner is untouched.");
        std::process::exit(1);
    }

    // Whatever the radio was left in. NOT a probe step — see the header.
    let baseline = read_pri_mode(&mut send);
    println!(
        "--- baseline priority digit (before any changes, NOT a probe step): {}",
        baseline.as_deref().unwrap_or("<unparsed>")
    );

    let order = probe_order(baseline.as_deref());
    println!(
        "--- probe order (baseline-last so every step is a transition): {}",
        order.join(" -> ")
    );

    let mut results: Vec<(&str, Option<String>)> = Vec::new();
    for label in &order {
        let digit = probe_mode(&mut send, label);
        results.push((label, digit));
    }
    let digit_for = |want: &str| -> Option<String> {
        results
            .iter()
            .find(|(label, _)| *label == want)
            .and_then(|(_, d)| d.clone())
    };

    println!();
    println!("=== RESULTS (fw {ver}) ===");
    for label in MODES {
        println!(
            "keypad `{label:<18}` -> wire mode digit {}",
            digit_for(label).as_deref().unwrap_or("<unparsed>")
        );
    }

    // State plainly whether each step actually moved the field. A step whose
    // read equals the state before it proves nothing on its own — that digit is
    // then pinned only by elimination. Say so here rather than leaving a reader
    // to reconstruct it, which is how the CLC captures shipped twice with an
    // unnoticed non-transition step.
    println!();
    println!("--- transition check (did each step actually move the field?) ---");
    let mut prev = baseline.clone();
    let mut weak: Vec<&str> = Vec::new();
    for label in &order {
        let digit = digit_for(label);
        match (prev.as_deref(), digit.as_deref()) {
            (Some(p), Some(d)) if p == d => {
                println!("  {label:<18}: {p} -> {d}  NO TRANSITION (pinned only by elimination)");
                weak.push(label);
            }
            (Some(p), Some(d)) => println!("  {label:<18}: {p} -> {d}  ok"),
            _ => println!("  {label:<18}: <unparsed>"),
        }
        if digit.is_some() {
            prev = digit;
        }
    }
    if weak.is_empty() {
        println!("  => all four digits directly observed.");
    } else {
        println!(
            "  => {} step(s) observed no transition: {}. Re-run starting from a\n     \
             different mode to observe those directly.",
            weak.len(),
            weak.join(", ")
        );
    }

    println!();
    let digits: Vec<Option<String>> = MODES.iter().map(|m| digit_for(m)).collect();
    let parsed: Vec<&str> = digits.iter().flatten().map(|s| s.as_str()).collect();
    let mut distinct = parsed.clone();
    distinct.sort_unstable();
    distinct.dedup();

    if parsed.len() != MODES.len() {
        println!("VERDICT: INCONCLUSIVE — a mode did not parse.");
        println!("  => Inspect the raw PRI replies above; re-run.");
        println!("  => If your radio has no `Priority DND` menu item at all, that is");
        println!("     itself the answer: record it and leave the UI at three modes.");
    } else if distinct.len() != MODES.len() {
        println!("VERDICT: INCONCLUSIVE — two modes reported the SAME digit.");
        println!("  => A menu step almost certainly didn't take: the radio stayed");
        println!("     where it was. Re-run and confirm the display shows the");
        println!("     requested mode before pressing Enter at each prompt.");
    } else {
        let expected = ["0", "1", "2", "3"];
        if parsed == expected {
            println!("VERDICT: 0 = Off, 1 = On, 2 = Plus, 3 = DND — matches the REFERENCES.");
            println!("  => Confirms modes 0-2 already shipped in PRIORITY_MODE_TO_WIRE,");
            println!("     and authorises adding mode 3. Fix #341:");
            println!("       - add `pri_dnd: 3` to PRIORITY_MODE_TO_WIRE (DeviceTab.tsx)");
            println!("       - add the matching <SelectItem>");
            println!("       - update the guard test that asserts 3 stays unmodelled");
            println!("       - commit this capture to docs/wire_captures/");
            println!("     Backend needs no change: set_priority already allows (0..=3).");
        } else {
            println!("VERDICT: UNEXPECTED mapping — all four distinct, none of the");
            println!("         reference's ordering.");
            for (label, digit) in MODES.iter().zip(digits.iter()) {
                println!(
                    "           {label:<18} = {}",
                    digit.as_deref().unwrap_or("?")
                );
            }
            println!("  => The menu steps took, so this is real. Capture it verbatim and");
            println!("     reconcile in audit-reconciliation.md BEFORE changing any code.");
            println!("     Note the shipped map assumes 0=off/1=on/2=plus; if this run");
            println!("     disagrees, that mapping is wrong on this firmware too.");
        }
    }

    println!();
    println!(
        "--- restore: set priority back to its original setting on the keypad \
         (baseline digit was {}).",
        baseline.as_deref().unwrap_or("<unparsed>")
    );
    println!("--- no scanner settings were written by this probe.");
}

/// Read-only check: does any channel carry the priority flag?
///
/// Walks `CIN,1..500` inside a single PRG bracket and stops at the first hit,
/// so a radio that has one usually answers in a few round-trips. A full walk
/// (nothing flagged) is the slow path at ~30-45 s — the same cost as a memory
/// sync, and only paid when the answer is "no" and the run is aborting anyway.
///
/// `CIN,<idx>,<name>,<freq>,<mod>,<tone>,<delay>,<lockout>,<priority>` — split
/// on commas that is index 8, matching `priority_clear_probe.rs`. Empty slots
/// (`freq == 00000000`) are skipped: per audit-reconciliation.md (2026-07-21)
/// an unprogrammed slot carries factory `lockout=1` and its priority bit is
/// not a real channel flag.
fn has_priority_channel(send: &mut dyn FnMut(&str) -> String) -> bool {
    println!();
    println!("--- checking precondition: is any channel flagged priority?");
    send("PRG");
    let mut found = None;
    for idx in 1..=500u16 {
        let raw = send(&format!("CIN,{idx}"));
        let fields: Vec<&str> = raw.split(',').collect();
        // Skip empty slots — an unprogrammed channel's flags are factory
        // defaults, not a user-set priority.
        if fields.get(3).map(|s| s.trim()) == Some("00000000") {
            continue;
        }
        if fields.get(8).map(|s| s.trim()) == Some("1") {
            found = Some(idx);
            break;
        }
    }
    send("EPG");
    match found {
        Some(idx) => {
            println!("--- OK: channel {idx} is flagged priority. Proceeding.");
            true
        }
        None => {
            println!("--- none found across all 500 channels.");
            false
        }
    }
}

/// Decide which order to prompt the modes in, given the baseline digit.
///
/// Any mode prompted while the radio is already in it observes no transition,
/// and a no-change read cannot be told apart from "the menu step didn't take."
/// So whichever mode the baseline already holds goes LAST — by then the radio
/// is in some other mode and entering it is a real transition.
///
/// The baseline->label guess uses the reference ordering. That is only used to
/// reorder prompts; digits are still read from the wire and never assumed, so a
/// wrong guess costs ordering, not correctness. An unknown baseline falls back
/// to reference order, and the transition check flags any weak step.
fn probe_order(baseline: Option<&str>) -> Vec<&'static str> {
    let baseline_label = match baseline {
        Some("0") => Some(MODES[0]),
        Some("1") => Some(MODES[1]),
        Some("2") => Some(MODES[2]),
        Some("3") => Some(MODES[3]),
        _ => None,
    };
    let Some(last) = baseline_label else {
        return MODES.to_vec();
    };
    let mut order: Vec<&'static str> = MODES.iter().copied().filter(|m| *m != last).collect();
    order.push(last);
    order
}

/// Prompt the operator to select `label` on the keypad, then read the resulting
/// mode digit. Returns `None` if the reply didn't parse.
///
/// `Priority DND` gets extra guidance: it is the mode the app does not model,
/// and it is plausible this firmware lacks the menu item entirely. Skipping is
/// an accepted answer — "no such mode here" is a legitimate result worth
/// recording, not a failed run.
fn probe_mode(send: &mut dyn FnMut(&str) -> String, label: &str) -> Option<String> {
    println!();
    println!("--- STEP: set priority mode to `{label}` on the radio's keypad.");
    println!("{KEYPAD_STEPS}");
    if label == "Priority DND" {
        println!("      NOTE: this is the mode the app does not currently model. If this");
        println!("      firmware has NO `Priority DND` item, press Enter to skip — that");
        println!("      is a valid answer and settles #341 the other way.");
    }
    println!("    Confirm the radio's display shows `{label}` before continuing.");
    wait_for_enter();
    let mode = read_pri_mode(send);
    println!(
        "--- `{label}` reads back as mode digit {}",
        mode.as_deref().unwrap_or("<unparsed>")
    );
    mode
}

/// Read `PRI` inside its own PRG/EPG bracket and return the mode field.
///
/// `PRI` replies with a single field: `PRI,<mode>` — matching `parse_setting_u8`
/// in crates/bearpaw-api/src/api/handlers/settings.rs, which takes the first
/// field after the echoed command.
///
/// The bracket is opened and closed per read so the scanner is never left in
/// program mode while the operator is at the keypad.
fn read_pri_mode(send: &mut dyn FnMut(&str) -> String) -> Option<String> {
    send("PRG");
    let raw = send("PRI");
    send("EPG");

    let fields: Vec<&str> = raw.split(',').collect();
    if fields.first().map(|s| s.trim()) != Some("PRI") {
        println!("--- WARNING: unexpected reply to PRI: {raw}");
        return None;
    }
    // Guard the NG/ERR shapes parse_setting_u8 rejects (#143): they must not be
    // read as a mode digit.
    fields
        .get(1)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit()))
}

/// Block until the operator presses Enter. Reads stdin so the pause is explicit
/// rather than a fixed sleep the operator has to race.
fn wait_for_enter() {
    print!("    Press Enter when the radio is set... ");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    let _ = std::io::stdin().lock().read_line(&mut line);
}
