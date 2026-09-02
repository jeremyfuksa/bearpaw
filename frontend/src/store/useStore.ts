import { create } from 'zustand';
import type { ActivityLogEntry, ChannelData, ChannelDraft, DeviceInfo, LiveState } from '../types';

export interface Preferences {
  theme: 'night' | 'field';
  displayMode: 'frequency' | 'alpha';
  reducedMotion: boolean;
  hitMinDuration: number;
  dataRetentionDays: number;
  audioOutputDevice: string;
  /** #273: gates the automatic update check the desktop shell runs at launch. */
  checkUpdatesOnLaunch: boolean;
  /**
   * Whether channel memory is re-read from the scanner at every connect, or
   * rendered from the SQLite cache (#413) until the user asks.
   *
   * Defaults true -- the pre-cache behaviour. A scanner programmed on its own
   * keypad has a cache that is stale before Bearpaw opens, and a user poll
   * found that is the majority case. Off is right for anyone who only programs
   * from a computer: their cache is never stale, and startup is instant.
   */
  rereadMemoryOnConnect: boolean;
  /**
   * Whether the Scan page's analytics count only the connected scanner
   * ('scanner') or every scanner ever attached ('all').
   *
   * Governs Busiest Channels, the Activity Heatmap and Recent Hits together:
   * a heatmap showing both radios beside a chart showing one reads as a bug
   * rather than a choice.
   */
  analyticsScope: 'scanner' | 'all';
  /**
   * Timezone the activity-log CSV is stamped in (#498).
   *
   * Local is the default because the export sheet already SELECTS in local
   * time. UTC exists because amateur radio logs in it by convention, so the
   * two constituencies want genuinely opposite things and neither can be
   * derived from the other without work in a spreadsheet.
   *
   * Labelling only. It deliberately does NOT move the timeframe filters: a
   * display preference that silently changed which rows you got would be a
   * worse surprise than a UTC-stamped export of your local day.
   */
  activityExportTimezone: 'local' | 'utc';
}

/**
 * Memory-sync orchestration state. The actual transport-level sync runs in
 * the Rust backend; this is what the UI knows about it. `inProgress` is the
 * "is there a sync running right now" signal that drives UI gating;
 * `hasSyncedInitially` tells us whether we've ever completed a sync this
 * session (used to distinguish the initial-load spinner from a user-
 * triggered re-sync).
 */
export interface SyncState {
  inProgress: boolean;
  hasSyncedInitially: boolean;
  taskId: string | null;
  message: string;
  percent: number;
  /**
   * Epoch seconds for when channel memory was last read from the scanner, or
   * null if it never has been. From `GET /memory/sync/status` (#413).
   *
   * NOT the same question as `hasSyncedInitially`, which means "a sync
   * completed in THIS session". Channel memory persists across restarts, so a
   * cache-loaded session has a real `syncedAt` and `hasSyncedInitially: false`.
   */
  syncedAt: number | null;
}

/**
 * Channel/config import progress, driven by the backend's `import-*` WS
 * progress messages. Deliberately separate from SyncState so import progress
 * can never bleed into the regression-guarded memory-sync overlay or handler.
 */
export interface ImportProgressState {
  active: boolean;
  percent: number;
  message: string;
}

export interface AppStore {
  liveState: LiveState | null;
  deviceInfo: DeviceInfo | null;
  channels: ChannelData[];
  banks: boolean[];
  /**
   * Whether `banks` reflects a real `SCG` read, or is still the all-enabled
   * placeholder.
   *
   * The default is ten enabled banks, which is a GUESS presented as fact: a
   * scanner with banks 8-10 off showed all ten lit until the first successful
   * read, and toggling from that view would have written the guessed mask back
   * to the radio. Consumers must render a distinct "unknown" state rather than
   * treat the placeholder as truth.
   */
  banksKnown: boolean;
  sync: SyncState;
  importProgress: ImportProgressState;
  fullActivityLog: ActivityLogEntry[];
  preferences: Preferences;
  lastSequence: number;
  memoryDrafts: Record<number, ChannelDraft>;
  memoryEditingIndex: number | null;

  updateLiveState: (state: Partial<LiveState>, sequence?: number) => void;
  resetSequence: () => void;
  setDeviceInfo: (info: DeviceInfo | null) => void;
  setChannels: (channels: ChannelData[] | ((prev: ChannelData[]) => ChannelData[])) => void;
  setBanks: (banks: boolean[]) => void;
  updateSync: (patch: Partial<SyncState>) => void;
  setImportProgress: (patch: Partial<ImportProgressState>) => void;
  updatePreferences: (prefs: Partial<Preferences>) => void;
  setMemoryEditingIndex: (index: number | null) => void;
  setMemoryDraft: (index: number, draft: ChannelDraft) => void;
  clearMemoryDrafts: () => void;
  addToFullActivityLog: (entry: ActivityLogEntry) => void;
  hydrateActivityLogs: (entries: ActivityLogEntry[]) => void;
}

const defaultPreferences: Preferences = {
  theme: 'night',
  displayMode: 'frequency',
  reducedMotion: false,
  hitMinDuration: 2,
  dataRetentionDays: 30,
  audioOutputDevice: 'default',
  checkUpdatesOnLaunch: true,
  rereadMemoryOnConnect: true,
  analyticsScope: 'scanner',
  activityExportTimezone: 'local',
};

/**
 * Map the backend's stored preferences onto the store's shape.
 *
 * REGRESSION GUARD (#509): the return type is `Preferences`, NOT
 * `Partial<Preferences>`. That `Partial` is what let `analyticsScope` be
 * omitted here for its whole life: it was wired into PREFERENCE_KEY_MAP so it
 * SAVED correctly, and the backend honoured it when scoping /activity-log, but
 * nothing ever read it back. Every launch reset the store to 'scanner' while
 * the API kept returning every scanner's hits, so the data and the toggle
 * disagreed and neither looked broken alone.
 *
 * A preference needs both halves. Requiring the full type means the compiler
 * refuses the next omission instead of a person having to notice it.
 *
 * Deliberately NOT derived from PREFERENCE_KEY_MAP. This is not a key rename:
 * each line carries its own coercion and default, and `checkUpdatesOnLaunch`
 * documents why `??` and `||` are not interchangeable. A generic mapping would
 * erase exactly the per-key logic that matters.
 */
export function mapStoredPreferences(stored: Record<string, unknown>): Preferences {
  const prefs = stored as Record<string, any>;
  return {
    theme: prefs.theme === 'field' ? 'field' : 'night',
    displayMode: prefs.displayMode || 'frequency',
    reducedMotion: prefs.reduced_motion || false,
    hitMinDuration: prefs.hit_min_duration || 2,
    dataRetentionDays: prefs.data_retention_days || 30,
    audioOutputDevice: prefs.audio_output_device || 'default',
    // `??`, not `||`: this defaults to true, so `||` would coerce a stored
    // `false` back to `true` and the toggle would silently revert on every
    // launch. Only null/undefined mean "unset".
    checkUpdatesOnLaunch: prefs.check_updates_on_launch ?? true,
    // `??` for the same reason as above: defaults true, so `||` would coerce
    // a stored `false` back on every launch.
    rereadMemoryOnConnect: prefs.reread_memory_on_connect ?? true,
    analyticsScope: prefs.analytics_scope === 'all' ? 'all' : 'scanner',
    activityExportTimezone: prefs.activity_export_timezone === 'utc' ? 'utc' : 'local',
  };
}

const defaultLiveState: LiveState = {
  timestamp: 0,
  frequency: 0,
  modulation: 'FM',
  squelch_open: false,
  rssi: 0,
  mode: 'SCAN',
  channel: null,
  alpha_tag: null,
  volume: 0,
  battery: null,
  stale: true,
};

const defaultBanks: boolean[] = Array.from({ length: 10 }, () => true);

const defaultSync: SyncState = {
  inProgress: false,
  hasSyncedInitially: false,
  taskId: null,
  message: 'Loading channels from device...',
  percent: 0,
  syncedAt: null,
};

const defaultImportProgress: ImportProgressState = {
  active: false,
  percent: 0,
  message: '',
};

export const useStore = create<AppStore>((set) => ({
  liveState: null,
  deviceInfo: null,
  channels: [],
  banks: defaultBanks,
  banksKnown: false,
  sync: defaultSync,
  importProgress: defaultImportProgress,
  fullActivityLog: [],
  preferences: defaultPreferences,
  lastSequence: 0,
  memoryDrafts: {},
  memoryEditingIndex: null,

  updateLiveState: (state, sequence) =>
    set((prev) => {
      if (sequence !== undefined && sequence <= prev.lastSequence) {
        return prev;
      }

      return {
        liveState: prev.liveState
          ? { ...prev.liveState, ...state }
          : { ...defaultLiveState, ...state },
        lastSequence: sequence ?? prev.lastSequence,
      };
    }),

  // Reset the WS sequence gate. The backend reseeds its sequence counter to 0
  // on (re)start, so after a backend restart the fresh low sequences (1, 2, 3…)
  // would otherwise be dropped as stale against a stale `lastSequence` from the
  // previous connection — freezing the UI until the counter caught up. Call
  // this whenever the WebSocket (re)connects.
  resetSequence: () => set({ lastSequence: 0 }),

  setDeviceInfo: (deviceInfo) => set({ deviceInfo }),
  setChannels: (channels) =>
    set((prev) => ({
      channels:
        typeof channels === 'function'
          ? channels(prev.channels)
          : Array.isArray(channels)
            ? channels
            : [],
    })),
  // A well-formed mask is the only thing that marks the state as known: a
  // malformed reply falls back to the placeholder, and a placeholder must not
  // claim to be a reading.
  setBanks: (banks) =>
    banks.length === 10
      ? set({ banks, banksKnown: true })
      : set({ banks: defaultBanks, banksKnown: false }),
  updateSync: (patch) => set((prev) => ({ sync: { ...prev.sync, ...patch } })),
  setImportProgress: (patch) =>
    set((prev) => ({ importProgress: { ...prev.importProgress, ...patch } })),
  addToFullActivityLog: (entry) =>
    set((prev) => ({
      fullActivityLog: [entry, ...prev.fullActivityLog],
    })),

  hydrateActivityLogs: (entries) =>
    set((prev) => {
      // Only seed from history when nothing is in memory yet. Lets the
      // user see historical hits at launch without clobbering anything a
      // WS event might have prepended while the fetch was in flight.
      if (prev.fullActivityLog.length > 0) {
        return prev;
      }
      const sorted = [...entries].sort((a, b) => b.timestamp - a.timestamp);
      return {
        fullActivityLog: sorted,
      };
    }),

  updatePreferences: (prefs) =>
    set((prev) => ({
      preferences: { ...prev.preferences, ...prefs },
    })),

  setMemoryEditingIndex: (index) => set({ memoryEditingIndex: index }),
  setMemoryDraft: (index, draft) =>
    set((prev) => ({
      memoryDrafts: {
        ...prev.memoryDrafts,
        [index]: draft,
      },
    })),
  clearMemoryDrafts: () => set({ memoryDrafts: {} }),
}));
