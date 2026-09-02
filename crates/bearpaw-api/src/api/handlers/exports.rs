use axum::extract::{Multipart, State};
use axum::response::{IntoResponse, Json};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::protocol::capabilities::ScannerCapabilities;
use crate::protocol::tones::dcs_code_to_number;
use crate::state::{ChannelData, ToneSquelchKind};

use super::super::security::validate_wire_field;
use super::super::{
    command_sender, csv_escape, flags_to_bools, on_off, read_frequency_lockouts_walk,
    send_raw_command, split_command_parts, write_channel_to_scanner, ApiError, AppState,
    ProgramModeGuard,
};

/// Format a channel's modulation for the `C-Freq` modulation column.
///
/// Uniden writes `Auto` in title case and `FM` / `AM` / `NFM` in upper case.
/// Confirmed across three files its own software produced (a blank, a
/// round-trip, and a read-from-scanner): `Auto` x497-500, with the three
/// explicit modulations upper case wherever they appear.
///
/// Bearpaw wrote the raw `CIN` value, which is `AUTO`. That is COSMETIC, not
/// data loss -- a round-trip through BC125AT SS preserved `FM`, `AM` and `NFM`
/// exactly, so the parser reads our casing and normalises on write (#507).
/// Matched anyway, because since #520 and #521 the tone column reproduces
/// Uniden's spellings exactly, and leaving modulation as the one deliberate
/// mismatch invites someone to "fix" the wrong one.
fn ss_modulation_label(modulation: &str) -> String {
    // Empty maps to `Auto` too. A BC125AT `CIN` always reports a modulation, so
    // empty only arises from a `ChannelData` that predates a memory sync -- and
    // Uniden's own blank file writes `Auto` on all 500 unprogrammed rows, so
    // that is the value an unset channel takes. Passing the empty string
    // through would emit a column no real file has.
    if modulation.is_empty() || modulation.eq_ignore_ascii_case("AUTO") {
        "Auto".to_string()
    } else {
        modulation.to_ascii_uppercase()
    }
}

/// Number of frequency slots in an `AvoidFreqs` line.
///
/// The line is 18 tab-separated fields: the keyword, then 17. Field 1 is never
/// a frequency -- every observed file leaves it empty -- so values occupy
/// fields 2..=17.
const AVOID_FREQS_SLOTS: usize = 16;

/// Build the `AvoidFreqs` line, or `None` when there are no global lockouts.
///
/// Measured 2026-08-29 (#459): two lockouts set on a real BC125AT in a known
/// order, read back by BC125AT SS, produced
///
/// ```text
/// AvoidFreqs<TAB><TAB>116733300<TAB>122883300<TAB>...14 empties
///            fld1  fld2       fld3
/// ```
///
/// So it is a PACKED list offset by one: values start at field 2 and fill
/// forward in the order `GLF` returned them, which is insertion order because
/// `LOF` appends rather than sorting (#502). Frequencies are integer Hz, the
/// same encoding `C-Freq` uses; the walk yields 100 Hz units, hence `* 100`.
///
/// The section is ABSENT ENTIRELY at zero lockouts -- confirmed by the blank
/// reference file -- which is why this returns Option rather than an empty
/// line. Emitting an all-empty `AvoidFreqs` would be a shape no real file has.
fn build_avoid_freqs_line(raw_100hz: &[u32]) -> Option<String> {
    if raw_100hz.is_empty() {
        return None;
    }
    // No silent truncation: every observed file has exactly 17 trailing fields
    // and none has ever carried more than one value, so behaviour past 16 is
    // unobserved. The radio holds far more than that, so a wide list is
    // reachable -- log rather than quietly drop, and keep the line the shape
    // Uniden writes instead of guessing at a longer one.
    if raw_100hz.len() > AVOID_FREQS_SLOTS {
        tracing::warn!(
            total = raw_100hz.len(),
            written = AVOID_FREQS_SLOTS,
            "AvoidFreqs holds {} slots; {} global lockouts were not exported",
            AVOID_FREQS_SLOTS,
            raw_100hz.len() - AVOID_FREQS_SLOTS
        );
    }
    let mut fields: Vec<String> = vec![String::new(); AVOID_FREQS_SLOTS + 1];
    for (i, raw) in raw_100hz.iter().take(AVOID_FREQS_SLOTS).enumerate() {
        // field 1 stays empty; values begin at field 2
        fields[i + 1] = (u64::from(*raw) * 100).to_string();
    }
    Some(format!("AvoidFreqs\t{}", fields.join("\t")))
}

/// Format a channel's tone for the `C-Freq` tone column of a `.bc125at_ss`.
///
/// REGRESSION GUARD (#516): these spellings are Uniden's, not ours, and they
/// are NOT the labels the UI uses. Measured 2026-08-29 by writing a CTCSS and
/// a DCS channel to a real BC125AT, then having BC125AT SS read the radio and
/// save: it wrote `C100.0` and `D023`.
///
/// Bearpaw previously wrote `100.0` and `DCS 023`. Uniden's parser cannot read
/// either and silently defaults the column to `Off` -- verified by round-
/// tripping a Bearpaw file through the tool, where both tones came back `Off`
/// while everything else survived. That is silent data loss on every export of
/// a channel carrying a tone, and no golden test could see it: every reference
/// file in `fixtures/` is `Off` on all 500 rows, so the column had never been
/// exercised with a value.
///
/// Do NOT reuse `dcs_code_to_label` here. It renders `DCS 023` for the live
/// display and is correct for that; this column needs `D023`.
pub(crate) fn ss_tone_label(ch: &ChannelData) -> String {
    match ch.tone_squelch_kind {
        ToneSquelchKind::Ctcss => ch
            .tone_squelch
            .map(|hz| format!("C{:.1}", hz))
            .unwrap_or_else(|| "Off".to_string()),
        ToneSquelchKind::Dcs => ch
            .tone_dcs_code
            .and_then(dcs_code_to_number)
            .map(|n| format!("D{:03}", n))
            .unwrap_or_else(|| "Off".to_string()),
        // VERIFIED 2026-08-29: set a channel's tone to Search in BC125AT SS and
        // saved -- exactly one line changed, and it wrote `Srch`. Notably NOT
        // the one-letter-prefix scheme the other two kinds use (`C100.0`,
        // `D023`), which is why it was worth measuring rather than deriving.
        ToneSquelchKind::Search => "Srch".to_string(),
        ToneSquelchKind::None => "Off".to_string(),
    }
}

pub(crate) async fn export_bc125at_ss_file(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let _ = command_sender(&state)?;
    if state.sync_task_id.lock().unwrap().is_some() {
        return Err(ApiError::Conflict("sync_in_progress".to_string()));
    }
    // Capability, not a substring match on the model name. The old gate --
    // `model.contains("BC125AT")` -- worked only by luck: "BC125AT" is a
    // substring of "BCT125AT". The BC75XLT has its own settings-file layout
    // that Bearpaw has no spec for, so it is refused here rather than handed
    // a BC125AT-shaped file its own software would reject.
    let caps = state.capabilities();
    if caps.ss_format != "bc125at" {
        return Err(ApiError::BadRequest("unsupported_model".to_string()));
    }
    let region = caps.ss_region;

    let result = async {
        let _prg = ProgramModeGuard::enter(&state).await?;

        let backlight = split_command_parts(&send_raw_command(&state, "BLT", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "AF".to_string());
        let kbp = split_command_parts(&send_raw_command(&state, "KBP", false).await?);
        let beep_level = kbp.first().cloned().unwrap_or_else(|| "99".to_string());
        let key_lock = kbp.get(1).cloned().unwrap_or_else(|| "0".to_string());
        let charge_time = split_command_parts(&send_raw_command(&state, "BSV", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "16".to_string());
        let priority_mode = split_command_parts(&send_raw_command(&state, "PRI", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "0".to_string());
        let scan_flags = split_command_parts(&send_raw_command(&state, "SCG", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "1111111111".to_string());
        let sco = split_command_parts(&send_raw_command(&state, "SCO", false).await?);
        let search_delay = sco.first().cloned().unwrap_or_else(|| "0".to_string());
        let search_code = sco.get(1).cloned().unwrap_or_else(|| "0".to_string());
        let clc = split_command_parts(&send_raw_command(&state, "CLC", false).await?);
        let cc_mode = clc.first().cloned().unwrap_or_else(|| "0".to_string());
        let cc_beep = clc.get(1).cloned().unwrap_or_else(|| "0".to_string());
        let cc_light = clc.get(2).cloned().unwrap_or_else(|| "0".to_string());
        let cc_bands = clc.get(3).cloned().unwrap_or_else(|| "11111".to_string());
        let cc_lockout = clc.get(4).cloned().unwrap_or_else(|| "0".to_string());
        let service_flags = split_command_parts(&send_raw_command(&state, "SSG", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "1111111111".to_string());
        let custom_flags = split_command_parts(&send_raw_command(&state, "CSG", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "1111111111".to_string());
        let wx_pri = split_command_parts(&send_raw_command(&state, "WXS", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "0".to_string());
        let contrast = split_command_parts(&send_raw_command(&state, "CNT", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "8".to_string());
        let volume = split_command_parts(&send_raw_command(&state, "VOL", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "0".to_string());
        let squelch = split_command_parts(&send_raw_command(&state, "SQL", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "0".to_string());

        let mut custom_ranges = Vec::new();
        for idx in 1..=10 {
            let csp = split_command_parts(
                &send_raw_command(&state, &format!("CSP,{}", idx), false).await?,
            );
            let lower_hz = csp
                .get(1)
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v * 100)
                .unwrap_or(0);
            let upper_hz = csp
                .get(2)
                .and_then(|v| v.parse::<i64>().ok())
                .map(|v| v * 100)
                .unwrap_or(0);
            custom_ranges.push((idx, lower_hz, upper_hz));
        }

        // Channels come from the shadow cache, not a live CIN walk. Re-reading
        // all 500 channels over the wire took ~150s (300ms x 500) and blew past
        // client timeouts, so the export "did nothing". CSV export already
        // reads the cache; this matches it. The tone column is rebuilt to the
        // same label format the CIN walk produced (`tone_code_label`).
        //
        // Since #413 the shadow may have been adopted from SQLite at connect
        // rather than read from the radio this session, so what this exports is
        // "the last memory sync, whenever that was" -- possibly days ago, and
        // possibly out of date if the channels were edited on the scanner's own
        // keypad in between. That is the same staleness the Channels tab
        // renders, which is the point of the cache; `synced_at` is how a user
        // sees how old it is.
        // (index, name, frequency_hz, modulation, tone, lockout, delay, priority)
        type SsChannelRow = (u16, String, i64, String, String, String, String, String);
        let channels: Vec<SsChannelRow> = {
            let shadow = state.shadow.read().unwrap();
            let mut cached: Vec<ChannelData> = shadow.channels.values().cloned().collect();
            cached.sort_by_key(|c| c.index);
            cached
                .into_iter()
                .map(|ch| {
                    let tone = ss_tone_label(&ch);
                    (
                        ch.index,
                        ch.alpha_tag,
                        (ch.frequency * 1_000_000.0).round() as i64,
                        ss_modulation_label(&ch.modulation),
                        tone,
                        on_off(if ch.lockout { "1" } else { "0" }).to_string(),
                        ch.delay.to_string(),
                        on_off(if ch.priority { "1" } else { "0" }).to_string(),
                    )
                })
                .collect()
        };

        const SERVICE_NAMES: [&str; 10] = [
            "Police",
            "Fire/Emergency",
            "HAM Radio",
            "Marine",
            "Railroad",
            "Civil Air",
            "Military Air",
            "CB Radio",
            "FRS/GMRS/MURS",
            "Racing",
        ];
        let backlight_display = match backlight.as_str() {
            "AO" => "On",
            "AF" => "Off",
            "KY" => "Key",
            "SQ" => "Squelch",
            "KS" => "K+S",
            _ => "Off",
        };
        let priority_display = match priority_mode.as_str() {
            "1" => "On",
            "2" => "Plus",
            "3" => "DND",
            _ => "Off",
        };
        let cc_mode_display = match cc_mode.as_str() {
            "1" => "Pri",
            "2" => "DND",
            _ => "Off",
        };
        let misc_beep = if beep_level == "0" {
            "Auto".to_string()
        } else if beep_level == "99" {
            "Off".to_string()
        } else {
            beep_level
        };

        let mut lines = Vec::new();
        lines.push(format!(
            "Misc\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
            backlight_display,
            misc_beep,
            on_off(&key_lock),
            contrast,
            volume,
            squelch,
            charge_time,
            region
        ));
        lines.push(format!("Priority\t{}", priority_display));
        lines.push(format!("WxPri\t{}", on_off(&wx_pri)));

        let service_enabled = flags_to_bools(&service_flags);
        for (idx, name) in SERVICE_NAMES.iter().enumerate() {
            let enabled = if service_enabled.get(idx).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            };
            lines.push(format!("Service\t{}\t{}\t{}", idx + 1, name, enabled));
        }

        let custom_enabled = flags_to_bools(&custom_flags);
        for (idx, lower_hz, upper_hz) in custom_ranges {
            let enabled = if custom_enabled
                .get((idx - 1) as usize)
                .copied()
                .unwrap_or(false)
            {
                "On"
            } else {
                "Off"
            };
            lines.push(format!(
                "Custom\t{}\tSearch Bnak{}\t{}\t{}\t{}",
                idx, idx, lower_hz, upper_hz, enabled
            ));
        }

        lines.push(format!(
            "CloseCall\t{}\t{}\t{}\t{}",
            cc_mode_display,
            on_off(&cc_beep),
            on_off(&cc_light),
            on_off(&cc_lockout)
        ));

        // CLC close-call bands use '1' = enabled (confirmed by wire probe:
        // raw "01001" reads as [off,on,off,off,on] via the canonical
        // get_close_call reader). NOT the '0' = enabled convention of the
        // SCG/SSG/CSG masks, so don't use flags_to_bools here.
        let cc_band_flags: Vec<bool> = cc_bands.chars().map(|c| c == '1').collect();
        lines.push(format!(
            "CloseCallBands\t{}\t{}\t{}\t{}\t{}",
            if cc_band_flags.first().copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            },
            if cc_band_flags.get(1).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            },
            if cc_band_flags.get(2).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            },
            if cc_band_flags.get(3).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            },
            if cc_band_flags.get(4).copied().unwrap_or(false) {
                "On"
            } else {
                "Off"
            }
        ));

        lines.push(format!(
            "GeneralSearch\t{}\t{}",
            search_delay,
            on_off(&search_code)
        ));

        // `AvoidFreqs` sits between GeneralSearch and the first Conventional
        // line, and only when the list is non-empty (#459). Read here rather
        // than from a cache because nothing caches it -- and we are already
        // inside this export's ProgramModeGuard, so the walk needs no bracket
        // of its own. `read_frequency_lockouts_walk` is the UNBRACKETED helper
        // on purpose; `read_frequency_lockouts_from_scanner` sends its own
        // PRG/EPG and would nest program mode inside this one.
        if let Some(line) = build_avoid_freqs_line(&read_frequency_lockouts_walk(&state).await?) {
            lines.push(line);
        }

        // Banks and channels INTERLEAVE: each `Conventional` line is followed
        // by that bank's own 50 channels, not ten bank lines and then all 500.
        //
        // Bearpaw emitted them grouped. It survived review of three real files
        // because the analysis aggregated lines by section NAME regardless of
        // position, which makes grouped and interleaved indistinguishable --
        // only a sequence-exact comparison shows the difference. Confirmed
        // against `fixtures/blank.bc125at_ss`, saved by Uniden's own tool.
        let scan_enabled = flags_to_bools(&scan_flags);
        let by_index: std::collections::HashMap<u16, &SsChannelRow> =
            channels.iter().map(|row| (row.0, row)).collect();
        for bank in 1..=caps.bank_count {
            let enabled = if scan_enabled
                .get(usize::from(bank - 1))
                .copied()
                .unwrap_or(false)
            {
                "On"
            } else {
                "Off"
            };
            lines.push(format!(
                "Conventional\t{}\tBank {}\t{}",
                bank, bank, enabled
            ));
            let first = u16::from(bank - 1) * caps.channels_per_bank + 1;
            for idx in first..first + caps.channels_per_bank {
                if let Some((i, name, frequency_hz, modulation, tone, lockout, delay, priority)) =
                    by_index.get(&idx)
                {
                    lines.push(format!(
                        "C-Freq\t{}\t{}\t{}\t{}\t{}\t{}\t{}\t{}",
                        i, name, frequency_hz, modulation, tone, lockout, delay, priority
                    ));
                }
            }
        }

        Ok::<String, ApiError>(join_ss_lines(&lines))
    }
    .await;
    let payload = result?;

    Ok((
        [
            ("content-type", "text/plain"),
            (
                "content-disposition",
                "attachment; filename=scanner.bc125at_ss",
            ),
        ],
        payload,
    ))
}

/// Service-search band names, in the order the BC75XLT tool writes them.
///
/// `WX` is first and the BC125AT list does not have it -- taken verbatim from
/// real files written by Uniden's own tool (2026-08-27).
const BC75XLT_SERVICE_NAMES: [&str; 10] = [
    "WX",
    "Police",
    "Fire/Emergency",
    "Marine",
    "Racing",
    "Civil Air",
    "HAM Radio",
    "Railroad",
    "CB Radio",
    "Other (FRS/GMRS/MURS)",
];

/// The delay Uniden's tool writes into every `.bc75xlt_ss` channel row.
///
/// Constant, not the radio's value: 600 of 600 channels across two real files
/// are `2`, empty slots included, and this model's CIN delay is a boolean
/// (0/1) so `2` cannot have come off the wire.
const BC75XLT_SS_CHANNEL_DELAY: u8 = 2;

/// Custom-search ranges as the BC75XLT tool writes them, in Hz.
///
/// Bearpaw does not read `CSP` here even though that command is now known to
/// work on this model (write -> read-back -> match, hardware 2026-08-28). The
/// reason is the format, not the wire: Uniden's own tool writes these constant
/// factory ranges into a `.bc75xlt_ss` rather than reading the radio, and this
/// export matches the tool. Reading `CSP` would produce a DIFFERENT file from
/// the one the vendor writes for the same scanner.
///
/// These are the values present in real exported files; they are the radio's
/// factory ranges and differ from the BC125AT's. The 2026-08-28 probe read all
/// ten back off a real unit and they match this table exactly -- two
/// independent recoveries agreeing.
const BC75XLT_CUSTOM_RANGES: [(u32, u32); 10] = [
    (25_000_000, 27_995_000),
    (28_000_000, 29_695_000),
    (29_700_000, 49_995_000),
    (50_000_000, 54_000_000),
    (108_000_000, 136_991_666),
    (137_000_000, 143_995_000),
    (144_000_000, 147_995_000),
    (406_000_000, 449_993_750),
    (450_000_000, 469_993_750),
    (470_000_000, 512_000_000),
];

/// Export the connected BC75XLT's memory and settings as a `.bc75xlt_ss` file.
///
/// The layout was recovered from real files written by Uniden's own tool
/// (2026-08-27). It is the same tab-delimited, CRLF, section-keyword format as
/// `.bc125at_ss`, with these differences, each confirmed by comparing
/// same-day exports of both radios from one owner:
///
/// ```text
///                 BC125AT   BC75XLT
///   WxPri         present   absent      (no weather alert)
///   Service       4 fields  6 fields    (gains delay + direction)
///   CustomSearch  absent    3 fields
///   GeneralSearch 3 fields  4 fields
///   AvoidFreqs    optional  absent
///   C-Freq        x500      x300
///   Custom name   "Bnak"    "Bank"      (Uniden fixed their typo)
/// ```
///
/// Only commands this model is known to answer are sent -- `KBP` (inside PRG),
/// `SQL`, `PRI`, `SCO`, `CLC`, `SCG`, per the wire capture in
/// `docs/wire_captures/2026-08-26/`. `BLT`/`BSV`/`CNT`/`WXS` reply `ERR` here
/// and are never sent; their `Misc` slots go out empty, which is exactly what
/// the real files contain.
pub(crate) async fn export_bc75xlt_ss_file(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, ApiError> {
    let _ = command_sender(&state)?;
    if state.sync_task_id.lock().unwrap().is_some() {
        return Err(ApiError::Conflict("sync_in_progress".to_string()));
    }
    let caps = state.capabilities();
    if caps.ss_format != "bc75xlt" {
        return Err(ApiError::BadRequest("unsupported_model".to_string()));
    }

    let result = async {
        let _prg = ProgramModeGuard::enter(&state).await?;

        // `KBP` answers `NG` outside PRG on this model, hence inside the
        // bracket. Field 2 is the key lock.
        let kbp = split_command_parts(&send_raw_command(&state, "KBP", false).await?);
        let key_lock = kbp.get(1).cloned().unwrap_or_else(|| "0".to_string());
        let squelch = split_command_parts(&send_raw_command(&state, "SQL", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "0".to_string());
        let priority = split_command_parts(&send_raw_command(&state, "PRI", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "0".to_string());
        let sco = split_command_parts(&send_raw_command(&state, "SCO", false).await?);
        let search_delay = sco.first().cloned().unwrap_or_else(|| "2".to_string());
        let search_code = sco.get(1).cloned().unwrap_or_default();
        let clc = split_command_parts(&send_raw_command(&state, "CLC", false).await?);
        let scan_flags = split_command_parts(&send_raw_command(&state, "SCG", false).await?)
            .first()
            .cloned()
            .unwrap_or_else(|| "1111111111".to_string());

        let mut lines = Vec::new();

        // Backlight, beep, contrast and volume are empty in every real file
        // from this model -- the tool does not read them here even though
        // `VOL` works on the wire. Charge time is a constant 2 in every
        // sample of both models. Emitting what the tool emits, not what the
        // radio could tell us, is the point: this file is read by Uniden's
        // software, not by us.
        lines.push(format!(
            "Misc\t\t\t{}\t\t\t{}\t2\t{}",
            on_off(&key_lock),
            squelch,
            caps.ss_region
        ));
        lines.push(format!("Priority\t{}", on_off(&priority)));

        // Direction is "Up" in every observed file and has no confirmed wire
        // source on this model; the delay column mirrors the search delay.
        for (idx, name) in BC75XLT_SERVICE_NAMES.iter().enumerate() {
            lines.push(format!(
                "Service\t{}\t{}\t\t{}\tUp",
                idx + 1,
                name,
                search_delay
            ));
        }
        lines.push(format!("CustomSearch\t{}\tUp", search_delay));

        // "Search Bank", not the BC125AT's "Search Bnak" -- Uniden fixed the
        // typo in this tool, and the real files prove it.
        for (idx, (lower, upper)) in BC75XLT_CUSTOM_RANGES.iter().enumerate() {
            lines.push(format!(
                "Custom\t{}\tSearch Bank{}\t{}\t{}\tOff",
                idx + 1,
                idx + 1,
                lower,
                upper
            ));
        }

        let cc_mode = match clc.first().map(String::as_str) {
            Some("1") => "Pri",
            Some("2") => "Pri",
            _ => "Off",
        };
        lines.push(format!(
            "CloseCall\t{}\t{}\t{}\t",
            cc_mode,
            on_off(clc.get(1).map(String::as_str).unwrap_or("0")),
            on_off(clc.get(2).map(String::as_str).unwrap_or("0"))
        ));
        // Band 4 is empty rather than "Off": this model has no 225-380 MHz
        // band at all, and the real files leave that slot blank.
        let cc_bands = flags_to_bools(clc.get(3).map(String::as_str).unwrap_or("11111"));
        lines.push(format!(
            "CloseCallBands\t{}\t{}\t{}\t\t{}",
            on_off_bool(cc_bands.first().copied().unwrap_or(false)),
            on_off_bool(cc_bands.get(1).copied().unwrap_or(false)),
            on_off_bool(cc_bands.get(2).copied().unwrap_or(false)),
            on_off_bool(cc_bands.get(4).copied().unwrap_or(false))
        ));
        lines.push(format!(
            "GeneralSearch\t{}\t{}\tUp",
            search_delay, search_code
        ));

        // Banks and channels INTERLEAVE: each `Conventional` line is followed
        // by that bank's own channels, not all ten bank lines and then all 300
        // channels. Caught by the golden test against a real file -- reading
        // each section in isolation would never have revealed the ordering.
        //
        // Name, modulation and tone are `[RSV]` on this model, so those
        // columns go out empty, which is what the real files contain.
        let scan_enabled = flags_to_bools(&scan_flags);
        let shadow = state.shadow.read().unwrap();
        for bank in 1..=caps.bank_count {
            lines.push(format!(
                "Conventional\t{}\tBank {}\t{}",
                bank,
                bank,
                on_off_bool(
                    scan_enabled
                        .get(usize::from(bank - 1))
                        .copied()
                        .unwrap_or(false)
                )
            ));
            let first = u16::from(bank - 1) * caps.channels_per_bank + 1;
            for idx in first..first + caps.channels_per_bank {
                let ch = shadow.channels.get(&idx);
                let hz = ch
                    .map(|c| (c.frequency * 1_000_000.0).round() as u64)
                    .unwrap_or(0);
                lines.push(format!(
                    "C-Freq\t{}\t\t{}\t\t\t{}\t{}\t{}",
                    idx,
                    hz,
                    on_off_bool(ch.map(|c| c.lockout).unwrap_or(false)),
                    // A CONSTANT 2, not the wire value. Uniden's tool writes 2
                    // for every channel of this model -- 600 of 600 across two
                    // real files, including empty slots. It cannot be echoing
                    // the radio: this model's CIN delay is a boolean (0/1), so
                    // 2 is not a value the wire can produce. The file's delay
                    // column uses the BC125AT's seconds vocabulary, which this
                    // model has no counterpart for, and the tool fills it with
                    // a fixed 2.
                    //
                    // The BC125AT files DO vary here (490 x 2, 10 x 0), so this
                    // is specific to the BC75XLT, not the format.
                    BC75XLT_SS_CHANNEL_DELAY,
                    on_off_bool(ch.map(|c| c.priority).unwrap_or(false))
                ));
            }
        }

        Ok::<String, ApiError>(join_ss_lines(&lines))
    }
    .await;
    let payload = result?;

    Ok((
        [
            ("content-type", "text/plain"),
            (
                "content-disposition",
                "attachment; filename=scanner.bc75xlt_ss",
            ),
        ],
        payload,
    ))
}

/// `true`/`false` -> the `On`/`Off` the settings file uses.
fn on_off_bool(v: bool) -> &'static str {
    if v {
        "On"
    } else {
        "Off"
    }
}

pub(crate) async fn export_csv(State(state): State<AppState>) -> impl IntoResponse {
    let mut rows = Vec::new();
    rows.push(
        "Index,Frequency,Modulation,Alpha Tag,Delay,Lockout,Priority,CTCSS/DCS,Bank".to_string(),
    );

    // REGRESSION GUARD (`an_exported_csv_re_imports`): read through
    // `channels_with_banks`, never the cache directly. Bank is not a wire field
    // -- `parse_cin_response` leaves it 0 and only this accessor derives it from
    // the connected scanner's memory model (see the third-rail table in
    // CLAUDE.md). Exporting the raw 0 wrote a Bank column the importer rejects
    // with "Invalid bank: 0", so Bearpaw's own CSV could not be re-imported.
    // It sorts by index, so the caller does not.
    for ch in state.channels_with_banks() {
        rows.push(format!(
            "{},{},{},{},{},{},{},{},{}",
            ch.index,
            ch.frequency,
            ch.modulation,
            csv_escape(&ch.alpha_tag),
            ch.delay,
            ch.lockout,
            ch.priority,
            ch.tone_squelch.map(|v| v.to_string()).unwrap_or_default(),
            ch.bank
        ));
    }

    (
        [
            ("content-type", "text/csv"),
            ("content-disposition", "attachment; filename=channels.csv"),
        ],
        rows.join("\n"),
    )
}

pub(crate) async fn import_csv(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<Value>, ApiError> {
    let _ = command_sender(&state)?;
    // Reject if a memory sync is running — both hold the single-threaded wire
    // for a long PRG bracket; racing them contends for the command channel.
    if state.sync_task_id.lock().unwrap().is_some() {
        return Err(ApiError::Conflict("sync_in_progress".to_string()));
    }
    let mut csv_bytes: Option<Vec<u8>> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("multipart_error: {}", e)))?
    {
        if field.name() == Some("file") {
            let bytes = field
                .bytes()
                .await
                .map_err(|e| ApiError::BadRequest(format!("upload_error: {}", e)))?;
            csv_bytes = Some(bytes.to_vec());
            break;
        }
    }

    let Some(bytes) = csv_bytes else {
        return Err(ApiError::BadRequest("file_required".to_string()));
    };

    let mut imported = 0;
    let mut errors: Vec<Value> = Vec::new();

    // Validate every row against the CONNECTED scanner's memory model.
    let caps = state.capabilities();

    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_reader(bytes.as_slice());

    // Parse every row up front. Rows that fail to parse are recorded as errors
    // now; only the valid payloads reach the wire. Knowing the total lets us
    // stream a meaningful "N/total" progress percent.
    let mut writes: Vec<(HashMap<String, String>, ChannelData)> = Vec::new();
    for result in rdr.deserialize::<HashMap<String, String>>() {
        match result {
            Ok(row) => match parse_import_csv_row(&row, &caps) {
                Ok(Some(payload)) => writes.push((row, payload)),
                Ok(None) => {} // empty slot (frequency 0) — skip, not an error
                Err(err) => errors.push(json!({ "row": row, "error": err })),
            },
            Err(err) => errors.push(json!({ "row": {}, "error": err.to_string() })),
        }
    }

    // Hold ONE program-mode bracket for the whole import and write each
    // channel with a single CIN command, trusting the scanner's CIN,OK reply
    // (which is a real acknowledgement — a rejected write returns NG/ERR and
    // is caught as an error). This matches Uniden Sentinel's bulk-write path.
    //
    // The previous code opened its own PRG/EPG per channel AND read every
    // write back inline (4 wire commands each), so a 500-row file took ~8
    // minutes and looked frozen. This is 1 command/channel. On this hardware
    // (~210ms/wire-command, per docs/wire_captures) a full ~355-channel file
    // lands in ~75-80s; the wire latency is the floor, not the command count.
    // Progress is streamed over the WS.
    let total = writes.len();
    {
        let _prg = ProgramModeGuard::enter(&state).await?;
        for (n, (row, payload)) in writes.into_iter().enumerate() {
            // Retry a failed write once. A single dropped CIN,OK (transient
            // wire hiccup under load) would otherwise permanently fail one
            // channel; the protocol's timeout policy is "retry once, then
            // fail". Only genuine rejections (NG/ERR twice) become errors.
            // REGRESSION GUARD (#556, findings 3/4/5): the import stores what the
            // SCANNER reports, not what the file said.
            //
            // This used `write_channel_no_readback`, which returns nothing
            // verified, so the loop cached its own intent. The firmware
            // silently refuses an in-place priority 1->0, so every imported row
            // disagreeing on that field was cached as a lie -- and since #413
            // the lie is flushed to SQLite and re-adopted at every connect.
            //
            // `write_channel_to_scanner` writes, reads back, and returns the
            // readback. It costs one extra CIN per row: about +5 s on a full
            // 500-channel import, measured against the ~5 s a 500-channel read
            // takes. It also picks up the #595 priority-displacement re-read,
            // so a row that takes priority no longer leaves the bank's previous
            // holder stale.
            let mut result = write_channel_to_scanner(&state, &payload).await;
            if result.is_err() {
                result = write_channel_to_scanner(&state, &payload).await;
            }
            match result {
                Ok(verified) => {
                    imported += 1;
                    state
                        .shadow
                        .write()
                        .unwrap()
                        .channels
                        .insert(verified.index, verified);
                }
                Err(err) => errors.push(json!({ "row": row, "error": format!("{:?}", err) })),
            }
            if total > 0 && (n + 1) % 10 == 0 {
                let percent = ((n + 1) * 99 / total) as u8;
                import_progress(
                    &state,
                    "import-csv",
                    percent,
                    &format!("Importing {}/{}", n + 1, total),
                );
            }
        }
    }
    import_progress(&state, "import-csv", 100, "Import complete");

    Ok(Json(json!({ "imported": imported, "errors": errors })))
}

/// Broadcast import progress over the WebSocket, mirroring the memory-sync
/// `progress` shape so the frontend's progress handler can display it. The
/// `task_id` distinguishes CSV (`import-csv`) from .ss (`import-ss`); the UI
/// treats any `import*` task_id the same.
pub(crate) fn import_progress(state: &AppState, task_id: &str, percent: u8, message: &str) {
    let msg = json!({
        "type": "progress",
        "task_id": task_id,
        "percent": percent,
        "message": message,
    });
    let _ = state.ws_tx.send(msg.to_string());
}

/// Parse one CSV row. `Ok(None)` means an empty channel slot (frequency 0) —
/// the CSV export writes every one of the scanner's slots including empties, so a
/// re-import must treat freq-0 as "skip", not an error. `Ok(Some(_))` is a
/// channel to write; `Err` is a genuinely malformed row.
/// Join settings-file lines the way Uniden's own tool writes them.
///
/// REGRESSION GUARD (`ss_export_uses_crlf`): CRLF, including a trailing one
/// after the last line. Verified against real `.bc125at_ss` and
/// `.bc75xlt_ss` files (2026-08-27) -- every line in both ends `\r\n`.
///
/// Bearpaw emitted bare LF, so the files it produced did not match the format
/// it claimed to write. It went unnoticed because the IMPORT side is immune:
/// Rust's `str::lines()` strips a trailing `\r`, so a Bearpaw-exported file
/// round-tripped through Bearpaw perfectly. Only Uniden's software would have
/// noticed, and nothing here ever fed it one.
fn join_ss_lines(lines: &[String]) -> String {
    format!("{}\r\n", lines.join("\r\n"))
}

fn parse_import_csv_row(
    row: &HashMap<String, String>,
    caps: &ScannerCapabilities,
) -> Result<Option<ChannelData>, String> {
    let parse_bool = |v: &str| -> bool { v.trim().eq_ignore_ascii_case("true") };

    let index: u16 = row
        .get("Index")
        .ok_or_else(|| "Missing Index".to_string())?
        .parse()
        .map_err(|_| "Invalid channel index".to_string())?;
    // Bound by the CONNECTED scanner, not a hardcoded 500. A BC75XLT holds
    // 300 channels; accepting a row for 301-500 queues a write that cannot
    // land, and the old message named a limit that model does not have.
    if !(1..=caps.channel_count).contains(&index) {
        return Err(format!(
            "Invalid channel index: {} (must be 1-{})",
            index, caps.channel_count
        ));
    }

    let frequency: f64 = row
        .get("Frequency")
        .ok_or_else(|| "Missing Frequency".to_string())?
        .parse()
        .map_err(|_| "Invalid frequency".to_string())?;
    // Frequency 0 is how the export represents an empty slot — skip it.
    if frequency == 0.0 {
        return Ok(None);
    }
    // Enforce the canonical 25–512 MHz bound (FREQ_MIN/FREQ_MAX) that the
    // single-channel edit path already applies (#263). Import previously used
    // a wider 25–1300 range, letting a CSV write channels the receiver can't
    // tune — inconsistent with every other channel-write path.
    if super::super::control::validate_frequency(frequency).is_err() {
        return Err(format!("Invalid frequency: {}", frequency));
    }

    let delay: i8 = row
        .get("Delay")
        .map(|s| s.as_str())
        .unwrap_or("2")
        .parse()
        .map_err(|_| "Invalid delay".to_string())?;
    // From the descriptor, not a third hardcoded copy of the BC125AT list.
    // A BC75XLT takes a boolean (0/1); sending it 2 is a CIN format error,
    // and the vendor spec aborts the ENTIRE set command on one.
    if !caps.valid_delays.contains(&delay) {
        return Err(format!(
            "Invalid delay: {} (must be one of {:?})",
            delay, caps.valid_delays
        ));
    }

    // REGRESSION GUARD (`an_import_row_derives_its_bank_and_ignores_the_file`,
    // `an_import_row_with_the_old_zero_bank_still_lands`): the Bank column is
    // DECORATIVE. Derive it from the index; never read it from the file.
    //
    // Bank membership is positional and there is no wire field for it --
    // `build_cin_write_payload_for` does not reference `bank` at all. This used
    // to parse the column, range-check it against `(1..=10)`, and discard the
    // whole row on a mismatch, for a value it then never sent anywhere.
    //
    // The check also punished the more careful user: the `.unwrap_or("1")`
    // default meant DELETING the Bank column imported fine, while KEEPING it
    // with a wrong value killed the row. And #603's export wrote `Bank,0` for
    // every channel, so Bearpaw's own export failed every programmed row on
    // re-import -- 350 of 350 on the dev unit.
    //
    // Derivation is per-model (50 channels per bank on a BC125AT, 30 on a
    // BC75XLT), which is why this reads `caps` rather than dividing by a
    // constant. See the bank-derivation third rail in CLAUDE.md.
    let bank = caps.index_to_bank(index);

    let tone_squelch = row
        .get("CTCSS/DCS")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.parse::<f64>())
        .transpose()
        .map_err(|_| "Invalid CTCSS/DCS".to_string())?;

    let tone_squelch_kind = if tone_squelch.is_some() {
        crate::state::ToneSquelchKind::Ctcss
    } else {
        crate::state::ToneSquelchKind::None
    };

    let modulation = row
        .get("Modulation")
        .map(|s| s.to_uppercase())
        .unwrap_or_else(|| "FM".to_string());
    let alpha_tag = row.get("Alpha Tag").cloned().unwrap_or_default();
    if alpha_tag.len() > 16 {
        return Err("Alpha Tag too long (max 16 chars)".to_string());
    }
    if validate_wire_field(&alpha_tag).is_err() {
        return Err("Alpha Tag contains invalid characters".to_string());
    }
    if validate_wire_field(&modulation).is_err() {
        return Err("Modulation contains invalid characters".to_string());
    }

    Ok(Some(ChannelData {
        index,
        frequency,
        modulation,
        alpha_tag,
        delay,
        lockout: row.get("Lockout").map(|s| parse_bool(s)).unwrap_or(false),
        priority: row.get("Priority").map(|s| parse_bool(s)).unwrap_or(false),
        tone_squelch,
        tone_squelch_kind,
        tone_dcs_code: None,
        bank,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::default_state;
    use crate::protocol::capabilities::{BC125AT_FAMILY, BC75XLT};

    fn row(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn closecall_bands_use_one_equals_enabled() {
        // Regression guard: the CLC close-call bands field uses '1' = enabled,
        // NOT the '0' = enabled convention of the SCG/SSG/CSG masks. Confirmed
        // by a wire probe on fw 1.06.06: raw "01001" reads as [off,on,off,off,on].
        // The .ss export decodes this field with `c == '1'` (see cc_band_flags);
        // using flags_to_bools here would invert CloseCallBands.
        let decode = |s: &str| s.chars().map(|c| c == '1').collect::<Vec<bool>>();
        assert_eq!(decode("01001"), vec![false, true, false, false, true]);
        // flags_to_bools (the mask decoder) would give the inverted result:
        assert_eq!(
            flags_to_bools("01001"),
            vec![true, false, true, true, false]
        );
    }

    #[test]
    fn parse_valid_row_returns_channel() {
        let r = row(&[
            ("Index", "5"),
            ("Frequency", "145.13"),
            ("Modulation", "AUTO"),
            ("Alpha Tag", "Test"),
            ("Delay", "2"),
            ("Lockout", "false"),
            ("Priority", "false"),
            ("Bank", "1"),
        ]);
        let ch = parse_import_csv_row(&r, &BC125AT_FAMILY)
            .unwrap()
            .expect("should be Some");
        assert_eq!(ch.index, 5);
        assert!((ch.frequency - 145.13).abs() < 0.00005);
        assert_eq!(ch.alpha_tag, "Test");
    }

    #[test]
    fn parse_empty_slot_is_skipped_not_error() {
        // Frequency 0 is how the export marks an empty slot — must be Ok(None),
        // NOT an error. Regression guard for the "hundreds of import errors"
        // bug where re-importing an exported file failed on every empty channel.
        let r = row(&[("Index", "6"), ("Frequency", "0")]);
        assert!(parse_import_csv_row(&r, &BC125AT_FAMILY).unwrap().is_none());
    }

    #[test]
    fn parse_out_of_band_frequency_is_error() {
        // A non-zero frequency outside 25–512 MHz is genuinely malformed.
        let r = row(&[("Index", "6"), ("Frequency", "9999")]);
        assert!(parse_import_csv_row(&r, &BC125AT_FAMILY).is_err());
    }

    #[test]
    fn parse_frequency_above_512_is_error() {
        // Regression guard (#263): import must enforce the same 25–512 MHz
        // bound (FREQ_MAX) as the single-channel edit path. A value like
        // 900 MHz — inside the old, wrong 25–1300 import bound but outside the
        // scanner's tunable range — must be rejected, not silently programmed.
        let r = row(&[("Index", "6"), ("Frequency", "900")]);
        assert!(parse_import_csv_row(&r, &BC125AT_FAMILY).is_err());
    }

    #[test]
    fn parse_frequency_at_512_is_accepted() {
        // The upper bound is inclusive (FREQ_MAX = 512.0).
        let r = row(&[("Index", "7"), ("Frequency", "512")]);
        assert!(parse_import_csv_row(&r, &BC125AT_FAMILY).unwrap().is_some());
    }

    #[test]
    fn parse_bad_index_is_error() {
        let r = row(&[("Index", "501"), ("Frequency", "145.13")]);
        assert!(parse_import_csv_row(&r, &BC125AT_FAMILY).is_err());
    }

    /// REGRESSION GUARD (#433): the CSV index bound follows the CONNECTED
    /// scanner, not a hardcoded 500. A BC75XLT holds 300 channels; accepting a
    /// row for 301 queues a write that cannot land, and the old error named a
    /// limit that model does not have.
    #[test]
    fn csv_import_bounds_the_index_by_the_connected_model() {
        let r = row(&[("Index", "301"), ("Frequency", "146.7000"), ("Delay", "0")]);
        assert!(
            parse_import_csv_row(&r, &BC125AT_FAMILY).is_ok(),
            "301 is a real channel on a 500-channel scanner"
        );

        let err = parse_import_csv_row(&r, &BC75XLT).expect_err("301 does not exist on a BC75XLT");
        assert!(
            err.contains("1-300"),
            "the message must name THIS model's limit, got: {err}"
        );
    }

    /// REGRESSION GUARD (#433): the delay allowlist comes from the descriptor,
    /// not a third hardcoded copy of the BC125AT list. A BC75XLT takes a
    /// boolean (0/1); sending it 2 is a CIN format error, and the vendor spec
    /// aborts the ENTIRE set command on one -- so a single bad delay in an
    /// imported row would silently discard that row's frequency and lockout.
    #[test]
    fn csv_import_takes_the_delay_allowlist_from_capabilities() {
        let r = row(&[("Index", "1"), ("Frequency", "146.7000"), ("Delay", "2")]);
        assert!(
            parse_import_csv_row(&r, &BC125AT_FAMILY).is_ok(),
            "2 seconds is a legal BC125AT delay"
        );
        assert!(
            parse_import_csv_row(&r, &BC75XLT).is_err(),
            "2 is not a legal delay on a scanner whose delay is a boolean"
        );

        let boolean = row(&[("Index", "1"), ("Frequency", "146.7000"), ("Delay", "1")]);
        assert!(parse_import_csv_row(&boolean, &BC75XLT).is_ok());
    }

    /// A negative pre-delay is legal on the BC125AT family and not on a
    /// BC75XLT — the same rule from the other direction.
    #[test]
    fn csv_import_still_accepts_bc125at_pre_delays() {
        let r = row(&[("Index", "1"), ("Frequency", "146.7000"), ("Delay", "-10")]);
        assert!(parse_import_csv_row(&r, &BC125AT_FAMILY).is_ok());
        assert!(parse_import_csv_row(&r, &BC75XLT).is_err());
    }

    /// REGRESSION GUARD: the settings file uses CRLF, including after the last
    /// line. Confirmed against real files written by Uniden's own tool
    /// (`kf0nui_042525.bc125at_ss`, `kf0nui_042525.bc75xlt_ss`, 2026-08-27):
    /// 537 and 336 CRLF respectively, zero bare LF in either.
    #[test]
    fn ss_export_uses_crlf() {
        let out = join_ss_lines(&["Misc\tK+S".to_string(), "Priority\tOff".to_string()]);
        assert_eq!(out, "Misc\tK+S\r\nPriority\tOff\r\n");
        assert_eq!(out.matches("\r\n").count(), 2, "including a trailing one");
        assert_eq!(
            out.matches('\n').count(),
            out.matches("\r\n").count(),
            "no bare LF may survive -- the real files contain none"
        );
    }

    /// REGRESSION GUARD (#507): Uniden writes `Auto` in title case and the
    /// three explicit modulations in upper case. Confirmed across three files
    /// its own software produced -- a blank, a round-trip, and a
    /// read-from-scanner -- all agreeing.
    ///
    /// Bearpaw wrote the raw `CIN` value (`AUTO`). Cosmetic rather than data
    /// loss, since the parser preserved `FM`/`AM`/`NFM` through a round-trip,
    /// but matched anyway so the tone and modulation columns are not
    /// inconsistent about whose spelling they follow.
    #[test]
    fn ss_modulation_column_uses_unidens_casing() {
        assert_eq!(ss_modulation_label("AUTO"), "Auto");
        assert_eq!(ss_modulation_label("FM"), "FM");
        assert_eq!(ss_modulation_label("AM"), "AM");
        assert_eq!(ss_modulation_label("NFM"), "NFM");

        // Only reachable from a ChannelData that predates a memory sync. The
        // blank reference file writes `Auto` on all 500 unprogrammed rows.
        assert_eq!(ss_modulation_label(""), "Auto");
    }

    /// REGRESSION GUARD (#459): `AvoidFreqs` is a PACKED list OFFSET BY ONE.
    ///
    /// Measured 2026-08-29: two global lockouts set on a real BC125AT in a
    /// known order, read back by BC125AT SS. Values landed in fields 2 and 3
    /// with field 1 empty:
    ///
    /// ```text
    /// AvoidFreqs<TAB><TAB>116733300<TAB>122883300<TAB>...14 empties
    /// ```
    ///
    /// The single pre-existing sample had its one value at field 2 too, which
    /// alone could not distinguish this from fixed positions. Two values in a
    /// known order settle it. Writing from field 1 instead would shift every
    /// entry by one slot -- a file Uniden's tool would read as a different set
    /// of frequencies, not as an error.
    #[test]
    fn avoid_freqs_packs_from_field_two() {
        // 100 Hz units, as the GLF walk yields them.
        let line = build_avoid_freqs_line(&[1_167_333, 1_228_833]).expect("non-empty");
        let f: Vec<&str> = line.split('\t').collect();

        assert_eq!(f.len(), 18, "keyword plus 17 slots");
        assert_eq!(f[0], "AvoidFreqs");
        assert_eq!(f[1], "", "field 1 is never a frequency");
        assert_eq!(f[2], "116733300", "first value at field 2, in integer Hz");
        assert_eq!(f[3], "122883300", "second at field 3, insertion order");
        assert!(f[4..].iter().all(|v| v.is_empty()), "rest empty");

        // Byte-exact against the measured line.
        assert_eq!(
            line,
            "AvoidFreqs\t\t116733300\t122883300\t\t\t\t\t\t\t\t\t\t\t\t\t\t"
        );
    }

    /// The section is ABSENT at zero lockouts -- confirmed by the blank
    /// reference file. An all-empty `AvoidFreqs` line is a shape no real file
    /// has, so this must be None rather than a padded line.
    #[test]
    fn avoid_freqs_is_absent_when_there_are_no_lockouts() {
        assert!(build_avoid_freqs_line(&[]).is_none());
    }

    /// Over-long lists are truncated to the slots the format has, not silently
    /// widened into a line shape nothing has ever produced.
    #[test]
    fn avoid_freqs_truncates_to_the_slots_the_format_has() {
        let many: Vec<u32> = (1..=20).map(|i| 1_000_000 + i).collect();
        let line = build_avoid_freqs_line(&many).expect("non-empty");
        let f: Vec<&str> = line.split('\t').collect();
        assert_eq!(f.len(), 18, "line stays 18 fields no matter the input");
        assert_eq!(f[2], "100000100", "first written");
        assert_eq!(f[17], "100001600", "16th written, last slot");
    }

    /// REGRESSION GUARD (#516): the `.bc125at_ss` tone column uses Uniden's
    /// spellings, which are NOT the UI's labels.
    ///
    /// Measured 2026-08-29: a CTCSS and a DCS channel were written to a real
    /// BC125AT, then BC125AT SS read the radio and saved. It wrote `C100.0` and
    /// `D023`. Bearpaw had been writing `100.0` and `DCS 023`; round-tripping a
    /// Bearpaw file through the tool brought both back as `Off` while every
    /// other field survived -- silent data loss on any channel with a tone.
    ///
    /// The golden test cannot catch this. It compares section/field-count
    /// shape, and every reference file in `fixtures/` is `Off` on all 500 rows,
    /// so the column has never been exercised with a value by anything else.
    #[test]
    fn ss_tone_column_uses_unidens_spellings() {
        let ctcss = ChannelData {
            tone_squelch_kind: ToneSquelchKind::Ctcss,
            tone_squelch: Some(100.0),
            ..Default::default()
        };
        assert_eq!(ss_tone_label(&ctcss), "C100.0", "CTCSS takes a C prefix");

        // 128 is the wire code for DCS 023 (protocol/tones.rs). The column wants
        // the Motorola number zero-padded to three digits, not the wire code and
        // not the `DCS 023` display label.
        let dcs = ChannelData {
            tone_squelch_kind: ToneSquelchKind::Dcs,
            tone_dcs_code: Some(128),
            ..Default::default()
        };
        assert_eq!(
            ss_tone_label(&dcs),
            "D023",
            "DCS takes a D prefix, no space"
        );

        // Verified on every reference file: an untoned channel is `Off`.
        assert_eq!(ss_tone_label(&ChannelData::default()), "Off");

        // Verified 2026-08-29 the same way as the other two: set to Search in
        // BC125AT SS and saved. It does NOT take a one-letter prefix.
        let search = ChannelData {
            tone_squelch_kind: ToneSquelchKind::Search,
            ..Default::default()
        };
        assert_eq!(ss_tone_label(&search), "Srch");

        // A kind set with its value missing must not emit a half-written tone.
        let broken = ChannelData {
            tone_squelch_kind: ToneSquelchKind::Ctcss,
            tone_squelch: None,
            ..Default::default()
        };
        assert_eq!(ss_tone_label(&broken), "Off");
    }

    // REGRESSION GUARD (`an_exported_csv_re_imports`): every row `export_csv`
    // writes must survive `parse_import_csv_row`. Export -> import is the round
    // trip users actually perform, and nothing pinned it end to end.
    //
    // `parse_cin_response` deliberately leaves `bank: 0` (#421 moved bank
    // derivation out of the pure parser; see the third-rail table in CLAUDE.md),
    // so the cache holds 0 for every channel and only `channels_with_banks`
    // fills it in. `export_csv` read the cache directly and wrote that 0 into
    // the Bank column, which the importer rejects with "Invalid bank: 0" -- so
    // Bearpaw's own export could not be re-imported. Measured on the dev unit
    // 2026-09-01: 350 programmed channels, 350 errors, 0 imported. The 150
    // cleared rows returned `Ok(None)` and were dropped from BOTH counts, which
    // is why the toast under-reported the damage.
    //
    // This drives the REAL `export_csv`. Every neighbouring test in this module
    // hand-builds its row with `("Bank", "1")` -- a value the export never
    // produced -- so all of them passed for the entire life of the bug.
    // `parse_empty_slot_is_skipped_not_error` even cites "the hundreds of import
    // errors bug", having fixed only the cleared-channel half of it.
    //
    // Asserting the derived VALUE, not merely that the row parses, is what makes
    // this mutation-proof: an export hardcoding 1 would satisfy a
    // parses-without-error check while misfiling every channel above bank 1.
    #[tokio::test]
    async fn an_exported_csv_re_imports() {
        let state = default_state();
        state.device.write().unwrap().capabilities = Some(BC125AT_FAMILY);
        {
            let mut shadow = state.shadow.write().unwrap();
            // Banks 1, 2 and 10 on a 50-per-bank model. Index 1 is deliberately
            // included: it derives to bank 1, so a hardcoded 1 would pass on
            // that row alone and fail on the other two.
            for index in [1u16, 60, 500] {
                shadow.channels.insert(
                    index,
                    ChannelData {
                        index,
                        frequency: 146.52,
                        alpha_tag: "Round Trip".to_string(),
                        // As the parser leaves it, and as the cache holds it.
                        bank: 0,
                        ..Default::default()
                    },
                );
            }
        }

        let response = export_csv(State(state)).await.into_response();
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let csv = String::from_utf8(bytes.to_vec()).unwrap();

        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(true)
            .from_reader(csv.as_bytes());
        let mut seen = Vec::new();
        for result in rdr.deserialize::<HashMap<String, String>>() {
            let row = result.expect("export must emit parseable CSV");
            let parsed = parse_import_csv_row(&row, &BC125AT_FAMILY)
                .unwrap_or_else(|e| panic!("exported row failed to re-import: {e} -- {row:?}"))
                .expect("a programmed row must not be skipped as empty");
            seen.push((parsed.index, parsed.bank));
        }

        seen.sort();
        assert_eq!(
            seen,
            vec![(1u16, 1u8), (60, 2), (500, 10)],
            "export must write the bank derived from the connected scanner"
        );
    }

    // REGRESSION GUARD (#604): the Bank column is DECORATIVE. The import
    // derives bank from the channel index and ignores whatever the file said.
    //
    // Bank membership is positional on both families -- channels 1-50 are bank
    // 1 on a BC125AT, 1-30 on a BC75XLT -- and there is no wire field for it at
    // all. `build_cin_write_payload_for` never reads `bank`, so the importer
    // was parsing a value, validating it, discarding whole rows over it, and
    // then not using it.
    //
    // The old check was `(1..=10).contains(&bank)` with a `.unwrap_or("1")`
    // default, which punished the more careful user: DELETING the Bank column
    // imported fine, while KEEPING it with a wrong value killed the row. #603's
    // export wrote `Bank,0` for every channel, so Bearpaw's own export failed
    // every programmed row on re-import.
    //
    // Both models are asserted because the derivation is per-model and the two
    // disagree at this index: channel 31 is bank 1 on a 50-per-bank BC125AT and
    // bank 2 on a 30-per-bank BC75XLT. A single-model assertion would pass for
    // a build that hardcoded either width -- the bank-derivation third rail in
    // CLAUDE.md is exactly that mistake, made in three places at once.
    #[test]
    fn an_import_row_derives_its_bank_and_ignores_the_file() {
        // Channel 31, with a Bank column that is wrong under BOTH models.
        let r = row(&[
            ("Index", "31"),
            ("Frequency", "145.13"),
            ("Modulation", "AUTO"),
            ("Alpha Tag", "Derived"),
            // 0 is the only delay valid on BOTH families: a BC75XLT takes a
            // boolean (`valid_delays` is [0, 1]) and rejects the BC125AT's 2.
            ("Delay", "0"),
            ("Lockout", "false"),
            ("Priority", "false"),
            ("Bank", "7"),
        ]);

        let on_125 = parse_import_csv_row(&r, &BC125AT_FAMILY)
            .expect("a wrong bank must not fail the row")
            .expect("a programmed row must not be skipped");
        assert_eq!(
            on_125.bank, 1,
            "channel 31 is bank 1 on a 50-per-bank model, whatever the file claims"
        );

        let on_75 = parse_import_csv_row(&r, &BC75XLT)
            .expect("a wrong bank must not fail the row")
            .expect("a programmed row must not be skipped");
        assert_eq!(
            on_75.bank, 2,
            "channel 31 is bank 2 on a 30-per-bank model, whatever the file claims"
        );
    }

    /// REGRESSION GUARD (#604), paired with
    /// `an_import_row_derives_its_bank_and_ignores_the_file`.
    ///
    /// `Bank,0` is the specific value #603's export wrote for every channel,
    /// and the value the old `(1..=10)` check rejected. Any file written by a
    /// Bearpaw build before #603 still carries it, so this has to keep working
    /// after the derivation guard above is satisfied — a build that derived the
    /// bank but kept the range check would pass that test and still reject
    /// every row of an old export.
    #[test]
    fn an_import_row_with_the_old_zero_bank_still_lands() {
        let r = row(&[
            ("Index", "60"),
            ("Frequency", "145.13"),
            ("Modulation", "AUTO"),
            ("Alpha Tag", "Old Export"),
            ("Delay", "2"),
            ("Lockout", "false"),
            ("Priority", "false"),
            ("Bank", "0"),
        ]);

        let ch = parse_import_csv_row(&r, &BC125AT_FAMILY)
            .expect("Bank,0 is what every pre-#603 export wrote; it must import")
            .expect("a programmed row must not be skipped");
        assert_eq!(ch.bank, 2, "channel 60 is bank 2 on a 50-per-bank model");
    }
}
