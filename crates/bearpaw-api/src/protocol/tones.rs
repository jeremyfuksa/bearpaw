//! CTCSS / DCS tone code translation for the Uniden BC125AT family.
//!
//! The scanner's protocol carries tone as an integer code 0–231 in `CIN`
//! (per-channel) and `GLG` (live receive). Different code ranges mean
//! different things:
//!
//! - `0` — no tone configured (open squelch)
//! - `64..=113` — CTCSS (with four gaps at 78, 79, 94, 95; those codes are
//!   not standard CTCSS frequencies and are treated as reserved)
//! - `127` — SEARCH (scanner identifies the tone itself on each hit)
//! - `128..=231` — DCS digital code
//! - `240` — NO_TONE (explicit "tone-squelched, but no tone configured")
//!
//! Canonical table: `docs/SCANNER_PROTOCOL_REFERENCE.md` §7 (sourced from
//! Uniden's BC125AT PC Protocol v1.01 and BCT15X v1.03 specs).

/// Translate a CTCSS code (64–113) to its frequency in Hz.
///
/// Returns `None` for codes outside the CTCSS range, the four reserved
/// gap codes (78, 79, 94, 95), the SEARCH sentinel (127), and DCS codes.
pub fn ctcss_code_to_hz(code: u16) -> Option<f64> {
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
        // 78, 79 — reserved (not standard CTCSS frequencies)
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
        // 94, 95 — reserved
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

/// Translate a DCS code (128–231) to its 3-digit Motorola designation.
///
/// Returns `None` for codes outside the DCS range. The string is formatted
/// as `DCS NNN` (e.g. `"DCS 023"`).
pub fn dcs_code_to_label(code: u16) -> Option<String> {
    let value = dcs_code_to_number(code)?;
    Some(format!("DCS {:03}", value))
}

/// Translate a DCS code (128–231) to its raw Motorola number (e.g. 23, 251).
pub fn dcs_code_to_number(code: u16) -> Option<u16> {
    let value = match code {
        128 => 23,
        129 => 25,
        130 => 26,
        131 => 31,
        132 => 32,
        133 => 36,
        134 => 43,
        135 => 47,
        136 => 51,
        137 => 53,
        138 => 54,
        139 => 65,
        140 => 71,
        141 => 72,
        142 => 73,
        143 => 74,
        144 => 114,
        145 => 115,
        146 => 116,
        147 => 122,
        148 => 125,
        149 => 131,
        150 => 132,
        151 => 134,
        152 => 143,
        153 => 145,
        154 => 152,
        155 => 155,
        156 => 156,
        157 => 162,
        158 => 165,
        159 => 172,
        160 => 174,
        161 => 205,
        162 => 212,
        163 => 223,
        164 => 225,
        165 => 226,
        166 => 243,
        167 => 244,
        168 => 245,
        169 => 246,
        170 => 251,
        171 => 252,
        173 => 261,
        174 => 263,
        175 => 265,
        176 => 266,
        177 => 271,
        178 => 274,
        179 => 306,
        180 => 311,
        181 => 315,
        182 => 325,
        183 => 331,
        184 => 332,
        185 => 343,
        186 => 346,
        187 => 351,
        188 => 356,
        189 => 364,
        190 => 365,
        191 => 371,
        192 => 411,
        193 => 412,
        194 => 413,
        195 => 423,
        196 => 431,
        197 => 432,
        198 => 445,
        199 => 446,
        200 => 452,
        201 => 454,
        202 => 455,
        203 => 462,
        204 => 464,
        205 => 465,
        206 => 466,
        207 => 503,
        208 => 506,
        209 => 516,
        210 => 523,
        211 => 526,
        212 => 532,
        213 => 546,
        214 => 565,
        215 => 606,
        216 => 612,
        217 => 624,
        218 => 627,
        219 => 631,
        220 => 632,
        221 => 654,
        222 => 662,
        223 => 664,
        224 => 703,
        225 => 712,
        226 => 723,
        227 => 731,
        228 => 732,
        229 => 734,
        230 => 743,
        231 => 754,
        _ => return None,
    };
    Some(value)
}

/// Render a wire tone-code string into a human-readable label for the UI.
///
/// Recognises:
/// - Empty, `"0"`, or `"240"` → `"Off"` (no tone / NO_TONE)
/// - `"127"` → `"Srch"` (SEARCH)
/// - `"64".."113"` → CTCSS frequency formatted to one decimal
/// - `"128".."231"` → DCS code formatted as `DCS NNN`
/// - Anything else → `"Off"` (defensive fallback)
pub fn tone_code_label(code: &str) -> String {
    if code.is_empty() || code == "0" || code == "240" {
        return "Off".to_string();
    }
    if code == "127" {
        return "Srch".to_string();
    }
    let Ok(value) = code.parse::<u16>() else {
        return "Off".to_string();
    };
    if (64..=113).contains(&value) {
        return ctcss_code_to_hz(value)
            .map(|v| format!("{:.1}", v))
            .unwrap_or_else(|| "Off".to_string());
    }
    if (128..=231).contains(&value) {
        return dcs_code_to_label(value).unwrap_or_else(|| "Off".to_string());
    }
    "Off".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctcss_canonical_endpoints() {
        assert_eq!(ctcss_code_to_hz(64), Some(67.0));
        assert_eq!(ctcss_code_to_hz(75), Some(100.0));
        assert_eq!(ctcss_code_to_hz(88), Some(146.2));
        assert_eq!(ctcss_code_to_hz(110), Some(254.1));
    }

    #[test]
    fn ctcss_reserved_gaps_return_none() {
        for gap in [78u16, 79, 94, 95] {
            assert_eq!(
                ctcss_code_to_hz(gap),
                None,
                "code {} is reserved (non-standard CTCSS)",
                gap
            );
        }
    }

    #[test]
    fn ctcss_out_of_range_return_none() {
        assert_eq!(ctcss_code_to_hz(0), None);
        assert_eq!(ctcss_code_to_hz(63), None);
        assert_eq!(ctcss_code_to_hz(111), None);
        assert_eq!(ctcss_code_to_hz(127), None);
        assert_eq!(ctcss_code_to_hz(150), None);
    }

    #[test]
    fn dcs_endpoints() {
        assert_eq!(dcs_code_to_number(128), Some(23));
        assert_eq!(dcs_code_to_number(170), Some(251));
        assert_eq!(dcs_code_to_number(231), Some(754));
        assert_eq!(dcs_code_to_label(128).as_deref(), Some("DCS 023"));
        assert_eq!(dcs_code_to_label(231).as_deref(), Some("DCS 754"));
    }

    #[test]
    fn dcs_out_of_range_return_none() {
        assert_eq!(dcs_code_to_number(127), None);
        assert_eq!(dcs_code_to_number(232), None);
    }

    #[test]
    fn tone_code_label_classifies_inputs() {
        assert_eq!(tone_code_label(""), "Off");
        assert_eq!(tone_code_label("0"), "Off");
        assert_eq!(tone_code_label("240"), "Off");
        assert_eq!(tone_code_label("127"), "Srch");
        assert_eq!(tone_code_label("75"), "100.0");
        assert_eq!(tone_code_label("88"), "146.2");
        assert_eq!(tone_code_label("128"), "DCS 023");
        assert_eq!(tone_code_label("bogus"), "Off");
    }
}
