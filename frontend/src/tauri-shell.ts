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
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<ShellInfo>('shell_info');
}

export async function getBackendStatus(): Promise<BackendStatus | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<BackendStatus>('backend_status');
}

export async function subscribeBackendStatus(
  onStatus: (status: BackendStatus) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<BackendStatus>('shell://backend-status', (event) => {
    if (event.payload) onStatus(event.payload);
  });
  return () => {
    void unlisten();
  };
}
