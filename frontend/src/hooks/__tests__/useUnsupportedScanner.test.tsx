import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

const setPreference = vi.hoisted(() =>
  vi.fn((_key: string, value: unknown) => Promise.resolve(value)),
);
vi.mock('../../api/useApi', () => ({ getAPI: () => ({ setPreference }) }));

import { useUnsupportedScanner } from '../useUnsupportedScanner';
import { mapStoredPreferences, useStore } from '../../store/useStore';

function setDevice(info: Record<string, unknown>, dismissedKeys: string[] = []) {
  useStore.setState({
    deviceInfo: info as never,
    preferences: { ...useStore.getState().preferences, unsupportedPanelDismissed: dismissedKeys },
  });
}

describe('useUnsupportedScanner', () => {
  beforeEach(() => {
    setPreference.mockClear();
  });

  it('is unsupported only while connected with the unsupported_model diagnostic', () => {
    setDevice({
      connection_status: 'connected',
      diagnostic_code: 'unsupported_model',
      model: 'SDS100',
    });
    expect(renderHook(() => useUnsupportedScanner()).result.current).toMatchObject({
      isUnsupported: true,
      model: 'SDS100',
    });

    setDevice({
      connection_status: 'disconnected',
      diagnostic_code: 'unsupported_model',
      model: 'SDS100',
    });
    expect(renderHook(() => useUnsupportedScanner()).result.current.isUnsupported).toBe(false);

    setDevice({ connection_status: 'connected', diagnostic_code: null, model: 'BC125AT' });
    expect(renderHook(() => useUnsupportedScanner()).result.current.isUnsupported).toBe(false);
  });

  it('dismiss saves the scanner id and appends to what was already stored', async () => {
    setDevice(
      {
        connection_status: 'connected',
        diagnostic_code: 'unsupported_model',
        model: 'SDS100',
        scanner_id: 'sds100-1',
      },
      ['other-scanner'],
    );
    const { result } = renderHook(() => useUnsupportedScanner());
    expect(result.current.dismissed).toBe(false);

    act(() => result.current.dismiss());

    expect(setPreference).toHaveBeenCalledWith('unsupported_panel_dismissed', [
      'other-scanner',
      'sds100-1',
    ]);
    await waitFor(() => expect(result.current.dismissed).toBe(true));
  });

  it('keys on the model when there is no scanner id', () => {
    setDevice(
      { connection_status: 'connected', diagnostic_code: 'unsupported_model', model: 'SDS100' },
      ['SDS100'],
    );
    expect(renderHook(() => useUnsupportedScanner()).result.current.dismissed).toBe(true);
  });

  it('does not mark another scanner dismissed', () => {
    setDevice(
      {
        connection_status: 'connected',
        diagnostic_code: 'unsupported_model',
        model: 'SDS100',
        scanner_id: 'sds100-2',
      },
      ['sds100-1'],
    );
    expect(renderHook(() => useUnsupportedScanner()).result.current.dismissed).toBe(false);
  });
});

describe('unsupportedPanelDismissed storage mapping', () => {
  it('reads the stored array back, and ignores a malformed value', () => {
    expect(
      mapStoredPreferences({ unsupported_panel_dismissed: ['a', 'b'] }).unsupportedPanelDismissed,
    ).toEqual(['a', 'b']);
    expect(
      mapStoredPreferences({ unsupported_panel_dismissed: 'nope' }).unsupportedPanelDismissed,
    ).toEqual([]);
    expect(mapStoredPreferences({}).unsupportedPanelDismissed).toEqual([]);
  });
});
