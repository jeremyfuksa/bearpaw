import { create } from 'zustand';
import type { ActivityLogEntry, ChannelData, ChannelDraft, DeviceInfo, LiveState } from '../types';

export interface Preferences {
  theme: 'night' | 'field';
  displayMode: 'frequency' | 'alpha';
  reducedMotion: boolean;
  hitMinDuration: number;
  checkUpdates: boolean;
  dataRetentionDays: number;
  audioOutputDevice: string;
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
  sync: SyncState;
  importProgress: ImportProgressState;
  activityLog: ActivityLogEntry[];
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
  addActivityLogEntry: (entry: ActivityLogEntry) => void;
  clearActivityLog: () => void;
  updatePreferences: (prefs: Partial<Preferences>) => void;
  setMemoryEditingIndex: (index: number | null) => void;
  setMemoryDraft: (index: number, draft: ChannelDraft) => void;
  addToFullActivityLog: (entry: ActivityLogEntry) => void;
  hydrateActivityLogs: (entries: ActivityLogEntry[]) => void;
}

const defaultPreferences: Preferences = {
  theme: 'night',
  displayMode: 'frequency',
  reducedMotion: false,
  hitMinDuration: 2,
  checkUpdates: true,
  dataRetentionDays: 30,
  audioOutputDevice: 'default',
};

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
  sync: defaultSync,
  importProgress: defaultImportProgress,
  activityLog: [],
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
  setBanks: (banks) => set({ banks: banks.length === 10 ? banks : defaultBanks }),
  updateSync: (patch) => set((prev) => ({ sync: { ...prev.sync, ...patch } })),
  setImportProgress: (patch) =>
    set((prev) => ({ importProgress: { ...prev.importProgress, ...patch } })),
  addActivityLogEntry: (entry) =>
    set((prev) => ({
      activityLog: [entry, ...prev.activityLog].slice(0, 5),
    })),

  addToFullActivityLog: (entry) =>
    set((prev) => ({
      fullActivityLog: [entry, ...prev.fullActivityLog],
    })),

  clearActivityLog: () => set({ activityLog: [], fullActivityLog: [] }),

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
        activityLog: sorted.slice(0, 5),
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
}));
