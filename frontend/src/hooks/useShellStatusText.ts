import { useEffect, useMemo, useState } from 'react';
import {
  getBackendStatus,
  getShellInfo,
  isTauriRuntime,
  subscribeBackendStatus,
  type BackendStatus,
} from '../tauri-shell';

/**
 * Returns the human-readable status string for the embedded Tauri
 * backend ("Backend up", "Backend down (error)", "Bearpaw 1.0.0 •
 * Backend up"), or `null` when we're not in a Tauri runtime — at
 * which point the caller should hide the indicator entirely.
 *
 * Mirrors what the UI actually needs: App.tsx never reads the raw
 * `BackendStatus` or the product label separately, so we keep them
 * private to the hook and only surface the composed string.
 */
export function useShellStatusText(): string | null {
  const [shellStatus, setShellStatus] = useState<BackendStatus | null>(null);
  const [shellLabel, setShellLabel] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauriRuntime()) {
      setShellStatus(null);
      setShellLabel(null);
      return;
    }
    let active = true;
    let cleanup: (() => void) | null = null;

    getShellInfo()
      .then((info) => {
        if (!active || !info) return;
        setShellLabel(`${info.product_name} ${info.version}`);
      })
      .catch(() => {
        // Ignore shell metadata failures in UI.
      });

    getBackendStatus()
      .then((status) => {
        if (active) setShellStatus(status);
      })
      .catch(() => {
        // Ignore initial status failures; event stream may still provide updates.
      });

    subscribeBackendStatus((status) => {
      if (active) setShellStatus(status);
    })
      .then((unlisten) => {
        cleanup = unlisten;
      })
      .catch(() => {
        // Non-fatal in browser or restricted runtime.
      });

    return () => {
      active = false;
      if (cleanup) cleanup();
    };
  }, []);

  return useMemo(() => {
    if (!isTauriRuntime()) return null;
    const server = shellStatus?.running ? 'Backend up' : 'Backend down';
    if (shellStatus?.last_error) return `${server} (error)`;
    if (shellLabel) return `${shellLabel} • ${server}`;
    return server;
  }, [shellLabel, shellStatus]);
}
