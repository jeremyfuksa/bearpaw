import { useMemo } from 'react';
import { useStore } from '../store/useStore';
import type { ScannerCapabilities } from '../types';

/**
 * BC125AT-family capabilities, used before a scanner has identified itself.
 *
 * Matches `BC125AT_FAMILY` in `crates/bearpaw-api/src/protocol/capabilities.rs`.
 * These are the values the UI assumed unconditionally before capabilities
 * existed, so falling back to them means a not-yet-connected app renders
 * exactly as it did before — no flash of a differently-shaped table while
 * `device_info` is in flight.
 *
 * Deliberately NOT a neutral or empty shape: a "no capabilities" default would
 * make every consumer handle a third state that only exists for a few hundred
 * milliseconds at startup.
 */
export const DEFAULT_CAPABILITIES: ScannerCapabilities = {
  channel_count: 500,
  channels_per_bank: 50,
  bank_count: 10,
  has_alpha_tags: true,
  reports_live_channel: true,
  has_per_channel_modulation: true,
  has_tone_squelch: true,
  has_backlight_control: true,
  has_battery_save: true,
  has_contrast: true,
  has_weather_alert: true,
  key_beep_needs_program_mode: false,
  valid_delays: [-10, -5, 0, 1, 2, 3, 4, 5],
  cleared_delay: 2,
  default_baud: 115200,
  coverage_bands: [
    [25, 54],
    [108, 174],
    [225, 380],
    [400, 512],
  ],
};

/**
 * Capabilities of the connected scanner, or the BC125AT-family defaults.
 *
 * The one place the UI should learn what the attached hardware can do.
 * Components must branch on these flags rather than on `deviceInfo.model` —
 * model strings scatter hardware knowledge across the UI and go stale the
 * moment a new model lands, while the backend already owns that mapping.
 *
 * The returned object is referentially stable while capabilities are
 * unchanged, so it is safe in dependency arrays. That matters: `deviceInfo` is
 * replaced wholesale on every `device_info` broadcast, and depending on it
 * directly would re-run effects on unrelated status changes.
 */
export function useScannerCapabilities(): ScannerCapabilities {
  const capabilities = useStore((s) => s.deviceInfo?.capabilities);
  return useMemo(() => capabilities ?? DEFAULT_CAPABILITIES, [capabilities]);
}
