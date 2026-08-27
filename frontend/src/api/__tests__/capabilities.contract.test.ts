import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ScannerCapabilities } from '../../types';
import { DEFAULT_CAPABILITIES } from '../../hooks/useScannerCapabilities';

/**
 * Capability payload contract test.
 *
 * `scanner-capabilities.json` is written by the Rust test
 * `capability_manifest_is_written_for_the_frontend`, which serializes the REAL
 * `ScannerCapabilities` for every model in the REAL allowlist. That test
 * rewrites the file and fails when it is stale, so the committed copy always
 * matches what the backend actually emits.
 *
 * This file asserts the TypeScript `ScannerCapabilities` interface against
 * that output. A hand-written fixture would pass whether or not it matched
 * Rust — the same trap the route-manifest comment describes.
 */

const FIXTURE = resolve(__dirname, '../../test/fixtures/scanner-capabilities.json');
const payloads: Record<string, ScannerCapabilities> = JSON.parse(readFileSync(FIXTURE, 'utf-8'));

// Every key the TS interface declares. Kept explicit rather than derived from
// a value: a type has no runtime representation, so `keyof` cannot be checked
// at runtime. Adding a field to the interface without adding it here would
// leave the new field unverified.
const EXPECTED_KEYS = [
  'channel_count',
  'channels_per_bank',
  'bank_count',
  'has_alpha_tags',
  'reports_live_channel',
  'has_bc125at_ss_format',
  'ss_region',
  'has_per_channel_modulation',
  'has_tone_squelch',
  'has_backlight_control',
  'has_battery_save',
  'has_contrast',
  'has_weather_alert',
  'key_beep_needs_program_mode',
  'valid_delays',
  'cleared_delay',
  'default_baud',
  'coverage_bands',
] as const;

describe('ScannerCapabilities contract', () => {
  it('covers every model the backend allowlists', () => {
    expect(Object.keys(payloads).sort()).toEqual([
      'AE125H',
      'BC125AT',
      'BC75XLT',
      'BCT125AT',
      'UBC125XLT',
      'UBC126AT',
    ]);
  });

  it.each(Object.entries(payloads))('%s payload matches the TS interface', (_model, caps) => {
    expect(Object.keys(caps).sort()).toEqual([...EXPECTED_KEYS].sort());

    expect(typeof caps.channel_count).toBe('number');
    expect(typeof caps.channels_per_bank).toBe('number');
    expect(typeof caps.bank_count).toBe('number');
    expect(typeof caps.has_alpha_tags).toBe('boolean');
    expect(typeof caps.reports_live_channel).toBe('boolean');
    expect(typeof caps.has_bc125at_ss_format).toBe('boolean');
    expect(['USA', 'EUR']).toContain(caps.ss_region);
    expect(typeof caps.has_per_channel_modulation).toBe('boolean');
    expect(typeof caps.has_tone_squelch).toBe('boolean');
    expect(typeof caps.has_backlight_control).toBe('boolean');
    expect(typeof caps.has_battery_save).toBe('boolean');
    expect(typeof caps.has_contrast).toBe('boolean');
    expect(typeof caps.has_weather_alert).toBe('boolean');
    expect(typeof caps.key_beep_needs_program_mode).toBe('boolean');
    expect(Array.isArray(caps.valid_delays)).toBe(true);
    expect(typeof caps.cleared_delay).toBe('number');
    expect(typeof caps.default_baud).toBe('number');
    expect(Array.isArray(caps.coverage_bands)).toBe(true);
    for (const band of caps.coverage_bands) {
      expect(band).toHaveLength(2);
      expect(band[0]).toBeLessThan(band[1]);
    }
  });

  it('banks tile the channel space exactly for every model', () => {
    for (const [model, caps] of Object.entries(payloads)) {
      expect(caps.channels_per_bank * caps.bank_count, model).toBe(caps.channel_count);
    }
  });

  // The hook's fallback stands in for a real scanner before device_info
  // arrives. If it drifts from what the backend reports for a BC125AT, the UI
  // renders one shape at startup and a different one a moment later.
  it('the hook fallback matches the backend BC125AT payload', () => {
    expect(DEFAULT_CAPABILITIES).toEqual(payloads.BC125AT);
  });

  it.each(['UBC125XLT', 'UBC126AT'])('%s is a European variant', (model) => {
    expect(payloads[model].ss_region).toBe('EUR');
    expect(payloads[model].has_bc125at_ss_format).toBe(true);
  });

  it.each(['BC125AT', 'BCT125AT', 'AE125H'])('%s is a USA variant', (model) => {
    expect(payloads[model].ss_region).toBe('USA');
  });

  // Values that came off real hardware on 2026-08-26. See
  // docs/wire_captures/2026-08-26/bc75xlt-compatibility.md.
  it('BC75XLT carries the values measured on hardware', () => {
    expect(payloads.BC75XLT).toMatchObject({
      channel_count: 300,
      channels_per_bank: 30,
      has_alpha_tags: false,
      // GLG field 11 is empty on this model, so the live frame never names a
      // channel: GLG,145.1300,NFM,,,,,,0,1,,, (hardware, 2026-08-27).
      reports_live_channel: false,
      // Bearpaw has no spec for this model's own settings-file layout, so it
      // exchanges CSV with it and nothing else. Writing a BC125AT-shaped file
      // would be rejected by Uniden's own software.
      has_bc125at_ss_format: false,
      has_per_channel_modulation: false,
      valid_delays: [0, 1],
      cleared_delay: 0,
      default_baud: 57600,
    });
  });
});
