import { useEffect } from 'react';

interface BankRefreshApi {
  getBanks: () => Promise<{ banks: boolean[] }>;
}

interface BankRefreshParams {
  api: BankRefreshApi;
  /**
   * `deviceInfo.connection_status`, NOT the `deviceInfo` object -- see the
   * #596 guard below.
   */
  connectionStatus: string | undefined;
  syncInProgress: boolean;
  /**
   * A startup sync has been decided on but `POST /memory/sync` has not come
   * back yet. See the #606 guard on the effect below — `syncInProgress` alone
   * leaves a window open at exactly the moment this effect first runs.
   */
  syncPending: boolean;
  setBanks: (banks: boolean[]) => void;
}

/**
 * Re-read the bank-enable mask when the scanner becomes reachable, and again
 * when a memory sync releases program mode.
 *
 * Lifted out of `App.tsx` (#596) for the same reason `useAutoMemorySync` was
 * (#568): the bug is about HOW OFTEN an effect runs, and no source-level
 * assertion about a deps array can see that. The guard this file replaces
 * asserted the deps array's shape and was perfectly happy while the effect
 * fired twice per connect.
 *
 * REGRESSION GUARD (`one_bank_read_per_connect`): the dependency is
 * `connectionStatus`, a STRING -- never the `deviceInfo` object.
 *
 * `deviceInfo`'s identity changes every time it is set, and three places set
 * it: the mount `Promise.allSettled` fetch, a second one-shot `getDeviceInfo()`
 * on mount, and the WS `device_info` handler. Any two of those landing gave two
 * bank reads at every launch. Measured on hardware 2026-08-31: two adjacent
 * `GET /api/v1/banks` on one page load.
 *
 * This effect does not care about `deviceInfo`'s contents -- only whether the
 * scanner is reachable -- so depending on the object made it re-run on churn
 * that means nothing to it.
 *
 * That matters because `get_banks` is not one command. It is a whole
 * program-mode bracket: `PRG`, the 100 ms settle, `SCG`, then `EPG` on guard
 * drop. Two of those back to back, serialized behind the 5 Hz poll loop with a
 * 3-second budget each, is exactly the shape that made the second one time out
 * in #584 -- 50 to 124 times a day in the logs there.
 *
 * `syncInProgress` stays a dependency and is load-bearing: it is what re-runs
 * this when a sync ends, which is what makes this -- and not the post-sync
 * chain -- the place bank state is refreshed (#584).
 */
export function useBankRefresh({
  api,
  connectionStatus,
  syncInProgress,
  syncPending,
  setBanks,
}: BankRefreshParams): void {
  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    // REGRESSION GUARD (`does not read banks while a sync is pending but not yet
    // in progress`, #606): both flags, not just `syncInProgress`.
    //
    // `syncInProgress` flips only once `POST /memory/sync` has come back. At
    // the connect edge it is still false while the startup sync is being
    // requested, so this effect fired first, took program mode, and had its
    // `SCG` queued behind the sync -- which the poll thread dispatches INLINE,
    // so the command queue is not drained for the sync's duration. The read
    // then blew its 3-second budget. Reproduced on hardware 2026-09-01: sync
    // first gives a clean 409 in 0.5 ms, bank read first gives
    // `command_timeout` after 3.31 s, once per launch.
    //
    // `syncPending` must CLEAR rather than hand off to nothing: a pending sync
    // can resolve into no sync at all (cache-first, where `useAutoMemorySync`
    // declines after its `getChannels` check), and on that path banks would
    // otherwise never be read. That is the trap #596 named -- removing a bank
    // read until there is no bank read left.
    if (syncPending || syncInProgress) return; // wait for the sync to release PRG mode
    let active = true;
    api
      .getBanks()
      .then((result) => {
        if (!active) return;
        if (Array.isArray(result.banks) && result.banks.length === 10) {
          setBanks(result.banks);
        }
      })
      .catch((error) => {
        console.warn('Failed to refresh banks after sync', error);
      });
    return () => {
      active = false;
    };
  }, [api, connectionStatus, syncInProgress, syncPending, setBanks]);
}
