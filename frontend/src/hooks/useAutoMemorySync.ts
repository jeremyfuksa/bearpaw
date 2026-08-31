import { useEffect } from 'react';
import { useStore, type SyncState } from '../store/useStore';
import type { ChannelData, DeviceInfo } from '../types';

/**
 * Only what this hook calls, structurally -- not the whole `ScannerAPIClient`.
 * A test supplies two functions instead of a client, and a signature change on
 * either still fails type-check here.
 */
interface AutoMemorySyncApi {
  getChannels: () => Promise<ChannelData[]>;
  syncMemory: () => Promise<{ status?: string; task_id?: string }>;
}

interface AutoMemorySyncParams {
  api: AutoMemorySyncApi;
  channels: ChannelData[];
  deviceInfo: DeviceInfo | null;
  preferencesLoaded: boolean;
  updateSync: (patch: Partial<SyncState>) => void;
  setChannels: (channels: ChannelData[] | ((prev: ChannelData[]) => ChannelData[])) => void;
}

/**
 * Start a memory sync when a scanner connects, unless the cache already
 * answers for it.
 *
 * Lifted out of `App.tsx` (#568) so the decision can be exercised by MOUNTING
 * it rather than by regexing App's source. The source-level guards this effect
 * carries are precise about shape and blind to timing, and the bug they missed
 * was purely a timing one: a preference the user toggled mid-session re-ran the
 * effect and drove the radio. Mounting `App` itself would need stubs for the
 * WebSocket context, the Tauri shell, the store, the menu bus, the API client,
 * the toast plugin, six views and ten hooks -- and would break whenever App
 * grew an eleventh. A hook needs the store.
 *
 * REGRESSION GUARD (#413): `channels.length > 0` is the ONLY thing that stops a
 * startup sync when the backend already has channel memory. Since #540 the
 * backend adopts a cached channel map at connect, so on a normal launch the
 * fetch returns a full list and this must decline to sync -- that decline IS
 * the feature. Dropping that line, or dropping `channels.length` from the deps
 * array, silently restores the blocking startup overlay for every user with a
 * warm cache, with no visible error.
 *
 * (Corrected while moving, per #576: the connect-edge `device_info` broadcast
 * DOES fire. #551 moved `connection_status = "connected"` out of the port-open
 * path precisely so `transitioned_to_connected` becomes true, and #552 built
 * App's connect-edge channel refetch on it. The comment here used to claim the
 * opposite, citing #539 -- acting on that would have read the refetch as dead
 * code and removed it.)
 *
 * REGRESSION GUARD (#568): the preference is read at INVOCATION TIME via
 * `useStore.getState()` and is deliberately NOT in the deps array.
 *
 * `reread_memory_on_connect` governs what happens when a scanner CONNECTS.
 * With it as dependency #6, flipping the switch in Device -> Application
 * Preferences re-ran this effect immediately: `handlePreferenceChange` updates
 * the store optimistically and synchronously, the early return no longer
 * applied, and `api.syncMemory()` went out. The full-screen "Syncing Scanner
 * Memory" overlay covered the settings page the user was standing on, and the
 * radio was held in program mode for the whole walk. Only the ON direction
 * misfired; the OFF direction was caught by the early return.
 *
 * The guard that was supposed to cover this asserted only that the deps array
 * CONTAINED the string, which a build with this exact bug satisfies perfectly --
 * and its comment argued for the dep in the wrong direction ("the setting would
 * appear to do nothing until the next connect"), which is the behaviour we
 * actually want. A setting about connect-time behaviour taking effect at the
 * next connect is correct.
 *
 * `preferencesLoaded` stays in the deps and is what makes the stored value
 * reach a launch that is already connected: it flips once the fetch settles,
 * this re-runs, and `getState()` reads the value that just arrived.
 */
export function useAutoMemorySync({
  api,
  channels,
  deviceInfo,
  preferencesLoaded,
  updateSync,
  setChannels,
}: AutoMemorySyncParams): void {
  useEffect(() => {
    if (!deviceInfo || deviceInfo.connection_status !== 'connected') return;
    if (useStore.getState().sync.inProgress) return;
    // Wait for the stored preferences before deciding. The store holds
    // DEFAULTS until the fetch settles, and `rereadMemoryOnConnect` defaults
    // true -- so without this the effect reads `true` on every launch and syncs
    // regardless of what the user stored. Turning the preference off did
    // nothing, which is how it shipped and how hardware verification caught it:
    // the backend reported `reread_memory_on_connect: false` and the launch
    // synced anyway.
    //
    // Exactly the hazard `check_updates_on_launch` already guards at the
    // `preferencesLoaded ? ... : undefined` call site, whose comment says the
    // startup check "waits for preferences to load rather than acting on a
    // default that may be about to change". I copied that preference in every
    // respect except this one.
    //
    // `preferencesLoaded` settles in a `finally`, so a failed fetch still
    // releases the gate and the effect proceeds on defaults -- the same answer
    // a fresh install gets.
    if (!preferencesLoaded) return;
    // Read at invocation, NOT as a dependency -- see the #568 guard above.
    const preferences = useStore.getState().preferences;
    // Conditional since the `reread_memory_on_connect` preference: ON means
    // re-read the radio at every launch even when the cache is warm, which is
    // the pre-#413 behaviour and the default. See the guards below -- both
    // sides of this condition are pinned, because loosening the assertion to
    // "mentions channels.length" would leave neither path guarded.
    if (!preferences.rereadMemoryOnConnect && channels.length > 0) return;

    let active = true;
    const startMemorySync = async () => {
      try {
        // Ask the BACKEND how much channel memory it has, rather than trusting
        // the store. `channels` here is whatever the last render saw, and
        // during startup that is usually [] -- the mount fetch races the poll
        // loop's connect, and the connect-edge refetch (#552) has not resolved
        // by the time this effect re-runs on the same device_info message.
        //
        // Without this the preference cannot work at all: the guard above is
        // `!rereadMemoryOnConnect && channels.length > 0`, which with an empty
        // store is `true && false` -- no early return, sync anyway. Measured on
        // hardware: with the preference stored OFF, every launch still synced.
        //
        // One extra GET, only on the path that was about to spend ~5 s on the
        // wire, and it removes the ordering assumption entirely rather than
        // making it more likely to hold.
        if (!preferences.rereadMemoryOnConnect) {
          const current = await api.getChannels();
          if (!active) return;
          if (current.length > 0) {
            setChannels(current);
            return;
          }
        }
        updateSync({ message: 'Loading channels from device...' });
        const result = await api.syncMemory();
        if (!active) return;
        if (result.status === 'started' || result.status === 'already_running') {
          updateSync({ inProgress: true, taskId: result.task_id || null });
        }
      } catch (error) {
        if (active) {
          console.warn('Failed to start memory sync', error);
        }
      }
    };
    startMemorySync();
    return () => {
      active = false;
    };
  }, [api, channels.length, deviceInfo, updateSync, setChannels, preferencesLoaded]);
}
