import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../lib/utils";
import { Toaster, toast } from "sonner";
import {
  TabNav,
  StatusHeader,
  ScannerDisplay,
  BankControls,
} from "./components/ScannerUI";
import {
  BarChart,
  Bar,
  LabelList,
  ResponsiveContainer,
  XAxis,
} from "recharts";
import {
  Activity,
  Clock,
  FileText,
  HelpCircle,
  Lock,
  Play,
  Radio,
  Signal,
  X,
} from "lucide-react";
import { Slider } from "./components/ui/slider";
import { Switch } from "./components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "./components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import { motion, AnimatePresence } from "motion/react";
import { useAPI } from "../api/useApi";
import { useStore } from "../store/useStore";
import { useWebSocket } from "../websocket/useWebSocket";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { stepToChannel } from "../utils/channelNavigation";
import type {
  ActivityLogEntry,
  ChannelData,
  ChannelDraft,
  CustomSearchRange,
  EventMessage,
  ProgressMessage,
  StateUpdateMessage,
} from "../types";
import { DeviceTab } from "./components/views/DeviceTab";
import { ChannelsTab } from "./components/views/ChannelsTab";
import { ActivityExportSheet } from "./components/views/ActivityExportSheet";

const API_BASE = (import.meta as any).env?.VITE_API_BASE_URL || "/api/v1";

export type Tab = "Scan" | "Device" | "Channels";
export type ConnectionStatus = "connected" | "connecting" | "disconnected";
export type ScannerMode = "SCAN" | "HOLD" | "SEARCH" | "CLOSE_CALL";

function getRelativeTime(date: Date | number) {
  const timestamp = typeof date === "number" ? date * 1000 : date.getTime();
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 10) return "now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatDuration(totalSeconds?: number) {
  if (!totalSeconds || totalSeconds <= 0) return "0:00";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function normalizeSignal(value?: number) {
  if (value === undefined || value === null) return 0;
  if (value <= 5) return Math.round(value);
  return Math.min(5, Math.round(value / 20));
}

const defaultCloseCallBand = [false, false, false, false, false];

export default function App() {
  useKeyboardShortcuts({
    openActivityLog: () => setIsLogModalOpen(true),
    openMemoryBrowser: () => setCurrentTab("Channels"),
  });
  const api = useAPI();
  const { ws, connected, connecting } = useWebSocket();

  const liveState = useStore((state) => state.liveState);
  const deviceInfo = useStore((state) => state.deviceInfo);
  const channels = useStore((state) => state.channels);
  const activityLog = useStore((state) => state.activityLog);
  const fullActivityLog = useStore((state) => state.fullActivityLog);
  const isDashboardMode = useStore((state) => state.isDashboardMode);
  const isRecording = useStore((state) => state.isRecording);
  const updateLiveState = useStore((state) => state.updateLiveState);
  const setDeviceInfo = useStore((state) => state.setDeviceInfo);
  const setChannels = useStore((state) => state.setChannels);
  const setConnected = useStore((state) => state.setConnected);
  const setConnecting = useStore((state) => state.setConnecting);
  const addActivityLogEntry = useStore((state) => state.addActivityLogEntry);
  const addToFullActivityLog = useStore((state) => state.addToFullActivityLog);
  const setDashboardMode = useStore((state) => state.setDashboardMode);
  const setRecording = useStore((state) => state.setRecording);

  const [currentTab, setCurrentTab] = useState<Tab>("Scan");
  const [banks, setBanks] = useState<boolean[]>(() =>
    Array.from({ length: 10 }, () => true),
  );
  const [banksBusy, setBanksBusy] = useState(false);
  const [toggleBusy, setToggleBusy] = useState(false);
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [chartAnimate, setChartAnimate] = useState(false);
  const [busiestChannels, setBusiestChannels] = useState<{ alpha_tag: string; hit_count: number }[]>([]);
  const [hourlyHeatmap, setHourlyHeatmap] = useState<number[][]>([]);
  const [sessionStats, setSessionStats] = useState<
    {
      total_hits?: number;
      unique_channels?: number;
      active_time_seconds?: number;
    } | null
  >(null);
  const [_temporaryLockoutChannels, setTemporaryLockoutChannels] = useState<number[]>([]);
  const [isMemorySyncing, setIsMemorySyncing] = useState(false);
  const [isExportSheetOpen, setIsExportSheetOpen] = useState(false);

  const syncInProgressRef = useRef(false);
  const syncStartedRef = useRef(false);
  const lastHitOpenRef = useRef(false);
  const analyticsLoadedRef = useRef(false);

  useEffect(() => {
    setConnected(connected);
    setConnecting(connecting);
  }, [connected, connecting, setConnected, setConnecting]);

  useEffect(() => {
    const unsubscribeState = ws.on("state_update", (message) => {
      const payload = message as StateUpdateMessage;
      updateLiveState(payload.data, payload.sequence);
      const squelchOpen = payload.data.squelch_open;
      const isNewHit = squelchOpen === true && !lastHitOpenRef.current;
      if (typeof squelchOpen === "boolean") {
        lastHitOpenRef.current = squelchOpen;
      }
      if (isNewHit && payload.data.frequency) {
        const entry: ActivityLogEntry = {
          id: `${payload.timestamp}-${payload.sequence}`,
          timestamp: payload.timestamp,
          frequency: payload.data.frequency,
          channel: payload.data.channel ?? null,
          alpha_tag: payload.data.alpha_tag ?? null,
          type: "hit",
          rssi: payload.data.rssi,
          hasAudio: isRecording,
        };
        addActivityLogEntry(entry);
        addToFullActivityLog(entry);
      }
    });

    const unsubscribeEvent = ws.on("event", (message) => {
      const payload = message as EventMessage;
      if (payload.event === "state_stale") {
        updateLiveState({ stale: true });
      }
    });

    const unsubscribeProgress = ws.on("progress", (message) => {
      const payload = message as ProgressMessage;
      const isComplete =
        payload.percent >= 100 ||
        /sync complete/i.test(payload.message) ||
        /sync cancelled/i.test(payload.message);
      if (isComplete && syncInProgressRef.current) {
        syncInProgressRef.current = false;
        setIsMemorySyncing(false);
        api
          .getChannels()
          .then((channelData) => setChannels(channelData))
          .then(() => api.sendScan())
          .catch((error) =>
            console.warn("Failed to refresh channels after sync", error),
          );
      }
    });

    return () => {
      unsubscribeState();
      unsubscribeEvent();
      unsubscribeProgress();
    };
  }, [addActivityLogEntry, addToFullActivityLog, api, isRecording, setChannels, updateLiveState, ws]);

  useEffect(() => {
    let active = true;
    const loadInitialData = async () => {
      try {
        const [status, info, channelData, banksData] = await Promise.all([
          api.getStatus(),
          api.getDeviceInfo(),
          api.getChannels(),
          api.getBanks(),
        ]);
        if (!active) return;
        updateLiveState(status);
        setDeviceInfo(info);
        setChannels(channelData);
        setBanks(banksData.banks);
        try {
          const lockouts = await api.getLockouts({ includeFrequencies: false });
          if (!active) return;
          setTemporaryLockoutChannels(
            lockouts.temporary_channels.map((entry) => entry.channel),
          );
        } catch (error) {
          if (active) {
            console.warn("Failed to load initial lockouts", error);
          }
        }
      } catch (error) {
        if (!active) return;
        console.warn("Failed to load initial scanner data", error);
      }
    };
    loadInitialData();
    return () => {
      active = false;
    };
  }, [api, setChannels, setDeviceInfo, updateLiveState]);

  useEffect(() => {
    if (syncStartedRef.current) return;
    if (!deviceInfo || deviceInfo.connection_status !== "connected") return;
    if (channels.length > 0) return;

    let active = true;
    const startMemorySync = async () => {
      try {
        const result = await api.syncMemory();
        if (!active) return;
        if (
          result.status === "started" ||
          result.status === "already_running"
        ) {
          syncInProgressRef.current = true;
          setIsMemorySyncing(true);
          syncStartedRef.current = true;
        }
      } catch (error) {
        if (!active) return;
        console.warn("Failed to start memory sync", error);
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
    try {
      const result = await api.syncMemory({ force: true });
      if (result.status === "already_running") {
        syncInProgressRef.current = true;
        return;
      }
      toast.success("Channel sync started");
      syncInProgressRef.current = true;
    } catch (error) {
      console.warn("Failed to start channel sync", error);
      toast.error("Unable to start channel sync");
      setIsMemorySyncing(false);
    }
  }, [api, isMemorySyncing]);

  useEffect(() => {
    let active = true;
    const refreshDeviceInfo = async () => {
      try {
        const info = await api.getDeviceInfo();
        if (active) {
          setDeviceInfo(info);
        }
      } catch (error) {
        if (active) {
          console.warn("Failed to refresh device info", error);
        }
      }
    };
    refreshDeviceInfo();
    const interval = window.setInterval(refreshDeviceInfo, 5000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [api, setDeviceInfo]);

  useEffect(() => {
    if (!deviceInfo || deviceInfo.connection_status !== "connected") return;
    let active = true;
    const refreshLockouts = async () => {
      try {
        const lockouts = await api.getLockouts({ includeFrequencies: false });
        if (!active) return;
        setTemporaryLockoutChannels(
          lockouts.temporary_channels.map((entry) => entry.channel),
        );
      } catch (error) {
        if (active) {
          console.warn("Failed to refresh lockouts", error);
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
    if (currentTab !== "Scan") return;
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
          }
        }
      } catch (error) {
        console.error("Failed to fetch analytics data:", error);
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

  const getConnectionStatus = useCallback((): ConnectionStatus => {
    if (!connected || deviceInfo?.connection_status === "disconnected" || liveState?.stale)
      return "disconnected";
    if (connecting) return "connecting";
    return "connected";
  }, [connected, connecting, deviceInfo, liveState]);

  const getScannerMode = () => {
    const normalized = (liveState?.mode ?? "").toString().trim().toUpperCase();
    if (normalized === "DIRECT") return "SEARCH";
    if (normalized === "CLOSE_CALL") return "CLOSE_CALL";
    if (normalized === "HOLD") return "HOLD";
    return "SCAN";
  };

  const { mainText, subText } = useMemo(() => {
    const isScanning = liveState?.mode === "SCAN" && !liveState?.squelch_open;
    if (isScanning) {
      return { mainText: "Scanning...", subText: "Searching for signals" };
    }
    if (!liveState) {
      return { mainText: "—", subText: "No signal" };
    }
    const main = liveState.alpha_tag || liveState.frequency?.toFixed(4) || "—";
    const parts = [];
    if (liveState.frequency) parts.push(liveState.frequency.toFixed(4));
    if (liveState.modulation) parts.push(liveState.modulation);
    if (liveState.channel !== undefined) parts.push(`CH${liveState.channel}`);
    return { mainText: main, subText: parts.join(" • ") };
  }, [liveState]);

  const handleToggle = useCallback(async () => {
    if (!connected || toggleBusy) return;
    setToggleBusy(true);
    try {
      if (getScannerMode() === "HOLD") {
        await api.sendScan();
      } else {
        await api.sendHold();
      }
    } catch (error) {
      console.warn("Failed to toggle scan/hold", error);
      toast.error("Failed to toggle scan/hold");
    } finally {
      setToggleBusy(false);
    }
  }, [api, connected, getScannerMode, toggleBusy]);

  const triggerTemporaryLockout = useCallback(async () => {
    if (!connected) return;
    try {
      const frequency = liveState?.frequency;
      if (!frequency) {
        toast.error("No active frequency for lockout");
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
            : "Temporary lockout enabled"
          : lockoutChannel
            ? `Temporary lockout cleared for CH ${lockoutChannel}`
            : "Temporary lockout cleared",
      );
      if (getScannerMode() === "HOLD") {
        window.setTimeout(() => {
          api.sendScan().catch((error) => {
            console.warn("Failed to resume scan after temporary lockout", error);
          });
        }, 1000);
      }
    } catch (error) {
      console.warn("Failed to toggle lockout", error);
      toast.error("Failed to toggle lockout");
    }
  }, [api, connected, getScannerMode, liveState?.channel, liveState?.frequency]);

  const triggerPermanentLockout = useCallback(async () => {
    if (!connected) return;
    try {
      const channelId = liveState?.channel ?? null;
      if (!channelId) {
        toast.error("No channel selected for lockout");
        return;
      }
      const updated = await api.togglePermanentLockout(channelId);
      setChannels(
        channels.map((channel) =>
          channel.index === updated.index ? updated : channel,
        ),
      );
      setTemporaryLockoutChannels((prev) =>
        prev.filter((channel) => channel !== updated.index),
      );
      toast.info(
        `Permanent lockout ${updated.lockout ? "enabled" : "cleared"} for CH ${updated.index}`,
      );
      if (getScannerMode() === "HOLD") {
        window.setTimeout(() => {
          api.sendScan().catch((error) => {
            console.warn("Failed to resume scan after permanent lockout", error);
          });
        }, 1000);
      }
    } catch (error) {
      console.warn("Failed to toggle lockout", error);
      toast.error("Failed to toggle lockout");
    }
  }, [api, channels, connected, getScannerMode, liveState?.channel, setChannels]);

  const handleLockout = useCallback(
    (type: "temporary" | "permanent") => {
      if (type === "permanent") {
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
      const nextBanks = banks.map((active, idx) =>
        idx === index ? !active : active,
      );
      setBanks(nextBanks);
      setBanksBusy(true);
      try {
        const result = await api.setBanks(nextBanks);
        if (Array.isArray(result.banks) && result.banks.length === 10) {
          setBanks(result.banks);
        }
      } catch (error) {
        console.warn("Failed to update banks", error);
        toast.error("Failed to update banks");
        setBanks((prev) =>
          prev.map((active, idx) => (idx === index ? !active : active)),
        );
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
        console.warn("Failed to set volume", error);
        toast.error("Failed to set volume");
      }
    },
    [api],
  );

  const handleRecordingToggle = useCallback(async () => {
    try {
      if (typeof __TAURI__ !== 'undefined' && __TAURI__) {
        const { invoke } = await import('@tauri-apps/api/core');

        if (isRecording) {
          const info = await invoke('stop_recording');
          console.log('Recording stopped:', info);
          toast.success('Recording saved');
        } else {
          const live = liveState || useStore.getState().liveState;
          const recordingId = await invoke('start_recording', {
            frequency: live?.frequency,
            alphaTag: live?.alpha_tag,
          });
          console.log('Recording started:', recordingId);
          toast.success('Recording started');
        }
        setRecording(!isRecording);
      } else {
        toast.error('Recording is only available in Tauri desktop app');
      }
    } catch (error) {
      console.error('Recording toggle failed', error);
      toast.error('Failed to toggle recording');
    }
  }, [isRecording, liveState, setRecording]);

  const recentHits = useMemo(
    () =>
      activityLog.map((entry) => ({
        id: entry.id,
        frequency: entry.frequency.toFixed(4),
        tag: entry.alpha_tag || "—",
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
      toast.info("No activity to export");
      return;
    }
    const header = ["timestamp", "frequency", "tag", "channel", "rssi"].join(",");
    const rows = fullActivityLog.map((entry) => {
      const timestamp = new Date(entry.timestamp * 1000).toISOString();
      const frequency = entry.frequency.toFixed(4);
      const tag = entry.alpha_tag ?? "";
      const channel = entry.channel ?? "";
      const rssi = entry.rssi ?? "";
      return [timestamp, frequency, `"${tag.replace(/"/g, '""')}"`, channel, rssi].join(",");
    });
    const blob = new Blob([[header, ...rows].join("\n")], {
      type: "text/csv",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
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
          "h-2 w-1 rounded-[1px]",
          bar <= strength ? "bg-green-500" : "bg-white/10",
        )}
      />
    ));

  const mainBg =
    "url('data:image/svg+xml;utf8,<svg viewBox=\\'0 0 511 217\\' xmlns=\\'http://www.w3.org/2000/svg\\' preserveAspectRatio=\\'none\\'><rect x=\\'0\\' y=\\'0\\' height=\\'100%\\' width=\\'100%\\' fill=\\'url(%23grad)\\' opacity=\\'1\\'/><defs><radialGradient id=\\'grad\\' gradientUnits=\\'userSpaceOnUse\\' cx=\\'0\\' cy=\\'0\\' r=\\'10\\' gradientTransform=\\'matrix(-2.2512e-14 14.305 -33.685 8.0487e-15 255.5 49.662)\\'><stop stop-color=\\'rgba(61,68,84,1)\\' offset=\\'0\\'/><stop stop-color=\\'rgba(45,50,61,1)\\' offset=\\'0.5\\'/><stop stop-color=\\'rgba(28,31,38,1)\\' offset=\\'1\\'/></radialGradient></defs></svg>')";

  return (
    <div
      className="flex flex-col w-[1100px] h-[600px] bg-[#1c1f26] text-[#f5ebe8] font-sans overflow-hidden select-none"
      style={{ backgroundImage: mainBg, backgroundSize: "cover" }}
    >
      <Toaster
        position="top-right"
        theme="dark"
        toastOptions={{
          unstyled: true,
          classNames: {
            toast:
              "bg-[#1c1f26] border border-white/10 shadow-lg rounded-lg p-4 flex gap-2 items-center w-full",
            title: "font-bold text-sm text-[#f5ebe8]",
            description: "text-xs text-[#acbbcc]",
            actionButton:
              "bg-[#4c627d] text-white text-xs px-2 py-1 rounded",
            cancelButton:
              "bg-white/10 text-white text-xs px-2 py-1 rounded",
            error: "border-red-500/50",
            success: "border-green-500/50",
            warning: "border-yellow-500/50",
            info: "border-blue-500/50",
          },
        }}
      />

      <div className="px-6 pt-4 pb-2">
        <TabNav
          currentTab={currentTab}
          onTabChange={(tab) => setCurrentTab(tab as Tab)}
          connectionStatus={getConnectionStatus()}
          modelName={deviceInfo?.model || "BC125AT"}
        />
      </div>

      <div className="flex-1 p-6 pt-2 overflow-hidden relative">
        <AnimatePresence mode="wait">
          {currentTab === "Scan" && (
            <motion.div
              key="scan"
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 20 }}
              className="flex flex-col gap-6 h-full relative"
              layout
            >
              <div
                className={cn(
                  "flex gap-6 transition-all duration-500 ease-in-out",
                  isDashboardMode ? "h-[220px]" : "flex-1",
                )}
              >
                <div
                  className={cn(
                    "flex flex-col gap-3 h-full transition-all duration-500 ease-in-out",
                    isDashboardMode
                      ? "w-[450px]"
                      : "w-full max-w-[600px]",
                  )}
                >
                  <StatusHeader
                    volume={liveState?.volume ?? 0}
                    onVolumeChange={handleVolumeChange}
                    isHolding={getScannerMode() === "HOLD"}
                    onHoldToggle={handleToggle}
                    onLockout={handleLockout}
                    isRecording={isRecording}
                    onRecordingToggle={handleRecordingToggle}
                    isDashboardMode={isDashboardMode}
                    onDashboardToggle={() => setDashboardMode(!isDashboardMode)}
                  />
                  <ScannerDisplay
                    mainText={mainText}
                    subText={subText}
                    mode={getScannerMode()}
                    signalStrength={normalizeSignal(liveState?.rssi)}
                    isScanning={
                      liveState?.mode === "SCAN" && !liveState?.squelch_open
                    }
                    isError={getConnectionStatus() === "disconnected"}
                    errorType={
                      getConnectionStatus() === "disconnected" ? "usb" : undefined
                    }
                    variant={isDashboardMode ? "default" : "hero"}
                    className="flex-1 min-h-0 mb-3"
                  />
                  <BankControls activeBanks={banks} onToggleBank={handleBankToggle} />
                  {!isDashboardMode && (
                    <motion.div
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="flex justify-between items-center bg-white/5 rounded-lg p-4 mt-auto border border-white/5"
                    >
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-white/40 font-medium uppercase tracking-wider">
                          Session Hits
                        </span>
                        <span className="text-2xl font-bold text-white">
                          {sessionStatsDisplay.hits}
                        </span>
                      </div>
                      <div className="w-px h-8 bg-white/10" />
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-white/40 font-medium uppercase tracking-wider">
                          Unique Channels
                        </span>
                        <span className="text-2xl font-bold text-white">
                          {sessionStatsDisplay.uniqueChannels}
                        </span>
                      </div>
                      <div className="w-px h-8 bg-white/10" />
                      <div className="flex flex-col gap-1">
                        <span className="text-xs text-white/40 font-medium uppercase tracking-wider">
                          Active Time
                        </span>
                        <span className="text-2xl font-bold text-white">
                          {formatDuration(sessionStatsDisplay.activeTime)}
                        </span>
                      </div>
                    </motion.div>
                  )}
                </div>

                {/* Recent Hits - Always Visible */}
                <div className="flex-1 bg-black/20 rounded-lg border border-white/5 p-4 overflow-hidden flex flex-col">
                  <h3 className="font-bold text-sm mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Radio className="w-4 h-4 text-orange-500" />
                      <span>Recent Hits</span>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => setIsExportSheetOpen(true)}
                          disabled={fullActivityLog.length === 0}
                          className={cn(
                            "ml-auto inline-flex items-center justify-center rounded-scanner-sm border border-white/10 bg-white/5 px-2 py-1 text-white/80 hover:text-white hover:bg-white/10 hover:border-white/20 transition-colors",
                            fullActivityLog.length === 0 && "opacity-50 cursor-not-allowed"
                          )}
                          aria-label="Export activity log"
                        >
                          <FileText size={14} />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent
                        side="bottom"
                        align="center"
                        className="bg-neutral-950 border border-white/10 text-white"
                        arrowClassName="bg-neutral-950 fill-neutral-950"
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
                    ) : isDashboardMode ? (
                      recentHits.map((hit) => (
                        <div
                          key={hit.id}
                          className="flex items-center text-xs py-1 px-2 hover:bg-white/5 rounded cursor-pointer group gap-2"
                        >
                          <div className="flex items-center gap-2 flex-1 min-w-0">
                            {hit.hasAudio && (
                              <Play className="w-3 h-3 text-[#ef991f] shrink-0 fill-[#ef991f]/20" />
                            )}
                            <span className="text-white/60 truncate" title={hit.tag}>
                              {hit.tag}
                            </span>
                          </div>
                          <div className="flex gap-0.5 h-2 items-end">
                            {formatSignalBars(hit.strength)}
                          </div>
                          <span className="font-mono text-orange-400 group-hover:text-orange-300 w-[60px] text-right">
                            {hit.frequency}
                          </span>
                          <span className="text-white/30 text-xs w-[45px] text-right whitespace-nowrap">
                            {getRelativeTime(hit.time)}
                          </span>
                        </div>
                      ))
                    ) : (
                      recentHits.map((hit) => (
                        <motion.div
                          key={hit.id}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          className="flex items-center justify-between bg-white/5 hover:bg-white/10 p-3 rounded-lg cursor-pointer group transition-all border border-transparent hover:border-white/10"
                        >
                          <div className="flex flex-col gap-0.5">
                            <span className="font-bold text-orange-400 font-mono text-sm group-hover:text-orange-300 transition-colors">
                              {hit.frequency}
                            </span>
                            <div className="flex items-center gap-1.5">
                              {hit.hasAudio && (
                                <Play className="w-3 h-3 text-[#ef991f] shrink-0 fill-[#ef991f]/20" />
                              )}
                              <span className="text-white/70 text-xs font-medium truncate max-w-[200px]">
                                {hit.tag}
                              </span>
                            </div>
                          </div>
                          <div className="flex flex-col items-end gap-1">
                            <div className="flex gap-0.5 h-2 items-end">
                              {formatSignalBars(hit.strength)}
                            </div>
                            <span className="text-white/30 text-xs whitespace-nowrap">
                              {getRelativeTime(hit.time)}
                            </span>
                          </div>
                        </motion.div>
                      ))
                    )}
                  </div>
                </div>

                {/* Stats Sidebar - Dashboard Mode Only */}
                {isDashboardMode && (
                  <div className="flex flex-col h-full w-[110px] gap-2">
                    <div className="flex flex-col justify-between flex-1 py-1">
                      <div className="flex flex-col">
                        <span className="text-xs text-white/40 font-medium uppercase">
                          Hits
                        </span>
                        <span className="text-xl font-bold text-white/90">
                          {sessionStatsDisplay.hits}
                        </span>
                      </div>
                      <div className="flex flex-col">
                        <span className="text-xs text-white/40 font-medium uppercase">
                          Active
                        </span>
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
                )}
              </div>

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
                              tick={{ fill: "#888", fontSize: 10 }}
                              interval={0}
                            />
                            <Bar
                              dataKey="hit_count"
                              fill="#3b82f6"
                              radius={[4, 4, 0, 0]}
                              isAnimationActive={chartAnimate}
                              animationDuration={600}
                            >
                              <LabelList
                                dataKey="hit_count"
                                position="insideTop"
                                style={{ fill: "#fff", fontSize: 10, fontWeight: 600 }}
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
                      <div className="flex-1 flex flex-col justify-center gap-[2px]">
                        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, row) => (
                          <div key={day} className="flex items-center gap-2">
                            <span className="text-xs text-white/30 w-5 text-right font-mono uppercase">
                              {day}
                            </span>
                            <div className="flex-1 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-[2px]">
                              {Array.from({ length: 24 }).map((_, col) => {
                                const heatmapData = hourlyHeatmap?.[row]?.[col] ?? 0;
                                const intensity = Math.min(5, Math.floor(heatmapData / 10));
                                return (
                                  <div
                                    key={col}
                                    className="rounded-[1px] hover:ring-1 ring-white/50 transition-all w-full aspect-square cursor-pointer"
                                    style={{
                                      backgroundColor:
                                        intensity === 0
                                          ? "rgba(255,255,255,0.05)"
                                          : `rgba(16, 185, 129, ${intensity * 0.2})`,
                                    }}
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

          {currentTab === "Device" && (
            <DeviceTab
              isMemorySyncing={isMemorySyncing}
              onMemorySync={handleMemorySync}
            />
          )}
          {currentTab === "Channels" && <ChannelsTab />}
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
