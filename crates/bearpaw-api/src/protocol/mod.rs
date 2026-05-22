//! Uniden BC125AT/BCT125AT wire protocol parsers.
//!
//! Wire-format references: docs/SCANNER_PROTOCOL_REFERENCE.md and the captured
//! fixtures in docs/wire_captures/. All parsers are total (never panic) and
//! defensive against firmware-version variance — see fixture 2026-05-21 from
//! firmware 1.06.06, which emits a different STS field count than the
//! research doc's 1.04.02.

use crate::state::{ChannelData, LiveState, ToneSquelchKind};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ProtocolError {
    #[error("parse error: {0}")]
    Parse(String),
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
/// Heuristic: scan from the end backward looking for a position `i` such that
/// `parts[i]` and `parts[i+1]` are both single 0/1 digits (SQL,MUT). Require
/// at least 9 fields from `i` to the end (the documented tail length).
fn find_sts_tail_start(parts: &[&str]) -> Option<usize> {
    if parts.len() < 10 {
        return None;
    }
    let max_start = parts.len().saturating_sub(9);
    for i in (1..=max_start).rev() {
        let a = parts[i].trim();
        let b = parts.get(i + 1).map(|s| s.trim()).unwrap_or("");
        if matches!(a, "0" | "1") && matches!(b, "0" | "1") {
            return Some(i);
        }
    }
    None
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
/// a skeleton with all data fields empty. Trailing channel number is present
/// on firmware 1.06.06 but firmware-dependent in general.
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
/// elsewhere (see protocol::tones — TODO).
pub fn parse_cin_response(index: u16, response: &str) -> Option<ChannelData> {
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
    // Index field — skip if present and matches.
    if let Some(first) = p.first() {
        if first.parse::<u16>().ok() == Some(index) {
            p = &p[1..];
        }
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
    let delay = p.get(4).and_then(|s| s.parse::<i8>().ok()).unwrap_or(2);
    let lockout = p.get(5).map(|s| *s == "1").unwrap_or(false);
    let priority = p.get(6).map(|s| *s == "1").unwrap_or(false);

    let (tone_squelch_kind, tone_squelch, tone_dcs_code) = decode_tone(tone_code);

    // delay is stored as u8 in ChannelData; clamp negatives to 0 for now.
    // (Negative pre-delays are valid wire values; surfacing them needs an
    // i8 schema change which we defer.)
    let delay_u8 = delay.max(0) as u8;

    Some(ChannelData {
        index,
        frequency,
        modulation,
        alpha_tag,
        delay: delay_u8,
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
        _ => match tone_code_to_hz(code) {
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

/// CTCSS code → frequency in Hz. Returns None for code 0 (no tone),
/// 127 (SEARCH), 240 (NO_TONE), DCS codes (128–231), and unknown codes.
fn tone_code_to_hz(code: u16) -> Option<f64> {
    // Standard Uniden CTCSS code map (64–113). 78, 79, 94, 95 are not
    // standard CTCSS frequencies and remain unmapped.
    let hz = match code {
        64 => 67.0,
        65 => 71.9,
        66 => 74.4,
        67 => 77.0,
        68 => 79.7,
        69 => 82.5,
        70 => 85.4,
        71 => 88.5,
        72 => 91.5,
        73 => 94.8,
        74 => 97.4,
        75 => 100.0,
        76 => 103.5,
        77 => 107.2,
        80 => 110.9,
        81 => 114.8,
        82 => 118.8,
        83 => 123.0,
        84 => 127.3,
        85 => 131.8,
        86 => 136.5,
        87 => 141.3,
        88 => 146.2,
        89 => 151.4,
        90 => 156.7,
        91 => 159.8,
        92 => 162.2,
        93 => 165.5,
        96 => 167.9,
        97 => 173.8,
        98 => 179.9,
        99 => 186.2,
        100 => 192.8,
        101 => 203.5,
        102 => 206.5,
        103 => 210.7,
        104 => 218.1,
        105 => 225.7,
        106 => 229.1,
        107 => 233.6,
        108 => 241.8,
        109 => 250.3,
        110 => 254.1,
        _ => return None,
    };
    Some(hz)
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
    commanded_mode: &str,
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
        mode: commanded_mode.to_string(),
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

    #[test]
    fn tone_code_decoding() {
        assert_eq!(tone_code_to_hz(0), None, "0 = no tone");
        assert_eq!(tone_code_to_hz(75), Some(100.0));
        assert_eq!(tone_code_to_hz(88), Some(146.2));
        assert_eq!(tone_code_to_hz(127), None, "127 = SEARCH (not a Hz value)");
        assert_eq!(tone_code_to_hz(150), None, "DCS codes not mapped to Hz");
    }

    #[test]
    fn decode_tone_classifies_kind() {
        use crate::state::ToneSquelchKind;
        assert_eq!(decode_tone(0), (ToneSquelchKind::None, None, None));
        assert_eq!(decode_tone(240), (ToneSquelchKind::None, None, None));
        assert_eq!(decode_tone(127), (ToneSquelchKind::Search, None, None));
        assert_eq!(decode_tone(75), (ToneSquelchKind::Ctcss, Some(100.0), None));
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

        // CTCSS 100.0 Hz (code 75)
        let ch = parse_cin_response(2, "CIN,2,X,01451300,FM,75,2,0,0").unwrap();
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
    fn livestate_from_frames_picks_glg_frequency_and_sts_squelch() {
        let sts = parse_sts_frame(STS_SIGNAL_PRESENT).unwrap();
        let glg = parse_glg_response(GLG_SIGNAL_PRESENT).unwrap();
        let pwr = parse_pwr_response(PWR_SAMPLE).unwrap();
        let live = livestate_from_frames(Some(&sts), Some(&glg), Some(&pwr), "SCAN", 7);
        assert_eq!(live.frequency, 462.6125);
        assert_eq!(live.modulation, "NFM");
        assert!(live.squelch_open);
        assert_eq!(live.channel, Some(75));
        assert_eq!(live.alpha_tag.as_deref(), Some("GMRS CH 03"));
        assert_eq!(live.mode, "SCAN");
        assert_eq!(live.volume, 7);
        assert!(live.battery.is_none());
        // RSSI from PWR=454/1023 = 44%
        assert_eq!(live.rssi, 44);
    }

    #[test]
    fn livestate_falls_back_to_sts_sig_lvl_when_pwr_absent() {
        let sts = parse_sts_frame(STS_SIGNAL_PRESENT).unwrap();
        let glg = parse_glg_response(GLG_SIGNAL_PRESENT).unwrap();
        let live = livestate_from_frames(Some(&sts), Some(&glg), None, "SCAN", 0);
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
}
