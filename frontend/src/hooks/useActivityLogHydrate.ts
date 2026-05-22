import { useEffect } from 'react';
import { API_BASE } from '../api/useApi';
import { useStore } from '../store/useStore';
import type { ActivityLogEntry } from '../types';

interface BackendHit {
  id?: string | number;
  timestamp?: number;
  frequency?: number;
  channel?: number | null;
  alpha_tag?: string | null;
  rssi?: number;
  duration?: number | null;
  ended_at?: number | null;
}

/**
 * One-shot hydration of `activityLog` / `fullActivityLog` from the
 * backend's persisted `scan_hits` table at app start.
 *
 * Without this, the dashboard's Recent Hits / Busiest Channels /
 * Heatmap panels look blank on every cold launch until the user gets
 * a fresh hit in the current session, even though the underlying
 * SQLite database holds weeks of history. The `useActivityLogTracker`
 * hook then prepends live hits to whatever this seeded.
 */
export function useActivityLogHydrate(): void {
  const hydrateActivityLogs = useStore((s) => s.hydrateActivityLogs);

  useEffect(() => {
    let active = true;

    fetch(`${API_BASE}/analytics/activity-log?limit=5000`)
      .then((res) => (res.ok ? res.json() : []))
      .then((rows: BackendHit[]) => {
        if (!active || !Array.isArray(rows)) return;
        const entries: ActivityLogEntry[] = rows.map((row) => ({
          id: String(row.id ?? `${row.timestamp ?? 0}-hydrated`),
          timestamp: row.timestamp ?? 0,
          frequency: row.frequency ?? 0,
          channel: row.channel ?? null,
          alpha_tag: row.alpha_tag ?? null,
          type: 'hit',
          rssi: row.rssi,
          hasAudio: false,
          duration: row.duration ?? null,
          ended_at: row.ended_at ?? null,
        }));
        hydrateActivityLogs(entries);
      })
      .catch(() => {
        // Non-fatal: live WS hits will still populate the log as they arrive.
      });

    return () => {
      active = false;
    };
  }, [hydrateActivityLogs]);
}
