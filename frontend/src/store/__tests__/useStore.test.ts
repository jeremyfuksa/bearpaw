import { renderHook, act } from '@testing-library/react';
import { useStore, mapStoredPreferences } from '../useStore';

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
      useStore.setState({ fullActivityLog: [] });
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

  describe('sync state (drives the memory-sync overlay)', () => {
    beforeEach(() => {
      useStore.setState({
        sync: {
          inProgress: false,
          hasSyncedInitially: false,
          taskId: null,
          message: '',
          percent: 0,
        },
      });
    });

    it('merges a partial patch instead of replacing the whole sync object', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.updateSync({ inProgress: true, taskId: 'task-1' });
      });
      act(() => {
        result.current.updateSync({ percent: 50 });
      });

      // A replace-instead-of-merge would drop inProgress/taskId here and the
      // blocking overlay would vanish mid-sync.
      expect(result.current.sync.inProgress).toBe(true);
      expect(result.current.sync.taskId).toBe('task-1');
      expect(result.current.sync.percent).toBe(50);
    });

    it('can clear inProgress without losing the final progress', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.updateSync({ inProgress: true, percent: 100, message: 'Done' });
      });
      act(() => {
        result.current.updateSync({ inProgress: false });
      });

      expect(result.current.sync.inProgress).toBe(false);
      expect(result.current.sync.percent).toBe(100);
      expect(result.current.sync.message).toBe('Done');
    });
  });

  describe('memory drafts (unsaved channel edits)', () => {
    beforeEach(() => {
      useStore.setState({ memoryDrafts: {}, memoryEditingIndex: null });
    });

    it('keeps drafts for different channels independent', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.setMemoryDraft(1, { alpha_tag: 'ONE' } as never);
        result.current.setMemoryDraft(2, { alpha_tag: 'TWO' } as never);
      });

      expect(result.current.memoryDrafts[1]).toMatchObject({ alpha_tag: 'ONE' });
      expect(result.current.memoryDrafts[2]).toMatchObject({ alpha_tag: 'TWO' });
    });

    it('overwrites the draft for a channel that is edited twice', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.setMemoryDraft(1, { alpha_tag: 'FIRST' } as never);
        result.current.setMemoryDraft(1, { alpha_tag: 'SECOND' } as never);
      });

      expect(result.current.memoryDrafts[1]).toMatchObject({ alpha_tag: 'SECOND' });
    });

    it('clearMemoryDrafts drops every pending edit', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.setMemoryDraft(1, { alpha_tag: 'ONE' } as never);
        result.current.setMemoryDraft(2, { alpha_tag: 'TWO' } as never);
      });
      act(() => {
        result.current.clearMemoryDrafts();
      });

      expect(result.current.memoryDrafts).toEqual({});
    });

    it('tracks which channel is being edited, and clears back to null', () => {
      const { result } = renderHook(() => useStore());

      act(() => {
        result.current.setMemoryEditingIndex(42);
      });
      expect(result.current.memoryEditingIndex).toBe(42);

      act(() => {
        result.current.setMemoryEditingIndex(null);
      });
      expect(result.current.memoryEditingIndex).toBeNull();
    });
  });

  describe('banks', () => {
    it('mirrors the bank mask the server reports', () => {
      const { result } = renderHook(() => useStore());
      const mask = [true, false, false, false, false, false, false, false, false, false];

      act(() => {
        result.current.setBanks(mask);
      });

      expect(result.current.banks).toEqual(mask);
    });
  });

  describe('preferences', () => {
    it('merges a partial update instead of replacing all preferences', () => {
      const { result } = renderHook(() => useStore());
      const before = result.current.preferences;

      act(() => {
        result.current.updatePreferences({ theme: 'day' } as never);
      });

      expect(result.current.preferences.theme).toBe('day');
      // Everything else must survive — a replace would reset the user's
      // hit threshold, retention window, and display mode.
      expect(result.current.preferences.hitMinDuration).toBe(before.hitMinDuration);
      expect(result.current.preferences.displayMode).toBe(before.displayMode);
    });
  });
  describe('mapStoredPreferences (#509)', () => {
    // The backend's shape, as GET /preferences actually returns it.
    const stored = {
      theme: 'field',
      displayMode: 'alpha',
      reduced_motion: true,
      hit_min_duration: 5,
      data_retention_days: 90,
      audio_output_device: 'speakers',
      check_updates_on_launch: false,
      analytics_scope: 'all',
      activity_export_timezone: 'utc',
    };

    it('restores analyticsScope from the backend', () => {
      // THE BUG: analyticsScope was wired for the WRITE (PREFERENCE_KEY_MAP)
      // but never read back, so every launch reset the store to 'scanner'
      // while the backend kept scoping /activity-log by the saved 'all'. The
      // toggle and the data disagreed, and neither looked wrong on its own.
      expect(mapStoredPreferences(stored).analyticsScope).toBe('all');
    });

    it('reads every preference back from its stored key', () => {
      expect(mapStoredPreferences(stored)).toEqual({
        theme: 'field',
        displayMode: 'alpha',
        reducedMotion: true,
        hitMinDuration: 5,
        dataRetentionDays: 90,
        audioOutputDevice: 'speakers',
        checkUpdatesOnLaunch: false,
        analyticsScope: 'all',
        activityExportTimezone: 'utc',
      });
    });

    it('covers every key in the store defaults', () => {
      // Runtime companion to the return type. `Preferences` already makes an
      // omission a compile error; this catches a key that is present but
      // silently reads the wrong stored name, which types cannot see.
      const { preferences } = useStore.getState();
      expect(Object.keys(mapStoredPreferences({})).sort()).toEqual(Object.keys(preferences).sort());
    });

    it('falls back to defaults when the backend has nothing stored', () => {
      // Asserted literally rather than against useStore.getState(): earlier
      // tests in this file mutate preferences and the beforeEach only resets
      // liveState, so comparing to live store state is order-dependent.
      expect(mapStoredPreferences({})).toEqual({
        theme: 'night',
        displayMode: 'frequency',
        reducedMotion: false,
        hitMinDuration: 2,
        dataRetentionDays: 30,
        audioOutputDevice: 'default',
        checkUpdatesOnLaunch: true,
        analyticsScope: 'scanner',
        activityExportTimezone: 'local',
      });
    });

    it('keeps a stored false for checkUpdatesOnLaunch', () => {
      // `??`, not `||`. This defaults to true, so `||` would coerce a stored
      // false back to true and the toggle would revert on every launch.
      expect(mapStoredPreferences({ check_updates_on_launch: false }).checkUpdatesOnLaunch).toBe(
        false,
      );
      expect(mapStoredPreferences({}).checkUpdatesOnLaunch).toBe(true);
    });

    it('treats an unrecognised analytics_scope as scanner', () => {
      expect(mapStoredPreferences({ analytics_scope: 'nonsense' }).analyticsScope).toBe('scanner');
    });
  });
});
