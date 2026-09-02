import { useEffect, useRef } from 'react';
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
 * Hydrates `activityLog` / `fullActivityLog` from the backend's persisted
 * `scan_hits` table at app start, and again whenever the `analytics_scope`
 * preference changes what that endpoint returns.
 *
 * Without this, the dashboard's Recent Hits / Busiest Channels /
 * Heatmap panels look blank on every cold launch until the user gets
 * a fresh hit in the current session, even though the underlying
 * SQLite database holds weeks of history. The `useActivityLogTracker`
 * hook then prepends live hits to whatever this seeded.
 */
export function useActivityLogHydrate(): void {
  const hydrateActivityLogs = useStore((s) => s.hydrateActivityLogs);
  // The backend scopes /activity-log by the `analytics_scope` preference, so a
  // change to it changes what this endpoint returns. Without it in the deps
  // this stays one-shot: Busiest Channels would follow the new setting on its
  // next 5-second poll while Recent Hits and the heatmap -- both derived from
  // `fullActivityLog`, which only this hook fills -- kept showing the old
  // scope until an app restart. Three widgets disagreeing reads as a bug
  // rather than a setting.
  const analyticsScope = useStore((s) => s.preferences.analyticsScope);
  const hydratedScopeRef = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    const requestStartedAt = Date.now() / 1000;
    const replace = hydratedScopeRef.current !== null;

    fetch(`${API_BASE}/analytics/activity-log?limit=5000&scope=${analyticsScope}`)
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
        hydrateActivityLogs(entries, { replace, preserveSince: requestStartedAt });
        hydratedScopeRef.current = analyticsScope;
      })
      .catch(() => {
        // Non-fatal: live WS hits will still populate the log as they arrive.
      });

    return () => {
      active = false;
    };
  }, [hydrateActivityLogs, analyticsScope]);
}
