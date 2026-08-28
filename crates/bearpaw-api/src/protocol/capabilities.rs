//! Per-model scanner capability descriptors.
//!
//! Bearpaw drives two families of Uniden scanner that speak the **same wire
//! protocol** but have different **memory models**. `PRG`/`EPG` bracketing,
//! `\r` framing, `ERR`/`NG` semantics, and positional `CIN` field order are
//! identical; what differs is how much memory there is and which fields carry
//! meaning.
//!
//! The BC75XLT keeps the BC125AT's `CIN` field *positions* and marks the unused
//! ones `[RSV]` (reserved), so a position-based parser does not shift. See
//! `docs/wire_captures/2026-08-26/bc75xlt-compatibility.md` and the vendor spec
//! at `docs/BC75XLT_PROTOCOL.pdf`.
//!
//! Everything here is a *family memory-model* fact, not a protocol fact. This
//! is the distinction #396 drew when it moved the model allowlist to the
//! connect chokepoint: the hazard was never the protocol.

/// What a given scanner model can do and how its memory is laid out.
///
/// Resolved once from the `MDL` reply at connect and stored on `AppState`, so
/// every consumer reads the same descriptor rather than re-deriving it from a
/// model string. Nothing outside this module may branch on model name.
// Serialize only, not Deserialize: `valid_delays` is a `&'static [i8]`, which
// has no owned deserialization target. That asymmetry is correct rather than a
// limitation worked around -- capabilities are derived from the MDL reply and
// only ever flow outward to the frontend. Accepting them as input would mean a
// client could assert its own memory model, which is exactly the authority the
// backend must keep.
// No `Eq`: `coverage_bands` holds f64 band edges, and f64 is only PartialEq.
// Nothing needs total equality here — the comparisons are all assert_eq! in
// tests and `Option<ScannerCapabilities>` equality at the connect chokepoint.
#[derive(Clone, Copy, Debug, PartialEq, serde::Serialize)]
pub struct ScannerCapabilities {
    /// Highest valid channel index. Channel indices are 1-based, so this is
    /// also the channel count. `CIN,<n>` above this returns `ERR`.
    pub channel_count: u16,
    /// Channels in each bank. Banks are contiguous and equal-sized on both
    /// families: `channel_count == channels_per_bank * bank_count`.
    pub channels_per_bank: u16,
    /// Number of banks. Ten on both families, which is why the `SCG` mask is
    /// ten characters wide on both — described rather than assumed.
    pub bank_count: u8,
    /// Whether `CIN` carries a channel name. False on the BC75XLT, where the
    /// field is present but reserved.
    pub has_alpha_tags: bool,
    /// Which Uniden settings-file layout this model uses.
    ///
    /// `"bc125at"`, `"bc75xlt"`, or `""` for a model Bearpaw cannot exchange
    /// settings files with. A single discriminant rather than one boolean per
    /// format: the two are mutually exclusive, and two booleans would make
    /// "both at once" representable.
    ///
    /// Replaces a substring match on the model name
    /// (`model.contains("BC125AT")`), which worked only by luck: "BC125AT" is
    /// a substring of "BCT125AT".
    pub ss_format: &'static str,
    /// Region stamped into the `.bc125at_ss` file: "USA" or "EUR".
    ///
    /// A real per-model fact -- the UBC-prefixed units are the European
    /// variants -- rather than something to re-derive from the model string
    /// at each call site.
    pub ss_region: &'static str,
    /// Whether the live `GLG` frame reports which channel is being received.
    ///
    /// A separate flag from `has_alpha_tags` even though the two agree on both
    /// families today: one describes stored channel MEMORY (`CIN` field), the
    /// other describes the LIVE frame (`GLG` field 11). Measured on hardware
    /// 2026-08-27 --
    ///
    /// ```text
    /// BC125AT  GLG,04626125,NFM,,0,,,GMRS CH 03,1,0,,75,   <- field 11 = 75
    /// BC75XLT  GLG,145.1300,NFM,,,,,,0,1,,,                <- field 11 empty
    /// ```
    ///
    /// Consumers use it to hide channel-derived readouts rather than print a
    /// value that can never be anything but zero -- the status bar's "unique
    /// channels" counter read `0` forever on a BC75XLT, which looks like the
    /// scanner is finding nothing while it is actively scanning.
    pub reports_live_channel: bool,
    /// Whether `CIN` carries per-channel modulation. False on the BC75XLT,
    /// where modulation is a global band-plan (`BPL`) property.
    pub has_per_channel_modulation: bool,
    /// Whether `CIN` carries a CTCSS/DCS tone code. False on the BC75XLT,
    /// where the field is reserved.
    pub has_tone_squelch: bool,
    /// Whether the scanner exposes a settable backlight *mode* via `BLT`.
    ///
    /// Deliberately not named `has_backlight`: the BC75XLT HAS a backlight. Its
    /// owner's manual documents a button that lights the display for 15 seconds
    /// (BC75XLTom.pdf, "Backlight"). What it lacks is programmatic control --
    /// `BLT` is absent from its command table and replies bare `ERR`, and there
    /// is no persistent mode to set.
    ///
    /// The BC125AT's `BLT` sets a mode (`AO`/`SQ`/`KY`) that persists. These are
    /// different features, not one feature present or absent, so the flag names
    /// what Bearpaw can control rather than what the hardware has.
    pub has_backlight_control: bool,
    /// Whether `BSV` (battery save) works. Absent on the BC75XLT -- `ERR` in
    /// both modes, verified 2026-08-26.
    pub has_battery_save: bool,
    /// Whether `CNT` (LCD contrast) works. Absent on the BC75XLT, which has no
    /// contrast setting in its own menus either.
    pub has_contrast: bool,
    /// Whether `WXS` (weather alert priority) works. Absent on the BC75XLT.
    pub has_weather_alert: bool,
    /// Whether `SSG` (the service-search avoid mask) exists on this model.
    ///
    /// Named for the mask, not the feature: the BC75XLT HAS service search --
    /// its owner's manual documents ten service bands on the `Svc` key -- but
    /// no command to enable or disable one remotely. Its settings command is
    /// `SSP,[SVC_INDEX],[DLY],[DIR]`, which carries a per-service delay and
    /// direction and no enable flag, and `SSG` is absent from the vendor
    /// spec's command table entirely.
    ///
    /// Uniden's own tool agrees: in a real `.bc75xlt_ss` the `Service` row's
    /// on/off slot is empty, while the BC125AT's carries `On|Off` (see
    /// `docs/SS_FILE_FORMAT.md`). The service list also differs -- `WX` leads
    /// it and there is no `Military Air` -- so the BC125AT band names are
    /// wrong here even where the mask would fit.
    pub has_service_search_groups: bool,
    /// Whether the `KBP` key-beep field is settable on this model.
    ///
    /// The BC125AT's `KBP` is `[BEEP],[LOCK]`; the BC75XLT's is `[RSV],[LOCK]`
    /// -- the beep slot is reserved. Confirmed on hardware: that model answers
    /// `KBP,,0` inside program mode (settings probe 2026-08-26), with field 1
    /// empty, and its owner's manual documents no key-beep setting at all.
    ///
    /// Separate from `key_beep_needs_program_mode`, which says WHERE `KBP` may
    /// be sent. Both are true of a BC75XLT at once: the command exists and is
    /// program-mode only, and carries a key lock Bearpaw reads for the settings
    /// file -- only the beep half is missing.
    ///
    /// Writing a number into that reserved slot is the format-error hazard in
    /// CLAUDE.md pitfall #8 applied to `KBP`: per the vendor spec one bad field
    /// aborts the whole set command, discarding the key lock sent with it.
    pub has_key_beep: bool,
    /// Whether `KBP` (key beep) is accepted outside program mode.
    ///
    /// The BC125AT takes it in either mode. The BC75XLT replies `KBP,NG`
    /// outside program mode -- "invalid at this time" per the vendor spec --
    /// and `KBP,,0` inside, so its key-beep reads and writes must be bracketed.
    pub key_beep_needs_program_mode: bool,
    /// Accepted values for the `CIN` delay field, ascending.
    ///
    /// These are genuinely different quantities, not a wider and narrower
    /// range of the same one. On the BC125AT delay is seconds, signed, with
    /// negatives meaning pre-delay. On the BC75XLT it is a boolean flag.
    /// Sending `2` to a BC75XLT is a format error, and per the vendor spec a
    /// format error **aborts the whole set command** — silently discarding the
    /// frequency, lockout, and priority in the same write.
    pub valid_delays: &'static [i8],
    /// Delay reported by a *cleared* channel slot. Not a sentinel: it is what
    /// the hardware actually reports for an empty slot, and the frontend's
    /// `buildEmptyDraft` must match it exactly or cleared channels stay
    /// permanently pending. See the third-rail table in CLAUDE.md.
    pub cleared_delay: i8,
    /// Serial baud rate this model speaks.
    pub default_baud: u32,
    /// Receive coverage, as inclusive `(low_mhz, high_mhz)` bands.
    ///
    /// The two families do NOT cover the same spectrum. The BC125AT family
    /// tunes 25–54, 108–174, 225–380, and 400–512 MHz. The BC75XLT has no
    /// 225–380 band at all and its UHF range starts at 406, not 400 (owner's
    /// manual, "FREQUENCY RANGE", USA and Canada band plans agree on the
    /// edges).
    ///
    /// Validating against the wrong set means the UI accepts a frequency the
    /// scanner cannot tune, and the user gets a bare wire error instead of a
    /// message naming the problem.
    pub coverage_bands: &'static [(f64, f64)],
}

/// BC125AT family: BC125AT, BCT125AT, UBC125XLT, UBC126AT, AE125H.
///
/// 500 channels in 10 banks of 50. Values match the constants they replace, so
/// this family's behavior is unchanged.
pub const BC125AT_FAMILY: ScannerCapabilities = ScannerCapabilities {
    channel_count: 500,
    channels_per_bank: 50,
    bank_count: 10,
    has_alpha_tags: true,
    ss_format: "bc125at",
    ss_region: "USA",
    reports_live_channel: true,
    has_per_channel_modulation: true,
    has_tone_squelch: true,
    has_backlight_control: true,
    has_battery_save: true,
    has_contrast: true,
    has_weather_alert: true,
    has_service_search_groups: true,
    has_key_beep: true,
    key_beep_needs_program_mode: false,
    // Per docs/BC125AT_PROTOCOL.md §5.3. Negatives are pre-delays.
    valid_delays: &[-10, -5, 0, 1, 2, 3, 4, 5],
    cleared_delay: 2,
    default_baud: 115_200,
    // docs/SCANNER_PROTOCOL_REFERENCE.md §6.
    coverage_bands: &[(25.0, 54.0), (108.0, 174.0), (225.0, 380.0), (400.0, 512.0)],
};

/// BC75XLT: 300 channels in 10 banks of 30, no alpha tags, no per-channel
/// modulation or tone, boolean delay, 57600 baud, no `BLT`.
///
/// Verified against hardware (firmware 1.02.04) in
/// `docs/wire_captures/2026-08-26/bc75xlt-compatibility.md`.
pub const BC75XLT: ScannerCapabilities = ScannerCapabilities {
    channel_count: 300,
    channels_per_bank: 30,
    bank_count: 10,
    has_alpha_tags: false,
    // Its own layout, recovered from real files written by Uniden's tool
    // (2026-08-27). Same tab-delimited sections as the BC125AT minus `WxPri`
    // and `AvoidFreqs`, plus `CustomSearch`, with 300 channels not 500.
    ss_format: "bc75xlt",
    ss_region: "USA",
    reports_live_channel: false,
    has_per_channel_modulation: false,
    has_tone_squelch: false,
    has_backlight_control: false,
    has_battery_save: false,
    has_contrast: false,
    has_weather_alert: false,
    has_service_search_groups: false,
    has_key_beep: false,
    key_beep_needs_program_mode: true,
    // Vendor spec: `[DLY] : Delay Time (0:OFF / 1:ON)`.
    valid_delays: &[0, 1],
    // Observed: `CIN,299 -> CIN,299,,00000000,,,0,1,0`.
    cleared_delay: 0,
    default_baud: 57_600,
    // Owner's manual, "FREQUENCY RANGE". No 225-380 band; UHF starts at 406.
    coverage_bands: &[(25.0, 54.0), (108.0, 174.0), (406.0, 512.0)],
};

impl ScannerCapabilities {
    /// Capabilities for a model string from `MDL`, or `None` if unrecognised.
    ///
    /// Case-insensitive: the wire reply is uppercase in every capture, but the
    /// allowlist comparison in `config::is_supported_model` is already
    /// case-insensitive and these two must not disagree about what counts as a
    /// match.
    pub fn for_model(model: &str) -> Option<Self> {
        const BC125AT_MODELS: &[&str] = &["BC125AT", "BCT125AT", "UBC125XLT", "UBC126AT", "AE125H"];
        // The European variants. An explicit allowlist rather than
        // `model.contains("UBC")`: substring tests on model names are how the
        // export gate ended up matching "BC125AT" inside "BCT125AT".
        const EUR_MODELS: &[&str] = &["UBC125XLT", "UBC126AT"];
        if BC125AT_MODELS.iter().any(|m| model.eq_ignore_ascii_case(m)) {
            let mut caps = BC125AT_FAMILY;
            if EUR_MODELS.iter().any(|m| model.eq_ignore_ascii_case(m)) {
                caps.ss_region = "EUR";
            }
            return Some(caps);
        }
        if model.eq_ignore_ascii_case("BC75XLT") {
            return Some(BC75XLT);
        }
        None
    }

    /// Capabilities for a model string, falling back to the BC125AT family for
    /// an unrecognised model.
    ///
    /// The fallback is deliberate and matches the posture #396 set: an
    /// unsupported scanner is allowed to connect with a diagnostic rather than
    /// refused, because an explicit `device.port` is the user overriding
    /// detection on purpose. Falling back to the larger memory model keeps that
    /// escape hatch usable — a scanner with fewer channels returns `ERR` past
    /// its end, which parsers already reject, whereas guessing *too small*
    /// would silently hide channels the user has.
    pub fn for_model_or_default(model: &str) -> Self {
        Self::for_model(model).unwrap_or(BC125AT_FAMILY)
    }

    /// Bank number (1-based) holding `index`, or 0 if out of range.
    ///
    /// Replaces `protocol::index_to_bank`'s hardcoded `/ 50`.
    pub fn index_to_bank(&self, index: u16) -> u8 {
        if index == 0 || index > self.channel_count {
            return 0;
        }
        ((index - 1) / self.channels_per_bank + 1) as u8
    }

    /// Whether this model can tune `mhz`.
    ///
    /// 0.0 is accepted as the "clear this channel" sentinel, matching the
    /// `CIN` write path where frequency 0 empties a slot.
    pub fn covers_frequency(&self, mhz: f64) -> bool {
        if mhz == 0.0 {
            return true;
        }
        self.coverage_bands
            .iter()
            .any(|(lo, hi)| mhz >= *lo && mhz <= *hi)
    }

    /// Coverage bands rendered for a user-facing message:
    /// "25–54, 108–174, 406–512 MHz".
    pub fn coverage_summary(&self) -> String {
        let bands = self
            .coverage_bands
            .iter()
            .map(|(lo, hi)| format!("{}–{}", lo, hi))
            .collect::<Vec<_>>()
            .join(", ");
        format!("{} MHz", bands)
    }

    /// Whether `delay` is a value this model accepts in a `CIN` write.
    pub fn accepts_delay(&self, delay: i8) -> bool {
        self.valid_delays.contains(&delay)
    }

    /// Human-readable capacity, for diagnostics and the Device tab:
    /// "500 channels across 10 banks of 50".
    pub fn capacity_summary(&self) -> String {
        format!(
            "{} channels across {} banks of {}",
            self.channel_count, self.bank_count, self.channels_per_bank
        )
    }
}

impl Default for ScannerCapabilities {
    fn default() -> Self {
        BC125AT_FAMILY
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every model the allowlist accepts must resolve. If a model is added to
    // config::ACCEPTED_MDL_MODELS without a descriptor here, it silently gets
    // BC125AT-family memory constants via the fallback — which is the exact
    // class of bug this descriptor exists to prevent.
    #[test]
    fn every_accepted_model_resolves_to_capabilities() {
        for model in [
            "BC125AT",
            "BCT125AT",
            "UBC125XLT",
            "UBC126AT",
            "AE125H",
            "BC75XLT",
        ] {
            assert!(
                ScannerCapabilities::for_model(model).is_some(),
                "{model} is accepted by the allowlist but has no capability descriptor"
            );
        }
    }

    // REGRESSION GUARD: these are the constants the descriptor replaces. If
    // they drift, every BC125AT user's bank math and memory sync change
    // behavior. `index_to_bank`'s `/ 50` and memory_sync's `CIN,1..500` are
    // the call sites.
    #[test]
    fn bc125at_family_values_match_the_constants_they_replace() {
        let c = BC125AT_FAMILY;
        assert_eq!(c.channel_count, 500);
        assert_eq!(c.channels_per_bank, 50);
        assert_eq!(c.bank_count, 10);
        assert_eq!(c.cleared_delay, 2, "parse_cin_response defaults to 2");
        assert_eq!(c.default_baud, 115_200);
        assert!(c.has_alpha_tags);
        assert!(c.reports_live_channel, "GLG field 11 carries the channel");
        assert!(c.has_per_channel_modulation);
        assert!(c.has_tone_squelch);
        assert!(c.has_backlight_control);
        assert!(c.has_battery_save);
        assert!(c.has_contrast);
        assert!(c.has_weather_alert);
        assert!(c.has_service_search_groups);
        assert!(c.has_key_beep);
        assert!(!c.key_beep_needs_program_mode);
    }

    // Every value here is from the 2026-08-26 hardware capture and the vendor
    // spec. See docs/wire_captures/2026-08-26/bc75xlt-compatibility.md.
    #[test]
    fn bc75xlt_values_match_the_wire_capture() {
        let c = BC75XLT;
        // Vendor spec: `[INDEX] : Channel Index(1-300)`; CIN,301 -> ERR.
        assert_eq!(c.channel_count, 300);
        // Band discontinuity at 30/31 in the factory presets.
        assert_eq!(c.channels_per_bank, 30);
        // SCG mask is 10 chars on both families.
        assert_eq!(c.bank_count, 10);
        // Vendor spec: `[DLY] : Delay Time (0:OFF / 1:ON)`.
        assert_eq!(c.valid_delays, &[0, 1]);
        // Observed: CIN,299 -> CIN,299,,00000000,,,0,1,0
        assert_eq!(c.cleared_delay, 0);
        // Only baud that produced a valid MDL reply.
        assert_eq!(c.default_baud, 57_600);
        // CIN fields 2, 4, 5 are [RSV].
        assert!(!c.has_alpha_tags);
        assert!(
            !c.reports_live_channel,
            "GLG field 11 is empty on this model -- measured on hardware 2026-08-27"
        );
        assert!(!c.has_per_channel_modulation);
        assert!(!c.has_tone_squelch);
        // BLT is absent from the command table; replies bare ERR. The scanner
        // still HAS a backlight -- a 15-second button, per the owner's manual.
        assert!(!c.has_backlight_control);
        // BSV/CNT/WXS all reply ERR in both modes (settings probe 2026-08-26).
        assert!(!c.has_battery_save);
        assert!(!c.has_contrast);
        assert!(!c.has_weather_alert);
        assert!(!c.has_service_search_groups);
        // KBP,NG outside program mode; KBP,,0 inside.
        assert!(!c.has_key_beep);
        assert!(c.key_beep_needs_program_mode);
    }

    #[test]
    fn channel_count_is_consistent_with_bank_layout() {
        for c in [BC125AT_FAMILY, BC75XLT] {
            assert_eq!(
                c.channel_count,
                c.channels_per_bank * c.bank_count as u16,
                "banks must tile the channel space exactly"
            );
        }
    }

    #[test]
    fn model_match_is_case_insensitive() {
        assert_eq!(ScannerCapabilities::for_model("bc75xlt"), Some(BC75XLT));
        assert_eq!(
            ScannerCapabilities::for_model("Bc125At"),
            Some(BC125AT_FAMILY)
        );
    }

    #[test]
    fn unknown_model_falls_back_to_bc125at_family() {
        assert_eq!(ScannerCapabilities::for_model("SDS100"), None);
        assert_eq!(
            ScannerCapabilities::for_model_or_default("SDS100"),
            BC125AT_FAMILY
        );
    }

    // The 30-vs-50 divisor is the whole point. Channel 31 is bank 1 on a
    // BC125AT and bank 2 on a BC75XLT; getting this wrong misfiles every
    // channel above 30 on the smaller scanner.
    #[test]
    fn index_to_bank_follows_the_model() {
        assert_eq!(BC125AT_FAMILY.index_to_bank(31), 1);
        assert_eq!(BC75XLT.index_to_bank(31), 2);

        assert_eq!(BC125AT_FAMILY.index_to_bank(1), 1);
        assert_eq!(BC125AT_FAMILY.index_to_bank(50), 1);
        assert_eq!(BC125AT_FAMILY.index_to_bank(51), 2);
        assert_eq!(BC125AT_FAMILY.index_to_bank(500), 10);

        assert_eq!(BC75XLT.index_to_bank(1), 1);
        assert_eq!(BC75XLT.index_to_bank(30), 1);
        assert_eq!(BC75XLT.index_to_bank(300), 10);
    }

    #[test]
    fn index_to_bank_rejects_out_of_range() {
        assert_eq!(BC125AT_FAMILY.index_to_bank(0), 0);
        assert_eq!(BC125AT_FAMILY.index_to_bank(501), 0);
        assert_eq!(BC75XLT.index_to_bank(0), 0);
        // Valid on a BC125AT, past the end on a BC75XLT.
        assert_eq!(BC75XLT.index_to_bank(301), 0);
    }

    // Matches protocol::index_to_bank exactly across the BC125AT's whole range,
    // so the migration in #401 cannot change behavior for existing users.
    #[test]
    fn index_to_bank_matches_the_free_function_across_the_full_range() {
        for i in 0..=501u16 {
            assert_eq!(
                BC125AT_FAMILY.index_to_bank(i),
                crate::protocol::index_to_bank(i),
                "divergence at index {i}"
            );
        }
    }

    // Sending 2 to a BC75XLT is a format error, and per the vendor spec a
    // format error aborts the entire set command — the frequency, lockout, and
    // priority in the same write are silently discarded. See #402.
    #[test]
    fn delay_validation_follows_the_model() {
        assert!(BC125AT_FAMILY.accepts_delay(2));
        assert!(BC125AT_FAMILY.accepts_delay(-10));
        assert!(!BC125AT_FAMILY.accepts_delay(6));

        assert!(BC75XLT.accepts_delay(0));
        assert!(BC75XLT.accepts_delay(1));
        assert!(!BC75XLT.accepts_delay(2));
        assert!(!BC75XLT.accepts_delay(-5));
    }

    // A cleared slot's delay must be what the hardware reports, not zero and
    // not a shared default. The frontend's buildEmptyDraft is diffed against
    // refetched channel data; a mismatch keeps every cleared channel
    // permanently pending. See the third-rail table in CLAUDE.md.
    #[test]
    fn cleared_delay_is_a_real_observed_value_per_model() {
        assert_eq!(BC125AT_FAMILY.cleared_delay, 2);
        assert_eq!(BC75XLT.cleared_delay, 0);
        for c in [BC125AT_FAMILY, BC75XLT] {
            assert!(
                c.accepts_delay(c.cleared_delay),
                "a cleared slot's delay must itself be writable"
            );
        }
    }

    #[test]
    fn capacity_summary_reads_naturally() {
        assert_eq!(
            BC125AT_FAMILY.capacity_summary(),
            "500 channels across 10 banks of 50"
        );
        assert_eq!(
            BC75XLT.capacity_summary(),
            "300 channels across 10 banks of 30"
        );
    }

    #[test]
    fn default_is_the_bc125at_family() {
        assert_eq!(ScannerCapabilities::default(), BC125AT_FAMILY);
    }
}
