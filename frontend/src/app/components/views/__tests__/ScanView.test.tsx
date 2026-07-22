import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { rollUpHits, ScanView } from '../ScanView';
import { useStore } from '../../../../store/useStore';
import { createTestLiveState, createTestActivityLogEntry } from '../../../../test/fixtures';
import type { ActivityLogEntry } from '../../../../types';

// Minimal entry factory. Tests pass entries newest-first, the same order
// `fullActivityLog` is kept in the store.
function hit(overrides: Partial<ActivityLogEntry>): ActivityLogEntry {
  return {
    id: overrides.id ?? `${overrides.timestamp ?? 0}`,
    timestamp: overrides.timestamp ?? 0,
    frequency: overrides.frequency ?? 146.85,
    channel: overrides.channel ?? null,
    alpha_tag: overrides.alpha_tag ?? null,
    type: 'hit',
    rssi: overrides.rssi,
    ...overrides,
  };
}

describe('rollUpHits', () => {
  it('returns an empty array for empty input', () => {
    expect(rollUpHits([])).toEqual([]);
  });

  it('passes non-repeating hits through with no count suffix', () => {
    const rolled = rollUpHits([
      hit({ id: 'a', timestamp: 30, channel: 1, alpha_tag: 'WOF Rides', frequency: 146.85 }),
      hit({ id: 'b', timestamp: 20, channel: 2, alpha_tag: 'Police', frequency: 154.1 }),
      hit({ id: 'c', timestamp: 10, channel: 3, alpha_tag: 'Fire', frequency: 155.0 }),
    ]);
    expect(rolled.map((r) => r.tag)).toEqual(['WOF Rides', 'Police', 'Fire']);
    expect(rolled.map((r) => r.count)).toEqual([1, 1, 1]);
  });

  it('collapses a run of same-channel hits into one row with a count suffix', () => {
    const entries = Array.from({ length: 6 }, (_, i) =>
      hit({
        id: `h${i}`,
        // newest first: timestamps descending
        timestamp: 60 - i * 10,
        channel: 7,
        alpha_tag: 'WOF Rides',
        frequency: 146.85,
        rssi: 60,
      }),
    );
    const rolled = rollUpHits(entries);
    expect(rolled).toHaveLength(1);
    expect(rolled[0].count).toBe(6);
    expect(rolled[0].tag).toBe('WOF Rides (6)');
    // time is the most recent (newest) hit in the group
    expect(rolled[0].time).toBe(60);
    // id is the most recent hit's id (stable React key)
    expect(rolled[0].id).toBe('h0');
  });

  it('does not merge non-consecutive runs of the same channel', () => {
    // A, A, B, A  →  WOF Rides (2), Police, WOF Rides
    const rolled = rollUpHits([
      hit({ id: 'a1', timestamp: 40, channel: 1, alpha_tag: 'WOF Rides' }),
      hit({ id: 'a2', timestamp: 30, channel: 1, alpha_tag: 'WOF Rides' }),
      hit({ id: 'b1', timestamp: 20, channel: 2, alpha_tag: 'Police' }),
      hit({ id: 'a3', timestamp: 10, channel: 1, alpha_tag: 'WOF Rides' }),
    ]);
    expect(rolled.map((r) => r.tag)).toEqual(['WOF Rides (2)', 'Police', 'WOF Rides']);
    expect(rolled.map((r) => r.count)).toEqual([2, 1, 1]);
  });

  it('groups channel-less hits by frequency', () => {
    const rolled = rollUpHits([
      hit({ id: 'f1', timestamp: 30, channel: null, frequency: 462.55, alpha_tag: null }),
      hit({ id: 'f2', timestamp: 20, channel: null, frequency: 462.55, alpha_tag: null }),
      hit({ id: 'f3', timestamp: 10, channel: null, frequency: 467.7, alpha_tag: null }),
    ]);
    expect(rolled).toHaveLength(2);
    expect(rolled[0].count).toBe(2);
    expect(rolled[0].frequency).toBe('462.550');
    expect(rolled[1].count).toBe(1);
  });

  it('does not merge different channels that share a frequency', () => {
    // Same frequency but distinct channel numbers must not merge — channel is
    // the primary key.
    const rolled = rollUpHits([
      hit({ id: 'c1', timestamp: 20, channel: 10, frequency: 146.85, alpha_tag: 'A' }),
      hit({ id: 'c2', timestamp: 10, channel: 11, frequency: 146.85, alpha_tag: 'B' }),
    ]);
    expect(rolled.map((r) => r.count)).toEqual([1, 1]);
  });

  it('counts a run longer than the store cap (proves it reads full history)', () => {
    // 8 consecutive same-channel hits — more than the store's 5-entry
    // activityLog cap. A correct count of 8 is only possible from fullActivityLog.
    const entries = Array.from({ length: 8 }, (_, i) =>
      hit({ id: `h${i}`, timestamp: 80 - i * 10, channel: 3, alpha_tag: 'Repeater' }),
    );
    const rolled = rollUpHits(entries);
    expect(rolled).toHaveLength(1);
    expect(rolled[0].count).toBe(8);
    expect(rolled[0].tag).toBe('Repeater (8)');
  });

  it('rolls up every group (the 5-row display cap is the caller’s concern)', () => {
    // The helper itself does not truncate — it rolls up all history and the
    // component slices to HIT_SLOT_COUNT. 7 distinct channels → 7 groups.
    const entries = Array.from({ length: 7 }, (_, i) =>
      hit({ id: `g${i}`, timestamp: 70 - i * 10, channel: i, alpha_tag: `Ch${i}` }),
    );
    expect(rollUpHits(entries)).toHaveLength(7);
  });

  it('averages the group signal strength and rounds', () => {
    // normalizeSignal maps rssi/20 (rounded, capped 0–5). rssi 60 → 3, 80 → 4.
    // Average of strengths [3, 4] = 3.5 → rounds to 4.
    const rolled = rollUpHits([
      hit({ id: 's1', timestamp: 20, channel: 5, alpha_tag: 'X', rssi: 60 }),
      hit({ id: 's2', timestamp: 10, channel: 5, alpha_tag: 'X', rssi: 80 }),
    ]);
    expect(rolled[0].strength).toBe(4);
  });

  it('renders an em dash for a null tag', () => {
    const rolled = rollUpHits([
      hit({ id: 'n1', timestamp: 10, channel: 9, alpha_tag: null, frequency: 146.85 }),
    ]);
    expect(rolled[0].tag).toBe('—');
  });

  it('appends the count to an em-dash tag when a null-tag run repeats', () => {
    const rolled = rollUpHits([
      hit({ id: 'n1', timestamp: 20, channel: 9, alpha_tag: null }),
      hit({ id: 'n2', timestamp: 10, channel: 9, alpha_tag: null }),
    ]);
    expect(rolled[0].tag).toBe('— (2)');
  });
});

describe('ScanView Recent Hits rendering', () => {
  const baseProps = {
    mainText: 'Scanning...',
    subText: '',
    scannerMode: 'SCAN' as const,
    connectionStatus: 'connected' as const,
    isHolding: false,
    isInitialSyncing: false,
    chartAnimate: false,
    dashboardLoading: false,
    busiestChannels: [],
    hourlyHeatmap: [],
    heatmapStats: { min: 0, max: 0, avg: 0 },
    onHoldToggle: () => {},
    onLockout: () => {},
    onVolumeChange: () => {},
    onBankToggle: () => {},
    onOpenActivityExport: () => {},
  };

  beforeEach(() => {
    useStore.setState({
      liveState: createTestLiveState({ mode: 'SCAN', squelch_open: false }),
      banks: Array(10).fill(true),
      activityLog: [],
      fullActivityLog: [],
    });
  });

  it('renders at most five rolled-up rows and shows the count suffix', () => {
    // Seven distinct channels, newest-first, plus a leading run of three on
    // channel 0 so the first row shows "(3)".
    const entries: ActivityLogEntry[] = [
      createTestActivityLogEntry({ id: 'r1', timestamp: 100, channel: 0, alpha_tag: 'WOF Rides' }),
      createTestActivityLogEntry({ id: 'r2', timestamp: 99, channel: 0, alpha_tag: 'WOF Rides' }),
      createTestActivityLogEntry({ id: 'r3', timestamp: 98, channel: 0, alpha_tag: 'WOF Rides' }),
      ...Array.from({ length: 6 }, (_, i) =>
        createTestActivityLogEntry({
          id: `d${i}`,
          timestamp: 90 - i,
          channel: i + 1,
          alpha_tag: `Ch${i + 1}`,
        }),
      ),
    ];
    useStore.setState({ fullActivityLog: entries });

    render(<ScanView {...baseProps} />);

    // The rolled-up first group carries the count suffix.
    expect(screen.getByText('WOF Rides (3)')).toBeInTheDocument();
    // Seven groups exist but only HIT_SLOT_COUNT (5) render: the (3) run plus
    // Ch1–Ch4. Ch5 and Ch6 fall outside the five-slot window.
    expect(screen.getByText('Ch4')).toBeInTheDocument();
    expect(screen.queryByText('Ch5')).not.toBeInTheDocument();
    expect(screen.queryByText('Ch6')).not.toBeInTheDocument();
  });
});
