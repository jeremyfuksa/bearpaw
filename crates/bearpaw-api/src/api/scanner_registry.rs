//! Which physical scanner is this, and what is its profile?
//!
//! Bearpaw treats a connection as a scanner. To hold more than one profile it
//! has to recognise the unit on the other end of the cable, and it can only
//! recognise it from what the hardware volunteers.
//!
//! Three names, and they are NOT interchangeable:
//!
//! - **`match_index`** — what does the recognising, derived from the wire every
//!   time. `MODEL:serial` where the serial identifies a unit (`BC75XLT:020D43D8`),
//!   and `MODEL` alone where it does not (`BC125AT`) — see
//!   `has_unique_usb_serial` and #570.
//! - **`scanner_id`** — a generated key. It recognises nothing. It exists so
//!   that renaming a scanner, or adding a better discriminator later, does not
//!   have to rewrite every foreign key that points at a profile.
//! - **`display_name`** — an optional label the user chooses. Cosmetic.
//!
//! ACCEPTED LIMITATION, and the reason `match_index` is only as good as it is:
//! a BC125AT reports usb_serial `0001` for every unit — a firmware constant,
//! not a per-unit id (measured on both units, 2026-08-26). Only the BC75XLT has
//! a real serial, and only because its CP2104 bridge is programmed per-unit by
//! Silicon Labs. So **two units of the same model share one profile.** That is
//! correct and permanent for a BC125AT plus a BC75XLT. It is also detectable if
//! a second same-model unit ever appears, and fixable then without a schema
//! rewrite, because the stored key is a UUID rather than the match index.

use super::{epoch_now, open_sqlite};

/// How a connected scanner is matched to a stored profile.
///
/// `MODEL:serial`, with a literal `unknown` where the transport could not read
/// one -- explicit rather than omitted, so a missing serial is a stable,
/// distinguishable state rather than two states collapsed into one string.
///
/// Two things this gets right that are easy to get wrong (#570):
///
/// 1. **The model is case-folded.** `is_supported_model` and
///    `ScannerCapabilities::for_model` both compare with
///    `eq_ignore_ascii_case`, and `model_match_is_case_insensitive_at_connect`
///    pins that `MDL,bc125at` is a reply Bearpaw must accept. This was the one
///    place consuming that string as an IDENTITY without folding it, and
///    `scanners.match_index` is UNIQUE -- so `bc125at:0001` and `BC125AT:0001`
///    would coexist forever as two profiles for one radio.
///
/// 2. **The serial is used only where it identifies a UNIT.** A BC125AT reports
///    `0001` for every unit, so including it bought no precision and cost a
///    profile split every time the descriptor read failed -- the same radio
///    keyed as `BC125AT:0001` one launch and `BC125AT:unknown` the next, each
///    with its own channel cache. `has_unique_usb_serial` carries that fact per
///    model, so adding a model means stating it rather than rediscovering this.
///
/// An UNRECOGNISED model keeps its serial. The flag is a positive claim about a
/// specific radio, and the two errors are not symmetric: dropping a real serial
/// merges two different radios into one profile and cross-contaminates their
/// channel memory, while keeping a constant one only risks a split that a
/// re-sync repairs.
pub(crate) fn match_index(model: &str, usb_serial: Option<&str>) -> String {
    let model_key = model.to_ascii_uppercase();
    let serial_identifies_the_unit =
        crate::protocol::capabilities::ScannerCapabilities::for_model(model)
            .map(|caps| caps.has_unique_usb_serial)
            .unwrap_or(true);
    if !serial_identifies_the_unit {
        return model_key;
    }
    format!("{}:{}", model_key, usb_serial.unwrap_or("unknown"))
}

/// A new `scanner_id`.
///
/// Nanosecond timestamp plus a process counter. Not a real UUID — the crate has
/// no such dependency and does not need one: a row is created once per physical
/// scanner a user ever plugs in, so the collision budget is enormous. The
/// counter covers the case of two profiles created inside the same nanosecond
/// tick, which a bare timestamp would not.
fn new_scanner_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:032x}{n:04x}")
}

/// The profile for this scanner, creating one if it has not been seen before.
///
/// Always stamps `last_seen`. Returns `None` only when the database cannot be
/// opened or written — the caller then behaves as it did before profiles
/// existed, which is the same posture every other path in this crate takes
/// toward an unusable database: degrade, never take down the poll loop.
///
/// Called on every connect from `update_device_info_from_mdl` (`poll.rs`),
/// after the `MDL` reply and before anything touches this scanner's cached
/// memory.
///
/// This used to say "exercised by tests but not yet by production code" and
/// carried an `#[allow(dead_code)]` to match. #562 wired it into the connect
/// path and the comment was not updated, so the attribute went on suppressing
/// a real dead-code signal for everything else in this module -- the one check
/// that would have flagged the staleness was the thing turned off (#576).
pub(crate) fn resolve_scanner(path: &str, model: &str, usb_serial: Option<&str>) -> Option<String> {
    let index = match_index(model, usb_serial);
    let conn = open_sqlite(path)?;
    let now = epoch_now();

    // Seen before: reuse the id and record the visit.
    let existing: Option<String> = conn
        .query_row(
            "SELECT scanner_id FROM scanners WHERE match_index = ?1",
            rusqlite::params![index],
            |row| row.get(0),
        )
        .ok();

    if let Some(id) = existing {
        let _ = conn.execute(
            "UPDATE scanners SET last_seen = ?1, model = ?2, usb_serial = ?3 WHERE scanner_id = ?4",
            rusqlite::params![now, model, usb_serial, id],
        );
        return Some(id);
    }

    // First time: create the profile.
    let id = new_scanner_id();
    conn.execute(
        "INSERT INTO scanners
             (scanner_id, match_index, model, usb_serial, display_name, first_seen, last_seen)
         VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)",
        rusqlite::params![id, index, model, usb_serial, now],
    )
    .ok()?;
    Some(id)
}

/// The label a user gave this profile, if any. `None` also when the database
/// cannot be read: the UI then falls back to the model, which is what an
/// unnamed profile shows anyway.
pub(crate) fn display_name(path: &str, scanner_id: &str) -> Option<String> {
    open_sqlite(path)?
        .query_row(
            "SELECT display_name FROM scanners WHERE scanner_id = ?1",
            rusqlite::params![scanner_id],
            |row| row.get(0),
        )
        .ok()
        .flatten()
}

/// One stored profile, with what Bearpaw holds for it (#417).
pub(crate) struct ProfileRow {
    pub scanner_id: String,
    pub model: String,
    pub display_name: Option<String>,
    pub last_seen: f64,
    /// When the radio's memory was last read, from the channel cache.
    pub synced_at: Option<f64>,
    /// Programmed channels in the cache -- slots with a frequency, not the
    /// cleared rows a full image also carries.
    pub channels: i64,
    pub bank_names: i64,
    /// Another profile has the same model. Activity history is keyed by model
    /// (`scan_hits.scanner_id` is written from `DeviceInfo.model`), so where
    /// this is true one profile's history cannot be told from the other's.
    pub history_shared: bool,
}

/// Every stored profile, most recently seen first. Empty if the database
/// cannot be read.
pub(crate) fn list_profiles(path: &str) -> Vec<ProfileRow> {
    let Some(conn) = open_sqlite(path) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare(
        "SELECT s.scanner_id, s.model, s.display_name, s.last_seen,
                (SELECT MAX(synced_at) FROM channel_memory c WHERE c.scanner_id = s.scanner_id),
                (SELECT COUNT(*) FROM channel_memory c
                  WHERE c.scanner_id = s.scanner_id AND c.frequency > 0),
                (SELECT COUNT(*) FROM bank_names b WHERE b.scanner_id = s.scanner_id),
                EXISTS (SELECT 1 FROM scanners o
                         WHERE UPPER(o.model) = UPPER(s.model) AND o.scanner_id <> s.scanner_id)
           FROM scanners s
          ORDER BY s.last_seen DESC",
    ) else {
        return Vec::new();
    };
    let rows = stmt.query_map([], |row| {
        Ok(ProfileRow {
            scanner_id: row.get(0)?,
            model: row.get(1)?,
            display_name: row.get(2)?,
            last_seen: row.get(3)?,
            synced_at: row.get(4)?,
            channels: row.get(5)?,
            bank_names: row.get(6)?,
            history_shared: row.get(7)?,
        })
    });
    rows.into_iter().flatten().flatten().collect()
}

/// Set or clear a profile's label. `Ok(false)` when no such profile exists.
pub(crate) fn set_display_name(
    path: &str,
    scanner_id: &str,
    name: Option<&str>,
) -> Result<bool, rusqlite::Error> {
    let conn = open_sqlite(path).ok_or(rusqlite::Error::InvalidQuery)?;
    let changed = conn.execute(
        "UPDATE scanners SET display_name = ?1 WHERE scanner_id = ?2",
        rusqlite::params![name, scanner_id],
    )?;
    Ok(changed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::default_state;

    /// A serial the transport could not read is still recorded explicitly --
    /// but ONLY for a model whose serial means something (#570).
    ///
    /// This guard used to assert the same thing for a BC125AT, on the reasoning
    /// that "a scanner whose serial failed to read must not collide". That
    /// reasoning was sound for dropping the segment blindly and wrong for this
    /// model: a BC125AT reports `0001` for every unit, so `BC125AT:0001` never
    /// meant "this unit" -- it meant "a BC125AT". Keeping `unknown` as a second
    /// key for the same class of radio bought no precision and cost a profile
    /// split every time the descriptor read failed.
    ///
    /// A BC75XLT's serial is programmed per unit by Silicon Labs, so there the
    /// original reasoning holds exactly and is asserted below.
    #[test]
    fn a_missing_serial_is_still_distinct_where_the_serial_is_real() {
        assert_eq!(match_index("BC75XLT", Some("020D43D8")), "BC75XLT:020D43D8");
        assert_eq!(match_index("BC75XLT", None), "BC75XLT:unknown");
        assert_ne!(
            match_index("BC75XLT", None),
            match_index("BC75XLT", Some("020D43D8"))
        );
        assert_ne!(
            match_index("BC75XLT", Some("020D43D8")),
            match_index("BC75XLT", Some("020D43D9")),
            "two BC75XLTs are two radios"
        );
    }

    /// REGRESSION GUARD (#570): a serial that is a firmware constant is not
    /// part of the identity.
    ///
    /// Measured on both units 2026-08-26: every BC125AT reports usb_serial
    /// `0001`. It is a constant, not a per-unit id, so it can only ever flip
    /// between `0001` and `unknown` depending on whether the descriptor read
    /// succeeded -- splitting ONE radio across TWO profiles, each with its own
    /// channel cache, with the second one empty and the first orphaned.
    ///
    /// `has_unique_usb_serial` is what decides, so adding a model means stating
    /// the fact for that model rather than discovering this failure again.
    #[test]
    fn a_model_whose_serial_is_a_firmware_constant_ignores_it() {
        assert_eq!(
            match_index("BC125AT", Some("0001")),
            match_index("BC125AT", None),
            "a failed descriptor read must not create a second profile"
        );
        assert!(
            !match_index("BC125AT", Some("0001")).contains("0001"),
            "the constant must not reach the key at all"
        );
        assert!(
            !match_index("BC125AT", None).contains("unknown"),
            "and neither must the placeholder that stands in for it"
        );
    }

    /// The model is case-folded, because it is the one identity site that did
    /// not fold it (#570).
    ///
    /// `is_supported_model` and `ScannerCapabilities::for_model` both use
    /// `eq_ignore_ascii_case`, and `model_match_is_case_insensitive_at_connect`
    /// pins that `MDL,bc125at` is a reply Bearpaw must accept. `match_index`
    /// consumed that same string as an identity key WITHOUT folding, and
    /// `scanners.match_index` is UNIQUE -- so the two spellings would coexist
    /// forever as two profiles with two caches and nothing to signal they are
    /// one radio.
    #[test]
    fn the_model_case_does_not_change_the_index() {
        assert_eq!(
            match_index("bc125at", Some("0001")),
            match_index("BC125AT", Some("0001"))
        );
        assert_eq!(
            match_index("bc75xlt", Some("020D43D8")),
            match_index("BC75XLT", Some("020D43D8"))
        );
    }

    /// An unrecognised model KEEPS its serial.
    ///
    /// The flag says "this model's serial is a firmware constant", and that is
    /// a positive fact about a specific radio. For a model with no descriptor
    /// Bearpaw knows nothing, and the two errors are not symmetric: dropping a
    /// real serial would merge two different radios into one profile and
    /// cross-contaminate their channel memory, while keeping a constant one
    /// only risks a split that a re-sync fixes.
    #[test]
    fn an_unrecognised_model_keeps_its_serial() {
        assert_ne!(
            match_index("SDS100", Some("A")),
            match_index("SDS100", Some("B"))
        );
        assert_ne!(
            match_index("SDS100", Some("A")),
            match_index("SDS100", None)
        );
    }

    /// REGRESSION GUARD: the same scanner resolves to the SAME profile every
    /// time. This is the entire point of the table -- a new id per connect
    /// would give a user a fresh empty profile on every launch, and their
    /// cached channels would be orphaned behind a key nothing looks up again.
    #[test]
    fn a_known_scanner_keeps_its_profile() {
        let state = default_state();
        let first = resolve_scanner(&state.preferences_db_path, "BC125AT", Some("0001"))
            .expect("first connect creates a profile");
        let second = resolve_scanner(&state.preferences_db_path, "BC125AT", Some("0001"))
            .expect("second connect resolves the same one");

        assert_eq!(first, second, "the same hardware must map to one profile");
    }

    /// REGRESSION GUARD: two different scanners get two different profiles.
    ///
    /// Paired with the guard above on purpose. Asserting only that a known
    /// scanner keeps its id also passes for a build that returns one hardcoded
    /// id for everything -- which is exactly the `_default` behaviour this issue
    /// exists to replace.
    #[test]
    fn different_scanners_get_different_profiles() {
        let state = default_state();
        let bc125 = resolve_scanner(&state.preferences_db_path, "BC125AT", Some("0001")).unwrap();
        let bc75 =
            resolve_scanner(&state.preferences_db_path, "BC75XLT", Some("020D43D8")).unwrap();

        assert_ne!(
            bc125, bc75,
            "a BC125AT and a BC75XLT must not share a profile"
        );
    }

    /// Reconnecting records the visit without creating a second row.
    #[test]
    fn reconnecting_updates_last_seen_in_place() {
        let state = default_state();
        let id = resolve_scanner(&state.preferences_db_path, "BC75XLT", Some("020D43D8")).unwrap();

        let conn = crate::api::open_sqlite(&state.preferences_db_path).unwrap();
        let (first_seen, last_seen): (f64, f64) = conn
            .query_row(
                "SELECT first_seen, last_seen FROM scanners WHERE scanner_id = ?1",
                rusqlite::params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            first_seen, last_seen,
            "a new profile has not been seen twice"
        );

        resolve_scanner(&state.preferences_db_path, "BC75XLT", Some("020D43D8")).unwrap();

        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM scanners", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "a reconnect must not create a second profile");

        let after: f64 = conn
            .query_row(
                "SELECT last_seen FROM scanners WHERE scanner_id = ?1",
                rusqlite::params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(after >= first_seen, "last_seen must move forward, not back");
    }

    /// Every generated id is distinct, including ids generated back to back.
    ///
    /// A bare nanosecond timestamp is not enough on a fast machine: two calls
    /// inside one tick would collide, and `match_index` is UNIQUE so the second
    /// profile would fail to insert and the scanner would get no profile at all.
    #[test]
    fn generated_ids_do_not_collide() {
        let ids: std::collections::HashSet<String> = (0..1000).map(|_| new_scanner_id()).collect();
        assert_eq!(ids.len(), 1000, "every scanner_id must be unique");
    }

    /// An unusable database degrades to `None` rather than panicking, matching
    /// every other database path in this crate.
    #[test]
    fn an_unopenable_database_returns_none() {
        let path = "/definitely/not/a/writable/directory/scanner.db";
        assert!(resolve_scanner(path, "BC125AT", Some("0001")).is_none());
    }

    fn seed_channel(path: &str, scanner_id: &str, index: i64, frequency: f64, synced_at: f64) {
        crate::api::open_sqlite(path)
            .unwrap()
            .execute(
                "INSERT INTO channel_memory
                     (scanner_id, channel_index, frequency, delay, lockout, priority, synced_at)
                 VALUES (?1, ?2, ?3, 2, 0, 0, ?4)",
                rusqlite::params![scanner_id, index, frequency, synced_at],
            )
            .unwrap();
    }

    /// #417: the list reports each profile's OWN cache, counting programmed
    /// channels only, and the newest sync time. Two profiles with different
    /// numbers, so a query that ignored `scanner_id` reports the wrong ones.
    #[test]
    fn the_profile_list_reports_each_profiles_own_cache() {
        let state = default_state();
        let path = &state.preferences_db_path;
        let a = resolve_scanner(path, "BC125AT", Some("0001")).unwrap();
        let b = resolve_scanner(path, "BC75XLT", Some("020D43D8")).unwrap();
        seed_channel(path, &a, 1, 146.52, 100.0);
        seed_channel(path, &a, 2, 0.0, 200.0); // a cleared slot: cached, not programmed
        seed_channel(path, &b, 1, 162.55, 50.0);
        crate::api::open_sqlite(path)
            .unwrap()
            .execute(
                "INSERT INTO bank_names (scanner_id, bank, name) VALUES (?1, 1, 'Ham')",
                rusqlite::params![a],
            )
            .unwrap();

        let rows = list_profiles(path);
        let row = |id: &str| rows.iter().find(|r| r.scanner_id == id).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            row(&a).channels,
            1,
            "cleared slots are not programmed channels"
        );
        assert_eq!(row(&a).synced_at, Some(200.0));
        assert_eq!(row(&a).bank_names, 1);
        assert_eq!(row(&b).channels, 1);
        assert_eq!(row(&b).synced_at, Some(50.0));
        assert_eq!(row(&b).bank_names, 0);
    }

    /// #417: `history_shared` is true only where another profile has the same
    /// model, case-folded like `match_index`. Forget decides whether to delete
    /// activity history on this, because history is keyed by model.
    #[test]
    fn history_is_shared_only_between_profiles_of_one_model() {
        let state = default_state();
        let path = &state.preferences_db_path;
        let solo = resolve_scanner(path, "BC125AT", Some("0001")).unwrap();
        let x = resolve_scanner(path, "BC75XLT", Some("AAAA")).unwrap();
        let y = resolve_scanner(path, "bc75xlt", Some("BBBB")).unwrap();

        let rows = list_profiles(path);
        let shared = |id: &str| {
            rows.iter()
                .find(|r| r.scanner_id == id)
                .unwrap()
                .history_shared
        };
        assert!(!shared(&solo));
        assert!(shared(&x));
        assert!(shared(&y), "the model comparison is case-insensitive");
    }

    #[test]
    fn a_display_name_round_trips_and_clears() {
        let state = default_state();
        let path = &state.preferences_db_path;
        let id = resolve_scanner(path, "BC75XLT", Some("020D43D8")).unwrap();
        assert_eq!(display_name(path, &id), None);

        assert!(set_display_name(path, &id, Some("Truck")).unwrap());
        assert_eq!(display_name(path, &id).as_deref(), Some("Truck"));
        resolve_scanner(path, "BC75XLT", Some("020D43D8")).unwrap();
        assert_eq!(
            display_name(path, &id).as_deref(),
            Some("Truck"),
            "a reconnect keeps the name"
        );

        assert!(set_display_name(path, &id, None).unwrap());
        assert_eq!(display_name(path, &id), None);
        assert!(!set_display_name(path, "no-such-id", Some("x")).unwrap());
    }
}
