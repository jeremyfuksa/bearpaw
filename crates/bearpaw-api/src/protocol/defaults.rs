//! Factory-default custom-search ranges for the BC125AT family.
//!
//! When the scanner is factory-reset via `CLR`, these are the 10 ranges it
//! preloads into the `CSP,1..10` slots. We surface them read-only via
//! `GET /api/v1/custom-search/defaults` so a future UI can offer a
//! "reset range N to factory default" affordance without round-tripping
//! the scanner.
//!
//! Source: `docs/BC125AT_PROTOCOL.md` §5.5 (decompiled from
//! `BC125AT_SS/DbCustomSearch.cs:14-26`).
//!
//! **No `CSP` write path uses these.** This file is just the read-only
//! seed list. Actually writing a default back to the scanner would go
//! through the existing `set_custom_range` handler.
//!
//! Frequencies are in MHz; the third field is a short label.

/// 10 custom-search ranges as `(lower MHz, upper MHz, label)`.
pub const CUSTOM_SEARCH_DEFAULTS: [(f64, f64, &str); 10] = [
    (25.0000, 27.9950, "CB / 11m"),
    (28.0000, 29.6950, "10m amateur"),
    (29.7000, 49.9950, "VHF Low"),
    (50.0000, 54.0000, "6m amateur"),
    (108.0000, 136.9916, "AIR band"),
    (137.0000, 143.9950, "Mil/sat"),
    (144.0000, 147.9950, "2m amateur"),
    (225.0000, 380.0000, "Mil air"),
    (400.0000, 449.9937, "70cm amateur"),
    (450.0000, 469.9937, "UHF business / GMRS"),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_ten_ranges() {
        assert_eq!(CUSTOM_SEARCH_DEFAULTS.len(), 10);
    }

    #[test]
    fn ranges_are_well_formed() {
        for (i, (lower, upper, label)) in CUSTOM_SEARCH_DEFAULTS.iter().enumerate() {
            assert!(
                lower < upper,
                "range {} ({}): lower {} not below upper {}",
                i + 1,
                label,
                lower,
                upper
            );
            assert!(*lower >= 25.0, "range {} lower below scanner minimum", i + 1);
            assert!(
                *upper <= 512.0,
                "range {} upper above scanner maximum",
                i + 1
            );
            assert!(!label.is_empty(), "range {} has empty label", i + 1);
        }
    }
}
