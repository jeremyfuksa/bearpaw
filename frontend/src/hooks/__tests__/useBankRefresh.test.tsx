import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useBankRefresh } from '../useBankRefresh';

/**
 * BEHAVIOURAL guards for the bank refresh (#596).
 *
 * The guard this replaces asserted the deps array's shape, and was perfectly
 * happy while the effect fired twice per connect -- because "how often does
 * this run?" is not a question a source-level assertion can answer. Measured on
 * hardware 2026-08-31: two adjacent `GET /api/v1/banks` on one page load.
 */
describe('useBankRefresh', () => {
  const api = { getBanks: vi.fn<() => Promise<{ banks: boolean[] }>>() };
  const setBanks = vi.fn();
  const allEnabled = Array(10).fill(true);

  beforeEach(() => {
    vi.clearAllMocks();
    api.getBanks.mockResolvedValue({ banks: allEnabled });
  });

  const render = (overrides: Partial<Parameters<typeof useBankRefresh>[0]> = {}) =>
    renderHook((props: Parameters<typeof useBankRefresh>[0]) => useBankRefresh(props), {
      initialProps: {
        api,
        connectionStatus: 'connected',
        syncInProgress: false,
        // Explicit, not omitted: leaving it undefined here makes the first
        // rerender look like a dependency change (undefined -> false) and
        // fires a second read, which the once-per-connect guard catches.
        syncPending: false,
        setBanks,
        ...overrides,
      },
    });

  const props = (
    connectionStatus: string | undefined,
    syncInProgress = false,
    syncPending = false,
  ) => ({
    api,
    connectionStatus,
    syncInProgress,
    syncPending,
    setBanks,
  });

  /**
   * THE #606 RACE, and the reason `syncPending` exists at all.
   *
   * `syncInProgress` only flips once `POST /memory/sync` has come back. At the
   * connect edge it is still false while the startup sync is being requested,
   * so this effect fired, took program mode, and had its `SCG` queued behind
   * the sync — which the poll thread dispatches INLINE, so the queue is not
   * drained for the sync's duration. The read then blew its 3-second budget.
   *
   * Reproduced on hardware 2026-09-01: sync first gives a clean 409 in 0.5 ms,
   * bank read first gives `command_timeout` after 3.31 s. One per launch.
   */
  it('does not read banks while a sync is pending but not yet in progress', async () => {
    render({ syncInProgress: false, syncPending: true });
    await Promise.resolve();
    await Promise.resolve();

    expect(api.getBanks).not.toHaveBeenCalled();
  });

  /**
   * The other half, and NOT redundant.
   *
   * A pending sync can resolve into no sync at all: with
   * `reread_memory_on_connect` off and the cache warm, `useAutoMemorySync`
   * declines after its `getChannels` check and `syncInProgress` never becomes
   * true. If clearing `syncPending` did not re-open this gate, banks would
   * never be read on that path — which is the trap #596 already warned about,
   * where removing a bank read leaves no bank read at all.
   *
   * Suppressing the connect-edge read outright would pass the test above and
   * fail here.
   */
  it('reads banks when a pending sync resolves without one starting', async () => {
    const { rerender } = render({ syncInProgress: false, syncPending: true });
    await Promise.resolve();
    expect(api.getBanks).not.toHaveBeenCalled();

    // The decline path: pending clears, and `inProgress` never went true.
    rerender(props('connected', false, false));

    await waitFor(() => expect(api.getBanks).toHaveBeenCalledTimes(1));
    expect(setBanks).toHaveBeenCalledWith(allEnabled);
  });

  /**
   * The handoff must not open a window either. `syncPending` clears at the same
   * moment `syncInProgress` is set, and if the gate checked them in a way that
   * let both be briefly false, the race would simply move.
   */
  it('does not read banks when pending hands off to in-progress', async () => {
    const { rerender } = render({ syncInProgress: false, syncPending: true });
    await Promise.resolve();

    rerender(props('connected', true, false));
    await Promise.resolve();
    await Promise.resolve();

    expect(api.getBanks).not.toHaveBeenCalled();
  });

  /**
   * THE BUG. `deviceInfo` is an object whose identity changes every time it is
   * set, and THREE places set it: the mount `Promise.allSettled` fetch, a
   * second one-shot `getDeviceInfo()` on mount, and the WS `device_info`
   * handler. With the object as a dependency, any two of those landing gave two
   * bank reads -- and `get_banks` is a whole program-mode bracket (`PRG`, a
   * 100 ms settle, `SCG`, `EPG`), not one command.
   *
   * Re-rendering with a NEW props object each time is the point: it reproduces
   * exactly what a fresh `deviceInfo` did.
   */
  it('reads banks once per connect, however often device info is replaced', async () => {
    const { rerender } = render();
    await waitFor(() => expect(api.getBanks).toHaveBeenCalledTimes(1));

    // Two more device-info updates land. Same status, new objects.
    rerender(props('connected'));
    rerender(props('connected'));
    await Promise.resolve();

    expect(api.getBanks).toHaveBeenCalledTimes(1);
  });

  /**
   * Not optional: `syncInProgress` must stay a dependency.
   *
   * It is what re-runs this when a sync ends, which is what makes this -- and
   * not the post-sync chain -- the place bank state is refreshed (#584).
   * Without it, #584's fix would have removed the only remaining bank read.
   */
  it('reads banks again when a sync ends', async () => {
    const { rerender } = render({ syncInProgress: true });
    await Promise.resolve();
    expect(api.getBanks).not.toHaveBeenCalled();

    rerender(props('connected', false));

    await waitFor(() => expect(api.getBanks).toHaveBeenCalledTimes(1));
    expect(setBanks).toHaveBeenCalledWith(allEnabled);
  });

  /** A reconnect is a new connect, and does re-read. */
  it('reads banks again after a reconnect', async () => {
    const { rerender } = render();
    await waitFor(() => expect(api.getBanks).toHaveBeenCalledTimes(1));

    rerender(props('disconnected'));
    await Promise.resolve();
    rerender(props('connected'));

    await waitFor(() => expect(api.getBanks).toHaveBeenCalledTimes(2));
  });

  /** Nothing is asked of a scanner that is not there. */
  it('does nothing while disconnected', async () => {
    render({ connectionStatus: 'disconnected' });
    await Promise.resolve();
    expect(api.getBanks).not.toHaveBeenCalled();
  });

  /**
   * A short mask is refused rather than stored. The scanner's `SCG` reply is
   * ten characters on both families; anything else means the parse went wrong,
   * and writing it would hand the UI a bank list of the wrong length.
   */
  it('ignores a mask that is not ten banks', async () => {
    api.getBanks.mockResolvedValue({ banks: [true, false] });
    render();
    await waitFor(() => expect(api.getBanks).toHaveBeenCalled());
    expect(setBanks).not.toHaveBeenCalled();
  });
});
