import type {
  BacklightSettings,
  BatterySettings,
  ChannelData,
  CloseCallSettings,
  ConfigSnapshot,
  ContrastSettings,
  CustomSearchRange,
  CustomSearchSettings,
  DeviceInfo,
  KeyBeepSettings,
  LiveState,
  LockoutsResponse,
  PrioritySettings,
  SearchSettings,
  ServiceSearchSettings,
  WeatherSettings,
} from '../types';

export class APIError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.payload = payload;
  }
}

export class ScannerAPIClient {
  private baseURL: string;

  constructor(baseURL: string) {
    this.baseURL = baseURL.replace(/\/$/, '');
  }

  private buildUrl(endpoint: string): string {
    const cleanedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const rawBase = (this.baseURL || '').trim();

    // Absolute base URL (Tauri/runtime override)
    if (rawBase.startsWith('http://') || rawBase.startsWith('https://')) {
      return `${rawBase}${cleanedEndpoint}`;
    }

    // Browser-relative base URL (dev proxy /api/v1)
    if (rawBase.startsWith('/')) {
      return `${rawBase}${cleanedEndpoint}`;
    }

    // Last-resort fallback for malformed base values
    return `/api/v1${cleanedEndpoint}`;
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(this.buildUrl(endpoint), {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...options?.headers,
      },
    });

    if (!response.ok) {
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = await response.text();
      }
      const message =
        typeof payload === 'object' && payload && 'message' in payload
          ? String((payload as { message?: string }).message)
          : response.statusText;
      throw new APIError(message || 'Request failed', response.status, payload);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private async requestText(endpoint: string, options?: RequestInit): Promise<string> {
    const response = await fetch(this.buildUrl(endpoint), {
      ...options,
      headers: {
        ...options?.headers,
      },
    });

    if (!response.ok) {
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        payload = await response.text();
      }
      const message =
        typeof payload === 'object' && payload && 'message' in payload
          ? String((payload as { message?: string }).message)
          : response.statusText;
      throw new APIError(message || 'Request failed', response.status, payload);
    }

    return response.text();
  }

  async sendHold(): Promise<void> {
    await this.request('/commands/hold', { method: 'POST' });
  }

  async sendScan(): Promise<void> {
    await this.request('/commands/scan', { method: 'POST' });
  }

  async sendKey(key: string): Promise<void> {
    await this.request('/commands/key', {
      method: 'POST',
      body: JSON.stringify({ key }),
    });
  }

  async getStatus(): Promise<LiveState> {
    return this.request<LiveState>('/status');
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    return this.request<DeviceInfo>('/device/info');
  }

  async getBanks(): Promise<{ banks: boolean[] }> {
    return this.request<{ banks: boolean[] }>('/banks');
  }

  async setBanks(banks: boolean[]): Promise<{ banks: boolean[] }> {
    return this.request<{ banks: boolean[] }>('/banks', {
      method: 'POST',
      body: JSON.stringify({ banks }),
    });
  }

  async getChannels(bank?: number): Promise<ChannelData[]> {
    const query = bank ? `?bank=${bank}` : '';
    return this.request<ChannelData[]>(`/memory/channels${query}`);
  }

  async getChannel(index: number): Promise<ChannelData> {
    return this.request<ChannelData>(`/memory/channels/${index}`);
  }

  async updateChannel(index: number, payload: Omit<ChannelData, 'index'>): Promise<ChannelData> {
    return this.request<ChannelData>(`/memory/channels/${index}`, {
      method: 'PUT',
      body: JSON.stringify(payload),
    });
  }

  async startProgramMode(): Promise<void> {
    await this.request('/memory/program-mode/start', { method: 'POST' });
  }

  async endProgramMode(): Promise<void> {
    await this.request('/memory/program-mode/end', { method: 'POST' });
  }

  async toggleTemporaryLockout(options?: {
    frequency?: number;
    channel?: number;
  }): Promise<{ frequency: number; locked: boolean; channel?: number }> {
    return this.request<{ frequency: number; locked: boolean; channel?: number }>(
      '/commands/lockout',
      {
        method: 'POST',
        body: JSON.stringify({
          mode: 'temporary',
          frequency: options?.frequency,
          channel: options?.channel,
        }),
      },
    );
  }

  async togglePermanentLockout(channel?: number): Promise<ChannelData> {
    const response = await this.request<{ channel: ChannelData }>('/commands/lockout', {
      method: 'POST',
      body: JSON.stringify({ mode: 'permanent', channel }),
    });
    return response.channel;
  }

  async setVolume(volume: number): Promise<void> {
    await this.request('/volume', {
      method: 'POST',
      body: JSON.stringify({ volume }),
    });
  }

  async getSquelch(): Promise<{ level: number }> {
    return this.request<{ level: number }>('/squelch');
  }

  async setSquelch(level: number): Promise<void> {
    await this.request('/squelch', {
      method: 'POST',
      body: JSON.stringify({ level }),
    });
  }

  async getConfig(): Promise<ConfigSnapshot> {
    return this.request<ConfigSnapshot>('/config');
  }

  async getAllSettings(): Promise<ConfigSnapshot> {
    return this.request<ConfigSnapshot>('/settings/all');
  }

  async getBacklight(): Promise<BacklightSettings> {
    return this.request<BacklightSettings>('/settings/backlight');
  }

  async setBacklight(event: string): Promise<void> {
    await this.request('/settings/backlight', {
      method: 'POST',
      body: JSON.stringify({ event }),
    });
  }

  async getBatterySettings(): Promise<BatterySettings> {
    return this.request<BatterySettings>('/settings/battery');
  }

  async setBatterySettings(charge_time: number): Promise<void> {
    await this.request('/settings/battery', {
      method: 'POST',
      body: JSON.stringify({ charge_time }),
    });
  }

  async getKeyBeepSettings(): Promise<KeyBeepSettings> {
    return this.request<KeyBeepSettings>('/settings/key-beep');
  }

  async setKeyBeepSettings(level: number, lock: boolean): Promise<void> {
    await this.request('/settings/key-beep', {
      method: 'POST',
      body: JSON.stringify({ level, lock }),
    });
  }

  async getPrioritySettings(): Promise<PrioritySettings> {
    return this.request<PrioritySettings>('/settings/priority');
  }

  async setPrioritySettings(mode: number): Promise<void> {
    await this.request('/settings/priority', {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
  }

  async getSearchSettings(): Promise<SearchSettings> {
    return this.request<SearchSettings>('/settings/search');
  }

  async setSearchSettings(delay: number, code_search: boolean): Promise<void> {
    await this.request('/settings/search', {
      method: 'POST',
      body: JSON.stringify({ delay, code_search }),
    });
  }

  async getCloseCallSettings(): Promise<CloseCallSettings> {
    return this.request<CloseCallSettings>('/settings/close-call');
  }

  async setCloseCallSettings(payload: CloseCallSettings): Promise<void> {
    await this.request('/settings/close-call', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  async getServiceSearchSettings(): Promise<ServiceSearchSettings> {
    return this.request<ServiceSearchSettings>('/settings/service-search');
  }

  async setServiceSearchSettings(groups: boolean[]): Promise<void> {
    await this.request('/settings/service-search', {
      method: 'POST',
      body: JSON.stringify({ groups }),
    });
  }

  async getCustomSearchSettings(): Promise<CustomSearchSettings> {
    return this.request<CustomSearchSettings>('/settings/custom-search');
  }

  async setCustomSearchSettings(groups: boolean[]): Promise<void> {
    await this.request('/settings/custom-search', {
      method: 'POST',
      body: JSON.stringify({ groups }),
    });
  }

  async getCustomSearchRange(index: number): Promise<CustomSearchRange> {
    return this.request<CustomSearchRange>(`/settings/custom-search/ranges/${index}`);
  }

  async setCustomSearchRange(index: number, lower: number, upper: number): Promise<void> {
    await this.request(`/settings/custom-search/ranges/${index}`, {
      method: 'POST',
      body: JSON.stringify({ index, lower, upper }),
    });
  }

  async getWeatherSettings(): Promise<WeatherSettings> {
    return this.request<WeatherSettings>('/settings/weather');
  }

  async setWeatherSettings(priority: boolean): Promise<void> {
    await this.request('/settings/weather', {
      method: 'POST',
      body: JSON.stringify({ priority }),
    });
  }

  async getContrastSettings(): Promise<ContrastSettings> {
    return this.request<ContrastSettings>('/settings/contrast');
  }

  async setContrastSettings(level: number): Promise<void> {
    await this.request('/settings/contrast', {
      method: 'POST',
      body: JSON.stringify({ level }),
    });
  }

  async getLockouts(options?: { includeFrequencies?: boolean }): Promise<LockoutsResponse> {
    const include = options?.includeFrequencies ?? true;
    const query = include ? '' : '?include_frequencies=false';
    return this.request<LockoutsResponse>(`/lockouts${query}`);
  }

  async clearTemporaryLockouts(): Promise<{ cleared: number[]; failed: number[] }> {
    return this.request<{ cleared: number[]; failed: number[] }>('/lockouts/temporary/clear', {
      method: 'POST',
    });
  }

  async clearGlobalLockouts(): Promise<{ cleared: number[]; failed: number[] }> {
    return this.request<{ cleared: number[]; failed: number[] }>('/lockouts/clear', {
      method: 'POST',
    });
  }

  async clearChannelLockouts(
    channels?: number[],
  ): Promise<{ cleared: number[]; failed: number[] }> {
    // If explicitly passing empty array, return early to prevent accidental clear-all
    // Otherwise, pass empty array to backend which interprets as "clear all selected"
    if (channels && channels.length === 0) {
      return { cleared: [], failed: [] };
    }
    return this.request<{ cleared: number[]; failed: number[] }>('/lockouts/channels/clear', {
      method: 'POST',
      body: JSON.stringify({ channels: channels ?? [] }),
    });
  }

  async syncMemory(options?: { force?: boolean }): Promise<{ status?: string; task_id?: string }> {
    return this.request<{ status?: string; task_id?: string }>('/memory/sync', {
      method: 'POST',
      body: options?.force ? JSON.stringify({ force: true }) : undefined,
    });
  }

  async cancelSync(taskId?: string): Promise<void> {
    await this.request('/memory/sync/cancel', {
      method: 'POST',
      body: taskId ? JSON.stringify({ task_id: taskId }) : undefined,
    });
  }

  async exportBc125atSs(): Promise<string> {
    return this.requestText('/memory/export/bc125at_ss');
  }

  async exportCsv(): Promise<string> {
    return this.requestText('/memory/export/csv');
  }

  async importCsv(
    file: File,
  ): Promise<{ imported: number; errors: Array<{ row: Record<string, string>; error: string }> }> {
    const formData = new FormData();
    formData.append('file', file);

    const response = await fetch(this.buildUrl('/memory/import/csv'), {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      const payload = await response.json();
      const message =
        typeof payload === 'object' && payload && 'message' in payload
          ? String((payload as { message?: string }).message)
          : response.statusText;
      throw new APIError(message || 'Request failed', response.status, payload);
    }

    return response.json();
  }

  async getAllPreferences(): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('/preferences');
  }

  async getPreference(key: string): Promise<{ key: string; value: any }> {
    return this.request<{ key: string; value: any }>(`/preferences/${key}`);
  }

  async setPreference(key: string, value: any): Promise<{ key: string; value: any }> {
    return this.request<{ key: string; value: any }>(`/preferences/${key}`, {
      method: 'PUT',
      body: JSON.stringify({ value }),
    });
  }

  async setPreferences(prefs: Record<string, any>): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('/preferences', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    });
  }

  async resetPreferences(): Promise<Record<string, any>> {
    return this.request<Record<string, any>>('/preferences', {
      method: 'POST',
    });
  }

  async cleanupAnalytics(): Promise<void> {
    await this.request('/analytics/cleanup', { method: 'POST' });
  }

  preferencesApi = {
    getAll: () => this.getAllPreferences(),
    get: (key: string) => this.getPreference(key),
    set: (key: string, value: any) => this.setPreference(key, value),
    setAll: (prefs: Record<string, any>) => this.setPreferences(prefs),
    reset: () => this.resetPreferences(),
  };
}
