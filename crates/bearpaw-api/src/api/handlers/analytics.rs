use axum::extract::{Query, State};
use axum::response::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

use super::super::{day_hour, epoch_now, min_hit_duration, ActivityHit, AppState};

/// Which scanner's hits the analytics views should count.
///
/// `None` means "count everything", and there are two ways to get there:
/// nothing is connected (an empty dashboard on a disconnected app would look
/// broken rather than scoped), or the user set `analytics_scope` to `"all"`.
/// Both collapse to the same answer, so the callers need no extra branch.
fn analytics_scanner_filter(state: &AppState) -> Option<String> {
    let sum_across_scanners = state
        .preferences
        .lock()
        .ok()
        .and_then(|p| {
            p.get("analytics_scope")
                .and_then(Value::as_str)
                .map(|scope| scope == "all")
        })
        .unwrap_or(false);
    if sum_across_scanners {
        return None;
    }
    state.device.read().ok().and_then(|d| d.model.clone())
}

/// Does this hit belong in a view scoped to `scanner`?
///
/// Unattributed hits (`scanner_id IS NULL`) COUNT. They were recorded before
/// #440 added the column, so every existing user's whole history is NULL --
/// and a strict equality filter would empty their dashboard the first time
/// they launch an upgraded build. Nothing was deleted, but "my history
/// vanished after an update" is indistinguishable from data loss to the person
/// it happens to.
///
/// The cost is that a user with two scanners sees pre-upgrade hits under both
/// until the NULLs age out of the retention window. That is the right trade:
/// the ambiguity is confined to history that predates attribution, it decays
/// on its own as attributed hits accumulate, and owning two scanners is the
/// rare case while upgrading is the universal one.
fn hit_matches_scanner(hit: &ActivityHit, scanner: Option<&str>) -> bool {
    match (scanner, hit.scanner_id.as_deref()) {
        (None, _) => true,
        (Some(_), None) => true,
        (Some(want), Some(got)) => want == got,
    }
}

#[derive(Deserialize)]
pub(crate) struct AnalyticsBusiestQuery {
    limit: Option<usize>,
    hours: Option<f64>,
}

pub(crate) async fn analytics_busiest(
    State(state): State<AppState>,
    Query(query): Query<AnalyticsBusiestQuery>,
) -> Json<Value> {
    let limit = query.limit.unwrap_or(10).max(1);
    // Default window is "all of history" so the dashboard shows the
    // user's actual busiest channels at startup, even before they get
    // a hit in the current session. Pass `hours=N` to scope the window.
    let cutoff = query.hours.map(|h| epoch_now() - h.max(0.1) * 3600.0);
    let min_duration = min_hit_duration(&state);

    let scanner = analytics_scanner_filter(&state);
    let log = state.analytics_log.lock().unwrap();
    let mut grouped: HashMap<String, (f64, Option<String>, Option<u16>, usize, f64, f64)> =
        HashMap::new();
    for hit in log.iter().filter(|h| {
        cutoff.is_none_or(|c| h.timestamp >= c)
            && h.duration >= min_duration
            && hit_matches_scanner(h, scanner.as_deref())
    }) {
        let key = format!("{}|{}", hit.frequency, hit.channel.unwrap_or(0));
        let entry = grouped.entry(key).or_insert((
            hit.frequency,
            hit.alpha_tag.clone(),
            hit.channel,
            0,
            0.0,
            0.0,
        ));
        entry.3 += 1;
        entry.4 += hit.duration;
        if hit.timestamp > entry.5 {
            entry.5 = hit.timestamp;
        }
    }

    let mut rows: Vec<Value> = grouped
        .into_values()
        .map(|(frequency, alpha_tag, channel, hit_count, total_duration, last_seen)| {
            json!({
                "frequency": frequency,
                "alpha_tag": alpha_tag,
                "channel": channel,
                "hit_count": hit_count,
                "avg_duration": if hit_count > 0 { total_duration / hit_count as f64 } else { 0.0 },
                "last_seen": last_seen
            })
        })
        .collect();
    rows.sort_by(|a, b| {
        b.get("hit_count")
            .and_then(Value::as_u64)
            .cmp(&a.get("hit_count").and_then(Value::as_u64))
    });
    rows.truncate(limit);
    for (idx, row) in rows.iter_mut().enumerate() {
        if let Value::Object(map) = row {
            map.insert("rank".to_string(), Value::from((idx + 1) as u64));
        }
    }

    Json(json!({ "channels": rows }))
}

pub(crate) async fn analytics_session_stats(State(state): State<AppState>) -> Json<Value> {
    let session_id = (*state.session_id).clone();
    let min_duration = min_hit_duration(&state);
    let log = state.analytics_log.lock().unwrap();
    let mut total_hits = 0usize;
    let mut rssi_sum = 0u64;
    let mut active_time_seconds = 0.0f64;
    let mut unique_channels: HashSet<u16> = HashSet::new();

    for hit in log
        .iter()
        .filter(|h| h.session_id == session_id && h.duration >= min_duration)
    {
        total_hits += 1;
        rssi_sum += hit.rssi as u64;
        active_time_seconds += hit.duration;
        if let Some(ch) = hit.channel {
            unique_channels.insert(ch);
        }
    }

    Json(json!({
        "total_hits": total_hits,
        "avg_rssi": if total_hits > 0 { (rssi_sum as f64) / (total_hits as f64) } else { 0.0 },
        "active_time_seconds": active_time_seconds,
        "unique_channels": unique_channels.len()
    }))
}

#[derive(Deserialize)]
pub(crate) struct HourlyHeatmapQuery {
    days: Option<u32>,
    /// Client UTC offset in minutes EAST of UTC (local = UTC + offset), e.g.
    /// -300 for CDT. Without it the server buckets in UTC (#143) — the
    /// backend has no timezone database, so local bucketing is the client's
    /// call to make. Clamped to ±14 h.
    tz_offset_minutes: Option<i32>,
}

pub(crate) async fn analytics_hourly_heatmap(
    State(state): State<AppState>,
    Query(query): Query<HourlyHeatmapQuery>,
) -> Json<Value> {
    let days = query.days.unwrap_or(7).max(1);
    let tz_shift_secs = f64::from(query.tz_offset_minutes.unwrap_or(0).clamp(-840, 840)) * 60.0;
    let cutoff = epoch_now() - (days as f64 * 24.0 * 3600.0);
    let min_duration = min_hit_duration(&state);
    let scanner = analytics_scanner_filter(&state);
    let log = state.analytics_log.lock().unwrap();
    let mut bins: HashMap<(u32, u32), u64> = HashMap::new();
    for hit in log.iter().filter(|h| {
        h.timestamp >= cutoff
            && h.duration >= min_duration
            && hit_matches_scanner(h, scanner.as_deref())
    }) {
        let (day, hour) = day_hour(hit.timestamp + tz_shift_secs);
        *bins.entry((day, hour)).or_insert(0) += 1;
    }
    let mut heatmap = Vec::new();
    let mut counts = Vec::new();
    for ((day, hour), count) in bins {
        counts.push(count as f64);
        heatmap.push(json!({ "hour": hour, "day": day, "count": count }));
    }
    heatmap.sort_by(|a, b| {
        a.get("day")
            .and_then(Value::as_u64)
            .cmp(&b.get("day").and_then(Value::as_u64))
            .then_with(|| {
                a.get("hour")
                    .and_then(Value::as_u64)
                    .cmp(&b.get("hour").and_then(Value::as_u64))
            })
    });
    let min = counts
        .iter()
        .cloned()
        .fold(0.0, |acc, v| if acc == 0.0 { v } else { acc.min(v) });
    let max = counts.iter().cloned().fold(0.0, f64::max);
    let avg = if counts.is_empty() {
        0.0
    } else {
        counts.iter().sum::<f64>() / counts.len() as f64
    };
    Json(json!({ "heatmap": heatmap, "stats": { "min": min, "max": max, "avg": avg } }))
}

#[derive(Deserialize)]
pub(crate) struct ActivityLogQuery {
    limit: Option<usize>,
    offset: Option<usize>,
    start_time: Option<f64>,
    end_time: Option<f64>,
    channel: Option<u16>,
}

pub(crate) async fn analytics_activity_log(
    State(state): State<AppState>,
    Query(query): Query<ActivityLogQuery>,
) -> Json<Value> {
    let limit = query.limit.unwrap_or(100);
    let offset = query.offset.unwrap_or(0);
    let start = query.start_time.unwrap_or(0.0);
    let end = query.end_time.unwrap_or(f64::MAX);
    let channel_filter = query.channel;
    let scanner = analytics_scanner_filter(&state);
    let mut rows = state
        .analytics_log
        .lock()
        .unwrap()
        .iter()
        .filter(|h| h.timestamp >= start && h.timestamp <= end)
        .filter(|h| channel_filter.map(|c| h.channel == Some(c)).unwrap_or(true))
        .filter(|h| hit_matches_scanner(h, scanner.as_deref()))
        .cloned()
        .collect::<Vec<ActivityHit>>();
    rows.sort_by(|a, b| {
        b.timestamp
            .partial_cmp(&a.timestamp)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let slice = rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .collect::<Vec<ActivityHit>>();
    Json(json!(slice))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::ScannerMode;

    fn hit(scanner_id: Option<&str>) -> ActivityHit {
        ActivityHit {
            id: "1".to_string(),
            timestamp: 100.0,
            frequency: 146.7,
            channel: Some(12),
            alpha_tag: None,
            rssi: 30,
            duration: 5.0,
            modulation: "NFM".to_string(),
            mode: ScannerMode::Scan,
            bank: Some(1),
            session_id: "s".to_string(),
            ended_at: 105.0,
            scanner_id: scanner_id.map(str::to_string),
        }
    }

    #[test]
    fn a_scoped_view_counts_only_the_connected_scanner() {
        assert!(hit_matches_scanner(&hit(Some("BC75XLT")), Some("BC75XLT")));
        assert!(!hit_matches_scanner(&hit(Some("BC125AT")), Some("BC75XLT")));
    }

    /// REGRESSION GUARD: unattributed history must keep counting.
    ///
    /// #440 added `scanner_id`, so every hit recorded before it is NULL --
    /// which is every existing user's ENTIRE history. A strict equality filter
    /// would empty their dashboard the first time they launch an upgraded
    /// build. Nothing is deleted, but "my history vanished after an update" is
    /// indistinguishable from data loss to the person it happens to.
    ///
    /// The cost is that a two-scanner user sees pre-upgrade hits under both
    /// radios until those NULLs age out of the retention window. That
    /// ambiguity is confined to history predating attribution and decays on
    /// its own; upgrading is universal, owning two scanners is rare.
    #[test]
    fn unattributed_history_still_counts_after_an_upgrade() {
        assert!(hit_matches_scanner(&hit(None), Some("BC75XLT")));
        assert!(hit_matches_scanner(&hit(None), Some("BC125AT")));
    }

    /// With nothing connected the views must not filter themselves empty --
    /// a blank dashboard reads as broken, not as scoped.
    /// The `analytics_scope` preference turns the per-scanner filter off.
    ///
    /// "All scanners" is expressed as `None` -- the same value a disconnected
    /// app produces -- so every call site keeps one code path. A second flag
    /// threaded through three handlers would be the obvious alternative and is
    /// strictly more to get wrong.
    #[test]
    fn the_all_scanners_preference_disables_scoping() {
        let state = crate::api::default_state();
        {
            let mut d = state.device.write().unwrap();
            d.model = Some("BC75XLT".to_string());
        }
        assert_eq!(
            analytics_scanner_filter(&state).as_deref(),
            Some("BC75XLT"),
            "the default preference scopes to the connected scanner"
        );

        state
            .preferences
            .lock()
            .unwrap()
            .insert("analytics_scope".to_string(), json!("all"));

        assert_eq!(
            analytics_scanner_filter(&state),
            None,
            "\"all\" must collapse to the same None that means count everything"
        );
    }

    /// An unrecognised value must scope rather than sum. A typo in a stored
    /// preference should not silently widen what the dashboard counts.
    #[test]
    fn an_unknown_scope_value_falls_back_to_per_scanner() {
        let state = crate::api::default_state();
        {
            let mut d = state.device.write().unwrap();
            d.model = Some("BC75XLT".to_string());
        }
        state
            .preferences
            .lock()
            .unwrap()
            .insert("analytics_scope".to_string(), json!("everything"));

        assert_eq!(analytics_scanner_filter(&state).as_deref(), Some("BC75XLT"));
    }

    #[test]
    fn nothing_connected_counts_everything() {
        assert!(hit_matches_scanner(&hit(Some("BC125AT")), None));
        assert!(hit_matches_scanner(&hit(None), None));
    }
}
