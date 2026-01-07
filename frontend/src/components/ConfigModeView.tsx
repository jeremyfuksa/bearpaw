import { useEffect, useMemo, useRef, useState } from "react";

import { useAPI } from "../api/useApi";
import { useStore } from "../store/useStore";
import { useNotifications } from "../hooks/useNotifications";
import type { CloseCallSettings, CustomSearchRange } from "../types";

// New category components
import { DeviceStatusHeader } from "./config/DeviceStatusHeader";
import { CategoryNav } from "./config/CategoryNav";
import { LockedChannelsCategory } from "./config/LockedChannelsCategory";
import { AudioCategory } from "./config/AudioCategory";
import { DisplayCategory } from "./config/DisplayCategory";
import { PowerKeysCategory } from "./config/PowerKeysCategory";
import { PriorityWeatherCategory } from "./config/PriorityWeatherCategory";
import { SearchCategory } from "./config/SearchCategory";
import { CloseCallCategory } from "./config/CloseCallCategory";
import { ServiceSearchCategory } from "./config/ServiceSearchCategory";
import { CustomSearchCategory } from "./config/CustomSearchCategory";

const defaultCloseCallBand = [false, false, false, false, false];

const buildDefaultRanges = (): CustomSearchRange[] =>
  Array.from({ length: 10 }, (_, index) => ({
    index: index + 1,
    lower: 0,
    upper: 0,
  }));

export function ConfigModeView() {
  const deviceInfo = useStore((state) => state.deviceInfo);
  const liveState = useStore((state) => state.liveState);
  const connected = useStore((state) => state.connected);
  const channels = useStore((state) => state.channels);
  const setChannels = useStore((state) => state.setChannels);
  const api = useAPI();
  const { addNotification } = useNotifications();
  const [selectedChannels, setSelectedChannels] = useState<number[]>([]);
  const [volumeLevel, setVolumeLevel] = useState(liveState?.volume ?? 0);
  const [squelchLevel, setSquelchLevel] = useState(0);
  const [firmware, setFirmware] = useState<string | null>(null);
  const [backlight, setBacklight] = useState("AO");
  const [batteryChargeTime, setBatteryChargeTime] = useState(1);
  const [keyBeepLevel, setKeyBeepLevel] = useState(0);
  const [keyLock, setKeyLock] = useState(false);
  const [priorityMode, setPriorityMode] = useState(0);
  const [searchDelay, setSearchDelay] = useState(0);
  const [searchCode, setSearchCode] = useState(false);
  const [closeCallMode, setCloseCallMode] = useState(0);
  const [closeCallBeep, setCloseCallBeep] = useState(false);
  const [closeCallLight, setCloseCallLight] = useState(false);
  const [closeCallBand, setCloseCallBand] = useState<boolean[]>(defaultCloseCallBand);
  const [closeCallLockout, setCloseCallLockout] = useState(false);
  const [serviceSearchGroups, setServiceSearchGroups] = useState<boolean[]>(
    Array.from({ length: 10 }, () => false)
  );
  const [customSearchGroups, setCustomSearchGroups] = useState<boolean[]>(
    Array.from({ length: 10 }, () => false)
  );
  const [customSearchRanges, setCustomSearchRanges] = useState<CustomSearchRange[]>(
    buildDefaultRanges()
  );
  const [weatherPriority, setWeatherPriority] = useState(false);
  const [contrast, setContrast] = useState(10);

  // Category navigation state
  const [activeCategory, setActiveCategory] = useState<string>(() => {
    return localStorage.getItem('config-active-category') || 'locked-channels';
  });
  const [isMobileView, setIsMobileView] = useState(false);

  // Persist active category
  useEffect(() => {
    localStorage.setItem('config-active-category', activeCategory);
  }, [activeCategory]);

  // Detect mobile view
  useEffect(() => {
    const handleResize = () => {
      setIsMobileView(window.innerWidth <= 768);
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const lockedChannels = useMemo(
    () => channels.filter((channel) => channel.lockout),
    [channels]
  );
  const allSelected =
    lockedChannels.length > 0 &&
    lockedChannels.every((channel) => selectedChannels.includes(channel.index));
  const anySelected = selectedChannels.length > 0;
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const liveModeRef = useRef<string | null>(null);

  useEffect(() => {
    liveModeRef.current = liveState?.mode ?? null;
  }, [liveState?.mode]);

  const handleClearSelected = async () => {
    if (selectedChannels.length === 0) return;
    try {
      const result = await api.clearChannelLockouts(selectedChannels);
      addNotification({
        type: result.failed.length > 0 ? "warning" : "info",
        message:
          result.failed.length > 0
            ? `Cleared ${result.cleared.length} channel lockouts, ${result.failed.length} failed`
            : `Cleared ${result.cleared.length} channel lockouts`,
        duration: 2500,
      });
      if (result.cleared.length > 0) {
        setSelectedChannels((prev) =>
          prev.filter((channelId) => !result.cleared.includes(channelId))
        );
        setChannels(
          channels.map((channel) =>
            result.cleared.includes(channel.index) ? { ...channel, lockout: false } : channel
          )
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to clear selected lockouts: ${message}`,
        duration: 3000,
      });
    }
  };

  const handleToggleChannel = (channelId: number) => {
    setSelectedChannels((prev) =>
      prev.includes(channelId)
        ? prev.filter((value) => value !== channelId)
        : [...prev, channelId]
    );
  };

  const handleSelectAll = () => {
    if (allSelected) {
      setSelectedChannels([]);
      return;
    }
    setSelectedChannels(lockedChannels.map((channel) => channel.index));
  };

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = !allSelected && anySelected;
  }, [allSelected, anySelected]);

  useEffect(() => {
    if (typeof liveState?.volume === "number") {
      setVolumeLevel(liveState.volume);
    }
  }, [liveState?.volume]);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    const loadConfig = async () => {
      const preMode = (liveModeRef.current ?? "").toString().trim().toUpperCase();
      try {
        const [config, squelch] = await Promise.all([api.getConfig(), api.getSquelch()]);
        if (!active) return;
        setFirmware(config.firmware ?? null);
        setBacklight(config.backlight?.event ?? "AO");
        setBatteryChargeTime(config.battery?.charge_time ?? 1);
        setKeyBeepLevel(config.key_beep?.level ?? 0);
        setKeyLock(config.key_beep?.lock ?? false);
        setPriorityMode(config.priority?.mode ?? 0);
        setSearchDelay(config.search?.delay ?? 0);
        setSearchCode(config.search?.code_search ?? false);
        setCloseCallMode(config.close_call?.mode ?? 0);
        setCloseCallBeep(config.close_call?.alert_beep ?? false);
        setCloseCallLight(config.close_call?.alert_light ?? false);
        setCloseCallBand(config.close_call?.band ?? defaultCloseCallBand);
        setCloseCallLockout(config.close_call?.lockout ?? false);
        setServiceSearchGroups(config.service_search?.groups ?? Array(10).fill(false));
        setCustomSearchGroups(config.custom_search?.groups ?? Array(10).fill(false));
        setCustomSearchRanges(
          config.custom_search_ranges?.length ? config.custom_search_ranges : buildDefaultRanges()
        );
        setWeatherPriority(config.weather?.priority ?? false);
        setContrast(config.contrast?.level ?? 10);
        setSquelchLevel(squelch.level);
        if (preMode === "SCAN") {
          await api.sendScan();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Request failed";
        addNotification({
          type: "error",
          message: `Failed to load configuration: ${message}`,
          duration: 2500,
        });
      }
    };
    loadConfig();
    return () => {
      active = false;
    };
  }, [addNotification, api, connected]);

  const getErrorMessage = (error: unknown) =>
    error instanceof Error ? error.message : "Request failed";

  const commitVolume = async (value: number) => {
    let setSucceeded = true;
    try {
      await api.setVolume(value);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set volume: ${message}`,
        duration: 2500,
      });
    }
    if (!setSucceeded && typeof liveState?.volume === "number") {
      setVolumeLevel(liveState.volume);
    }
  };

  const commitSquelch = async (value: number) => {
    let setSucceeded = true;
    try {
      await api.setSquelch(value);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set squelch: ${message}`,
        duration: 2500,
      });
    }
    try {
      const squelch = await api.getSquelch();
      setSquelchLevel(squelch.level);
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh squelch: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitBacklight = async (value: string) => {
    let setSucceeded = true;
    try {
      await api.setBacklight(value);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set backlight: ${message}`,
        duration: 2500,
      });
    }
    try {
      const backlightSettings = await api.getBacklight();
      setBacklight(backlightSettings.event ?? "AO");
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh backlight: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitBatteryChargeTime = async (value: number) => {
    let setSucceeded = true;
    try {
      await api.setBatterySettings(value);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set battery charge time: ${message}`,
        duration: 2500,
      });
    }
    try {
      const batterySettings = await api.getBatterySettings();
      setBatteryChargeTime(batterySettings.charge_time ?? 1);
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh battery charge time: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitKeyBeep = async (level: number, lock: boolean) => {
    let setSucceeded = true;
    try {
      await api.setKeyBeepSettings(level, lock);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set key beep: ${message}`,
        duration: 2500,
      });
    }
    try {
      const keyBeepSettings = await api.getKeyBeepSettings();
      setKeyBeepLevel(keyBeepSettings.level ?? 0);
      setKeyLock(keyBeepSettings.lock ?? false);
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh key beep: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitPriority = async (mode: number) => {
    let setSucceeded = true;
    try {
      await api.setPrioritySettings(mode);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set priority: ${message}`,
        duration: 2500,
      });
    }
    try {
      const prioritySettings = await api.getPrioritySettings();
      setPriorityMode(prioritySettings.mode ?? 0);
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh priority: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitSearchSettings = async (delay: number, codeSearch: boolean) => {
    let setSucceeded = true;
    try {
      await api.setSearchSettings(delay, codeSearch);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set search settings: ${message}`,
        duration: 2500,
      });
    }
    try {
      const searchSettings = await api.getSearchSettings();
      setSearchDelay(searchSettings.delay ?? 0);
      setSearchCode(searchSettings.code_search ?? false);
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh search settings: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitCloseCall = async (payload: CloseCallSettings) => {
    let setSucceeded = true;
    try {
      await api.setCloseCallSettings(payload);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set Close Call: ${message}`,
        duration: 2500,
      });
    }
    try {
      const closeCallSettings = await api.getCloseCallSettings();
      setCloseCallMode(closeCallSettings.mode ?? 0);
      setCloseCallBeep(closeCallSettings.alert_beep ?? false);
      setCloseCallLight(closeCallSettings.alert_light ?? false);
      setCloseCallBand(closeCallSettings.band ?? defaultCloseCallBand);
      setCloseCallLockout(closeCallSettings.lockout ?? false);
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh Close Call: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitServiceSearchGroups = async (groups: boolean[]) => {
    let setSucceeded = true;
    try {
      await api.setServiceSearchSettings(groups);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set service search: ${message}`,
        duration: 2500,
      });
    }
    try {
      const serviceSearchSettings = await api.getServiceSearchSettings();
      setServiceSearchGroups(serviceSearchSettings.groups ?? Array(10).fill(false));
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh service search: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitCustomSearchGroups = async (groups: boolean[]) => {
    let setSucceeded = true;
    try {
      await api.setCustomSearchSettings(groups);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set custom search: ${message}`,
        duration: 2500,
      });
    }
    try {
      const customSearchSettings = await api.getCustomSearchSettings();
      setCustomSearchGroups(customSearchSettings.groups ?? Array(10).fill(false));
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh custom search: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitCustomRange = async (range: CustomSearchRange) => {
    let setSucceeded = true;
    try {
      await api.setCustomSearchRange(range.index, range.lower, range.upper);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set custom range ${range.index}: ${message}`,
        duration: 2500,
      });
    }
    try {
      const updatedRange = await api.getCustomSearchRange(range.index);
      setCustomSearchRanges((prev) =>
        prev.map((item) => (item.index === range.index ? updatedRange : item))
      );
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh custom range ${range.index}: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitWeather = async (priority: boolean) => {
    let setSucceeded = true;
    try {
      await api.setWeatherSettings(priority);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set weather priority: ${message}`,
        duration: 2500,
      });
    }
    try {
      const weatherSettings = await api.getWeatherSettings();
      setWeatherPriority(weatherSettings.priority ?? false);
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh weather priority: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitContrast = async (value: number) => {
    let setSucceeded = true;
    try {
      await api.setContrastSettings(value);
    } catch (error) {
      setSucceeded = false;
      const message = getErrorMessage(error);
      addNotification({
        type: "error",
        message: `Failed to set contrast: ${message}`,
        duration: 2500,
      });
    }
    try {
      const contrastSettings = await api.getContrastSettings();
      setContrast(contrastSettings.level ?? 10);
    } catch (error) {
      if (!setSucceeded) return;
      const message = getErrorMessage(error);
      addNotification({
        type: "warning",
        message: `Failed to refresh contrast: ${message}`,
        duration: 2500,
      });
    }
  };

  const handleServiceSearchToggle = (index: number) => {
    const next = serviceSearchGroups.map((enabled, idx) =>
      idx === index ? !enabled : enabled
    );
    setServiceSearchGroups(next);
    commitServiceSearchGroups(next);
  };

  const handleCustomSearchToggle = (index: number) => {
    const next = customSearchGroups.map((enabled, idx) =>
      idx === index ? !enabled : enabled
    );
    setCustomSearchGroups(next);
    commitCustomSearchGroups(next);
  };

  const handleCloseCallBandToggle = (index: number) => {
    const next = closeCallBand.map((enabled, idx) => (idx === index ? !enabled : enabled));
    setCloseCallBand(next);
    commitCloseCall({
      mode: closeCallMode,
      alert_beep: closeCallBeep,
      alert_light: closeCallLight,
      band: next,
      lockout: closeCallLockout,
    });
  };

  const handleCloseCallToggle = (field: "alert_beep" | "alert_light" | "lockout", value: boolean) => {
    const payload = {
      mode: closeCallMode,
      alert_beep: field === "alert_beep" ? value : closeCallBeep,
      alert_light: field === "alert_light" ? value : closeCallLight,
      band: closeCallBand,
      lockout: field === "lockout" ? value : closeCallLockout,
    };
    if (field === "alert_beep") setCloseCallBeep(value);
    if (field === "alert_light") setCloseCallLight(value);
    if (field === "lockout") setCloseCallLockout(value);
    commitCloseCall(payload);
  };

  const handleCloseCallModeChange = (value: number) => {
    setCloseCallMode(value);
    commitCloseCall({
      mode: value,
      alert_beep: closeCallBeep,
      alert_light: closeCallLight,
      band: closeCallBand,
      lockout: closeCallLockout,
    });
  };

  const handleCustomRangeChange = (index: number, field: "lower" | "upper", value: number) => {
    setCustomSearchRanges((prev) =>
      prev.map((range) => (range.index === index ? { ...range, [field]: value } : range))
    );
  };

  const handleCustomRangeCommit = (index: number) => {
    const range = customSearchRanges.find((item) => item.index === index);
    if (!range) return;
    commitCustomRange(range);
  };

  // Define categories for navigation
  const categories = [
    { id: 'locked-channels', label: 'Locked Channels' },
    { id: 'audio', label: 'Audio' },
    { id: 'display', label: 'Display' },
    { id: 'power-keys', label: 'Power & Keys' },
    { id: 'priority-weather', label: 'Priority & Weather' },
    { id: 'search', label: 'Search' },
  ];

  const advancedCategories = [
    { id: 'close-call', label: 'Close Call' },
    { id: 'service-search', label: 'Service Search' },
    { id: 'custom-search', label: 'Custom Search' },
  ];

  // Render active category content
  const renderCategoryContent = () => {
    switch (activeCategory) {
      case 'locked-channels':
        return (
          <LockedChannelsCategory
            channels={channels}
            selectedChannels={selectedChannels}
            connected={connected}
            onToggleChannel={handleToggleChannel}
            onSelectAll={handleSelectAll}
            onClearSelected={handleClearSelected}
          />
        );

      case 'audio':
        return (
          <AudioCategory
            volumeLevel={volumeLevel}
            squelchLevel={squelchLevel}
            connected={connected}
            onVolumeChange={setVolumeLevel}
            onSquelchChange={setSquelchLevel}
            onVolumeCommit={commitVolume}
            onSquelchCommit={commitSquelch}
          />
        );

      case 'display':
        return (
          <DisplayCategory
            backlight={backlight}
            contrast={contrast}
            connected={connected}
            onBacklightChange={(value) => {
              setBacklight(value);
              commitBacklight(value);
            }}
            onContrastChange={setContrast}
            onContrastCommit={commitContrast}
          />
        );

      case 'power-keys':
        return (
          <PowerKeysCategory
            keyBeepLevel={keyBeepLevel}
            keyLock={keyLock}
            batteryChargeTime={batteryChargeTime}
            connected={connected}
            onKeyBeepChange={(value) => {
              setKeyBeepLevel(value);
              commitKeyBeep(value, keyLock);
            }}
            onKeyLockChange={(value) => {
              setKeyLock(value);
              commitKeyBeep(keyBeepLevel, value);
            }}
            onBatteryChargeChange={setBatteryChargeTime}
            onBatteryChargeCommit={commitBatteryChargeTime}
          />
        );

      case 'priority-weather':
        return (
          <PriorityWeatherCategory
            priorityMode={priorityMode}
            weatherPriority={weatherPriority}
            connected={connected}
            onPriorityChange={(value) => {
              setPriorityMode(value);
              commitPriority(value);
            }}
            onWeatherPriorityChange={(value) => {
              setWeatherPriority(value);
              commitWeather(value);
            }}
          />
        );

      case 'search':
        return (
          <SearchCategory
            searchDelay={searchDelay}
            searchCode={searchCode}
            connected={connected}
            onSearchDelayChange={(value) => {
              setSearchDelay(value);
              commitSearchSettings(value, searchCode);
            }}
            onSearchCodeChange={(value) => {
              setSearchCode(value);
              commitSearchSettings(searchDelay, value);
            }}
          />
        );

      case 'close-call':
        return (
          <CloseCallCategory
            closeCallMode={closeCallMode}
            closeCallBand={closeCallBand}
            closeCallBeep={closeCallBeep}
            closeCallLight={closeCallLight}
            closeCallLockout={closeCallLockout}
            connected={connected}
            onModeChange={handleCloseCallModeChange}
            onBandToggle={handleCloseCallBandToggle}
            onAlertToggle={handleCloseCallToggle}
          />
        );

      case 'service-search':
        return (
          <ServiceSearchCategory
            serviceSearchGroups={serviceSearchGroups}
            connected={connected}
            onToggle={handleServiceSearchToggle}
          />
        );

      case 'custom-search':
        return (
          <CustomSearchCategory
            customSearchGroups={customSearchGroups}
            customSearchRanges={customSearchRanges}
            connected={connected}
            onGroupToggle={handleCustomSearchToggle}
            onRangeChange={handleCustomRangeChange}
            onRangeCommit={handleCustomRangeCommit}
          />
        );

      default:
        return null;
    }
  };

  return (
    <section className="config-view" aria-label="Scanner configuration">
      <DeviceStatusHeader
        deviceInfo={deviceInfo}
        firmware={firmware}
        liveState={liveState}
      />

      <div className="config-layout">
        <CategoryNav
          categories={categories}
          advancedCategories={advancedCategories}
          activeCategory={activeCategory}
          onCategoryChange={setActiveCategory}
          isMobile={isMobileView}
        />

        <div className="config-content-pane">
          <div className="category-content">{renderCategoryContent()}</div>
        </div>
      </div>
    </section>
  );
}

