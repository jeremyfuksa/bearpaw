import type { ChannelData, DeviceInfo, LiveState } from "../types";

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

  async setFrequency(frequency: number, modulation: string = "AUTO"): Promise<void> {
    await this.request("/frequency", {
      method: "POST",
      body: JSON.stringify({ frequency, modulation }),
    });
  }

  async getStatus(): Promise<LiveState> {
    return this.request<LiveState>("/status");
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    return this.request<DeviceInfo>("/device/info");
  }

  async getChannels(bank?: number): Promise<ChannelData[]> {
    const query = bank ? `?bank=${bank}` : "";
    return this.request<ChannelData[]>(`/memory/channels${query}`);
  }

  async syncMemory(): Promise<{ status?: string; task_id?: string }> {
    return this.request<{ status?: string; task_id?: string }>("/memory/sync", {
      method: "POST",
    });
  }
}
