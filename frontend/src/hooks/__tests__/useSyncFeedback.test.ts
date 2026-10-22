import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { syncOutcomeFromMessage, useSyncFeedback } from '../useSyncFeedback';

afterEach(() => vi.useRealTimers());
describe('sync terminal feedback', () => {
  it('recognizes explicit backend outcomes, never transfer progress or cancellation requests', () => {
    expect(syncOutcomeFromMessage('Sync complete')).toBe('success');
    expect(syncOutcomeFromMessage('Sync cancelled')).toBe('cancelled');
    expect(syncOutcomeFromMessage('Sync failed: device disconnected')).toBe('error');
    expect(syncOutcomeFromMessage('Exiting program mode...')).toBeNull();
    expect(syncOutcomeFromMessage('Cancelling sync...')).toBeNull();
    expect(syncOutcomeFromMessage('Unable to cancel sync')).toBeNull();
  });
  it('holds success through the final stagger, then clears independently of sync state', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ active }) => useSyncFeedback(active, false), {
      initialProps: { active: true },
    });
    act(() => {
      result.current.finish('success', 100, 'Sync complete');
      rerender({ active: false });
    });
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.feedback?.outcome).toBe('success');
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.feedback).toBeNull();
  });
  it('shows cancellation briefly, keeps failures until dismissed, and resets for a new sync', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ active }) => useSyncFeedback(active, false), {
      initialProps: { active: false },
    });
    act(() => result.current.finish('cancelled', 60, 'Sync cancelled'));
    expect(result.current.feedback?.outcome).toBe('cancelled');
    act(() => vi.advanceTimersByTime(900));
    expect(result.current.feedback).toBeNull();
    act(() => result.current.finish('error', 60, 'Sync failed'));
    act(() => vi.advanceTimersByTime(10000));
    expect(result.current.feedback?.outcome).toBe('error');
    act(() => result.current.dismiss());
    expect(result.current.feedback).toBeNull();
    act(() => result.current.finish('success', 100, 'Sync complete'));
    rerender({ active: true });
    act(() => vi.advanceTimersByTime(1100));
    expect(result.current.feedback).toBeNull();
  });
});
