// Shared types for configuration category components

export interface ScannerConfig {
  volume?: number;
  squelch?: number;
  backlight?: string;
  contrast?: number;
  key_beep?: string;
  key_lock?: boolean;
  battery_charge_time?: number;
  priority_mode?: string;
  weather_priority?: boolean;
  search_delay?: string;
  code_search?: boolean;
  close_call_mode?: string;
  close_call_bands?: {
    vhf_low?: boolean;
    air?: boolean;
    vhf_high_1?: boolean;
    vhf_high_2?: boolean;
    uhf?: boolean;
  };
  close_call_alert_beep?: boolean;
  close_call_alert_light?: boolean;
  close_call_lockout_scanning?: boolean;
  service_search?: {
    police?: boolean;
    fire_ems?: boolean;
    ham?: boolean;
    marine?: boolean;
    railroad?: boolean;
    civil_air?: boolean;
    military_air?: boolean;
    cb?: boolean;
    frs_gmrs_murs?: boolean;
    racing?: boolean;
  };
  custom_search_groups?: boolean[];
  custom_search_ranges?: Array<{ lower: string; upper: string }>;
}

export interface Channel {
  index: number;
  frequency: string;
  alpha_tag: string;
  modulation?: string;
  lockout?: boolean;
  bank?: number;
}

export interface DeviceInfo {
  model?: string;
  firmware?: string;
  serial_port?: string;
}

export interface LiveState {
  mode?: string;
  squelch_open?: boolean;
  frequency?: string;
  channel?: number;
  modulation?: string;
  rssi?: number;
}

export interface CustomSearchRange {
  index: number;
  lower: number;
  upper: number;
}
