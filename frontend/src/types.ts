export type Modulation = 'FM' | 'AM' | 'NFM' | 'AUTO';

export interface LiveState {
  timestamp: number;
  frequency: number;
  modulation: Modulation | string;
  squelch_open: boolean;
  rssi: number;
  mode: 'SCAN' | 'HOLD' | 'DIRECT' | string;
  channel?: number | null;
  alpha_tag?: string | null;
  volume: number;
  battery?: number | null;
  stale?: boolean;
  /** Tone discriminator from the live GLG frame during a hit; mirrors ChannelData. */
  tone_squelch_kind?: 'none' | 'ctcss' | 'dcs' | 'search';
  /** CTCSS frequency in Hz when tone_squelch_kind === 'ctcss'. */
  tone_squelch?: number | null;
  /** DCS wire code (128–231) when tone_squelch_kind === 'dcs'. */
  tone_dcs_code?: number | null;
  /** Backend-formatted "DCS NNN" label when tone_squelch_kind === 'dcs'. */
  tone_dcs_label?: string | null;
}

export interface ChannelData {
  index: number;
  frequency: number;
  modulation: string;
  alpha_tag: string;
  delay: number;
  lockout: boolean;
  priority: boolean;
  /** CTCSS frequency in Hz when tone_squelch_kind === 'ctcss'; null/absent otherwise. */
  tone_squelch?: number | null;
  /**
   * Tone discriminator, mirroring the backend's ToneSquelchKind. Must be
   * passed through on channel edits — omitting it deserializes as 'none' on
   * the backend and erases DCS/Search squelch on any edit (#132).
   */
  tone_squelch_kind?: 'none' | 'ctcss' | 'dcs' | 'search';
  /** DCS wire code (128–231) when tone_squelch_kind === 'dcs'. */
  tone_dcs_code?: number | null;
  bank: number;
}

export interface ChannelDraft {
  frequency: string;
  alpha_tag: string;
  modulation: string;
  tone_squelch: string;
  delay: string;
  lockout: boolean;
  priority: boolean;
  comments: string;
}

export interface DeviceInfo {
  model?: string | null;
  port?: string | null;
  vid?: number | null;
  pid?: number | null;
  firmware?: string | null;
  serial_number?: string | null;
  description?: string | null;
  connection_status: 'connected' | 'disconnected' | 'connecting';
  diagnostic_code?: string | null;
  diagnostic_message?: string | null;
}

export type WSMessage =
  StateUpdateMessage | EventMessage | ProgressMessage | ErrorMessage | BanksUpdateMessage;

export interface BanksUpdateMessage {
  type: 'banks_update';
  timestamp: number;
  data: { banks: boolean[] };
}

export interface StateUpdateMessage {
  type: 'state_update';
  timestamp: number;
  sequence: number;
  data: Partial<LiveState>;
}

export interface EventMessage {
  type: 'event';
  timestamp: number;
  event: 'scan_hit' | 'hold' | 'scan_start' | 'state_stale';
  data: Record<string, unknown> & {
    frequency?: number;
    channel?: number;
    alpha_tag?: string;
    rssi?: number;
    duration?: number;
    message?: string;
  };
}

export interface ProgressMessage {
  type: 'progress';
  task_id: string;
  percent: number;
  message: string;
}

export interface ErrorMessage {
  type: 'error';
  error: string;
  message: string;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  frequency: number;
  channel?: number | null;
  alpha_tag?: string | null;
  type: 'hit' | 'hold' | 'manual';
  rssi?: number;
  hasAudio?: boolean;
  duration?: number | null;
  ended_at?: number | null;
}

export interface LockoutsResponse {
  frequencies: number[];
  channels: number[];
  temporary_channels: { channel: number; frequency: number }[];
}

export interface BacklightSettings {
  event: string;
}

export interface BatterySettings {
  charge_time: number;
}

export interface SquelchSettings {
  level: number;
}

export interface KeyBeepSettings {
  level: number;
  lock: boolean;
}

export interface PrioritySettings {
  mode: number;
}

export interface SearchSettings {
  delay: number;
  code_search: boolean;
}

export interface CloseCallSettings {
  mode: number;
  alert_beep: boolean;
  alert_light: boolean;
  band: boolean[];
  lockout: boolean;
}

export interface ServiceSearchSettings {
  groups: boolean[];
}

export interface CustomSearchSettings {
  groups: boolean[];
}

export interface CustomSearchRange {
  index: number;
  lower: number;
  upper: number;
}

export interface WeatherSettings {
  priority: boolean;
}

export interface ContrastSettings {
  level: number;
}

export interface ConfigSnapshot {
  firmware?: string | null;
  squelch?: SquelchSettings | null;
  backlight?: BacklightSettings | null;
  battery?: BatterySettings | null;
  key_beep?: KeyBeepSettings | null;
  priority?: PrioritySettings | null;
  search?: SearchSettings | null;
  close_call?: CloseCallSettings | null;
  service_search?: ServiceSearchSettings | null;
  custom_search?: CustomSearchSettings | null;
  custom_search_ranges?: CustomSearchRange[];
  weather?: WeatherSettings | null;
  contrast?: ContrastSettings | null;
}
