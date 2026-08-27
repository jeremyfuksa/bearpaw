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
