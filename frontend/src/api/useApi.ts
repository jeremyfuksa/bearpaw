import { ScannerAPIClient } from './client';
import { isTauriRuntime } from '../tauri-shell';

// Backend URL configuration — exported so non-hook code can resolve API URLs
// without hardcoding paths that break in Tauri's file:// context.
export const API_BASE = isTauriRuntime()
  ? 'http://localhost:8000/api/v1'
  : import.meta.env.VITE_API_BASE_URL || '/api/v1';

const defaultBaseURL = API_BASE;

export function getAPI() {
  const baseURL = defaultBaseURL;
  if (
    !(globalThis as { __bearpawApiClients?: Map<string, ScannerAPIClient> }).__bearpawApiClients
  ) {
    (globalThis as { __bearpawApiClients?: Map<string, ScannerAPIClient> }).__bearpawApiClients =
      new Map();
  }

  const clients = (globalThis as unknown as { __bearpawApiClients: Map<string, ScannerAPIClient> })
    .__bearpawApiClients;
  let client = clients.get(baseURL);
  if (!client) {
    client = new ScannerAPIClient(baseURL);
    clients.set(baseURL, client);
  }
  return client;
}
