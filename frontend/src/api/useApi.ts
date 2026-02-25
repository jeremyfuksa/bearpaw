import { ScannerAPIClient } from "./client";

// Detect Tauri runtime only when the marker is truthy/object-like.
// In browser builds, __TAURI__ may exist as a false boolean sentinel.
const isTauri = (() => {
  const marker = (window as Window & { __TAURI__?: unknown }).__TAURI__;
  return typeof marker === "object" && marker !== null;
})();

// Backend URL configuration
const defaultBaseURL = isTauri 
  ? 'http://localhost:8000/api/v1'  // Sidecar runs on localhost
  : import.meta.env.VITE_API_BASE_URL || '/api/v1';

export function useAPI() {
  const baseURL = defaultBaseURL;
  if (!(globalThis as { __bearpawApiClients?: Map<string, ScannerAPIClient> })
    .__bearpawApiClients) {
    (globalThis as { __bearpawApiClients?: Map<string, ScannerAPIClient> })
      .__bearpawApiClients = new Map();
  }

  const clients = (globalThis as { __bearpawApiClients: Map<string, ScannerAPIClient> })
    .__bearpawApiClients;
  let client = clients.get(baseURL);
  if (!client) {
    client = new ScannerAPIClient(baseURL);
    clients.set(baseURL, client);
  }
  return client;
}
