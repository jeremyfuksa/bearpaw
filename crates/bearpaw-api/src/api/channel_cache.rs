//! Persistence for scanner channel memory.
//!
//! The cache is a READ ACCELERATOR, NOT THE SOURCE OF TRUTH. The scanner is
//! the truth. Every user-initiated write goes to hardware first and lands here
//! second; nothing may write here and upload later, because that path diverges
//! silently and is unrecoverable without a full re-read.
//!
//! Saves are whole-map snapshots rather than per-channel write-through. Eleven
//! sites across five files mutate `shadow.channels`, and per-site persistence
//! means one missed site silently diverges the cache -- exactly the failure
//! this module exists to prevent. A snapshot cannot miss one, and the cost of
//! a redundant write is a couple of milliseconds.

use std::collections::HashMap;

use crate::state::{ChannelData, ToneSquelchKind};

use super::open_sqlite;

/// Profile key used until #414 introduces real scanner identity.
///
/// The column exists now so #412 migrates once; #414 adopts these rows onto
/// the first real profile rather than orphaning them.
pub(crate) const PLACEHOLDER_SCANNER_ID: &str = "_default";

fn tone_kind_to_text(kind: &ToneSquelchKind) -> &'static str {
    match kind {
        ToneSquelchKind::None => "none",
        ToneSquelchKind::Ctcss => "ctcss",
        ToneSquelchKind::Dcs => "dcs",
        ToneSquelchKind::Search => "search",
    }
}

fn tone_kind_from_text(text: &str) -> ToneSquelchKind {
    match text {
        "ctcss" => ToneSquelchKind::Ctcss,
        "dcs" => ToneSquelchKind::Dcs,
        "search" => ToneSquelchKind::Search,
        // Anything unrecognised reads as "no tone" rather than failing the
        // whole load: a cache row is recoverable by re-syncing, an empty
        // channel list is not.
        _ => ToneSquelchKind::None,
    }
}

/// Replace this profile's cached channels with `channels`, in one transaction.
///
/// A snapshot, not a merge: rows for `scanner_id` that are absent from the map
/// are removed, so a channel cleared on the scanner does not linger.
///
/// Silent on failure by design, matching `save_preference_to_db`. An
/// unwritable cache costs a re-sync; it must never take down a poll loop.
pub(crate) fn save_channels(
    path: &str,
    scanner_id: &str,
    channels: &HashMap<u16, ChannelData>,
    synced_at: f64,
) {
    let Some(mut conn) = open_sqlite(path) else {
        return;
    };
    let Ok(tx) = conn.transaction() else {
        return;
    };
    if tx
        .execute(
            "DELETE FROM channel_memory WHERE scanner_id = ?1",
            rusqlite::params![scanner_id],
        )
        .is_err()
    {
        return;
    }
    for ch in channels.values() {
        let _ = tx.execute(
            "INSERT OR REPLACE INTO channel_memory (
                 scanner_id, channel_index, frequency, modulation, alpha_tag,
                 delay, lockout, priority, tone_kind, tone_squelch_hz,
                 tone_dcs_code, synced_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            rusqlite::params![
                scanner_id,
                ch.index,
                ch.frequency,
                ch.modulation,
                ch.alpha_tag,
                ch.delay,
                ch.lockout,
                ch.priority,
                tone_kind_to_text(&ch.tone_squelch_kind),
                ch.tone_squelch,
                ch.tone_dcs_code,
                synced_at,
            ],
        );
    }
    let _ = tx.commit();
}

/// Cached channels for this profile, or an empty map if there are none.
///
/// `bank` is left at its default. Bank membership is derived per connected
/// model by `channels_with_banks` and is deliberately not stored -- see the
/// bank-derivation entry in CLAUDE.md's third-rail table.
pub(crate) fn load_channels(path: &str, scanner_id: &str) -> HashMap<u16, ChannelData> {
    let mut out = HashMap::new();
    let Some(conn) = open_sqlite(path) else {
        return out;
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT channel_index, frequency, modulation, alpha_tag, delay,
                lockout, priority, tone_kind, tone_squelch_hz, tone_dcs_code
         FROM channel_memory WHERE scanner_id = ?1",
    ) else {
        return out;
    };
    let rows = stmt.query_map(rusqlite::params![scanner_id], |row| {
        let index: u16 = row.get(0)?;
        let tone_kind: String = row.get(7)?;
        Ok(ChannelData {
            index,
            frequency: row.get(1)?,
            modulation: row.get(2)?,
            alpha_tag: row.get(3)?,
            delay: row.get(4)?,
            lockout: row.get(5)?,
            priority: row.get(6)?,
            tone_squelch_kind: tone_kind_from_text(&tone_kind),
            tone_squelch: row.get(8)?,
            tone_dcs_code: row.get(9)?,
            bank: 0,
        })
    });
    if let Ok(rows) = rows {
        for ch in rows.flatten() {
            out.insert(ch.index, ch);
        }
    }
    out
}

/// When this profile's cache was last written, if it has been.
///
/// Every row in a snapshot carries the same value, so the max is that value.
pub(crate) fn last_synced_at(path: &str, scanner_id: &str) -> Option<f64> {
    let conn = open_sqlite(path)?;
    conn.query_row(
        "SELECT MAX(synced_at) FROM channel_memory WHERE scanner_id = ?1",
        rusqlite::params![scanner_id],
        |row| row.get::<_, Option<f64>>(0),
    )
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::init_preferences_db;

    fn migrated_db(name: &str) -> String {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir()
            .join(format!("bearpaw-test-{name}-{ts}.db"))
            .to_string_lossy()
            .into_owned();
        init_preferences_db(&path).expect("migrate");
        path
    }

    fn sample() -> HashMap<u16, ChannelData> {
        let mut m = HashMap::new();
        m.insert(
            1,
            ChannelData {
                index: 1,
                frequency: 146.52,
                modulation: "FM".to_string(),
                alpha_tag: "CALLING".to_string(),
                // Negative delays are pre-delays and must survive as signed.
                delay: -5,
                lockout: true,
                priority: false,
                tone_squelch: Some(103.5),
                tone_squelch_kind: ToneSquelchKind::Ctcss,
                tone_dcs_code: None,
                bank: 1,
            },
        );
        m.insert(
            2,
            ChannelData {
                index: 2,
                frequency: 462.5625,
                modulation: "NFM".to_string(),
                alpha_tag: String::new(),
                delay: 2,
                lockout: false,
                priority: true,
                tone_squelch: None,
                tone_squelch_kind: ToneSquelchKind::Dcs,
                tone_dcs_code: Some(23),
                bank: 9,
            },
        );
        m
    }

    /// Every field a channel carries survives persist -> load unchanged.
    ///
    /// Tone is asserted field by field because the schema stores the kind, the
    /// Hz and the DCS code in three columns rather than one wire code -- the
    /// whole reason for that departure is that a single code would need a
    /// lossy round-trip here.
    #[test]
    fn channels_round_trip_through_the_cache() {
        let path = migrated_db("cache-round-trip");
        let original = sample();
        save_channels(&path, PLACEHOLDER_SCANNER_ID, &original, 1234.5);

        let loaded = load_channels(&path, PLACEHOLDER_SCANNER_ID);
        assert_eq!(loaded.len(), 2);

        let one = loaded.get(&1).expect("channel 1");
        assert!((one.frequency - 146.52).abs() < 1e-9);
        assert_eq!(one.modulation, "FM");
        assert_eq!(one.alpha_tag, "CALLING");
        assert_eq!(one.delay, -5, "a negative pre-delay must stay signed");
        assert!(one.lockout);
        assert!(!one.priority);
        assert_eq!(one.tone_squelch_kind, ToneSquelchKind::Ctcss);
        assert_eq!(one.tone_squelch, Some(103.5));
        assert_eq!(one.tone_dcs_code, None);

        let two = loaded.get(&2).expect("channel 2");
        assert_eq!(two.tone_squelch_kind, ToneSquelchKind::Dcs);
        assert_eq!(two.tone_dcs_code, Some(23));
        assert_eq!(two.tone_squelch, None);
        assert!(two.priority);
    }

    /// REGRESSION GUARD: bank is NOT persisted, and a load does not invent one.
    ///
    /// Bank width is 50 channels on the BC125AT family and 30 on a BC75XLT, so
    /// a bank stored under one model and read under another misfiles roughly a
    /// third of the channels. `channels_with_banks` derives it from the
    /// CONNECTED scanner's capabilities; this cache must stay out of that.
    #[test]
    fn loading_does_not_restore_a_stored_bank() {
        let path = migrated_db("cache-no-bank");
        save_channels(&path, PLACEHOLDER_SCANNER_ID, &sample(), 1.0);

        let loaded = load_channels(&path, PLACEHOLDER_SCANNER_ID);
        for ch in loaded.values() {
            assert_eq!(
                ch.bank, 0,
                "bank must come from the connected scanner's capabilities, \
                 never from the cache: channel {} loaded bank {}",
                ch.index, ch.bank
            );
        }
    }

    /// A save replaces the profile's rows rather than merging into them, so a
    /// channel that disappears from the map disappears from the cache.
    #[test]
    fn a_save_replaces_rather_than_merges() {
        let path = migrated_db("cache-replace");
        save_channels(&path, PLACEHOLDER_SCANNER_ID, &sample(), 1.0);

        let mut smaller = HashMap::new();
        smaller.insert(1, sample().remove(&1).expect("channel 1"));
        save_channels(&path, PLACEHOLDER_SCANNER_ID, &smaller, 2.0);

        let loaded = load_channels(&path, PLACEHOLDER_SCANNER_ID);
        assert_eq!(loaded.len(), 1, "channel 2 must be gone: {loaded:?}");
        assert!(loaded.contains_key(&1));
    }

    /// Profiles do not bleed into each other, which is what #414 depends on.
    #[test]
    fn profiles_are_isolated_by_scanner_id() {
        let path = migrated_db("cache-isolation");
        save_channels(&path, PLACEHOLDER_SCANNER_ID, &sample(), 1.0);

        assert!(load_channels(&path, "some-other-scanner").is_empty());
        assert_eq!(load_channels(&path, PLACEHOLDER_SCANNER_ID).len(), 2);
    }

    /// `synced_at` comes back for a written profile and is absent for one that
    /// has never been written.
    #[test]
    fn last_synced_at_reports_the_snapshot_time() {
        let path = migrated_db("cache-synced-at");
        assert_eq!(last_synced_at(&path, PLACEHOLDER_SCANNER_ID), None);

        save_channels(&path, PLACEHOLDER_SCANNER_ID, &sample(), 9876.5);
        assert_eq!(last_synced_at(&path, PLACEHOLDER_SCANNER_ID), Some(9876.5));
    }

    /// An unopenable path degrades to empty rather than panicking, matching
    /// every other database path in this crate.
    #[test]
    fn an_unusable_path_loads_empty_instead_of_panicking() {
        let path = "/definitely/not/a/writable/directory/scanner.db";
        save_channels(path, PLACEHOLDER_SCANNER_ID, &sample(), 1.0);
        assert!(load_channels(path, PLACEHOLDER_SCANNER_ID).is_empty());
        assert_eq!(last_synced_at(path, PLACEHOLDER_SCANNER_ID), None);
    }
}
