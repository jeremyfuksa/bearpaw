import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { motion } from "motion/react";
import {
  Lock,
  Radio,
  Maximize2,
  Signal,
  Settings,
  FileText,
  Coffee,
  Heart,
  Code,
  ExternalLink,
  RefreshCcw,
} from "lucide-react";

import { cn } from "../../../lib/utils";
import { useAPI } from "../../../api/useApi";
import { useStore } from "../../../store/useStore";
import { Slider } from "../ui/slider";
import { Switch } from "../ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

type DeviceCategory =
  | "Sync"
  | "Locked Channels"
  | "Device Config"
  | "Close Call"
  | "Service Search"
  | "Custom Search"
  | "Preferences";

interface SearchRange {
  id: number;
  enabled: boolean;
  label: string;
  start: string;
  end: string;
}

interface DeviceTabProps {
  isMemorySyncing: boolean;
  onMemorySync?: () => void;
}

export function DeviceTab({ isMemorySyncing, onMemorySync }: DeviceTabProps) {
  const api = useAPI();
  const deviceInfo = useStore((state) => state.deviceInfo);
  const liveState = useStore((state) => state.liveState);
  const channels = useStore((state) => state.channels) ?? [];
  const setChannels = useStore((state) => state.setChannels);

  const [lockedChannelIds, setLockedChannelIds] = useState<number[]>([]);
  const [selectedCategory, setSelectedCategory] = useState<DeviceCategory>("Sync");
  const [pendingCategory, setPendingCategory] = useState<DeviceCategory | null>(null);
  const [pendingSyncRequested, setPendingSyncRequested] = useState(false);
  const [selectedChannels, setSelectedChannels] = useState<number[]>([]);
  const [isClearing, setIsClearing] = useState(false);

  // Device Config Settings
  const [squelch, setSquelch] = useState(2);
  const [batterySaver, setBatterySaver] = useState(0);
  const [backlight, setBacklight] = useState("key_squelch");
  const [contrast, setContrast] = useState(7);
  const [keyBeep, setKeyBeep] = useState("auto");
  const [priorityMode, setPriorityMode] = useState("off");
  const [weatherAlert, setWeatherAlert] = useState(false);

  // Close Call Settings
  const [closeCallMode, setCloseCallMode] = useState("off");
  const [closeCallLockout, setCloseCallLockout] = useState(false);
  const [closeCallBeep, setCloseCallBeep] = useState(false);
  const [closeCallLight, setCloseCallLight] = useState(false);
  const [closeCallBands, setCloseCallBands] = useState<boolean[]>([false, false, false, false, false]);

  // Service Search Settings
  const [serviceSearchGroups, setServiceSearchGroups] = useState<boolean[]>([
    false, false, false, false, false, false, false, false,
  ]);

  // Custom Search Settings
  const [searchRanges, setSearchRanges] = useState<SearchRange[]>([
    { id: 1, enabled: true, label: "VHF Low", start: "25.0000", end: "54.0000" },
    { id: 2, enabled: true, label: "Civil Air", start: "108.0000", end: "136.9916" },
    { id: 3, enabled: true, label: "VHF High", start: "137.0000", end: "174.0000" },
    { id: 4, enabled: false, label: "UHF Air", start: "225.0000", end: "380.0000" },
    { id: 5, enabled: false, label: "UHF", start: "400.0000", end: "512.0000" },
    { id: 6, enabled: false, label: "800 MHz", start: "806.0000", end: "960.0000" },
    { id: 7, enabled: false, label: "Range 7", start: "1240.0000", end: "1300.0000" },
    { id: 8, enabled: false, label: "Range 8", start: "0.0000", end: "0.0000" },
    { id: 9, enabled: false, label: "Range 9", start: "0.0000", end: "0.0000" },
    { id: 10, enabled: false, label: "Range 10", start: "0.0000", end: "0.0000" },
  ]);

  const lockedChannels = useMemo(() => {
    if (!lockedChannelIds.length) return [];
    const channelMap = new Map(channels.map((ch) => [ch.index, ch]));
    return lockedChannelIds
      .map((id) => channelMap.get(id))
      .filter((ch): ch is NonNullable<typeof ch> => Boolean(ch));
  }, [channels, lockedChannelIds]);

  const allSelected =
    lockedChannels.length > 0 &&
    lockedChannels.every((channel) => selectedChannels.includes(channel.index));

  useEffect(() => {
    setSelectedChannels((prev) =>
      prev.filter((id) => lockedChannels.some((channel) => channel.index === id)),
    );
  }, [lockedChannels]);

  useEffect(() => {
    if (selectedCategory !== "Locked Channels") return;
    let active = true;
    api
      .getLockouts({ includeFrequencies: false })
      .then((result) => {
        if (!active) return;
        setLockedChannelIds(result.channels ?? []);
      })
      .catch((error) => {
        console.error("Failed to load lockouts", error);
      });
    return () => {
      active = false;
    };
  }, [api, selectedCategory]);

  const programModeSettingsLoaded = useRef(false);

  // Fetch program-mode settings only when user navigates to a program-mode category
  useEffect(() => {
    if (!["Device Config", "Close Call", "Service Search"].includes(selectedCategory)) {
      return;
    }
    if (programModeSettingsLoaded.current) {
      return;
    }

    let active = true;
    const loadSettings = async () => {
      try {
        const [
          squelchRes,
          batteryRes,
          backlightRes,
          contrastRes,
          keyBeepRes,
          priorityRes,
          weatherRes,
          closeCallRes,
          serviceSearchRes,
        ] = await Promise.all([
          api.getSquelch().catch(() => ({ level: 2 })),
          api.getBatterySettings().catch(() => ({ charge_time: 0 })),
          api.getBacklight().catch(() => ({ event: "key_squelch" })),
          api.getContrastSettings().catch(() => ({ level: 7 })),
          api.getKeyBeepSettings().catch(() => ({ level: 0, lock: false })),
          api.getPrioritySettings().catch(() => ({ mode: 0 })),
          api.getWeatherSettings().catch(() => ({ priority: false })),
          api.getCloseCallSettings().catch(() => ({ mode: 0, alert_beep: false, alert_light: false, band: [false, false, false, false, false], lockout: false })),
          api.getServiceSearchSettings().catch(() => ({ groups: Array(8).fill(false) })),
        ]);

        if (!active) return;

        setSquelch(squelchRes.level);
        setBatterySaver(batteryRes.charge_time);
        setBacklight(backlightRes.event);
        setContrast(contrastRes.level);

        // Map key beep level to UI values
        const keyBeepMap: Record<number, string> = { 0: "off", 1: "auto", 2: "level_1" };
        setKeyBeep(keyBeepMap[keyBeepRes.level] || "auto");

        // Map priority mode to UI values
        const priorityMap: Record<number, string> = { 0: "off", 1: "on", 2: "plus" };
        setPriorityMode(priorityMap[priorityRes.mode] || "off");

        setWeatherAlert(weatherRes.priority);

        // Map close call mode to UI values
        const closeCallModeMap: Record<number, string> = { 0: "off", 1: "cc_dnd", 2: "cc_priority" };
        setCloseCallMode(closeCallModeMap[closeCallRes.mode] || "off");
        setCloseCallLockout(closeCallRes.lockout);
        setCloseCallBeep(closeCallRes.alert_beep);
        setCloseCallLight(closeCallRes.alert_light);
        setCloseCallBands(closeCallRes.band);

        setServiceSearchGroups(serviceSearchRes.groups);
        programModeSettingsLoaded.current = true;
      } catch (error) {
        console.error("Failed to load settings", error);
      }
    };

    loadSettings();

    return () => {
      active = false;
    };
  }, [api, selectedCategory]);

  // Load custom search settings AND ranges only when Custom Search category is selected
  // This enters program mode, so we only do it when user explicitly navigates to this section
  useEffect(() => {
    if (selectedCategory !== "Custom Search") return;

    let active = true;
    const loadCustomSearch = async () => {
      try {
        // Load both enabled groups and ranges (both require program mode)
        const [customSearchRes, ...ranges] = await Promise.all([
          api.getCustomSearchSettings().catch(() => ({ groups: Array(10).fill(false) })),
          ...Array.from({ length: 10 }, (_, i) =>
            api.getCustomSearchRange(i + 1).catch(() => ({ index: i + 1, lower: 0, upper: 0 }))
          ),
        ]);

        if (!active) return;

        // Default labels for custom search ranges
        const defaultLabels = [
          "VHF Low", "Civil Air", "VHF High", "UHF Air", "UHF",
          "800 MHz", "Range 7", "Range 8", "Range 9", "Range 10"
        ];

        setSearchRanges(ranges.map((r, idx) => ({
          id: r.index,
          enabled: customSearchRes.groups[idx] || false,
          label: defaultLabels[idx] || `Range ${r.index}`,
          start: r.lower.toFixed(4),
          end: r.upper.toFixed(4),
        })));
      } catch (error) {
        console.error("Failed to load custom search settings", error);
      }
    };

    loadCustomSearch();

    return () => {
      active = false;
    };
  }, [selectedCategory, api]);

  const toggleSelection = useCallback((channelId: number) => {
    setSelectedChannels((prev) =>
      prev.includes(channelId)
        ? prev.filter((value) => value !== channelId)
        : [...prev, channelId],
    );
  }, []);

  const toggleAllSelected = useCallback(
    (checked: boolean) => {
      setSelectedChannels(checked ? lockedChannels.map((ch) => ch.index) : []);
    },
    [lockedChannels],
  );

  const handleUnlockSelected = useCallback(async () => {
    if (selectedChannels.length === 0) {
      toast.info("Select channels to unlock");
      return;
    }
    setIsClearing(true);
    try {
      const result = await api.clearChannelLockouts(selectedChannels);
      const clearedSet = new Set(result.cleared);
      setChannels((prev) =>
        prev.map((channel) =>
          clearedSet.has(channel.index) ? { ...channel, lockout: false } : channel,
        ),
      );
      setLockedChannelIds((prev) => prev.filter((id) => !clearedSet.has(id)));
      setSelectedChannels((prev) => prev.filter((id) => !clearedSet.has(id)));
      toast.success(`${result.cleared.length} channels unlocked`);
    } catch (error) {
      console.error("Failed to unlock channels", error);
      toast.error("Unable to unlock channels");
    } finally {
      setIsClearing(false);
    }
  }, [api, selectedChannels, setChannels]);

  const handleStartSync = useCallback(() => {
    if (!onMemorySync) {
      toast.error("Scanner is not connected");
      return;
    }
    programModeSettingsLoaded.current = false;
    onMemorySync();
  }, [onMemorySync]);

  const handleCategoryClick = useCallback(
    (category: DeviceCategory) => {
      if (category === "Sync") {
        setSelectedCategory(category);
        return;
      }
      setPendingCategory(category);
      setPendingSyncRequested(true);
      setSelectedCategory("Sync");
      handleStartSync();
    },
    [handleStartSync],
  );

  useEffect(() => {
    if (!pendingCategory || !pendingSyncRequested) return;
    if (isMemorySyncing) return;
    setSelectedCategory(pendingCategory);
    setPendingCategory(null);
    setPendingSyncRequested(false);
  }, [isMemorySyncing, pendingCategory, pendingSyncRequested]);


  // Setting handlers
  const handleVolumeChange = useCallback(async (value: number[]) => {
    try {
      await api.setVolume(value[0]);
    } catch (error) {
      console.error("Failed to set volume", error);
      toast.error("Failed to set volume");
    }
  }, [api]);

  const handleSquelchChange = useCallback(async (value: number[]) => {
    const level = value[0];
    setSquelch(level);
    try {
      await api.setSquelch(level);
    } catch (error) {
      console.error("Failed to set squelch", error);
      toast.error("Failed to set squelch");
    }
  }, [api]);

  const handleBatterySaverChange = useCallback(async (value: number[]) => {
    const chargeTime = value[0];
    setBatterySaver(chargeTime);
    try {
      await api.setBatterySettings(chargeTime);
    } catch (error) {
      console.error("Failed to set battery saver", error);
      toast.error("Failed to set battery saver");
    }
  }, [api]);

  const handleBacklightChange = useCallback(async (value: string) => {
    setBacklight(value);
    try {
      await api.setBacklight(value);
    } catch (error) {
      console.error("Failed to set backlight", error);
      toast.error("Failed to set backlight");
    }
  }, [api]);

  const handleContrastChange = useCallback(async (value: number[]) => {
    const level = value[0];
    setContrast(level);
    try {
      await api.setContrastSettings(level);
    } catch (error) {
      console.error("Failed to set contrast", error);
      toast.error("Failed to set contrast");
    }
  }, [api]);

  const handleKeyBeepChange = useCallback(async (value: string) => {
    setKeyBeep(value);
    const levelMap: Record<string, number> = { "off": 0, "auto": 1, "level_1": 2 };
    try {
      await api.setKeyBeepSettings(levelMap[value] || 0, false);
    } catch (error) {
      console.error("Failed to set key beep", error);
      toast.error("Failed to set key beep");
    }
  }, [api]);

  const handlePriorityModeChange = useCallback(async (value: string) => {
    setPriorityMode(value);
    const modeMap: Record<string, number> = { "off": 0, "on": 1, "plus": 2 };
    try {
      await api.setPrioritySettings(modeMap[value] || 0);
    } catch (error) {
      console.error("Failed to set priority mode", error);
      toast.error("Failed to set priority mode");
    }
  }, [api]);

  const handleWeatherAlertChange = useCallback(async (checked: boolean) => {
    setWeatherAlert(checked);
    try {
      await api.setWeatherSettings(checked);
    } catch (error) {
      console.error("Failed to set weather alert", error);
      toast.error("Failed to set weather alert");
    }
  }, [api]);

  const handleCloseCallModeChange = useCallback(async (value: string) => {
    setCloseCallMode(value);
    const modeMap: Record<string, number> = { "off": 0, "cc_dnd": 1, "cc_priority": 2 };
    try {
      await api.setCloseCallSettings({
        mode: modeMap[value] || 0,
        alert_beep: closeCallBeep,
        alert_light: closeCallLight,
        band: closeCallBands,
        lockout: closeCallLockout,
      });
    } catch (error) {
      console.error("Failed to set close call mode", error);
      toast.error("Failed to set close call mode");
    }
  }, [api, closeCallBeep, closeCallLight, closeCallBands, closeCallLockout]);

  const handleCloseCallSettingChange = useCallback(async (setting: string, value: boolean) => {
    const modeMap: Record<string, number> = { "off": 0, "cc_dnd": 1, "cc_priority": 2 };
    const updates: Record<string, boolean> = {
      lockout: closeCallLockout,
      alert_beep: closeCallBeep,
      alert_light: closeCallLight,
      [setting]: value,
    };

    if (setting === "lockout") setCloseCallLockout(value);
    if (setting === "alert_beep") setCloseCallBeep(value);
    if (setting === "alert_light") setCloseCallLight(value);

    try {
      await api.setCloseCallSettings({
        mode: modeMap[closeCallMode] || 0,
        alert_beep: updates.alert_beep,
        alert_light: updates.alert_light,
        band: closeCallBands,
        lockout: updates.lockout,
      });
    } catch (error) {
      console.error("Failed to update close call setting", error);
      toast.error("Failed to update close call setting");
    }
  }, [api, closeCallMode, closeCallLockout, closeCallBeep, closeCallLight, closeCallBands]);

  const handleCloseCallBandToggle = useCallback(async (index: number) => {
    const newBands = [...closeCallBands];
    newBands[index] = !newBands[index];
    setCloseCallBands(newBands);

    const modeMap: Record<string, number> = { "off": 0, "cc_dnd": 1, "cc_priority": 2 };
    try {
      await api.setCloseCallSettings({
        mode: modeMap[closeCallMode] || 0,
        alert_beep: closeCallBeep,
        alert_light: closeCallLight,
        band: newBands,
        lockout: closeCallLockout,
      });
    } catch (error) {
      console.error("Failed to toggle close call band", error);
      toast.error("Failed to toggle close call band");
    }
  }, [api, closeCallMode, closeCallBeep, closeCallLight, closeCallBands, closeCallLockout]);

  const handleServiceSearchToggle = useCallback(async (index: number) => {
    const newGroups = [...serviceSearchGroups];
    newGroups[index] = !newGroups[index];
    setServiceSearchGroups(newGroups);

    try {
      await api.setServiceSearchSettings(newGroups);
    } catch (error) {
      console.error("Failed to toggle service search", error);
      toast.error("Failed to toggle service search");
    }
  }, [api, serviceSearchGroups]);

  const toggleRange = useCallback(async (id: number) => {
    const newRanges = searchRanges.map((r) =>
      r.id === id ? { ...r, enabled: !r.enabled } : r
    );
    setSearchRanges(newRanges);

    try {
      await api.setCustomSearchSettings(newRanges.map(r => r.enabled));
    } catch (error) {
      console.error("Failed to toggle search range", error);
      toast.error("Failed to toggle search range");
    }
  }, [api, searchRanges]);

  const updateRange = useCallback(async (id: number, field: "start" | "end" | "label", value: string) => {
    const newRanges = searchRanges.map((r) =>
      r.id === id ? { ...r, [field]: value } : r
    );
    setSearchRanges(newRanges);

    // Update backend if start or end changed
    if (field === "start" || field === "end") {
      const range = newRanges.find(r => r.id === id);
      if (range) {
        try {
          await api.setCustomSearchRange(id, parseFloat(range.start), parseFloat(range.end));
        } catch (error) {
          console.error("Failed to update search range", error);
          toast.error("Failed to update search range");
        }
      }
    }
  }, [api, searchRanges]);

  const activeRangeCount = searchRanges.filter((r) => r.enabled).length;

  const volume = liveState?.volume ?? 0;

  const categories: DeviceCategory[] = [
    "Locked Channels",
    "Device Config",
    "Close Call",
    "Service Search",
    "Custom Search",
    "Preferences",
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex h-full gap-6"
    >
      {/* Side Nav */}
      <div className="w-[200px] flex flex-col gap-1 bg-black/20 rounded-lg p-2 border border-white/5 h-full">
        {["Sync", "Locked Channels", "Device Config", "Close Call", "Service Search", "Custom Search"].map((cat) => (
          <button
            key={cat}
            onClick={() => handleCategoryClick(cat as DeviceCategory)}
            className={cn(
              "text-left px-3 py-2 rounded text-xs font-medium transition-colors",
              selectedCategory === cat
                ? "bg-[#d97706]/20 text-[#d97706]"
                : "text-white/60 hover:bg-white/5 hover:text-white",
            )}
          >
            {cat}
          </button>
        ))}
        <div className="mt-2 border-t border-white/10" />

        {/* Preferences at bottom */}
        <button
          onClick={() => setSelectedCategory("Preferences")}
          className={cn(
            "text-left px-3 py-2 rounded text-xs font-medium transition-colors mt-auto border-t border-white/10 pt-3",
            selectedCategory === "Preferences"
              ? "bg-[#d97706]/20 text-[#d97706]"
              : "text-white/60 hover:bg-white/5 hover:text-white",
          )}
        >
          Preferences
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 bg-black/20 rounded-lg border border-white/5 p-6 h-full overflow-y-auto">
        {selectedCategory !== "Locked Channels" && (
          <h2 className="text-lg font-bold mb-6 border-b border-white/10 pb-2 flex items-center justify-between">
            <span>{selectedCategory}</span>
            {selectedCategory === "Custom Search" && (
              <span className="text-xs font-normal text-white/50">
                {activeRangeCount} of 10 active
              </span>
            )}
          </h2>
        )}

        {/* Sync */}
        {selectedCategory === "Sync" && (
          <div className="max-w-3xl space-y-6">
            <div className="bg-white/5 rounded-lg border border-white/10 p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded bg-[#ef991f]/10 text-[#ef991f] border border-[#ef991f]/20">
                  <RefreshCcw className={cn("w-4 h-4", isMemorySyncing && "animate-spin")} />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white">Program Mode Sync</h2>
                  <p className="text-xs text-white/50">
                    Configuration pages read from scanner memory and require program mode.
                  </p>
                </div>
              </div>

              <div className="text-sm text-white/60 leading-relaxed space-y-2">
                <p>
                  When you start a sync, the scanner switches into program mode and scanning pauses until
                  the sync completes.
                </p>
                <p>
                  Use this before opening Device Config, Close Call, Service Search, or Custom Search to
                  ensure the data reflects the device.
                </p>
              </div>

              <div className="flex items-center gap-3">
                <button
                  onClick={() => handleStartSync()}
                  disabled={!onMemorySync}
                  className="px-4 py-2 rounded bg-[#ef991f] hover:bg-[#d97706] text-black text-xs font-bold uppercase tracking-wider shadow-[0px_0px_15px_rgba(239,153,31,0.3)] hover:shadow-[0px_0px_20px_rgba(239,153,31,0.5)] transition-all flex items-center gap-2 disabled:opacity-50"
                >
                  <RefreshCcw className={cn("w-3 h-3", isMemorySyncing && "animate-spin")} />
                  {isMemorySyncing ? "Syncing..." : "Start Sync"}
                </button>
                <span className="text-xs text-white/40">PGM mode required</span>
              </div>
            </div>
          </div>
        )}

        {/* Locked Channels */}
        {selectedCategory === "Locked Channels" && (
          <div className="flex flex-col h-full max-w-5xl mx-auto">
            {/* Header Bar */}
            <div className="flex items-start justify-between mb-8 pb-6 border-b border-white/5">
              <div>
                <h2 className="text-2xl font-bold text-white flex items-center gap-3">
                  <span className="p-2 rounded bg-red-500/10 text-red-500 border border-red-500/20">
                    <Lock className="w-5 h-5" />
                  </span>
                  Locked Signals
                </h2>
                <p className="text-sm text-white/50 mt-2 pl-1">
                  {lockedChannels.length} frequencies permanently locked out
                </p>
              </div>

              <div className="flex gap-4 items-center">
                <button
                  onClick={() => toggleAllSelected(!allSelected)}
                  className="text-xs font-medium text-white/50 hover:text-white transition-colors uppercase tracking-wider px-3 py-1.5"
                >
                  {allSelected ? "Deselect All" : "Select All"}
                </button>

                {selectedChannels.length > 0 && (
                  <button
                    onClick={handleUnlockSelected}
                    disabled={isClearing}
                    className="px-5 py-2 rounded bg-[#ef991f] hover:bg-[#d97706] text-black text-xs font-bold uppercase tracking-wider shadow-[0px_0px_15px_rgba(239,153,31,0.3)] hover:shadow-[0px_0px_20px_rgba(239,153,31,0.5)] transition-all flex items-center gap-2 disabled:opacity-50"
                  >
                    <Lock className="w-3 h-3" />
                    Unlock ({selectedChannels.length})
                  </button>
                )}
              </div>
            </div>

            {/* Signal Matrix Grid */}
            <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto pr-2 pb-10">
              {lockedChannels.map((channel) => (
                <div
                  key={channel.index}
                  onClick={() => toggleSelection(channel.index)}
                  className={cn(
                    "relative p-4 rounded border transition-all duration-200 cursor-pointer group flex flex-col gap-1 overflow-hidden",
                    selectedChannels.includes(channel.index)
                      ? "bg-[#ef991f]/10 border-[#ef991f] shadow-[inset_0_0_20px_rgba(239,153,31,0.1)]"
                      : "bg-white/5 border-white/5 hover:border-white/20 hover:bg-white/10",
                  )}
                >
                  {/* Status Light */}
                  <div
                    className={cn(
                      "absolute top-3 right-3 w-1.5 h-1.5 rounded-full transition-colors shadow-[0_0_5px_currentColor]",
                      selectedChannels.includes(channel.index)
                        ? "bg-[#ef991f] text-[#ef991f]"
                        : "bg-red-500/50 text-red-500",
                    )}
                  />

                  {/* Frequency */}
                  <div
                    className={cn(
                      "font-mono text-xl font-bold tracking-tight transition-colors",
                      selectedChannels.includes(channel.index)
                        ? "text-[#ef991f]"
                        : "text-white/90",
                    )}
                  >
                    {channel.frequency.toFixed(4)}
                  </div>

                  {/* Label */}
                  <div className="text-[10px] font-medium text-white/40 uppercase tracking-widest truncate group-hover:text-white/60 transition-colors">
                    {channel.alpha_tag || `CH ${channel.index}`}
                  </div>

                  {/* Selection Corner Visual */}
                  {selectedChannels.includes(channel.index) && (
                    <div className="absolute bottom-0 right-0 p-1">
                      <svg
                        width="10"
                        height="10"
                        viewBox="0 0 10 10"
                        fill="none"
                        className="text-[#ef991f]"
                      >
                        <path d="M10 0V10H0L10 0Z" fill="currentColor" opacity="0.5" />
                      </svg>
                    </div>
                  )}
                </div>
              ))}

              {lockedChannels.length === 0 && (
                <div className="col-span-full py-20 flex flex-col items-center justify-center text-white/30 border border-dashed border-white/10 rounded-lg">
                  <Lock className="w-8 h-8 mb-4 opacity-50" />
                  <p className="text-sm">No locked frequencies</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Device Config */}
        {selectedCategory === "Device Config" && (
          <div className="space-y-6 max-w-4xl">
            <div className="grid grid-cols-2 gap-6">
              {/* Audio Control */}
              <div className="bg-white/5 rounded-lg border border-white/10 p-5 space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="p-1.5 bg-orange-500/20 rounded text-orange-400">
                    <Radio size={16} />
                  </div>
                  <h3 className="font-bold text-white">Audio & Power</h3>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-xs font-medium text-white/70">
                    <span>Volume</span>
                    <span className="text-white">{volume}</span>
                  </div>
                  <Slider value={[volume]} max={15} step={1} onValueChange={handleVolumeChange} />
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-xs font-medium text-white/70">
                    <span>Squelch</span>
                    <span className="text-white">{squelch}</span>
                  </div>
                  <Slider value={[squelch]} max={15} step={1} onValueChange={handleSquelchChange} />
                </div>

                <div className="space-y-3 pt-2 border-t border-white/5">
                  <div className="flex justify-between text-xs font-medium text-white/70">
                    <span>Battery Saver</span>
                    <span className="text-white">{batterySaver === 0 ? "Off" : `${batterySaver}h`}</span>
                  </div>
                  <Slider value={[batterySaver]} max={5} step={1} onValueChange={handleBatterySaverChange} />
                </div>
              </div>

              {/* Display Settings */}
              <div className="bg-white/5 rounded-lg border border-white/10 p-5 space-y-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="p-1.5 bg-blue-500/20 rounded text-blue-400">
                    <Maximize2 size={16} />
                  </div>
                  <h3 className="font-bold text-white">Display & System</h3>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-white/70">Backlight</span>
                    <Select value={backlight} onValueChange={handleBacklightChange}>
                      <SelectTrigger className="w-[140px] h-7 text-xs bg-black/20 border-white/10">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[#1c1f26] border-white/10 text-white">
                        <SelectItem value="always_on">Always On</SelectItem>
                        <SelectItem value="key_squelch">Key/Squelch</SelectItem>
                        <SelectItem value="manual">Manual</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-white/70">Contrast</span>
                    <Slider value={[contrast]} max={15} step={1} className="w-[140px]" onValueChange={handleContrastChange} />
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-white/5">
                    <span className="text-xs font-medium text-white/70">Key Beep</span>
                    <Select value={keyBeep} onValueChange={handleKeyBeepChange}>
                      <SelectTrigger className="w-[140px] h-7 text-xs bg-black/20 border-white/10">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="bg-[#1c1f26] border-white/10 text-white">
                        <SelectItem value="auto">Auto</SelectItem>
                        <SelectItem value="level_1">Level 1</SelectItem>
                        <SelectItem value="off">Off</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </div>

            {/* Scanning Logic */}
            <div className="bg-white/5 rounded-lg border border-white/10 p-5 space-y-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="p-1.5 bg-green-500/20 rounded text-green-400">
                  <Signal size={16} />
                </div>
                <h3 className="font-bold text-white">Scanning Logic</h3>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-white/70">Priority Mode</span>
                  <Select value={priorityMode} onValueChange={handlePriorityModeChange}>
                    <SelectTrigger className="w-[140px] h-7 text-xs bg-black/20 border-white/10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1c1f26] border-white/10 text-white">
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="on">On</SelectItem>
                      <SelectItem value="plus">Plus</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-3">
                  <Switch
                    id="weather-alert"
                    className="scale-75"
                    checked={weatherAlert}
                    onCheckedChange={handleWeatherAlertChange}
                  />
                  <label
                    htmlFor="weather-alert"
                    className="text-xs font-medium text-white/70 cursor-pointer"
                  >
                    Weather Alert Priority
                  </label>
                </div>
              </div>
            </div>

            {/* Device Info */}
            <div className="bg-white/5 rounded-lg border border-white/10 p-5 space-y-3">
              <h3 className="font-bold text-white text-sm mb-4">Device Information</h3>
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div className="flex justify-between">
                  <span className="text-white/50">Model</span>
                  <span className="text-white">{deviceInfo?.model ?? "BC125AT"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Port</span>
                  <span className="text-white">{deviceInfo?.port ?? "USB"}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Status</span>
                  <span className="text-white">
                    {deviceInfo?.connection_status === "connected" ? "Connected" : "Disconnected"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Firmware</span>
                  <span className="text-white">{deviceInfo?.firmware ?? "—"}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Close Call */}
        {selectedCategory === "Close Call" && (
          <div className="grid grid-cols-2 gap-8 max-w-4xl">
            <div className="space-y-8">
              <section className="space-y-4">
                <h3 className="text-lg font-bold text-white">Settings</h3>

                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-xs font-medium text-white/70">Mode</span>
                    <span className="text-[10px] text-white/40">Operation mode</span>
                  </div>
                  <Select value={closeCallMode} onValueChange={handleCloseCallModeChange}>
                    <SelectTrigger className="w-[180px] h-8 text-xs bg-white/5 border-white/10">
                      <SelectValue placeholder="Select mode" />
                    </SelectTrigger>
                    <SelectContent className="bg-[#1c1f26] border-white/10 text-white">
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="cc_dnd">CC DND</SelectItem>
                      <SelectItem value="cc_priority">CC Priority</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <Switch
                    id="cc-lockout"
                    checked={closeCallLockout}
                    onCheckedChange={(checked) => handleCloseCallSettingChange("lockout", checked)}
                  />
                  <label
                    htmlFor="cc-lockout"
                    className="text-xs font-medium text-white/70 cursor-pointer"
                  >
                    Lockout Hits While Scanning
                  </label>
                </div>
              </section>

              <section className="space-y-4">
                <h3 className="text-lg font-bold text-white">Alerts</h3>

                <div className="flex items-center gap-3">
                  <Switch
                    id="cc-beep"
                    checked={closeCallBeep}
                    onCheckedChange={(checked) => handleCloseCallSettingChange("alert_beep", checked)}
                  />
                  <label
                    htmlFor="cc-beep"
                    className="text-xs font-medium text-white/70 cursor-pointer"
                  >
                    Alert Beep
                  </label>
                </div>

                <div className="flex items-center gap-3">
                  <Switch
                    id="cc-light"
                    checked={closeCallLight}
                    onCheckedChange={(checked) => handleCloseCallSettingChange("alert_light", checked)}
                  />
                  <label
                    htmlFor="cc-light"
                    className="text-xs font-medium text-white/70 cursor-pointer"
                  >
                    Alert Light
                  </label>
                </div>
              </section>
            </div>

            <section className="space-y-4">
              <h3 className="text-lg font-bold text-white">Enabled Bands</h3>
              <div className="bg-white/5 rounded-lg p-4 space-y-4 border border-white/10">
                {["VHF Low", "Air", "VHF High 1", "VHF High 2", "UHF"].map((band, index) => (
                  <div key={band} className="flex items-center justify-between">
                    <label
                      htmlFor={`band-${band}`}
                      className="text-xs font-medium text-white/70 cursor-pointer"
                    >
                      {band}
                    </label>
                    <Switch
                      id={`band-${band}`}
                      checked={closeCallBands[index]}
                      onCheckedChange={() => handleCloseCallBandToggle(index)}
                    />
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* Service Search */}
        {selectedCategory === "Service Search" && (
          <div className="max-w-3xl">
            <div className="bg-white/5 rounded-lg border border-white/10 p-8">
              <div className="grid grid-cols-2 gap-x-16 gap-y-6">
                {[
                  "Police",
                  "Fire/Emergency",
                  "Ham",
                  "Marine",
                  "Railroad",
                  "Civil Air",
                  "Military Air",
                  "CB",
                ].map((service, index) => (
                  <div key={service} className="flex items-center justify-between group">
                    <label
                      htmlFor={`service-${service}`}
                      className="text-sm font-medium text-white/70 group-hover:text-white transition-colors cursor-pointer"
                    >
                      {service}
                    </label>
                    <Switch
                      id={`service-${service}`}
                      checked={serviceSearchGroups[index]}
                      onCheckedChange={() => handleServiceSearchToggle(index)}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Custom Search */}
        {selectedCategory === "Custom Search" && (
          <div className="flex flex-col max-w-5xl mx-auto overflow-hidden gap-4">
            <div className="flex-1 h-full bg-black/20 rounded-lg border border-white/5 overflow-hidden flex flex-col shadow-inner">
              {/* Table Header */}
              <div className="grid grid-cols-[50px_60px_1fr_100px_100px] gap-2 px-4 py-2 bg-white/5 text-[10px] font-bold text-white/30 uppercase tracking-wider border-b border-white/5 shrink-0 select-none">
                <div className="text-center">Active</div>
                <div>Range</div>
                <div>Label</div>
                <div className="text-center">Lower (MHz)</div>
                <div className="text-center">Upper (MHz)</div>
              </div>

              {/* Table Body */}
              <div className="flex-1 flex flex-col min-h-0">
                {searchRanges.map((range) => (
                  <div
                    key={range.id}
                    className={cn(
                      "flex-1 grid grid-cols-[50px_60px_1fr_100px_100px] gap-2 px-4 items-center border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors group min-h-[36px]",
                      range.enabled && "bg-[#ef991f]/5",
                    )}
                  >
                    <div className="flex justify-center">
                      <Switch
                        checked={range.enabled}
                        onCheckedChange={() => toggleRange(range.id)}
                        className={cn(
                          "scale-[0.6] data-[state=checked]:bg-[#ef991f]",
                          !range.enabled && "opacity-50",
                        )}
                      />
                    </div>

                    <div className="text-[10px] font-mono font-bold text-white/30 group-hover:text-white/50 pl-1">
                      R-{range.id}
                    </div>

                    <div className="relative">
                      <input
                        value={range.label}
                        onChange={(e) => updateRange(range.id, "label", e.target.value)}
                        className={cn(
                          "w-full bg-transparent border-none outline-none text-xs font-medium tracking-wide transition-colors placeholder:text-white/10",
                          range.enabled ? "text-white/80" : "text-white/30",
                        )}
                        placeholder="Label..."
                      />
                    </div>

                    <div className="relative">
                      <input
                        type="text"
                        value={range.start}
                        onChange={(e) => updateRange(range.id, "start", e.target.value)}
                        className={cn(
                          "w-full bg-transparent border-b border-transparent focus:border-[#ef991f] text-xs font-mono font-bold text-center outline-none transition-all py-0",
                          range.enabled
                            ? "text-[#ef991f] group-hover:text-[#ffb045]"
                            : "text-white/30 group-hover:border-white/10",
                        )}
                      />
                    </div>

                    <div className="relative">
                      <input
                        type="text"
                        value={range.end}
                        onChange={(e) => updateRange(range.id, "end", e.target.value)}
                        className={cn(
                          "w-full bg-transparent border-b border-transparent focus:border-[#ef991f] text-xs font-mono font-bold text-center outline-none transition-all py-0",
                          range.enabled
                            ? "text-[#ef991f] group-hover:text-[#ffb045]"
                            : "text-white/30 group-hover:border-white/10",
                        )}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Preferences */}
        {selectedCategory === "Preferences" && (
          <div className="flex max-h-[404px] gap-6 overflow-hidden">
            {/* Info Sidebar (Left) */}
            <div className="w-[260px] flex flex-col gap-4 overflow-y-auto shrink-0 pb-4 pr-4 border-r border-white/5">
              <div className="space-y-3">
                <div className="bg-white/5 rounded-lg border border-white/5 p-4 space-y-3">
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-8 h-8 rounded bg-[#ef991f] flex items-center justify-center text-black font-bold text-xs shadow-lg shadow-orange-500/20">
                      BP
                    </div>
                    <div>
                      <h3 className="font-bold text-white text-sm">Bearpaw</h3>
                      <div className="text-[10px] text-white/40">v2.4.0-beta</div>
                    </div>
                  </div>
                  <p className="text-xs text-white/60 leading-relaxed">
                    Community-developed control software for Uniden scanners.
                  </p>
                  <div className="flex gap-2 pt-2">
                    <button className="flex-1 py-1.5 bg-black/20 hover:bg-black/40 rounded text-[10px] text-white/70 transition-colors border border-white/5 flex items-center justify-center gap-1.5">
                      <ExternalLink size={10} /> Website
                    </button>
                    <button className="flex-1 py-1.5 bg-black/20 hover:bg-black/40 rounded text-[10px] text-white/70 transition-colors border border-white/5 flex items-center justify-center gap-1.5">
                      <Code size={10} /> Github
                    </button>
                  </div>
                </div>
              </div>

              <div className="relative overflow-hidden group rounded-lg">
                <div className="absolute inset-0 bg-gradient-to-br from-orange-500/20 to-orange-900/10" />
                <div className="relative p-4 space-y-3 border border-orange-500/20 rounded-lg">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-orange-500/20 rounded-full">
                      <Coffee className="w-3.5 h-3.5 text-orange-400" />
                    </div>
                    <h3 className="text-xs font-bold text-white">Support Dev</h3>
                  </div>
                  <p className="text-[10px] text-white/60 leading-relaxed">
                    Enjoying the app? A $10 donation helps keep updates coming!
                  </p>
                  <button className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-orange-500 hover:bg-orange-600 text-white text-xs font-bold rounded transition-colors shadow-lg shadow-orange-900/20">
                    <Heart className="w-3 h-3 fill-white/20" />
                    Donate $10
                  </button>
                </div>
              </div>
            </div>

            {/* Main Settings Area (Right) */}
            <div className="flex-1 overflow-y-auto pr-2 space-y-6 max-h-[404px]">
              <div className="flex items-center justify-between border-b border-white/5 pb-4">
                <div>
                  <h2 className="text-2xl font-bold text-white">Application Settings</h2>
                  <p className="text-sm text-white/50">Manage your workspace preferences</p>
                </div>
                <button className="text-xs text-[#ef991f] hover:text-[#ffb045] font-medium transition-colors">
                  Reset to Defaults
                </button>
              </div>

              {/* General Settings */}
              <section className="space-y-4">
                <h3 className="text-sm font-bold text-white/80 flex items-center gap-2 uppercase tracking-wider">
                  <Settings className="w-4 h-4 text-white/50" /> General
                </h3>
                <div className="bg-black/20 rounded-lg border border-white/5 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <label className="text-sm font-medium text-white">
                        Auto-Connect on Startup
                      </label>
                      <p className="text-xs text-white/40">
                        Automatically connect to the last used device
                      </p>
                    </div>
                    <Switch defaultChecked />
                  </div>
                  <div className="h-px bg-white/5" />
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <label className="text-sm font-medium text-white">
                        Start in Dashboard Mode
                      </label>
                      <p className="text-xs text-white/40">
                        Launch directly into the dashboard view
                      </p>
                    </div>
                    <Switch />
                  </div>
                  <div className="h-px bg-white/5" />
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <label className="text-sm font-medium text-white">Check for Updates</label>
                      <p className="text-xs text-white/40">
                        Notify when a new firmware version is available
                      </p>
                    </div>
                    <Switch defaultChecked />
                  </div>
                </div>
              </section>

              {/* Audio Settings */}
              <section className="space-y-4">
                <h3 className="text-sm font-bold text-white/80 flex items-center gap-2 uppercase tracking-wider">
                  <Radio className="w-4 h-4 text-white/50" /> Audio & Recording
                </h3>
                <div className="bg-black/20 rounded-lg border border-white/5 p-4 space-y-6">
                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <label className="text-sm font-medium text-white">Audio Output Device</label>
                      <span className="text-xs text-white/40">System Default</span>
                    </div>
                    <Select defaultValue="default">
                      <SelectTrigger className="w-full bg-white/5 border-white/10 text-xs">
                        <SelectValue placeholder="Select device" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#1c1f26] border-white/10 text-white">
                        <SelectItem value="default">System Default</SelectItem>
                        <SelectItem value="speakers">Speakers (Realtek Audio)</SelectItem>
                        <SelectItem value="headphones">Headphones (USB Audio)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-3">
                    <div className="flex justify-between">
                      <label className="text-sm font-medium text-white">Recording Buffer Size</label>
                      <span className="text-xs text-white/40">2048 samples</span>
                    </div>
                    <Slider defaultValue={[50]} max={100} step={1} />
                  </div>
                </div>
              </section>

              {/* Data Settings */}
              <section className="space-y-4">
                <h3 className="text-sm font-bold text-white/80 flex items-center gap-2 uppercase tracking-wider">
                  <FileText className="w-4 h-4 text-white/50" /> Data & Storage
                </h3>
                <div className="bg-black/20 rounded-lg border border-white/5 p-4 space-y-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5 flex-1">
                      <label className="text-sm font-medium text-white">Recordings Location</label>
                      <div className="flex gap-2 mt-1">
                        <input
                          type="text"
                          value="~/Documents/Bearpaw/recordings"
                          readOnly
                          className="w-full bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-white/60 font-mono"
                        />
                      </div>
                    </div>
                    <button className="px-3 py-1 bg-white/5 hover:bg-white/10 rounded text-xs border border-white/5 h-fit mt-auto">
                      Change
                    </button>
                  </div>

                  <div className="h-px bg-white/5" />

                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <label className="text-sm font-medium text-white">Data Retention</label>
                      <p className="text-xs text-white/40">Auto-delete older recordings & logs</p>
                    </div>
                    <Select defaultValue="forever">
                      <SelectTrigger className="w-[140px] bg-white/5 border-white/10 text-white h-8 text-xs">
                        <SelectValue placeholder="Select retention" />
                      </SelectTrigger>
                      <SelectContent className="bg-[#1a1a1a] border-white/10 text-white">
                        <SelectItem value="forever">Keep Forever</SelectItem>
                        <SelectItem value="30days">30 Days</SelectItem>
                        <SelectItem value="90days">90 Days</SelectItem>
                        <SelectItem value="1year">1 Year</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  );
}
