import { vi } from 'vitest';
import type { AppStore } from '../../store/useStore';
import { createTestLiveState, createTestDeviceInfo } from '../fixtures/data';

export const createMockStore = (overrides: Partial<AppStore> = {}) => {
  const mockStore = {
    liveState: overrides.liveState ?? createTestLiveState(),
    deviceInfo: overrides.deviceInfo ?? createTestDeviceInfo(),
    channels: overrides.channels ?? [],
    fullActivityLog: overrides.fullActivityLog ?? [],
    preferences: overrides.preferences ?? {
      theme: 'night',
      displayMode: 'frequency',
      reducedMotion: false,
      hitMinDuration: 2,
      dataRetentionDays: 30,
      audioOutputDevice: 'default',
    },
    lastSequence: overrides.lastSequence ?? 0,
    memoryDrafts: overrides.memoryDrafts ?? {},
    memoryEditingIndex: overrides.memoryEditingIndex ?? null,
    importProgress: overrides.importProgress ?? { active: false, percent: 0, message: '' },
    // Mirrors `defaultSync`. Components read `state.sync.*`, so omitting this
    // makes every test using them throw on an undefined slice rather than fail
    // on the behaviour under test.
    sync: overrides.sync ?? {
      inProgress: false,
      hasSyncedInitially: false,
      taskId: null,
      message: 'Loading channels from device...',
      percent: 0,
      syncedAt: null,
    },

    updateLiveState: vi.fn(),
    setImportProgress: vi.fn(),
    setDeviceInfo: vi.fn(),
    setChannels: vi.fn(),
    addToFullActivityLog: vi.fn(),
    updatePreferences: vi.fn(),
    setMemoryEditingIndex: vi.fn(),
    setMemoryDraft: vi.fn(),
    clearMemoryDrafts: vi.fn(),
    updateSync: vi.fn(),
  };

  return mockStore;
};
