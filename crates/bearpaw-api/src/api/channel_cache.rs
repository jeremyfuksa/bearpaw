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

use super::{epoch_now, open_sqlite, AppState};

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

/// Only reachable through `load_channels`, so it stays dead until PR 3 wires
/// load-on-connect. The allow goes away with that caller, not before.
#[allow(dead_code)]
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
///
/// Exercised by tests but not yet by production code — PR 3 wires load-on-connect.
#[allow(dead_code)]
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

/// Snapshot the live channel map to the cache.
///
/// The single flush entry point, called from three places: a periodic timer, the
/// end of a completed memory sync, and server shutdown. Every caller writes the
/// WHOLE map, which is what makes it impossible to miss one of the eleven sites
/// that mutate `shadow.channels`.
///
/// Cheap when there is nothing to persist: an empty map returns without opening
/// the database, so a not-yet-synced session does not write an empty snapshot
/// over a good one.
///
/// REGRESSION GUARD (`a_flush_records_the_sync_time_not_the_flush_time`): the
/// stamp is `shadow.last_sync` -- when the SCANNER was read -- not the time of
/// the flush. The periodic flush runs on a timer regardless of whether anything
/// was read, so stamping `epoch_now()` unconditionally made `synced_at` mean
/// "cache last written", which is always within one interval of now. #413 wants
/// it to answer "last synced 3 days ago"; that answer has to survive a flush.
pub(crate) fn flush_channel_cache(state: &AppState) {
    let (channels, last_sync) = match state.shadow.read() {
        Ok(shadow) => (shadow.channels.clone(), shadow.last_sync),
        // A poisoned lock means another thread panicked mid-write. Skip the
        // flush rather than persist a half-updated map; the next tick retries.
        Err(_) => return,
    };
    if channels.is_empty() {
        return;
    }
    // 0.0 is `ShadowState`'s default and means "no sync recorded this session".
    // Reaching here with channels but no recorded sync means a handler read
    // them one at a time straight off the wire, so they really are current --
    // stamping now is the honest answer, and it is strictly better than
    // writing the 0.0 sentinel into a column PR 4 will surface.
    let synced_at = if last_sync > 0.0 {
        last_sync
    } else {
        epoch_now()
    };
    save_channels(
        &state.preferences_db_path,
        PLACEHOLDER_SCANNER_ID,
        &channels,
        synced_at,
    );
}

/// When this profile's cache was last written, if it has been.
///
/// Every row in a snapshot carries the same value, so the max is that value.
///
/// Exercised by tests but not yet by production code — PR 4 exposes it via the API.
#[allow(dead_code)]
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

        // The second save is what makes this a guard rather than a decoration.
        //
        // With only the first save above, this test exercises `load_channels`'
        // WHERE clause and NOTHING on the write side. Measured by mutation:
        // dropping the `scanner_id` predicate from `save_channels`' DELETE --
        // so every flush wipes every OTHER profile's channels -- left the whole
        // suite at 280/280 green, this test included. Hardcoding
        // PLACEHOLDER_SCANNER_ID into the INSERT bind, and dropping the WHERE
        // from `last_synced_at`, were equally invisible.
        //
        // Writing a second profile and re-reading the first catches all three:
        // an unscoped DELETE empties `mine`, an unscoped INSERT lands the other
        // profile's row in it, and an unscoped MAX(synced_at) returns 2.0.
        //
        // This matters most in #414/#415, where a second profile stops being
        // hypothetical -- which is exactly when a silent write-side regression
        // would destroy a real scanner's cached memory.
        let mut other = HashMap::new();
        other.insert(
            5,
            ChannelData {
                index: 5,
                frequency: 155.0,
                ..Default::default()
            },
        );
        save_channels(&path, "some-other-scanner", &other, 2.0);

        let mine = load_channels(&path, PLACEHOLDER_SCANNER_ID);
        assert_eq!(
            mine.len(),
            2,
            "another profile's save must not touch this one: {mine:?}"
        );
        assert!(
            mine.contains_key(&1) && mine.contains_key(&2),
            "this profile's own channels must survive: {mine:?}"
        );
        assert!(
            !mine.contains_key(&5),
            "the other profile's channel must not land here: {mine:?}"
        );
        assert_eq!(
            last_synced_at(&path, PLACEHOLDER_SCANNER_ID),
            Some(1.0),
            "synced_at must be per profile, not the newest row in the table"
        );

        let theirs = load_channels(&path, "some-other-scanner");
        assert_eq!(
            theirs.len(),
            1,
            "the other profile keeps its own: {theirs:?}"
        );
        assert_eq!(last_synced_at(&path, "some-other-scanner"), Some(2.0));
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

    /// The flush entry point persists whatever is currently in the shadow map.
    ///
    /// This is what makes the whole-map snapshot design work: no caller has to
    /// know which of the eleven `shadow.channels` mutation sites ran.
    #[test]
    fn flush_writes_the_current_shadow_to_the_cache() {
        let state = crate::api::default_state();
        state.shadow.write().unwrap().channels = sample();

        flush_channel_cache(&state);

        let loaded = load_channels(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID);
        assert_eq!(
            loaded.len(),
            2,
            "flush must persist every channel: {loaded:?}"
        );
        assert!(
            loaded.get(&1).is_some_and(|c| c.alpha_tag == "CALLING"),
            "field values must survive the flush: {loaded:?}"
        );
        assert!(
            last_synced_at(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID).is_some(),
            "a flush must stamp synced_at"
        );
    }

    /// REGRESSION GUARD: an empty shadow map must NOT be flushed.
    ///
    /// `save_channels` deletes the profile's rows before inserting, so flushing
    /// an empty map WIPES the cache. The periodic timer starts before the first
    /// memory sync completes and fires again on every restart, so without this
    /// check the normal startup sequence erases the very cache that exists to
    /// make startup instant. The emptiness guard in `flush_channel_cache` is
    /// load-bearing, not defensive — do not simplify it away.
    #[test]
    fn flushing_an_empty_shadow_does_not_wipe_a_good_cache() {
        let state = crate::api::default_state();
        state.shadow.write().unwrap().channels = sample();
        flush_channel_cache(&state);
        assert_eq!(
            load_channels(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID).len(),
            2
        );

        state.shadow.write().unwrap().channels.clear();
        flush_channel_cache(&state);

        let survived = load_channels(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID);
        assert_eq!(
            survived.len(),
            2,
            "an empty shadow must leave the cache alone, not delete it: {survived:?}"
        );
    }

    /// REGRESSION GUARD: a flush records when the RADIO was read, not when the
    /// flush ran.
    ///
    /// `synced_at` exists to answer "how stale is this?" -- #413 wants "last
    /// synced 3 days ago" on screen. The periodic flush fires every
    /// CHANNEL_CACHE_FLUSH_SECS whether or not anything was read from the
    /// scanner, so stamping the flush time made that answer "moments ago"
    /// forever, for every running session. Worse, it would overwrite the real
    /// timestamp a cache load restores within one flush interval of launch.
    ///
    /// `shadow.last_sync` is the honest value: `memory_sync` sets it after a
    /// completed walk, and PR 3's cache load restores it from the database.
    #[test]
    fn a_flush_records_the_sync_time_not_the_flush_time() {
        let state = crate::api::default_state();
        {
            let mut shadow = state.shadow.write().unwrap();
            shadow.channels = sample();
            // A sync that completed long ago -- 2001-09-09, comfortably
            // distinguishable from any plausible `epoch_now()`.
            shadow.last_sync = 1_000_000_000.0;
        }

        flush_channel_cache(&state);

        assert_eq!(
            last_synced_at(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID),
            Some(1_000_000_000.0),
            "the cache must remember when the scanner was last read, not when \
             the periodic flush last ran"
        );
    }

    /// With no sync recorded this session, the flush falls back to now -- which
    /// is honest, because the only way to hold channels without a sync is a
    /// single-channel read that DID just come off the wire.
    ///
    /// Paired with the guard above on purpose: asserting only the preserved
    /// timestamp would also pass for a build that stamped a hardcoded 0.0.
    #[test]
    fn a_flush_with_no_recorded_sync_stamps_now() {
        let state = crate::api::default_state();
        state.shadow.write().unwrap().channels = sample();

        flush_channel_cache(&state);

        let stamped = last_synced_at(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID)
            .expect("a flush must stamp something");
        assert!(
            stamped > 1_600_000_000.0,
            "with no recorded sync the stamp should be now, not the 0.0 \
             default: got {stamped}"
        );
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
