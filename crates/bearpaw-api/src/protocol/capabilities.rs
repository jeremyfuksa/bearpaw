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
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
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
    /// Whether `CIN` carries per-channel modulation. False on the BC75XLT,
    /// where modulation is a global band-plan (`BPL`) property.
    pub has_per_channel_modulation: bool,
    /// Whether `CIN` carries a CTCSS/DCS tone code. False on the BC75XLT,
    /// where the field is reserved.
    pub has_tone_squelch: bool,
    /// Whether the scanner implements `BLT` (backlight). The BC75XLT omits it
    /// from its command table entirely and replies bare `ERR`.
    pub has_backlight: bool,
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
    has_per_channel_modulation: true,
    has_tone_squelch: true,
    has_backlight: true,
    // Per docs/BC125AT_PROTOCOL.md §5.3. Negatives are pre-delays.
    valid_delays: &[-10, -5, 0, 1, 2, 3, 4, 5],
    cleared_delay: 2,
    default_baud: 115_200,
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
    has_per_channel_modulation: false,
    has_tone_squelch: false,
    has_backlight: false,
    // Vendor spec: `[DLY] : Delay Time (0:OFF / 1:ON)`.
    valid_delays: &[0, 1],
    // Observed: `CIN,299 -> CIN,299,,00000000,,,0,1,0`.
    cleared_delay: 0,
    default_baud: 57_600,
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
        if BC125AT_MODELS.iter().any(|m| model.eq_ignore_ascii_case(m)) {
            return Some(BC125AT_FAMILY);
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
        assert!(c.has_per_channel_modulation);
        assert!(c.has_tone_squelch);
        assert!(c.has_backlight);
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
        assert!(!c.has_per_channel_modulation);
        assert!(!c.has_tone_squelch);
        // BLT is absent from the command table; replies bare ERR.
        assert!(!c.has_backlight);
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
