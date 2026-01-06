export type Modulation = "FM" | "AM" | "NFM" | "AUTO";

export interface LiveState {
  timestamp: number;
  frequency: number;
  modulation: Modulation | string;
  squelch_open: boolean;
  rssi: number;
  mode: "SCAN" | "HOLD" | "DIRECT" | string;
  channel?: number | null;
  alpha_tag?: string | null;
  volume: number;
  battery?: number | null;
  stale?: boolean;
}

export interface ChannelData {
  index: number;
  frequency: number;
  modulation: string;
  alpha_tag: string;
  delay: number;
  lockout: boolean;
  priority: boolean;
  tone_squelch?: number | null;
  bank: number;
}

export interface DeviceInfo {
  model: string;
  firmware?: string | null;
  serial_number?: string | null;
  connection_status: "connected" | "disconnected" | "connecting";
}

export type WSMessage = StateUpdateMessage | EventMessage | ProgressMessage | ErrorMessage | PingMessage;

export interface PingMessage {
  type: "ping";
}

export interface StateUpdateMessage {
  type: "state_update";
  timestamp: number;
  sequence: number;
  data: Partial<LiveState>;
}

export interface EventMessage {
  type: "event";
  timestamp: number;
  event: "scan_hit" | "hold" | "scan_start" | "state_stale";
  data: Record<string, unknown> & {
    frequency?: number;
    channel?: number;
    alpha_tag?: string;
    duration?: number;
    message?: string;
  };
}

export interface ProgressMessage {
  type: "progress";
  task_id: string;
  percent: number;
  message: string;
}

export interface ErrorMessage {
  type: "error";
  error: string;
  message: string;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  frequency: number;
  channel?: number | null;
  alpha_tag?: string | null;
  type: "hit" | "hold" | "manual";
}

export interface Notification {
  id: string;
  type: "success" | "error" | "info" | "warning";
  message: string;
  duration?: number;
}
