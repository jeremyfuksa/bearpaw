import { create } from "zustand";
import type {
  ActivityLogEntry,
  ChannelData,
  ChannelDraft,
  DeviceInfo,
  LiveState,
} from "../types";

interface Preferences {
  theme: "night" | "field";
  displayMode: "frequency" | "alpha";
  reducedMotion: boolean;
  hitMinDuration: number;
  startInDashboardMode: boolean;
  autoConnect: boolean;
  checkUpdates: boolean;
  recordingBufferSize: number;
  dataRetentionDays: number;
  audioOutputDevice: string;
  recordingsPath: string;
  mqttEnabled: boolean;
  mqttHost: string;
  mqttPort: number;
  mqttTopicPrefix: string;
  mqttQos: number;
  mqttRetain: boolean;
}

interface AppState {
  liveState: LiveState | null;
  deviceInfo: DeviceInfo | null;
  channels: ChannelData[];
  connected: boolean;
  connecting: boolean;
  activityLog: ActivityLogEntry[];
  fullActivityLog: ActivityLogEntry[];
  preferences: Preferences;
  lastSequence: number;
  memoryDrafts: Record<number, ChannelDraft>;
  memoryEditingIndex: number | null;
  isRecording: boolean;

  updateLiveState: (state: Partial<LiveState>, sequence?: number) => void;
  setDeviceInfo: (info: DeviceInfo | null) => void;
  setChannels: (channels: ChannelData[]) => void;
  setConnected: (connected: boolean) => void;
  setConnecting: (connecting: boolean) => void;
  addActivityLogEntry: (entry: ActivityLogEntry) => void;
  clearActivityLog: () => void;
  setPreferences: (prefs: Preferences) => void;
  updatePreferences: (prefs: Partial<Preferences>) => void;
  setMemoryEditingIndex: (index: number | null) => void;
  setMemoryDraft: (index: number, draft: ChannelDraft) => void;
  setRecording: (recording: boolean) => void;
  addToFullActivityLog: (entry: ActivityLogEntry) => void;
}

const defaultPreferences: Preferences = {
  theme: "night",
  displayMode: "frequency",
  reducedMotion: false,
  hitMinDuration: 2,
  startInDashboardMode: false,
  autoConnect: false,
  checkUpdates: true,
  recordingBufferSize: 30,
  dataRetentionDays: 30,
  audioOutputDevice: "default",
  recordingsPath: "./recordings",
  mqttEnabled: false,
  mqttHost: "127.0.0.1",
  mqttPort: 1883,
  mqttTopicPrefix: "scanner",
  mqttQos: 0,
  mqttRetain: false,
};

export const useStore = create<AppState>((set) => ({
  liveState: null,
  deviceInfo: null,
  channels: [],
  connected: false,
  connecting: true,
  activityLog: [],
  fullActivityLog: [],
  preferences: defaultPreferences,
  lastSequence: 0,
  memoryDrafts: {},
  memoryEditingIndex: null,
  isRecording: false,

  updateLiveState: (state, sequence) =>
    set((prev) => {
      if (sequence !== undefined && sequence <= prev.lastSequence) {
        return prev;
      }

      const requiredFields = ['frequency', 'modulation'] as const;
      const hasRequired = prev.liveState || requiredFields.every(f => f in state);
      
      if (!hasRequired) {
        return prev;
      }

      return {
        liveState: prev.liveState ? { ...prev.liveState, ...state } : (state as LiveState),
        lastSequence: sequence ?? prev.lastSequence,
      };
    }),

  setDeviceInfo: (deviceInfo) => set({ deviceInfo }),
  setChannels: (channels) => set({ channels: Array.isArray(channels) ? channels : [] }),
  setConnected: (connected) => set({ connected }),
  setConnecting: (connecting) => set({ connecting }),

  addActivityLogEntry: (entry) =>
    set((prev) => ({
      activityLog: [entry, ...prev.activityLog].slice(0, 5),
    })),

  addToFullActivityLog: (entry) =>
    set((prev) => ({
      fullActivityLog: [entry, ...prev.fullActivityLog],
    })),

  clearActivityLog: () => set({ activityLog: [], fullActivityLog: [] }),

  setPreferences: (prefs) =>
    set((prev) => ({
      preferences: { ...prev.preferences, ...prefs },
    })),

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

  setRecording: (recording) => set({ isRecording: recording }),
}));
