import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ScannerAPIClient, APIError } from '../../api/client';
import {
  mockApiResponse,
  mockFetch,
  mockFetchError,
  mockFetchNetworkError,
  resetMockFetch,
} from '../../test/utils';
import { mockApiResponses, mockApiErrors } from '../../test/fixtures';

describe('ScannerAPIClient', () => {
  let client: ScannerAPIClient;

  beforeEach(() => {
    client = new ScannerAPIClient('/api/v1');
  });

  afterEach(() => {
    resetMockFetch();
  });

  describe('commands', () => {
    it('should send hold command successfully', async () => {
      mockFetch(mockApiResponses);
      await expect(client.sendHold()).resolves.toBeUndefined();
    });

    it('should send scan command successfully', async () => {
      mockFetch(mockApiResponses);
      await expect(client.sendScan()).resolves.toBeUndefined();
    });

    it('should send key command successfully', async () => {
      mockFetch(mockApiResponses);
      await expect(client.sendKey('UP')).resolves.toBeUndefined();
    });

    it('should throw APIError on network failure', async () => {
      mockFetchNetworkError();
      await expect(client.sendHold()).rejects.toThrow('Failed to fetch');
    });

    it('should throw APIError with 503 status on device disconnected', async () => {
      mockFetchError(503, 'Device not connected');
      await expect(client.sendHold()).rejects.toThrow('Device not connected');
    });
  });

  describe('status and device info', () => {
    it('should get status successfully', async () => {
      mockFetch(mockApiResponses.status);
      const status = await client.getStatus();
      expect(status).toEqual(mockApiResponses.status);
    });

    it('should get device info successfully', async () => {
      mockFetch(mockApiResponses.deviceInfo);
      const info = await client.getDeviceInfo();
      expect(info).toEqual(mockApiResponses.deviceInfo);
    });
  });

  describe('banks', () => {
    it('should get banks successfully', async () => {
      mockFetch(mockApiResponses.banks);
      const banks = await client.getBanks();
      expect(banks).toEqual(mockApiResponses.banks);
    });

    it('should set banks successfully', async () => {
      mockFetch(mockApiResponses.banks);
      const newBanks = [false, true, true, true, true, true, true, true, true, true];
      const result = await client.setBanks(newBanks);
      expect(result.banks).toEqual(mockApiResponses.banks.banks);
    });

    it('should throw APIError on invalid banks length', async () => {
      mockFetchError(400, 'Invalid banks length');
      await expect(client.setBanks(Array(5).fill(true))).rejects.toThrow('Invalid banks length');
    });
  });

  describe('volume', () => {
    it('should set volume successfully', async () => {
      mockFetch({});
      await expect(client.setVolume(10)).resolves.toBeUndefined();
    });

    it('should throw APIError on volume out of range', async () => {
      mockFetchError(400, 'Volume out of range');
      await expect(client.setVolume(50)).rejects.toThrow('Volume out of range');
    });

    it('should throw APIError on device disconnected', async () => {
      mockFetchError(503, 'Device not connected');
      await expect(client.setVolume(10)).rejects.toThrow('Device not connected');
    });
  });

  describe('squelch', () => {
    it('should get squelch successfully', async () => {
      mockFetch(mockApiResponses.squelch);
      const squelch = await client.getSquelch();
      expect(squelch).toEqual(mockApiResponses.squelch);
    });

    it('should set squelch successfully', async () => {
      mockFetch({});
      await expect(client.setSquelch(5)).resolves.toBeUndefined();
    });

    it('should throw APIError on squelch out of range', async () => {
      mockFetchError(400, 'Squelch out of range');
      await expect(client.setSquelch(50)).rejects.toThrow('Squelch out of range');
    });
  });

  describe('channels', () => {
    it('should get channels successfully', async () => {
      mockFetch(mockApiResponses.channels);
      const channels = await client.getChannels();
      expect(channels).toEqual(mockApiResponses.channels);
    });

    it('should get channels with bank filter', async () => {
      mockFetch(mockApiResponses.channels);
      const channels = await client.getChannels(1);
      expect(channels).toEqual(mockApiResponses.channels);
    });

    it('should get single channel successfully', async () => {
      mockFetch(mockApiResponses.channel);
      const channel = await client.getChannel(1);
      expect(channel).toEqual(mockApiResponses.channel);
    });

    it('should update channel successfully', async () => {
      mockFetch(mockApiResponses.channel);
      const update = {
        frequency: 151.25,
        modulation: 'FM',
        alpha_tag: 'Updated Channel',
        delay: 2,
        lockout: false,
        priority: false,
        tone_squelch: null,
        bank: 1,
      };
      const result = await client.updateChannel(1, update);
      expect(result).toEqual(mockApiResponses.channel);
    });

    it('should throw APIError on invalid channel index', async () => {
      mockFetchError(404, 'Channel not found');
      await expect(client.getChannel(600)).rejects.toThrow('Channel not found');
    });

    it('should throw APIError on invalid frequency', async () => {
      mockFetchError(400, 'Invalid frequency');
      const update = {
        frequency: 9999,
        modulation: 'FM',
        alpha_tag: 'Test',
        delay: 2,
        lockout: false,
        priority: false,
        tone_squelch: null,
        bank: 1,
      };
      await expect(client.updateChannel(1, update)).rejects.toThrow('Invalid frequency');
    });
  });

  describe('lockouts', () => {
    it('should toggle temporary lockout successfully', async () => {
      mockFetch(mockApiResponses.toggleTemporaryLockout);
      const result = await client.toggleTemporaryLockout({ frequency: 151.25, channel: 1 });
      expect(result).toEqual(mockApiResponses.toggleTemporaryLockout);
    });

    it('should toggle permanent lockout successfully', async () => {
      mockFetch({ channel: mockApiResponses.channel });
      const result = await client.togglePermanentLockout(1);
      expect(result).toEqual(mockApiResponses.channel);
    });

    it('should clear temporary lockouts successfully', async () => {
      mockFetch(mockApiResponses.clearTempLockouts);
      const result = await client.clearTemporaryLockouts();
      expect(result).toEqual(mockApiResponses.clearTempLockouts);
    });

    it('should clear global lockouts successfully', async () => {
      mockFetch(mockApiResponses.clearGlobalLockouts);
      const result = await client.clearGlobalLockouts();
      expect(result).toEqual(mockApiResponses.clearGlobalLockouts);
    });

    it('should clear channel lockouts successfully', async () => {
      mockFetch(mockApiResponses.clearChannelLockouts);
      const result = await client.clearChannelLockouts([1, 5, 10]);
      expect(result).toEqual(mockApiResponses.clearChannelLockouts);
    });
  });

  describe('memory sync', () => {
    it('should start memory sync successfully', async () => {
      mockFetch(mockApiResponses.syncStarted);
      const result = await client.syncMemory();
      expect(result).toEqual(mockApiResponses.syncStarted);
    });

    it('should handle already running sync', async () => {
      mockFetch(mockApiResponses.syncAlreadyRunning);
      const result = await client.syncMemory();
      expect(result.status).toBe('already_running');
    });

    it('should force start memory sync successfully', async () => {
      mockFetch(mockApiResponses.syncStarted);
      const result = await client.syncMemory({ force: true });
      expect(result).toEqual(mockApiResponses.syncStarted);
    });

    it('should export BC125AT SS format successfully', async () => {
      mockFetch(mockApiResponses.bc125atSsExport);
      const result = await client.exportBc125atSs();
      expect(result).toBeTypeOf('string');
    });

    it('should export CSV successfully', async () => {
      mockFetch(mockApiResponses.csvExport);
      const result = await client.exportCsv();
      expect(result).toBeTypeOf('string');
    });

    it('should import CSV successfully', async () => {
      mockFetch(mockApiResponses.importCsv);
      const file = new File(['test'], 'test.csv', { type: 'text/csv' });
      const result = await client.importCsv(file);
      expect(result.imported).toBe(mockApiResponses.importCsv.imported);
    });

    it('should handle CSV import with errors', async () => {
      mockFetch(mockApiResponses.importCsvWithErrors);
      const file = new File(['test'], 'test.csv', { type: 'text/csv' });
      const result = await client.importCsv(file);
      expect(result.errors).toHaveLength(mockApiResponses.importCsvWithErrors.errors.length);
    });
  });

  describe('settings', () => {
    it('should get backlight successfully', async () => {
      mockFetch(mockApiResponses.backlight);
      const backlight = await client.getBacklight();
      expect(backlight).toEqual(mockApiResponses.backlight);
    });

    it('should set backlight successfully', async () => {
      mockFetch({});
      await expect(client.setBacklight('AO')).resolves.toBeUndefined();
    });

    it('should get battery settings successfully', async () => {
      mockFetch(mockApiResponses.battery);
      const battery = await client.getBatterySettings();
      expect(battery).toEqual(mockApiResponses.battery);
    });

    it('should set battery settings successfully', async () => {
      mockFetch({});
      await expect(client.setBatterySettings(10)).resolves.toBeUndefined();
    });

    it('should get priority settings successfully', async () => {
      mockFetch(mockApiResponses.priority);
      const priority = await client.getPrioritySettings();
      expect(priority).toEqual(mockApiResponses.priority);
    });

    it('should set priority settings successfully', async () => {
      mockFetch({});
      await expect(client.setPrioritySettings(1)).resolves.toBeUndefined();
    });

    it('should get close call settings successfully', async () => {
      mockFetch(mockApiResponses.closeCall);
      const closeCall = await client.getCloseCallSettings();
      expect(closeCall).toEqual(mockApiResponses.closeCall);
    });

    it('should set close call settings successfully', async () => {
      mockFetch({});
      await expect(
        client.setCloseCallSettings(mockApiResponses.closeCall),
      ).resolves.toBeUndefined();
    });

    it('should get service search settings successfully', async () => {
      mockFetch(mockApiResponses.serviceSearch);
      const serviceSearch = await client.getServiceSearchSettings();
      expect(serviceSearch).toEqual(mockApiResponses.serviceSearch);
    });

    it('should set service search settings successfully', async () => {
      mockFetch({});
      await expect(
        client.setServiceSearchSettings([true, false, true, false, true, false, true, false, true]),
      ).resolves.toBeUndefined();
    });

    it('should get custom search settings successfully', async () => {
      mockFetch(mockApiResponses.customSearch);
      const customSearch = await client.getCustomSearchSettings();
      expect(customSearch).toEqual(mockApiResponses.customSearch);
    });

    it('should set custom search settings successfully', async () => {
      mockFetch({});
      await expect(
        client.setCustomSearchSettings([true, false, true, false, true, false, true, false, true]),
      ).resolves.toBeUndefined();
    });

    it('should get custom search range successfully', async () => {
      mockFetch(mockApiResponses.customSearchRange);
      const range = await client.getCustomSearchRange(1);
      expect(range).toEqual(mockApiResponses.customSearchRange);
    });

    it('should set custom search range successfully', async () => {
      mockFetch({});
      await expect(client.setCustomSearchRange(1, 140, 149)).resolves.toBeUndefined();
    });

    it('should get contrast settings successfully', async () => {
      mockFetch(mockApiResponses.contrast);
      const contrast = await client.getContrastSettings();
      expect(contrast).toEqual(mockApiResponses.contrast);
    });

    it('should set contrast settings successfully', async () => {
      mockFetch({});
      await expect(client.setContrastSettings(8)).resolves.toBeUndefined();
    });
  });

  describe('preferences', () => {
    it('should get all preferences successfully', async () => {
      mockFetch(mockApiResponses.preferences);
      const prefs = await client.getAllPreferences();
      expect(prefs).toEqual(mockApiResponses.preferences);
    });

    it('should get single preference successfully', async () => {
      mockFetch({ key: 'theme', value: 'night' });
      const pref = await client.getPreference('theme');
      expect(pref).toEqual({ key: 'theme', value: 'night' });
    });

    it('should set single preference successfully', async () => {
      mockFetch({ key: 'theme', value: 'field' });
      const pref = await client.setPreference('theme', 'field');
      expect(pref.value).toBe('field');
    });

    it('should set multiple preferences successfully', async () => {
      mockFetch(mockApiResponses.preferences);
      const prefs = { theme: 'field', hitMinDuration: 3 };
      const result = await client.setPreferences(prefs);
      expect(result).toEqual(mockApiResponses.preferences);
    });

    it('should reset preferences successfully', async () => {
      mockFetch(mockApiResponses.preferencesReset);
      const result = await client.resetPreferences();
      expect(result).toEqual(mockApiResponses.preferencesReset);
    });
  });

  describe('analytics', () => {
    it('should get busiest channels successfully', async () => {
      mockFetch(mockApiResponses.analyticsBusiestChannels);
      const result = await fetch('/api/v1/analytics/busiest-channels?limit=5&hours=24');
      const data = await result.json();
      expect(data.channels).toEqual(mockApiResponses.analyticsBusiestChannels.channels);
    });

    it('should get hourly heatmap successfully', async () => {
      mockFetch(mockApiResponses.analyticsHourlyHeatmap);
      const result = await fetch('/api/v1/analytics/hourly-heatmap');
      const data = await result.json();
      expect(data.heatmap).toEqual(mockApiResponses.analyticsHourlyHeatmap.heatmap);
    });

    it('should get session stats successfully', async () => {
      mockFetch(mockApiResponses.analyticsSessionStats);
      const result = await fetch('/api/v1/analytics/session-stats');
      const data = await result.json();
      expect(data).toEqual(mockApiResponses.analyticsSessionStats);
    });

    it('should get activity log successfully', async () => {
      mockFetch(mockApiResponses.activityLog);
      const result = await fetch('/api/v1/analytics/activity-log?limit=10');
      const data = await result.json();
      expect(data.entries).toEqual(mockApiResponses.activityLog.entries);
    });
  });

  describe('APIError', () => {
    it('should have correct structure', () => {
      const error = new APIError('Test error', 500, { code: 500 });
      expect(error.name).toBe('APIError');
      expect(error.message).toBe('Test error');
      expect(error.status).toBe(500);
      expect(error.payload).toEqual({ code: 500 });
    });

    it('should be throwable', () => {
      const error = new APIError('Test error', 400, { field: 'test' });
      expect(() => {
        throw error;
      }).toThrow(APIError);
    });

    it('should be instance of Error', () => {
      const error = new APIError('Test', 404, null);
      expect(error).toBeInstanceOf(Error);
    });
  });
});
