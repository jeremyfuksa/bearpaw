import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openInShell } from '@tauri-apps/plugin-shell';

export interface ShellInfo {
  product_name: string;
  version: string;
  backend_bind: string;
  is_desktop: boolean;
}

export interface BackendStatus {
  running: boolean;
  bind: string;
  started_at_ms?: number | null;
  last_error?: string | null;
}

export function isTauriRuntime(): boolean {
  // Tauri 2 only injects `__TAURI_INTERNALS__` by default. `__TAURI__` is
  // present only when `app.withGlobalTauri` is set in `tauri.conf.json`,
  // which we deliberately leave off. Check both so the helper keeps
  // working regardless of that config flip.
  const w = window as Window & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  const hasGlobal = typeof w.__TAURI__ === 'object' && w.__TAURI__ !== null;
  const hasInternals = typeof w.__TAURI_INTERNALS__ === 'object' && w.__TAURI_INTERNALS__ !== null;
  return hasGlobal || hasInternals;
}

export async function getShellInfo(): Promise<ShellInfo | null> {
  if (!isTauriRuntime()) return null;
  return invoke<ShellInfo>('shell_info');
}

export async function getBackendStatus(): Promise<BackendStatus | null> {
  if (!isTauriRuntime()) return null;
  return invoke<BackendStatus>('backend_status');
}

/**
 * Open a URL in the user's default browser via Tauri's shell plugin.
 * Falls back to `window.open` outside Tauri (e.g. plain `npm run dev`),
 * which is fine because that path has a real browser already.
 */
export function openExternalUrl(url: string): void {
  if (isTauriRuntime()) {
    void openInShell(url).catch((error) => {
      console.warn('Failed to open external URL via shell plugin', error);
    });
    return;
  }
  window.open(url, '_blank', 'noopener');
}

export async function subscribeBackendStatus(
  onStatus: (status: BackendStatus) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const unlisten = await listen<BackendStatus>('shell://backend-status', (event) => {
    if (event.payload) onStatus(event.payload);
  });
  return () => {
    void unlisten();
  };
}
