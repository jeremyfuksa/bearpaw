import type { ChannelData, DeviceInfo, LiveState, LockoutsResponse } from "../types";

export class APIError extends Error {
  status: number;
  payload: unknown;

  constructor(message: string, status: number, payload: unknown) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.payload = payload;
  }
}

export class ScannerAPIClient {
  private baseURL: string;

  constructor(baseURL: string) {
    this.baseURL = baseURL.replace(/\/$/, "");
  }

  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseURL}${endpoint}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
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
        typeof payload === "object" && payload && "message" in payload
          ? String((payload as { message?: string }).message)
          : response.statusText;
      throw new APIError(message || "Request failed", response.status, payload);
    }

    if (response.status === 204) {
      return undefined as T;
    }

    return response.json() as Promise<T>;
  }

  private async requestText(endpoint: string, options?: RequestInit): Promise<string> {
    const response = await fetch(`${this.baseURL}${endpoint}`, {
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
        typeof payload === "object" && payload && "message" in payload
          ? String((payload as { message?: string }).message)
          : response.statusText;
      throw new APIError(message || "Request failed", response.status, payload);
    }

    return response.text();
  }

  async sendHold(): Promise<void> {
    await this.request("/commands/hold", { method: "POST" });
  }

  async sendScan(): Promise<void> {
    await this.request("/commands/scan", { method: "POST" });
  }

  async sendKey(key: string): Promise<void> {
    await this.request("/commands/key", {
      method: "POST",
      body: JSON.stringify({ key }),
    });
  }

  async getStatus(): Promise<LiveState> {
    return this.request<LiveState>("/status");
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    return this.request<DeviceInfo>("/device/info");
  }

  async getBanks(): Promise<{ banks: boolean[] }> {
    return this.request<{ banks: boolean[] }>("/banks");
  }

  async setBanks(banks: boolean[]): Promise<{ banks: boolean[] }> {
    return this.request<{ banks: boolean[] }>("/banks", {
      method: "POST",
      body: JSON.stringify({ banks }),
    });
  }

  async getChannels(bank?: number): Promise<ChannelData[]> {
    const query = bank ? `?bank=${bank}` : "";
    return this.request<ChannelData[]>(`/memory/channels${query}`);
  }

  async getChannel(index: number): Promise<ChannelData> {
    return this.request<ChannelData>(`/memory/channels/${index}`);
  }

  async toggleTemporaryLockout(options?: {
    frequency?: number;
    channel?: number;
  }): Promise<{ frequency: number; locked: boolean; channel?: number }> {
    return this.request<{ frequency: number; locked: boolean; channel?: number }>(
      "/commands/lockout",
      {
        method: "POST",
        body: JSON.stringify({
          mode: "temporary",
          frequency: options?.frequency,
          channel: options?.channel,
        }),
      }
    );
  }

  async togglePermanentLockout(channel?: number): Promise<ChannelData> {
    const response = await this.request<{ channel: ChannelData }>("/commands/lockout", {
      method: "POST",
      body: JSON.stringify({ mode: "permanent", channel }),
    });
    return response.channel;
  }

  async setVolume(volume: number): Promise<void> {
    await this.request("/volume", {
      method: "POST",
      body: JSON.stringify({ volume }),
    });
  }

  async getLockouts(options?: { includeFrequencies?: boolean }): Promise<LockoutsResponse> {
    const include = options?.includeFrequencies ?? true;
    const query = include ? "" : "?include_frequencies=false";
    return this.request<LockoutsResponse>(`/lockouts${query}`);
  }

  async clearTemporaryLockouts(): Promise<{ cleared: number[]; failed: number[] }> {
    return this.request<{ cleared: number[]; failed: number[] }>(
      "/lockouts/temporary/clear",
      { method: "POST" }
    );
  }

  async clearGlobalLockouts(): Promise<{ cleared: number[]; failed: number[] }> {
    return this.request<{ cleared: number[]; failed: number[] }>(
      "/lockouts/clear",
      { method: "POST" }
    );
  }

  async clearChannelLockouts(): Promise<{ cleared: number[]; failed: number[] }> {
    return this.request<{ cleared: number[]; failed: number[] }>(
      "/lockouts/channels/clear",
      { method: "POST" }
    );
  }

  async syncMemory(): Promise<{ status?: string; task_id?: string }> {
    return this.request<{ status?: string; task_id?: string }>("/memory/sync", {
      method: "POST",
    });
  }

  async exportBc125atSs(): Promise<string> {
    return this.requestText("/memory/export/bc125at_ss");
  }
}
