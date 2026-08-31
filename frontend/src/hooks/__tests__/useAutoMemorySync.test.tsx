import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAutoMemorySync } from '../useAutoMemorySync';
import { useStore } from '../../store/useStore';
import { createTestChannel, createTestDeviceInfo } from '../../test/fixtures';
import type { ChannelData } from '../../types';

/**
 * BEHAVIOURAL guards for the auto-sync decision (#568).
 *
 * The source-level guards in `App.regression.test.tsx` pin the SHAPE and ORDER
 * of this decision and are precise about both. They are blind to timing, and
 * the bug they missed was purely a timing one: a preference the user toggled
 * mid-session re-ran the effect and drove the radio. The guard that was meant
 * to cover it asserted that the deps array CONTAINED a string, which a build
 * with the bug satisfies perfectly.
 *
 * These mount the real hook. Nothing here regexes source.
 */
describe('useAutoMemorySync', () => {
  const api = {
    getChannels: vi.fn<() => Promise<ChannelData[]>>(),
    syncMemory: vi.fn<() => Promise<{ status?: string; task_id?: string }>>(),
  };
  const updateSync = vi.fn();
  const setChannels = vi.fn();

  const connected = createTestDeviceInfo({ connection_status: 'connected' });

  /** Reset the real store between tests -- the hook reads it via getState(). */
  const setPreference = (rereadMemoryOnConnect: boolean) => {
    useStore.setState((prev) => ({
      preferences: { ...prev.preferences, rereadMemoryOnConnect },
    }));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    api.getChannels.mockResolvedValue([]);
    api.syncMemory.mockResolvedValue({ status: 'started', task_id: 'sync-1' });
    useStore.setState({ sync: { ...useStore.getState().sync, inProgress: false } });
    setPreference(true);
  });

  const render = (overrides: Partial<Parameters<typeof useAutoMemorySync>[0]> = {}) =>
    renderHook((props: Parameters<typeof useAutoMemorySync>[0]) => useAutoMemorySync(props), {
      initialProps: {
        api,
        channels: [] as ChannelData[],
        deviceInfo: connected,
        preferencesLoaded: true,
        updateSync,
        setChannels,
        ...overrides,
      },
    });

  /**
   * THE BUG. Flipping the switch is not a connect, and must not drive the
   * radio.
   *
   * `handlePreferenceChange` updates the Zustand store optimistically and
   * synchronously, so before #568 this store write re-ran the effect with the
   * early return no longer applying, and `api.syncMemory()` went out -- the
   * full-screen "Syncing Scanner Memory" overlay over the settings page the
   * user was standing on, and the radio deaf for the whole walk.
   *
   * The store write IS the mechanism; mounting DeviceTab as well would exercise
   * the same input through more machinery.
   */
  it('toggling the preference ON while connected does not start a sync', async () => {
    // Warm cache, preference OFF: the steady state a user is in before they
    // reach for the switch. The early return fires, so NOTHING is called --
    // asserted, because a setup that had already synced would hide the bug.
    setPreference(false);
    const channels = [createTestChannel({ index: 1 })];
    api.getChannels.mockResolvedValue(channels);
    const { rerender } = render({ channels });
    await Promise.resolve();
    expect(api.syncMemory).not.toHaveBeenCalled();

    // The user flips it ON.
    setPreference(true);
    rerender({
      api,
      channels,
      deviceInfo: connected,
      preferencesLoaded: true,
      updateSync,
      setChannels,
    });

    // Give any effect re-run a chance to fire before asserting a negative.
    await Promise.resolve();
    expect(api.syncMemory).not.toHaveBeenCalled();
  });

  /**
   * The other half, and not optional: the fix must not be "delete the dep and
   * let the preference stop working". A value that arrives after connect --
   * which is the normal order, since `preferencesLoaded` starts false -- has to
   * be acted on.
   *
   * Without this, a build that never reads the preference at all passes the
   * guard above.
   */
  it('a preference that loads after connect still takes effect', async () => {
    setPreference(false);
    // The store's channel list is EMPTY here on purpose: at startup the mount
    // fetch races the poll loop's connect, so the OFF path has to ask the
    // backend rather than trust the store. That is the whole reason the
    // `api.getChannels()` branch exists.
    const onBackend = [createTestChannel({ index: 1 })];
    api.getChannels.mockResolvedValue(onBackend);

    // Connected, but preferences have not settled: nothing may happen yet.
    const { rerender } = render({ channels: [], preferencesLoaded: false });
    await Promise.resolve();
    expect(api.syncMemory).not.toHaveBeenCalled();
    expect(api.getChannels).not.toHaveBeenCalled();

    // The fetch settles. The stored OFF value must now be honoured: ask the
    // backend, adopt what it has, and do NOT sync.
    rerender({
      api,
      channels: [],
      deviceInfo: connected,
      preferencesLoaded: true,
      updateSync,
      setChannels,
    });

    await waitFor(() => expect(api.getChannels).toHaveBeenCalled());
    expect(setChannels).toHaveBeenCalledWith(onBackend);
    expect(api.syncMemory).not.toHaveBeenCalled();
  });

  /**
   * And the ON path still syncs at a connect. Asserting only the two negatives
   * above would pass for a hook that never syncs at all, which is the failure
   * this whole effect exists to prevent.
   */
  it('a connect with the preference ON syncs', async () => {
    setPreference(true);
    render({ channels: [createTestChannel({ index: 1 })] });

    await waitFor(() => expect(api.syncMemory).toHaveBeenCalled());
    expect(updateSync).toHaveBeenCalledWith(
      expect.objectContaining({ inProgress: true, taskId: 'sync-1' }),
    );
  });

  /** A disconnected scanner is never synced, whatever the preference says. */
  it('does nothing while the scanner is not connected', async () => {
    render({ deviceInfo: createTestDeviceInfo({ connection_status: 'disconnected' }) });

    await Promise.resolve();
    expect(api.syncMemory).not.toHaveBeenCalled();
    expect(api.getChannels).not.toHaveBeenCalled();
  });

  /**
   * THE #564 BUG: a radio's first connection synced TWICE.
   *
   * Observed on hardware 2026-08-30, tracing a BC75XLT's first-ever connect:
   *
   * ```text
   * 22:14:34  in_progress:true   task_id:sync-41030358  channels=0
   * 22:14:37  in_progress:true   task_id:sync-19179e20  channels=300
   * 22:14:40  in_progress:false  task_id:null           channels=300
   * ```
   *
   * `channels.length` is in the deps -- and has to be, so the effect
   * re-evaluates when the mount fetch lands. With the preference ON there is no
   * early return, so the sequence was: sync, channels fill, length changes,
   * effect re-runs, sync again. Self-limiting at exactly two, because the
   * second sync does not change the length.
   *
   * Cold cache only: with a warm one the list is already populated and its
   * length does not change across the sync.
   *
   * Wasteful rather than harmful -- about 5 extra seconds of the radio deaf in
   * program mode on a first connection -- but the fix is a real one: the effect
   * has to know a sync already ran FOR THIS CONNECTION, not merely that the
   * channel list is empty.
   */
  it('a first connection syncs once, not twice', async () => {
    setPreference(true);
    // Cold cache: nothing in the store yet.
    const { rerender } = render({ channels: [] });
    await waitFor(() => expect(api.syncMemory).toHaveBeenCalledTimes(1));

    // The sync completes and fills the list. `channels.length` changes, so the
    // effect re-runs -- which is exactly what the deps array is for, and
    // exactly what used to fire the second sync.
    const filled = [createTestChannel({ index: 1 }), createTestChannel({ index: 2 })];
    rerender({
      api,
      channels: filled,
      deviceInfo: connected,
      preferencesLoaded: true,
      updateSync,
      setChannels,
    });
    await Promise.resolve();

    expect(api.syncMemory).toHaveBeenCalledTimes(1);
  });

  /**
   * The other half, and not optional: whatever remembers "already synced" has
   * to forget on disconnect, or the next radio never syncs at all.
   *
   * Asserting only the test above passes for a hook that syncs once per PROCESS
   * -- which would be a far worse bug than the one being fixed, and invisible
   * until someone swapped scanners.
   */
  it('a reconnect syncs again', async () => {
    setPreference(true);
    const { rerender } = render({ channels: [] });
    await waitFor(() => expect(api.syncMemory).toHaveBeenCalledTimes(1));

    const props = (
      deviceInfo: ReturnType<typeof createTestDeviceInfo>,
      channels: ChannelData[],
    ) => ({ api, channels, deviceInfo, preferencesLoaded: true, updateSync, setChannels });

    // The radio goes away.
    rerender(props(createTestDeviceInfo({ connection_status: 'disconnected' }), []));
    await Promise.resolve();

    // And comes back.
    rerender(props(createTestDeviceInfo({ connection_status: 'connected' }), []));

    await waitFor(() => expect(api.syncMemory).toHaveBeenCalledTimes(2));
  });
});
