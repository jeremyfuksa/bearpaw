import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const setPreference = vi.hoisted(() =>
  vi.fn((_key: string, value: unknown) => Promise.resolve(value)),
);
vi.mock('../../../../api/useApi', () => ({ getAPI: () => ({ setPreference }) }));

import {
  formatHitDuration,
  hitsSinceReset,
  rollUpHits,
  ScanView,
  summarizeHeatmap,
  HEATMAP_DAY_LABELS,
} from '../ScanView';
import { useStore } from '../../../../store/useStore';
import { createTestLiveState, createTestActivityLogEntry } from '../../../../test/fixtures';
import type { ActivityLogEntry, ScannerCapabilities } from '../../../../types';

// Read the REAL descriptor a backend test writes from the Rust allowlist, not
// a hand-built literal. CLAUDE.md records two earlier guards that rebuilt the
// shape they meant to check and passed while the bug was live.
const CAPS: Record<string, ScannerCapabilities> = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../../test/fixtures/scanner-capabilities.json',
    ),
    'utf-8',
  ),
);

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

  // The `(N)` suffix used to be baked into `tag` by this helper. It moved to
  // the renderer because a scanner with no alpha tags has no tag column to
  // carry it -- a bare "(3)" alone in an empty column reads as a glitch, and
  // the count now sits beside the frequency instead. These tests assert the
  // GROUPING contract (`count`, run boundaries), which is what they were
  // really pinning; presentation is asserted where it is now decided.
  it('collapses a run of same-channel hits into one row', () => {
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
    expect(rolled[0].tag).toBe('WOF Rides');
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
    expect(rolled.map((r) => r.tag)).toEqual(['WOF Rides', 'Police', 'WOF Rides']);
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
    expect(rolled[0].tag).toBe('Repeater');
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

  // #815: rssi is always 0–100. A reading of 3 is 3%, not three bars -- the
  // old `<= 5` branch read it as a bar count. 100 is the top of the meter.
  it('reads a low rssi as a weak signal, not as a bar count', () => {
    const rolled = rollUpHits([
      hit({ id: 'w1', timestamp: 30, channel: 1, alpha_tag: 'A', rssi: 3 }),
      hit({ id: 'w2', timestamp: 20, channel: 2, alpha_tag: 'B', rssi: 100 }),
    ]);
    expect(rolled.map((r) => r.strength)).toEqual([0, 5]);
  });

  // The em dash is applied by the renderer, and ONLY when the tag column is
  // shown. Baking it in here produced a full column of dashes on a BC75XLT,
  // which has no alpha tags at all -- roughly a third of every row saying
  // nothing. The helper reports the absence; the view decides how to show it.
  it('leaves a null tag empty rather than substituting a placeholder', () => {
    const rolled = rollUpHits([
      hit({ id: 'n1', timestamp: 10, channel: 9, alpha_tag: null, frequency: 146.85 }),
    ]);
    expect(rolled[0].tag).toBe('');
  });

  it('still counts a repeated null-tag run', () => {
    const rolled = rollUpHits([
      hit({ id: 'n1', timestamp: 20, channel: 9, alpha_tag: null }),
      hit({ id: 'n2', timestamp: 10, channel: 9, alpha_tag: null }),
    ]);
    expect(rolled[0].tag).toBe('');
    expect(rolled[0].count).toBe(2);
  });

  // #927: a rolled-up row plays all of its clips, so it has a recording if any
  // hit in the run does, not only the newest.
  it('marks a rolled-up row as recorded when any hit in the run has audio', () => {
    const rolled = rollUpHits([
      hit({ id: 'a1', timestamp: 30, channel: 1, hasAudio: false }),
      hit({ id: 'a2', timestamp: 20, channel: 1, hasAudio: true }),
      hit({ id: 'b1', timestamp: 10, channel: 2, hasAudio: false }),
    ]);
    expect(rolled.map((r) => r.hasRecording)).toEqual([true, false]);
  });
});

describe('Recent Hits duration (#816)', () => {
  it('totals the airtime of a rolled-up run, not just its newest hit', () => {
    const rolled = rollUpHits([
      hit({ id: 'a', timestamp: 30, channel: 7, duration: 4 }),
      hit({ id: 'b', timestamp: 20, channel: 7, duration: 6.4 }),
      hit({ id: 'c', timestamp: 10, channel: 2, duration: 3 }),
    ]);
    expect(rolled.map((r) => r.duration)).toEqual([10.4, 3]);
  });

  it('counts a hit with no recorded duration as zero', () => {
    expect(rollUpHits([hit({ channel: 1, duration: null })])[0].duration).toBe(0);
  });

  it.each([
    [0, '0s'],
    [8.4, '8s'],
    [59.6, '1m 00s'],
    [65, '1m 05s'],
    [3725, '1h 02m'],
  ])('formats %s seconds as %s', (seconds, label) => {
    expect(formatHitDuration(seconds)).toBe(label);
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
    heatmapStats: { max: 0 },
    squelch: 0,
    onSquelchChange: () => {},
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
      fullActivityLog: [],
    });
  });

  it('shows the first five rows, with older hits further down the list (#817)', () => {
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
    // Groups past the fifth are in the list, reached by scrolling it.
    const list = screen.getByRole('list', { name: 'Recent hits' });
    expect(within(list).getByText('Ch5')).toBeInTheDocument();
    expect(within(list).getByText('Ch6')).toBeInTheDocument();
    // Focusable, so the keyboard can scroll it too.
    expect(list).toHaveAttribute('tabindex', '0');
  });

  it('lists the newest 100 rows and no more', () => {
    useStore.setState({
      fullActivityLog: Array.from({ length: 150 }, (_, i) =>
        createTestActivityLogEntry({
          id: `h${i}`,
          timestamp: 1000 - i,
          channel: i + 1,
          alpha_tag: `Ch${i + 1}`,
        }),
      ),
    });
    render(<ScanView {...baseProps} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(100);
    expect(screen.getByText('Ch100')).toBeInTheDocument();
    expect(screen.queryByText('Ch101')).toBeNull();
  });

  describe('recording marker (#927)', () => {
    const rowFor = (tag: string) =>
      screen.getByText(tag).closest('[role="listitem"]') as HTMLElement;

    it('marks the rows that have a recording and only those', () => {
      useStore.setState({
        fullActivityLog: [
          createTestActivityLogEntry({
            id: 'r',
            timestamp: 20,
            channel: 1,
            alpha_tag: 'Rec',
            hasAudio: true,
          }),
          createTestActivityLogEntry({
            id: 'n',
            timestamp: 10,
            channel: 2,
            alpha_tag: 'NoRec',
            hasAudio: false,
          }),
        ],
      });
      render(<ScanView {...baseProps} />);
      expect(
        within(rowFor('Rec')).getByRole('img', { name: 'Has a recording' }),
      ).toBeInTheDocument();
      expect(within(rowFor('NoRec')).queryByRole('img', { name: 'Has a recording' })).toBeNull();
    });

    it('shows no marker anywhere when nothing was recorded', () => {
      useStore.setState({
        fullActivityLog: [
          createTestActivityLogEntry({ id: 'n', alpha_tag: 'NoRec', hasAudio: false }),
        ],
      });
      render(<ScanView {...baseProps} />);
      expect(screen.queryByRole('img', { name: 'Has a recording' })).toBeNull();
    });
  });

  describe('time format preference (#816)', () => {
    const start = Date.UTC(2026, 10, 13, 18, 4, 5) / 1000;
    const clock = new Date(start * 1000).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });

    beforeEach(() => {
      useStore.setState({
        fullActivityLog: [
          createTestActivityLogEntry({ id: 'a', timestamp: start, channel: 4, duration: 50 }),
          createTestActivityLogEntry({ id: 'b', timestamp: start - 90, channel: 4, duration: 15 }),
        ],
      });
    });

    it('shows elapsed time by default', () => {
      useStore.setState({
        preferences: { ...useStore.getState().preferences, recentHitsTimeFormat: 'relative' },
      });
      render(<ScanView {...baseProps} />);
      const row = screen.getByRole('listitem');
      expect(row).toHaveTextContent(/ago/);
      expect(row).not.toHaveTextContent(clock);
    });

    it('shows the start time and total duration when set to clock', () => {
      useStore.setState({
        preferences: {
          ...useStore.getState().preferences,
          recentHitsTimeFormat: 'clock',
          recentHitsTimezone: 'local',
        },
      });
      render(<ScanView {...baseProps} />);
      const row = screen.getByRole('listitem');
      expect(row).toHaveTextContent(`${clock} · 1m 05s`);
      expect(row).not.toHaveTextContent(/ago/);
    });

    it('shows the start time in UTC when that time zone is chosen', () => {
      useStore.setState({
        preferences: {
          ...useStore.getState().preferences,
          recentHitsTimeFormat: 'clock',
          recentHitsTimezone: 'utc',
        },
      });
      render(<ScanView {...baseProps} />);
      expect(screen.getByRole('listitem')).toHaveTextContent('18:04:05 UTC · 1m 05s');
    });
  });

  describe('scroll position', () => {
    // jsdom does no layout, so give each row a position from its place in the
    // list: 20 px per row.
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
        configurable: true,
        get(this: HTMLElement) {
          return this.parentElement ? [...this.parentElement.children].indexOf(this) * 20 : 0;
        },
      });
      return () => {
        if (original) Object.defineProperty(HTMLElement.prototype, 'offsetTop', original);
      };
    });

    const channels = (n: number, newest: number) =>
      Array.from({ length: n }, (_, i) =>
        createTestActivityLogEntry({
          id: `h${newest - i}`,
          timestamp: newest - i,
          channel: newest - i,
          alpha_tag: `Ch${newest - i}`,
        }),
      );

    it('stays put while the live state updates', () => {
      useStore.setState({ fullActivityLog: channels(10, 10) });
      render(<ScanView {...baseProps} />);
      const list = screen.getByRole('list', { name: 'Recent hits' });
      list.scrollTop = 60;
      act(() => {
        useStore.setState({ liveState: createTestLiveState({ mode: 'SCAN', frequency: 155.1 }) });
      });
      expect(screen.getByRole('list', { name: 'Recent hits' })).toBe(list);
      expect(list.scrollTop).toBe(60);
    });

    it('keeps the rows you are reading in place when a new hit arrives', () => {
      useStore.setState({ fullActivityLog: channels(10, 10) });
      render(<ScanView {...baseProps} />);
      const list = screen.getByRole('list', { name: 'Recent hits' });
      list.scrollTop = 60;
      act(() => {
        useStore.setState({ fullActivityLog: channels(11, 11) });
      });
      // One row (20 px) arrived above, so the view moves down by one row.
      expect(list.scrollTop).toBe(80);
    });

    it('shows a new hit at the top when the list is not scrolled', () => {
      useStore.setState({ fullActivityLog: channels(10, 10) });
      render(<ScanView {...baseProps} />);
      const list = screen.getByRole('list', { name: 'Recent hits' });
      act(() => {
        useStore.setState({ fullActivityLog: channels(11, 11) });
      });
      expect(list.scrollTop).toBe(0);
    });
  });

  // A BC75XLT has no alpha tags at all, so the tag column rendered an em dash
  // on every row -- about a third of each row saying nothing. The column is
  // removed rather than blanked (CLAUDE.md: hide unsupported surfaces), and
  // the roll-up count moves beside the frequency, which becomes the row's
  // identity.
  describe('on a scanner with no alpha tags', () => {
    beforeEach(() => {
      useStore.setState({
        deviceInfo: {
          model: 'BC75XLT',
          connection_status: 'connected',
          capabilities: CAPS.BC75XLT,
        },
        fullActivityLog: [
          createTestActivityLogEntry({
            id: 'n1',
            timestamp: 100,
            channel: null,
            alpha_tag: null,
            frequency: 146.85,
          }),
          createTestActivityLogEntry({
            id: 'n2',
            timestamp: 99,
            channel: null,
            alpha_tag: null,
            frequency: 146.85,
          }),
        ],
      });
    });

    it('renders no em-dash placeholder column', () => {
      render(<ScanView {...baseProps} />);
      expect(screen.queryByText('—')).not.toBeInTheDocument();
      expect(screen.queryByText(/^— \(\d+\)$/)).not.toBeInTheDocument();
    });

    // REGRESSION GUARD: the count must live in its OWN cell, never inside the
    // frequency span. The frequency column carries `text-right` so decimal
    // points line up; mixing "146.8500 (2)" and "27.4050" into that column
    // makes its contents vary in width, and right-aligning them indents the
    // short rows into a ragged left edge -- the same rows then read
    // left-aligned on a BC125AT and right-aligned on a BC75XLT.
    it('shows the roll-up count in its own cell, not inside the frequency', () => {
      render(<ScanView {...baseProps} />);
      const frequency = screen.getByText('146.850');
      expect(frequency).toBeInTheDocument();
      expect(frequency.textContent).toBe('146.850');
      expect(screen.getByText('(2)')).toBeInTheDocument();
    });
  });

  it('keeps the tag column on a scanner that has alpha tags', () => {
    useStore.setState({
      deviceInfo: {
        model: 'BC125AT',
        connection_status: 'connected',
        capabilities: CAPS.BC125AT,
      },
      fullActivityLog: [
        createTestActivityLogEntry({
          id: 't1',
          timestamp: 100,
          channel: 7,
          alpha_tag: 'WOF Rides',
        }),
      ],
    });
    render(<ScanView {...baseProps} />);
    expect(screen.getByText('WOF Rides')).toBeInTheDocument();
  });
});

/**
 * The heatmap grid is 168 unlabelled <div>s whose only description was a
 * `title` attribute. `title` is not announced on a non-focusable element, so
 * to assistive tech the whole widget was empty — a WCAG 1.1.1 failure.
 */
describe('Activity Heatmap accessibility', () => {
  const emptyGrid = () => Array.from({ length: 7 }, () => Array(24).fill(0));

  describe('summarizeHeatmap', () => {
    it('says so plainly when there is nothing to report', () => {
      expect(summarizeHeatmap(emptyGrid())).toMatch(/no hits recorded/i);
    });

    it('names the busiest day and hour, which is what the chart is for', () => {
      const grid = emptyGrid();
      grid[1][18] = 9; // Tue 18:00
      grid[3][2] = 4;
      const summary = summarizeHeatmap(grid);
      expect(summary).toContain('13 hits');
      expect(summary).toContain('Tue');
      expect(summary).toContain('18:00');
      expect(summary).toContain('9');
    });

    it('tolerates a ragged or empty grid rather than throwing', () => {
      expect(() => summarizeHeatmap([])).not.toThrow();
      expect(() => summarizeHeatmap([[1]])).not.toThrow();
    });
  });

  describe('rendering', () => {
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
      hourlyHeatmap: (() => {
        const g = Array.from({ length: 7 }, () => Array(24).fill(0));
        g[1][18] = 9;
        return g;
      })(),
      heatmapStats: { max: 9 },
      squelch: 0,
      onSquelchChange: () => {},
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
        fullActivityLog: [],
      });
    });

    it('exposes the heatmap as a table with day and hour headers', () => {
      render(<ScanView {...baseProps} />);
      const table = screen.getByRole('table', { name: /activity heatmap/i });
      expect(table).toBeInTheDocument();
      // Row headers let a screen reader announce "Tue, 18:00, 9" while moving
      // through cells, rather than reading 168 bare numbers.
      expect(within(table).getByRole('rowheader', { name: 'Tue' })).toBeInTheDocument();
      expect(within(table).getByRole('columnheader', { name: '18:00' })).toBeInTheDocument();
    });

    it('carries every day label as a row', () => {
      render(<ScanView {...baseProps} />);
      const table = screen.getByRole('table', { name: /activity heatmap/i });
      for (const day of HEATMAP_DAY_LABELS) {
        expect(within(table).getByRole('rowheader', { name: day })).toBeInTheDocument();
      }
    });
  });
});

describe('Recent Hits export control', () => {
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
    heatmapStats: { max: 0 },
    squelch: 0,
    onSquelchChange: () => {},
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
      fullActivityLog: [createTestActivityLogEntry({ id: 'e1', timestamp: 100 })],
    });
  });

  /**
   * The control used to be an icon with its purpose in a hover tooltip, which
   * is unreachable by touch and invisible to anyone scanning the page. The
   * visible text is the label now.
   */
  it('carries a visible text label, not just an icon', () => {
    render(<ScanView {...baseProps} />);
    expect(screen.getByRole('button', { name: /export activity log/i })).toHaveTextContent(
      /export/i,
    );
  });

  /**
   * WCAG 2.5.3 (Label in Name): the accessible name must contain the visible
   * text, so speech-input users can activate the control by saying what they
   * see. `aria-label` overrides the text as the name, so the two must agree.
   */
  it('keeps the accessible name a superset of the visible text', () => {
    render(<ScanView {...baseProps} />);
    const button = screen.getByRole('button', { name: /export activity log/i });
    const visible = (button.textContent ?? '').trim().toLowerCase();
    const accessibleName = (button.getAttribute('aria-label') ?? '').toLowerCase();
    expect(visible).not.toBe('');
    expect(accessibleName).toContain(visible);
  });

  // The scanner's last mode survives a disconnect, so `mode: 'SCAN'` alone
  // made the display claim it was scanning with no scanner attached.
  it('shows the disconnected text, not "Scanning...", while disconnected', () => {
    render(
      <ScanView
        {...baseProps}
        connectionStatus="disconnected"
        mainText="Disconnected"
        subText="No scanner connected"
      />,
    );
    expect(screen.getByText('Disconnected', { selector: 'p, span, div' })).toBeInTheDocument();
    expect(screen.queryByText('Scanning...')).not.toBeInTheDocument();
  });

  it('is disabled while there is nothing to export', () => {
    useStore.setState({ fullActivityLog: [] });
    render(<ScanView {...baseProps} />);
    expect(screen.getByRole('button', { name: /export activity log/i })).toBeDisabled();
  });
});

describe('hitsSinceReset (#818)', () => {
  it('keeps every hit when Recent Hits was never reset', () => {
    const entries = [hit({ id: 'a', timestamp: 10, ended_at: 12 })];
    expect(hitsSinceReset(entries, null)).toBe(entries);
  });

  it('keeps hits that ended after the reset, including one on the air when it was pressed', () => {
    const entries = [
      hit({ id: 'after', timestamp: 200, ended_at: 205 }),
      hit({ id: 'straddles', timestamp: 145, ended_at: 155 }),
      hit({ id: 'before', timestamp: 100, ended_at: 105 }),
    ];
    expect(hitsSinceReset(entries, 150).map((e) => e.id)).toEqual(['after', 'straddles']);
  });

  it('falls back to the start time for a hit with no end time', () => {
    const entries = [
      hit({ id: 'new', timestamp: 160, ended_at: null }),
      hit({ id: 'old', timestamp: 140, ended_at: null }),
    ];
    expect(hitsSinceReset(entries, 150).map((e) => e.id)).toEqual(['new']);
  });
});

describe('Recent Hits reset (#818)', () => {
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
    heatmapStats: { max: 0 },
    squelch: 0,
    onSquelchChange: () => {},
    onHoldToggle: () => {},
    onLockout: () => {},
    onVolumeChange: () => {},
    onBankToggle: () => {},
    onOpenActivityExport: () => {},
  };
  const log = [
    createTestActivityLogEntry({ id: 'new', timestamp: 200, ended_at: 205, alpha_tag: 'Fire' }),
    createTestActivityLogEntry({
      id: 'old',
      timestamp: 100,
      ended_at: 105,
      channel: 2,
      alpha_tag: 'Police',
    }),
  ];

  beforeEach(() => {
    setPreference.mockReset();
    setPreference.mockImplementation((_key: string, value: unknown) => Promise.resolve(value));
    useStore.setState({
      liveState: createTestLiveState({ mode: 'SCAN', squelch_open: false }),
      banks: Array(10).fill(true),
      fullActivityLog: log,
      preferences: { ...useStore.getState().preferences, recentHitsResetAt: null },
    });
  });

  it('empties Recent Hits, saves when, and leaves the activity log alone', async () => {
    render(<ScanView {...baseProps} />);
    expect(screen.getByText('Fire')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Clear Recent Hits' }));

    await waitFor(() => expect(screen.getByText('Waiting for signals...')).toBeInTheDocument());
    expect(setPreference).toHaveBeenCalledWith('recent_hits_reset_at', expect.any(Number));
    expect(useStore.getState().preferences.recentHitsResetAt).toBe(setPreference.mock.calls[0][1]);
    expect(useStore.getState().fullActivityLog).toBe(log);
    expect(screen.getByRole('button', { name: /export activity log/i })).toBeEnabled();
  });

  it('applies a stored reset on launch, so the cleared hits stay cleared', () => {
    useStore.setState({
      preferences: { ...useStore.getState().preferences, recentHitsResetAt: 150 },
    });
    render(<ScanView {...baseProps} />);
    expect(screen.getByText('Fire')).toBeInTheDocument();
    expect(screen.queryByText('Police')).toBeNull();
  });

  it('keeps the list when the reset cannot be saved', async () => {
    setPreference.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<ScanView {...baseProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear Recent Hits' }));

    await waitFor(() => expect(setPreference).toHaveBeenCalled());
    await act(async () => {});
    expect(useStore.getState().preferences.recentHitsResetAt).toBeNull();
    expect(screen.getByText('Police')).toBeInTheDocument();
  });

  it('is disabled while Recent Hits is empty', () => {
    useStore.setState({ fullActivityLog: [] });
    render(<ScanView {...baseProps} />);
    expect(screen.getByRole('button', { name: 'Clear Recent Hits' })).toBeDisabled();
  });
});

// #905 drew a "My scanner isn't listed" link here. Removed: a radio that answers
// MDL connects and gets the unsupported panel, so this screen is nearly always
// a scanner that is just unplugged, and the link sat on top of bank buttons 8-10.
describe('ScanView with no scanner found', () => {
  const props = {
    mainText: 'Disconnected',
    subText: 'No scanner connected',
    scannerMode: 'SCAN' as const,
    connectionStatus: 'disconnected' as const,
    isHolding: false,
    isInitialSyncing: false,
    chartAnimate: false,
    dashboardLoading: false,
    busiestChannels: [],
    hourlyHeatmap: [],
    heatmapStats: { max: 0 },
    squelch: 0,
    onSquelchChange: () => {},
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
      fullActivityLog: [],
      // What the backend really sends before any scanner is found.
      deviceInfo: { connection_status: 'disconnected', diagnostic_code: 'scanner_not_found' },
    });
  });

  it('offers no "isn\'t listed" link', () => {
    render(<ScanView {...props} />);
    expect(screen.queryByRole('button', { name: /isn't listed/i })).toBeNull();
  });
});
