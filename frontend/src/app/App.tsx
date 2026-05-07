import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../lib/utils';
import { Toaster, toast } from 'sonner';
import { TabNav, StatusHeader, ScannerDisplay, BankControls } from './components/ScannerUI';
import { BarChart, Bar, LabelList, ResponsiveContainer, XAxis } from 'recharts';
import { Activity, Clock, FileText, HelpCircle, Lock, Play, Radio, Signal, X } from 'lucide-react';
import { Slider } from './components/ui/slider';
import { Switch } from './components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from './components/ui/tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './components/ui/select';
import { useAPI, API_BASE } from '../api/useApi';
import { useStore, type Preferences } from '../store/useStore';
import { useWebSocket } from '../websocket/useWebSocket';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { stepToChannel } from '../utils/channelNavigation';
import {
  getBackendStatus,
  getShellInfo,
  isTauriRuntime,
  subscribeBackendStatus,
  type BackendStatus,
} from '../tauri-shell';
import type {
  ActivityLogEntry,
  ChannelData,
  ChannelDraft,
  CustomSearchRange,
  EventMessage,
  ProgressMessage,
  StateUpdateMessage,
} from '../types';
import { DeviceTab } from './components/views/DeviceTab';
import { ChannelsTab } from './components/views/ChannelsTab';
import { ActivityExportSheet } from './components/views/ActivityExportSheet';

// API_BASE is imported from ../api/useApi (Tauri-aware)

export type Tab = 'Scan' | 'Device' | 'Channels';
export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';
export type ScannerMode = 'SCAN' | 'HOLD' | 'SEARCH' | 'CLOSE_CALL';

function getRelativeTime(date: Date | number) {
  const timestamp = typeof date === 'number' ? date * 1000 : date.getTime();
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 10) return 'now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatDuration(totalSeconds?: number) {
  if (!totalSeconds || totalSeconds <= 0) return '0:00';
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function normalizeSignal(value?: number) {
  if (value === undefined || value === null) return 0;
  if (value <= 5) return Math.round(value);
  return Math.min(5, Math.round(value / 20));
}

const defaultCloseCallBand = [false, false, false, false, false];
const HEATMAP_INTENSITY_CLASSES = [
  'bg-heatmap-0',
  'bg-heatmap-1',
  'bg-heatmap-2',
  'bg-heatmap-3',
  'bg-heatmap-4',
  'bg-heatmap-5',
] as const;

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
  const api = useAPI();
  const { ws, connected, connecting } = useWebSocket();

  const liveState = useStore((state) => state.liveState);
  const deviceInfo = useStore((state) => state.deviceInfo);
  const channels = useStore((state) => state.channels);
  const activityLog = useStore((state) => state.activityLog);
  const fullActivityLog = useStore((state) => state.fullActivityLog);
  const preferences = useStore((state) => state.preferences);
  const isDashboardMode = preferences.startInDashboardMode;
  const updateLiveState = useStore((state) => state.updateLiveState);
  const setDeviceInfo = useStore((state) => state.setDeviceInfo);
  const setChannels = useStore((state) => state.setChannels);
  const setConnected = useStore((state) => state.setConnected);
  const setConnecting = useStore((state) => state.setConnecting);
  const addActivityLogEntry = useStore((state) => state.addActivityLogEntry);
  const addToFullActivityLog = useStore((state) => state.addToFullActivityLog);
  const setPreferences = useStore((state) => state.setPreferences);
  const updatePreferences = useStore((state) => state.updatePreferences);

  const [currentTab, setCurrentTab] = useState<Tab>('Scan');
  const [banks, setBanks] = useState<boolean[]>(() => Array.from({ length: 10 }, () => true));
  const [banksBusy, setBanksBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [chartAnimate, setChartAnimate] = useState(false);
  const [busiestChannels, setBusiestChannels] = useState<
    { alpha_tag: string; hit_count: number }[]
  >([]);
  const [hourlyHeatmap, setHourlyHeatmap] = useState<number[][]>([]);
  const [heatmapStats, setHeatmapStats] = useState<{ min: number; max: number; avg: number }>({
    min: 0,
    max: 0,
    avg: 0,
  });
  const [sessionStats, setSessionStats] = useState<{
    total_hits?: number;
    unique_channels?: number;
    active_time_seconds?: number;
  } | null>(null);
  const [_temporaryLockoutChannels, setTemporaryLockoutChannels] = useState<number[]>([]);
  const [isMemorySyncing, setIsMemorySyncing] = useState(false);
  const [syncProgressMessage, setSyncProgressMessage] = useState('Loading channels from device...');
  const [isExportSheetOpen, setIsExportSheetOpen] = useState(false);
  const [preferencesLoading, setPreferencesLoading] = useState(false);
  const [isInProgramMode, setIsInProgramMode] = useState(false);
  const [hasFreshLiveFrame, setHasFreshLiveFrame] = useState(false);
  const [shellStatus, setShellStatus] = useState<BackendStatus | null>(null);
  const [shellLabel, setShellLabel] = useState<string | null>(null);

  const syncInProgressRef = useRef(false);
  const syncTaskIdRef = useRef<string | null>(null);
  const hasSyncedInitiallyRef = useRef(false);
  const lastHitOpenRef = useRef(false);
  const squelchOpenStartTimeRef = useRef<number | null>(null);
  const currentHitDataRef = useRef<ActivityLogEntry | null>(null);
  const analyticsLoadedRef = useRef(false);
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
    setConnected(connected);
    setConnecting(connecting);
  }, [connected, connecting, setConnected, setConnecting]);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setShellStatus(null);
      setShellLabel(null);
      return;
    }
    let active = true;
    let cleanup: (() => void) | null = null;

    getShellInfo()
      .then((info) => {
        if (!active || !info) return;
        setShellLabel(`${info.product_name} ${info.version}`);
      })
      .catch(() => {
        // Ignore shell metadata failures in UI.
      });

    getBackendStatus()
      .then((status) => {
        if (active) setShellStatus(status);
      })
      .catch(() => {
        // Ignore initial status failures; event stream may still provide updates.
      });

    subscribeBackendStatus((status) => {
      if (active) setShellStatus(status);
    })
      .then((unlisten) => {
        cleanup = unlisten;
      })
      .catch(() => {
        // Non-fatal in browser or restricted runtime.
      });

    return () => {
      active = false;
      if (cleanup) cleanup();
    };
  }, []);

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
          setPreferences(frontendPrefs);
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
  }, [setPreferences]);

  useEffect(() => {
    const unsubscribeState = ws.on('state_update', (message) => {
      const payload = message as StateUpdateMessage;
      if (payload.data.stale === true) {
        setHasFreshLiveFrame(false);
      } else {
        setHasFreshLiveFrame(true);
      }
      updateLiveState(payload.data, payload.sequence);
      const squelchOpen = payload.data.squelch_open;

      if (typeof squelchOpen === 'boolean') {
        if (squelchOpen && !lastHitOpenRef.current) {
          squelchOpenStartTimeRef.current = payload.timestamp;
          lastHitOpenRef.current = true;
        } else if (!squelchOpen && lastHitOpenRef.current) {
          const startTime =
            squelchOpenStartTimeRef.current !== null
              ? squelchOpenStartTimeRef.current
              : payload.timestamp;
          const duration = payload.timestamp - startTime;
          if (
            duration >= preferences.hitMinDuration &&
            squelchOpenStartTimeRef.current !== null &&
            currentHitDataRef.current
          ) {
            const entry: ActivityLogEntry = {
              ...currentHitDataRef.current,
              id: `${squelchOpenStartTimeRef.current}-${payload.sequence}`,
              timestamp: squelchOpenStartTimeRef.current,
              duration,
              ended_at: payload.timestamp,
            };
            addActivityLogEntry(entry);
            addToFullActivityLog(entry);
          }
          squelchOpenStartTimeRef.current = null;
          currentHitDataRef.current = null;
          lastHitOpenRef.current = false;
        }
      }
    });

    const unsubscribeEvent = ws.on('event', (message) => {
      const payload = message as EventMessage;
      if (payload.event === 'state_stale') {
        setHasFreshLiveFrame(false);
        updateLiveState({ stale: true });
      }
      if (payload.event === 'scan_hit') {
        squelchOpenStartTimeRef.current = payload.timestamp;
        currentHitDataRef.current = {
          id: `${payload.timestamp}-pending`,
          timestamp: payload.timestamp,
          frequency: payload.data.frequency ?? 0,
          channel: payload.data.channel ?? null,
          alpha_tag: payload.data.alpha_tag ?? null,
          type: 'hit',
          rssi: payload.data.rssi,
          hasAudio: false,
          duration: 0,
          ended_at: 0,
        };
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
        setSyncProgressMessage(payload.message);
      }

      // Detect sync in progress or just completed
      if (
        !syncInProgressRef.current &&
        !isComplete &&
        payload.message.includes('Syncing channel')
      ) {
        syncInProgressRef.current = true;
        setIsMemorySyncing(true);
        syncTaskIdRef.current = payload.task_id || null;
      }

      if (isComplete && syncInProgressRef.current) {
        syncInProgressRef.current = false;
        hasSyncedInitiallyRef.current = true;
        setIsMemorySyncing(false);
        setSyncProgressMessage('Loading channels from device...');
        syncTaskIdRef.current = null;

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
    addActivityLogEntry,
    addToFullActivityLog,
    api,
    currentTab,
    requestScanResume,
    setChannels,
    setDeviceInfo,
    updateLiveState,
    ws,
    liveState?.mode,
  ]);

  useEffect(() => {
    if (!connected) {
      setHasFreshLiveFrame(false);
    }
  }, [connected]);

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
          setHasFreshLiveFrame(!statusResult.value.stale);
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

        try {
          const lockouts = await api.getLockouts({ includeFrequencies: false });
          if (!active) return;
          setTemporaryLockoutChannels(lockouts.temporary_channels.map((entry) => entry.channel));
        } catch (error) {
          if (active) {
            console.warn('Failed to load initial lockouts', error);
          }
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
    if (syncInProgressRef.current) return;
    if (channels.length > 0) return;

    let active = true;
    const startMemorySync = async () => {
      try {
        setSyncProgressMessage('Loading channels from device...');
        const result = await api.syncMemory();
        if (!active) return;
        if (result.status === 'started' || result.status === 'already_running') {
          syncInProgressRef.current = true;
          setIsMemorySyncing(true);
          syncTaskIdRef.current = result.task_id || null;
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
  }, [api, channels.length, deviceInfo]);

  useEffect(() => {
    if (!isDashboardMode) {
      setChartAnimate(false);
      return;
    }
    setChartAnimate(true);
    const timeout = window.setTimeout(() => setChartAnimate(false), 700);
    return () => window.clearTimeout(timeout);
  }, [isDashboardMode]);

  const handleMemorySync = useCallback(async () => {
    if (syncInProgressRef.current || isMemorySyncing) {
      return;
    }
    setIsMemorySyncing(true);
    setSyncProgressMessage('Loading channels from device...');
    try {
      const result = await api.syncMemory({ force: true });
      if (result.status === 'already_running') {
        syncInProgressRef.current = true;
        return;
      }
      toast.success('Channel sync started');
      syncInProgressRef.current = true;
    } catch (error) {
      console.warn('Failed to start channel sync', error);
      toast.error('Unable to start channel sync');
      setIsMemorySyncing(false);
    }
  }, [api, isMemorySyncing]);

  const handleCancelSync = useCallback(async () => {
    try {
      await api.cancelSync(syncTaskIdRef.current || undefined);
      toast.info('Sync cancelled');
      syncInProgressRef.current = false;
      hasSyncedInitiallyRef.current = true;
      syncTaskIdRef.current = null;
      setIsMemorySyncing(false);
      setSyncProgressMessage('Loading channels from device...');
    } catch (error) {
      console.warn('Failed to cancel sync', error);
      toast.error('Unable to cancel sync');
    }
  }, [api]);

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

  useEffect(() => {
    if (!deviceInfo || deviceInfo.connection_status !== 'connected') return;
    let active = true;
    const refreshLockouts = async () => {
      try {
        const lockouts = await api.getLockouts({ includeFrequencies: false });
        if (!active) return;
        setTemporaryLockoutChannels(lockouts.temporary_channels.map((entry) => entry.channel));
      } catch (error) {
        if (active) {
          console.warn('Failed to refresh lockouts', error);
        }
      }
    };
    refreshLockouts();
    const interval = window.setInterval(refreshLockouts, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [api, deviceInfo]);

  useEffect(() => {
    if (currentTab !== 'Scan') return;
    let active = true;
    const fetchAnalytics = async () => {
      try {
        if (!analyticsLoadedRef.current) {
          setDashboardLoading(true);
        }
        const [channelsRes, statsRes, heatmapRes] = await Promise.all([
          fetch(`${API_BASE}/analytics/busiest-channels?limit=5&hours=24`),
          fetch(`${API_BASE}/analytics/session-stats`),
          fetch(`${API_BASE}/analytics/hourly-heatmap`),
        ]);
        if (channelsRes.ok) {
          const data = await channelsRes.json();
          if (active) setBusiestChannels(data.channels || []);
        }
        if (statsRes.ok) {
          const data = await statsRes.json();
          if (active) setSessionStats(data);
        }
        if (heatmapRes.ok) {
          const data = await heatmapRes.json();
          if (active) {
            const stats = data.stats || { min: 0, max: 0, avg: 0 };
            // Transform flat array to 7x24 grid
            const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
            if (data.heatmap && Array.isArray(data.heatmap)) {
              for (const cell of data.heatmap) {
                if (cell.day >= 0 && cell.day < 7 && cell.hour >= 0 && cell.hour < 24) {
                  grid[cell.day][cell.hour] = cell.count;
                }
              }
            }
            setHourlyHeatmap(grid);
            setHeatmapStats(stats);
          }
        }
      } catch (error) {
        console.error('Failed to fetch analytics data:', error);
      } finally {
        if (active) {
          setDashboardLoading(false);
          analyticsLoadedRef.current = true;
        }
      }
    };
    fetchAnalytics();
    const interval = setInterval(fetchAnalytics, 5000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [currentTab]);

  useEffect(() => {
    // Don't track mode changes during sync completion to avoid race conditions
    if (isMemorySyncing) return;

    const normalizedMode = (liveState?.mode ?? '').toString().trim().toUpperCase();
    const isProgramModeNow = normalizedMode === 'PGM';

    if (isProgramModeNow !== isInProgramMode) {
      setIsInProgramMode(isProgramModeNow);
    }
  }, [liveState?.mode, isInProgramMode, isMemorySyncing]);

  const getConnectionStatus = useCallback((): ConnectionStatus => {
    if (connecting) return 'connecting';
    if (!connected || deviceInfo?.connection_status === 'disconnected' || liveState?.stale)
      return 'disconnected';
    return 'connected';
  }, [connected, connecting, deviceInfo, liveState]);

  const shellStatusText = useMemo(() => {
    if (!isTauriRuntime()) return null;
    const server = shellStatus?.running ? 'Backend up' : 'Backend down';
    if (shellStatus?.last_error) return `${server} (error)`;
    if (shellLabel) return `${shellLabel} • ${server}`;
    return server;
  }, [shellLabel, shellStatus]);

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

  const getScannerMode = () => {
    const normalized = (liveState?.mode ?? '').toString().trim().toUpperCase();
    if (normalized === 'DIRECT') return 'SEARCH';
    if (normalized === 'CLOSE_CALL') return 'CLOSE_CALL';
    if (normalized === 'HOLD') return 'HOLD';
    return 'SCAN';
  };

  const isInitialSyncing = isMemorySyncing && !hasSyncedInitiallyRef.current;

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
      if (result.channel) {
        setTemporaryLockoutChannels((prev) =>
          result.locked
            ? prev.includes(result.channel!)
              ? prev
              : [...prev, result.channel!]
            : prev.filter((channelId) => channelId !== result.channel),
        );
      }
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
      setTemporaryLockoutChannels((prev) => prev.filter((channel) => channel !== updated.index));
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
        setBanks((prev) => prev.map((active, idx) => (idx === index ? !active : active)));
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

  const recentHits = useMemo(
    () =>
      activityLog.map((entry) => ({
        id: entry.id,
        frequency: entry.frequency.toFixed(4),
        tag: entry.alpha_tag || '—',
        strength: normalizeSignal(entry.rssi),
        time: entry.timestamp,
        hasAudio: entry.hasAudio ?? false,
        channel: entry.channel ?? null,
      })),
    [activityLog],
  );

  const sessionStatsDisplay = {
    hits: sessionStats?.total_hits ?? 0,
    uniqueChannels: sessionStats?.unique_channels ?? 0,
    activeTime: sessionStats?.active_time_seconds ?? 0,
  };

  const handleExportActivityLog = useCallback(() => {
    if (fullActivityLog.length === 0) {
      toast.info('No activity to export');
      return;
    }
    const header = ['timestamp', 'frequency', 'tag', 'channel', 'rssi'].join(',');
    const rows = fullActivityLog.map((entry) => {
      const timestamp = new Date(entry.timestamp * 1000).toISOString();
      const frequency = entry.frequency.toFixed(4);
      const tag = entry.alpha_tag ?? '';
      const channel = entry.channel ?? '';
      const rssi = entry.rssi ?? '';
      return [timestamp, frequency, `"${tag.replace(/"/g, '""')}"`, channel, rssi].join(',');
    });
    const blob = new Blob([[header, ...rows].join('\n')], {
      type: 'text/csv',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `activity-log-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }, [fullActivityLog]);

  const formatSignalBars = (strength: number) =>
    [1, 2, 3, 4, 5].map((bar) => (
      <span
        key={bar}
        className={cn(
          'h-2 w-1 rounded-scanner-xs',
          bar <= strength ? 'bg-green-500' : 'bg-white/10',
        )}
      />
    ));

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

      <div className="px-6 pt-4 pb-2">
        <TabNav
          currentTab={currentTab}
          onTabChange={handleTabChange}
          connectionStatus={getConnectionStatus()}
          modelName={deviceInfo?.model || 'BC125AT'}
          shellStatusText={shellStatusText}
        />
      </div>

      <div
        className={cn(
          'relative flex-1 overflow-hidden',
          currentTab === 'Scan' && !isDashboardMode ? 'p-0' : 'p-6 pt-2',
        )}
      >
        <AnimatePresence mode="wait">
          {currentTab === 'Scan' && (
            <motion.div
              key="scan"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="flex flex-col gap-6 h-full relative"
              layout
            >
              {isDashboardMode ? (
                <div className="flex h-[var(--layout-dashboard-main-height)] gap-6 transition-all duration-500 ease-in-out">
                  <div
                    className={cn(
                      'flex flex-col gap-3 h-full transition-all duration-500 ease-in-out',
                      'w-[var(--layout-dashboard-panel-width)]',
                    )}
                  >
                    <StatusHeader
                      volume={liveState?.volume ?? 0}
                      onVolumeChange={handleVolumeChange}
                      isHolding={getScannerMode() === 'HOLD'}
                      onHoldToggle={handleToggle}
                      onLockout={handleLockout}
                      isDashboardMode={isDashboardMode}
                      onDashboardToggle={handleDashboardToggle}
                    />
                    <ScannerDisplay
                      mainText={mainText}
                      subText={subText}
                      mode={getScannerMode()}
                      signalStrength={normalizeSignal(liveState?.rssi)}
                      isScanning={
                        !isInitialSyncing && liveState?.mode === 'SCAN' && !liveState?.squelch_open
                      }
                      isError={getConnectionStatus() === 'disconnected'}
                      errorType={getConnectionStatus() === 'disconnected' ? 'usb' : undefined}
                      variant="default"
                      className="flex-1 min-h-0 mb-3"
                    />
                    {isInitialSyncing && (
                      <div className="mb-3 flex items-center justify-between rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-scanner-text-secondary">
                        <span>{syncProgressMessage || 'Loading channels from device...'}</span>
                        <button
                          type="button"
                          onClick={handleCancelSync}
                          className="rounded-md border border-white/15 bg-white/10 px-2 py-1 text-scanner-text-light transition-colors hover:bg-white/20"
                        >
                          Cancel Sync
                        </button>
                      </div>
                    )}
                    <BankControls activeBanks={banks} onToggleBank={handleBankToggle} />
                  </div>

                  {/* Recent Hits */}
                  <div className="flex-1 bg-black/20 rounded-lg border border-white/5 p-4 overflow-hidden flex flex-col">
                    <h3 className="font-bold text-sm mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Radio className="h-4 w-4 text-brand-primary" />
                        <span>Recent Hits</span>
                      </div>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={() => setIsExportSheetOpen(true)}
                            disabled={fullActivityLog.length === 0}
                            className={cn(
                              'ml-auto inline-flex items-center justify-center rounded-scanner-sm border border-white/10 bg-white/5 px-2 py-1 text-white/80 hover:text-white hover:bg-white/10 hover:border-white/20 transition-colors',
                              fullActivityLog.length === 0 && 'opacity-50 cursor-not-allowed',
                            )}
                            aria-label="Export activity log"
                          >
                            <FileText size={14} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent
                          side="bottom"
                          align="center"
                          className="scanner-select-content"
                          arrowClassName="bg-background fill-background"
                        >
                          Export
                        </TooltipContent>
                      </Tooltip>
                    </h3>
                    <div className="flex-1 overflow-y-auto pr-1 space-y-2">
                      {recentHits.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full text-white/20 text-xs italic gap-2">
                          <Activity className="w-8 h-8 opacity-20" />
                          Waiting for signals...
                        </div>
                      ) : (
                        recentHits.map((hit) => (
                          <div
                            key={hit.id}
                            className="flex items-center text-xs py-1 px-2 hover:bg-white/5 rounded cursor-pointer group gap-2"
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              {hit.hasAudio && (
                                <Play className="h-3 w-3 shrink-0 fill-brand-primary/20 text-brand-primary" />
                              )}
                              <span className="text-white/60 truncate" title={hit.tag}>
                                {hit.tag}
                              </span>
                            </div>
                            <div className="flex gap-0.5 h-2 items-end">
                              {formatSignalBars(hit.strength)}
                            </div>
                            <span className="w-[var(--size-hit-frequency-width)] text-right font-mono text-brand-light group-hover:text-brand-primary">
                              {hit.frequency}
                            </span>
                            <span className="w-[var(--size-hit-time-width)] whitespace-nowrap text-right text-xs text-white/30">
                              {getRelativeTime(hit.time)}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {/* Stats Sidebar - Dashboard Mode Only */}
                  <div className="flex h-full w-[var(--layout-stats-sidebar-width)] flex-col gap-2">
                    <div className="flex flex-col justify-between flex-1 py-1">
                      <div className="flex flex-col">
                        <span className="text-xs text-white/40 font-medium uppercase">Hits</span>
                        <span className="text-xl font-bold text-white/90">
                          {sessionStatsDisplay.hits}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-xs text-white/40 font-medium uppercase">Active</span>
                        <span className="text-xl font-bold text-white/90">
                          {formatDuration(sessionStatsDisplay.activeTime)}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-xs text-white/40 font-medium uppercase">
                          Channels
                        </span>
                        <span className="text-xl font-bold text-white/90">
                          {sessionStatsDisplay.uniqueChannels}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="relative h-full w-full p-[var(--layout-monitor-bezel)]">
                  <ScannerDisplay
                    mainText={mainText}
                    subText={subText}
                    mode={getScannerMode()}
                    signalStrength={normalizeSignal(liveState?.rssi)}
                    isScanning={
                      !isInitialSyncing && liveState?.mode === 'SCAN' && !liveState?.squelch_open
                    }
                    isError={getConnectionStatus() === 'disconnected'}
                    errorType={getConnectionStatus() === 'disconnected' ? 'usb' : undefined}
                    variant="monitor"
                    className="h-full w-full"
                  />
                  <div className="pointer-events-none absolute inset-x-4 top-4 flex justify-end">
                    <button
                      type="button"
                      onClick={handleDashboardToggle}
                      className="pointer-events-auto rounded border border-white/20 bg-black/30 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-white/90 transition-colors hover:bg-black/40"
                    >
                      Dashboard
                    </button>
                  </div>
                </div>
              )}

              {/* Dashboard Widgets - Appear Below */}
              <AnimatePresence>
                {isDashboardMode && (
                  <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 20 }}
                    className="flex-1 min-h-0 flex gap-6 overflow-hidden"
                  >
                    {/* Busiest Channels */}
                    <div className="flex-1 min-h-0 bg-black/20 rounded-lg border border-white/5 p-4 flex flex-col">
                      <h3 className="font-bold text-sm mb-3 flex items-center gap-2">
                        <Signal className="w-4 h-4 text-blue-400" /> Busiest Channels
                      </h3>
                      {dashboardLoading ? (
                        <div className="flex-1 flex items-center justify-center text-white/20 text-xs">
                          Loading...
                        </div>
                      ) : busiestChannels.length === 0 ? (
                        <div className="flex-1 flex items-center justify-center text-white/20 text-xs italic">
                          No data yet
                        </div>
                      ) : (
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={busiestChannels}>
                            <XAxis
                              dataKey="alpha_tag"
                              tick={{ fill: 'var(--color-chart-axis)', fontSize: 10 }}
                              interval={0}
                            />
                            <Bar
                              dataKey="hit_count"
                              fill="var(--color-chart-bar)"
                              radius={[4, 4, 0, 0]}
                              isAnimationActive={chartAnimate}
                              animationDuration={600}
                            >
                              <LabelList
                                dataKey="hit_count"
                                position="insideTop"
                                style={{
                                  fill: 'var(--color-chart-label)',
                                  fontSize: 10,
                                  fontWeight: 600,
                                }}
                              />
                            </Bar>
                          </BarChart>
                        </ResponsiveContainer>
                      )}
                    </div>

                    {/* Activity Heatmap */}
                    <div className="flex-1 min-h-0 bg-black/20 rounded-lg border border-white/5 p-4 flex flex-col">
                      <h3 className="font-bold text-sm mb-3 flex items-center gap-2">
                        <Clock className="w-4 h-4 text-green-400" /> Activity Heatmap
                      </h3>
                      <div className="flex flex-1 flex-col justify-center gap-[var(--layout-heatmap-cell-gap)]">
                        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, row) => (
                          <div key={day} className="flex items-center gap-2">
                            <span className="text-xs text-white/30 w-5 text-right font-mono uppercase">
                              {day}
                            </span>
                            <div className="grid flex-1 grid-cols-[repeat(24,minmax(0,1fr))] gap-[var(--layout-heatmap-cell-gap)]">
                              {Array.from({ length: 24 }).map((_, col) => {
                                const heatmapData = hourlyHeatmap?.[row]?.[col] ?? 0;

                                // Calculate intensity based on stats
                                let intensity = 0;
                                if (heatmapStats.max > heatmapStats.min) {
                                  const normalized =
                                    (heatmapData - heatmapStats.min) /
                                    (heatmapStats.max - heatmapStats.min);
                                  intensity = Math.min(5, Math.floor(normalized * 5));
                                }

                                return (
                                  <div
                                    key={col}
                                    className={cn(
                                      'aspect-square w-full cursor-pointer rounded-scanner-xs ring-white/50 transition-all hover:ring-1',
                                      HEATMAP_INTENSITY_CLASSES[intensity],
                                    )}
                                    title={`${day} ${col}:00 - ${heatmapData} hits`}
                                  />
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                      <div className="flex justify-between text-xs text-white/30 mt-1 pl-7">
                        <span>00</span>
                        <span>06</span>
                        <span>12</span>
                        <span>18</span>
                        <span>23</span>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}

          {currentTab === 'Device' && <DeviceTab />}
          {currentTab === 'Channels' && <ChannelsTab />}
        </AnimatePresence>
      </div>

      <ActivityExportSheet
        isOpen={isExportSheetOpen}
        onClose={() => setIsExportSheetOpen(false)}
        hasActivity={fullActivityLog.length > 0}
      />
    </div>
  );
}
