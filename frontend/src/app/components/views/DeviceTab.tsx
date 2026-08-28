import { useCallback, useEffect, useMemo, useState } from 'react';
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
  RefreshCw,
} from 'lucide-react';

import appIcon from '@/assets/app-icon.png';
import { cn } from '../../../lib/utils';
import { getAPI, API_BASE } from '../../../api/useApi';
import { useStore, type Preferences } from '../../../store/useStore';
import { openExternalUrl, revealLogs, isTauriRuntime } from '../../../tauri-shell';
import { useConnectionStatus } from '../../../hooks/useConnectionStatus';
import { useScannerCapabilities } from '../../../hooks/useScannerCapabilities';
import { Slider } from '../ui/slider';
import { Switch } from '../ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { SearchRangeEditSheet } from './SearchRangeEditSheet';

type DeviceCategory =
  | 'Locked Channels'
  | 'Device Config'
  | 'Close Call'
  | 'Service Search'
  | 'Custom Search'
  | 'Preferences';

/**
 * Categories whose contents are read from the scanner and can therefore drift.
 *
 * Locked Channels is absent because it already refetches whenever it is
 * selected and shows its own sync time. Preferences is absent because it is
 * app state in SQLite, not device state -- nothing on the radio can change it.
 */
const REFRESHABLE_CATEGORIES: DeviceCategory[] = [
  'Device Config',
  'Close Call',
  'Service Search',
  'Custom Search',
];

interface SearchRange {
  id: number;
  enabled: boolean;
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
  checkUpdatesOnLaunch: 'check_updates_on_launch',
  analyticsScope: 'analytics_scope',
};

// Close Call (CLC) mode: UI value -> wire digit. Digits confirmed on hardware
// (fw 1.06.06, #241): 1 = Priority, 2 = DND. Captured twice — see
// docs/wire_captures/2026-08-03/clc-mode-probe.txt and
// clc-mode-probe-clean-baseline.txt (the latter re-run from mode 0, so neither
// reading rests on elimination). Both references agreed and the app had them
// inverted, so "CC Priority" was sending DND to the radio.
//
// Single source of truth on purpose. This map was previously inlined at four
// sites (one read, three writes); a fix that missed one would have the mode
// dropdown and the band/beep toggles sending DIFFERENT modes for the same
// selection. Read direction is derived below rather than written out, so the
// two cannot drift apart.
// Mode 3 (`CC Only`) is NOT in BC125AT_PROTOCOL.md §7.6, which documents only
// 0-2. It was found on hardware — see clc-mode-probe-cc-only.txt in the same
// capture directory. Both layers used to cap at 2, so a radio in CC Only
// reported a digit the UI could not display and the backend would reject.
export const CLOSE_CALL_MODE_TO_WIRE: Record<string, number> = {
  off: 0,
  cc_priority: 1,
  cc_dnd: 2,
  cc_only: 3,
};

export const CLOSE_CALL_WIRE_TO_MODE: Record<number, string> = Object.fromEntries(
  Object.entries(CLOSE_CALL_MODE_TO_WIRE).map(([mode, wire]) => [wire, mode]),
);

/**
 * Map a wire Close Call digit to its UI value.
 *
 * Returns `null` for a digit we don't model rather than falling back to 'off' —
 * the same guard `priorityWireToMode` carries, for the same reason (#340): this
 * dropdown is also the write path, so a wrong read becomes a wrong write on the
 * next save. `CC Only` (mode 3) was exactly that case before it was mapped.
 */
export function closeCallWireToMode(wire: number): string | null {
  return CLOSE_CALL_WIRE_TO_MODE[wire] ?? null;
}

// Priority scan (PRI) mode: UI value -> wire digit. Same derived-inverse shape
// as the Close Call maps above, and for the same reason — these were two
// hand-maintained inverse literals that could drift apart.
//
// All four digits confirmed on hardware (fw 1.06.06, #341) — see
// docs/wire_captures/2026-08-03/pri-mode-probe.txt. Every mode was entered from
// a different one, so each digit is a directly observed transition, not an
// inference: 1->0 Off, 0->2 Plus, 2->3 DND, 3->1 On.
//
// Mode 3 (DND) was withheld from the UI until that capture existed: both
// references and the backend's `(0..=3)` validation agreed on it, but per the
// captures-win rule (audit-reconciliation.md) agreeing references are not
// authority for a user-facing mapping. #241 is why that rule is taken
// literally here.
export const PRIORITY_MODE_TO_WIRE: Record<string, number> = {
  off: 0,
  on: 1,
  plus: 2,
  dnd: 3,
};

export const PRIORITY_WIRE_TO_MODE: Record<number, string> = Object.fromEntries(
  Object.entries(PRIORITY_MODE_TO_WIRE).map(([mode, wire]) => [wire, mode]),
);

/**
 * Map a wire priority digit to its UI value.
 *
 * Returns `null` for a digit we don't model rather than falling back to 'off'.
 * The old `priorityMap[mode] || 'off'` turned an unknown mode into a displayed
 * "Off", and because the dropdown is also the write path, the next save would
 * send `PRI,0` and genuinely switch priority off — a display gap quietly
 * becoming a state change the user never asked for.
 *
 * All four documented digits (0-3) are now mapped, so `null` means a digit
 * outside the known range. Keep the null-return: the failure it guards against
 * is a silent write of the wrong mode, which does not stop being a hazard just
 * because today's map happens to be complete.
 */
export function priorityWireToMode(wire: number): string | null {
  return PRIORITY_WIRE_TO_MODE[wire] ?? null;
}

export interface DeviceTabProps {
  /**
   * Run a manual update check (#273). Owned by App.tsx rather than by a
   * local `useUpdateCheck` call: the hook also runs the startup check, so a
   * second instance here would fire an extra request every time this tab
   * mounts and keep its own unrelated `checking` state.
   *
   * Optional so the component still renders bare in tests and outside Tauri.
   */
  onCheckForUpdates?: () => void;
  /** True while a manual check is in flight; disables the button. */
  checkingForUpdates?: boolean;
}

export function DeviceTab({ onCheckForUpdates, checkingForUpdates }: DeviceTabProps = {}) {
  const api = getAPI();
  const connectionStatus = useConnectionStatus();
  const deviceInfo = useStore((state) => state.deviceInfo);
  const liveState = useStore((state) => state.liveState);
  // Selected raw and defaulted inside the memo below rather than with a
  // `?? []` here: the fallback allocates a new array on every render while
  // channels is null, which lands in the `lockedChannels` deps array and
  // defeats that memo (react-hooks/exhaustive-deps).
  const channels = useStore((state) => state.channels);
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
  // Controls for commands the scanner does not implement are hidden, not
  // disabled: on a BC75XLT, BLT / BSV / CNT / WXS all reply ERR (settings probe
  // 2026-08-26, docs/wire_captures/2026-08-26/). A visible control that cannot
  // work is worse than an absent one -- it invites a click that silently fails.
  const capabilities = useScannerCapabilities();

  // Service Search is hidden on a scanner with no `SSG` command. The BC75XLT
  // HAS service search -- ten bands on the `Svc` key -- but no way to enable or
  // disable one remotely, so all ten toggles here would be dead. Hidden rather
  // than disabled: a page of controls the scanner cannot honour asks the same
  // question on every visit (CLAUDE.md frontend pitfall #5). The band names are
  // wrong for that model too -- `WX` leads its list and it has no Military Air.
  const categories = useMemo<DeviceCategory[]>(() => {
    const all: DeviceCategory[] = [
      'Device Config',
      'Close Call',
      'Service Search',
      'Custom Search',
      'Locked Channels',
    ];
    return capabilities.has_service_search_groups
      ? all
      : all.filter((cat) => cat !== 'Service Search');
  }, [capabilities.has_service_search_groups]);

  // Derived during render rather than corrected by an effect: swapping scanners
  // can strip the category the user is standing on, and an effect-synced copy is
  // stale for the render in which capabilities changed -- one frame of a page
  // with no content. Same reasoning as `visibleSelectedChannels` below.
  // The Display & System card holds only capability-gated controls, so on a
  // scanner with none of them it renders as an empty titled box -- which is
  // what a BC75XLT got once #471 gated Key Beep alongside BLT and CNT. Gate the
  // card on its own contents rather than adding a fourth ungated control to
  // justify it.
  const showDisplayCard =
    capabilities.has_backlight_control || capabilities.has_contrast || capabilities.has_key_beep;

  const activeCategory: DeviceCategory =
    selectedCategory === 'Preferences' || categories.includes(selectedCategory)
      ? selectedCategory
      : 'Device Config';
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

  // Custom Search Settings.
  //
  // Placeholders until `CSP,1..10` hydrates them, so they say nothing rather
  // than something false. The previous seed named bands the ranges were not
  // ('VHF Low' on 25-54, which is CB) and two the scanner cannot receive at all
  // ('800 MHz', 1240-1300) -- see #477. A row that reads `Range 4  —  —` is
  // obviously waiting for the radio; one that reads `800 MHz  806.0000` looks
  // like a setting.
  const [editingRangeId, setEditingRangeId] = useState<number | null>(null);
  const [searchRanges, setSearchRanges] = useState<SearchRange[]>(() =>
    Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      enabled: false,
      start: '',
      end: '',
    })),
  );

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
    const channelMap = new Map((channels ?? []).map((ch) => [ch.index, ch]));
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

  // Selection scoped to what the active search/bank filter currently shows.
  // Derived during render rather than pruned by an effect
  // (react-hooks/set-state-in-effect): the raw `selectedChannels` state can
  // hold ids that the filter has since hidden, and an effect-synced copy is
  // stale for the render in which the filter changed. Every read below goes
  // through this value — including the unlock target, so the user can never
  // unlock a channel they cannot see.
  const visibleSelectedChannels = useMemo(() => {
    const visible = new Set(filteredLockedChannels.map((channel) => channel.index));
    return selectedChannels.filter((id) => visible.has(id));
  }, [filteredLockedChannels, selectedChannels]);

  const allSelected =
    filteredLockedChannels.length > 0 &&
    filteredLockedChannels.every((channel) => visibleSelectedChannels.includes(channel.index));

  useEffect(() => {
    if (activeCategory !== 'Locked Channels') return;
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
  }, [api, activeCategory]);

  /**
   * Read every device setting in one pass.
   *
   * Runs on mount and from the Refresh control. Deliberately NOT polled: the
   * backend answers this by opening a program-mode bracket, which parks the
   * scanner in HOLD at channel 1 for the duration. On a timer that would make
   * the radio unusable.
   *
   * `shouldContinue` lets the mount effect abandon a load whose component has
   * unmounted; the Refresh path passes nothing and always applies.
   */
  const loadAllSettings = useCallback(
    async (shouldContinue: () => boolean = () => true) => {
      try {
        const settings = await api.getAllSettings();

        const active = shouldContinue();
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
          const mode = priorityWireToMode(settings.priority.mode);
          if (mode === null) {
            // Unmodelled wire mode (3 = Priority DND per the reference; no
            // capture yet). Don't render it as "Off" — that would let the next
            // save clobber the radio's actual setting with PRI,0.
            console.warn(
              `Unsupported priority mode from scanner: ${settings.priority.mode} (not shown in UI)`,
            );
          } else {
            setPriorityMode(mode);
          }
        }
        if (settings.weather) {
          setWeatherAlert(settings.weather.priority);
        }

        // Populate close call settings
        if (settings.close_call) {
          const ccMode = closeCallWireToMode(settings.close_call.mode);
          if (ccMode === null) {
            // Unmodelled wire mode. Don't render it as "Off" — that would let
            // the next save clobber the radio's actual setting with CLC,0.
            console.warn(
              `Unsupported close call mode from scanner: ${settings.close_call.mode} (not shown in UI)`,
            );
          } else {
            setCloseCallMode(ccMode);
          }
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
          setSearchRanges(
            settings.custom_search_ranges.map((r, idx) => ({
              id: r.index,
              enabled: settings.custom_search?.groups[idx] || false,
              start: r.lower.toFixed(4),
              end: r.upper.toFixed(4),
            })),
          );
        }
      } catch (error) {
        console.error('Failed to load all settings', error);
        toast.error('Failed to load device settings');
      }
    },
    [api],
  );

  useEffect(() => {
    let mounted = true;
    // `loadAllSettings` is async and every setState inside it happens after an
    // await, so nothing is set synchronously here -- the rule cannot see past
    // the call. The `mounted` flag is what actually prevents a late response
    // from setting state on an unmounted component.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAllSettings(() => mounted);
    return () => {
      mounted = false;
    };
  }, [loadAllSettings]);

  // The scanner has no change notification -- it answers questions and never
  // volunteers that something moved. So anything changed on the front panel
  // stays invisible here until this runs again. Refresh makes that recoverable
  // and, via the timestamp, visible.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [settingsReadAt, setSettingsReadAt] = useState<number | null>(null);

  const handleRefreshSettings = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await loadAllSettings();
      setSettingsReadAt(Date.now());
    } finally {
      setIsRefreshing(false);
    }
  }, [loadAllSettings]);

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
      const targets = targetIds ?? visibleSelectedChannels;
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
    [api, visibleSelectedChannels, setChannels],
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

  // Priority modes silently do nothing unless some channel carries the
  // priority flag — the radio shows "Priority Scan: No Channel" on its own
  // display and the mode does not stick (#346, fw 1.06.06; recorded as
  // Conflict 5 in docs/wire_captures/2026-05-21/audit-reconciliation.md).
  // Priority is bank-exclusive but not bank-scoped for this precondition: one
  // flagged channel anywhere in memory satisfies the radio.
  //
  // Gated on `hasSyncedInitially`, not on `channels.length`: before memory
  // sync the channel list is empty, which is indistinguishable from "synced,
  // nothing flagged" — warning then would be a false alarm on every cold
  // start. This is the one place `hasSyncedInitially` means what it says
  // ("has memory ever been read?"); do NOT copy this gate to the sync overlay,
  // where it is the known #102 regression.
  const hasSyncedInitially = useStore((state) => state.sync.hasSyncedInitially);
  const noPriorityChannel = useMemo(
    () => hasSyncedInitially && !channels.some((c) => c.priority),
    [hasSyncedInitially, channels],
  );

  const handlePriorityModeChange = useCallback(
    async (value: string) => {
      setPriorityMode(value);
      try {
        await api.setPrioritySettings(PRIORITY_MODE_TO_WIRE[value] || 0);
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
      try {
        await api.setCloseCallSettings({
          mode: CLOSE_CALL_MODE_TO_WIRE[value] || 0,
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
      const updates: Record<string, boolean> = {
        lockout: closeCallLockout,
        alert_beep: closeCallBeep,
        alert_light: closeCallLight,
        [setting]: value,
      };

      try {
        await api.setCloseCallSettings({
          mode: CLOSE_CALL_MODE_TO_WIRE[closeCallMode] || 0,
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

      try {
        await api.setCloseCallSettings({
          mode: CLOSE_CALL_MODE_TO_WIRE[closeCallMode] || 0,
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

  // Batched behind the edit sheet's Save button. This used to fire
  // `setCustomSearchRange` from the table's `onChange`, so every keystroke that
  // left both fields parseable wrote to the radio: typing `146.5` into an empty
  // lower limit sent CSP writes for `1`, `14`, `146` and `146.5`, three of them
  // values nobody chose. Each opens a program-mode bracket, which parks the
  // scanner in HOLD at channel 1.
  const saveRange = useCallback(
    async (id: number, draft: { start: string; end: string }) => {
      const startVal = parseFloat(draft.start);
      const endVal = parseFloat(draft.end);
      if (isNaN(startVal) || isNaN(endVal)) return;
      try {
        await api.setCustomSearchRange(id, startVal, endVal);
        setSearchRanges((prev) =>
          prev.map((r) => (r.id === id ? { ...r, start: draft.start, end: draft.end } : r)),
        );
      } catch (error) {
        console.error('Failed to update search range', error);
        toast.error('Failed to update search range');
      }
    },
    [api],
  );

  const editingRange = searchRanges.find((r) => r.id === editingRangeId) ?? null;

  const activeRangeCount = searchRanges.filter((r) => r.enabled).length;

  const volume = liveState?.volume ?? 0;

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex h-full gap-6">
      {/* Side Nav */}
      <div className="scanner-surface flex h-full w-[var(--layout-sidebar-device-width)] flex-col p-2">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            aria-current={activeCategory === cat ? 'page' : undefined}
            className={cn(
              'text-left px-3 py-2 rounded text-sm font-medium transition-colors',
              activeCategory === cat
                ? 'bg-brand-hover/20 text-brand-hover'
                : 'text-white/60 hover:bg-white/5 hover:text-white',
            )}
          >
            {cat}
          </button>
        ))}

        {/* Preferences at bottom */}
        <button
          onClick={() => setSelectedCategory('Preferences')}
          aria-current={activeCategory === 'Preferences' ? 'page' : undefined}
          className={cn(
            'text-left px-3 py-2 rounded text-sm font-medium transition-colors mt-auto border-t border-white/10 pt-3',
            activeCategory === 'Preferences'
              ? 'bg-brand-hover/20 text-brand-hover'
              : 'text-white/60 hover:bg-white/5 hover:text-white',
          )}
        >
          Preferences
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 bg-black/20 rounded-lg border border-white/5 p-6 h-full overflow-y-auto">
        {activeCategory !== 'Locked Channels' && (
          <h2 className="text-lg font-bold mb-6 border-b border-white/10 pb-2 flex items-center justify-between gap-4">
            <span>{selectedCategory}</span>
            <span className="flex items-center gap-4">
              {activeCategory === 'Custom Search' && (
                <span className="text-sm font-normal text-white/50">
                  {activeRangeCount} of 10 active
                </span>
              )}
              {REFRESHABLE_CATEGORIES.includes(activeCategory) && (
                <>
                  {settingsReadAt && (
                    <span className="text-sm font-normal text-white/40">
                      Read {new Date(settingsReadAt).toLocaleTimeString()}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={handleRefreshSettings}
                    disabled={isRefreshing}
                    className="flex items-center gap-1.5 rounded border border-white/5 bg-black/20 px-2.5 py-1 text-sm font-normal text-white/70 transition-colors hover:bg-black/40 hover:text-white disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw
                      size={14}
                      aria-hidden
                      className={cn(isRefreshing && 'animate-spin')}
                    />
                    {isRefreshing ? 'Reading…' : 'Refresh'}
                  </button>
                </>
              )}
            </span>
          </h2>
        )}

        {/* Locked Channels */}
        {activeCategory === 'Locked Channels' && (
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
                    Selected: {visibleSelectedChannels.length}
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
                      disabled={visibleSelectedChannels.length === 0 || isClearing}
                      className="px-3 py-2 text-sm font-bold text-black bg-brand-primary hover:bg-brand-hover rounded border border-brand-primary/40 transition-colors disabled:opacity-50"
                    >
                      Unlock Selected ({visibleSelectedChannels.length || 0})
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
                  const isSelected = visibleSelectedChannels.includes(channel.index);
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
        {activeCategory === 'Device Config' && (
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

                {capabilities.has_battery_save && (
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
                )}
              </div>

              {/* Display Settings. Gated as a whole, not control by control:
                  every control it holds is capability-gated, so on a BC75XLT
                  (no BLT, no CNT, and KBP's beep field reserved) it rendered as
                  an empty titled box. Scanning Logic takes the grid slot instead
                  of leaving the row half empty. */}
              {showDisplayCard && (
                <div className="bg-white/5 rounded-lg border border-white/10 p-4 space-y-3">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="p-1.5 bg-blue-500/20 rounded text-blue-400">
                      <Maximize2 size={16} aria-hidden />
                    </div>
                    <h3 className="font-bold text-white">Display & System</h3>
                  </div>

                  <div className="space-y-4">
                    {capabilities.has_backlight_control && (
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
                    )}

                    {capabilities.has_contrast && (
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
                    )}

                    {capabilities.has_key_beep && (
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
                    )}
                  </div>
                </div>
              )}
              {/* Scanning Logic */}
              <div
                className={cn(
                  'bg-white/5 rounded-lg border border-white/10 p-4 space-y-3',
                  showDisplayCard && 'col-span-2',
                )}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className="p-1.5 bg-green-500/20 rounded text-green-400">
                    <Signal size={16} aria-hidden />
                  </div>
                  <h3 className="font-bold text-white">Scanning Logic</h3>
                </div>

                <div className="grid grid-cols-2 gap-6">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-white/70">Priority Mode</span>
                      <Select value={priorityMode} onValueChange={handlePriorityModeChange}>
                        <SelectTrigger
                          aria-label="Priority Mode"
                          aria-describedby={noPriorityChannel ? 'priority-no-channel' : undefined}
                          className="scanner-input h-7 w-[var(--size-select-medium)] text-sm"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent className="scanner-select-content">
                          <SelectItem value="off">Off</SelectItem>
                          <SelectItem value="on">On</SelectItem>
                          <SelectItem value="plus">Plus</SelectItem>
                          <SelectItem value="dnd">DND</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    {noPriorityChannel && (
                      <p
                        id="priority-no-channel"
                        className="rounded-md border border-amber-400/20 bg-amber-500/10 p-2 text-xs leading-relaxed text-amber-100"
                      >
                        No channel is flagged as priority, so these modes will not engage. Flag one
                        on the Channels page.
                      </p>
                    )}
                  </div>

                  {capabilities.has_weather_alert && (
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
                  )}
                </div>
              </div>
            </div>

            {/* Device Info */}
            <div className="bg-white/5 rounded-lg border border-white/10 p-5 space-y-3">
              <h3 className="font-bold text-white text-base mb-4">Device Information</h3>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-white/50">Model</span>
                  {/* No 'BC125AT' fallback: Bearpaw drives two families now, so
                      naming one when nothing is connected is a guess presented
                      as fact. */}
                  <span className="text-white">{deviceInfo?.model ?? '—'}</span>
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
                {/* Capacity varies by model — 500 channels in banks of 50 on the
                    BC125AT family, 300 in banks of 30 on the BC75XLT. With two
                    supported families a user with both scanners otherwise has no
                    in-app way to confirm which one Bearpaw is driving. */}
                <div className="flex justify-between">
                  <span className="text-white/50">Memory</span>
                  <span className="text-white">
                    {deviceInfo?.capabilities
                      ? `${capabilities.channel_count} ch · ${capabilities.bank_count}×${capabilities.channels_per_bank}`
                      : '—'}
                  </span>
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
        {activeCategory === 'Close Call' && (
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
                      <SelectItem value="cc_only">CC Only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {/* CLC field 5 is reserved on some models: written `1` on a
                    BC75XLT it reads back empty (hardware 2026-08-28). It is
                    accepted without an error and silently discarded, so
                    nothing but a read-back would ever reveal the failure. */}
                {capabilities.has_close_call_hit_scan && (
                  <div className="flex items-center gap-3 pt-2">
                    <Switch
                      id="cc-lockout"
                      className="data-[state=checked]:bg-brand-primary"
                      checked={closeCallLockout}
                      disabled={closeCallMode === 'off'}
                      onCheckedChange={(checked) =>
                        handleCloseCallSettingChange('lockout', checked)
                      }
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
                )}
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
                {/* Index IS the wire position in the 5-character CLC mask, so
                    the reserved slot is skipped in place rather than filtered
                    out -- `entries()` keeps the index after the null is gone.
                    The families disagree on positions 4 and 5 (BC125AT: UHF,
                    800 MHz; BC75XLT: reserved, UHF), verified on hardware
                    2026-08-28. Remapping only one of the two would leave a
                    "UHF" switch writing the reserved slot. */}
                {[...capabilities.close_call_bands.entries()]
                  .filter((entry): entry is [number, string] => entry[1] !== null)
                  .map(([index, band]) => (
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
        {activeCategory === 'Service Search' && (
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
        {activeCategory === 'Custom Search' && (
          <div className="flex flex-col max-w-5xl mx-auto overflow-hidden gap-4">
            {/* Both halves of this are load-bearing. Writes ARE immediate --
                a range edit or an Active toggle reaches the scanner as soon as
                it is made -- but every write runs inside a PRG/EPG bracket, and
                the vendor spec is explicit that EPG leaves the scanner in Scan
                Hold. So the change lands and then appears to do nothing, which
                reads as a failed write rather than a parked radio. Naming Srch
                is the recovery; the manual's own procedure is "Press Srch to
                start searching your custom search range". */}
            <p className="text-base text-white/60">
              Custom Search runs on the scanner itself. Range edits and Active toggles are written
              to the scanner immediately — but each write leaves it in Hold, so press{' '}
              <span className="font-bold text-white/80">Srch</span> on the scanner to resume
              searching with the new settings.
            </p>
            <div className="flex-1 h-full bg-black/20 rounded-lg border border-white/5 overflow-hidden flex flex-col shadow-inner">
              {/* Table Header */}
              {/* Table Header. No Label column: `CSP` has no name field on
                  either model, so a label could never be saved -- the old one
                  wrote to local state and vanished on reload. `R-n` already
                  names the row. */}
              <div className="grid grid-cols-[72px_80px_1fr_1fr] gap-2 px-4 py-2 bg-white/5 text-sm font-bold text-white/60 uppercase tracking-wider border-b border-white/5 shrink-0 select-none">
                <div className="text-center">Active</div>
                <div>Range</div>
                <div className="text-center">Lower (MHz)</div>
                <div className="text-center">Upper (MHz)</div>
              </div>

              {/* Table Body */}
              <div className="flex-1 flex flex-col min-h-0">
                {searchRanges.map((range) => (
                  <div
                    key={range.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Edit search range ${range.id}`}
                    onClick={() => setEditingRangeId(range.id)}
                    // Enter/Space opens the sheet -- the row's primary action.
                    // The target===currentTarget guard leaves a Space press on
                    // the Active switch toggling the switch instead. Same shape
                    // as ChannelsTab's row (a11y C1).
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setEditingRangeId(range.id);
                      }
                    }}
                    className={cn(
                      'group flex-1 grid min-h-[var(--size-panel-stat-min-height)] cursor-pointer grid-cols-[72px_80px_1fr_1fr] items-center gap-2 border-b border-white/5 px-4 text-left transition-colors last:border-0 hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
                      range.enabled && 'bg-brand-primary/5',
                    )}
                  >
                    <div className="flex justify-center" onClick={(e) => e.stopPropagation()}>
                      <Switch
                        aria-label={`Range ${range.id} active`}
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

                    <div
                      className={cn(
                        'text-center text-sm font-mono font-bold',
                        range.enabled
                          ? 'text-brand-primary group-hover:text-brand-light'
                          : 'text-white/30',
                      )}
                    >
                      {range.start || '—'}
                    </div>

                    <div
                      className={cn(
                        'text-center text-sm font-mono font-bold',
                        range.enabled
                          ? 'text-brand-primary group-hover:text-brand-light'
                          : 'text-white/30',
                      )}
                    >
                      {range.end || '—'}
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {editingRange && (
              <SearchRangeEditSheet
                index={editingRange.id}
                draft={{ start: editingRange.start, end: editingRange.end }}
                isOpen
                onClose={() => setEditingRangeId(null)}
                onSave={(draft) => saveRange(editingRange.id, draft)}
              />
            )}
          </div>
        )}

        {/* Preferences */}
        {activeCategory === 'Preferences' && (
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
                      <Code size={20} aria-hidden /> Github
                    </button>
                  </div>
                  {/* #273: same action as Help → Check for Updates, surfaced
                      next to the version number people actually look at. */}
                  {isTauriRuntime() && onCheckForUpdates && (
                    <button
                      onClick={onCheckForUpdates}
                      disabled={checkingForUpdates}
                      className="w-full py-1.5 bg-black/20 hover:bg-black/40 rounded text-sm text-white/70 transition-colors border border-white/5 flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <RefreshCw
                        size={16}
                        aria-hidden
                        className={cn(checkingForUpdates && 'animate-spin')}
                      />
                      {checkingForUpdates ? 'Checking…' : 'Check for Updates'}
                    </button>
                  )}
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
                    <Heart aria-hidden className="w-5 h-5 fill-white/20" />
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
                  {isTauriRuntime() && (
                    <div className="flex items-center justify-between gap-6">
                      <div className="space-y-0.5">
                        <label className="text-base font-medium text-white">Log Files</label>
                        <p className="text-sm text-white/60">
                          Open the folder containing this session's backend log
                        </p>
                      </div>
                      <button
                        onClick={() => void revealLogs()}
                        className="shrink-0 py-1.5 px-3 bg-black/20 hover:bg-black/40 rounded text-sm text-white/70 transition-colors border border-white/5"
                      >
                        Show Log Files
                      </button>
                    </div>
                  )}
                  {/* #273: the app is otherwise fully offline, so the one
                      network call it makes needs an opt-out. */}
                  {isTauriRuntime() && (
                    <div className="flex items-center justify-between gap-6">
                      <div className="space-y-0.5">
                        <label
                          htmlFor="check-updates-on-launch"
                          className="text-base font-medium text-white"
                        >
                          Check for Updates on Launch
                        </label>
                        <p className="text-sm text-white/60">
                          Ask GitHub for a newer release when Bearpaw starts
                        </p>
                      </div>
                      <Switch
                        id="check-updates-on-launch"
                        checked={preferences.checkUpdatesOnLaunch}
                        onCheckedChange={(checked) =>
                          handlePreferenceChange('checkUpdatesOnLaunch', checked)
                        }
                      />
                    </div>
                  )}

                  {/* Not gated on capabilities: the choice is about the stored
                    history, which can contain hits from a scanner that is not
                    the one attached right now. Hiding it when only one scanner
                    has ever been used would hide it exactly when a user is
                    trying to work out why their old hits disappeared. */}
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <label htmlFor="analytics-scope" className="text-base font-medium text-white">
                        Combine Scanner Analytics
                      </label>
                      <p className="text-sm text-white/60">
                        Count hits from every scanner you have used, not just the connected one
                      </p>
                    </div>
                    <Switch
                      id="analytics-scope"
                      checked={preferences.analyticsScope === 'all'}
                      onCheckedChange={(checked) =>
                        handlePreferenceChange('analyticsScope', checked ? 'all' : 'scanner')
                      }
                    />
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
