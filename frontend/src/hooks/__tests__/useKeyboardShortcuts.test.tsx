import { renderHook, act } from '@testing-library/react';
import { useKeyboardShortcuts } from '../useKeyboardShortcuts';
import { useStore } from '../../store/useStore';
import { vi } from 'vitest';

vi.mock('../../store/useStore');
vi.mock('../../api/useApi');

describe('useKeyboardShortcuts', () => {
  let mockApi: any;
  let mockHandlers: any;

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

    (useStore.getState as any).mockReturnValue({
      liveState: {
        frequency: 145.5,
        channel: 1,
        mode: 'SCAN',
      }
    });

    vi.clearAllMocks();
  });

  it('should call toggleTemporaryLockout with correct parameters on Ctrl+L', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers, mockApi));

    const event = new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
    });
    window.dispatchEvent(event);

    expect(mockApi.toggleTemporaryLockout).toHaveBeenCalledWith({
      frequency: 145.5,
      channel: 1,
    });
  });

  it('should call openActivityLog on Ctrl+Shift+L', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers, mockApi));

    const event = new KeyboardEvent('keydown', {
      key: 'l',
      ctrlKey: true,
      shiftKey: true,
    });
    window.dispatchEvent(event);

    expect(mockHandlers.openActivityLog).toHaveBeenCalled();
  });

  it('should call sendScan on Ctrl+S', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers, mockApi));

    const event = new KeyboardEvent('keydown', {
      key: 's',
      ctrlKey: true,
    });
    window.dispatchEvent(event);

    expect(mockApi.sendScan).toHaveBeenCalled();
  });

  it('should call sendHold on Ctrl+H', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers, mockApi));

    const event = new KeyboardEvent('keydown', {
      key: 'h',
      ctrlKey: true,
    });
    window.dispatchEvent(event);

    expect(mockApi.sendHold).toHaveBeenCalled();
  });

  it('should call sendKey with UP on Ctrl+ArrowUp', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers, mockApi));

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      ctrlKey: true,
    });
    window.dispatchEvent(event);

    expect(mockApi.sendKey).toHaveBeenCalledWith('UP');
  });

  it('should call sendKey with DOWN on Ctrl+ArrowDown', () => {
    renderHook(() => useKeyboardShortcuts(mockHandlers, mockApi));

    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      ctrlKey: true,
    });
    window.dispatchEvent(event);

    expect(mockApi.sendKey).toHaveBeenCalledWith('DOWN');
  });
});
