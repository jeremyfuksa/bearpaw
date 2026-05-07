import { renderHook, act } from '@testing-library/react';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { useStore } from '../../store/useStore';
import { getAPI } from '../../api/useApi';
import { vi } from 'vitest';

vi.mock('../../api/useApi', () => ({
  getAPI: vi.fn(),
}));

vi.mock('../../store/useStore', () => ({
  useStore: Object.assign(vi.fn(), { getState: vi.fn() }),
}));

describe('useKeyboardShortcuts', () => {
  let mockApi: any;
  let mockHandlers: any;

  const mockedGetAPI = vi.mocked(getAPI);
  const mockedGetState = vi.mocked(useStore.getState);

  beforeEach(() => {
    mockApi = {
      toggleTemporaryLockout: vi.fn(),
      sendHold: vi.fn(),
      sendScan: vi.fn(),
      sendKey: vi.fn(),
    };

    mockHandlers = {
      openShortcuts: vi.fn(),
      openActivityLog: vi.fn(),
      openMemoryBrowser: vi.fn(),
      closeOverlays: vi.fn(),
    };

    mockedGetAPI.mockReturnValue(mockApi);
    mockedGetState.mockReturnValue({
      liveState: {
        timestamp: 0,
        frequency: 145.5,
        modulation: 'FM',
        squelch_open: false,
        rssi: 0,
        mode: 'SCAN',
        channel: 1,
        alpha_tag: null,
        volume: 0,
        battery: null,
        stale: false,
      },
    } as ReturnType<typeof useStore.getState>);

    vi.clearAllMocks();
  });

  it('should call toggleTemporaryLockout with correct parameters on Ctrl+L', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers));

    const event = new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(mockApi.toggleTemporaryLockout).toHaveBeenCalledWith({
      frequency: 145.5,
      channel: 1,
    });
  });

  it('should call openActivityLog on Ctrl+Shift+L', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers));

    const event = new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
      shiftKey: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(mockHandlers.openActivityLog).toHaveBeenCalled();
  });

  it('should call sendScan on Ctrl+S', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers));

    const event = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(mockApi.sendScan).toHaveBeenCalled();
  });

  it('should call sendHold on Ctrl+H', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers));

    const event = new KeyboardEvent('keydown', {
      key: 'h',
      ctrlKey: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(mockApi.sendHold).toHaveBeenCalled();
  });

  it('should call sendKey with UP on Ctrl+ArrowUp', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers));

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      ctrlKey: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(mockApi.sendKey).toHaveBeenCalledWith('UP');
  });

  it('should call sendKey with DOWN on Ctrl+ArrowDown', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers));

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      ctrlKey: true,
    });
    act(() => {
      document.dispatchEvent(event);
    });

    expect(mockApi.sendKey).toHaveBeenCalledWith('DOWN');
  });
});
