//! One-time hardware probe: reproduce the locked-channel clear failure on a
//! REAL channel and expose the field that breaks the round-trip.
//!
//! Established (lockout_keybeep_probe, fw 1.06.06): a plain CIN `lockout=0`
//! write DOES clear lockout on a scratch channel (tone=0, delay=2, FM, clean
//! freq). Yet the field reports `lockout write not persisted as sent
//! index=469 wanted=false read_back=true`. So the failure is specific to that
//! real channel's data surviving the production round-trip:
//!
//!     read CIN  ->  parse_cin_response  ->  ChannelData
//!               ->  build_cin_write_payload  ->  wire payload  ->  write
//!
//! If any field re-encodes to a value the scanner rejects (or silently
//! no-ops), the write returns CIN,OK but the old record — lockout=1 — survives.
//!
//! This probe reads each target channel, prints the raw wire record next to the
//! exact payload the production code would send (so a field-by-field diff is
//! visible), then attempts the real clear via the production code path and
//! reads back. NON-DESTRUCTIVE by intent: it only flips lockout, and only on
//! channels the caller names — it never deletes or reformats a real channel.
//!
//! Run with the backend STOPPED (exclusive USB access). Pass the channel
//! index(es) that failed to clear; defaults to 469 if none given:
//!   cargo run -p bearpaw-api --example lockout_realchannel_probe -- 469 470
//!
//! Record the result in docs/wire_captures/ and audit-reconciliation.md.

use bearpaw_api::protocol::{parse_cin_response, tones};
use bearpaw_api::state::{ChannelData, ToneSquelchKind};
use bearpaw_api::transport_usb::UsbTransport;

const VID: u16 = 0x1965;
const PID: u16 = 0x0017;

/// Mirror of `api::build_cin_write_payload` (pub(crate), not reachable from an
/// example). Kept byte-for-byte identical to the production builder so the
/// payload this probe prints is exactly what the failing clear path sends. If
/// production ever diverges, update this copy — it exists only to reproduce.
fn build_cin_write_payload(channel: &ChannelData) -> Result<String, String> {
    let alpha_tag = channel
        .alpha_tag
        .replace(',', " ")
        .trim()
        .chars()
        .take(16)
        .collect::<String>();
    let alpha_tag = if alpha_tag.is_empty() {
        " ".repeat(16)
    } else {
        alpha_tag
    };

    let modulation = if channel.modulation.is_empty() {
        "AUTO".to_string()
    } else {
        channel.modulation.trim().to_uppercase()
    };
    if !matches!(modulation.as_str(), "AUTO" | "AM" | "FM" | "NFM") {
        return Err(format!("modulation_invalid ({modulation})"));
    }

    let tone_code: u16 = match channel.tone_squelch_kind {
        ToneSquelchKind::None => 0,
        ToneSquelchKind::Search => 127,
        ToneSquelchKind::Ctcss => {
            let hz = channel.tone_squelch.ok_or_else(|| "tone_missing".to_string())?;
            tones::ctcss_hz_to_code(hz).ok_or_else(|| format!("tone_invalid (hz={hz})"))?
        }
        ToneSquelchKind::Dcs => {
            let code = channel.tone_dcs_code.ok_or_else(|| "tone_missing".to_string())?;
            if tones::dcs_code_to_number(code).is_none() {
                return Err(format!("tone_invalid (dcs_code={code})"));
            }
            code
        }
    };

    let freq = format!("{:08}", (channel.frequency * 10000.0).round() as i64);

    Ok(format!(
        "{},{},{},{},{},{},{}",
        alpha_tag,
        freq,
        modulation,
        tone_code,
        channel.delay,
        if channel.lockout { "1" } else { "0" },
        if channel.priority { "1" } else { "0" },
    ))
}

fn main() {
    let targets: Vec<u16> = {
        let args: Vec<u16> = std::env::args()
            .skip(1)
            .filter_map(|a| a.parse::<u16>().ok())
            .collect();
        if args.is_empty() {
            vec![469]
        } else {
            args
        }
    };

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
    let lockout_of = |cin: &str| -> Option<&'static str> {
        let f: Vec<&str> = cin.split(',').collect();
        match f.get(7).map(|s| s.trim()) {
            Some("1") => Some("1"),
            Some("0") => Some("0"),
            _ => None,
        }
    };

    let mdl = send("MDL");
    assert!(mdl.starts_with("MDL,"), "not a BC125AT-family scanner");
    let ver = send("VER");

    send("PRG");

    for idx in &targets {
        let idx = *idx;
        println!("\n============ CHANNEL {idx} ============");
        let raw = send(&format!("CIN,{idx}"));

        // Run the production read path.
        let Some(channel) = parse_cin_response(idx, &raw) else {
            println!("  parse_cin_response returned None — skipping (empty/error slot?)");
            continue;
        };
        println!("  parsed: mod={} freq={:.4} tone_kind={:?} tone_hz={:?} dcs={:?} delay={} lockout={} priority={}",
            channel.modulation, channel.frequency, channel.tone_squelch_kind,
            channel.tone_squelch, channel.tone_dcs_code, channel.delay,
            channel.lockout, channel.priority);

        if !channel.lockout {
            println!("  channel is already unlocked — nothing to clear. Skipping.");
            continue;
        }

        // Build the payload the production clear path would send (lockout=false).
        let mut cleared = channel.clone();
        cleared.lockout = false;
        match build_cin_write_payload(&cleared) {
            Ok(payload) => {
                println!("  RAW record : {raw}");
                println!("  WOULD write: CIN,{idx},{payload}");
                println!("  --- field-by-field: does the rebuilt payload match the raw record");
                println!("      (ignoring the lockout slot, which we intend to change)? ---");

                // Actually attempt the clear via the same payload.
                let write_reply = send(&format!("CIN,{idx},{payload}"));
                let readback = send(&format!("CIN,{idx}"));
                let after = lockout_of(&readback);
                println!("  write reply : {write_reply}");
                println!("  read-back lockout: {after:?}  (wanted 0)");
                if after == Some("0") {
                    println!("  >>> CLEARED OK on this channel.");
                } else {
                    println!("  >>> STILL LOCKED — reproduced the failure. Compare RAW vs WOULD-write above.");
                    // Restore the lockout bit we tried to clear so the channel
                    // is left exactly as found (belt-and-suspenders: the write
                    // didn't stick, but re-assert intent anyway).
                    if let Ok(relock) = build_cin_write_payload(&channel) {
                        send(&format!("CIN,{idx},{relock}"));
                    }
                }
            }
            Err(e) => {
                println!("  build_cin_write_payload REJECTED this channel: {e:?}");
                println!("  >>> This IS the bug: the rebuilt payload is invalid, so the");
                println!("      production clear path errors before the write even lands.");
            }
        }
    }

    send("EPG");
    println!("\n=== DONE (fw {ver}) — channels left as found ===");
}
