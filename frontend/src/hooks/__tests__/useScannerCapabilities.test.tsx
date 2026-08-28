import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScannerCapabilities, DEFAULT_CAPABILITIES } from '../useScannerCapabilities';
import { useStore } from '../../store/useStore';
import type { DeviceInfo, ScannerCapabilities } from '../../types';

const BC75XLT: ScannerCapabilities = {
  channel_count: 300,
  channels_per_bank: 30,
  bank_count: 10,
  has_alpha_tags: false,
  reports_live_channel: false,
  ss_format: 'bc75xlt',
  ss_region: 'USA',
  has_per_channel_modulation: false,
  has_tone_squelch: false,
  has_backlight_control: false,
  has_battery_save: false,
  has_contrast: false,
  has_weather_alert: false,
  has_service_search_groups: false,
  close_call_bands: ['VHF Low', 'Air', 'VHF High', null, 'UHF'],
  has_close_call_hit_scan: false,
  has_key_beep: false,
  key_beep_needs_program_mode: true,
  valid_delays: [0, 1],
  cleared_delay: 0,
  default_baud: 57600,
  coverage_bands: [
    [25, 54],
    [108, 174],
    [406, 512],
  ],
};

function connect(overrides: Partial<DeviceInfo> = {}) {
  useStore.getState().setDeviceInfo({
    model: 'BC125AT',
    connection_status: 'connected',
    ...overrides,
  } as DeviceInfo);
}

describe('useScannerCapabilities', () => {
  beforeEach(() => {
    useStore.setState({ deviceInfo: null });
  });

  it('falls back to BC125AT-family defaults before a scanner connects', () => {
    const { result } = renderHook(() => useScannerCapabilities());
    expect(result.current).toEqual(DEFAULT_CAPABILITIES);
    expect(result.current.channel_count).toBe(500);
    expect(result.current.channels_per_bank).toBe(50);
  });

  // The defaults are what the UI assumed unconditionally before capabilities
  // existed. If they drift, a not-yet-connected app renders differently than
  // it used to — and the change would show up as a flash of a differently
  // shaped table while device_info is in flight.
  it('defaults match the values the UI assumed before capabilities existed', () => {
    expect(DEFAULT_CAPABILITIES).toEqual({
      channel_count: 500,
      channels_per_bank: 50,
      bank_count: 10,
      has_alpha_tags: true,
      reports_live_channel: true,
      ss_format: 'bc125at',
      ss_region: 'USA',
      has_per_channel_modulation: true,
      has_tone_squelch: true,
      has_backlight_control: true,
      has_battery_save: true,
      has_contrast: true,
      has_weather_alert: true,
      has_service_search_groups: true,
      close_call_bands: ['VHF Low', 'Air', 'VHF High', 'UHF', '800 MHz'],
      has_close_call_hit_scan: true,
      has_key_beep: true,
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
    });
  });

  it('returns the connected scanner capabilities', () => {
    connect({ model: 'BC75XLT', capabilities: BC75XLT });
    const { result } = renderHook(() => useScannerCapabilities());
    expect(result.current).toEqual(BC75XLT);
  });

  it('falls back when a connected device reports no capabilities', () => {
    connect({ capabilities: null });
    const { result } = renderHook(() => useScannerCapabilities());
    expect(result.current).toEqual(DEFAULT_CAPABILITIES);
  });

  // deviceInfo is replaced wholesale on every device_info broadcast. If this
  // hook returned a fresh object each render, anything using it in a
  // dependency array would re-run on unrelated status changes — the same class
  // of bug as the WS-subscription regression guarded in App.regression.test.tsx.
  it('is referentially stable across unrelated deviceInfo changes', () => {
    connect({ model: 'BC75XLT', capabilities: BC75XLT });
    const { result, rerender } = renderHook(() => useScannerCapabilities());
    const first = result.current;

    connect({ model: 'BC75XLT', capabilities: BC75XLT, port: '/dev/cu.changed' });
    rerender();

    expect(result.current).toBe(first);
  });

  it('returns a new object when capabilities actually change', () => {
    connect({ capabilities: DEFAULT_CAPABILITIES });
    const { result, rerender } = renderHook(() => useScannerCapabilities());
    const first = result.current;

    connect({ model: 'BC75XLT', capabilities: BC75XLT });
    rerender();

    expect(result.current).not.toBe(first);
    expect(result.current.channels_per_bank).toBe(30);
  });
});
