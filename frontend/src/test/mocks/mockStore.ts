import { vi } from 'vitest';
import type { AppStore } from '../../store/useStore';
import { createTestLiveState, createTestDeviceInfo } from '../fixtures/data';

export const createMockStore = (overrides: Partial<AppStore> = {}) => {
  const mockStore = {
    liveState: overrides.liveState ?? createTestLiveState(),
    deviceInfo: overrides.deviceInfo ?? createTestDeviceInfo(),
    channels: overrides.channels ?? [],
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
      dataRetentionDays: 30,
      audioOutputDevice: 'default',
    },
    lastSequence: overrides.lastSequence ?? 0,
    memoryDrafts: overrides.memoryDrafts ?? {},
    memoryEditingIndex: overrides.memoryEditingIndex ?? null,

    updateLiveState: vi.fn(),
    setDeviceInfo: vi.fn(),
    setChannels: vi.fn(),
    addActivityLogEntry: vi.fn(),
    addToFullActivityLog: vi.fn(),
    clearActivityLog: vi.fn(),
    setPreferences: vi.fn(),
    updatePreferences: vi.fn(),
    setMemoryEditingIndex: vi.fn(),
    setMemoryDraft: vi.fn(),
  };

  return mockStore;
};
