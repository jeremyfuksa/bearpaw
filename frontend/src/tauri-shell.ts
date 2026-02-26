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
  const marker = (window as Window & { __TAURI__?: unknown }).__TAURI__;
  return typeof marker === "object" && marker !== null;
}

export async function getShellInfo(): Promise<ShellInfo | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<ShellInfo>("shell_info");
}

export async function getBackendStatus(): Promise<BackendStatus | null> {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<BackendStatus>("backend_status");
}

export async function subscribeBackendStatus(
  onStatus: (status: BackendStatus) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<BackendStatus>("shell://backend-status", (event) => {
    if (event.payload) onStatus(event.payload);
  });
  return () => {
    void unlisten();
  };
}
