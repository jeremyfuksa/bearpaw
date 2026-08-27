import { useEffect, useMemo, useRef, useState } from 'react';
import { API_BASE } from '../api/useApi';
import { useStore } from '../store/useStore';
import type { ActivityLogEntry } from '../types';

export interface BusiestChannel {
  alpha_tag: string | null;
  /** Present on every row the backend returns; the tag may not be. */
  frequency?: number | null;
  channel?: number | null;
  hit_count: number;
  /** Axis label, derived once on fetch. See `busiestChannelLabel`. */
  label: string;
}

/**
 * Name a busiest-channels bar.
 *
 * The chart used to key its X axis on `alpha_tag` alone. A BC75XLT has no
 * alpha tags at all (`has_alpha_tags: false`), so every bar came out blank —
 * a row of anonymous rectangles, unusable rather than merely untidy, and
 * silent to a screen reader.
 *
 * Falls back to the frequency, which is what actually distinguishes the bars,
 * then to the channel number. Deliberately NOT gated on `has_alpha_tags`: a
 * BC125AT channel the user never named is equally blank, so the rule is "use
 * whatever identifies this row" rather than a per-model branch. Never invents
 * a placeholder like "Untitled" for a field the hardware cannot store.
 */
export function busiestChannelLabel(row: {
  alpha_tag?: string | null;
  frequency?: number | null;
  channel?: number | null;
}): string {
  const tag = row.alpha_tag?.trim();
  if (tag) return tag;
  if (row.frequency) return row.frequency.toFixed(3);
  if (row.channel !== undefined && row.channel !== null) return `CH ${row.channel}`;
  return '—';
}

export interface SessionStats {
  total_hits?: number;
  unique_channels?: number;
  active_time_seconds?: number;
}

export interface HeatmapStats {
  min: number;
  max: number;
  avg: number;
}

export interface DashboardAnalytics {
  busiestChannels: BusiestChannel[];
  sessionStats: SessionStats | null;
  hourlyHeatmap: number[][];
  heatmapStats: HeatmapStats;
  loading: boolean;
}

const EMPTY_HEATMAP_STATS: HeatmapStats = { min: 0, max: 0, avg: 0 };
const POLL_INTERVAL_MS = 5000;
const HEATMAP_DAYS = 7;
const SECONDS_PER_DAY = 24 * 60 * 60;

/**
 * Bucket the last 7 days of hits into a 7×24 grid using the browser's
 * local timezone. The backend's equivalent endpoint groups by UTC,
 * which shifts a Central-time evening into the next UTC morning — the
 * heatmap then renders activity on the wrong row + hour. Doing the
 * grouping client-side fixes the timezone shift naturally.
 *
 * - Day axis: Monday=0 … Sunday=6 (matches the row labels in ScanView).
 * - Hour axis: local hour 0..23.
 * - Only hits whose duration meets the `hit_min_duration` preference
 *   are counted, matching the backend's filter.
 */
function computeLocalHeatmap(
  hits: ActivityLogEntry[],
  minDurationSeconds: number,
): { hourlyHeatmap: number[][]; heatmapStats: HeatmapStats } {
  const cutoffSeconds = Date.now() / 1000 - HEATMAP_DAYS * SECONDS_PER_DAY;
  const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));

  for (const hit of hits) {
    if (typeof hit.timestamp !== 'number') continue;
    if (hit.timestamp < cutoffSeconds) continue;
    const duration = hit.duration ?? 0;
    if (duration < minDurationSeconds) continue;

    const local = new Date(hit.timestamp * 1000);
    // JS Date.getDay() is Sunday=0..Saturday=6. Convert to Monday=0..Sunday=6
    // so it aligns with the row labels rendered in ScanView.
    const day = (local.getDay() + 6) % 7;
    const hour = local.getHours();
    if (day >= 0 && day < 7 && hour >= 0 && hour < 24) {
      grid[day][hour] += 1;
    }
  }

  const counts = grid.flat().filter((c) => c > 0);
  const max = counts.length ? Math.max(...counts) : 0;
  const min = counts.length ? Math.min(...counts) : 0;
  const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;

  return { hourlyHeatmap: grid, heatmapStats: { min, max, avg } };
}

/**
 * Polls the backend's busiest-channels + session-stats endpoints on a
 * 5-second cadence whenever `enabled` is true, and computes the
 * 7×24 activity heatmap locally from the hydrated activity log so
 * timezone bucketing matches what the user sees on the wall clock.
 *
 * The `loading` flag is true only on the very first fetch of the
 * session — subsequent polls update silently so the dashboard doesn't
 * flicker every 5 seconds.
 */
export function useDashboardAnalytics(enabled: boolean): DashboardAnalytics {
  const [busiestChannels, setBusiestChannels] = useState<BusiestChannel[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [loading, setLoading] = useState(true);

  const loadedOnceRef = useRef(false);

  const fullActivityLog = useStore((s) => s.fullActivityLog);
  const hitMinDuration = useStore((s) => s.preferences.hitMinDuration);

  const { hourlyHeatmap, heatmapStats } = useMemo(
    () => computeLocalHeatmap(fullActivityLog, hitMinDuration),
    [fullActivityLog, hitMinDuration],
  );

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    const fetchAnalytics = async () => {
      try {
        if (!loadedOnceRef.current) {
          setLoading(true);
        }
        const [channelsRes, statsRes] = await Promise.all([
          // No `hours` param — backend defaults to all-time so the
          // dashboard reflects long-term busiest channels at cold start.
          fetch(`${API_BASE}/analytics/busiest-channels?limit=5`),
          fetch(`${API_BASE}/analytics/session-stats`),
        ]);
        if (channelsRes.ok) {
          const data = await channelsRes.json();
          if (active) {
            const rows: BusiestChannel[] = (data.channels || []).map(
              (row: Omit<BusiestChannel, 'label'>) => ({
                ...row,
                label: busiestChannelLabel(row),
              }),
            );
            setBusiestChannels(rows);
          }
        }
        if (statsRes.ok) {
          const data = await statsRes.json();
          if (active) setSessionStats(data);
        }
      } catch (error) {
        console.error('Failed to fetch analytics data:', error);
      } finally {
        if (active) {
          setLoading(false);
          loadedOnceRef.current = true;
        }
      }
    };

    fetchAnalytics();
    const interval = setInterval(fetchAnalytics, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [enabled]);

  return { busiestChannels, sessionStats, hourlyHeatmap, heatmapStats, loading };
}

// Exported for unit testing — the heatmap math is the load-bearing
// piece and is easier to cover directly than through the hook.
export { computeLocalHeatmap, EMPTY_HEATMAP_STATS };
