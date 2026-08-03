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
//! a substitute for probing a mode, because it is just wherever the operator
//! left the radio.
//!
//! Prompt order is COMPUTED from the baseline, not fixed. A step that starts
//! from the mode it is testing observes no transition, and a no-change read
//! cannot be distinguished from "the menu step silently didn't take." Whichever
//! mode the baseline already holds is therefore prompted LAST, so every step is
//! entered from a different mode. Every earlier capture tripped on this in some
//! form, so the results section now reports per-step transitions explicitly
//! instead of leaving a reader to reconstruct them from the raw log.
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
    // ORDER IS COMPUTED, NOT FIXED. A step that starts from the mode it is
    // testing observes no transition, and a no-change read is consistent with
    // "the menu step silently didn't take" — it proves nothing. Which step has
    // that problem depends on where the operator left the radio, so the order
    // cannot be hard-coded.
    //
    // Every earlier capture tripped on this: the 2026-08-03 runs left Priority
    // (baseline 1) or nothing at all as a non-transition, and a fixed
    // Priority/DND/Off order repeats it whenever the radio starts in Priority.
    //
    // Fix: prompt whichever mode already matches the baseline LAST. It is then
    // entered from some other mode, so every step is a real transition.
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
    let priority = digit_for("CC Priority");
    let dnd = digit_for("CC DND");
    let off = digit_for("CC Off");
    let only = digit_for("CC Only");

    println!();
    println!("=== RESULTS (fw {ver}) ===");
    for (label, digit) in [
        ("CC Priority", &priority),
        ("CC DND", &dnd),
        ("CC Only", &only),
        ("CC Off", &off),
    ] {
        println!(
            "keypad `{label:<11}` -> wire mode digit {}",
            digit.as_deref().unwrap_or("<unparsed>")
        );
    }

    // State plainly whether each step actually moved the field. A step whose
    // read equals the state before it proves nothing on its own — that digit is
    // then pinned only by elimination. Say so here rather than leaving a reader
    // to reconstruct it from the raw log, which is how the earlier captures
    // shipped with an unnoticed non-transition step.
    println!();
    println!("--- transition check (did each step actually move the field?) ---");
    let mut prev = baseline.clone();
    let mut weak: Vec<&str> = Vec::new();
    for label in &order {
        let digit = digit_for(label);
        match (prev.as_deref(), digit.as_deref()) {
            (Some(p), Some(d)) if p == d => {
                println!("  {label:<11}: {p} -> {d}  NO TRANSITION (pinned only by elimination)");
                weak.push(label);
            }
            (Some(p), Some(d)) => println!("  {label:<11}: {p} -> {d}  ok"),
            _ => println!("  {label:<11}: <unparsed>"),
        }
        if digit.is_some() {
            prev = digit;
        }
    }
    if weak.is_empty() {
        println!("  => all three digits directly observed.");
    } else {
        println!(
            "  => {} step(s) observed no transition: {}. The mapping may still be\n     \
             correct, but re-run starting from a different mode to observe it\n     \
             directly. (The probe orders baseline-last to avoid this; it can\n     \
             still happen if the mode changed between the baseline read and the\n     \
             first prompt.)",
            weak.len(),
            weak.join(", ")
        );
    }
    println!();

    // The three documented modes must each have parsed and be distinct. A
    // duplicate among them means a menu step silently didn't take (the radio
    // stayed where it was) — the most likely operator error, and it must not
    // read as a result.
    //
    // `CC Only` is handled separately below: it is NOT in the reference at all,
    // so we have no expectation for it and must not fold it into a
    // distinctness check that assumes four distinct digits exist.
    let documented: Vec<Option<&str>> = vec![priority.as_deref(), dnd.as_deref(), off.as_deref()];
    let parsed: Vec<&str> = documented.iter().flatten().copied().collect();
    let mut distinct = parsed.clone();
    distinct.sort_unstable();
    distinct.dedup();

    if parsed.len() != 3 {
        println!("VERDICT: INCONCLUSIVE — a documented mode did not parse.");
        println!("  => Inspect the raw CLC replies above; re-run.");
    } else if distinct.len() != 3 {
        println!("VERDICT: INCONCLUSIVE — two documented modes reported the SAME digit.");
        println!("  => A menu step almost certainly didn't take: the radio stayed");
        println!("     where it was. Re-run and confirm the display shows the");
        println!("     requested mode before pressing Enter at each prompt.");
    } else {
        match (priority.as_deref(), dnd.as_deref(), off.as_deref()) {
            (Some("1"), Some("2"), Some("0")) => {
                println!("VERDICT: 0 = Off, 1 = Priority, 2 = DND — matches the REFERENCES.");
                println!("  => Confirms the shipped mapping in DeviceTab.tsx");
                println!("     (CLOSE_CALL_MODE_TO_WIRE).");
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

    // `CC Only` — the open question this run exists to answer. The reference
    // documents only modes 0/1/2 and the backend REJECTS anything above 2
    // (close_call_mode_invalid, settings.rs::set_close_call), so if this menu
    // item reports a fourth digit the whole stack is incomplete. If instead it
    // reports one of the known digits, `CC Only` is not part of the CLC mode
    // field at all and lives somewhere else on the wire.
    println!();
    println!("--- `CC Only` (undocumented — not in BC125AT_PROTOCOL.md §7.6) ---");
    match only.as_deref() {
        None => {
            println!("  did not parse. If the radio has no `CC Only` menu item, that is");
            println!("  itself the answer: skip it and note the menu differs.");
        }
        Some(d) if !parsed.contains(&d) => {
            println!("  reports NEW digit {d} — a fourth CLC mode the reference omits.");
            println!("  => The stack is incomplete end to end:");
            println!("     - backend set_close_call validates (0..=2) and would REJECT {d}");
            println!("     - CLOSE_CALL_MODE_TO_WIRE has no entry, so the UI misreads it");
            println!("     File this with the capture; do NOT widen either without it.");
        }
        Some(d) => {
            let same = if Some(d) == priority.as_deref() {
                "CC Priority"
            } else if Some(d) == dnd.as_deref() {
                "CC DND"
            } else {
                "CC Off"
            };
            println!("  reports digit {d}, the SAME as `{same}`.");
            println!("  => `CC Only` is therefore NOT a distinct value of the CLC mode");
            println!("     field. It is a separate operating state that reports");
            println!("     elsewhere on the wire (or not at all). No CLC mode-map");
            println!("     change follows; investigate which field carries it.");
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

/// Decide which order to prompt the three modes in, given the baseline digit.
///
/// Any mode prompted while the radio is already in it observes no transition,
/// and a no-change read cannot be told apart from "the menu step didn't take."
/// So whichever mode the baseline already holds goes LAST — by then the radio
/// is in some other mode and entering it is a real transition.
///
/// An unknown or unparsed baseline falls back to the default order; the worst
/// case is one non-transition step, which the results section flags.
fn probe_order(baseline: Option<&str>) -> Vec<&'static str> {
    const DEFAULT: [&str; 4] = ["CC Priority", "CC DND", "CC Only", "CC Off"];
    // Baseline digit -> the label it corresponds to, per the shipped mapping.
    // Only used to reorder prompts; the digits are still read from the wire and
    // never assumed, so a wrong guess here costs ordering, not correctness.
    let baseline_label = match baseline {
        Some("0") => Some("CC Off"),
        Some("1") => Some("CC Priority"),
        Some("2") => Some("CC DND"),
        _ => None,
    };
    let Some(last) = baseline_label else {
        return DEFAULT.to_vec();
    };
    let mut order: Vec<&'static str> = DEFAULT.iter().copied().filter(|m| *m != last).collect();
    order.push(DEFAULT.iter().copied().find(|m| *m == last).unwrap());
    order
}

/// Prompt the operator to select `label` on the keypad, then read the resulting
/// mode digit. Returns `None` if the reply didn't parse.
///
/// `CC Only` gets its own guidance: the reference documents no such CLC mode,
/// so we must not assert it lives under the `CC Mode` menu item. The operator
/// finds it wherever the radio actually puts it, and may skip it if this
/// firmware has no such item — a skip is a legitimate result, not a failure.
fn probe_mode(send: &mut dyn FnMut(&str) -> String, label: &str) -> Option<String> {
    println!();
    if label == "CC Only" {
        println!("--- STEP: set the radio to `CC Only` (Close Call Only).");
        println!("      This mode is NOT in our protocol reference, so the menu path");
        println!("      is unknown — on many BC125AT units it is [Func] + [Close Call]");
        println!("      held, or a `CC Only` entry alongside CC Mode. Use whatever your");
        println!("      radio actually offers.");
        println!("      If this firmware has NO `CC Only` item, just press Enter to");
        println!("      skip — 'no such mode' is a valid answer worth recording.");
        println!("    Confirm the radio shows Close Call Only, then continue.");
    } else {
        println!("--- STEP: set Close Call mode to `{label}` on the radio's keypad.");
        println!("{KEYPAD_STEPS}");
        println!("    Confirm the radio's display shows `{label}` before continuing.");
    }
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
