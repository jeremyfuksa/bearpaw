import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useUpdateCheck } from '../useUpdateCheck';
import { checkForUpdates, isTauriRuntime, type UpdateCheck } from '../../tauri-shell';

vi.mock('../../tauri-shell', () => ({
  checkForUpdates: vi.fn(),
  isTauriRuntime: vi.fn(),
}));

const mockCheck = vi.mocked(checkForUpdates);
const mockIsTauri = vi.mocked(isTauriRuntime);

function available(overrides: Partial<UpdateCheck> = {}): UpdateCheck {
  return {
    available: true,
    latest_version: 'v1.0.0-beta.3',
    release_url: 'https://github.com/jeremyfuksa/bearpaw/releases/tag/v1.0.0-beta.3',
    current_version: '1.0.0-beta.2',
    ...overrides,
  };
}

function upToDate(): UpdateCheck {
  return {
    available: false,
    latest_version: null,
    release_url: null,
    current_version: '1.0.0-beta.2',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsTauri.mockReturnValue(true);
});

describe('useUpdateCheck — startup', () => {
  it('surfaces an available update found at startup', async () => {
    mockCheck.mockResolvedValue(available());
    const { result } = renderHook(() => useUpdateCheck(undefined, true));

    await waitFor(() => expect(result.current.update).not.toBeNull());
    expect(result.current.update?.latest_version).toBe('v1.0.0-beta.3');
  });

  it('stays silent when already up to date', async () => {
    mockCheck.mockResolvedValue(upToDate());
    const onUpToDate = vi.fn();
    const { result } = renderHook(() => useUpdateCheck(onUpToDate, true));

    await waitFor(() => expect(mockCheck).toHaveBeenCalled());
    expect(result.current.update).toBeNull();
    // The startup path must never announce "up to date" — that is the
    // manual path's job. Announcing here would break offline-first quiet.
    expect(onUpToDate).not.toHaveBeenCalled();
  });

  it('stays silent when the check fails (offline)', async () => {
    mockCheck.mockResolvedValue(null);
    const onUpToDate = vi.fn();
    const { result } = renderHook(() => useUpdateCheck(onUpToDate, true));

    await waitFor(() => expect(mockCheck).toHaveBeenCalled());
    expect(result.current.update).toBeNull();
    expect(onUpToDate).not.toHaveBeenCalled();
  });

  it('does not call the shell outside Tauri', async () => {
    mockIsTauri.mockReturnValue(false);
    const { result } = renderHook(() => useUpdateCheck(undefined, true));

    await act(async () => {});
    expect(mockCheck).not.toHaveBeenCalled();
    expect(result.current.update).toBeNull();
  });

  it('checks once per mount, not once per render', async () => {
    mockCheck.mockResolvedValue(upToDate());
    const { rerender } = renderHook(() => useUpdateCheck(undefined, true));

    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
    rerender();
    rerender();
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});

describe('useUpdateCheck — checkUpdatesOnLaunch gate (#273)', () => {
  it('waits while preferences are still loading', async () => {
    mockCheck.mockResolvedValue(available());
    renderHook(() => useUpdateCheck(undefined, undefined));

    await act(async () => {});
    // `undefined` means "not known yet". Acting on the store default here
    // would fire the request before a stored `false` ever arrives, and the
    // toggle would appear to do nothing.
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('does not check at startup when the preference is off', async () => {
    mockCheck.mockResolvedValue(available());
    const { result } = renderHook(() => useUpdateCheck(undefined, false));

    await act(async () => {});
    expect(mockCheck).not.toHaveBeenCalled();
    expect(result.current.update).toBeNull();
  });

  it('checks once the preference arrives as true', async () => {
    mockCheck.mockResolvedValue(available());
    const { rerender } = renderHook(({ gate }) => useUpdateCheck(undefined, gate), {
      initialProps: { gate: undefined as boolean | undefined },
    });

    await act(async () => {});
    expect(mockCheck).not.toHaveBeenCalled();

    rerender({ gate: true });
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));
  });

  it('never checks when the preference arrives as false', async () => {
    mockCheck.mockResolvedValue(available());
    const { rerender } = renderHook(({ gate }) => useUpdateCheck(undefined, gate), {
      initialProps: { gate: undefined as boolean | undefined },
    });

    rerender({ gate: false });
    await act(async () => {});
    expect(mockCheck).not.toHaveBeenCalled();
  });

  it('still allows a manual check when the startup preference is off', async () => {
    mockCheck.mockResolvedValue(upToDate());
    const onUpToDate = vi.fn();
    const { result } = renderHook(() => useUpdateCheck(onUpToDate, false));

    await act(async () => {
      result.current.checkNow();
    });

    // Only the automatic check is gated. Turning off the launch check must
    // not disable the button the user just pressed.
    expect(mockCheck).toHaveBeenCalledTimes(1);
    expect(onUpToDate).toHaveBeenCalledWith('1.0.0-beta.2');
  });

  it('does not re-check when the preference toggles off and on again', async () => {
    mockCheck.mockResolvedValue(upToDate());
    const { rerender } = renderHook(({ gate }) => useUpdateCheck(undefined, gate), {
      initialProps: { gate: true as boolean | undefined },
    });
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));

    rerender({ gate: false });
    rerender({ gate: true });
    await act(async () => {});

    // The startup check is once per launch, not once per toggle flip.
    expect(mockCheck).toHaveBeenCalledTimes(1);
  });
});

describe('useUpdateCheck — manual', () => {
  it('reports up to date so the menu item never looks broken', async () => {
    mockCheck.mockResolvedValue(upToDate());
    const onUpToDate = vi.fn();
    const { result } = renderHook(() => useUpdateCheck(onUpToDate, true));
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.checkNow();
    });

    expect(onUpToDate).toHaveBeenCalledWith('1.0.0-beta.2');
  });

  it('reports a failed manual check with an empty version', async () => {
    mockCheck.mockResolvedValue(null);
    const onUpToDate = vi.fn();
    const { result } = renderHook(() => useUpdateCheck(onUpToDate, true));
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.checkNow();
    });

    // Empty string signals "couldn't check" vs a real version string.
    expect(onUpToDate).toHaveBeenCalledWith('');
  });

  it('surfaces an update found by a manual check', async () => {
    mockCheck.mockResolvedValueOnce(upToDate()).mockResolvedValueOnce(available());
    const { result } = renderHook(() => useUpdateCheck(undefined, true));
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));

    await act(async () => {
      result.current.checkNow();
    });

    expect(result.current.update?.latest_version).toBe('v1.0.0-beta.3');
  });

  it('ignores a second manual check while one is in flight', async () => {
    mockCheck.mockResolvedValue(upToDate());
    const { result } = renderHook(() => useUpdateCheck(undefined, true));
    await waitFor(() => expect(mockCheck).toHaveBeenCalledTimes(1));

    let release: (v: UpdateCheck | null) => void = () => {};
    mockCheck.mockReturnValueOnce(
      new Promise<UpdateCheck | null>((resolve) => {
        release = resolve;
      }),
    );

    act(() => {
      result.current.checkNow();
      result.current.checkNow();
      result.current.checkNow();
    });

    // Three clicks, one additional request: the in-flight guard held.
    expect(mockCheck).toHaveBeenCalledTimes(2);
    await act(async () => {
      release(upToDate());
    });
  });

  it('dismiss clears the banner', async () => {
    mockCheck.mockResolvedValue(available());
    const { result } = renderHook(() => useUpdateCheck(undefined, true));
    await waitFor(() => expect(result.current.update).not.toBeNull());

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.update).toBeNull();
  });
});
