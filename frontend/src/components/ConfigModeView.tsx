import { useEffect, useMemo, useRef, useState } from "react";

import { ConnectionStatus } from "./ConnectionStatus";
import { useAPI } from "../api/useApi";
import { useStore } from "../store/useStore";
import { useNotifications } from "../hooks/useNotifications";
import type { CloseCallSettings, CustomSearchRange } from "../types";

const backlightOptions = [
  { value: "AO", label: "Always On" },
  { value: "AF", label: "Always Off" },
  { value: "KY", label: "Keypress" },
  { value: "SQ", label: "Squelch" },
  { value: "KS", label: "Key + Squelch" },
];

const priorityOptions = [
  { value: 0, label: "Off" },
  { value: 1, label: "On" },
  { value: 2, label: "Plus" },
  { value: 3, label: "DND" },
];

const searchDelayOptions = [
  { value: -10, label: "-10" },
  { value: -5, label: "-5" },
  { value: 0, label: "0" },
  { value: 1, label: "1" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
  { value: 5, label: "5" },
];

const closeCallModeOptions = [
  { value: 0, label: "Off" },
  { value: 1, label: "Priority" },
  { value: 2, label: "DND" },
];

const closeCallBandLabels = [
  "VHF Low",
  "Air",
  "VHF High 1",
  "VHF High 2",
  "UHF",
];

const serviceSearchLabels = [
  "Police",
  "Fire/Emergency",
  "Ham",
  "Marine",
  "Railroad",
  "Civil Air",
  "Military Air",
  "CB",
  "FRS/GMRS/MURS",
  "Racing",
];

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

  const lockedChannels = useMemo(
    () => channels.filter((channel) => channel.lockout),
    [channels]
  );
  const allSelected =
    lockedChannels.length > 0 &&
    lockedChannels.every((channel) => selectedChannels.includes(channel.index));
  const anySelected = selectedChannels.length > 0;
  const selectAllRef = useRef<HTMLInputElement | null>(null);

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
        setCustomSearchRanges(config.custom_search_ranges?.length ? config.custom_search_ranges : buildDefaultRanges());
        setWeatherPriority(config.weather?.priority ?? false);
        setContrast(config.contrast?.level ?? 10);
        setSquelchLevel(squelch.level);
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

  const commitVolume = async (value: number) => {
    try {
      await api.setVolume(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set volume: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitSquelch = async (value: number) => {
    try {
      await api.setSquelch(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set squelch: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitBacklight = async (value: string) => {
    try {
      await api.setBacklight(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set backlight: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitBatteryChargeTime = async (value: number) => {
    try {
      await api.setBatterySettings(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set battery charge time: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitKeyBeep = async (level: number, lock: boolean) => {
    try {
      await api.setKeyBeepSettings(level, lock);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set key beep: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitPriority = async (mode: number) => {
    try {
      await api.setPrioritySettings(mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set priority: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitSearchSettings = async (delay: number, codeSearch: boolean) => {
    try {
      await api.setSearchSettings(delay, codeSearch);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set search settings: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitCloseCall = async (payload: CloseCallSettings) => {
    try {
      await api.setCloseCallSettings(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set Close Call: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitServiceSearchGroups = async (groups: boolean[]) => {
    try {
      await api.setServiceSearchSettings(groups);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set service search: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitCustomSearchGroups = async (groups: boolean[]) => {
    try {
      await api.setCustomSearchSettings(groups);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set custom search: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitCustomRange = async (range: CustomSearchRange) => {
    try {
      await api.setCustomSearchRange(range.index, range.lower, range.upper);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set custom range ${range.index}: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitWeather = async (priority: boolean) => {
    try {
      await api.setWeatherSettings(priority);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set weather priority: ${message}`,
        duration: 2500,
      });
    }
  };

  const commitContrast = async (value: number) => {
    try {
      await api.setContrastSettings(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Request failed";
      addNotification({
        type: "error",
        message: `Failed to set contrast: ${message}`,
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

  return (
    <section className="config-view" aria-label="Scanner configuration">
      <div className="config-grid">
        <div className="config-card">
          <h3>Device</h3>
          <ConnectionStatus />
          <div className="config-row">
            <span className="config-label">Model</span>
            <span className="config-value">{deviceInfo?.model || "—"}</span>
          </div>
          <div className="config-row">
            <span className="config-label">Firmware</span>
            <span className="config-value">{firmware || "—"}</span>
          </div>
          <div className="config-row">
            <span className="config-label">Mode</span>
            <span className="config-value">{liveState?.mode || "—"}</span>
          </div>
          <div className="config-row">
            <span className="config-label">Squelch</span>
            <span className="config-value">
              {liveState ? (liveState.squelch_open ? "Open" : "Closed") : "—"}
            </span>
          </div>
        </div>

        <div className="config-card">
          <h3>Audio</h3>
          <div className="config-row config-row--stack">
            <span className="config-label">Volume</span>
            <div className="config-slider">
              <input
                type="range"
                min={0}
                max={15}
                value={volumeLevel}
                onChange={(event) => setVolumeLevel(Number(event.target.value))}
                onMouseUp={(event) => commitVolume(Number((event.target as HTMLInputElement).value))}
                onTouchEnd={(event) => commitVolume(Number((event.target as HTMLInputElement).value))}
                disabled={!connected}
              />
              <span className="config-value">{volumeLevel}</span>
            </div>
          </div>
          <div className="config-row config-row--stack">
            <span className="config-label">Squelch</span>
            <div className="config-slider">
              <input
                type="range"
                min={0}
                max={15}
                value={squelchLevel}
                onChange={(event) => setSquelchLevel(Number(event.target.value))}
                onMouseUp={(event) => commitSquelch(Number((event.target as HTMLInputElement).value))}
                onTouchEnd={(event) => commitSquelch(Number((event.target as HTMLInputElement).value))}
                disabled={!connected}
              />
              <span className="config-value">{squelchLevel}</span>
            </div>
          </div>
        </div>

        <div className="config-card">
          <h3>Locked Channels</h3>
          <p className="config-note">Select channels to unlock.</p>
          {lockedChannels.length === 0 ? (
            <p className="config-note">No locked channels.</p>
          ) : (
            <div className="locked-list">
              <label className="locked-selectAll">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={handleSelectAll}
                  disabled={!connected}
                  ref={selectAllRef}
                />
                <span>Select all</span>
              </label>
              <ul className="locked-items" role="list">
                {lockedChannels.map((channel) => (
                  <li key={channel.index} className="locked-item">
                    <label className="locked-itemLabel">
                      <input
                        type="checkbox"
                        checked={selectedChannels.includes(channel.index)}
                        onChange={() => handleToggleChannel(channel.index)}
                        disabled={!connected}
                      />
                      <span className="locked-text">
                        {channel.frequency.toFixed(4)} {channel.alpha_tag || "—"}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="config-actions">
            <button
              className="mvp-actionButton"
              type="button"
              disabled={!connected || selectedChannels.length === 0}
              onClick={handleClearSelected}
            >
              Clear Selected Channels
            </button>
          </div>
        </div>

        <div className="config-card config-card--span">
          <h3>Display</h3>
          <div className="config-row">
            <span className="config-label">Backlight</span>
            <select
              className="config-select"
              value={backlight}
              onChange={(event) => {
                const value = event.target.value;
                setBacklight(value);
                commitBacklight(value);
              }}
              disabled={!connected}
            >
              {backlightOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="config-row">
            <span className="config-label">Contrast</span>
            <div className="config-slider">
              <input
                type="range"
                min={1}
                max={15}
                value={contrast}
                onChange={(event) => setContrast(Number(event.target.value))}
                onMouseUp={(event) => commitContrast(Number((event.target as HTMLInputElement).value))}
                onTouchEnd={(event) => commitContrast(Number((event.target as HTMLInputElement).value))}
                disabled={!connected}
              />
              <span className="config-value">{contrast}</span>
            </div>
          </div>
        </div>

        <div className="config-card">
          <h3>Keys & Power</h3>
          <div className="config-row">
            <span className="config-label">Beep Level</span>
            <select
              className="config-select"
              value={keyBeepLevel}
              onChange={(event) => {
                const value = Number(event.target.value);
                setKeyBeepLevel(value);
                commitKeyBeep(value, keyLock);
              }}
              disabled={!connected}
            >
              <option value={0}>Auto</option>
              {Array.from({ length: 15 }, (_, index) => (
                <option key={index + 1} value={index + 1}>
                  {index + 1}
                </option>
              ))}
              <option value={99}>Off</option>
            </select>
          </div>
          <label className="config-toggle">
            <input
              type="checkbox"
              checked={keyLock}
              onChange={(event) => {
                const value = event.target.checked;
                setKeyLock(value);
                commitKeyBeep(keyBeepLevel, value);
              }}
              disabled={!connected}
            />
            <span>Key Lock</span>
          </label>
          <div className="config-row">
            <span className="config-label">Battery Charge</span>
            <div className="config-slider">
              <input
                type="range"
                min={1}
                max={16}
                value={batteryChargeTime}
                onChange={(event) => setBatteryChargeTime(Number(event.target.value))}
                onMouseUp={(event) =>
                  commitBatteryChargeTime(Number((event.target as HTMLInputElement).value))
                }
                onTouchEnd={(event) =>
                  commitBatteryChargeTime(Number((event.target as HTMLInputElement).value))
                }
                disabled={!connected}
              />
              <span className="config-value">{batteryChargeTime}</span>
            </div>
          </div>
        </div>

        <div className="config-card">
          <h3>Priority & Weather</h3>
          <div className="config-row">
            <span className="config-label">Priority Mode</span>
            <select
              className="config-select"
              value={priorityMode}
              onChange={(event) => {
                const value = Number(event.target.value);
                setPriorityMode(value);
                commitPriority(value);
              }}
              disabled={!connected}
            >
              {priorityOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <label className="config-toggle">
            <input
              type="checkbox"
              checked={weatherPriority}
              onChange={(event) => {
                const value = event.target.checked;
                setWeatherPriority(value);
                commitWeather(value);
              }}
              disabled={!connected}
            />
            <span>Weather Alert Priority</span>
          </label>
        </div>

        <div className="config-card">
          <h3>Search</h3>
          <div className="config-row">
            <span className="config-label">Search Delay</span>
            <select
              className="config-select"
              value={searchDelay}
              onChange={(event) => {
                const value = Number(event.target.value);
                setSearchDelay(value);
                commitSearchSettings(value, searchCode);
              }}
              disabled={!connected}
            >
              {searchDelayOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <label className="config-toggle">
            <input
              type="checkbox"
              checked={searchCode}
              onChange={(event) => {
                const value = event.target.checked;
                setSearchCode(value);
                commitSearchSettings(searchDelay, value);
              }}
              disabled={!connected}
            />
            <span>CTCSS/DCS Search</span>
          </label>
        </div>

        <div className="config-card config-card--span">
          <h3>Close Call</h3>
          <div className="config-row">
            <span className="config-label">Mode</span>
            <select
              className="config-select"
              value={closeCallMode}
              onChange={(event) => handleCloseCallModeChange(Number(event.target.value))}
              disabled={!connected}
            >
              {closeCallModeOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="config-group">
            {closeCallBandLabels.map((label, index) => (
              <label key={label} className="config-toggle">
                <input
                  type="checkbox"
                  checked={closeCallBand[index] ?? false}
                  onChange={() => handleCloseCallBandToggle(index)}
                  disabled={!connected}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <div className="config-group">
            <label className="config-toggle">
              <input
                type="checkbox"
                checked={closeCallBeep}
                onChange={(event) => handleCloseCallToggle("alert_beep", event.target.checked)}
                disabled={!connected}
              />
              <span>Alert Beep</span>
            </label>
            <label className="config-toggle">
              <input
                type="checkbox"
                checked={closeCallLight}
                onChange={(event) => handleCloseCallToggle("alert_light", event.target.checked)}
                disabled={!connected}
              />
              <span>Alert Light</span>
            </label>
            <label className="config-toggle">
              <input
                type="checkbox"
                checked={closeCallLockout}
                onChange={(event) => handleCloseCallToggle("lockout", event.target.checked)}
                disabled={!connected}
              />
              <span>Lockout Hits While Scanning</span>
            </label>
          </div>
        </div>

        <div className="config-card">
          <h3>Service Search</h3>
          <div className="config-group">
            {serviceSearchLabels.map((label, index) => (
              <label key={label} className="config-toggle">
                <input
                  type="checkbox"
                  checked={serviceSearchGroups[index] ?? false}
                  onChange={() => handleServiceSearchToggle(index)}
                  disabled={!connected}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="config-card">
          <h3>Custom Search Groups</h3>
          <div className="config-group config-group--grid">
            {customSearchGroups.map((enabled, index) => (
              <label key={`custom-group-${index + 1}`} className="config-toggle">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={() => handleCustomSearchToggle(index)}
                  disabled={!connected}
                />
                <span>Range {index + 1}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="config-card config-card--span">
          <h3>Custom Search Ranges</h3>
          <div className="config-table">
            <div className="config-tableHeader">
              <span>Range</span>
              <span>Lower (MHz)</span>
              <span>Upper (MHz)</span>
              <span></span>
            </div>
            {customSearchRanges.map((range) => (
              <div key={`range-${range.index}`} className="config-tableRow">
                <span>#{range.index}</span>
                <input
                  type="number"
                  min={25}
                  max={512}
                  step={0.0001}
                  value={Number.isFinite(range.lower) ? range.lower : 0}
                  onChange={(event) =>
                    handleCustomRangeChange(range.index, "lower", Number(event.target.value))
                  }
                  disabled={!connected}
                />
                <input
                  type="number"
                  min={25}
                  max={512}
                  step={0.0001}
                  value={Number.isFinite(range.upper) ? range.upper : 0}
                  onChange={(event) =>
                    handleCustomRangeChange(range.index, "upper", Number(event.target.value))
                  }
                  disabled={!connected}
                />
                <button
                  type="button"
                  className="mvp-actionButton mvp-actionButton--ghost"
                  onClick={() => handleCustomRangeCommit(range.index)}
                  disabled={!connected}
                >
                  Set
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
