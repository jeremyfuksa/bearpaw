import { vi } from 'vitest';
import { APIError } from '../../api/client';
import { mockApiResponses, mockApiErrors } from '../fixtures/apiResponses';

type MockResponse<T> = {
  data: T;
  delay?: number;
  error?: { status: number; message: string };
};

export const createMockApiClient = () => {
  const responses = new Map<string, MockResponse<unknown>>();

  const mockClient = {
    sendHold: vi.fn(async () => {
      const response = responses.get('/commands/hold');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    sendScan: vi.fn(async () => {
      const response = responses.get('/commands/scan');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    sendKey: vi.fn(async (key: string) => {
      const response = responses.get('/commands/key');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getStatus: vi.fn(async () => {
      const response = responses.get('/status');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.status;
    }),
    getDeviceInfo: vi.fn(async () => {
      const response = responses.get('/device/info');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.deviceInfo;
    }),
    getBanks: vi.fn(async () => {
      const response = responses.get('/banks');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.banks;
    }),
    setBanks: vi.fn(async (banks: boolean[]) => {
      const response = responses.get('/banks');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.banks;
    }),
    getChannels: vi.fn(async (bank?: number) => {
      const response = responses.get('/memory/channels');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.channels;
    }),
    getChannel: vi.fn(async (index: number) => {
      const response = responses.get(`/memory/channels/${index}`);
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.channel;
    }),
    updateChannel: vi.fn(async (index: number, payload: unknown) => {
      const response = responses.get(`/memory/channels/${index}`);
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.channel;
    }),
    startProgramMode: vi.fn(async () => {
      const response = responses.get('/memory/program-mode/start');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    endProgramMode: vi.fn(async () => {
      const response = responses.get('/memory/program-mode/end');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    toggleTemporaryLockout: vi.fn(async (options?: unknown) => {
      const response = responses.get('/commands/lockout');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.toggleTemporaryLockout;
    }),
    togglePermanentLockout: vi.fn(async (channel?: number) => {
      const response = responses.get('/commands/lockout');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.togglePermanentLockout;
    }),
    setVolume: vi.fn(async (volume: number) => {
      const response = responses.get('/volume');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getSquelch: vi.fn(async () => {
      const response = responses.get('/squelch');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.squelch;
    }),
    setSquelch: vi.fn(async (level: number) => {
      const response = responses.get('/squelch');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getAllSettings: vi.fn(async () => {
      const response = responses.get('/settings/all');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.config;
    }),
    getBacklight: vi.fn(async () => {
      const response = responses.get('/settings/backlight');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.backlight;
    }),
    setBacklight: vi.fn(async (event: string) => {
      const response = responses.get('/settings/backlight');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getBatterySettings: vi.fn(async () => {
      const response = responses.get('/settings/battery');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.battery;
    }),
    setBatterySettings: vi.fn(async (charge_time: number) => {
      const response = responses.get('/settings/battery');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getKeyBeepSettings: vi.fn(async () => {
      const response = responses.get('/settings/key-beep');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.keyBeep;
    }),
    setKeyBeepSettings: vi.fn(async (level: number, lock: boolean) => {
      const response = responses.get('/settings/key-beep');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getPrioritySettings: vi.fn(async () => {
      const response = responses.get('/settings/priority');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.priority;
    }),
    setPrioritySettings: vi.fn(async (mode: number) => {
      const response = responses.get('/settings/priority');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    setSearchSettings: vi.fn(async (delay: number, code_search: boolean) => {
      const response = responses.get('/settings/search');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getCloseCallSettings: vi.fn(async () => {
      const response = responses.get('/settings/close-call');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.closeCall;
    }),
    setCloseCallSettings: vi.fn(async (payload: unknown) => {
      const response = responses.get('/settings/close-call');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getServiceSearchSettings: vi.fn(async () => {
      const response = responses.get('/settings/service-search');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.serviceSearch;
    }),
    setServiceSearchSettings: vi.fn(async (groups: boolean[]) => {
      const response = responses.get('/settings/service-search');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getCustomSearchSettings: vi.fn(async () => {
      const response = responses.get('/settings/custom-search');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.customSearch;
    }),
    setCustomSearchSettings: vi.fn(async (groups: boolean[]) => {
      const response = responses.get('/settings/custom-search');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getCustomSearchRange: vi.fn(async (index: number) => {
      const response = responses.get(`/settings/custom-search/ranges/${index}`);
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.customSearchRange;
    }),
    setCustomSearchRange: vi.fn(async (index: number, lower: number, upper: number) => {
      const response = responses.get(`/settings/custom-search/ranges/${index}`);
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    setWeatherSettings: vi.fn(async (priority: boolean) => {
      const response = responses.get('/settings/weather');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getContrastSettings: vi.fn(async () => {
      const response = responses.get('/settings/contrast');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.contrast;
    }),
    setContrastSettings: vi.fn(async (level: number) => {
      const response = responses.get('/settings/contrast');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return undefined;
    }),
    getLockouts: vi.fn(async (options?: unknown) => {
      const response = responses.get('/lockouts');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.lockouts;
    }),
    clearTemporaryLockouts: vi.fn(async () => {
      const response = responses.get('/lockouts/temporary/clear');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.clearTempLockouts;
    }),
    clearGlobalLockouts: vi.fn(async () => {
      const response = responses.get('/lockouts/clear');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.clearGlobalLockouts;
    }),
    clearChannelLockouts: vi.fn(async (channels?: number[]) => {
      const response = responses.get('/lockouts/channels/clear');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.clearChannelLockouts;
    }),
    syncMemory: vi.fn(async (options?: unknown) => {
      const response = responses.get('/memory/sync');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.syncStarted;
    }),
    exportBc125atSs: vi.fn(async () => {
      const response = responses.get('/memory/export/bc125at_ss');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.bc125atSsExport;
    }),
    exportCsv: vi.fn(async () => {
      const response = responses.get('/memory/export/csv');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.csvExport;
    }),
    importCsv: vi.fn(async (file: File) => {
      const response = responses.get('/memory/import/csv');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.importCsv;
    }),
    getAllPreferences: vi.fn(async () => {
      const response = responses.get('/preferences');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.preferences;
    }),
    getPreference: vi.fn(async (key: string) => {
      const response = responses.get(`/preferences/${key}`);
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return { key, value: (mockApiResponses.preferences as any)[key] };
    }),
    setPreference: vi.fn(async (key: string, value: unknown) => {
      const response = responses.get(`/preferences/${key}`);
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return { key, value };
    }),
    setPreferences: vi.fn(async (prefs: unknown) => {
      const response = responses.get('/preferences');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.preferences;
    }),
    resetPreferences: vi.fn(async () => {
      const response = responses.get('/preferences');
      if (response?.error) {
        throw new APIError(response.error.message, response.error.status, response.error);
      }
      await new Promise((r) => setTimeout(r, response?.delay ?? 0));
      return mockApiResponses.preferencesReset;
    }),

    setResponse: (endpoint: string, response: MockResponse<unknown>) => {
      responses.set(endpoint, response);
    },

    setError: (endpoint: string, error: { status: number; message: string }) => {
      responses.set(endpoint, { data: {}, error });
    },

    reset: () => {
      responses.clear();
      Object.values(mockClient).forEach((method) => {
        if (typeof method === 'function' && 'mockClear' in method) {
          (method as any).mockClear();
        }
      });
    },
  };

  return mockClient;
};
