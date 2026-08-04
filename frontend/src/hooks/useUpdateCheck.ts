import { useCallback, useEffect, useRef, useState } from 'react';
import { checkForUpdates, isTauriRuntime, type UpdateCheck } from '../tauri-shell';

export interface UseUpdateCheck {
  /** The pending update, or null when up to date / not yet checked / dismissed. */
  update: UpdateCheck | null;
  /** True while a manual (menu-triggered) check is in flight. */
  checking: boolean;
  /** Run a manual check — always reports a result, including "up to date". */
  checkNow: () => void;
  /** Hide the banner for this session. */
  dismiss: () => void;
}

/**
 * Update check against GitHub Releases (#273).
 *
 * Two triggers with deliberately different behaviour:
 *
 * - **Startup** (automatic, once per launch): silent unless an update
 *   exists. Bearpaw is offline-first, so a user with no network must
 *   never see an error, a spinner, or any hint the feature exists.
 * - **Manual** (Help → Check for Updates): always reports, because a
 *   menu item that appears to do nothing reads as broken. "You're up to
 *   date" is surfaced via `onUpToDate`.
 *
 * No-ops entirely outside Tauri — there is no shell command to call from
 * a plain browser dev server, and `checkForUpdates` returns null there.
 *
 * @param checkOnLaunch the `checkUpdatesOnLaunch` preference. Pass
 *   `undefined` while preferences are still loading — the startup check
 *   waits rather than acting on a default that may be about to change.
 *   Only the startup check is gated; the manual check always runs.
 */
export function useUpdateCheck(
  onUpToDate?: (current: string) => void,
  checkOnLaunch?: boolean,
): UseUpdateCheck {
  const [update, setUpdate] = useState<UpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);

  // Guards against React 18 StrictMode double-invoking effects in dev,
  // which would otherwise fire two startup requests per launch.
  const startupRan = useRef(false);
  // Read inside checkNow without making the callback depend on it, so the
  // identity stays stable for the menu-handler deps in App.tsx.
  const checkingRef = useRef(false);
  // Latest-callback ref, synced after commit rather than during render.
  // Writing `.current` inline in the render body trips react-hooks/refs and
  // is genuinely unsafe under concurrent rendering, where a render can be
  // discarded and replayed.
  const onUpToDateRef = useRef(onUpToDate);
  useEffect(() => {
    onUpToDateRef.current = onUpToDate;
  }, [onUpToDate]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    // `undefined` means preferences haven't loaded yet. Waiting is load-
    // bearing: they arrive asynchronously from the backend, so acting on
    // the store default here would fire the request before a stored
    // `false` ever lands, and the toggle would appear to do nothing.
    if (checkOnLaunch === undefined) return;
    if (!checkOnLaunch) return;
    if (startupRan.current) return;
    startupRan.current = true;

    let cancelled = false;
    void checkForUpdates().then((result) => {
      // Silent on failure (null) and when already current: startup only
      // ever speaks up to announce a real update.
      if (cancelled || !result?.available) return;
      setUpdate(result);
    });

    return () => {
      cancelled = true;
    };
  }, [checkOnLaunch]);

  const checkNow = useCallback(() => {
    if (!isTauriRuntime()) return;
    if (checkingRef.current) return;

    checkingRef.current = true;
    setChecking(true);
    void checkForUpdates()
      .then((result) => {
        if (result?.available) {
          setUpdate(result);
          return;
        }
        // Null (failure) and up-to-date both land here. The manual path
        // owes the user an answer either way; `current_version` is absent
        // on failure, which the caller renders as a generic message.
        onUpToDateRef.current?.(result?.current_version ?? '');
      })
      .finally(() => {
        checkingRef.current = false;
        setChecking(false);
      });
  }, []);

  const dismiss = useCallback(() => setUpdate(null), []);

  return { update, checking, checkNow, dismiss };
}
