import type { ChannelData, ChannelDraft, LiveState, DeviceInfo, ActivityLogEntry } from '../types';

export const createTestChannel = (overrides: Partial<ChannelData> = {}): ChannelData => ({
  index: 1,
  frequency: 151.25,
  modulation: 'FM',
  alpha_tag: 'Test Channel',
  delay: 2,
  lockout: false,
  priority: false,
  tone_squelch: null,
  bank: 1,
  ...overrides,
});

export const createTestChannelDraft = (overrides: Partial<ChannelDraft> = {}): ChannelDraft => ({
  frequency: '151.2500',
  alpha_tag: 'Test Channel',
  modulation: 'FM',
  tone_squelch: '',
  delay: '2',
  lockout: false,
  priority: false,
  comments: '',
  ...overrides,
});

export const createTestLiveState = (overrides: Partial<LiveState> = {}): LiveState => ({
  timestamp: Date.now() / 1000,
  frequency: 151.25,
  modulation: 'FM',
  squelch_open: false,
  rssi: 60,
  mode: 'SCAN',
  channel: 1,
  alpha_tag: 'Test Channel',
  volume: 10,
  battery: 85,
  stale: false,
  ...overrides,
});

export const createTestDeviceInfo = (overrides: Partial<DeviceInfo> = {}): DeviceInfo => ({
  model: 'BC125AT',
  firmware: '1.0.12',
  serial_number: '123456789',
  connection_status: 'connected',
  ...overrides,
});

export const createTestActivityLogEntry = (
  overrides: Partial<ActivityLogEntry> = {},
): ActivityLogEntry => ({
  id: 'test-entry-1',
  timestamp: Date.now() / 1000,
  frequency: 151.25,
  channel: 1,
  alpha_tag: 'Test Channel',
  type: 'hit',
  rssi: 60,
  hasAudio: false,
  duration: 2.5,
  ended_at: Date.now() / 1000,
  ...overrides,
});

export const mockChannels: ChannelData[] = Array.from({ length: 10 }, (_, i) =>
  createTestChannel({
    index: i + 1,
    frequency: 140 + i * 0.5,
    alpha_tag: `Channel ${i + 1}`,
    bank: Math.floor(i / 5) + 1,
  }),
);

export const mockLiveState: LiveState = createTestLiveState({
  frequency: 151.25,
  modulation: 'FM',
  mode: 'SCAN',
  rssi: 75,
  squelch_open: false,
});

export const mockDeviceInfo: DeviceInfo = createTestDeviceInfo();

export const mockBanks = [true, true, true, true, true, true, true, true, true, true];
