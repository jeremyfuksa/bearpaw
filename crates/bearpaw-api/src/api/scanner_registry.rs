//! Which physical scanner is this, and what is its profile?
//!
//! Bearpaw treats a connection as a scanner. To hold more than one profile it
//! has to recognise the unit on the other end of the cable, and it can only
//! recognise it from what the hardware volunteers.
//!
//! Three names, and they are NOT interchangeable:
//!
//! - **`match_index`** — `model:serial`, e.g. `BC125AT:0001`. This is what does
//!   the recognising. It is derived from the wire every time.
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
/// `model:serial`, with a literal `unknown` where the transport could not read
/// a serial. Explicit rather than omitted: a missing serial must produce a
/// stable, distinguishable index, not silently collapse two different states
/// into the same string.
pub(crate) fn match_index(model: &str, usb_serial: Option<&str>) -> String {
    format!("{}:{}", model, usb_serial.unwrap_or("unknown"))
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
/// Exercised by tests but not yet by production code — the connect path adopts
/// it in a later PR, together with reading the serial on the USB-direct
/// transport.
#[allow(dead_code)]
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::default_state;

    /// A serial the transport could not read is recorded explicitly.
    ///
    /// `BC125AT:unknown` and `BC125AT:0001` must be different profiles. Dropping
    /// the segment instead would make a scanner whose serial failed to read
    /// collide with whichever model happened to be listed first.
    #[test]
    fn a_missing_serial_still_produces_a_distinct_index() {
        assert_eq!(match_index("BC125AT", Some("0001")), "BC125AT:0001");
        assert_eq!(match_index("BC125AT", None), "BC125AT:unknown");
        assert_ne!(
            match_index("BC125AT", None),
            match_index("BC125AT", Some("0001"))
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
}
