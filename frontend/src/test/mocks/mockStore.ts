import { vi } from 'vitest';
import type { AppStore } from '../../store/useStore';
import { createTestLiveState, createTestDeviceInfo } from '../fixtures/data';

export const createMockStore = (overrides: Partial<AppStore> = {}) => {
  const mockStore = {
    liveState: overrides.liveState ?? createTestLiveState(),
    deviceInfo: overrides.deviceInfo ?? createTestDeviceInfo(),
    channels: overrides.channels ?? [],
    connected: overrides.connected ?? true,
    connecting: overrides.connecting ?? false,
    activityLog: overrides.activityLog ?? [],
    fullActivityLog: overrides.fullActivityLog ?? [],
    preferences: overrides.preferences ?? {
      theme: 'night',
      displayMode: 'frequency',
      reducedMotion: false,
      hitMinDuration: 2,
      startInDashboardMode: false,
      autoConnect: false,
      checkUpdates: true,
      recordingBufferSize: 30,
      dataRetentionDays: 30,
      audioOutputDevice: 'default',
      recordingsPath: './recordings',
    },
    lastSequence: overrides.lastSequence ?? 0,
    memoryDrafts: overrides.memoryDrafts ?? {},
    memoryEditingIndex: overrides.memoryEditingIndex ?? null,
    isRecording: overrides.isRecording ?? false,

    updateLiveState: vi.fn(),
    setDeviceInfo: vi.fn(),
    setChannels: vi.fn(),
    setConnected: vi.fn(),
    setConnecting: vi.fn(),
    addActivityLogEntry: vi.fn(),
    addToFullActivityLog: vi.fn(),
    clearActivityLog: vi.fn(),
    setPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    setMemoryEditingIndex: vi.fn(),
    setMemoryDraft: vi.fn(),
    setRecording: vi.fn(),
  };

  return mockStore;
};
