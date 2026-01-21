import { useMemo } from "react";

import { ScannerAPIClient } from "./client";

// Detect if running in Tauri
const isTauri = '__TAURI__' in window;

// Backend URL configuration
const defaultBaseURL = isTauri 
  ? 'http://localhost:8000/api/v1'  // Sidecar runs on localhost
  : import.meta.env.VITE_API_BASE_URL || '/api/v1';

export function useAPI() {
  const baseURL = defaultBaseURL;
  return useMemo(() => new ScannerAPIClient(baseURL), [baseURL]);
}
