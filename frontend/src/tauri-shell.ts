import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask, open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import { writeFile, readFile } from '@tauri-apps/plugin-fs';
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

/**
 * Confirmation dialog that works in both runtimes. Under Tauri, the
 * webview's native `window.confirm` silently returns false (macOS
 * WKWebView never blocks on it), so we use the dialog plugin's `ask`.
 * In a plain browser (dev server, tests) `window.confirm` works, so we
 * fall back to it. Returns true when the user confirms.
 */
export async function confirmDialog(message: string, title: string): Promise<boolean> {
  if (isTauriRuntime()) {
    return ask(message, { title, kind: 'warning' });
  }
  return window.confirm(message);
}

/**
 * Save exported file bytes with a readable filename.
 *
 * In Tauri, a blob-URL `<a download>` loses the filename — WKWebView's
 * native download handler ignores the DOM `download` attribute and writes
 * a hashed name to a default location. So under Tauri we write the bytes
 * straight to the system Downloads folder via the fs plugin. In a plain
 * browser the anchor download works, so we keep that path.
 *
 * Returns where it saved: `'downloads'` (Tauri) or `'browser'` (fallback).
 */
export async function saveExport(
  filename: string,
  bytes: Uint8Array,
): Promise<'saved' | 'browser' | 'cancelled'> {
  if (isTauriRuntime()) {
    // Use the native Save panel rather than writing to BaseDirectory.Download:
    // the app is macOS-sandboxed, so $DOWNLOAD resolves inside the app's
    // container (~/Library/Containers/.../Data/Downloads), not the user's real
    // ~/Downloads — the write would succeed silently in the wrong place. A
    // dialog-chosen path carries a sandbox grant, so the write lands where the
    // user picked.
    const path = await saveFileDialog({ defaultPath: filename });
    if (path === null) return 'cancelled';
    await writeFile(path, bytes);
    return 'saved';
  }
  // `bytes` is always backed by a plain ArrayBuffer here (never SharedArrayBuffer),
  // but TS 5.7's generic Uint8Array can't prove it — narrow to BlobPart.
  const blob = new Blob([bytes as BlobPart]);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  return 'browser';
}

/** A file the user picked: its base name and raw bytes. */
export interface PickedFile {
  name: string;
  bytes: Uint8Array;
}

/**
 * Prompt for a file and return its name + bytes, or null if cancelled.
 *
 * In Tauri, a programmatically-clicked `<input type="file">` opens the
 * picker but its `change` event often never fires in the WKWebView, so the
 * selection is lost. We use the dialog plugin's `open()` to get a path and
 * read it via the fs plugin. In a plain browser the input element works, so
 * we keep that path.
 *
 * @param extensions allowed file extensions without the dot, e.g. ['csv'].
 */
export async function pickAndReadFile(extensions: string[]): Promise<PickedFile | null> {
  if (isTauriRuntime()) {
    const selected = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: extensions.join(', ').toUpperCase(), extensions }],
    });
    if (typeof selected !== 'string') return null; // cancelled (null) or multi (array)
    const bytes = await readFile(selected);
    const name = selected.split(/[\\/]/).pop() ?? 'import';
    return { name, bytes };
  }

  return new Promise<PickedFile | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = extensions.map((e) => `.${e}`).join(',');
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      resolve({ name: file.name, bytes });
    };
    input.click();
  });
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
