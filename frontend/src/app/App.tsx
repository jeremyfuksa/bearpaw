import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { SyncSpinner } from './components/SyncSpinner';
import { cn } from '../lib/utils';
import { StatusBar } from './components/ScannerUI';
import { getAPI, API_BASE } from '../api/useApi';
import { useStore, type Preferences } from '../store/useStore';
import { useWebSocket } from '../websocket/useWebSocket';
import { useActivityLogHydrate } from '../hooks/useActivityLogHydrate';
import { useActivityLogTracker } from '../hooks/useActivityLogTracker';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { useDashboardAnalytics } from '../hooks/useDashboardAnalytics';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useMenuEvents } from '../hooks/useMenuEvents';
import { useShellStatusText } from '../hooks/useShellStatusText';
import { openExternalUrl } from '../tauri-shell';
import type { BanksUpdateMessage, LiveState, ProgressMessage, StateUpdateMessage } from '../types';
import { DeviceTab } from './components/views/DeviceTab';
import { ChannelsTab } from './components/views/ChannelsTab';
import { ScanView } from './components/views/ScanView';
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

export default function App() {
  useKeyboardShortcuts({
    openActivityLog: () => setIsExportSheetOpen(true),
    openMemoryBrowser: () => setCurrentTab('Channels'),
    closeOverlays: () => {
      setIsExportSheetOpen(false);
    },
    openShortcuts: () => {
      toast.info(
        'Keyboard Shortcuts:\nCtrl+S: Scan | Ctrl+H: Hold\nCtrl+L: Activity Log | Ctrl+M: Memory\nCtrl+C: Copy Freq | Ctrl+↑/↓: Navigate\nEsc: Close overlays | ?: Show shortcuts',
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
  const channels = useStore((state) => state.channels);
  const fullActivityLog = useStore((state) => state.fullActivityLog);
  const preferences = useStore((state) => state.preferences);
  const updateLiveState = useStore((state) => state.updateLiveState);
  const setDeviceInfo = useStore((state) => state.setDeviceInfo);
  const setChannels = useStore((state) => state.setChannels);
  const updatePreferences = useStore((state) => state.updatePreferences);
  const banks = useStore((state) => state.banks);
  const setBanks = useStore((state) => state.setBanks);
  const sync = useStore((state) => state.sync);
  const updateSync = useStore((state) => state.updateSync);
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
  const [chartAnimate, setChartAnimate] = useState(false);
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
          const frontendPrefs: Partial<Preferences> = {
            theme: prefs.theme === 'field' ? 'field' : 'night',
            displayMode: prefs.displayMode || 'frequency',
            reducedMotion: prefs.reduced_motion || false,
            hitMinDuration: prefs.hit_min_duration || 2,
            autoConnect: prefs.auto_connect ?? false,
            checkUpdates: prefs.check_updates ?? true,
            dataRetentionDays: prefs.data_retention_days || 30,
            audioOutputDevice: prefs.audio_output_device || 'default',
          };
          console.log('[Preferences] Setting in store:', frontendPrefs);
          updatePreferences(frontendPrefs);
          console.log(
            '[Preferences] Current store preferences after set:',
            useStore.getState().preferences,
          );
        }
      } catch (error) {
        console.warn('Failed to load preferences from backend', error);
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
      if (payload?.data) {
        setDeviceInfo(payload.data);
      }
    });

    const unsubscribeProgress = ws.on('progress', (message) => {
      const payload = message as ProgressMessage;
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
            // Background bank refresh — fire-and-forget so a 409/timeout
            // doesn't take scan-resume down with it. Failure here just
            // means the UI's bank state stays at whatever it was; the
            // existing bank-refetch useEffect is a second chance.
            api
              .getBanks()
              .then((result) => {
                if (Array.isArray(result.banks) && result.banks.length === 10) {
                  setBanks(result.banks);
                }
              })
              .catch((error) => {
                console.warn('Failed to refresh banks after sync', error);
              });
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
        const [statusResult, infoResult, channelsResult, banksResult] = await Promise.allSettled([
          api.getStatus(),
          api.getDeviceInfo(),
          api.getChannels(),
          api.getBanks(),
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

        if (banksResult.status === 'fulfilled' && Array.isArray(banksResult.value.banks)) {
          setBanks(banksResult.value.banks);
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
  }, [api, setChannels, setDeviceInfo, updateLiveState]);

  useEffect(() => {
    // Refetch banks once the scanner is reachable AND any initial memory
    // sync has settled. The initial `Promise.allSettled` mount-time
    // fetch races against `startMemorySync` (both want PRG mode); if
    // sync wins, the bank fetch errors out and the store keeps its
    // all-enabled default. This effect closes the gap by re-asking the
    // scanner once sync is done (or once we know sync isn't needed
    // because channels are already populated).
    if (!deviceInfo || deviceInfo.connection_status !== 'connected') return;
    if (sync.inProgress) return; // wait for the sync to release PRG mode
    let active = true;
    api
      .getBanks()
      .then((result) => {
        if (!active) return;
        if (Array.isArray(result.banks) && result.banks.length === 10) {
          setBanks(result.banks);
        }
      })
      .catch((error) => {
        console.warn('Failed to refresh banks after sync', error);
      });
    return () => {
      active = false;
    };
  }, [api, deviceInfo, sync.inProgress, sync.hasSyncedInitially, setBanks]);

  useEffect(() => {
    if (!deviceInfo || deviceInfo.connection_status !== 'connected') return;
    if (useStore.getState().sync.inProgress) return;
    if (channels.length > 0) return;

    let active = true;
    const startMemorySync = async () => {
      try {
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
  }, [api, channels.length, deviceInfo, updateSync]);

  useEffect(() => {
    // One-shot animation pass on mount so the bar chart slides in once.
    // After 700ms Recharts switches to its no-anim render path, which
    // matches the prior behaviour when entering dashboard view.
    setChartAnimate(true);
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
      setIsInProgramMode(isProgramModeNow);
    }
  }, [liveState?.mode, isInProgramMode, isMemorySyncing]);

  const connectionStatus = useConnectionStatus();

  const handleTabChange = useCallback(
    (tab: string) => {
      const newTab = tab as Tab;
      if (newTab === 'Scan') {
        if (isInProgramMode) {
          requestScanResume('exit program mode', { toastOnError: true });
        }
        setCurrentTab(newTab);
        return;
      }

      if (newTab === 'Device' || newTab === 'Channels') {
        setCurrentTab(newTab);
      }
    },
    [isInProgramMode, requestScanResume],
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
    }),
    [api, connected, handleTabChange, updateSync],
  );
  useMenuEvents(menuHandlers);

  const getScannerMode = () => {
    const normalized = (liveState?.mode ?? '').toString().trim().toUpperCase();
    if (normalized === 'DIRECT') return 'SEARCH';
    if (normalized === 'CLOSE_CALL') return 'CLOSE_CALL';
    if (normalized === 'HOLD') return 'HOLD';
    return 'SCAN';
  };

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
    const parts = [];
    if (liveState.frequency) parts.push(liveState.frequency.toFixed(3));
    if (liveState.modulation) parts.push(liveState.modulation);
    if (liveState.channel !== undefined && liveState.channel !== null) {
      parts.push(`CH ${liveState.channel}`);
    }
    if (liveState.squelch_open) {
      const tone = formatLiveTone(liveState);
      if (tone) parts.push(tone);
    }
    return { mainText: main, subText: parts.join(' • ') };
  }, [deviceInfo, hasFreshLiveFrame, isInitialSyncing, liveState, syncProgressMessage]);

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

  const handleLockout = useCallback(
    (type: 'temporary' | 'permanent') => {
      if (type === 'permanent') {
        void triggerPermanentLockout();
      } else {
        void triggerTemporaryLockout();
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

  return (
    <div className="scanner-app-shell">
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

      <TabBar currentTab={currentTab} onTabChange={setCurrentTab} />

      <div className="relative flex-1 overflow-hidden p-6">
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

          {currentTab === 'Device' && <DeviceTab />}
          {currentTab === 'Channels' && <ChannelsTab />}
        </AnimatePresence>
      </div>

      <StatusBar
        connectionStatus={connectionStatus}
        modelName={deviceInfo?.model || 'BC125AT'}
        shellStatusText={shellStatusText}
        currentTab={currentTab}
        sessionStats={currentTab === 'Scan' ? sessionStats : null}
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
            role="status"
            aria-live="polite"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
          >
            <div className="flex max-w-sm flex-col items-center gap-4 rounded-lg border border-white/10 bg-scanner-bg-dark p-6 shadow-lg">
              <SyncSpinner percent={sync.percent} size={56} />
              <div className="flex flex-col items-center gap-1">
                <span className="text-sm font-medium text-white">Syncing Scanner Memory</span>
                <span className="font-mono text-xs text-scanner-text-secondary">
                  {Math.round(sync.percent)}%
                </span>
              </div>
              <p className="text-center text-xs text-scanner-text-secondary">
                {syncProgressMessage || 'Loading channels from device...'}
              </p>
              <button
                type="button"
                onClick={handleCancelSync}
                className="rounded-md border border-white/15 bg-white/10 px-3 py-1.5 text-xs text-scanner-text-light transition-colors hover:bg-white/20"
              >
                Cancel Sync
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
