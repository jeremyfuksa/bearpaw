import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { SyncSpinner } from './components/SyncSpinner';
import { ImportProgressOverlay } from './components/ImportProgressOverlay';
import { StatusBar, type LockoutKind } from './components/ScannerUI';
import { ScanAnnouncer } from './components/ScanAnnouncer';
import { getAPI, API_BASE } from '../api/useApi';
import { useStore, mapStoredPreferences } from '../store/useStore';
import { useWebSocket } from '../websocket/useWebSocket';
import { useActivityLogHydrate } from '../hooks/useActivityLogHydrate';
import { useAutoMemorySync } from '../hooks/useAutoMemorySync';
import { useBankRefresh } from '../hooks/useBankRefresh';
import { useActivityLogTracker } from '../hooks/useActivityLogTracker';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { useDashboardAnalytics } from '../hooks/useDashboardAnalytics';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useMenuEvents } from '../hooks/useMenuEvents';
import { useShellStatusText } from '../hooks/useShellStatusText';
import { useUpdateCheck } from '../hooks/useUpdateCheck';
import { openExternalUrl } from '../tauri-shell';
import type { BanksUpdateMessage, LiveState, ProgressMessage, StateUpdateMessage } from '../types';
import { DeviceTab } from './components/views/DeviceTab';
import { ChannelsTab } from './components/views/ChannelsTab';
import { ScanView } from './components/views/ScanView';
import { useScannerCapabilities } from '../hooks/useScannerCapabilities';
import { DataDiagnosticBanner } from './components/DataDiagnosticBanner';
import { TabBar } from './components/TabBar';
import { ActivityExportSheet } from './components/views/ActivityExportSheet';

export type Tab = 'Scan' | 'Device' | 'Channels';
export type ScannerMode = 'SCAN' | 'HOLD' | 'SEARCH' | 'CLOSE_CALL';

/**
 * Format the live tone for the Scan display's subText, or null if there is
 * no tone to show. CTCSS prints the Hz value; DCS uses the backend-formatted
 * label (the DCS wire code is not the human DCS number — the backend owns
 * that mapping); Tone Search gets a fixed label. Called only while the
 * squelch is open (see the subText memo).
 */
export function formatLiveTone(live: LiveState): string | null {
  switch (live.tone_squelch_kind) {
    case 'ctcss':
      return live.tone_squelch != null ? `CTCSS ${live.tone_squelch.toFixed(1)}` : null;
    case 'dcs':
      return live.tone_dcs_label ?? null;
    case 'search':
      return 'Tone Search';
    default:
      return null;
  }
}

/**
 * Compose the Scan display's sub-line for a hit (or a held channel).
 *
 * The frequency appears here ONLY when an alpha tag is carrying the headline.
 * With no tag the headline falls back to the frequency itself, so repeating it
 * below reads as a stutter: "146.700 / 146.700 • NFM". That is every hit on a
 * BC75XLT, which has no alpha tags at all — but it is deliberately NOT a
 * `has_alpha_tags` branch, because an untagged channel on a BC125AT produces
 * the identical stutter. The rule is "never repeat the headline", which covers
 * both without the display needing to know which scanner is attached.
 *
 * Exported for its test: asserting the real function is the point (see
 * CLAUDE.md "Third-rail flows" on guards that hand-rebuilt the shape they
 * meant to check and passed while the bug was live).
 */
export function buildHitSubText(live: LiveState): string {
  const parts: string[] = [];
  if (live.frequency && live.alpha_tag) parts.push(live.frequency.toFixed(3));
  if (live.modulation) parts.push(live.modulation);
  if (live.channel !== undefined && live.channel !== null) {
    parts.push(`CH ${live.channel}`);
  }
  if (live.squelch_open) {
    const tone = formatLiveTone(live);
    if (tone) parts.push(tone);
  }
  return parts.join(' • ');
}

export default function App() {
  useKeyboardShortcuts({
    openActivityLog: () => setIsExportSheetOpen(true),
    openMemoryBrowser: () => setCurrentTab('Channels'),
    closeOverlays: () => {
      setIsExportSheetOpen(false);
    },
    openShortcuts: () => {
      toast.info(
        'Keyboard Shortcuts:\nCtrl+S: Scan | Ctrl+H: Hold\nCtrl+L: Activity Log | Ctrl+M: Memory\nCtrl+C: Copy Freq | Ctrl+↑/↓: Navigate\nEsc: Close overlays | Ctrl+/: Show shortcuts',
        {
          duration: 5000,
        },
      );
    },
  });
  const api = getAPI();
  const { ws, connected } = useWebSocket();
  useActivityLogHydrate();
  useActivityLogTracker();

  const liveState = useStore((state) => state.liveState);
  const deviceInfo = useStore((state) => state.deviceInfo);
  // Falls back to the BC125AT-family defaults until device_info arrives, so
  // the status bar does not flash a differently-shaped stat row on connect.
  const capabilities = useScannerCapabilities();
  const channels = useStore((state) => state.channels);
  const fullActivityLog = useStore((state) => state.fullActivityLog);
  const preferences = useStore((state) => state.preferences);
  // Whether the preferences fetch has settled (either way). The store holds
  // defaults until then, so this is what distinguishes "checkUpdatesOnLaunch
  // is true by default" from "the user stored true" — see the #273 gate below.
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const updateLiveState = useStore((state) => state.updateLiveState);
  const setDeviceInfo = useStore((state) => state.setDeviceInfo);
  const setChannels = useStore((state) => state.setChannels);
  const updatePreferences = useStore((state) => state.updatePreferences);
  const banks = useStore((state) => state.banks);
  const setBanks = useStore((state) => state.setBanks);
  const sync = useStore((state) => state.sync);
  const updateSync = useStore((state) => state.updateSync);
  const importProgress = useStore((state) => state.importProgress);
  const setImportProgress = useStore((state) => state.setImportProgress);
  const isMemorySyncing = sync.inProgress;
  const syncProgressMessage = sync.message;

  const [currentTab, setCurrentTab] = useState<Tab>(() => {
    // Query param `?tab=scan|device|channels` → initial tab. Lets deep
    // links (and Figma/Playwright captures) target a specific tab
    // without clicking the menu. Using the query string instead of the
    // hash keeps the hash reserved for unrelated tooling (e.g. the
    // Figma html-to-design capture script).
    if (typeof window === 'undefined') return 'Scan';
    const tab = new URLSearchParams(window.location.search).get('tab')?.toLowerCase();
    if (tab === 'device') return 'Device';
    if (tab === 'channels') return 'Channels';
    return 'Scan';
  });
  const [toggleBusy, setToggleBusy] = useState(false);
  // Starts true so the one-shot mount animation is on for the very first paint;
  // the timer below turns it off after 700ms. Previously this initialized false
  // and an effect flipped it true on mount, which rendered one un-animated
  // frame first (react-hooks/set-state-in-effect).
  const [chartAnimate, setChartAnimate] = useState(true);
  const [isExportSheetOpen, setIsExportSheetOpen] = useState(false);
  const [isInProgramMode, setIsInProgramMode] = useState(false);
  const shellStatusText = useShellStatusText();

  // Derived from the store rather than tracked locally: a frame is "fresh"
  // when we've received any live state and the backend isn't marking it
  // stale. Previously this was a local `useState` that mirrored
  // `liveState.stale`, but the two sources could disagree during reconnect
  // windows and freeze the display on "Scanning..." (issue #74).
  const hasFreshLiveFrame = liveState !== null && liveState.stale !== true;

  const programModeEntryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const scanResumeInFlightRef = useRef(false);
  const scanResumeTimerRef = useRef<number | null>(null);
  // Focus management for the blocking sync overlay (a11y S2).
  const cancelSyncButtonRef = useRef<HTMLButtonElement | null>(null);
  const overlayReturnFocusRef = useRef<HTMLElement | null>(null);
  // Bank-toggle debounce. Each click updates `bankDesiredRef` to the latest
  // desired mask and resets a 300ms timer; the flush only fires after the
  // user stops clicking. Without this, rapid toggling hits the scanner with
  // one PRG/SCG/EPG cycle per click, which visibly thrashes the LCD between
  // "Remote Mode" and scan. `bankFlushInFlightRef` keeps writes serial so
  // two POSTs never race for PRG mode.
  const bankDesiredRef = useRef<boolean[] | null>(null);
  const bankFlushTimerRef = useRef<number | null>(null);
  const bankFlushInFlightRef = useRef(false);
  // Captured mode at the start of a bank-toggle burst. PRG/EPG leaves the
  // scanner in HOLD on this firmware, so if the user was scanning when they
  // first clicked, the post-flush resume puts them back in SCAN. Null
  // between bursts so we don't keep stomping HOLD.
  const bankPreToggleModeRef = useRef<string | null>(null);

  const requestScanResume = useCallback(
    (reason: string, options: { delayMs?: number; toastOnError?: boolean } = {}) => {
      const delayMs = options.delayMs ?? 0;
      const toastOnError = options.toastOnError ?? false;
      if (!connected) return;

      const runResume = async () => {
        if (scanResumeInFlightRef.current) return;
        scanResumeInFlightRef.current = true;
        try {
          await api.sendScan();
        } catch (error) {
          console.warn(`Failed to resume scan (${reason})`, error);
          if (toastOnError) {
            toast.error('Failed to resume scan');
          }
        } finally {
          scanResumeTimerRef.current = window.setTimeout(() => {
            scanResumeInFlightRef.current = false;
            scanResumeTimerRef.current = null;
          }, 250);
        }
      };

      if (delayMs > 0) {
        if (scanResumeTimerRef.current !== null) {
          window.clearTimeout(scanResumeTimerRef.current);
        }
        scanResumeTimerRef.current = window.setTimeout(() => {
          void runResume();
        }, delayMs);
      } else {
        void runResume();
      }
    },
    [api, connected],
  );

  useEffect(() => {
    const loadPreferences = async () => {
      try {
        console.log('[Preferences] Loading preferences from backend...');
        const response = await fetch(`${API_BASE}/preferences`);
        console.log('[Preferences] Response status:', response.status);
        if (response.ok) {
          const prefs = await response.json();
          console.log('[Preferences] Loaded from backend:', prefs);
          const frontendPrefs = mapStoredPreferences(prefs);
          console.log('[Preferences] Setting in store:', frontendPrefs);
          updatePreferences(frontendPrefs);
          console.log(
            '[Preferences] Current store preferences after set:',
            useStore.getState().preferences,
          );
        }
      } catch (error) {
        console.warn('Failed to load preferences from backend', error);
      } finally {
        // `finally`, not the success branch: this gates the #273 startup
        // update check, and a failed load must still release that gate or
        // the check would never run for anyone whose backend was slow or
        // unreachable. On failure the store keeps its defaults, which is
        // the same answer a fresh install gets.
        setPreferencesLoaded(true);
      }
    };
    loadPreferences();
  }, [updatePreferences]);

  useEffect(() => {
    const unsubscribeState = ws.on('state_update', (message) => {
      const payload = message as StateUpdateMessage;
      updateLiveState(payload.data, payload.sequence);
    });

    const unsubscribeEvent = ws.on('event', (message) => {
      const payload = message as { event?: string };
      if (payload.event === 'state_stale') {
        updateLiveState({ stale: true });
      }
    });

    const unsubscribeDeviceInfo = ws.on('device_info', (message) => {
      const payload = message as unknown as { data?: import('../types').DeviceInfo };
      if (!payload?.data) return;
      const wasConnected = useStore.getState().deviceInfo?.connection_status === 'connected';
      setDeviceInfo(payload.data);

      // REGRESSION GUARD (#413, check 1): refetch channels when the scanner
      // becomes connected. The backend adopts cached channel memory during
      // `update_device_info_from_mdl` and broadcasts AFTER that, so by the time
      // this message arrives the channel list is already populated server-side.
      // Without the refetch the store keeps whatever the mount fetch saw --
      // usually nothing, because that fetch races the poll loop's connect --
      // and the auto-sync effect then starts a full memory sync the cache
      // exists to avoid.
      //
      // Deliberately gated on the EDGE. `broadcast_device_info` only fires on
      // edges today, but a future caller that broadcast every tick would turn
      // an unconditional refetch into a 5 Hz channel fetch.
      //
      // `useStore.getState()` rather than a closed-over value, and no new deps:
      // this effect owns four WS subscriptions and re-registering it on store
      // changes is the #144/#102-adjacent churn its guard exists to prevent.
      if (payload.data.connection_status === 'connected' && !wasConnected) {
        api
          .getChannels()
          .then((channelData) => setChannels(channelData))
          .catch((error) => console.warn('Failed to refresh channels on connect', error));

        // REGRESSION GUARD (#572): refetch the SYNC STATUS here too, for the
        // same reason and on the same edge.
        //
        // `synced_at` only becomes knowable once `load_channel_cache` has set
        // `shadow.last_sync`, which happens inside
        // `update_device_info_from_mdl` -- i.e. just before this broadcast.
        // The frontend otherwise learns it in only two places: the WS-connect
        // probe and sync completion. On a Tauri cold launch the WS connects in
        // milliseconds while the poll loop is still opening the port, so the
        // probe answers null; and with `reread_memory_on_connect` OFF no sync
        // ever runs, so it stayed null for the entire session.
        //
        // The cost was the whole point of #413 going missing on its own happy
        // path: the Scan bar showed no age, and the Channels tab's age +
        // Refresh block is gated on that label, so it did not render at all.
        // It appeared only if the user switched tabs (`currentTab` is in the
        // probe effect's deps) and never for a `?tab=channels` deep link.
        api
          .getSyncStatus()
          .then((status) => updateSync({ syncedAt: status.synced_at ?? null }))
          .catch((error) => console.warn('Failed to refresh sync status on connect', error));
      }
    });

    const unsubscribeProgress = ws.on('progress', (message) => {
      const payload = message as ProgressMessage;

      // Import progress (task_id "import-csv"/"import-ss") drives the SEPARATE
      // importProgress overlay state and must NEVER fall through to the
      // regression-guarded memory-sync logic below. The overlay's `active`
      // flag is set/cleared by handleImport (start/finally); here we only feed
      // it live percent + message. The early return is load-bearing.
      if (payload.task_id?.startsWith('import')) {
        const patch: { percent?: number; message?: string } = {};
        if (typeof payload.percent === 'number' && Number.isFinite(payload.percent)) {
          patch.percent = Math.max(0, Math.min(100, payload.percent));
        }
        if (payload.message) patch.message = payload.message;
        setImportProgress(patch);
        return;
      }

      // ONLY trust the explicit completion text. The backend sends
      // `progress(100, "Exiting program mode...")` BEFORE finish() clears
      // sync_task_id, then `progress(100, "Sync complete")` after.
      // Trusting percent>=100 fires the completion handler too early —
      // post-sync getBanks/etc race into the still-set sync_task_id and
      // get 409. memory_sync.rs guarantees the text patterns only appear
      // after finish() has actually run.
      const isComplete =
        /sync complete/i.test(payload.message) || /sync cancelled/i.test(payload.message);

      if (payload.message) {
        updateSync({ message: payload.message });
      }
      if (typeof payload.percent === 'number' && Number.isFinite(payload.percent)) {
        updateSync({ percent: Math.max(0, Math.min(100, payload.percent)) });
      }

      const currentSync = useStore.getState().sync;

      // Detect sync in progress or just completed
      if (!currentSync.inProgress && !isComplete && payload.message.includes('Syncing channel')) {
        updateSync({ inProgress: true, taskId: payload.task_id || null });
      }

      if (isComplete && currentSync.inProgress) {
        updateSync({
          inProgress: false,
          hasSyncedInitially: true,
          taskId: null,
          message: 'Loading channels from device...',
          percent: 0,
        });

        // Double-check PGM mode after a delay to account for mode transitions.
        // Read liveState via getState() — see REGRESSION GUARD below.
        programModeEntryTimeoutRef.current = setTimeout(() => {
          const currentLiveState = useStore.getState().liveState;
          const normalizedMode = (currentLiveState?.mode ?? '').toString().trim().toUpperCase();
          setIsInProgramMode(normalizedMode === 'PGM');
        }, 500);

        // The sync just moved `synced_at` forward; re-read it rather than
        // stamping the client clock, so the status bar agrees with the value
        // the cache actually persisted.
        api
          .getSyncStatus()
          .then((status) => updateSync({ syncedAt: status.synced_at ?? null }))
          .catch(() => {
            /* a missing timestamp only blanks the label; never surface it */
          });

        api
          .getChannels()
          .then((channelData) => setChannels(channelData))
          .then(() => {
            // Schedule scan-resume FIRST (it's a setTimeout, fires at
            // T+1500 regardless of what else is happening). Then kick
            // off bank refresh in the background — if that fails, it
            // must NOT block scan-resume from firing.
            if (currentTab === 'Scan') {
              // 1500ms delay covers worst-case post-sync mode-transition
              // settle plus any concurrent PRG cycles. KEY,S,P with
              // default delayMs:0 fires before the scanner is receptive
              // and the scan never resumes.
              requestScanResume('sync completion', {
                delayMs: 1500,
                toastOnError: true,
              });
            }
            // REGRESSION GUARD (#584): NO bank read here. The bank-refetch
            // effect below already re-runs when `sync.inProgress` flips false,
            // which is exactly "the sync is done, re-ask the scanner".
            //
            // Both firing meant two program-mode brackets back to back at the
            // end of every sync -- and `get_banks` is a whole bracket, not one
            // command: `PRG`, a 100 ms settle, `SCG`, then `EPG` on guard drop.
            // Serialized behind the 5 Hz poll loop with a 3-second budget each,
            // the second queued behind the first and blew its deadline. Over a
            // ~17 hour hardware run that was 37 "Failed to refresh banks after
            // sync" warnings and 18 backend `command_timeout`s -- the warning
            // appearing TWICE per sync was the tell.
            //
            // This one was the redundant half: its own comment called the
            // effect "a second chance", which had it backwards. The effect is
            // the primary.
          })
          .catch((error) =>
            console.warn('[Progress] Failed to refresh channels after sync', error),
          );
      }
    });

    // banks_update (#149): backend-initiated bank changes (memory sync,
    // second client) previously never reached the UI — the broadcast had no
    // subscriber.
    const unsubscribeBanks = ws.on('banks_update', (message) => {
      const payload = message as BanksUpdateMessage;
      const nextBanks = payload.data?.banks;
      if (Array.isArray(nextBanks) && nextBanks.length === 10) {
        setBanks(nextBanks);
      }
    });

    return () => {
      unsubscribeState();
      unsubscribeEvent();
      unsubscribeDeviceInfo();
      unsubscribeProgress();
      unsubscribeBanks();
      // NOTE (#144): do NOT clear scanResumeTimerRef / programModeEntry
      // timers here. This effect re-runs on currentTab/connected changes;
      // clearing app-lifetime timers in its cleanup cancelled pending
      // scan-resumes on every tab switch and could strand
      // scanResumeInFlightRef=true (killing every later resume for the
      // session). Those timers are cleaned up in the unmount-only effect
      // below.
    };
    // REGRESSION GUARD: App.regression.test.tsx :: WS subscription is stable
    // across liveState updates.
    // DO NOT add `liveState`, `liveState?.mode`, or any other high-frequency
    // store-derived value to these deps. The poll loop pushes state_update
    // messages at 5 Hz; if those values are in the deps array this effect
    // tears down and re-registers all four WS subscriptions on every tick,
    // cancelling in-flight scan-resume timers and producing the visible
    // "scanning churn / random unresponsiveness" regression. If a handler
    // needs the latest mode, read it via `useStore.getState().liveState?.mode`
    // at handler-invocation time, not from the closed-over value.
  }, [
    api,
    currentTab,
    requestScanResume,
    setBanks,
    setChannels,
    setDeviceInfo,
    updateLiveState,
    updateSync,
    setImportProgress,
    ws,
  ]);

  useEffect(() => {
    if (!connected) {
      // Mark the store stale on disconnect so the derived `hasFreshLiveFrame`
      // becomes false without the local-mirror bug from #74.
      updateLiveState({ stale: true });
    }
  }, [connected, updateLiveState]);

  const hasConnectedOnceRef = useRef(false);
  useEffect(() => {
    // #137: reconcile sync state against the backend when the WS (re)connects.
    // If the final "Sync complete"/"Sync cancelled" progress message was
    // broadcast while the socket was down, our `inProgress` flag is stale and
    // the blocking overlay would stay up forever — there is no other signal
    // that clears it. Conversely, if the backend is mid-sync and we don't know
    // (page reloaded during a sync, or a second client started one), adopt it
    // so the overlay guards the open PRG bracket.
    if (!connected) return;
    const isReconnect = hasConnectedOnceRef.current;
    hasConnectedOnceRef.current = true;
    let active = true;
    api
      .getSyncStatus()
      .then((status) => {
        if (!active) return;
        // Record how old the channel memory is, on every connect. This is the
        // one place the frontend learns it: channel memory persists across
        // restarts (#413), so a session that adopted a cache has a real
        // `synced_at` and no sync of its own. Set unconditionally, before the
        // branching below, so it lands whichever branch runs.
        updateSync({ syncedAt: status.synced_at ?? null });
        const currentSync = useStore.getState().sync;
        if (!currentSync.inProgress && status.in_progress) {
          updateSync({
            inProgress: true,
            taskId: status.task_id,
            message: 'Syncing scanner memory...',
          });
          return;
        }
        // REGRESSION GUARD: App.regression.test.tsx :: sync-status reconnect
        // probe only clears state on reconnects. On the initial connect this
        // probe races the auto-start-sync effect: the status snapshot can be
        // served before POST /memory/sync registers the task, and acting on
        // it would drop the overlay over a live PRG bracket — the exact
        // hazard #137 exists to prevent.
        if (isReconnect && currentSync.inProgress && !status.in_progress) {
          updateSync({
            inProgress: false,
            hasSyncedInitially: true,
            percent: 100,
            message: 'Sync complete',
          });
          api
            .getChannels()
            .then((channelData) => {
              if (active) setChannels(channelData);
            })
            .catch((error) =>
              console.warn('[SyncStatus] Failed to refresh channels after reconnect', error),
            );
          if (currentTab === 'Scan') {
            // Same settle delay as the WS completion path: the sync's EPG has
            // long since run, but the scanner may still be mode-transitioning
            // if completion was recent.
            requestScanResume('sync status reconciliation', { delayMs: 1500 });
          }
        }
      })
      .catch((error) => {
        // Best-effort probe; a failed status check just leaves state as-is.
        console.warn('[SyncStatus] status probe failed', error);
      });
    return () => {
      active = false;
    };
  }, [api, connected, currentTab, requestScanResume, setChannels, updateSync]);

  useEffect(() => {
    let active = true;
    const loadInitialData = async () => {
      try {
        // Deliberately NO getBanks() here (#393). This runs on mount, before
        // the backend has finished probing and opening the serial port, so the
        // SCG sits unserviced past its 3s deadline and the poll loop discards
        // it as expired -- two logged failures on every single launch, and a
        // wasted ProgramModeGuard attempt against a scanner that cannot answer
        // yet. Reading banks is owned by the connection-gated effect below,
        // which fires the moment `connection_status` turns "connected" and is
        // the only place that can succeed.
        const [statusResult, infoResult, channelsResult] = await Promise.allSettled([
          api.getStatus(),
          api.getDeviceInfo(),
          api.getChannels(),
        ]);
        if (!active) return;

        if (statusResult.status === 'fulfilled' && useStore.getState().lastSequence === 0) {
          // Mount-time REST snapshot carries no sequence number (#144): if a
          // WS state_update already arrived, applying this older snapshot
          // would overwrite newer state until the next poll tick. Only seed
          // from REST while the sequence gate is still untouched.
          updateLiveState(statusResult.value);
        }

        if (infoResult.status === 'fulfilled') {
          setDeviceInfo(infoResult.value);
        }

        if (channelsResult.status === 'fulfilled') {
          setChannels(channelsResult.value);
        }
      } catch (error) {
        if (!active) return;
        console.warn('Failed to load initial scanner data', error);
      }
    };
    loadInitialData();
    return () => {
      active = false;
    };
    // setChannels/setDeviceInfo are Zustand store actions — stable by
    // identity — so declaring them is honest about what the effect reads
    // without changing when it re-runs. `setBanks` is deliberately absent:
    // this effect no longer reads banks (#393).
  }, [api, setChannels, setDeviceInfo, updateLiveState]);

  // Bank refresh lives in `useBankRefresh` (#596). It was lifted out of this
  // file so the "how often does this run?" question can be answered by
  // mounting it -- the deps-array guard it used to carry was happy while the
  // effect fired twice per connect.
  useBankRefresh({
    api,
    connectionStatus: deviceInfo?.connection_status,
    syncInProgress: sync.inProgress,
    // #606: `inProgress` alone leaves a window at the connect edge, where a
    // startup sync has been decided on but its POST has not returned. The bank
    // read used to fire into it and time out behind the sync.
    syncPending: sync.pending,
    setBanks,
  });

  // The auto-sync decision lives in `useAutoMemorySync` (#568). It was lifted
  // out of this file so it can be exercised by MOUNTING it: the guards it
  // carries are source-level, precise about shape and blind to timing, and the
  // bug they missed was a timing one -- a preference toggled mid-session
  // re-ran the effect and drove the radio.
  useAutoMemorySync({
    api,
    channels,
    deviceInfo,
    preferencesLoaded,
    updateSync,
    setChannels,
  });

  useEffect(() => {
    // One-shot animation pass on mount so the bar chart slides in once.
    // After 700ms Recharts switches to its no-anim render path, which
    // matches the prior behaviour when entering dashboard view. The "on"
    // half is the useState initializer above; this effect only ends it.
    const timeout = window.setTimeout(() => setChartAnimate(false), 700);
    return () => window.clearTimeout(timeout);
  }, []);

  useEffect(() => {
    // Unmount-only cleanup for app-lifetime timers (#144). These used to be
    // cleared in the WS-subscribe effect's cleanup, which re-runs on
    // currentTab/connected changes — cancelling pending scan-resumes on
    // every tab switch and potentially stranding scanResumeInFlightRef=true
    // (silently no-oping every later resume for the session).
    return () => {
      if (programModeEntryTimeoutRef.current) {
        clearTimeout(programModeEntryTimeoutRef.current);
      }
      if (scanResumeTimerRef.current !== null) {
        window.clearTimeout(scanResumeTimerRef.current);
        scanResumeTimerRef.current = null;
      }
      scanResumeInFlightRef.current = false;
      if (bankFlushTimerRef.current !== null) {
        window.clearTimeout(bankFlushTimerRef.current);
        bankFlushTimerRef.current = null;
      }
    };
  }, []);

  const handleCancelSync = useCallback(async () => {
    // REGRESSION GUARD: App.regression.test.tsx :: cancel sync runs the
    // post-sync chain. Do NOT synchronously flip `inProgress: false` when the
    // backend acknowledges with "cancelling". The WS "Sync cancelled" progress
    // message arrives shortly after the cancel API returns, and the progress
    // handler is what runs the post-sync chain (refresh channels, resume
    // scan). If we pre-flip `inProgress: false`, the handler sees
    // `currentSync.inProgress === false` and skips that chain — leaving the
    // scanner in HOLD with stale channel state.
    //
    // The ONE exception is a "no_task" reply (#137): the backend has no
    // running sync, so no WS message will ever arrive to clear our state and
    // the blocking overlay would stay up forever. There's no PRG bracket open
    // and no post-sync chain to run — just clear the local flag.
    try {
      const taskId = useStore.getState().sync.taskId || undefined;
      updateSync({ message: 'Cancelling sync...' });
      const result = await api.cancelSync(taskId);
      if (result.status === 'no_task') {
        updateSync({ inProgress: false, taskId: null, message: 'No sync in progress' });
        return;
      }
      toast.info('Sync cancelled');
    } catch (error) {
      console.warn('Failed to cancel sync', error);
      toast.error('Unable to cancel sync');
    }
  }, [api, updateSync]);

  useEffect(() => {
    // One-shot fetch on mount as fallback in case the client connects
    // before the first device_info broadcast arrives over the WebSocket.
    let active = true;
    api
      .getDeviceInfo()
      .then((info) => {
        if (active) setDeviceInfo(info);
      })
      .catch((error) => {
        if (active) console.warn('Failed to load initial device info', error);
      });
    return () => {
      active = false;
    };
  }, [api, setDeviceInfo]);

  const {
    busiestChannels,
    sessionStats,
    hourlyHeatmap,
    heatmapStats,
    loading: dashboardLoading,
  } = useDashboardAnalytics(currentTab === 'Scan');

  useEffect(() => {
    // Don't track mode changes during sync completion to avoid race conditions
    if (isMemorySyncing) return;

    const normalizedMode = (liveState?.mode ?? '').toString().trim().toUpperCase();
    const isProgramModeNow = normalizedMode === 'PGM';

    if (isProgramModeNow !== isInProgramMode) {
      // set-state-in-effect is suppressed, not fixed. Deriving this from
      // liveState?.mode during render would flip it true the moment a sync's
      // PRG bracket opened — precisely the race the isMemorySyncing bail above
      // exists to avoid. The value must HOLD its last state through sync, so
      // it is history, not a function of the current mode. It also has a second
      // writer (the post-sync PGM re-check around line 283), which a derived
      // value could not accommodate. The `!==` guard makes this a no-op unless
      // the mode actually changed, so it cannot cascade.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIsInProgramMode(isProgramModeNow);
    }
  }, [liveState?.mode, isInProgramMode, isMemorySyncing]);

  const connectionStatus = useConnectionStatus();

  // REGRESSION GUARD: App.regression.test.tsx :: "leaving the Device page
  // resumes scan". A write on the Device page (unlock, bank/priority edit) runs
  // inside a PRG/EPG bracket that parks the scanner in HOLD at ch1. We
  // deliberately leave it parked while the user stays on Device, then resume
  // scanning when they navigate away to Scan or Channels. Two ways to break
  // this: (1) drop the `leavingDevice` resume, or (2) wire TabBar's onTabChange
  // straight to setCurrentTab instead of this handler — then tab-bar clicks
  // (the primary navigation) skip the resume entirely and the scanner stays
  // stuck at ch1. Both are guarded.
  const handleTabChange = useCallback(
    (tab: string) => {
      const newTab = tab as Tab;
      const leavingDevice = currentTab === 'Device' && newTab !== 'Device';
      if (leavingDevice) {
        requestScanResume('leaving device page', { delayMs: 1000 });
      } else if (newTab === 'Scan' && isInProgramMode) {
        requestScanResume('exit program mode', { toastOnError: true });
      }
      setCurrentTab(newTab);
    },
    [currentTab, isInProgramMode, requestScanResume],
  );

  // Update check (#273). Startup runs it silently; the Help menu item runs
  // it again and always reports, including "up to date".
  const handleUpToDate = useCallback((current: string) => {
    toast.info(current ? `Bearpaw ${current} is up to date` : 'Could not check for updates');
  }, []);
  const {
    update: pendingUpdate,
    checking: checkingForUpdates,
    checkNow: checkForUpdatesNow,
    dismiss: dismissUpdate,
  } = useUpdateCheck(
    handleUpToDate,
    // `undefined` until preferences settle, so the startup check waits
    // rather than acting on a default that may be about to change.
    preferencesLoaded ? preferences.checkUpdatesOnLaunch : undefined,
  );

  const menuHandlers = useMemo(
    () => ({
      onNavigate: (tab: Tab) => handleTabChange(tab),
      onHold: () => {
        if (!connected) return;
        api.sendHold().catch((error) => {
          console.warn('Menu: failed to send hold', error);
          toast.error('Failed to send Hold');
        });
      },
      onScan: () => {
        if (!connected) return;
        api.sendScan().catch((error) => {
          console.warn('Menu: failed to send scan', error);
          toast.error('Failed to send Scan');
        });
      },
      onSyncMemory: () => {
        if (!connected) return;
        if (useStore.getState().sync.inProgress) {
          toast.info('Memory sync already in progress');
          return;
        }
        updateSync({ message: 'Loading channels from device...' });
        api
          .syncMemory()
          .then((result) => {
            if (result.status === 'started' || result.status === 'already_running') {
              updateSync({ inProgress: true, taskId: result.task_id || null });
            }
          })
          .catch((error) => {
            console.warn('Menu: failed to start memory sync', error);
            toast.error('Failed to start memory sync');
          });
      },
      onOpenDocs: () => {
        openExternalUrl('https://github.com/jeremyfuksa/bearpaw#readme');
      },
      onOpenIssues: () => {
        openExternalUrl('https://github.com/jeremyfuksa/bearpaw/issues');
      },
      onCheckForUpdates: () => {
        if (checkingForUpdates) return;
        checkForUpdatesNow();
      },
    }),
    [api, checkForUpdatesNow, checkingForUpdates, connected, handleTabChange, updateSync],
  );
  useMenuEvents(menuHandlers);

  // Surface a pending update (#273). Persistent (duration: Infinity) because
  // this is the only notice the user gets — the install is manual, so a
  // toast that auto-dismisses would lose the release link. Download opens
  // the GitHub release page in the default browser.
  useEffect(() => {
    if (!pendingUpdate?.available || !pendingUpdate.release_url) return;
    const releaseUrl = pendingUpdate.release_url;
    const toastId = toast.info(`Bearpaw ${pendingUpdate.latest_version} is available`, {
      description: `You're running ${pendingUpdate.current_version}.`,
      duration: Infinity,
      action: {
        label: 'Download',
        onClick: () => openExternalUrl(releaseUrl),
      },
      onDismiss: dismissUpdate,
    });
    return () => {
      toast.dismiss(toastId);
    };
  }, [pendingUpdate, dismissUpdate]);

  // Memoized on liveState?.mode, the only input it reads. Left unmemoized this
  // was redeclared every render, which put a new identity into the deps of the
  // four useCallbacks below — and made the React Compiler skip preserving their
  // memoization entirely (react-hooks/preserve-manual-memoization).
  //
  // NOTE: this is a *derivation*, not a subscription. Handlers that need the
  // live mode at invocation time must still read
  // `useStore.getState().liveState?.mode` — see the WS-subscribe REGRESSION
  // GUARD. Depending on this value inside the WS-subscribe effect would
  // reintroduce the ~5 Hz re-registration that guard exists to catch.
  const getScannerMode = useCallback(() => {
    const normalized = (liveState?.mode ?? '').toString().trim().toUpperCase();
    if (normalized === 'DIRECT') return 'SEARCH';
    if (normalized === 'CLOSE_CALL') return 'CLOSE_CALL';
    if (normalized === 'HOLD') return 'HOLD';
    return 'SCAN';
  }, [liveState?.mode]);

  const isInitialSyncing = isMemorySyncing && !sync.hasSyncedInitially;

  const { mainText, subText } = useMemo(() => {
    if (isInitialSyncing) {
      return {
        mainText: 'Syncing Scanner Memory',
        subText: syncProgressMessage || 'Loading channels from device...',
      };
    }
    if (deviceInfo?.connection_status === 'disconnected' && deviceInfo?.diagnostic_message) {
      return {
        mainText: 'Scanner Offline',
        subText: deviceInfo.diagnostic_message,
      };
    }
    if (!hasFreshLiveFrame && deviceInfo?.connection_status !== 'disconnected') {
      return { mainText: 'Scanning...', subText: 'Searching for signals' };
    }
    const isScanning = liveState?.mode === 'SCAN' && !liveState?.squelch_open;
    if (isScanning) {
      return { mainText: 'Scanning...', subText: 'Searching for signals' };
    }
    if (!liveState) {
      return { mainText: '—', subText: 'No signal' };
    }
    // Frequency 0 means "empty/no channel" — render the placeholder, not
    // "0.000" (#144). The subText already skips 0 via its truthiness check.
    const main =
      liveState.alpha_tag || (liveState.frequency ? liveState.frequency.toFixed(3) : '—');
    return { mainText: main, subText: buildHitSubText(liveState) };
  }, [deviceInfo, hasFreshLiveFrame, isInitialSyncing, liveState, syncProgressMessage]);

  // REGRESSION GUARD (#330, react-hooks/preserve-manual-memoization): the three
  // callbacks below keep narrow `liveState?.channel` / `liveState?.frequency`
  // deps on purpose. The React Compiler infers whole `liveState` instead ("less
  // specific property than source") and skips optimizing them, so the rule is
  // suppressed rather than satisfied — matching it would mean WIDENING these
  // deps to the whole 5 Hz-churning liveState object, which is the exact
  // direction the WS-subscribe guard above forbids. All three are event
  // handlers (onHoldToggle / the lockout key handler), never effect inputs, so
  // the lost memoization costs a re-render, not correctness. Do not "fix" these
  // by broadening the deps.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const handleToggle = useCallback(async () => {
    if (!connected || toggleBusy) return;
    setToggleBusy(true);
    try {
      if (getScannerMode() === 'HOLD') {
        await api.sendScan();
      } else {
        await api.sendHold();
      }
    } catch (error) {
      console.warn('Failed to toggle scan/hold', error);
      toast.error('Failed to toggle scan/hold');
    } finally {
      setToggleBusy(false);
    }
  }, [api, connected, getScannerMode, toggleBusy]);

  // See the preserve-manual-memoization note on handleToggle above.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const triggerTemporaryLockout = useCallback(async () => {
    if (!connected) return;
    try {
      const frequency = liveState?.frequency;
      if (!frequency) {
        toast.error('No active frequency for lockout');
        return;
      }
      const result = await api.toggleTemporaryLockout({
        frequency,
        channel: liveState?.channel ?? undefined,
      });
      const lockoutChannel = result.channel ?? liveState?.channel;
      toast.info(
        result.locked
          ? lockoutChannel
            ? `Temporary lockout enabled for CH ${lockoutChannel}`
            : 'Temporary lockout enabled'
          : lockoutChannel
            ? `Temporary lockout cleared for CH ${lockoutChannel}`
            : 'Temporary lockout cleared',
      );
      if (getScannerMode() === 'HOLD') {
        requestScanResume('temporary lockout', { delayMs: 1000 });
      }
    } catch (error) {
      console.warn('Failed to toggle lockout', error);
      toast.error('Failed to toggle lockout');
    }
  }, [api, connected, getScannerMode, liveState?.channel, liveState?.frequency, requestScanResume]);

  // See the preserve-manual-memoization note on handleToggle above.
  // eslint-disable-next-line react-hooks/preserve-manual-memoization
  const triggerPermanentLockout = useCallback(async () => {
    if (!connected) return;
    try {
      const channelId = liveState?.channel ?? null;
      if (!channelId) {
        toast.error('No channel selected for lockout');
        return;
      }
      const updated = await api.togglePermanentLockout(channelId);
      setChannels(channels.map((channel) => (channel.index === updated.index ? updated : channel)));
      toast.info(
        `Permanent lockout ${updated.lockout ? 'enabled' : 'cleared'} for CH ${updated.index}`,
      );
      if (getScannerMode() === 'HOLD') {
        requestScanResume('permanent lockout', { delayMs: 1000 });
      }
    } catch (error) {
      console.warn('Failed to toggle lockout', error);
      toast.error('Failed to toggle lockout');
    }
  }, [
    api,
    channels,
    connected,
    getScannerMode,
    liveState?.channel,
    requestScanResume,
    setChannels,
  ]);

  // Switch on every variant explicitly rather than
  // `if (permanent) ... else temporary`.
  //
  // `tsconfig` has `strict: false`, so `strictFunctionTypes` is off and
  // function params compare BIVARIANTLY: a handler typed for two variants is
  // accepted where three are required, with NO type error. #522 briefly added
  // a third L/O item and the else-branch shape silently routed it to a
  // temporary channel lockout while `npm run type-check` stayed green. That
  // item was removed again in #531, but the hazard is a property of the
  // tsconfig, not of that item -- the next variant added here would hit it.
  //
  // No test names this: the failure needs a variant that does not exist yet.
  // The shape is the guard.
  const handleLockout = useCallback(
    (type: LockoutKind) => {
      switch (type) {
        case 'permanent':
          void triggerPermanentLockout();
          break;
        case 'temporary':
          void triggerTemporaryLockout();
          break;
      }
    },
    [triggerPermanentLockout, triggerTemporaryLockout],
  );

  const flushBankWrite = useCallback(async () => {
    if (bankFlushInFlightRef.current) return;
    bankFlushInFlightRef.current = true;
    try {
      while (bankDesiredRef.current) {
        const target = bankDesiredRef.current;
        bankDesiredRef.current = null;
        try {
          await api.setBanks(target);
        } catch (error) {
          console.warn('Failed to update banks', error);
          toast.error('Failed to update banks');
          // Re-read from the scanner so the UI reconverges with reality
          // instead of holding the optimistic mask the scanner rejected.
          try {
            const result = await api.getBanks();
            if (Array.isArray(result.banks) && result.banks.length === 10) {
              setBanks(result.banks);
            }
          } catch {
            // Refetch also failed (sync running, etc.) — nothing to do.
          }
        }
      }
      if (bankPreToggleModeRef.current === 'SCAN' && connected) {
        // Let the scanner settle after EPG before nudging it back to scan.
        // EPG is fire-and-forget from the ProgramModeGuard's Drop, then the
        // poll thread drains it on its next iteration (POLL_INTERVAL_MS is
        // 200ms). Worst case: poll thread is mid-STS (50–200ms) when EPG
        // is queued, drains EPG only at the next iteration boundary, then
        // the BC125AT itself needs 50–100ms for the mode transition. We
        // wait 350ms to cover the worst case so KEY,S,P doesn't race the
        // transition. Bypassing requestScanResume because its in-flight
        // cooldown can drop our resume after the sync-completion resume.
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        try {
          await api.sendScan();
        } catch (error) {
          console.warn('Failed to resume scan after bank toggle', error);
        }
      }
      bankPreToggleModeRef.current = null;
    } finally {
      bankFlushInFlightRef.current = false;
    }
  }, [api, setBanks, connected]);

  const handleBankToggle = useCallback(
    (index: number) => {
      if (bankPreToggleModeRef.current === null) {
        bankPreToggleModeRef.current = getScannerMode();
      }
      const baseline = bankDesiredRef.current ?? banks;
      const nextBanks = baseline.map((active, idx) => (idx === index ? !active : active));
      setBanks(nextBanks);
      bankDesiredRef.current = nextBanks;
      if (bankFlushTimerRef.current !== null) {
        window.clearTimeout(bankFlushTimerRef.current);
      }
      bankFlushTimerRef.current = window.setTimeout(() => {
        bankFlushTimerRef.current = null;
        void flushBankWrite();
      }, 300);
    },
    [banks, setBanks, flushBankWrite, getScannerMode],
  );

  const handleVolumeChange = useCallback(
    async (value: number) => {
      try {
        await api.setVolume(value);
      } catch (error) {
        console.warn('Failed to set volume', error);
        toast.error('Failed to set volume');
      }
    },
    [api],
  );

  // Focus management + trap for the blocking sync overlay (a11y S2). Standalone
  // effect keyed on isMemorySyncing — it touches none of the four
  // regression-guarded sync flows (WS deps, overlay gate, handleCancelSync,
  // reconnect probe). On open: remember the previously-focused element and move
  // focus to Cancel. While open: the overlay has one focusable control, so Tab
  // is trapped by re-focusing it. On close: restore focus.
  useEffect(() => {
    if (!isMemorySyncing) return;
    overlayReturnFocusRef.current = document.activeElement as HTMLElement | null;
    cancelSyncButtonRef.current?.focus();

    const handleTrapKey = (event: KeyboardEvent) => {
      if (event.key === 'Tab') {
        event.preventDefault();
        cancelSyncButtonRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleTrapKey);
    return () => {
      document.removeEventListener('keydown', handleTrapKey);
      overlayReturnFocusRef.current?.focus();
    };
  }, [isMemorySyncing]);

  return (
    // MotionConfig honors the user's reduced-motion preference — the OS setting
    // via 'user', or force-off when the in-app toggle is set (a11y S4). The
    // reducedMotion pref was previously loaded but never consumed.
    <MotionConfig reducedMotion={preferences.reducedMotion ? 'always' : 'user'}>
      <div className="scanner-app-shell">
        <h1 className="sr-only">Bearpaw</h1>
        {/* Above the tab bar and NOT gated on connection_status: a data
          problem is still true while the scanner is connected and everything
          else looks fine, which is exactly how the migration failure it
          exists for stayed invisible. */}
        <DataDiagnosticBanner message={deviceInfo?.data_diagnostic_message} />
        {/* `expand` + `gap` make stacked toasts spread vertically instead of
          piling. Colors come from sonner's own CSS variables (not `unstyled`)
          so its stacking/expand layout stays intact — a darker `--normal-bg`
          with per-type accent borders. */}
        <Toaster
          position="top-right"
          theme="dark"
          expand
          gap={12}
          style={
            {
              '--normal-bg': '#0e1014',
              '--normal-border': 'rgba(255,255,255,0.12)',
              '--normal-text': 'var(--text-scanner-light)',
              '--success-bg': '#0e1014',
              '--success-border': 'rgba(34,197,94,0.5)',
              '--success-text': 'var(--text-scanner-light)',
              '--error-bg': '#0e1014',
              '--error-border': 'rgba(239,68,68,0.5)',
              '--error-text': 'var(--text-scanner-light)',
              '--warning-bg': '#0e1014',
              '--warning-border': 'rgba(234,179,8,0.5)',
              '--warning-text': 'var(--text-scanner-light)',
              '--info-bg': '#0e1014',
              '--info-border': 'rgba(59,130,246,0.5)',
              '--info-text': 'var(--text-scanner-light)',
            } as React.CSSProperties
          }
        />

        <nav aria-label="Views">
          <TabBar currentTab={currentTab} onTabChange={handleTabChange} />
        </nav>

        <main
          id="view-panel"
          role="tabpanel"
          aria-labelledby={`tab-${currentTab.toLowerCase()}`}
          tabIndex={0}
          className="relative flex-1 overflow-hidden p-6"
        >
          <h2 className="sr-only">{currentTab}</h2>
          <AnimatePresence mode="wait">
            {currentTab === 'Scan' && (
              <ScanView
                mainText={mainText}
                subText={subText}
                scannerMode={getScannerMode()}
                connectionStatus={connectionStatus}
                isHolding={getScannerMode() === 'HOLD'}
                isInitialSyncing={isInitialSyncing}
                chartAnimate={chartAnimate}
                dashboardLoading={dashboardLoading}
                busiestChannels={busiestChannels}
                hourlyHeatmap={hourlyHeatmap}
                heatmapStats={heatmapStats}
                onHoldToggle={handleToggle}
                onLockout={handleLockout}
                onVolumeChange={handleVolumeChange}
                onBankToggle={handleBankToggle}
                onOpenActivityExport={() => setIsExportSheetOpen(true)}
              />
            )}

            {currentTab === 'Device' && (
              <DeviceTab
                onCheckForUpdates={checkForUpdatesNow}
                checkingForUpdates={checkingForUpdates}
              />
            )}
            {currentTab === 'Channels' && <ChannelsTab />}
          </AnimatePresence>
        </main>

        <StatusBar
          connectionStatus={connectionStatus}
          modelName={deviceInfo?.model || 'BC125AT'}
          shellStatusText={shellStatusText}
          currentTab={currentTab}
          sessionStats={currentTab === 'Scan' ? sessionStats : null}
          showChannelCount={capabilities.reports_live_channel}
          syncedAt={sync.syncedAt}
        />

        {/* Announces scan-hit / scanning / connection transitions to screen
          readers. Mounted here (outside the AnimatePresence tab switch) so its
          edge-tracking refs survive tab changes. Pass RAW liveState.mode, not
          getScannerMode() — the announcer gates on `mode === 'SCAN'`. */}
        <ScanAnnouncer
          squelchOpen={liveState?.squelch_open ?? false}
          mode={liveState?.mode ?? ''}
          frequency={liveState?.frequency}
          alphaTag={liveState?.alpha_tag}
          connectionStatus={connectionStatus}
          isSyncing={isMemorySyncing}
        />

        <ActivityExportSheet
          isOpen={isExportSheetOpen}
          onClose={() => setIsExportSheetOpen(false)}
          hasActivity={fullActivityLog.length > 0}
        />

        {/* REGRESSION GUARD: App.regression.test.tsx :: memory-sync overlay
          covers subsequent syncs, not just initial. Gate on `isMemorySyncing`
          (any in-progress sync) rather than `isInitialSyncing` (first-time
          only) so that a user-triggered File → Sync Memory after the initial
          sync still blocks the UI for the duration of the PRG bracket — the
          original intent of #102. */}
        <AnimatePresence>
          {isMemorySyncing && (
            <motion.div
              key="memory-sync-overlay"
              role="dialog"
              aria-modal={true}
              aria-labelledby="sync-overlay-title"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
            >
              <div className="flex max-w-sm flex-col items-center gap-4 rounded-lg border border-white/10 bg-scanner-bg-dark p-6 shadow-lg">
                <SyncSpinner percent={sync.percent} size={56} />
                <div className="flex flex-col items-center gap-1">
                  <span id="sync-overlay-title" className="text-sm font-medium text-white">
                    Syncing Scanner Memory
                  </span>
                  <span className="font-mono text-xs text-scanner-text-secondary">
                    {Math.round(sync.percent)}%
                  </span>
                </div>
                {/* Progress text is the polite live region so screen readers hear
                  updates without the whole dialog re-announcing. */}
                <p aria-live="polite" className="text-center text-xs text-scanner-text-secondary">
                  {syncProgressMessage || 'Loading channels from device...'}
                </p>
                <button
                  type="button"
                  ref={cancelSyncButtonRef}
                  onClick={handleCancelSync}
                  className="rounded-md border border-white/15 bg-white/10 px-3 py-1.5 text-xs text-scanner-text-light transition-colors hover:bg-white/20"
                >
                  Cancel Sync
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <ImportProgressOverlay
          active={importProgress.active}
          percent={importProgress.percent}
          message={importProgress.message}
        />
      </div>
    </MotionConfig>
  );
}
