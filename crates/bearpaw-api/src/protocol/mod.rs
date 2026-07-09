//! Uniden BC125AT/BCT125AT wire protocol parsers.
//!
//! Wire-format references: docs/SCANNER_PROTOCOL_REFERENCE.md and the captured
//! fixtures in docs/wire_captures/. All parsers are total (never panic) and
//! defensive against firmware-version variance — see fixture 2026-05-21 from
//! firmware 1.06.06, which emits a different STS field count than the
//! research doc's 1.04.02.

pub mod defaults;
pub mod tones;

use crate::state::{ChannelData, LiveState, ScannerMode, ToneSquelchKind};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("parse error: {0}")]
    Parse(String),
}

/// Classified scanner response. The BC125AT protocol uses four distinct reply
/// shapes that current code conflates by substring-matching "OK". Per the
/// reference (`docs/BC125AT_PROTOCOL.md` §3) and our wire captures:
///
/// - `OK` — set succeeded, or the verb itself was a side-effect-only command.
/// - `Err` — syntax or out-of-range error. **Never retry**; surface as a
///   bad-request to the caller.
/// - `Ng` — "Not Good": command is legal but wrong mode (e.g. tried `CIN`
///   outside `PRG`). **Never retry**; the caller did something semantically
///   wrong.
/// - `EndOfList` — the `-1` sentinel used by `GLF` to indicate "no more
///   entries". Not actually an error.
/// - `Data` — anything else: a parseable response with payload fields.
///
/// Single-token responses (`OK`, `ERR`, `NG`) and command-prefixed forms
/// (`<CMD>,OK`, `<CMD>,ERR`, `<CMD>,NG`) both classify the same.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScannerReply {
    Ok,
    Err,
    Ng,
    EndOfList,
    Data(String),
}

/// Classify a raw scanner response string into one of the four reply shapes.
/// Input is the response with leading/trailing whitespace already trimmed by
/// the transport layer; this function further normalises case and trims
/// inner whitespace on each comma-split field.
pub fn classify_response(response: &str) -> ScannerReply {
    let trimmed = response.trim();
    if trimmed.is_empty() {
        return ScannerReply::Data(trimmed.to_string());
    }
    let upper = trimmed.to_uppercase();
    // Bare tokens — no comma — match a small fixed set.
    if !upper.contains(',') {
        return match upper.as_str() {
            "OK" => ScannerReply::Ok,
            "ERR" => ScannerReply::Err,
            "NG" => ScannerReply::Ng,
            "-1" => ScannerReply::EndOfList,
            _ => ScannerReply::Data(trimmed.to_string()),
        };
    }
    // <CMD>,<token> form — look at the last comma-separated field.
    let last = upper.rsplit(',').next().map(|s| s.trim()).unwrap_or("");
    match last {
        "OK" => ScannerReply::Ok,
        "ERR" => ScannerReply::Err,
        "NG" => ScannerReply::Ng,
        "-1" => ScannerReply::EndOfList,
        _ => ScannerReply::Data(trimmed.to_string()),
    }
}

// ---------- MDL ----------

/// MDL response: "MDL,BC125AT" -> "BC125AT".
pub fn parse_mdl_response(response: &str) -> Option<String> {
    let line = response.lines().next()?.trim();
    let (cmd, model) = line.split_once(',')?;
    if !cmd.trim().eq_ignore_ascii_case("MDL") {
        return None;
    }
    let model = model.trim();
    if model.is_empty() || model.len() > 32 {
        return None;
    }
    if !model
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }
    Some(model.to_string())
}

// ---------- STS ----------

/// Parsed STS LCD-dump frame. Bearpaw only consumes `squelch_open` and
/// `sig_lvl`; everything else is here so tests can pin the field layout.
#[derive(Clone, Debug, Default)]
pub struct StsFrame {
    pub squelch_open: bool,
    pub muted: bool,
    /// Signal level bars, 0–5 (LCD scale, not a 0–100 percentage).
    pub sig_lvl: u8,
    /// Backlight dimmer: 0=Off, 1=Low, 2=Mid, 3=High.
    pub bk_dimmer: u8,
}

/// Parse an STS response. Returns `None` for empty or unrecognisable input.
///
/// STS is a single-line, comma-separated LCD dump:
///   `STS,<DSP_FORM>,<lines+modes alternating>,<SQL>,<MUT>,<RSV>,<WAT>,<LED_CC>,<LED_ALERT>,<SIG_LVL>,<RSV>,<BK_DIMMER>`
///
/// The number of LCD lines varies by firmware (4 on 1.04.02, 5+ on 1.06.06).
/// The status tail (the last ~9 numeric fields after the LCD section) is
/// stable, so we anchor from the tail. SIG_LVL is the 3rd-from-last numeric
/// field; SQL is the first numeric in the status block (right after the last
/// non-empty line/mode pair).
///
/// See `docs/BC125AT_PROTOCOL.md` §10 ("Parsing STS") and the captures in
/// `docs/wire_captures/2026-05-21/audit-reconciliation.md` finding 1.
pub fn parse_sts_frame(response: &str) -> Option<StsFrame> {
    let line = response.lines().find(|l| !l.trim().is_empty())?.trim();
    let line = line.strip_suffix('\r').unwrap_or(line);
    let parts: Vec<&str> = line.split(',').collect();
    if parts.len() < 6 {
        return None;
    }
    if !parts[0].eq_ignore_ascii_case("STS") {
        return None;
    }

    // Walk back from the end to find the status-bits tail. The tail is a run
    // of ≥9 trailing fields where SQL/MUT/SIG_LVL/BK_DIMMER live. We anchor
    // by finding the last position where two adjacent fields are both
    // unambiguously single 0/1 digits (the LED_CC/LED_ALERT pair). Tail
    // layout (1.06.06 capture): ..., SQL, MUT, _, _, _, _, SIG_LVL, _, BK_DIMMER.
    //
    // Defensive: if anchoring fails, return None so the caller re-polls.
    let tail_start = find_sts_tail_start(&parts)?;
    let tail = &parts[tail_start..];

    let sql = tail.first().and_then(|s| parse_bit(s))?;
    let muted = tail.get(1).and_then(|s| parse_bit(s)).unwrap_or(false);
    // SIG_LVL is at tail offset 6 in the observed layout; bounds-check.
    let sig_lvl = tail
        .get(6)
        .and_then(|s| s.trim().parse::<u8>().ok())
        .unwrap_or(0)
        .min(5);
    let bk_dimmer = tail
        .get(8)
        .and_then(|s| s.trim().parse::<u8>().ok())
        .unwrap_or(0)
        .min(3);

    Some(StsFrame {
        squelch_open: sql,
        muted,
        sig_lvl,
        bk_dimmer,
    })
}

/// Find the index in `parts` where the status-bit tail begins.
///
/// The tail has exactly 9 fields with a known signature:
///   [0] SQL       single 0/1
///   [1] MUT       single 0/1
///   [2] reserved  0/1 (some firmwares)
///   [3] WAT       0/1
///   [4] LED_CC    0/1 or empty
///   [5] LED_ALERT 0/1 or empty
///   [6] SIG_LVL   0..=5
///   [7] reserved  empty
///   [8] BK_DIMMER 0..=3
///
/// Original heuristic looked for ANY adjacent `(0|1, 0|1)` pair walking from
/// the end backward, intending to find SQL,MUT. Bug: on firmwares where
/// LED_CC and LED_ALERT both carry a 0/1 value (rather than empty), the
/// walker locks onto that pair four positions too late and reads LED_CC as
/// SQL — that's the disagreement filed as issue #73.
///
/// New approach: anchor on the *back end* of the tail. Walk every legal
/// position and accept only if BK_DIMMER (offset 8) is a single 0..=3 digit
/// AND SIG_LVL (offset 6) is a single 0..=5 digit AND SQL (offset 0) is a
/// single 0/1 digit. That signature is unique within the STS frame; the LCD
/// section can't accidentally match because its character cells are
/// multi-character padded strings, not single digits.
fn find_sts_tail_start(parts: &[&str]) -> Option<usize> {
    if parts.len() < 10 {
        return None;
    }
    let max_start = parts.len().saturating_sub(9);
    for i in (1..=max_start).rev() {
        if matches_sts_tail_signature(parts, i) {
            return Some(i);
        }
    }
    None
}

/// True if positions [i..i+9] in `parts` match the documented STS tail
/// signature: SQL/MUT 0-or-1 at offsets 0/1, SIG_LVL 0-to-5 at offset 6,
/// BK_DIMMER 0-to-3 at offset 8.
fn matches_sts_tail_signature(parts: &[&str], i: usize) -> bool {
    let sql_ok = matches!(parts.get(i).map(|s| s.trim()), Some("0" | "1"));
    let mut_ok = matches!(parts.get(i + 1).map(|s| s.trim()), Some("0" | "1"));
    let sig_ok = parts
        .get(i + 6)
        .map(|s| s.trim())
        .and_then(|s| s.parse::<u8>().ok())
        .is_some_and(|n| n <= 5);
    // BK_DIMMER may be EMPTY on some firmware (#143): the reference doc's own
    // 1.04.02 example ends `...,1,,`. An empty field is accepted (parsed as 0
    // downstream); a non-empty field must still be a 0-3 digit.
    let dimmer_ok = parts
        .get(i + 8)
        .map(|s| s.trim())
        .is_some_and(|s| s.is_empty() || s.parse::<u8>().ok().is_some_and(|n| n <= 3));
    sql_ok && mut_ok && sig_ok && dimmer_ok
}

fn parse_bit(s: &str) -> Option<bool> {
    match s.trim() {
        "0" => Some(false),
        "1" => Some(true),
        _ => None,
    }
}

// ---------- GLG ----------

/// Parsed GLG frame: the canonical live-state source on the BC125AT family.
#[derive(Clone, Debug, Default)]
pub struct GlgFrame {
    /// Frequency in MHz; 0.0 if idle / empty frame.
    pub frequency: f64,
    /// "AM" / "FM" / "NFM" / "AUTO" or empty.
    pub modulation: String,
    /// CTCSS/DCS code 0–231 (0 = no tone). Decoded to Hz at the API boundary.
    pub tone_code: u16,
    /// First non-empty alpha tag (BC125AT uses one of three name fields).
    pub alpha_tag: Option<String>,
    pub squelch_open: bool,
    pub muted: bool,
    /// Current memory channel index, if reported (firmware-dependent).
    pub channel: Option<u16>,
    /// True if the entire response was the idle skeleton `GLG,,,,,,,,,`.
    pub idle: bool,
}

/// Parse a GLG response.
///
/// Format: `GLG,<FRQ>,<MOD>,<ATT>,<TONE>,<N1>,<N2>,<N3>,<SQL>,<MUT>[,<RSV>,<CHAN_NUM>]`
///
/// FRQ is 8-digit integer in 100 Hz units. Idle (no current channel) returns
/// a skeleton with all data fields empty (`GLG,,,,,,,,,`). Trailing channel
/// number is present on firmware 1.06.06 but firmware-dependent in general.
///
/// See `docs/BC125AT_PROTOCOL.md` §10 ("Parsing GLG"). BC125AT only uses one
/// of the three name fields (N1/N2/N3); we surface the first non-empty.
pub fn parse_glg_response(response: &str) -> Option<GlgFrame> {
    let line = response.lines().find(|l| !l.trim().is_empty())?.trim();
    let line = line.strip_suffix('\r').unwrap_or(line);
    let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    if parts.len() < 10 {
        return None;
    }
    if !parts[0].eq_ignore_ascii_case("GLG") {
        return None;
    }

    let frequency = parse_freq_field(parts[1]);
    let modulation = match parts[2].to_uppercase().as_str() {
        m @ ("AM" | "FM" | "NFM" | "AUTO") => m.to_string(),
        _ => String::new(),
    };
    let tone_code = parts[4].parse::<u16>().unwrap_or(0);
    let alpha_tag = [parts[5], parts[6], parts[7]]
        .iter()
        .map(|s| s.trim())
        .find(|s| !s.is_empty())
        .map(|s| s.to_string());
    let squelch_open = parse_bit(parts[8]).unwrap_or(false);
    let muted = parse_bit(parts[9]).unwrap_or(false);
    // Channel number: try the trailing field if present.
    let channel = parts.get(11).and_then(|s| s.parse::<u16>().ok());

    let idle = frequency == 0.0 && modulation.is_empty() && alpha_tag.is_none();

    Some(GlgFrame {
        frequency,
        modulation,
        tone_code,
        alpha_tag,
        squelch_open,
        muted,
        channel,
        idle,
    })
}

// ---------- PWR ----------

/// Parsed PWR frame: raw RSSI (0–1023) and current frequency.
#[derive(Clone, Debug, Default)]
pub struct PwrFrame {
    pub rssi_raw: u16,
    pub frequency: f64,
}

/// Parse a PWR response: `PWR,<rssi 0-1023>,<freq*10000>`.
pub fn parse_pwr_response(response: &str) -> Option<PwrFrame> {
    let line = response.lines().find(|l| !l.trim().is_empty())?.trim();
    let line = line.strip_suffix('\r').unwrap_or(line);
    let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    if parts.len() < 3 || !parts[0].eq_ignore_ascii_case("PWR") {
        return None;
    }
    let rssi_raw = parts[1].parse::<u16>().ok()?.min(1023);
    let frequency = parse_freq_field(parts[2]);
    Some(PwrFrame {
        rssi_raw,
        frequency,
    })
}

/// Map raw PWR RSSI (0–1023) to Bearpaw's 0–100 scale.
pub fn rssi_raw_to_scaled(raw: u16) -> u8 {
    let pct = (raw as u32 * 100) / 1023;
    pct.min(100) as u8
}

// ---------- CIN ----------

/// Parse a CIN response into ChannelData.
///
/// BC125AT CIN field order (per Uniden BC125AT PC Protocol v1.01):
///   `CIN,<index>,<alpha_tag>,<freq>,<mod>,<tone_code>,<delay>,<lockout>,<priority>`
///
/// 8 data fields after `CIN`. No bank field exists on the wire; bank
/// membership comes from `SCG`.
///
/// `tone_code` is an integer 0–231, NOT a frequency in Hz. The
/// `ChannelData.tone_squelch` field is populated from a code→Hz translation
/// via `protocol::tones::decode_tone`.
pub fn parse_cin_response(index: u16, response: &str) -> Option<ChannelData> {
    // REGRESSION GUARD (#134): reject scanner error / end-of-list replies.
    // Without this, `CIN,NG` / `CIN,ERR` / bare `-1` are parsed as a channel
    // whose alpha tag is "NG"/"ERR", which memory sync then caches and serves
    // as real channel data (and, when PRG is refused, wipes the whole cache
    // with 500 phantom "NG" channels).
    match classify_response(response) {
        ScannerReply::Err | ScannerReply::Ng | ScannerReply::EndOfList => return None,
        _ => {}
    }

    let line = response.lines().find(|l| !l.trim().is_empty())?.trim();
    let line = line.strip_suffix('\r').unwrap_or(line);
    let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
    if parts.is_empty() {
        return None;
    }

    // Accept "CIN,<idx>,..." form.
    let mut p = parts.as_slice();
    if p.first().map(|s| s.eq_ignore_ascii_case("CIN")) == Some(true) {
        p = &p[1..];
    }
    // Index field. The wire always echoes `CIN,<index>,...`. If the echoed
    // index is numeric but does not match what we asked for, the response
    // stream has desynced (e.g. a late reply arriving after a timeout) —
    // reject it rather than mis-parsing the index digits as the alpha tag and
    // storing the channel under the wrong key. See #134. A non-numeric first
    // field (index already stripped by the transport) falls through as before.
    match p.first().and_then(|s| s.parse::<u16>().ok()) {
        Some(echoed) if echoed == index => p = &p[1..],
        Some(_) => return None,
        None => {}
    }

    // Empty channel slot: short or all-empty payload.
    if p.is_empty() {
        return Some(empty_channel(index));
    }

    let alpha_tag = p.first().map(|s| s.to_string()).unwrap_or_default();
    let frequency = p.get(1).map(|s| parse_freq_field(s)).unwrap_or(0.0);
    let modulation = match p.get(2).map(|s| s.to_uppercase()).as_deref() {
        Some("AM") => "AM".to_string(),
        Some("FM") => "FM".to_string(),
        Some("NFM") => "NFM".to_string(),
        Some("AUTO") => "AUTO".to_string(),
        _ => "FM".to_string(),
    };
    let tone_code = p.get(3).and_then(|s| s.parse::<u16>().ok()).unwrap_or(0);
    // delay is signed (per docs/BC125AT_PROTOCOL.md §5.3): valid values are
    // `-10, -5, 0, 1, 2, 3, 4, 5`. Negatives are pre-delays. Default to 2
    // (the most common firmware default) when the field is unparseable.
    let delay = p.get(4).and_then(|s| s.parse::<i8>().ok()).unwrap_or(2);
    let lockout = p.get(5).map(|s| *s == "1").unwrap_or(false);
    let priority = p.get(6).map(|s| *s == "1").unwrap_or(false);

    let (tone_squelch_kind, tone_squelch, tone_dcs_code) = decode_tone(tone_code);

    Some(ChannelData {
        index,
        frequency,
        modulation,
        alpha_tag,
        delay,
        lockout,
        priority,
        tone_squelch,
        tone_squelch_kind,
        tone_dcs_code,
        bank: index_to_bank(index),
    })
}

fn empty_channel(index: u16) -> ChannelData {
    ChannelData {
        index,
        frequency: 0.0,
        modulation: "FM".to_string(),
        alpha_tag: String::new(),
        delay: 2,
        lockout: false,
        priority: false,
        tone_squelch: None,
        tone_squelch_kind: ToneSquelchKind::None,
        tone_dcs_code: None,
        bank: index_to_bank(index),
    }
}

/// Validate a channel name against the BC125AT-accepted alphabet before
/// sending a CIN write. Per `docs/BC125AT_PROTOCOL.md` §6.3 (decompiled from
/// `Uniden.Scaner.SS/SntlLib.cs:10`), the firmware accepts only:
///
/// ```text
/// ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*()-/<>.? (space)
/// ```
///
/// Sending any other character results in `ERR` from the scanner. The list
/// is intentionally restrictive — notably **comma is forbidden** (it would
/// break the wire format), as are `_`, `\`, `[]`, `{}`, `:`, `;`, `'`, `"`,
/// `~`, `|`, `+`, `=`, backtick, and all control characters.
///
/// Max length is 16 characters. Empty is allowed on the wire (means
/// "unchanged" on a write per the protocol), but we reject empty here
/// because a write path that wants "unchanged" should pass `None`, not
/// an empty string, to be explicit.
///
/// No caller yet — this is groundwork for the future CIN-write path.
/// See `docs/PROTOCOL_AUDIT_PLAN.md` Phase 9 PR-6.
pub fn validate_channel_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() {
        return Err("channel name is empty");
    }
    if name.chars().count() > 16 {
        return Err("channel name exceeds 16 characters");
    }
    for c in name.chars() {
        let allowed = c.is_ascii_alphanumeric()
            || matches!(
                c,
                ' ' | '!'
                    | '@'
                    | '#'
                    | '$'
                    | '%'
                    | '&'
                    | '*'
                    | '('
                    | ')'
                    | '-'
                    | '/'
                    | '<'
                    | '>'
                    | '.'
                    | '?'
            );
        if !allowed {
            return Err("channel name contains a forbidden character");
        }
    }
    Ok(())
}

/// Map a BC125AT channel index (1–500) to its fixed bank (1–10).
/// Banks are 50 channels each: 1–50 = bank 1, ..., 451–500 = bank 10.
/// Returns 0 for out-of-range input.
pub fn index_to_bank(index: u16) -> u8 {
    if index == 0 || index > 500 {
        return 0;
    }
    ((index - 1) / 50 + 1) as u8
}

/// Decode the CTCSS/DCS code field into kind + Hz + DCS code.
fn decode_tone(code: u16) -> (ToneSquelchKind, Option<f64>, Option<u16>) {
    match code {
        0 | 240 => (ToneSquelchKind::None, None, None),
        127 => (ToneSquelchKind::Search, None, None),
        128..=231 => (ToneSquelchKind::Dcs, None, Some(code)),
        _ => match tones::ctcss_code_to_hz(code) {
            Some(hz) => (ToneSquelchKind::Ctcss, Some(hz), None),
            None => (ToneSquelchKind::None, None, None),
        },
    }
}

// ---------- Frequency / CTCSS helpers ----------

/// Parse a wire frequency field. Accepts both 100 Hz integer encoding
/// (`01469700` → 146.9700) and decimal MHz (`146.9700` → 146.9700).
fn parse_freq_field(s: &str) -> f64 {
    let s = s.trim();
    if s.is_empty() {
        return 0.0;
    }
    if let Ok(n) = s.parse::<u32>() {
        if n >= 10_000 {
            return n as f64 / 10_000.0;
        }
        return n as f64;
    }
    s.parse::<f64>().unwrap_or(0.0)
}

// ---------- LiveState assembly ----------

/// Build a LiveState from one or more parsed frames.
///
/// `mode` is the scheduler's commanded mode (`SCAN`/`HOLD`/`DIRECT`) — there
/// is no mode field on the wire. `volume` is a separately-cached value from
/// the last `VOL` query. `battery` is always None on this protocol family.
pub fn livestate_from_frames(
    sts: Option<&StsFrame>,
    glg: Option<&GlgFrame>,
    pwr: Option<&PwrFrame>,
    commanded_mode: ScannerMode,
    volume: u8,
) -> LiveState {
    let timestamp = std::time::SystemTime::UNIX_EPOCH
        .elapsed()
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0);

    // squelch_open: prefer GLG, fall back to STS. (Both should agree.)
    let squelch_open = glg
        .map(|g| g.squelch_open)
        .or_else(|| sts.map(|s| s.squelch_open))
        .unwrap_or(false);

    // frequency: prefer GLG, then PWR, else 0.0.
    let frequency = glg
        .map(|g| g.frequency)
        .filter(|f| *f > 0.0)
        .or_else(|| pwr.map(|p| p.frequency).filter(|f| *f > 0.0))
        .unwrap_or(0.0);

    let modulation = glg
        .map(|g| g.modulation.clone())
        .filter(|m| !m.is_empty())
        .unwrap_or_else(|| "FM".to_string());

    // rssi: prefer PWR (fine-grained), else STS sig_lvl scaled 0–5 → 0–100.
    let rssi = pwr
        .map(|p| rssi_raw_to_scaled(p.rssi_raw))
        .or_else(|| sts.map(|s| s.sig_lvl.saturating_mul(20)))
        .unwrap_or(0);

    let channel = glg.and_then(|g| g.channel);
    let alpha_tag = glg.and_then(|g| g.alpha_tag.clone());

    LiveState {
        timestamp,
        frequency,
        modulation,
        squelch_open,
        rssi,
        mode: commanded_mode,
        channel,
        alpha_tag,
        volume,
        // Battery is not exposed by the BC125AT/BCT125AT protocol.
        battery: None,
        stale: false,
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures captured from BC125AT firmware 1.06.06 on 2026-05-21.
    // See docs/wire_captures/2026-05-21/raw.txt.

    const STS_SIGNAL_PRESENT: &str = "STS,011000,              ,,GMRS CH 03      ,,CH075  462.6125,,            ,,                ,,123          ,,1,0,0,0,,,5,,3";
    const STS_SIGNAL_ABSENT: &str = "STS,011000,                ,,GMRS CH 03      ,,CH075  462.6125,,            ,,                ,,123          ,,0,1,0,0,,,0,,3";
    const GLG_SIGNAL_PRESENT: &str = "GLG,04626125,NFM,,0,,,GMRS CH 03,1,0,,75,";
    const GLG_SIGNAL_ABSENT: &str = "GLG,04626125,NFM,,0,,,GMRS CH 03,0,1,,75,";
    const PWR_SAMPLE: &str = "PWR,454,04626125";
    const CIN_PROGRAMMED: &str = "CIN,1,Ararat UHF,01451300,AUTO,0,2,0,0";
    const CIN_LOCKED_PLACEHOLDER: &str = "CIN,3,AUTO,00000000,AUTO,0,2,1,0";
    const CIN_PROGRAMMED_LOCKED: &str = "CIN,4,Trimble 640,01466400,AUTO,0,2,1,0";

    #[test]
    fn sts_signal_present_has_squelch_open() {
        let f = parse_sts_frame(STS_SIGNAL_PRESENT).unwrap();
        assert!(f.squelch_open, "SQL=1 must mean squelch open");
        assert!(!f.muted);
        assert_eq!(f.sig_lvl, 5);
        assert_eq!(f.bk_dimmer, 3);
    }

    #[test]
    fn sts_signal_absent_has_squelch_closed() {
        let f = parse_sts_frame(STS_SIGNAL_ABSENT).unwrap();
        assert!(!f.squelch_open);
        assert!(f.muted, "muted should be 1 when no signal");
        assert_eq!(f.sig_lvl, 0);
    }

    #[test]
    fn sts_garbage_returns_none() {
        assert!(parse_sts_frame("").is_none());
        assert!(parse_sts_frame("ERR").is_none());
        assert!(parse_sts_frame("STS,").is_none());
    }

    #[test]
    fn sts_anchors_correctly_when_led_cc_and_led_alert_are_populated() {
        // Regression for issue #73. The original `find_sts_tail_start`
        // heuristic scanned backward for ANY adjacent (0|1, 0|1) pair and
        // assumed it was SQL,MUT. On firmwares where LED_CC and LED_ALERT
        // are both single 0/1 digits (rather than the empty strings in
        // our 2026-05-21 capture), the scan locked onto the LED pair
        // first — four positions late — and read LED_CC as SQL.
        //
        // Synthetic frame: LCD section padded as in the real capture, but
        // the tail's LED_CC and LED_ALERT positions are populated as
        // "1","1" instead of empty. SQL is "1", SIG_LVL is "5",
        // BK_DIMMER is "3" — same as the SIGNAL_PRESENT capture.
        let synthetic = "STS,011000,              ,,GMRS CH 03      ,,CH075  462.6125,,            ,,                ,,123          ,,1,0,0,0,1,1,5,,3";
        let f = parse_sts_frame(synthetic).expect("should parse");
        assert!(
            f.squelch_open,
            "SQL=1 must read as squelch_open=true even when LED_CC/LED_ALERT are 0/1 digits"
        );
        assert!(!f.muted, "MUT=0 must read as muted=false (not flipped)");
        assert_eq!(f.sig_lvl, 5);
        assert_eq!(f.bk_dimmer, 3);
    }

    #[test]
    fn sts_accepts_empty_bk_dimmer_variant() {
        // #143: firmware 1.04.02's documented STS example ends `...,1,,` —
        // BK_DIMMER is an empty field. The tail signature must still anchor
        // (empty dimmer parses as 0) or every STS poll on that firmware is
        // dropped and squelch detection falls back to GLG alone.
        let variant = "STS,011000,              ,,GMRS CH 03      ,,CH075  462.6125,,            ,,                ,,123          ,,1,0,0,0,,,5,,";
        let f = parse_sts_frame(variant).expect("empty BK_DIMMER must still anchor");
        assert!(f.squelch_open);
        assert_eq!(f.sig_lvl, 5);
        assert_eq!(f.bk_dimmer, 0, "empty dimmer field defaults to 0");
    }

    #[test]
    fn sts_tail_signature_requires_signal_and_dimmer_in_range() {
        // If a frame is corrupted such that SIG_LVL > 5 or BK_DIMMER > 3,
        // the anchor heuristic should not lock onto a wrong tail and
        // return garbage — better to return None and re-poll.
        let bad_sig =
            "STS,011000,              ,,GMRS CH 03      ,,CH075  462.6125,,            ,,                ,,123          ,,1,0,0,0,,,9,,3";
        assert!(
            parse_sts_frame(bad_sig).is_none(),
            "SIG_LVL=9 is out of range; should not anchor a tail"
        );
        let bad_dimmer =
            "STS,011000,              ,,GMRS CH 03      ,,CH075  462.6125,,            ,,                ,,123          ,,1,0,0,0,,,5,,9";
        assert!(
            parse_sts_frame(bad_dimmer).is_none(),
            "BK_DIMMER=9 is out of range; should not anchor a tail"
        );
    }

    #[test]
    fn glg_signal_present() {
        let f = parse_glg_response(GLG_SIGNAL_PRESENT).unwrap();
        assert_eq!(f.frequency, 462.6125);
        assert_eq!(f.modulation, "NFM");
        assert_eq!(f.tone_code, 0);
        assert_eq!(f.alpha_tag.as_deref(), Some("GMRS CH 03"));
        assert!(f.squelch_open);
        assert!(!f.muted);
        assert_eq!(f.channel, Some(75));
        assert!(!f.idle);
    }

    #[test]
    fn glg_signal_absent() {
        let f = parse_glg_response(GLG_SIGNAL_ABSENT).unwrap();
        assert!(!f.squelch_open);
        assert!(f.muted);
        assert_eq!(f.frequency, 462.6125);
    }

    #[test]
    fn glg_idle_skeleton() {
        let f = parse_glg_response("GLG,,,,,,,,,").unwrap();
        assert!(f.idle);
        assert_eq!(f.frequency, 0.0);
        assert!(f.alpha_tag.is_none());
    }

    #[test]
    fn pwr_parses_raw_rssi_and_freq() {
        let f = parse_pwr_response(PWR_SAMPLE).unwrap();
        assert_eq!(f.rssi_raw, 454);
        assert_eq!(f.frequency, 462.6125);
    }

    #[test]
    fn rssi_scaling() {
        assert_eq!(rssi_raw_to_scaled(0), 0);
        assert_eq!(rssi_raw_to_scaled(1023), 100);
        assert_eq!(rssi_raw_to_scaled(511), 49);
    }

    #[test]
    fn cin_programmed_channel() {
        let ch = parse_cin_response(1, CIN_PROGRAMMED).unwrap();
        assert_eq!(ch.index, 1);
        assert_eq!(ch.alpha_tag, "Ararat UHF");
        assert_eq!(ch.frequency, 145.13);
        assert_eq!(ch.modulation, "AUTO");
        assert_eq!(ch.delay, 2);
        assert!(!ch.lockout);
        assert!(!ch.priority);
        assert!(ch.tone_squelch.is_none());
        assert_eq!(ch.bank, 1, "channel 1 is in bank 1");
    }

    #[test]
    fn cin_lockout_with_zero_freq() {
        // Sample 3 from the capture: `CIN,3,AUTO,00000000,AUTO,0,2,1,0` —
        // an empty/placeholder slot literally named "AUTO" with lockout=1,
        // priority=0. Used to ensure we read the lockout/priority columns in
        // the correct order (the old parser confused them with bank).
        let ch = parse_cin_response(3, CIN_LOCKED_PLACEHOLDER).unwrap();
        assert_eq!(ch.frequency, 0.0);
        assert!(ch.lockout, "lockout=1 in field 7");
        assert!(!ch.priority, "priority=0 in field 8");
        assert_eq!(ch.bank, 1, "channel 3 is in bank 1 (1-50)");
    }

    #[test]
    fn cin_programmed_lockout() {
        // Sample 4: `CIN,4,Trimble 640,01466400,AUTO,0,2,1,0` — lockout=1.
        let ch = parse_cin_response(4, CIN_PROGRAMMED_LOCKED).unwrap();
        assert_eq!(ch.alpha_tag, "Trimble 640");
        assert_eq!(ch.frequency, 146.64);
        assert!(ch.lockout);
        assert!(!ch.priority);
    }

    #[test]
    fn cin_empty_slot() {
        let ch = parse_cin_response(99, "CIN,99,,,,,,,").unwrap();
        assert_eq!(ch.frequency, 0.0);
        assert_eq!(ch.alpha_tag, "");
    }

    // REGRESSION GUARD: see issue #134. Error/terminator replies must not be
    // parsed into phantom channels named "NG"/"ERR".
    #[test]
    fn cin_rejects_error_replies() {
        assert!(
            parse_cin_response(1, "CIN,NG").is_none(),
            "CIN,NG is not a channel"
        );
        assert!(
            parse_cin_response(1, "CIN,ERR").is_none(),
            "CIN,ERR is not a channel"
        );
        assert!(parse_cin_response(1, "NG").is_none());
        assert!(parse_cin_response(1, "ERR").is_none());
        assert!(parse_cin_response(1, "-1").is_none());
    }

    // REGRESSION GUARD: see issue #134. A reply echoing a different index than
    // requested (FIFO desync after a timeout) must be rejected, not stored
    // under the wrong key with the index digits parsed as the alpha tag.
    #[test]
    fn cin_rejects_index_mismatch() {
        // Asked for 5, scanner echoed 6 → desync.
        assert!(
            parse_cin_response(5, "CIN,6,Ararat UHF,01451300,AUTO,0,2,0,0").is_none(),
            "mismatched echo index must be rejected"
        );
        // Matching index still parses.
        assert!(parse_cin_response(6, "CIN,6,Ararat UHF,01451300,AUTO,0,2,0,0").is_some());
    }

    #[test]
    fn decode_tone_classifies_kind() {
        use crate::state::ToneSquelchKind;
        assert_eq!(decode_tone(0), (ToneSquelchKind::None, None, None));
        assert_eq!(decode_tone(240), (ToneSquelchKind::None, None, None));
        assert_eq!(decode_tone(127), (ToneSquelchKind::Search, None, None));
        assert_eq!(decode_tone(76), (ToneSquelchKind::Ctcss, Some(100.0), None));
        assert_eq!(decode_tone(150), (ToneSquelchKind::Dcs, None, Some(150)));
    }

    #[test]
    fn index_to_bank_maps_50_channel_chunks() {
        assert_eq!(index_to_bank(0), 0, "out of range");
        assert_eq!(index_to_bank(1), 1);
        assert_eq!(index_to_bank(50), 1);
        assert_eq!(index_to_bank(51), 2);
        assert_eq!(index_to_bank(100), 2);
        assert_eq!(index_to_bank(451), 10);
        assert_eq!(index_to_bank(500), 10);
        assert_eq!(index_to_bank(501), 0, "out of range");
    }

    #[test]
    fn cin_populates_bank_from_index() {
        let ch1 = parse_cin_response(1, "CIN,1,Ararat UHF,01451300,AUTO,0,2,0,0").unwrap();
        assert_eq!(ch1.bank, 1);
        let ch100 = parse_cin_response(100, "CIN,100,Test,01451300,AUTO,0,2,0,0").unwrap();
        assert_eq!(ch100.bank, 2);
        let ch451 = parse_cin_response(451, "CIN,451,Test,01451300,AUTO,0,2,0,0").unwrap();
        assert_eq!(ch451.bank, 10);
    }

    #[test]
    fn cin_classifies_tone_kind() {
        use crate::state::ToneSquelchKind;
        // No tone (sample 1 from capture)
        let ch = parse_cin_response(1, "CIN,1,X,01451300,FM,0,2,0,0").unwrap();
        assert_eq!(ch.tone_squelch_kind, ToneSquelchKind::None);
        assert_eq!(ch.tone_squelch, None);

        // CTCSS 100.0 Hz (code 76, per the corrected #130 table)
        let ch = parse_cin_response(2, "CIN,2,X,01451300,FM,76,2,0,0").unwrap();
        assert_eq!(ch.tone_squelch_kind, ToneSquelchKind::Ctcss);
        assert_eq!(ch.tone_squelch, Some(100.0));

        // DCS code 023
        let ch = parse_cin_response(3, "CIN,3,X,01451300,FM,151,2,0,0").unwrap();
        assert_eq!(ch.tone_squelch_kind, ToneSquelchKind::Dcs);
        assert_eq!(ch.tone_dcs_code, Some(151));
        assert_eq!(ch.tone_squelch, None);

        // Search (code 127)
        let ch = parse_cin_response(4, "CIN,4,X,01451300,FM,127,2,0,0").unwrap();
        assert_eq!(ch.tone_squelch_kind, ToneSquelchKind::Search);
    }

    #[test]
    fn cin_preserves_negative_pre_delay() {
        // -5 and -10 are valid wire values (per docs/BC125AT_PROTOCOL.md §5.3)
        // representing pre-delays. The parser used to clamp these to 0,
        // silently discarding what the user had programmed.
        let ch = parse_cin_response(1, "CIN,1,Test,01451300,FM,0,-5,0,0").unwrap();
        assert_eq!(ch.delay, -5);

        let ch = parse_cin_response(2, "CIN,2,Test,01451300,FM,0,-10,0,0").unwrap();
        assert_eq!(ch.delay, -10);

        // Positives still round-trip.
        let ch = parse_cin_response(3, "CIN,3,Test,01451300,FM,0,5,0,0").unwrap();
        assert_eq!(ch.delay, 5);
    }

    #[test]
    fn livestate_from_frames_picks_glg_frequency_and_sts_squelch() {
        let sts = parse_sts_frame(STS_SIGNAL_PRESENT).unwrap();
        let glg = parse_glg_response(GLG_SIGNAL_PRESENT).unwrap();
        let pwr = parse_pwr_response(PWR_SAMPLE).unwrap();
        let live = livestate_from_frames(Some(&sts), Some(&glg), Some(&pwr), ScannerMode::Scan, 7);
        assert_eq!(live.frequency, 462.6125);
        assert_eq!(live.modulation, "NFM");
        assert!(live.squelch_open);
        assert_eq!(live.channel, Some(75));
        assert_eq!(live.alpha_tag.as_deref(), Some("GMRS CH 03"));
        assert_eq!(live.mode, ScannerMode::Scan);
        assert_eq!(live.volume, 7);
        assert!(live.battery.is_none());
        // RSSI from PWR=454/1023 = 44%
        assert_eq!(live.rssi, 44);
    }

    #[test]
    fn livestate_falls_back_to_sts_sig_lvl_when_pwr_absent() {
        let sts = parse_sts_frame(STS_SIGNAL_PRESENT).unwrap();
        let glg = parse_glg_response(GLG_SIGNAL_PRESENT).unwrap();
        let live = livestate_from_frames(Some(&sts), Some(&glg), None, ScannerMode::Scan, 0);
        // sig_lvl=5 → 5*20 = 100
        assert_eq!(live.rssi, 100);
    }

    #[test]
    fn mdl_parser_unchanged() {
        assert_eq!(
            parse_mdl_response("MDL,BC125AT"),
            Some("BC125AT".to_string())
        );
        assert_eq!(
            parse_mdl_response("MDL,BCT125AT"),
            Some("BCT125AT".to_string())
        );
        assert_eq!(parse_mdl_response("ERR"), None);
    }

    // classify_response — per docs/BC125AT_PROTOCOL.md §3 and our response-code rules.

    #[test]
    fn classify_bare_ok_err_ng() {
        assert_eq!(classify_response("OK"), ScannerReply::Ok);
        assert_eq!(classify_response("ERR"), ScannerReply::Err);
        assert_eq!(classify_response("NG"), ScannerReply::Ng);
        assert_eq!(classify_response("-1"), ScannerReply::EndOfList);
    }

    #[test]
    fn classify_command_prefixed_ok_err_ng() {
        assert_eq!(classify_response("PRG,OK"), ScannerReply::Ok);
        assert_eq!(classify_response("VOL,OK"), ScannerReply::Ok);
        assert_eq!(classify_response("CIN,ERR"), ScannerReply::Err);
        assert_eq!(classify_response("CIN,NG"), ScannerReply::Ng);
        assert_eq!(classify_response("GLF,-1"), ScannerReply::EndOfList);
    }

    #[test]
    fn classify_case_insensitive() {
        assert_eq!(classify_response("prg,ok"), ScannerReply::Ok);
        assert_eq!(classify_response("Cin,Err"), ScannerReply::Err);
        assert_eq!(classify_response("scg,ng"), ScannerReply::Ng);
    }

    #[test]
    fn classify_data_response_passes_through() {
        // STS/GLG/CIN data responses must classify as Data, not Ok — they
        // happen to contain commas but the trailing field isn't OK/ERR/NG.
        assert_eq!(
            classify_response(STS_SIGNAL_PRESENT),
            ScannerReply::Data(STS_SIGNAL_PRESENT.to_string())
        );
        assert_eq!(
            classify_response("PWR,454,04626125"),
            ScannerReply::Data("PWR,454,04626125".to_string())
        );
        // MDL response is data, not OK.
        assert_eq!(
            classify_response("MDL,BC125AT"),
            ScannerReply::Data("MDL,BC125AT".to_string())
        );
    }

    #[test]
    fn classify_empty_and_whitespace() {
        assert_eq!(classify_response(""), ScannerReply::Data(String::new()));
        assert_eq!(classify_response("   "), ScannerReply::Data(String::new()));
        assert_eq!(classify_response("\r\n"), ScannerReply::Data(String::new()));
    }

    #[test]
    fn classify_strips_outer_whitespace_but_preserves_data_content() {
        assert_eq!(classify_response("  PRG,OK  "), ScannerReply::Ok);
        let data = "MDL,BC125AT";
        assert_eq!(
            classify_response(&format!("  {}  ", data)),
            ScannerReply::Data(data.to_string())
        );
    }

    // validate_channel_name — per docs/BC125AT_PROTOCOL.md §6.3.

    #[test]
    fn validate_channel_name_accepts_captured_samples() {
        // From docs/wire_captures/2026-05-21/raw.txt — real channels we
        // synced from the user's BC125AT.
        assert!(validate_channel_name("Ararat UHF").is_ok());
        assert!(validate_channel_name("K0ECS - JoCo").is_ok());
        assert!(validate_channel_name("Trimble 640").is_ok());
        assert!(validate_channel_name("AUTO").is_ok());
    }

    #[test]
    fn validate_channel_name_accepts_documented_punctuation() {
        for c in "!@#$%&*()-/<>.? ".chars() {
            let s = format!("A{}B", c);
            assert!(
                validate_channel_name(&s).is_ok(),
                "expected {:?} to be allowed",
                s
            );
        }
    }

    #[test]
    fn validate_channel_name_rejects_empty() {
        assert!(validate_channel_name("").is_err());
    }

    #[test]
    fn validate_channel_name_rejects_too_long() {
        // 16 chars: allowed.
        assert!(validate_channel_name("1234567890123456").is_ok());
        // 17 chars: rejected.
        assert!(validate_channel_name("12345678901234567").is_err());
    }

    #[test]
    fn validate_channel_name_rejects_forbidden_punctuation() {
        // The decompiled reference explicitly excludes these. Sending any
        // of them to the scanner produces ERR.
        for c in "_\\[]{}:;'\"`~|+=,".chars() {
            let s = format!("A{}B", c);
            assert!(
                validate_channel_name(&s).is_err(),
                "expected {:?} to be rejected",
                s
            );
        }
    }

    #[test]
    fn validate_channel_name_rejects_control_chars_and_non_ascii() {
        assert!(validate_channel_name("A\rB").is_err(), "CR");
        assert!(validate_channel_name("A\nB").is_err(), "LF");
        assert!(validate_channel_name("A\tB").is_err(), "tab");
        assert!(validate_channel_name("Ñame").is_err(), "non-ASCII");
        assert!(validate_channel_name("🦀").is_err(), "emoji");
    }
}
