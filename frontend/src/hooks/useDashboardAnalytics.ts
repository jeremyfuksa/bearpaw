import { useEffect, useRef, useState } from 'react';
import { API_BASE } from '../api/useApi';

export interface BusiestChannel {
  alpha_tag: string;
  hit_count: number;
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

/**
 * Polls the backend's three analytics endpoints (busiest-channels,
 * session-stats, hourly-heatmap) on a 5-second cadence whenever
 * `enabled` is true. Each tab switch back into the Scan view re-arms
 * polling; switching away tears it down.
 *
 * The `loading` flag is true only on the very first fetch of the
 * session — subsequent polls update silently so the dashboard doesn't
 * flicker every 5 seconds.
 */
export function useDashboardAnalytics(enabled: boolean): DashboardAnalytics {
  const [busiestChannels, setBusiestChannels] = useState<BusiestChannel[]>([]);
  const [sessionStats, setSessionStats] = useState<SessionStats | null>(null);
  const [hourlyHeatmap, setHourlyHeatmap] = useState<number[][]>([]);
  const [heatmapStats, setHeatmapStats] = useState<HeatmapStats>(EMPTY_HEATMAP_STATS);
  const [loading, setLoading] = useState(true);

  const loadedOnceRef = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let active = true;

    const fetchAnalytics = async () => {
      try {
        if (!loadedOnceRef.current) {
          setLoading(true);
        }
        const [channelsRes, statsRes, heatmapRes] = await Promise.all([
          fetch(`${API_BASE}/analytics/busiest-channels?limit=5&hours=24`),
          fetch(`${API_BASE}/analytics/session-stats`),
          fetch(`${API_BASE}/analytics/hourly-heatmap`),
        ]);
        if (channelsRes.ok) {
          const data = await channelsRes.json();
          if (active) setBusiestChannels(data.channels || []);
        }
        if (statsRes.ok) {
          const data = await statsRes.json();
          if (active) setSessionStats(data);
        }
        if (heatmapRes.ok) {
          const data = await heatmapRes.json();
          if (active) {
            const stats = data.stats || EMPTY_HEATMAP_STATS;
            const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
            if (data.heatmap && Array.isArray(data.heatmap)) {
              for (const cell of data.heatmap) {
                if (cell.day >= 0 && cell.day < 7 && cell.hour >= 0 && cell.hour < 24) {
                  grid[cell.day][cell.hour] = cell.count;
                }
              }
            }
            setHourlyHeatmap(grid);
            setHeatmapStats(stats);
          }
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
