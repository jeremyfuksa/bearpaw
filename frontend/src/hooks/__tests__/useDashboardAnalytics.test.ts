import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { computeLocalHeatmap } from '../useDashboardAnalytics';
import type { ActivityLogEntry } from '../../types';

function makeHit(overrides: Partial<ActivityLogEntry> & { timestamp: number }): ActivityLogEntry {
  return {
    id: String(overrides.id ?? overrides.timestamp),
    timestamp: overrides.timestamp,
    frequency: overrides.frequency ?? 146.52,
    type: 'hit',
    duration: overrides.duration ?? 5,
    ...overrides,
  };
}

describe('computeLocalHeatmap', () => {
  beforeEach(() => {
    // Pin "now" so cutoff logic is deterministic. 2026-06-15 12:00 local.
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an empty 7×24 grid when there are no hits', () => {
    const { hourlyHeatmap, heatmapStats } = computeLocalHeatmap([], 2);
    expect(hourlyHeatmap).toHaveLength(7);
    expect(hourlyHeatmap.every((row) => row.length === 24)).toBe(true);
    expect(hourlyHeatmap.every((row) => row.every((c) => c === 0))).toBe(true);
    expect(heatmapStats).toEqual({ min: 0, max: 0, avg: 0 });
  });

  it('buckets a hit by local day/hour, not UTC', () => {
    // Build a Date for a known local moment: Wednesday 2026-06-10 14:30 local.
    // Wednesday is row 2 in Monday-first ordering (Mon=0, Tue=1, Wed=2).
    const localDate = new Date(2026, 5, 10, 14, 30, 0);
    const epochSeconds = localDate.getTime() / 1000;

    const { hourlyHeatmap } = computeLocalHeatmap(
      [makeHit({ timestamp: epochSeconds, duration: 5 })],
      2,
    );
    expect(hourlyHeatmap[2][14]).toBe(1);
    // No other cells touched.
    const total = hourlyHeatmap.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  it('filters out hits older than 7 days', () => {
    const eightDaysAgo = Date.now() / 1000 - 8 * 86400;
    const oneDayAgo = Date.now() / 1000 - 86400;

    const { hourlyHeatmap } = computeLocalHeatmap(
      [
        makeHit({ id: 'old', timestamp: eightDaysAgo, duration: 5 }),
        makeHit({ id: 'recent', timestamp: oneDayAgo, duration: 5 }),
      ],
      2,
    );
    const total = hourlyHeatmap.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  it('filters out hits shorter than the min-duration preference', () => {
    const now = Date.now() / 1000;
    const { hourlyHeatmap } = computeLocalHeatmap(
      [
        makeHit({ id: 'short', timestamp: now - 60, duration: 1 }),
        makeHit({ id: 'long', timestamp: now - 120, duration: 10 }),
      ],
      2,
    );
    const total = hourlyHeatmap.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(1);
  });

  it('treats missing/null durations as 0 so they fail the min-duration check', () => {
    const now = Date.now() / 1000;
    const { hourlyHeatmap } = computeLocalHeatmap(
      [makeHit({ timestamp: now - 60, duration: null })],
      2,
    );
    const total = hourlyHeatmap.flat().reduce((a, b) => a + b, 0);
    expect(total).toBe(0);
  });

  it('counts repeat hits in the same hour bucket', () => {
    const now = Date.now() / 1000;
    const { hourlyHeatmap, heatmapStats } = computeLocalHeatmap(
      [
        makeHit({ id: '1', timestamp: now - 600, duration: 5 }),
        makeHit({ id: '2', timestamp: now - 1200, duration: 5 }),
        makeHit({ id: '3', timestamp: now - 1800, duration: 5 }),
      ],
      2,
    );
    const max = Math.max(...hourlyHeatmap.flat());
    expect(max).toBeGreaterThanOrEqual(1);
    expect(heatmapStats.max).toBe(max);
  });

  it('maps Sunday to row 6 (Monday-first ordering)', () => {
    // 2026-06-14 is a Sunday.
    const sundayLocal = new Date(2026, 5, 14, 9, 0, 0);
    const epochSeconds = sundayLocal.getTime() / 1000;

    const { hourlyHeatmap } = computeLocalHeatmap(
      [makeHit({ timestamp: epochSeconds, duration: 5 })],
      2,
    );
    expect(hourlyHeatmap[6][9]).toBe(1);
  });

  it('reports stats only for populated cells', () => {
    const now = Date.now() / 1000;
    const { heatmapStats } = computeLocalHeatmap(
      [
        makeHit({ id: '1', timestamp: now - 3600, duration: 5 }),
        makeHit({ id: '2', timestamp: now - 7200, duration: 5 }),
      ],
      2,
    );
    // Two populated cells with count=1 each → min=max=avg=1
    expect(heatmapStats.min).toBe(1);
    expect(heatmapStats.max).toBe(1);
    expect(heatmapStats.avg).toBe(1);
  });
});
