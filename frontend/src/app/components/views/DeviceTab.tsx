import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { motion } from 'motion/react';
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
} from 'lucide-react';

import appIcon from '@/assets/app-icon.png';
import { cn } from '../../../lib/utils';
import { getAPI, API_BASE } from '../../../api/useApi';
import { useStore, type Preferences } from '../../../store/useStore';
import { openExternalUrl } from '../../../tauri-shell';
import { useConnectionStatus } from '../../../hooks/useConnectionStatus';
import { Slider } from '../ui/slider';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';

type DeviceCategory =
  | 'Locked Channels'
  | 'Device Config'
  | 'Close Call'
  | 'Service Search'
  | 'Custom Search'
  | 'Preferences';

interface SearchRange {
  id: number;
  enabled: boolean;
  label: string;
  start: string;
  end: string;
}

// Frontend uses camelCase preference keys; the backend persists snake_case
// (see default_preferences() in api/mod.rs). Map every key that differs so
// saved values round-trip through App.tsx's snake_case load path. A missing
// entry silently falls back to the camelCase key via `?? key`, saving under a
// key nobody reads back — the setting then looks non-persistent.
export const PREFERENCE_KEY_MAP: Partial<Record<keyof Preferences, string>> = {
  hitMinDuration: 'hit_min_duration',
  dataRetentionDays: 'data_retention_days',
};

export function DeviceTab() {
  const api = getAPI();
  const connectionStatus = useConnectionStatus();
  const deviceInfo = useStore((state) => state.deviceInfo);
  const liveState = useStore((state) => state.liveState);
  const channels = useStore((state) => state.channels) ?? [];
  const setChannels = useStore((state) => state.setChannels);
  const preferences = useStore((state) => state.preferences);
  const updatePreferences = useStore((state) => state.updatePreferences);

  const [lockedChannelIds, setLockedChannelIds] = useState<number[]>([]);
  const [lockedFetchedAt, setLockedFetchedAt] = useState<number | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<DeviceCategory>('Device Config');
  const [firmware, setFirmware] = useState<string | null>(null);
  const [selectedChannels, setSelectedChannels] = useState<number[]>([]);
  const [isClearing, setIsClearing] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [bankFilter, setBankFilter] = useState<number | 'all'>('all');

  const handlePreferenceChange = useCallback(
    async <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
      const backendKey = PREFERENCE_KEY_MAP[key] ?? key;
      updatePreferences({ [key]: value } as Partial<Preferences>);
      try {
        await fetch(`${API_BASE}/preferences`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [backendKey]: value }),
        });
      } catch (error) {
        console.error('Failed to save preference', error);
        toast.error('Failed to save preference');
      }
    },
    [updatePreferences],
  );

  // Device Config Settings
  const [squelch, setSquelch] = useState(2);
  const [batterySaver, setBatterySaver] = useState(1);
  const [backlight, setBacklight] = useState('AO');
  const [contrast, setContrast] = useState(7);
  const [keyBeepEnabled, setKeyBeepEnabled] = useState(true);
  const [priorityMode, setPriorityMode] = useState('off');
  const [weatherAlert, setWeatherAlert] = useState(false);
  const [keyBeepLock, setKeyBeepLock] = useState(false);

  // Close Call Settings
  const [closeCallMode, setCloseCallMode] = useState('off');
  const [closeCallLockout, setCloseCallLockout] = useState(false);
  const [closeCallBeep, setCloseCallBeep] = useState(false);
  const [closeCallLight, setCloseCallLight] = useState(false);
  const [closeCallBands, setCloseCallBands] = useState<boolean[]>([
    false,
    false,
    false,
    false,
    false,
  ]);

  // Service Search Settings
  // The BC125AT exposes exactly 10 service-search band groups; the backend
  // (set_service_search) rejects any payload that is not exactly 10 booleans.
  const [serviceSearchGroups, setServiceSearchGroups] = useState<boolean[]>(() =>
    Array(10).fill(false),
  );
  const [searchDelay, setSearchDelay] = useState(3);
  const [codeSearchEnabled, setCodeSearchEnabled] = useState(false);

  // Custom Search Settings
  const [searchRanges, setSearchRanges] = useState<SearchRange[]>([
    { id: 1, enabled: true, label: 'VHF Low', start: '25.0000', end: '54.0000' },
    { id: 2, enabled: true, label: 'Civil Air', start: '108.0000', end: '136.9916' },
    { id: 3, enabled: true, label: 'VHF High', start: '137.0000', end: '174.0000' },
    { id: 4, enabled: false, label: 'UHF Air', start: '225.0000', end: '380.0000' },
    { id: 5, enabled: false, label: 'UHF', start: '400.0000', end: '512.0000' },
    { id: 6, enabled: false, label: '800 MHz', start: '806.0000', end: '960.0000' },
    { id: 7, enabled: false, label: 'Range 7', start: '1240.0000', end: '1300.0000' },
    { id: 8, enabled: false, label: 'Range 8', start: '0.0000', end: '0.0000' },
    { id: 9, enabled: false, label: 'Range 9', start: '0.0000', end: '0.0000' },
    { id: 10, enabled: false, label: 'Range 10', start: '0.0000', end: '0.0000' },
  ]);

  const connectionStatusLabel =
    connectionStatus === 'connected'
      ? 'Connected'
      : connectionStatus === 'connecting'
        ? 'Connecting'
        : 'Disconnected';

  const showUsbTroubleshooting =
    connectionStatus !== 'connected' &&
    (deviceInfo?.diagnostic_code === 'usb_detected_no_serial_endpoint' ||
      deviceInfo?.diagnostic_code === 'usb_device_not_accessible');

  const lockedChannels = useMemo(() => {
    if (!lockedChannelIds.length) return [];
    const channelMap = new Map(channels.map((ch) => [ch.index, ch]));
    return lockedChannelIds
      .map((id) => channelMap.get(id))
      .filter((ch): ch is NonNullable<typeof ch> => Boolean(ch));
  }, [channels, lockedChannelIds]);

  const filteredLockedChannels = useMemo(() => {
    const term = searchTerm.trim().toLowerCase();
    return lockedChannels.filter((channel) => {
      const matchesBank = bankFilter === 'all' || channel.bank === bankFilter;
      const matchesTerm =
        term.length === 0 ||
        channel.alpha_tag.toLowerCase().includes(term) ||
        channel.frequency.toFixed(4).includes(term);
      return matchesBank && matchesTerm;
    });
  }, [bankFilter, lockedChannels, searchTerm]);

  const allSelected =
    filteredLockedChannels.length > 0 &&
    filteredLockedChannels.every((channel) => selectedChannels.includes(channel.index));

  useEffect(() => {
    setSelectedChannels((prev) =>
      prev.filter((id) => filteredLockedChannels.some((channel) => channel.index === id)),
    );
  }, [filteredLockedChannels]);

  useEffect(() => {
    if (selectedCategory !== 'Locked Channels') return;
    let active = true;
    api
      .getLockouts({ includeFrequencies: false })
      .then((result) => {
        if (!active) return;
        setLockedChannelIds(result.channels ?? []);
        setLockedFetchedAt(Date.now());
      })
      .catch((error) => {
        console.error('Failed to load lockouts', error);
      });
    return () => {
      active = false;
    };
  }, [api, selectedCategory]);

  const programModeSettingsLoaded = useRef(false);

  // Load all device settings when component mounts
  useEffect(() => {
    let active = true;
    const loadAllSettings = async () => {
      try {
        const settings = await api.getAllSettings();

        if (!active) return;

        // Firmware comes from the settings snapshot (VER), not DeviceInfo —
        // the backend never populates DeviceInfo.firmware.
        if (settings.firmware) {
          setFirmware(settings.firmware);
        }

        // Populate device config settings
        if (settings.squelch) {
          setSquelch(settings.squelch.level);
        }
        if (settings.battery) {
          const batteryValue = Math.min(16, Math.max(1, settings.battery.charge_time || 1));
          setBatterySaver(batteryValue);
        }
        if (settings.backlight) {
          setBacklight(settings.backlight.event || 'AO');
        }
        if (settings.contrast) {
          setContrast(settings.contrast.level);
        }
        if (settings.key_beep) {
          setKeyBeepLock(Boolean(settings.key_beep.lock));
          setKeyBeepEnabled(settings.key_beep.level !== 99);
        }
        if (settings.priority) {
          const priorityMap: Record<number, string> = { 0: 'off', 1: 'on', 2: 'plus' };
          setPriorityMode(priorityMap[settings.priority.mode] || 'off');
        }
        if (settings.weather) {
          setWeatherAlert(settings.weather.priority);
        }

        // Populate close call settings
        if (settings.close_call) {
          const closeCallModeMap: Record<number, string> = {
            0: 'off',
            1: 'cc_dnd',
            2: 'cc_priority',
          };
          setCloseCallMode(closeCallModeMap[settings.close_call.mode] || 'off');
          setCloseCallLockout(settings.close_call.lockout);
          setCloseCallBeep(settings.close_call.alert_beep);
          setCloseCallLight(settings.close_call.alert_light);
          setCloseCallBands(settings.close_call.band);
        }

        // Populate service search settings. Always normalize to exactly 10
        // booleans so toggles never send a short/sparse array to the backend.
        if (settings.service_search) {
          const loaded = settings.service_search.groups ?? [];
          setServiceSearchGroups(Array.from({ length: 10 }, (_, i) => loaded[i] ?? false));
        }

        // Populate search settings
        if (settings.search) {
          setSearchDelay(settings.search.delay);
          setCodeSearchEnabled(settings.search.code_search);
        }

        // Populate custom search settings and ranges
        if (settings.custom_search && settings.custom_search_ranges) {
          const defaultLabels = [
            'VHF Low',
            'Civil Air',
            'VHF High',
            'UHF Air',
            'UHF',
            '800 MHz',
            'Range 7',
            'Range 8',
            'Range 9',
            'Range 10',
          ];

          setSearchRanges(
            settings.custom_search_ranges.map((r, idx) => ({
              id: r.index,
              enabled: settings.custom_search?.groups[idx] || false,
              label: defaultLabels[idx] || `Range ${r.index}`,
              start: r.lower.toFixed(4),
              end: r.upper.toFixed(4),
            })),
          );
        }

        programModeSettingsLoaded.current = true;
      } catch (error) {
        console.error('Failed to load all settings', error);
        toast.error('Failed to load device settings');
      }
    };

    loadAllSettings();

    return () => {
      active = false;
    };
  }, [api]);

  const toggleSelection = useCallback((channelId: number) => {
    setSelectedChannels((prev) =>
      prev.includes(channelId) ? prev.filter((value) => value !== channelId) : [...prev, channelId],
    );
  }, []);

  const toggleAllSelected = useCallback(
    (checked: boolean) => {
      // Operate only on the currently-filtered locked channels so "Select Page"
      // never selects/unlocks channels hidden by the active search/bank filter.
      setSelectedChannels(checked ? filteredLockedChannels.map((ch) => ch.index) : []);
    },
    [filteredLockedChannels],
  );

  const handleUnlockSelected = useCallback(
    async (targetIds?: number[]) => {
      const targets = targetIds ?? selectedChannels;
      if (targets.length === 0) {
        toast.info('Select channels to unlock');
        return;
      }
      setIsClearing(true);
      try {
        const result = await api.clearChannelLockouts(targets);
        const clearedIds = targets.length > 0 ? targets : result.cleared;
        const clearedSet = new Set(clearedIds);
        setChannels((prev) =>
          prev.map((channel) =>
            clearedSet.has(channel.index) ? { ...channel, lockout: false } : channel,
          ),
        );
        setLockedChannelIds((prev) => prev.filter((id) => !clearedSet.has(id)));
        setSelectedChannels((prev) => prev.filter((id) => !clearedSet.has(id)));
        toast.success(`${clearedIds.length} channel${clearedIds.length === 1 ? '' : 's'} unlocked`);
      } catch (error) {
        console.error('Failed to unlock channels', error);
        toast.error('Unable to unlock channels');
      } finally {
        setIsClearing(false);
      }
    },
    [api, selectedChannels, setChannels],
  );

  // Setting handlers
  const handleVolumeChange = useCallback(
    async (value: number[]) => {
      try {
        await api.setVolume(value[0]);
      } catch (error) {
        console.error('Failed to set volume', error);
        toast.error('Failed to set volume');
      }
    },
    [api],
  );

  const handleSquelchChange = useCallback(
    async (value: number[]) => {
      const level = value[0];
      try {
        await api.setSquelch(level);
        setSquelch(level);
      } catch (error) {
        console.error('Failed to set squelch', error);
        toast.error('Failed to set squelch');
      }
    },
    [api],
  );

  const handleBatterySaverChange = useCallback(
    async (value: number[]) => {
      const chargeTime = value[0];
      try {
        await api.setBatterySettings(chargeTime);
        setBatterySaver(chargeTime);
      } catch (error) {
        console.error('Failed to set battery saver', error);
        toast.error('Failed to set battery saver');
      }
    },
    [api],
  );

  const handleBacklightChange = useCallback(
    async (value: string) => {
      try {
        await api.setBacklight(value);
        setBacklight(value);
      } catch (error) {
        console.error('Failed to set backlight', error);
        toast.error('Failed to set backlight');
      }
    },
    [api],
  );

  const handleContrastChange = useCallback(
    async (value: number[]) => {
      const level = value[0];
      try {
        await api.setContrastSettings(level);
        setContrast(level);
      } catch (error) {
        console.error('Failed to set contrast', error);
        toast.error('Failed to set contrast');
      }
    },
    [api],
  );

  const refreshKeyBeep = useCallback(async () => {
    try {
      const res = await api.getKeyBeepSettings();
      setKeyBeepLock(Boolean(res.lock));
      setKeyBeepEnabled(res.level !== 99);
      return res;
    } catch (error) {
      console.error('Failed to refresh key beep', error);
      return null;
    }
  }, [api]);

  const applyKeyBeep = useCallback(
    async (enabled: boolean) => {
      const level = enabled ? 1 : 99;
      const payload = { level, lock: keyBeepLock };
      try {
        await api.setKeyBeepSettings(level, keyBeepLock);
        const refreshed = await refreshKeyBeep();

        if (!refreshed) {
          toast.error('Failed to set key beep');
          return;
        }

        const matches = (enabled && refreshed.level !== 99) || (!enabled && refreshed.level === 99);

        if (matches) {
          return;
        }

        console.error('Key beep verification failed', { enabled, actualLevel: refreshed.level });
        toast.error('Failed to set key beep');
      } catch (error) {
        console.error('Failed to set key beep', { payload, error });
        toast.error('Failed to set key beep');
      }
    },
    [api, keyBeepLock, refreshKeyBeep],
  );

  const handleKeyBeepChange = useCallback(
    async (enabled: boolean) => {
      setKeyBeepEnabled(enabled);
      await applyKeyBeep(enabled);
    },
    [applyKeyBeep],
  );

  const handlePriorityModeChange = useCallback(
    async (value: string) => {
      setPriorityMode(value);
      const modeMap: Record<string, number> = { off: 0, on: 1, plus: 2 };
      try {
        await api.setPrioritySettings(modeMap[value] || 0);
      } catch (error) {
        console.error('Failed to set priority mode', error);
        toast.error('Failed to set priority mode');
      }
    },
    [api],
  );

  const handleWeatherAlertChange = useCallback(
    async (checked: boolean) => {
      setWeatherAlert(checked);
      try {
        await api.setWeatherSettings(checked);
      } catch (error) {
        console.error('Failed to set weather alert', error);
        toast.error('Failed to set weather alert');
      }
    },
    [api],
  );

  const handleCloseCallModeChange = useCallback(
    async (value: string) => {
      setCloseCallMode(value);
      const modeMap: Record<string, number> = { off: 0, cc_dnd: 1, cc_priority: 2 };
      try {
        await api.setCloseCallSettings({
          mode: modeMap[value] || 0,
          alert_beep: closeCallBeep,
          alert_light: closeCallLight,
          band: closeCallBands,
          lockout: closeCallLockout,
        });
      } catch (error) {
        console.error('Failed to set close call mode', error);
        toast.error('Failed to set close call mode');
      }
    },
    [api, closeCallBeep, closeCallLight, closeCallBands, closeCallLockout],
  );

  const handleCloseCallSettingChange = useCallback(
    async (setting: string, value: boolean) => {
      const modeMap: Record<string, number> = { off: 0, cc_dnd: 1, cc_priority: 2 };
      const updates: Record<string, boolean> = {
        lockout: closeCallLockout,
        alert_beep: closeCallBeep,
        alert_light: closeCallLight,
        [setting]: value,
      };

      try {
        await api.setCloseCallSettings({
          mode: modeMap[closeCallMode] || 0,
          alert_beep: updates.alert_beep,
          alert_light: updates.alert_light,
          band: closeCallBands,
          lockout: updates.lockout,
        });
        if (setting === 'lockout') setCloseCallLockout(value);
        if (setting === 'alert_beep') setCloseCallBeep(value);
        if (setting === 'alert_light') setCloseCallLight(value);
      } catch (error) {
        console.error('Failed to update close call setting', error);
        toast.error('Failed to update close call setting');
      }
    },
    [api, closeCallMode, closeCallLockout, closeCallBeep, closeCallLight, closeCallBands],
  );

  const handleCloseCallBandToggle = useCallback(
    async (index: number) => {
      const newBands = [...closeCallBands];
      newBands[index] = !newBands[index];

      const modeMap: Record<string, number> = { off: 0, cc_dnd: 1, cc_priority: 2 };
      try {
        await api.setCloseCallSettings({
          mode: modeMap[closeCallMode] || 0,
          alert_beep: closeCallBeep,
          alert_light: closeCallLight,
          band: newBands,
          lockout: closeCallLockout,
        });
        setCloseCallBands(newBands);
      } catch (error) {
        console.error('Failed to toggle close call band', error);
        toast.error('Failed to toggle close call band');
      }
    },
    [api, closeCallMode, closeCallBeep, closeCallLight, closeCallBands, closeCallLockout],
  );

  const handleServiceSearchToggle = useCallback(
    async (index: number) => {
      const newGroups = [...serviceSearchGroups];
      newGroups[index] = !newGroups[index];

      try {
        await api.setServiceSearchSettings(newGroups);
        setServiceSearchGroups(newGroups);
      } catch (error) {
        console.error('Failed to toggle service search', error);
        toast.error('Failed to toggle service search');
      }
    },
    [api, serviceSearchGroups],
  );

  const handleSearchDelayChange = useCallback(
    async (value: number[]) => {
      const delay = value[0];
      setSearchDelay(delay);
      try {
        await api.setSearchSettings(delay, codeSearchEnabled);
      } catch (error) {
        console.error('Failed to set search delay', error);
        toast.error('Failed to set search delay');
      }
    },
    [api, codeSearchEnabled],
  );

  const handleCodeSearchToggle = useCallback(
    async (checked: boolean) => {
      setCodeSearchEnabled(checked);
      try {
        await api.setSearchSettings(searchDelay, checked);
      } catch (error) {
        console.error('Failed to toggle code search', error);
        toast.error('Failed to toggle code search');
      }
    },
    [api, searchDelay],
  );

  const toggleRange = useCallback(
    async (id: number) => {
      const newRanges = searchRanges.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r));
      setSearchRanges(newRanges);

      try {
        await api.setCustomSearchSettings(newRanges.map((r) => r.enabled));
      } catch (error) {
        console.error('Failed to toggle search range', error);
        toast.error('Failed to toggle search range');
      }
    },
    [api, searchRanges],
  );

  const updateRange = useCallback(
    async (id: number, field: 'start' | 'end' | 'label', value: string) => {
      if (field === 'start' || field === 'end') {
        const num = parseFloat(value);
        if (isNaN(num) || num < 0) {
          return;
        }
      }

      const newRanges = searchRanges.map((r) => (r.id === id ? { ...r, [field]: value } : r));
      setSearchRanges(newRanges);

      if (field === 'start' || field === 'end') {
        const range = newRanges.find((r) => r.id === id);
        if (range) {
          try {
            const startVal = parseFloat(range.start);
            const endVal = parseFloat(range.end);
            if (isNaN(startVal) || isNaN(endVal)) {
              console.error('Invalid frequency range');
              return;
            }
            await api.setCustomSearchRange(id, startVal, endVal);
          } catch (error) {
            console.error('Failed to update search range', error);
            toast.error('Failed to update search range');
          }
        }
      }
    },
    [api, searchRanges],
  );

  const activeRangeCount = searchRanges.filter((r) => r.enabled).length;

  const volume = liveState?.volume ?? 0;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex h-full gap-6">
      {/* Side Nav */}
      <div className="scanner-surface flex h-full w-[var(--layout-sidebar-device-width)] flex-col p-2">
        {['Device Config', 'Close Call', 'Service Search', 'Custom Search', 'Locked Channels'].map(
          (cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat as DeviceCategory)}
              aria-current={selectedCategory === cat ? 'page' : undefined}
              className={cn(
                'text-left px-3 py-2 rounded text-sm font-medium transition-colors',
                selectedCategory === cat
                  ? 'bg-brand-hover/20 text-brand-hover'
                  : 'text-white/60 hover:bg-white/5 hover:text-white',
              )}
            >
              {cat}
            </button>
          ),
        )}

        {/* Preferences at bottom */}
        <button
          onClick={() => setSelectedCategory('Preferences')}
          aria-current={selectedCategory === 'Preferences' ? 'page' : undefined}
          className={cn(
            'text-left px-3 py-2 rounded text-sm font-medium transition-colors mt-auto border-t border-white/10 pt-3',
            selectedCategory === 'Preferences'
              ? 'bg-brand-hover/20 text-brand-hover'
              : 'text-white/60 hover:bg-white/5 hover:text-white',
          )}
        >
          Preferences
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 bg-black/20 rounded-lg border border-white/5 p-6 h-full overflow-y-auto">
        {selectedCategory !== 'Locked Channels' && (
          <h2 className="text-lg font-bold mb-6 border-b border-white/10 pb-2 flex items-center justify-between">
            <span>{selectedCategory}</span>
            {selectedCategory === 'Custom Search' && (
              <span className="text-sm font-normal text-white/50">
                {activeRangeCount} of 10 active
              </span>
            )}
          </h2>
        )}

        {/* Locked Channels */}
        {selectedCategory === 'Locked Channels' && (
          <div className="flex flex-col h-full gap-4">
            <div className="flex flex-col gap-4 rounded-lg border border-white/5 bg-white/5 p-4">
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="p-2 rounded bg-red-500/10 text-red-500 border border-red-500/20">
                    <Lock aria-hidden className="w-4 h-4" />
                  </span>
                  <div>
                    <div className="text-base font-bold text-white">Locked Channels</div>
                    <div className="text-sm text-white/50">
                      {lockedChannelIds.length} locked • {filteredLockedChannels.length} shown
                    </div>
                  </div>
                </div>
                {lockedFetchedAt && (
                  <div className="text-sm text-white/60">
                    Synced {new Date(lockedFetchedAt).toLocaleTimeString()}
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2 text-sm">
                  <span className="px-2 py-1 rounded bg-white/10 border border-white/10 text-white/70">
                    Total: {lockedChannelIds.length}
                  </span>
                  <span className="px-2 py-1 rounded bg-white/10 border border-white/10 text-white/70">
                    Selected: {selectedChannels.length}
                  </span>
                  {bankFilter !== 'all' && (
                    <span className="px-2 py-1 rounded bg-white/10 border border-white/10 text-white/70">
                      Bank {bankFilter}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap gap-3 items-center">
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="Search frequency or tag"
                    className="w-56 bg-black/30 border border-white/40 rounded px-3 py-2 text-sm text-white placeholder:text-white/40 focus:outline-none focus:border-brand-primary"
                  />
                  <Select
                    value={bankFilter === 'all' ? 'all' : String(bankFilter)}
                    onValueChange={(val) => setBankFilter(val === 'all' ? 'all' : Number(val))}
                  >
                    <SelectTrigger className="scanner-input h-8 w-[var(--size-select-compact)] text-sm">
                      <SelectValue placeholder="All Banks" />
                    </SelectTrigger>
                    <SelectContent className="scanner-select-content">
                      <SelectItem value="all">All Banks</SelectItem>
                      {Array.from({ length: 10 }, (_, i) => i + 1).map((bank) => (
                        <SelectItem key={bank} value={String(bank)}>
                          Bank {bank}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex gap-2 ml-auto">
                    <button
                      onClick={() => toggleAllSelected(!allSelected)}
                      className="px-3 py-2 text-sm font-medium text-white/70 bg-white/10 hover:bg-white/20 rounded border border-white/10 transition-colors"
                    >
                      {allSelected ? 'Deselect' : 'Select Page'}
                    </button>
                    <button
                      onClick={() => handleUnlockSelected()}
                      disabled={selectedChannels.length === 0 || isClearing}
                      className="px-3 py-2 text-sm font-bold text-black bg-brand-primary hover:bg-brand-hover rounded border border-brand-primary/40 transition-colors disabled:opacity-50"
                    >
                      Unlock Selected ({selectedChannels.length || 0})
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div
              role="table"
              aria-label="Locked channels"
              className="flex min-h-0 flex-1 flex-col rounded-lg border border-white/5 bg-black/10 overflow-hidden"
            >
              <div
                role="row"
                className="grid grid-cols-[40px_60px_120px_1fr_80px_100px] text-sm font-bold uppercase tracking-wider text-white/60 bg-white/5 border-b border-white/10 px-3 py-2"
              >
                <div role="columnheader">Select</div>
                <div role="columnheader" className="text-center">
                  CH
                </div>
                <div role="columnheader">Freq (MHz)</div>
                <div role="columnheader">Tag</div>
                <div role="columnheader" className="text-center">
                  Bank
                </div>
                <div role="columnheader" className="text-center">
                  Action
                </div>
              </div>

              <div role="rowgroup" className="flex-1 divide-y divide-white/5 overflow-y-auto">
                {filteredLockedChannels.map((channel) => {
                  const isSelected = selectedChannels.includes(channel.index);
                  return (
                    <div
                      key={channel.index}
                      role="row"
                      className={cn(
                        'grid grid-cols-[40px_60px_120px_1fr_80px_100px] items-center px-3 py-2 text-base',
                        isSelected ? 'bg-brand-primary/10' : 'hover:bg-white/5',
                      )}
                    >
                      <div role="cell" className="flex justify-center">
                        <input
                          type="checkbox"
                          aria-label={`Select channel ${channel.index}`}
                          checked={isSelected}
                          onChange={() => toggleSelection(channel.index)}
                          className="form-checkbox h-3.5 w-3.5 text-brand-primary bg-black/40 border-white/20 rounded"
                        />
                      </div>
                      <div role="cell" className="text-center text-sm text-white/70 font-mono">
                        CH {channel.index}
                      </div>
                      <div role="cell" className="text-sm font-mono text-white">
                        {channel.frequency.toFixed(4)}
                      </div>
                      <div role="cell" className="text-sm text-white/80 truncate">
                        {channel.alpha_tag || 'Untitled'}
                      </div>
                      <div role="cell" className="text-center text-sm text-white/60">
                        {channel.bank}
                      </div>
                      <div role="cell" className="flex justify-center">
                        <button
                          onClick={() => handleUnlockSelected([channel.index])}
                          aria-label={`Unlock channel ${channel.index}`}
                          className="px-2 py-1 text-sm font-bold text-black bg-brand-primary hover:bg-brand-hover rounded border border-brand-primary/50 transition-colors"
                        >
                          Unlock
                        </button>
                      </div>
                    </div>
                  );
                })}

                {filteredLockedChannels.length === 0 && (
                  <div className="py-16 text-center text-white/60 text-base">
                    {lockedChannelIds.length === 0 ? 'No locked channels' : 'No matches'}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Device Config */}
        {selectedCategory === 'Device Config' && (
          <div className="space-y-4 max-w-4xl">
            <div className="grid grid-cols-2 gap-6">
              {/* Audio Control */}
              <div className="bg-white/5 rounded-lg border border-white/10 p-4 space-y-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="rounded bg-brand-primary/20 p-1.5 text-brand-primary">
                    <Radio size={16} aria-hidden />
                  </div>
                  <h3 className="font-bold text-white">Audio & Power</h3>
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-sm font-medium text-white/70">
                    <span>Volume</span>
                    <span className="text-white">{volume}</span>
                  </div>
                  <Slider
                    aria-label="Volume"
                    value={[volume]}
                    max={15}
                    step={1}
                    onValueChange={handleVolumeChange}
                  />
                </div>

                <div className="space-y-3">
                  <div className="flex justify-between text-sm font-medium text-white/70">
                    <span>Squelch</span>
                    <span className="text-white">{squelch}</span>
                  </div>
                  <Slider
                    aria-label="Squelch"
                    value={[squelch]}
                    max={15}
                    step={1}
                    onValueChange={handleSquelchChange}
                  />
                </div>

                <div className="space-y-3 pt-2 border-t border-white/5">
                  <div className="flex justify-between text-sm font-medium text-white/70">
                    <span>Battery Saver</span>
                    <span className="text-white">{`${batterySaver}h`}</span>
                  </div>
                  <Slider
                    aria-label="Battery Saver"
                    value={[batterySaver]}
                    min={1}
                    max={16}
                    step={1}
                    onValueChange={handleBatterySaverChange}
                  />
                </div>
              </div>

              {/* Display Settings */}
              <div className="bg-white/5 rounded-lg border border-white/10 p-4 space-y-3">
                <div className="flex items-center gap-2 mb-2">
                  <div className="p-1.5 bg-blue-500/20 rounded text-blue-400">
                    <Maximize2 size={16} aria-hidden />
                  </div>
                  <h3 className="font-bold text-white">Display & System</h3>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-white/70">Backlight</span>
                    <Select value={backlight} onValueChange={handleBacklightChange}>
                      <SelectTrigger
                        aria-label="Backlight"
                        className="scanner-input h-7 w-[var(--size-select-medium)] text-sm"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent className="scanner-select-content">
                        <SelectItem value="AO">Always On</SelectItem>
                        <SelectItem value="AF">Always Off</SelectItem>
                        <SelectItem value="KY">Keypress</SelectItem>
                        <SelectItem value="SQ">Squelch</SelectItem>
                        <SelectItem value="KS">Key + Squelch</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-white/70">Contrast</span>
                    <Slider
                      aria-label="Contrast"
                      value={[contrast]}
                      min={1}
                      max={15}
                      step={1}
                      className="w-[var(--size-select-medium)]"
                      onValueChange={handleContrastChange}
                    />
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-white/5">
                    <label
                      htmlFor="key-beep"
                      className="text-sm font-medium text-white/70 cursor-pointer"
                    >
                      Key Beep
                    </label>
                    <Switch
                      id="key-beep"
                      className="data-[state=checked]:bg-brand-primary"
                      checked={keyBeepEnabled}
                      onCheckedChange={handleKeyBeepChange}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Scanning Logic */}
            <div className="bg-white/5 rounded-lg border border-white/10 p-4 space-y-3">
              <div className="flex items-center gap-2 mb-2">
                <div className="p-1.5 bg-green-500/20 rounded text-green-400">
                  <Signal size={16} aria-hidden />
                </div>
                <h3 className="font-bold text-white">Scanning Logic</h3>
              </div>

              <div className="grid grid-cols-2 gap-6">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-white/70">Priority Mode</span>
                  <Select value={priorityMode} onValueChange={handlePriorityModeChange}>
                    <SelectTrigger
                      aria-label="Priority Mode"
                      className="scanner-input h-7 w-[var(--size-select-medium)] text-sm"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="scanner-select-content">
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="on">On</SelectItem>
                      <SelectItem value="plus">Plus</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-3">
                  <Switch
                    id="weather-alert"
                    className="scale-75 data-[state=checked]:bg-brand-primary"
                    checked={weatherAlert}
                    onCheckedChange={handleWeatherAlertChange}
                  />
                  <label
                    htmlFor="weather-alert"
                    className="text-sm font-medium text-white/70 cursor-pointer"
                  >
                    Weather Alert Priority
                  </label>
                </div>
              </div>
            </div>

            {/* Device Info */}
            <div className="bg-white/5 rounded-lg border border-white/10 p-5 space-y-3">
              <h3 className="font-bold text-white text-base mb-4">Device Information</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-white/50">Model</span>
                  <span className="text-white">{deviceInfo?.model ?? 'BC125AT'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Port</span>
                  <span className="text-white">{deviceInfo?.port ?? 'USB'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Status</span>
                  <span className="text-white">{connectionStatusLabel}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-white/50">Firmware</span>
                  <span className="text-white">{firmware ?? '—'}</span>
                </div>
              </div>
              {deviceInfo?.diagnostic_message && (
                <div className="mt-4 rounded-md border border-amber-400/20 bg-amber-500/10 p-3 text-sm text-amber-100">
                  <p className="font-semibold text-amber-200">Connection Diagnostic</p>
                  <p className="mt-1 leading-relaxed">{deviceInfo.diagnostic_message}</p>
                </div>
              )}
              {showUsbTroubleshooting && (
                <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-3 text-sm text-white/80">
                  <p className="font-semibold text-white">USB Troubleshooting</p>
                  <ol className="mt-2 list-decimal space-y-1 pl-4">
                    <li>Reconnect the scanner with a known data-capable USB cable.</li>
                    <li>On the scanner, confirm USB mode is set for PC/Serial control.</li>
                    <li>If endpoint security is installed, allow USB serial access for Bearpaw.</li>
                  </ol>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Close Call */}
        {selectedCategory === 'Close Call' && (
          <div className="grid grid-cols-2 gap-8 max-w-4xl">
            <div className="space-y-8">
              <section className="space-y-4">
                <h3 className="text-lg font-bold text-white">Settings</h3>

                <div className="flex items-center justify-between">
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-white/70">Mode</span>
                    <span className="text-sm text-white/60">Operation mode</span>
                  </div>
                  <Select value={closeCallMode} onValueChange={handleCloseCallModeChange}>
                    <SelectTrigger
                      aria-label="Mode"
                      className="h-8 w-[var(--size-select-wide)] border-white/10 bg-white/5 text-sm"
                    >
                      <SelectValue placeholder="Select mode" />
                    </SelectTrigger>
                    <SelectContent className="scanner-select-content">
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="cc_dnd">CC DND</SelectItem>
                      <SelectItem value="cc_priority">CC Priority</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center gap-3 pt-2">
                  <Switch
                    id="cc-lockout"
                    className="data-[state=checked]:bg-brand-primary"
                    checked={closeCallLockout}
                    disabled={closeCallMode === 'off'}
                    onCheckedChange={(checked) => handleCloseCallSettingChange('lockout', checked)}
                  />
                  <label
                    htmlFor="cc-lockout"
                    className={cn(
                      'text-sm font-medium cursor-pointer',
                      closeCallMode === 'off' ? 'text-white/30' : 'text-white/70',
                    )}
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
                    className="data-[state=checked]:bg-brand-primary"
                    checked={closeCallBeep}
                    disabled={closeCallMode === 'off'}
                    onCheckedChange={(checked) =>
                      handleCloseCallSettingChange('alert_beep', checked)
                    }
                  />
                  <label
                    htmlFor="cc-beep"
                    className={cn(
                      'text-sm font-medium cursor-pointer',
                      closeCallMode === 'off' ? 'text-white/30' : 'text-white/70',
                    )}
                  >
                    Alert Beep
                  </label>
                </div>

                <div className="flex items-center gap-3">
                  <Switch
                    id="cc-light"
                    className="data-[state=checked]:bg-brand-primary"
                    checked={closeCallLight}
                    disabled={closeCallMode === 'off'}
                    onCheckedChange={(checked) =>
                      handleCloseCallSettingChange('alert_light', checked)
                    }
                  />
                  <label
                    htmlFor="cc-light"
                    className={cn(
                      'text-sm font-medium cursor-pointer',
                      closeCallMode === 'off' ? 'text-white/30' : 'text-white/70',
                    )}
                  >
                    Alert Light
                  </label>
                </div>
              </section>
            </div>

            <section className="space-y-4">
              <h3 className="text-lg font-bold text-white">Enabled Bands</h3>
              <div className="bg-white/5 rounded-lg p-4 space-y-4 border border-white/10">
                {['VHF Low', 'Air', 'VHF High', 'UHF', '800 MHz'].map((band, index) => (
                  <div key={band} className="flex items-center justify-between">
                    <label
                      htmlFor={`band-${band}`}
                      className={cn(
                        'text-sm font-medium cursor-pointer',
                        closeCallMode === 'off' ? 'text-white/30' : 'text-white/70',
                      )}
                    >
                      {band}
                    </label>
                    <Switch
                      id={`band-${band}`}
                      className="data-[state=checked]:bg-brand-primary"
                      checked={closeCallBands[index]}
                      disabled={closeCallMode === 'off'}
                      onCheckedChange={() => handleCloseCallBandToggle(index)}
                    />
                  </div>
                ))}
              </div>
            </section>
          </div>
        )}

        {/* Service Search */}
        {selectedCategory === 'Service Search' && (
          <div className="max-w-3xl">
            <div className="bg-white/5 rounded-lg border border-white/10 p-6">
              <p className="text-base text-white/60 mb-4">
                Service Search runs on the scanner itself. Enable the service banks you want to use,
                then start Service Search directly on the device.
              </p>
              <div className="grid grid-cols-2 gap-x-16 gap-y-4">
                {[
                  'Police',
                  'Fire/Emergency',
                  'Ham',
                  'Marine',
                  'Railroad',
                  'Civil Air',
                  'Military Air',
                  'CB',
                  'FRS/GMRS/MURS',
                  'Racing',
                ].map((service, index) => (
                  <div key={service} className="flex items-center justify-between group">
                    <label
                      htmlFor={`service-${service}`}
                      className="text-base font-medium text-white/70 group-hover:text-white transition-colors cursor-pointer"
                    >
                      {service}
                    </label>
                    <Switch
                      id={`service-${service}`}
                      className="data-[state=checked]:bg-brand-primary"
                      checked={serviceSearchGroups[index]}
                      onCheckedChange={() => handleServiceSearchToggle(index)}
                    />
                  </div>
                ))}
              </div>

              <div className="mt-6 pt-6 border-t border-white/10 space-y-4">
                <h3 className="text-base font-bold text-white">Search Settings</h3>

                <div className="flex items-center justify-between">
                  <label htmlFor="code-search" className="text-base font-medium text-white/70">
                    Code Search
                  </label>
                  <Switch
                    id="code-search"
                    className="data-[state=checked]:bg-brand-primary"
                    checked={codeSearchEnabled}
                    onCheckedChange={handleCodeSearchToggle}
                  />
                </div>

                <div>
                  <div className="flex justify-between text-sm font-medium text-white/70 mb-2">
                    {/* Radix puts an id on the slider Root, not the role=slider
                        thumb, so htmlFor can't target it — name via aria-label. */}
                    <span>Search Delay</span>
                    <span className="text-white">{searchDelay}s</span>
                  </div>
                  <Slider
                    aria-label="Search Delay"
                    min={0}
                    max={5}
                    step={1}
                    value={[searchDelay]}
                    onValueChange={handleSearchDelayChange}
                    className="w-full"
                  />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Custom Search */}
        {selectedCategory === 'Custom Search' && (
          <div className="flex flex-col max-w-5xl mx-auto overflow-hidden gap-4">
            <p className="text-base text-white/60">
              Custom Search runs on the scanner itself. Configure these ranges here, then start
              Custom Search directly on the device.
            </p>
            <div className="flex-1 h-full bg-black/20 rounded-lg border border-white/5 overflow-hidden flex flex-col shadow-inner">
              {/* Table Header */}
              <div className="grid grid-cols-[50px_60px_1fr_100px_100px] gap-2 px-4 py-2 bg-white/5 text-sm font-bold text-white/60 uppercase tracking-wider border-b border-white/5 shrink-0 select-none">
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
                      'group flex-1 grid min-h-[var(--size-panel-stat-min-height)] grid-cols-[50px_60px_1fr_100px_100px] items-center gap-2 border-b border-white/5 px-4 transition-colors last:border-0 hover:bg-white/5',
                      range.enabled && 'bg-brand-primary/5',
                    )}
                  >
                    <div className="flex justify-center">
                      <Switch
                        checked={range.enabled}
                        onCheckedChange={() => toggleRange(range.id)}
                        className={cn(
                          'scale-[0.6] data-[state=checked]:bg-brand-primary',
                          !range.enabled && 'opacity-50',
                        )}
                      />
                    </div>

                    <div className="text-sm font-mono font-bold text-white/60 group-hover:text-white/80 pl-1">
                      R-{range.id}
                    </div>

                    <div className="relative">
                      <input
                        aria-label={`Range ${range.id} label`}
                        value={range.label}
                        onChange={(e) => updateRange(range.id, 'label', e.target.value)}
                        className={cn(
                          'w-full bg-transparent border-none outline-none text-sm font-medium tracking-wide transition-colors placeholder:text-white/10',
                          range.enabled ? 'text-white/80' : 'text-white/30',
                        )}
                        placeholder="Label..."
                      />
                    </div>

                    <div className="relative">
                      <input
                        type="text"
                        aria-label={`Range ${range.id} lower MHz`}
                        value={range.start}
                        onChange={(e) => updateRange(range.id, 'start', e.target.value)}
                        className={cn(
                          'w-full bg-transparent border-b border-transparent focus:border-brand-primary text-sm font-mono font-bold text-center outline-none transition-all py-0',
                          range.enabled
                            ? 'text-brand-primary group-hover:text-brand-light'
                            : 'text-white/30 group-hover:border-white/10',
                        )}
                      />
                    </div>

                    <div className="relative">
                      <input
                        type="text"
                        aria-label={`Range ${range.id} upper MHz`}
                        value={range.end}
                        onChange={(e) => updateRange(range.id, 'end', e.target.value)}
                        className={cn(
                          'w-full bg-transparent border-b border-transparent focus:border-brand-primary text-sm font-mono font-bold text-center outline-none transition-all py-0',
                          range.enabled
                            ? 'text-brand-primary group-hover:text-brand-light'
                            : 'text-white/30 group-hover:border-white/10',
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
        {selectedCategory === 'Preferences' && (
          <div className="flex h-[calc(100%-4rem)] gap-6 overflow-hidden">
            {/* Info Sidebar (Left) */}
            <div className="w-[var(--layout-detail-sidebar-width)] shrink-0 space-y-4 overflow-y-auto border-r border-white/5 pb-4 pr-4">
              <div className="space-y-3">
                <div className="bg-white/5 rounded-lg border border-white/5 p-4 space-y-3">
                  <div className="flex items-center gap-2 mb-1">
                    <img
                      src={appIcon}
                      alt="Bearpaw"
                      className="w-8 h-8 rounded object-cover shadow-lg shadow-brand-primary/20"
                    />
                    <div>
                      <h3 className="font-bold text-white text-base">Bearpaw</h3>
                      <div className="text-sm text-white/60">v{__APP_VERSION__}</div>
                    </div>
                  </div>
                  <p className="text-sm text-white/60 leading-relaxed">
                    Community-developed control software for Uniden scanners.
                  </p>
                  <p className="text-sm text-white/50">Created by Jeremy Fuksa · KF0NUI</p>
                  <div className="flex gap-2 pt-2">
                    <button
                      onClick={() => openExternalUrl('https://github.com/jeremyfuksa/bearpaw')}
                      className="flex-1 py-1.5 bg-black/20 hover:bg-black/40 rounded text-sm text-white/70 transition-colors border border-white/5 flex items-center justify-center gap-1.5"
                    >
                      <Code size={10} aria-hidden /> Github
                    </button>
                  </div>
                </div>
              </div>

              <div className="relative overflow-hidden group rounded-lg">
                <div className="absolute inset-0 bg-gradient-to-br from-orange-500/20 to-orange-900/10" />
                <div className="relative p-4 space-y-3 border border-orange-500/20 rounded-lg">
                  <div className="flex items-center gap-2">
                    <div className="p-1.5 bg-brand-primary/20 rounded-full">
                      <Coffee aria-hidden className="h-3.5 w-3.5 text-brand-primary" />
                    </div>
                    <h3 className="text-sm font-bold text-white">Support Dev</h3>
                  </div>
                  <p className="text-sm text-white/60 leading-relaxed">
                    Enjoying the app? A little support helps keep updates coming!
                  </p>
                  <button
                    onClick={() => openExternalUrl('https://buymeacoffee.com/jeremyfuksa')}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-brand-primary hover:bg-brand-hover text-white text-sm font-bold rounded transition-colors shadow-lg shadow-brand-hover/20"
                  >
                    <Heart aria-hidden className="w-3 h-3 fill-white/20" />
                    Buy me a coffee
                  </button>
                </div>
              </div>
            </div>

            {/* Main Settings Area (Right) */}
            <div className="flex-1 space-y-6 overflow-y-auto pr-2">
              <div className="border-b border-white/5 pb-4">
                <h2 className="text-2xl font-bold text-white">Application Settings</h2>
                <p className="text-base text-white/50">Manage your workspace preferences</p>
              </div>

              {/* General Settings */}
              <section className="space-y-4">
                <h3 className="text-base font-bold text-white/80 flex items-center gap-2 uppercase tracking-wider">
                  <Settings aria-hidden className="w-4 h-4 text-white/50" /> General
                </h3>
                <div className="bg-black/20 rounded-lg border border-white/5 p-4 space-y-4">
                  <div className="flex items-center justify-between gap-6">
                    <div className="space-y-0.5">
                      <label className="text-base font-medium text-white">
                        Hit Minimum Duration
                      </label>
                      <p className="text-sm text-white/60">
                        Minimum seconds a transmission must last to be logged as a hit
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <Slider
                        aria-label="Hit Minimum Duration"
                        value={[preferences.hitMinDuration]}
                        onValueChange={(values) =>
                          handlePreferenceChange('hitMinDuration', values[0])
                        }
                        min={0.5}
                        max={10}
                        step={0.5}
                        className="w-[var(--size-select-wide)]"
                      />
                      <span className="text-sm text-white/70 w-12 text-right font-mono">
                        {preferences.hitMinDuration}s
                      </span>
                    </div>
                  </div>
                </div>
              </section>

              {/* Data Settings */}
              <section className="space-y-4">
                <h3 className="text-base font-bold text-white/80 flex items-center gap-2 uppercase tracking-wider">
                  <FileText aria-hidden className="w-4 h-4 text-white/50" /> Data & Storage
                </h3>
                <div className="bg-black/20 rounded-lg border border-white/5 p-4 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <label className="text-base font-medium text-white">Data Retention</label>
                      <p className="text-sm text-white/60">Auto-delete older logs</p>
                    </div>
                    <Select
                      value={String(preferences.dataRetentionDays)}
                      onValueChange={(value) =>
                        handlePreferenceChange('dataRetentionDays', parseInt(value))
                      }
                    >
                      <SelectTrigger className="h-8 w-[var(--size-select-medium)] border-white/10 bg-white/5 text-sm text-white">
                        <SelectValue placeholder="Select retention" />
                      </SelectTrigger>
                      <SelectContent className="bg-gray-900 border-white/10 text-white">
                        <SelectItem value="30">30 Days</SelectItem>
                        <SelectItem value="90">90 Days</SelectItem>
                        <SelectItem value="365">1 Year</SelectItem>
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
