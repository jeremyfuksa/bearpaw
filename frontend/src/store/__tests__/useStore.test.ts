import { renderHook, act } from '@testing-library/react';
import { useStore } from '../useStore';
import { vi } from 'vitest';

describe('useStore', () => {
  beforeEach(() => {
    useStore.setState({
      liveState: null,
      lastSequence: 0,
    });
  });

  describe('updateLiveState', () => {
    it('should not update with stale sequence number', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.updateLiveState({ frequency: 145.5, modulation: 'FM' }, 5);
      });

      act(() => {
        result.current.updateLiveState({ frequency: 146.0, modulation: 'FM' }, 3);
      });

      expect(result.current.liveState?.frequency).toBe(145.5);
    });

    it('should let a low sequence through again after resetSequence (reconnect)', () => {
      const { result } = renderHook(() => useStore());

      // Simulate a long-running backend: lastSequence has climbed high.
      act(() => {
        result.current.updateLiveState({ frequency: 145.5 }, 5000);
      });
      expect(result.current.liveState?.frequency).toBe(145.5);

      // A restarted backend reseeds at 0 and sends sequence 1 — normally dropped.
      act(() => {
        result.current.updateLiveState({ frequency: 146.0 }, 1);
      });
      expect(result.current.liveState?.frequency).toBe(145.5);

      // On reconnect the gate is reset, so the fresh low sequence is accepted.
      act(() => {
        result.current.resetSequence();
      });
      act(() => {
        result.current.updateLiveState({ frequency: 146.0 }, 1);
      });
      expect(result.current.liveState?.frequency).toBe(146.0);
    });

    it('should bootstrap initial state from partial updates', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.updateLiveState({ mode: 'SCAN' }, 1);
      });

      expect(result.current.liveState).toEqual(
        expect.objectContaining({
          mode: 'SCAN',
          frequency: 0,
          modulation: 'FM',
        }),
      );
    });

    it('should merge partial updates when liveState exists', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.updateLiveState(
          {
            frequency: 145.5,
            modulation: 'FM',
            mode: 'SCAN',
          },
          1,
        );
      });

      act(() => {
        result.current.updateLiveState({ rssi: 80 }, 2);
      });

      expect(result.current.liveState).toEqual(
        expect.objectContaining({
          frequency: 145.5,
          modulation: 'FM',
          mode: 'SCAN',
          rssi: 80,
        }),
      );
    });
  });

  describe('addActivityLogEntry', () => {
    it('should limit log to 5 entries', () => {
      const { result } = renderHook(() => useStore());

      for (let i = 1; i <= 7; i++) {
        act(() => {
          result.current.addActivityLogEntry({
            id: `entry-${i}`,
            timestamp: Date.now() / 1000,
            frequency: 145.5,
            type: 'hit',
          });
        });
      }

      expect(result.current.activityLog).toHaveLength(5);
      expect(result.current.activityLog[0].id).toBe('entry-7');
    });
  });

  describe('addToFullActivityLog', () => {
    it('should keep all entries', () => {
      const { result } = renderHook(() => useStore());

      for (let i = 1; i <= 7; i++) {
        act(() => {
          result.current.addToFullActivityLog({
            id: `entry-${i}`,
            timestamp: Date.now() / 1000,
            frequency: 145.5,
            type: 'hit',
          });
        });
      }

      expect(result.current.fullActivityLog).toHaveLength(7);
    });
  });

  describe('hydrateActivityLogs', () => {
    beforeEach(() => {
      useStore.setState({ activityLog: [], fullActivityLog: [] });
    });

    it('seeds full and recent logs sorted newest-first', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.hydrateActivityLogs([
          { id: 'old', timestamp: 100, frequency: 146.5, type: 'hit' },
          { id: 'new', timestamp: 300, frequency: 154.8, type: 'hit' },
          { id: 'mid', timestamp: 200, frequency: 151.5, type: 'hit' },
        ]);
      });

      expect(result.current.fullActivityLog.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
      expect(result.current.activityLog.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
    });

    it('caps activityLog at 5 even when more history is hydrated', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.hydrateActivityLogs(
          Array.from({ length: 8 }, (_, i) => ({
            id: `e-${i}`,
            timestamp: i,
            frequency: 146.5,
            type: 'hit' as const,
          })),
        );
      });

      expect(result.current.fullActivityLog).toHaveLength(8);
      expect(result.current.activityLog).toHaveLength(5);
    });

    it('does not clobber an existing in-memory log', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.addToFullActivityLog({
          id: 'live',
          timestamp: 999,
          frequency: 146.5,
          type: 'hit',
        });
      });

      act(() => {
        result.current.hydrateActivityLogs([
          { id: 'history', timestamp: 100, frequency: 154.8, type: 'hit' },
        ]);
      });

      expect(result.current.fullActivityLog.map((e) => e.id)).toEqual(['live']);
    });
  });

  describe('setChannels', () => {
    it('should handle undefined channels', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.setChannels(undefined as any);
      });

      expect(result.current.channels).toEqual([]);
    });

    it('should handle null channels', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.setChannels(null as any);
      });

      expect(result.current.channels).toEqual([]);
    });
  });

  describe('setImportProgress', () => {
    it('patches importProgress and leaves sync untouched', () => {
      const { result } = renderHook(() => useStore());
      const syncBefore = result.current.sync;

      act(() => {
        result.current.setImportProgress({
          active: true,
          percent: 40,
          message: 'Importing 200/500',
        });
      });

      expect(result.current.importProgress).toEqual({
        active: true,
        percent: 40,
        message: 'Importing 200/500',
      });
      // The isolation guarantee: import progress must never mutate sync state.
      expect(result.current.sync).toBe(syncBefore);
    });

    it('merges partial patches', () => {
      const { result } = renderHook(() => useStore());
      act(() => result.current.setImportProgress({ active: true, percent: 0, message: 'start' }));
      act(() => result.current.setImportProgress({ percent: 75 }));

      expect(result.current.importProgress).toEqual({
        active: true,
        percent: 75,
        message: 'start',
      });
    });
  });
});
