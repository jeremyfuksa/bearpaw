import { useMemo } from "react";

import { ScannerAPIClient } from "./client";

const defaultBaseURL = import.meta.env.VITE_API_BASE_URL || "/api/v1";

export function useAPI() {
  const baseURL = defaultBaseURL;
  return useMemo(() => new ScannerAPIClient(baseURL), [baseURL]);
}
