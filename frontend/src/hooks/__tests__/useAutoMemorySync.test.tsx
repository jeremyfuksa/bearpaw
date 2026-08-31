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
});
