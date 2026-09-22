/// <reference types="vite/client" />

// Injected by Vite's `define` (see vite.config.ts) — the package version.
declare const __APP_VERSION__: string;

// Set by the startup-failure script inline in index.html (#679).
interface Window {
  __bearpawStarted?: boolean;
  __bearpawStartupFailureShown?: boolean;
  __bearpawShowStartupFailure?: (detail: string) => void;
}
