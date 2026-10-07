import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useBankNames } from '../useBankNames';
import { useStore } from '../../store/useStore';
import { createTestDeviceInfo } from '../../test/fixtures';

/**
 * Bank names belong to one scanner profile (#677). Mounts the real hook
 * against the real store.
 */
describe('useBankNames', () => {
  const NAMES_A = ['Ham', 'Sea', '', '', '', '', '', '', '', ''];
  const NAMES_B = ['Fire', '', '', '', '', '', '', '', '', ''];
  const api = { getBankNames: vi.fn<() => Promise<{ names: string[] }>>() };

  const connect = (scanner_id: string | null) =>
    act(() => {
      useStore.setState({ deviceInfo: createTestDeviceInfo({ scanner_id }) });
    });

  beforeEach(() => {
    vi.clearAllMocks();
    useStore.setState({ deviceInfo: null, bankNames: [] });
  });

  it('loads the connected scanner’s names', async () => {
    api.getBankNames.mockResolvedValue({ names: NAMES_A });
    connect('scanner-a');
    renderHook(() => useBankNames(api));
    await waitFor(() => expect(useStore.getState().bankNames).toEqual(NAMES_A));
  });

  it('does not ask before a scanner profile is known', () => {
    renderHook(() => useBankNames(api));
    expect(api.getBankNames).not.toHaveBeenCalled();
    expect(useStore.getState().bankNames).toEqual([]);
  });

  /**
   * The point of keying on the profile. Clearing first matters on its own:
   * if the second fetch fails, the first radio's names must not stay up.
   */
  it('swaps to the other scanner’s names when a different radio connects', async () => {
    api.getBankNames.mockResolvedValueOnce({ names: NAMES_A });
    connect('scanner-a');
    renderHook(() => useBankNames(api));
    await waitFor(() => expect(useStore.getState().bankNames).toEqual(NAMES_A));

    api.getBankNames.mockRejectedValueOnce(new Error('offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    connect('scanner-b');
    expect(useStore.getState().bankNames).toEqual([]);
    await waitFor(() => expect(api.getBankNames).toHaveBeenCalledTimes(2));
    expect(useStore.getState().bankNames).toEqual([]);

    api.getBankNames.mockResolvedValueOnce({ names: NAMES_B });
    connect('scanner-c');
    await waitFor(() => expect(useStore.getState().bankNames).toEqual(NAMES_B));
  });

  it('does not refetch for an unrelated device-info change', async () => {
    api.getBankNames.mockResolvedValue({ names: NAMES_A });
    connect('scanner-a');
    renderHook(() => useBankNames(api));
    await waitFor(() => expect(useStore.getState().bankNames).toEqual(NAMES_A));

    act(() => {
      useStore.setState({
        deviceInfo: createTestDeviceInfo({
          scanner_id: 'scanner-a',
          connection_status: 'disconnected',
        }),
      });
    });
    expect(api.getBankNames).toHaveBeenCalledTimes(1);
    expect(useStore.getState().bankNames).toEqual(NAMES_A);
  });
});
