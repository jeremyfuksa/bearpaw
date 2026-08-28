import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useScannerCapabilities, DEFAULT_CAPABILITIES } from '../useScannerCapabilities';
import { useStore } from '../../store/useStore';
import type { DeviceInfo } from '../../types';
import { BC125AT_CAPS, BC75XLT_CAPS as BC75XLT } from '../../test/fixtures/capabilities';

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

  // DEFAULT_CAPABILITIES is what the UI assumes before a scanner identifies
  // itself, and its doc comment claims it matches BC125AT_FAMILY in
  // capabilities.rs. This asserts that claim against the manifest the Rust
  // allowlist actually generates, rather than against a literal hand-copied
  // from it — which is a check that a copy could never fail, because both
  // sides were maintained by the same hand at the same time.
  //
  // If they drift, a not-yet-connected app renders differently than it used
  // to, showing as a flash of a differently shaped table while device_info is
  // in flight.
  it('defaults match the BC125AT descriptor the backend generates', () => {
    expect(DEFAULT_CAPABILITIES).toEqual(BC125AT_CAPS);
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
