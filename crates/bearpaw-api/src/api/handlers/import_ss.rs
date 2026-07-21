use std::collections::HashMap;

use crate::state::{ChannelData, ToneSquelchKind};

#[derive(Default)]
pub(crate) struct SsSettings {
    pub backlight: Option<String>,   // BLT: On->AO Off->AF Key->KY Squelch->SQ K+S->KS
    pub beep: Option<String>,        // KBP field 1: Auto->0 Off->99 else digits
    pub key_lock: Option<String>,    // KBP field 2: On->1 Off->0
    pub contrast: Option<String>,    // CNT
    pub volume: Option<String>,      // VOL
    pub squelch: Option<String>,     // SQL
    pub charge_time: Option<String>, // BSV
    pub priority: Option<String>,    // PRI: Off->0 On->1 Plus->2 DND->3
    pub wx_pri: Option<String>,      // WXS: On->1 Off->0
    pub service_flags: Option<String>, // SSG 10-char mask
    pub scan_flags: Option<String>,    // SCG 10-char bank mask
    pub custom_flags: Option<String>,  // CSG 10-char mask
    pub custom_ranges: Vec<(u8, i64, i64)>, // (index, lower_100hz, upper_100hz)
    pub search_delay: Option<String>,  // SCO field 1
    pub search_code: Option<String>,   // SCO field 2 (On->1 Off->0)
    pub cc_mode: Option<String>,       // CloseCall field: Off->0 Pri->1 DND->2
    pub cc_beep: Option<String>,
    pub cc_light: Option<String>,
    pub cc_lockout: Option<String>,
    pub cc_bands: Option<String>, // 5-char mask from CloseCallBands
}

pub(crate) struct SsConfig {
    pub settings: SsSettings,
    pub channels: Vec<ChannelData>,
    pub errors: Vec<String>,
}

fn on_to_mask_bit(v: &str) -> char {
    // On -> enabled -> '0'; Off/anything -> disabled -> '1'
    if v.eq_ignore_ascii_case("On") { '0' } else { '1' }
}

fn on_off_to_flag(v: &str) -> &'static str {
    if v.eq_ignore_ascii_case("On") { "1" } else { "0" }
}

pub(crate) fn parse_ss_config(text: &str) -> SsConfig {
    let mut s = SsSettings::default();
    let mut channels = Vec::new();
    let mut errors = Vec::new();
    // masks built from indexed lines default to enabled ('0'); we fill by index
    let mut scan = ['0'; 10];
    let mut service = ['0'; 10];
    let mut custom_enabled = ['0'; 10];

    for line in text.lines() {
        let f: Vec<&str> = line.split('\t').collect();
        match f.first().copied() {
            Some("Misc") if f.len() >= 8 => {
                s.backlight = Some(match f[1] {
                    "On" => "AO", "Off" => "AF", "Key" => "KY",
                    "Squelch" => "SQ", "K+S" => "KS", _ => "AF",
                }.to_string());
                s.beep = Some(match f[2] {
                    "Auto" => "0".to_string(),
                    "Off" => "99".to_string(),
                    other => other.to_string(),
                });
                s.key_lock = Some(on_off_to_flag(f[3]).to_string());
                s.contrast = Some(f[4].to_string());
                s.volume = Some(f[5].to_string());
                s.squelch = Some(f[6].to_string());
                s.charge_time = Some(f[7].to_string());
            }
            Some("Priority") if f.len() >= 2 => {
                s.priority = Some(match f[1] {
                    "On" => "1", "Plus" => "2", "DND" => "3", _ => "0",
                }.to_string());
            }
            Some("WxPri") if f.len() >= 2 => {
                s.wx_pri = Some(on_off_to_flag(f[1]).to_string());
            }
            Some("Service") if f.len() >= 4 => {
                if let Ok(idx) = f[1].parse::<usize>() {
                    if (1..=10).contains(&idx) { service[idx - 1] = on_to_mask_bit(f[3]); }
                }
            }
            Some("Conventional") if f.len() >= 4 => {
                if let Ok(idx) = f[1].parse::<usize>() {
                    if (1..=10).contains(&idx) { scan[idx - 1] = on_to_mask_bit(f[3]); }
                }
            }
            Some("Custom") if f.len() >= 6 => {
                if let (Ok(idx), Ok(lo), Ok(hi)) =
                    (f[1].parse::<u8>(), f[3].parse::<i64>(), f[4].parse::<i64>())
                {
                    // export writes Hz; CSP wants units of 100 Hz
                    s.custom_ranges.push((idx, lo / 100, hi / 100));
                    if (1..=10).contains(&(idx as usize)) {
                        custom_enabled[(idx - 1) as usize] = on_to_mask_bit(f[5]);
                    }
                }
            }
            Some("GeneralSearch") if f.len() >= 3 => {
                s.search_delay = Some(f[1].to_string());
                s.search_code = Some(on_off_to_flag(f[2]).to_string());
            }
            Some("CloseCall") if f.len() >= 5 => {
                s.cc_mode = Some(match f[1] {
                    "Pri" => "1", "DND" => "2", _ => "0",
                }.to_string());
                s.cc_beep = Some(on_off_to_flag(f[2]).to_string());
                s.cc_light = Some(on_off_to_flag(f[3]).to_string());
                s.cc_lockout = Some(on_off_to_flag(f[4]).to_string());
            }
            Some("CloseCallBands") if f.len() >= 6 => {
                let bands: String = (1..=5)
                    .map(|i| if f[i].eq_ignore_ascii_case("On") { '1' } else { '0' })
                    .collect();
                s.cc_bands = Some(bands);
            }
            Some("C-Freq") if f.len() >= 9 => {
                match parse_ss_channel(&f) {
                    Ok(Some(ch)) => channels.push(ch),
                    Ok(None) => {}
                    Err(e) => errors.push(e),
                }
            }
            _ => {} // unknown line type: ignore (forward-compatible)
        }
    }

    s.scan_flags = Some(scan.iter().collect());
    s.service_flags = Some(service.iter().collect());
    s.custom_flags = Some(custom_enabled.iter().collect());
    SsConfig { settings: s, channels, errors }
}

fn parse_ss_channel(f: &[&str]) -> Result<Option<ChannelData>, String> {
    let on = |v: &str| v.eq_ignore_ascii_case("On");
    let index: u16 = f[1].parse().map_err(|_| "bad C-Freq index".to_string())?;
    if !(1..=500).contains(&index) {
        return Err(format!("C-Freq index out of range: {}", index));
    }
    let freq_hz: i64 = f[3].parse().map_err(|_| "bad C-Freq frequency".to_string())?;
    if freq_hz == 0 {
        return Ok(None); // empty slot
    }
    let frequency = freq_hz as f64 / 1_000_000.0;
    let delay: i8 = f[7].parse().map_err(|_| "bad C-Freq delay".to_string())?;
    Ok(Some(ChannelData {
        index,
        frequency,
        modulation: f[4].to_uppercase(),
        alpha_tag: f[2].to_string(),
        delay,
        lockout: on(f[6]),
        priority: on(f[8]),
        // Tone parsing from the display label is deferred: import writes tone
        // as "0" (off) in the CIN payload for now. Tone round-trip is tracked
        // separately — the export label ("100.0"/"DCS 023"/"Srch") would need
        // reverse decoding to a code. Channels still import with correct
        // freq/name/mod/delay/lockout/priority.
        tone_squelch: None,
        tone_squelch_kind: ToneSquelchKind::None,
        tone_dcs_code: None,
        bank: 1,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "Misc\tK+S\tAuto\tOff\t8\t10\t3\t16\tUSA\nPriority\tOn\nWxPri\tOff\nService\t1\tPolice\tOff\nService\t3\tHAM Radio\tOn\nConventional\t1\tBank 1\tOn\nConventional\t4\tBank 4\tOff\nCloseCall\tOff\tOff\tOff\tOff\nCloseCallBands\tOff\tOn\tOff\tOff\tOn\nGeneralSearch\t2\tOff\nCustom\t1\tSearch Bnak1\t25000000\t27995000\tOn\n";

    #[test]
    fn parses_misc_to_wire_settings() {
        let cfg = parse_ss_config(SAMPLE);
        // Misc: backlight K+S->KS, beep Auto->99, keylock Off->0,
        // contrast 8, volume 10, squelch 3, charge 16
        assert_eq!(cfg.settings.backlight.as_deref(), Some("KS"));
        assert_eq!(cfg.settings.volume.as_deref(), Some("10"));
        assert_eq!(cfg.settings.squelch.as_deref(), Some("3"));
        assert_eq!(cfg.settings.contrast.as_deref(), Some("8"));
        assert_eq!(cfg.settings.charge_time.as_deref(), Some("16"));
    }

    #[test]
    fn parses_priority_and_wxpri() {
        let cfg = parse_ss_config(SAMPLE);
        assert_eq!(cfg.settings.priority.as_deref(), Some("1")); // On->1
        assert_eq!(cfg.settings.wx_pri.as_deref(), Some("0")); // Off->0
    }

    #[test]
    fn parses_bank_mask_with_correct_polarity() {
        let cfg = parse_ss_config(SAMPLE);
        // Conventional 1 On -> '0', Conventional 4 Off -> '1', rest default On->'0'
        // mask is 10 chars, positions 1..10
        let mask = cfg.settings.scan_flags.as_deref().unwrap();
        assert_eq!(mask.len(), 10);
        assert_eq!(&mask[0..1], "0"); // bank 1 enabled
        assert_eq!(&mask[3..4], "1"); // bank 4 disabled
    }

    #[test]
    fn parses_service_mask() {
        let cfg = parse_ss_config(SAMPLE);
        // Service 1 Off -> '1', Service 3 On -> '0'
        let mask = cfg.settings.service_flags.as_deref().unwrap();
        assert_eq!(&mask[0..1], "1");
        assert_eq!(&mask[2..3], "0");
    }

    #[test]
    fn parses_beep_auto_to_wire_zero() {
        // SAMPLE's Misc line has beep field "Auto"
        let cfg = parse_ss_config(SAMPLE);
        assert_eq!(cfg.settings.beep.as_deref(), Some("0"));
    }

    #[test]
    fn parses_beep_off_to_wire_99() {
        let text = "Misc\tK+S\tOff\tOff\t8\t10\t3\t16\tUSA\n";
        let cfg = parse_ss_config(text);
        assert_eq!(cfg.settings.beep.as_deref(), Some("99"));
    }

    #[test]
    fn parses_closecall_pri_to_wire_one() {
        let text = "CloseCall\tPri\tOn\tOff\tOff\n";
        let cfg = parse_ss_config(text);
        assert_eq!(cfg.settings.cc_mode.as_deref(), Some("1"));
    }

    #[test]
    fn parses_cfreq_channel() {
        let line = "C-Freq\t1\tArarat UHF\t145130000\tAUTO\tOff\tOff\t2\tOff";
        let f: Vec<&str> = line.split('\t').collect();
        let ch = parse_ss_channel(&f).unwrap().expect("some");
        assert_eq!(ch.index, 1);
        assert!((ch.frequency - 145.13).abs() < 0.00005);
        assert_eq!(ch.alpha_tag, "Ararat UHF");
        assert_eq!(ch.delay, 2);
        assert!(!ch.lockout);
    }

    #[test]
    fn cfreq_zero_freq_is_empty_slot() {
        let line = "C-Freq\t6\tAUTO\t0\tAUTO\tOff\tOff\t2\tOff";
        let f: Vec<&str> = line.split('\t').collect();
        assert!(parse_ss_channel(&f).unwrap().is_none());
    }

    #[test]
    fn cfreq_lockout_priority_on() {
        let line = "C-Freq\t3\tRepeater\t146940000\tFM\tOff\tOn\t2\tOn";
        let f: Vec<&str> = line.split('\t').collect();
        let ch = parse_ss_channel(&f).unwrap().expect("some");
        assert!(ch.lockout);
        assert!(ch.priority);
    }
}
