import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Regression-guard tests for App.tsx.
 *
 * These tests do NOT mount the App component. They parse App.tsx as source
 * and assert the specific code shapes that caused production regressions
 * have not returned. Each test corresponds to a `REGRESSION GUARD:` comment
 * in App.tsx — if you touch the guarded code, the failing test tells you
 * which comment to read.
 *
 * Why source-level instead of behavioral? The behavioral tests would need
 * to mount App with mocks for the WebSocket context, the Tauri shell, the
 * Zustand store, the menu-event bus, the API client, the toast plugin, and
 * the routing layer — hours of mock infrastructure for what is effectively
 * a "this edit must not recur" assertion. Source-level checks are precise
 * for this purpose and cheap. Behavioral coverage of these flows is tracked
 * separately (see CLAUDE.md "Third-rail flows").
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_PATH = resolve(HERE, '..', 'App.tsx');
const APP_SOURCE = readFileSync(APP_PATH, 'utf8');

/**
 * Extracts the deps array of the WebSocket-subscription useEffect — the one
 * whose body sets up `unsubscribeState`, `unsubscribeEvent`,
 * `unsubscribeDeviceInfo`, `unsubscribeProgress`. Returns the raw deps text
 * between the `[` and `]`.
 */
function extractWsEffectDepsArray(source: string): string {
  // Anchor on the unique tuple of unsubscribe identifiers in the cleanup.
  const anchor = source.indexOf('unsubscribeProgress();');
  if (anchor === -1) throw new Error('Could not locate WS useEffect cleanup');
  // From there, find the next `}, [` (closes the effect and opens deps).
  const depsOpen = source.indexOf('}, [', anchor);
  if (depsOpen === -1) throw new Error('Could not locate WS useEffect deps array open');
  const depsClose = source.indexOf(']);', depsOpen);
  if (depsClose === -1) throw new Error('Could not locate WS useEffect deps array close');
  return source.slice(depsOpen + 3, depsClose + 1);
}

/**
 * Strips line and block comments from a TS/JSX source slice. Approximate
 * (does not handle comment-like substrings inside strings/regexes), but
 * adequate for the small handler bodies we inspect — none of them embed
 * "//" or "/*" inside string literals.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

/**
 * Extracts the body of `handleCancelSync` — the text between its opening
 * `=> {` and the matching closing `}` of the useCallback body, with
 * comments stripped so regex assertions check only executable code.
 */
function extractHandleCancelSyncBody(source: string): string {
  const declStart = source.indexOf('const handleCancelSync = useCallback');
  if (declStart === -1) throw new Error('Could not locate handleCancelSync declaration');
  const bodyOpen = source.indexOf('=> {', declStart);
  if (bodyOpen === -1) throw new Error('Could not locate handleCancelSync body open');
  // Find the closing `}, [` of the useCallback. handleCancelSync has no
  // nested useCallback so a forward scan for `}, [` works.
  const bodyClose = source.indexOf('}, [', bodyOpen);
  if (bodyClose === -1) throw new Error('Could not locate handleCancelSync body close');
  return stripComments(source.slice(bodyOpen + 4, bodyClose));
}

describe('App.tsx regression guards', () => {
  describe('WS subscription is stable across liveState updates', () => {
    // History: PR landed in the days leading up to 2026-05-22 added
    // `liveState?.mode` to the deps array, which made the WS-subscribe
    // useEffect tear down and re-register all four channels on every poll
    // tick (~5 Hz). Symptom: scan-resume timers cancelled mid-countdown,
    // device-info subscription momentarily detached, visible "the app is
    // misbehaving" feel during active scanning. Fix: removed
    // `liveState?.mode` from deps and switched any in-handler reads to
    // `useStore.getState().liveState?.mode`.

    it('the WS-subscribe useEffect deps array does not contain liveState', () => {
      const deps = extractWsEffectDepsArray(APP_SOURCE);
      expect(deps).not.toMatch(/\bliveState\b/);
    });

    it('the WS-subscribe useEffect deps array does not contain any sync.* field', () => {
      // Same hazard class — high-frequency fields don't belong here.
      const deps = extractWsEffectDepsArray(APP_SOURCE);
      expect(deps).not.toMatch(/\bsync\.\w+/);
    });
  });

  describe('memory-sync overlay covers subsequent syncs', () => {
    // History: PR #102 (cad85e3, 2026-05-22) lifted the overlay to cover the
    // entire UI during memory sync. The gating expression was
    // `isInitialSyncing = isMemorySyncing && !sync.hasSyncedInitially`,
    // which meant subsequent syncs (File → Sync Memory) ran 30–45s of
    // PRG/CIN/EPG with no overlay protection. Users could click into
    // Channels/Device during that window and trigger handlers that conflict
    // with the in-progress PRG bracket. Fix: gate the overlay on
    // `isMemorySyncing` directly so any sync blocks the UI.

    it('overlay JSX gates on isMemorySyncing, not isInitialSyncing', () => {
      // The overlay's <motion.div> key uniquely identifies the JSX block.
      const overlayMarker = APP_SOURCE.indexOf("key='memory-sync-overlay'");
      const altMarker = APP_SOURCE.indexOf('key="memory-sync-overlay"');
      const idx = overlayMarker !== -1 ? overlayMarker : altMarker;
      expect(idx, 'memory-sync-overlay JSX must exist').toBeGreaterThan(-1);

      // Walk backwards ~400 chars to find the enclosing `{<expr> && (`.
      const window = APP_SOURCE.slice(Math.max(0, idx - 400), idx);
      expect(window).toMatch(/\{\s*isMemorySyncing\s*&&\s*\(/);
      expect(window).not.toMatch(/\{\s*isInitialSyncing\s*&&\s*\(/);
    });
  });

  describe('handleCancelSync runs the post-sync chain via WS', () => {
    // History: handleCancelSync used to synchronously flip
    // `inProgress: false` after the cancel API returned. The subsequent
    // WS "Sync cancelled" message hit a progress handler that gates the
    // post-sync chain on `currentSync.inProgress`, so the chain
    // (getChannels refresh, requestScanResume, getBanks) silently skipped
    // on every cancel. Scanner stayed in HOLD; user had to manually press
    // Scan. Fix: handleCancelSync only requests cancellation; the WS
    // progress message is what flips inProgress and runs the chain.

    it('handleCancelSync body does not set inProgress: false', () => {
      const body = extractHandleCancelSyncBody(APP_SOURCE);
      // The literal regression: `inProgress: false` inside an updateSync call.
      // We also reject `inProgress: !true` / `inProgress: 1 > 2` etc. via the
      // direct keyword match — this is the historically-reintroduced shape.
      expect(body).not.toMatch(/inProgress\s*:\s*false/);
    });

    it('handleCancelSync body does not set hasSyncedInitially', () => {
      // Pre-flipping hasSyncedInitially in the cancel path also bypasses
      // the WS-driven post-sync chain in subtle ways (it short-circuits the
      // overlay) and was part of the same regression.
      const body = extractHandleCancelSyncBody(APP_SOURCE);
      expect(body).not.toMatch(/hasSyncedInitially\s*:/);
    });
  });
});
