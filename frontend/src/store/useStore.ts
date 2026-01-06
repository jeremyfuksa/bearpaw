import { create } from "zustand";

import type { ActivityLogEntry, ChannelData, DeviceInfo, LiveState } from "../types";

interface Preferences {
  theme: "night" | "field";
  displayMode: "frequency" | "alpha";
  reducedMotion: boolean;
}

interface AppState {
  liveState: LiveState | null;
  deviceInfo: DeviceInfo | null;
  channels: ChannelData[];
  connected: boolean;
  connecting: boolean;
  activityLog: ActivityLogEntry[];
  preferences: Preferences;
  lastSequence: number;

  updateLiveState: (state: Partial<LiveState>, sequence?: number) => void;
  setDeviceInfo: (info: DeviceInfo | null) => void;
  setChannels: (channels: ChannelData[]) => void;
  setConnected: (connected: boolean) => void;
  setConnecting: (connecting: boolean) => void;
  addActivityLogEntry: (entry: ActivityLogEntry) => void;
  clearActivityLog: () => void;
  updatePreferences: (prefs: Partial<Preferences>) => void;
}

const defaultPreferences: Preferences = {
  theme: "night",
  displayMode: "frequency",
  reducedMotion: false,
};

export const useStore = create<AppState>((set) => ({
  liveState: null,
  deviceInfo: null,
  channels: [],
  connected: false,
  connecting: true,
  activityLog: [],
  preferences: defaultPreferences,
  lastSequence: 0,

  updateLiveState: (state, sequence) =>
    set((prev) => {
      if (sequence !== undefined && sequence <= prev.lastSequence) {
        return prev;
      }

      if (!prev.liveState && (state.frequency === undefined || state.modulation === undefined)) {
        return prev;
      }

      return {
        liveState: prev.liveState ? { ...prev.liveState, ...state } : (state as LiveState),
        lastSequence: sequence ?? prev.lastSequence,
      };
    }),

  setDeviceInfo: (deviceInfo) => set({ deviceInfo }),
  setChannels: (channels) => set({ channels }),
  setConnected: (connected) => set({ connected }),
  setConnecting: (connecting) => set({ connecting }),

  addActivityLogEntry: (entry) =>
    set((prev) => ({
      activityLog: [entry, ...prev.activityLog].slice(0, 5),
    })),

  clearActivityLog: () => set({ activityLog: [] }),

  updatePreferences: (prefs) =>
    set((prev) => ({
      preferences: { ...prev.preferences, ...prefs },
    })),
}));
