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
  comments: string;
}

/**
 * Memory model and feature set of the connected scanner, resolved by the
 * backend from the `MDL` reply and sent with every `DeviceInfo`.
 *
 * Components must branch on these flags, never on `DeviceInfo.model`. Model
 * strings scatter hardware knowledge across the UI and break the moment a new
 * model lands; the backend is the single place that maps model to behaviour.
 *
 * Backend source of truth: `crates/bearpaw-api/src/protocol/capabilities.rs`.
 */
export interface ScannerCapabilities {
  /** Highest valid channel index, and therefore the channel count. */
  channel_count: number;
  /** Channels per bank. 50 on the BC125AT family, 30 on the BC75XLT. */
  channels_per_bank: number;
  /** Number of banks. 10 on both families. */
  bank_count: number;
  /** False on the BC75XLT, where the CIN alpha-tag field is reserved. */
  has_alpha_tags: boolean;
  /**
   * Whether the live `GLG` frame reports which channel is being received.
   * Separate from `has_alpha_tags`: one describes stored channel memory, the
   * other the live frame. False on a BC75XLT, whose GLG field 11 is empty.
   */
  reports_live_channel: boolean;
  /**
   * Whether this model exchanges settings as a Uniden `.bc125at_ss` file.
   * Named for the FORMAT: the BC75XLT has its own layout, which Bearpaw does
   * not implement because we have no spec for it.
   */
  /** 'bc125at' | 'bc75xlt' | '' when no settings file is supported. */
  ss_format: string;
  /** Region stamped into the `.bc125at_ss` file: 'USA' or 'EUR'. */
  ss_region: string;
  /** False on the BC75XLT, where modulation is a global band-plan setting. */
  has_per_channel_modulation: boolean;
  /** False on the BC75XLT, where the CIN tone field is reserved. */
  has_tone_squelch: boolean;
  /**
   * Whether the scanner exposes a settable backlight *mode* via `BLT`.
   *
   * Not `has_backlight`: the BC75XLT has a backlight (a 15-second button, per
   * its owner's manual) but no `BLT` command and no persistent mode to set.
   */
  has_backlight_control: boolean;
  /** False on the BC75XLT: `BSV` replies ERR in both modes. */
  has_battery_save: boolean;
  /** False on the BC75XLT, which has no contrast setting at all. */
  has_contrast: boolean;
  /** False on the BC75XLT: `WXS` replies ERR in both modes. */
  has_weather_alert: boolean;
  /**
   * Whether `SSG` (the service-search avoid mask) exists on this model.
   *
   * Named for the mask, not the feature: the BC75XLT HAS service search, but
   * no command to enable or disable a band remotely — its `SSP` carries only
   * a per-service delay and direction. False there, so the UI hides the whole
   * Service Search page rather than showing ten toggles that cannot write.
   */
  has_service_search_groups: boolean;
  /**
   * Close Call band labels, indexed by position in the `CLC` mask.
   *
   * `null` marks a reserved position — present in the 5-character mask, but
   * not a band. The families disagree on positions 4 and 5: the BC125AT is
   * `[…, 'UHF', '800 MHz']`, the BC75XLT is `[…, null, 'UHF']`. Render by
   * index and skip the nulls; never reorder, the index IS the wire position.
   */
  close_call_bands: Array<string | null>;
  /**
   * Whether `CLC` field 5 (`hit_scan`, "Lockout Hits While Scanning") is
   * settable. Reserved on the BC75XLT: written `1`, it reads back empty.
   */
  has_close_call_hit_scan: boolean;
  /**
   * Whether Bearpaw can clear a channel's priority flag on this model.
   *
   * The BC125AT family needs `DCH` + a full rewrite; a BC75XLT has no `DCH`
   * and refuses an in-place clear, but its firmware moves the flag within a
   * bank by itself. False does NOT mean priority cannot be moved — it means
   * the clear is the radio's job rather than ours.
   */
  has_priority_clear: boolean;
  /**
   * Whether the `KBP` key-beep field is settable.
   *
   * The BC125AT's `KBP` is `[BEEP],[LOCK]`; the BC75XLT's is `[RSV],[LOCK]` —
   * the beep slot is reserved, and that model's manual documents no key-beep
   * setting. Separate from `key_beep_needs_program_mode`, which says WHERE the
   * command may be sent; both are true of a BC75XLT at once.
   */
  has_key_beep: boolean;
  /**
   * True on the BC75XLT, where `KBP` replies `KBP,NG` outside program mode.
   * The BC125AT accepts it in either mode.
   */
  key_beep_needs_program_mode: boolean;
  /** Accepted CIN delay values. `[-10,-5,0,1,2,3,4,5]` vs `[0,1]`. */
  valid_delays: number[];
  /**
   * Delay a *cleared* channel slot reports. Not a sentinel — it is what the
   * hardware actually returns for an empty slot, and `buildEmptyDraft` must
   * match it exactly or cleared channels stay permanently pending.
   * See the third-rail table in CLAUDE.md.
   */
  cleared_delay: number;
  /**
   * Whether this model's USB serial identifies the UNIT rather than the model.
   *
   * Every BC125AT reports `0001` — a firmware constant, measured on both units
   * 2026-08-26 — while a BC75XLT's comes from a per-unit CP2104 bridge. The
   * backend reads this to decide whether the serial belongs in a scanner's
   * identity key at all (#570). False does not mean "no serial"; it means the
   * serial does not distinguish units.
   */
  has_unique_usb_serial: boolean;
  /** Serial baud rate this model speaks. */
  default_baud: number;
  /**
   * Receive coverage as inclusive `[low, high]` MHz bands.
   *
   * The families do not cover the same spectrum: the BC75XLT has no 225–380
   * band and its UHF range starts at 406, not 400.
   */
  coverage_bands: Array<[number, number]>;
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
  /** A CONNECTION problem, cleared the moment a connect succeeds. */
  diagnostic_code?: string | null;
  diagnostic_message?: string | null;
  /**
   * A problem with the stored DATA — true regardless of the scanner, and
   * cleared only when its cause is. Surfaced by `DataDiagnosticBanner`, which
   * must not be gated on `connection_status`: the whole point is that this is
   * still true while the scanner is connected and everything looks fine.
   */
  data_diagnostic_code?: string | null;
  data_diagnostic_message?: string | null;
  /**
   * Something the user should know about their stored data that is NOT a
   * problem — today, that the database was upgraded on this launch and older
   * versions of Bearpaw can no longer open it.
   *
   * Separate from `data_diagnostic_*` on purpose: that pair means "something is
   * wrong", and a successful upgrade shown as a fault teaches people to ignore
   * the channel that also carries real failures.
   */
  data_notice_code?: string | null;
  data_notice_message?: string | null;
  /**
   * Absent until a scanner identifies itself. Consumers should use
   * `useScannerCapabilities()` rather than reading this directly — it supplies
   * the BC125AT-family defaults that preserve existing behaviour before a
   * scanner connects.
   */
  capabilities?: ScannerCapabilities | null;
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
