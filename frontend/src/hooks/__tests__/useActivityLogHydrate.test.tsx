import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useActivityLogHydrate } from '../useActivityLogHydrate';
import { useStore } from '../../store/useStore';

describe('useActivityLogHydrate', () => {
  beforeEach(() => {
    useStore.setState({
      preferences: { ...useStore.getState().preferences, analyticsScope: 'scanner' },
      fullActivityLog: [],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => [] } as unknown as Response),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * REGRESSION GUARD: the backend scopes /activity-log by `analytics_scope`,
   * so a change to that preference changes what the endpoint returns.
   *
   * This hook is the ONLY thing that fills `fullActivityLog`, from which both
   * Recent Hits and the Activity Heatmap are derived. If it stays one-shot,
   * Busiest Channels follows the new setting on its next 5-second poll while
   * those two keep showing the old scope until an app restart — three widgets
   * on one page disagreeing, which reads as a bug rather than a setting.
   */
  it('re-fetches when the analytics scope preference changes', async () => {
    const { rerender } = renderHook(() => useActivityLogHydrate());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    useStore.setState({
      preferences: { ...useStore.getState().preferences, analyticsScope: 'all' },
    });
    rerender();

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch).toHaveBeenLastCalledWith(expect.stringContaining('scope=all'));
  });

  it.each([
    ['scanner', 'all'],
    ['all', 'scanner'],
  ] as const)('replaces %s history when the scope changes to %s', async (from, to) => {
    useStore.setState({
      preferences: { ...useStore.getState().preferences, analyticsScope: from },
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: `${from}-hit`, timestamp: 100, frequency: 145.1 }],
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: `${to}-hit`, timestamp: 200, frequency: 154.8 }],
      } as unknown as Response);

    const { rerender } = renderHook(() => useActivityLogHydrate());
    await waitFor(() =>
      expect(useStore.getState().fullActivityLog.map((entry) => entry.id)).toEqual([`${from}-hit`]),
    );

    useStore.setState({
      preferences: { ...useStore.getState().preferences, analyticsScope: to },
    });
    rerender();

    await waitFor(() =>
      expect(useStore.getState().fullActivityLog.map((entry) => entry.id)).toEqual([`${to}-hit`]),
    );
  });

  it('keeps and deduplicates a live hit that arrives during a scope refresh', async () => {
    let resolveRefresh!: (response: Response) => void;
    const refresh = new Promise<Response>((resolve) => {
      resolveRefresh = resolve;
    });
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [{ id: 'old-scope', timestamp: 100, frequency: 145.1 }],
      } as unknown as Response)
      .mockReturnValueOnce(refresh);

    const { rerender } = renderHook(() => useActivityLogHydrate());
    await waitFor(() => expect(useStore.getState().fullActivityLog).toHaveLength(1));

    useStore.setState({
      preferences: { ...useStore.getState().preferences, analyticsScope: 'all' },
    });
    rerender();
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));

    const liveTimestamp = Date.now() / 1000 + 1;
    useStore.getState().addToFullActivityLog({
      id: 'live',
      timestamp: liveTimestamp,
      frequency: 154.8,
      channel: 3,
      type: 'hit',
    });
    resolveRefresh({
      ok: true,
      json: async () => [
        { id: 'new-history', timestamp: 200, frequency: 151.5 },
        { id: 'persisted-copy', timestamp: liveTimestamp, frequency: 154.8, channel: 3 },
      ],
    } as unknown as Response);

    await waitFor(() =>
      expect(useStore.getState().fullActivityLog.map((entry) => entry.id)).toEqual([
        'live',
        'new-history',
      ]),
    );
  });

  it('does not re-fetch when an unrelated preference changes', async () => {
    const { rerender } = renderHook(() => useActivityLogHydrate());
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));

    useStore.setState({
      preferences: { ...useStore.getState().preferences, hitMinDuration: 9 },
    });
    rerender();

    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
