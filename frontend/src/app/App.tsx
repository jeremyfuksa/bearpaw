import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { cn } from '../lib/utils';
import { StatusBar } from './components/ScannerUI';
import { getAPI, API_BASE } from '../api/useApi';
import { useStore, type Preferences } from '../store/useStore';
import { useWebSocket } from '../websocket/useWebSocket';
import { useActivityLogTracker } from '../hooks/useActivityLogTracker';
import { useConnectionStatus } from '../hooks/useConnectionStatus';
import { useDashboardAnalytics } from '../hooks/useDashboardAnalytics';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useMenuEvents } from '../hooks/useMenuEvents';
import { useShellStatusText } from '../hooks/useShellStatusText';
import { openExternalUrl } from '../tauri-shell';
import type { ProgressMessage, StateUpdateMessage } from '../types';
import { DeviceTab } from './components/views/DeviceTab';
import { ChannelsTab } from './components/views/ChannelsTab';
import { ScanView } from './components/views/ScanView';
import { ActivityExportSheet } from './components/views/ActivityExportSheet';

export type Tab = 'Scan' | 'Device' | 'Channels';
export type ScannerMode = 'SCAN' | 'HOLD' | 'SEARCH' | 'CLOSE_CALL';

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
  useActivityLogTracker();

  const liveState = useStore((state) => state.liveState);
  const deviceInfo = useStore((state) => state.deviceInfo);
  const channels = useStore((state) => state.channels);
  const fullActivityLog = useStore((state) => state.fullActivityLog);
  const preferences = useStore((state) => state.preferences);
  const isDashboardMode = preferences.startInDashboardMode;
  const updateLiveState = useStore((state) => state.updateLiveState);
  const setDeviceInfo = useStore((state) => state.setDeviceInfo);
  const setChannels = useStore((state) => state.setChannels);
  const updatePreferences = useStore((state) => state.updatePreferences);
  const banks = useStore((state) => state.banks);
  const banksBusy = useStore((state) => state.banksBusy);
  const setBanks = useStore((state) => state.setBanks);
  const setBanksBusy = useStore((state) => state.setBanksBusy);
  const sync = useStore((state) => state.sync);
  const updateSync = useStore((state) => state.updateSync);
  const isMemorySyncing = sync.inProgress;
  const syncProgressMessage = sync.message;

  const [currentTab, setCurrentTab] = useState<Tab>('Scan');
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
            startInDashboardMode: prefs.start_dashboard_mode ?? false,
            autoConnect: prefs.auto_connect ?? false,
            checkUpdates: prefs.check_updates ?? true,
            dataRetentionDays: prefs.data_retention_days || 30,
            audioOutputDevice: prefs.audio_output_device || 'default',
            mqttEnabled: prefs.mqtt_enabled ?? false,
            mqttHost: prefs.mqtt_host || '127.0.0.1',
            mqttPort: prefs.mqtt_port || 1883,
            mqttTopicPrefix: prefs.mqtt_topic_prefix || 'scanner',
            mqttQos: prefs.mqtt_qos ?? 0,
            mqttRetain: prefs.mqtt_retain ?? false,
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
      const isComplete =
        payload.percent >= 100 ||
        /sync complete/i.test(payload.message) ||
        /sync cancelled/i.test(payload.message);

      if (payload.message) {
        updateSync({ message: payload.message });
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
        });

        // Double-check PGM mode after a delay to account for mode transitions
        programModeEntryTimeoutRef.current = setTimeout(() => {
          const normalizedMode = (liveState?.mode ?? '').toString().trim().toUpperCase();
          setIsInProgramMode(normalizedMode === 'PGM');
        }, 500);

        api
          .getChannels()
          .then((channelData) => setChannels(channelData))
          .then(() => {
            if (currentTab === 'Scan') {
              requestScanResume('sync completion', { toastOnError: true });
            }
          })
          .catch((error) =>
            console.warn('[Progress] Failed to refresh channels after sync', error),
          );
      }
    });

    return () => {
      unsubscribeState();
      unsubscribeEvent();
      unsubscribeDeviceInfo();
      unsubscribeProgress();
      if (programModeEntryTimeoutRef.current) {
        clearTimeout(programModeEntryTimeoutRef.current);
      }
      if (scanResumeTimerRef.current !== null) {
        window.clearTimeout(scanResumeTimerRef.current);
      }
    };
  }, [
    api,
    currentTab,
    requestScanResume,
    setChannels,
    setDeviceInfo,
    updateLiveState,
    updateSync,
    ws,
    liveState?.mode,
  ]);

  useEffect(() => {
    if (!connected) {
      // Mark the store stale on disconnect so the derived `hasFreshLiveFrame`
      // becomes false without the local-mirror bug from #74.
      updateLiveState({ stale: true });
    }
  }, [connected, updateLiveState]);

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

        if (statusResult.status === 'fulfilled') {
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
    if (!isDashboardMode) {
      setChartAnimate(false);
      return;
    }
    setChartAnimate(true);
    const timeout = window.setTimeout(() => setChartAnimate(false), 700);
    return () => window.clearTimeout(timeout);
  }, [isDashboardMode]);

  const handleCancelSync = useCallback(async () => {
    try {
      const taskId = useStore.getState().sync.taskId || undefined;
      await api.cancelSync(taskId);
      toast.info('Sync cancelled');
      updateSync({
        inProgress: false,
        hasSyncedInitially: true,
        taskId: null,
        message: 'Loading channels from device...',
      });
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
    const main = liveState.alpha_tag || liveState.frequency?.toFixed(4) || '—';
    const parts = [];
    if (liveState.frequency) parts.push(liveState.frequency.toFixed(4));
    if (liveState.modulation) parts.push(liveState.modulation);
    if (liveState.channel !== undefined) parts.push(`CH${liveState.channel}`);
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

  const handleBankToggle = useCallback(
    async (index: number) => {
      if (banksBusy) return;
      const nextBanks = banks.map((active, idx) => (idx === index ? !active : active));
      setBanks(nextBanks);
      setBanksBusy(true);
      try {
        const result = await api.setBanks(nextBanks);
        if (Array.isArray(result.banks) && result.banks.length === 10) {
          setBanks(result.banks);
        }
      } catch (error) {
        console.warn('Failed to update banks', error);
        toast.error('Failed to update banks');
        // Roll back the optimistic toggle: re-flip the bit we just changed.
        const current = useStore.getState().banks;
        setBanks(current.map((active, idx) => (idx === index ? !active : active)));
      } finally {
        setBanksBusy(false);
      }
    },
    [api, banks, banksBusy],
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

  const handleDashboardToggle = useCallback(async () => {
    const newValue = !isDashboardMode;
    updatePreferences({ startInDashboardMode: newValue });
    try {
      await fetch(`${API_BASE}/preferences`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ start_dashboard_mode: newValue }),
      });
    } catch (error) {
      console.error('Failed to save dashboard preference', error);
      toast.error('Failed to save preference');
    }
  }, [isDashboardMode, updatePreferences]);

  return (
    <div className="scanner-app-shell">
      <Toaster
        position="top-right"
        theme="dark"
        toastOptions={{
          unstyled: true,
          classNames: {
            toast:
              'flex w-full items-center gap-2 rounded-lg border border-white/10 bg-scanner-bg-dark p-4 shadow-lg',
            title: 'text-sm font-bold text-scanner-text-light',
            description: 'text-xs text-scanner-text-secondary',
            actionButton: 'rounded bg-scanner-bg-button-hover px-2 py-1 text-xs text-white',
            cancelButton: 'bg-white/10 text-white text-xs px-2 py-1 rounded',
            error: 'border-red-500/50',
            success: 'border-green-500/50',
            warning: 'border-yellow-500/50',
            info: 'border-blue-500/50',
          },
        }}
      />

      <div
        className={cn(
          'relative flex-1 overflow-hidden',
          currentTab === 'Scan' && !isDashboardMode ? 'p-0' : 'p-6',
        )}
      >
        <AnimatePresence mode="wait">
          {currentTab === 'Scan' && (
            <ScanView
              mainText={mainText}
              subText={subText}
              scannerMode={getScannerMode()}
              connectionStatus={connectionStatus}
              isHolding={getScannerMode() === 'HOLD'}
              isInitialSyncing={isInitialSyncing}
              syncProgressMessage={syncProgressMessage}
              chartAnimate={chartAnimate}
              dashboardLoading={dashboardLoading}
              busiestChannels={busiestChannels}
              hourlyHeatmap={hourlyHeatmap}
              heatmapStats={heatmapStats}
              onHoldToggle={handleToggle}
              onLockout={handleLockout}
              onVolumeChange={handleVolumeChange}
              onBankToggle={handleBankToggle}
              onCancelSync={handleCancelSync}
              onDashboardToggle={handleDashboardToggle}
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
        currentFrequency={liveState?.frequency ?? null}
        currentTab={currentTab}
        sessionStats={currentTab === 'Scan' ? sessionStats : null}
      />

      <ActivityExportSheet
        isOpen={isExportSheetOpen}
        onClose={() => setIsExportSheetOpen(false)}
        hasActivity={fullActivityLog.length > 0}
      />
    </div>
  );
}
