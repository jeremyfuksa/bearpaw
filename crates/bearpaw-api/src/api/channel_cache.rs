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

/// Only reachable through `load_channels`.
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

/// Is `channels` a complete image of a radio with `channel_count` slots?
///
/// ONE definition, deliberately used on BOTH sides -- `flush_channel_cache`
/// before a write and `load_channel_cache` after a read. #567 and #569 are the
/// same question asked in two places, and before this it had two different
/// answers: the write side never asked at all, and the read side asked
/// `max(index) == channel_count`, which is a claim about the highest row rather
/// than about coverage.
///
/// Both conditions are required and neither is redundant:
///
/// - `len` catches a hole ANYWHERE. `max(index)` only ever noticed a hole at
///   the top, which is arbitrary from the user's point of view -- a walk that
///   dropped channel 150 wrote a cache that looked complete.
/// - `max(index)` pins the coverage to 1..=channel_count. `len` alone would
///   accept 500 rows numbered 1..=500 from a different radio's map that
///   happened to survive in the shadow, which is the failure #565 closes at the
///   call site rather than here.
///
/// Together they mean dense: `channel_count` entries, all in `1..=channel_count`.
///
/// This does NOT identify the radio -- that is `scanner_id`'s job (#570), and
/// keeping the two questions apart is what stops one number from quietly
/// answering both, the way the hardcoded `/ 50` did for bank derivation.
fn is_complete_image(channels: &HashMap<u16, ChannelData>, channel_count: u16) -> bool {
    channel_count > 0
        && channels.len() == channel_count as usize
        && channels.keys().max().copied() == Some(channel_count)
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
        // REGRESSION GUARD (#569): a failed row aborts the whole write.
        //
        // This was `let _ = tx.execute(...)` followed by an unconditional
        // commit. The DELETE above has already run, so committing after a
        // failed INSERT persists a cache with a hole -- indistinguishable from
        // a skipped CIN, and rejected on every subsequent launch. Returning
        // without committing drops `tx`, which rolls back to the previous
        // snapshot: an unchanged good cache, not a damaged one.
        if tx
            .execute(
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
            )
            .is_err()
        {
            return;
        }
    }
    let _ = tx.commit();
}

/// Cached channels for this profile, or an empty map if there are none.
///
/// `bank` is left at its default. Bank membership is derived per connected
/// model by `channels_with_banks` and is deliberately not stored -- see the
/// bank-derivation entry in CLAUDE.md's third-rail table.
///
/// The raw primitive. `load_channel_cache` is the guarded entry point that
/// production calls; this one applies no capacity or emptiness rules, exactly
/// as `save_channels` applies none for writes.
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
    // REGRESSION GUARD (`a_partial_shadow_does_not_overwrite_a_complete_cache`,
    // `a_holed_walk_does_not_delete_the_good_cache`): only a COMPLETE image is
    // written.
    //
    // `save_channels` DELETEs before it inserts, so every flush is a replace.
    // "Not empty" was never enough evidence to justify one: several handlers
    // insert a single channel, and the walk skips a channel it could not read.
    // Both produced a map that replaced the user's whole cache.
    //
    // Capacity comes from the connected radio. Before MDL is parsed
    // `capabilities()` answers with the BC125AT default of 500, which is safe
    // HERE only because a shadow that small is refused anyway -- do not copy
    // this call into a path where the default would be adopted as fact (see
    // the channel-memory cache rules in CLAUDE.md).
    let channel_count = state.capabilities().channel_count;
    if !is_complete_image(&channels, channel_count) {
        tracing::debug!(
            len = channels.len(),
            channel_count,
            "skipping channel-cache flush: the shadow is not a complete image \
             of the connected scanner"
        );
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
        &state.scanner_id(),
        &channels,
        synced_at,
    );
}

/// Move pre-#414 cached channels onto a real profile, once.
///
/// Everything cached before scanners had identity sits under
/// `PLACEHOLDER_SCANNER_ID`. Left there it is orphaned: nothing looks that key
/// up any more, so a user who upgrades silently loses their cache and pays a
/// re-sync.
///
/// ONLY adopts when the placeholder rows are a complete image of THIS scanner
/// -- the same `max_index == channel_count` test `load_channel_cache` uses, and
/// for a sharper reason here. Adoption is a one-way move. If a user's
/// placeholder cache came from their BC125AT and they happen to plug in the
/// BC75XLT first, re-keying blindly would hand 500 BC125AT channels to the
/// BC75XLT's profile, where the capacity guard would discard them at load --
/// and the BC125AT would never find them again, because they now live under
/// someone else's key. Checking capacity first means the rows wait for the
/// scanner they actually belong to.
///
/// KNOWN AMBIGUITY, deliberately left open (#571b). Every model in the BC125AT
/// family -- BC125AT, BCT125AT, UBC125XLT, UBC126AT, AE125H -- holds 500
/// channels, so a user who owns two of them gets one radio's pre-identity cache
/// attached to whichever they connect first. Capacity cannot separate them and
/// the `_default` rows carry no model, so telling them apart would need the
/// model recorded at WRITE time -- which is impossible retroactively, and
/// retroactive is the only case that matters: these rows exist for ONE hop,
/// from a pre-#414 install to a post-#414 one. The rows still only move to a
/// radio of the right family and capacity, and the loser re-syncs rather than
/// losing data.
///
/// Capacity is necessary but NOT sufficient, which is why `model` is here too
/// (#571). `for_model_or_default` hands an unrecognised model the BC125AT
/// family's 500 channels, and the connect path deliberately connects to
/// unsupported radios rather than refusing them -- so anything that answers
/// `MDL,<something>` presented as a 500-channel radio and matched a BC125AT's
/// placeholder cache exactly. The capacity test cannot catch that: 500 == 500
/// is precisely what the fallback produced.
///
/// The recognition check derives its own answer from `model` rather than taking
/// a `supported` flag from the caller. A caller can pass the wrong boolean; it
/// cannot lie about the model string it just read off the wire. It also keeps
/// the guard on the DATA, where a future caller cannot skip it -- the lesson
/// from #565, which fixed a related hazard at its call site and left every
/// other route open.
///
/// Returns how many rows moved. Silent on failure, like every other write here.
pub(crate) fn adopt_placeholder_cache(
    path: &str,
    scanner_id: &str,
    model: &str,
    channel_count: u16,
) -> usize {
    if scanner_id == PLACEHOLDER_SCANNER_ID {
        return 0;
    }
    // REGRESSION GUARD (`an_unsupported_model_does_not_adopt_the_placeholder_cache`):
    // a radio whose capabilities came from the fallback has no claim on anyone
    // else's memory. The move is one-way, so a wrong adoption is permanent:
    // the real owner finds an empty profile and re-syncs, while the stranger
    // renders 500 channels it never had and `export_csv` writes them to the
    // user's file.
    if crate::protocol::capabilities::ScannerCapabilities::for_model(model).is_none() {
        tracing::info!(
            model,
            "leaving pre-#414 cached channels in place; this model is not \
             supported, so its capacity came from the default rather than from \
             the radio"
        );
        return 0;
    }
    let Some(conn) = open_sqlite(path) else {
        return 0;
    };

    let max_index: Option<u16> = conn
        .query_row(
            "SELECT MAX(channel_index) FROM channel_memory WHERE scanner_id = ?1",
            rusqlite::params![PLACEHOLDER_SCANNER_ID],
            |row| row.get::<_, Option<u16>>(0),
        )
        .ok()
        .flatten();

    match max_index {
        None => return 0, // nothing left over
        Some(max) if max != channel_count => {
            tracing::info!(
                max,
                channel_count,
                "leaving pre-#414 cached channels in place; they do not match \
                 this scanner's capacity and belong to a different radio"
            );
            return 0;
        }
        Some(_) => {}
    }

    // Never overwrite a profile that already has its own memory.
    let existing: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM channel_memory WHERE scanner_id = ?1",
            rusqlite::params![scanner_id],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if existing > 0 {
        return 0;
    }

    conn.execute(
        "UPDATE channel_memory SET scanner_id = ?1 WHERE scanner_id = ?2",
        rusqlite::params![scanner_id, PLACEHOLDER_SCANNER_ID],
    )
    .map(|n| {
        if n > 0 {
            tracing::info!(
                rows = n,
                "adopted pre-#414 cached channels onto this scanner"
            );
        }
        n
    })
    .unwrap_or(0)
}

/// Populate the shadow from the cache, if the cache belongs to THIS scanner.
///
/// The mirror of `flush_channel_cache`, and shaped the same way on purpose:
/// `load_channels`/`save_channels` are the raw primitives, and the guards live
/// here in the entry point that production actually calls -- so #414's second
/// caller cannot forget them.
///
/// Returns how many channels were adopted; 0 means "nothing usable", which the
/// caller treats exactly like a cold start.
///
/// Two guards, both load-bearing:
///
/// 1. **A populated shadow wins.** Nothing clears `shadow.channels` on
///    disconnect, so a reconnect -- and a flapping USB link reconnects every
///    few seconds -- arrives with a map that is newer than the cache. Loading
///    unconditionally would stomp live edits with rows up to
///    CHANNEL_CACHE_FLUSH_SECS old.
///
/// 2. **The cache must be a complete image of THIS radio.** See
///    `CAPACITY GUARD` below.
pub(crate) fn load_channel_cache(state: &AppState, channel_count: u16) -> usize {
    // Cheap pre-check without holding a lock across SQLite I/O.
    match state.shadow.read() {
        Ok(shadow) if !shadow.channels.is_empty() => return 0,
        Ok(_) => {}
        Err(_) => return 0,
    }

    let scanner_id = state.scanner_id();
    let cached = load_channels(&state.preferences_db_path, &scanner_id);
    if cached.is_empty() {
        return 0;
    }

    // COMPLETENESS GUARD: the same `is_complete_image` the flush applies before
    // writing. One definition, both directions -- #567 and #569 were the same
    // question with two different wrong answers.
    //
    // Still rejects both capacity directions, which is the part that must not
    // regress: a 300-row BC75XLT cache must not load onto a 500-channel
    // BC125AT any more than the reverse. The frontend suppresses its startup
    // sync whenever channels exist, so the wrong radio's memory would render
    // and never refresh.
    //
    // #569 NOTE -- this still discards a cache with a hole, and that is a
    // deliberate limit rather than an oversight. Telling "299 rows from a
    // BC75XLT" apart from "299-of-500 from a BC125AT" needs the writing
    // radio's capacity STORED, which needs a schema migration; #574 says the
    // pre-migration backup is currently incomplete, so that migration should
    // not land first. What #569 actually cost the user is fixed on the write
    // side instead: a holed map never replaces a good cache, so the "it
    // remembered my channels last time but not this time" loop cannot start.
    // A holed cache therefore only exists if an older build wrote it.
    //
    // Nothing here deletes the rejected rows. They are the other radio's
    // memory, and the next completed sync's snapshot replaces them anyway
    // (`save_channels` DELETEs then INSERTs per profile). Under one shared
    // placeholder profile the two scanners take turns; #414 gives them their
    // own keys and the discard stops happening at all.
    if !is_complete_image(&cached, channel_count) {
        tracing::info!(
            len = cached.len(),
            max_index = cached.keys().max().copied().unwrap_or(0),
            channel_count,
            "cached channel memory is not a complete image of this scanner; \
             discarding it and starting cold"
        );
        return 0;
    }

    let synced_at = last_synced_at(&state.preferences_db_path, &scanner_id);

    let Ok(mut shadow) = state.shadow.write() else {
        return 0;
    };
    // Re-check under the write lock: a handler may have inserted a channel
    // while SQLite was being read, and a live read off the wire outranks the
    // cache.
    if !shadow.channels.is_empty() {
        return 0;
    }
    let adopted = cached.len();
    shadow.channels = cached;
    // Carry the real sync time forward so the next flush re-persists it
    // unchanged, and so PR 4 can report how stale this memory actually is.
    if let Some(ts) = synced_at {
        shadow.last_sync = ts;
    }
    adopted
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
        // A COMPLETE image, not `sample()`. Since #567 the flush writes only a
        // map that covers the whole radio, and `sample()`'s two channels never
        // were one -- it stays the right fixture for field fidelity
        // (`channels_round_trip_through_the_cache`) and the wrong one here.
        let count = state.capabilities().channel_count;
        state.shadow.write().unwrap().channels = complete_map(count);

        flush_channel_cache(&state);

        let loaded = load_channels(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID);
        assert_eq!(
            loaded.len(),
            count as usize,
            "flush must persist every channel: {}",
            loaded.len()
        );
        assert!(
            loaded.get(&1).is_some_and(|c| c.alpha_tag == "CH1"),
            "field values must survive the flush"
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
        let count = state.capabilities().channel_count;
        state.shadow.write().unwrap().channels = complete_map(count);
        flush_channel_cache(&state);
        assert_eq!(
            load_channels(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID).len(),
            count as usize
        );

        state.shadow.write().unwrap().channels.clear();
        flush_channel_cache(&state);

        let survived = load_channels(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID);
        assert_eq!(
            survived.len(),
            count as usize,
            "an empty shadow must leave the cache alone, not delete it"
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
        let count = state.capabilities().channel_count;
        {
            let mut shadow = state.shadow.write().unwrap();
            shadow.channels = complete_map(count);
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

    /// With no sync recorded this session, the flush falls back to now rather
    /// than writing `ShadowState`'s 0.0 default into a column the UI reports as
    /// an age.
    ///
    /// The justification here used to be "the only way to hold channels
    /// without a sync is a single-channel read that DID just come off the
    /// wire". #567 made that false: a single-channel shadow is refused by the
    /// flush now, so the reachable case is a complete map whose `last_sync` was
    /// never set. The fallback stays because 0.0 is the one value that would
    /// render as 1970, not because that path is common.
    ///
    /// Paired with the guard above on purpose: asserting only the preserved
    /// timestamp would also pass for a build that stamped a hardcoded 0.0.
    #[test]
    fn a_flush_with_no_recorded_sync_stamps_now() {
        let state = crate::api::default_state();
        let count = state.capabilities().channel_count;
        state.shadow.write().unwrap().channels = complete_map(count);

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

    /// A dense `1..=count` map, as a completed walk leaves it.
    ///
    /// `sample()` is two channels and was never a complete image of any radio.
    /// It is still the right fixture for field fidelity; it is the wrong one
    /// for anything that asks "is this the whole radio?".
    fn complete_map(count: u16) -> HashMap<u16, ChannelData> {
        (1..=count)
            .map(|index| {
                (
                    index,
                    ChannelData {
                        index,
                        frequency: 146.0 + (index as f64) / 1000.0,
                        modulation: "FM".to_string(),
                        alpha_tag: format!("CH{index}"),
                        ..Default::default()
                    },
                )
            })
            .collect()
    }

    fn cached_rows(state: &AppState) -> usize {
        load_channels(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID).len()
    }

    /// REGRESSION GUARD (#567): a partial shadow must NOT overwrite a complete
    /// cache.
    ///
    /// `save_channels` DELETEs the profile's rows before inserting, so the
    /// flush is a replace. The only guard used to be "the map is not empty",
    /// which treats ANY non-empty shadow as an authoritative image of the
    /// radio. It is not: `get_memory_channel`, `clear_channel_lockouts` and the
    /// KEY-toggle path each insert ONE entry, and `mark_port_opened` registers
    /// the command sender before the MDL probe -- so a `GET
    /// /memory/channels/:index` landing in that window puts a single row in an
    /// otherwise empty shadow. From there the 30-second timer needs no further
    /// help: one row replaces the user's whole cache.
    #[test]
    fn a_partial_shadow_does_not_overwrite_a_complete_cache() {
        let state = crate::api::default_state();
        let count = state.capabilities().channel_count;

        state.shadow.write().unwrap().channels = complete_map(count);
        flush_channel_cache(&state);
        assert_eq!(cached_rows(&state), count as usize, "setup: cache is full");

        // What a single handler read off the wire leaves behind.
        let mut one = HashMap::new();
        one.insert(7, complete_map(count).remove(&7).expect("channel 7"));
        state.shadow.write().unwrap().channels = one;

        flush_channel_cache(&state);

        assert_eq!(
            cached_rows(&state),
            count as usize,
            "a one-channel shadow must leave the cache alone, not replace it"
        );
    }

    /// REGRESSION GUARD (#569): a walk that skipped a channel must not destroy
    /// the good cache.
    ///
    /// The walk deliberately tolerates a per-channel failure -- a `Soft`
    /// transport error and an unparseable reply are both skipped -- and a
    /// CP210x bridge is documented to `ERR` a command for reasons unrelated to
    /// the data (pitfall #11). Over 300-500 commands one skip is an expected
    /// event.
    ///
    /// The damage was never the hole itself. It was that the holed map went
    /// through `save_channels`, which DELETED 300 good rows and wrote 299 that
    /// `load_channel_cache` then rejected on every subsequent launch. The user
    /// saw "it remembered my channels last time but not this time", repeating
    /// forever, and the 299 rows sat there being re-rejected.
    ///
    /// Refusing the write keeps the previous good cache, which is strictly
    /// better than both the old behaviour and an empty cache.
    #[test]
    fn a_holed_walk_does_not_delete_the_good_cache() {
        let state = crate::api::default_state();
        let count = state.capabilities().channel_count;

        state.shadow.write().unwrap().channels = complete_map(count);
        flush_channel_cache(&state);
        assert_eq!(cached_rows(&state), count as usize, "setup: cache is full");

        // The top channel's reply was dropped. Every other channel read fine.
        let mut holed = complete_map(count);
        holed.remove(&count);
        state.shadow.write().unwrap().channels = holed;

        flush_channel_cache(&state);

        assert_eq!(
            cached_rows(&state),
            count as usize,
            "a walk missing one channel must not replace a complete cache"
        );
    }

    /// REGRESSION GUARD (#569): a transaction whose inserts failed must not
    /// commit.
    ///
    /// `save_channels` used `let _ = tx.execute(...)` per row and committed
    /// regardless. Because the DELETE runs first, one failed INSERT leaves the
    /// same hole -- and the same permanent discard -- as a skipped CIN, by a
    /// route no guard on the caller can see.
    ///
    /// The trigger is how a per-row failure is forced without a fake database:
    /// SQLite raises on exactly one row, the rest would insert fine, and the
    /// transaction must roll back to the previous snapshot rather than commit
    /// a partial one.
    #[test]
    fn a_save_whose_insert_fails_does_not_commit() {
        let state = crate::api::default_state();
        let count = state.capabilities().channel_count;

        state.shadow.write().unwrap().channels = complete_map(count);
        flush_channel_cache(&state);
        let before = load_channels(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID);
        assert_eq!(before.len(), count as usize, "setup: cache is full");
        let original_tag = before.get(&7).map(|c| c.alpha_tag.clone());

        let conn = open_sqlite(&state.preferences_db_path).expect("open");
        conn.execute_batch(
            "CREATE TRIGGER fail_on_7 BEFORE INSERT ON channel_memory
             WHEN NEW.channel_index = 7
             BEGIN SELECT RAISE(ABORT, 'forced'); END;",
        )
        .expect("create trigger");
        drop(conn);

        let mut next = complete_map(count);
        next.insert(
            1,
            ChannelData {
                index: 1,
                alpha_tag: "REWRITTEN".to_string(),
                ..Default::default()
            },
        );
        save_channels(
            &state.preferences_db_path,
            PLACEHOLDER_SCANNER_ID,
            &next,
            42.0,
        );

        let after = load_channels(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID);
        assert_eq!(
            after.len(),
            count as usize,
            "a failed insert must roll back to the previous snapshot, \
             not commit a holed one"
        );
        assert_eq!(
            after.get(&7).map(|c| c.alpha_tag.clone()),
            original_tag,
            "the rolled-back write must leave the old rows untouched"
        );
    }

    /// Pins the `len` half of `is_complete_image`.
    ///
    /// A hole in the MIDDLE keeps `max(index) == channel_count`, so the old
    /// top-index test accepted it: #569 notes that a hole anywhere but the top
    /// was tolerated silently, which is arbitrary from the user's point of
    /// view -- a walk that dropped channel 250 wrote a cache that looked
    /// complete and was missing a channel forever.
    ///
    /// Paired with `a_map_whose_indices_are_shifted_is_refused` on purpose.
    /// Drop `len` from the predicate and only this test goes red; drop the
    /// `max(index)` clause and only that one does. Either alone leaves half
    /// the condition unexercised.
    #[test]
    fn a_walk_missing_a_middle_channel_does_not_replace_the_cache() {
        let state = crate::api::default_state();
        let count = state.capabilities().channel_count;

        state.shadow.write().unwrap().channels = complete_map(count);
        flush_channel_cache(&state);
        assert_eq!(cached_rows(&state), count as usize, "setup: cache is full");

        let mut holed = complete_map(count);
        holed.remove(&(count / 2));
        assert_eq!(
            holed.keys().max().copied(),
            Some(count),
            "the hole must NOT be at the top -- that is the case max(index) \
             already caught, and this test exists for the case it did not"
        );
        state.shadow.write().unwrap().channels = holed;

        flush_channel_cache(&state);

        assert_eq!(
            cached_rows(&state),
            count as usize,
            "a map with a hole in the middle is not a complete image"
        );
    }

    /// Pins the `max(index)` half of `is_complete_image`.
    ///
    /// The right NUMBER of channels is not the same fact as covering
    /// `1..=channel_count`. A map carrying `count` entries numbered from 2 is
    /// missing channel 1 and carries a phantom one channel past the end --
    /// `index_to_bank` answers 0 above `channel_count`, and the frontend's
    /// `deriveBankFromIndex` clamps, so it would render in a bank the backend
    /// calls 0 and `export_csv` would write it to the user's file.
    #[test]
    fn a_map_whose_indices_are_shifted_is_refused() {
        let state = crate::api::default_state();
        let count = state.capabilities().channel_count;

        state.shadow.write().unwrap().channels = complete_map(count);
        flush_channel_cache(&state);
        assert_eq!(cached_rows(&state), count as usize, "setup: cache is full");

        let shifted: HashMap<u16, ChannelData> = complete_map(count)
            .into_values()
            .map(|mut ch| {
                ch.index += 1;
                (ch.index, ch)
            })
            .collect();
        assert_eq!(
            shifted.len(),
            count as usize,
            "the count must match -- that is what makes this the len check's \
             blind spot"
        );
        state.shadow.write().unwrap().channels = shifted;

        flush_channel_cache(&state);

        // Assert the CONTENT, not the row count. A shifted map writes exactly
        // `count` rows too, so counting them passes whether or not the guard
        // works -- mutation caught this assertion doing nothing.
        let after = load_channels(&state.preferences_db_path, PLACEHOLDER_SCANNER_ID);
        assert!(
            after.contains_key(&1),
            "channel 1 must survive: the shifted map does not contain it, so \
             its absence means the write went through"
        );
        assert!(
            !after.contains_key(&(count + 1)),
            "a phantom channel one past the end must never reach the cache"
        );
    }
}
