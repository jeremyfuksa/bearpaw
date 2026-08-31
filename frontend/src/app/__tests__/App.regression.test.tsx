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
 * The auto-sync effect moved out of App.tsx in #568 so it could be exercised
 * by mounting it (see `useAutoMemorySync.test.tsx`). Its source-level guards
 * are still worth keeping -- they pin the ORDER and SHAPE of the decision,
 * which a behavioural test covers less precisely -- so they read the hook's
 * source rather than App's.
 */
const AUTO_SYNC_PATH = resolve(HERE, '..', '..', 'hooks', 'useAutoMemorySync.ts');
const AUTO_SYNC_SOURCE = readFileSync(AUTO_SYNC_PATH, 'utf8');

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
    //
    // #137 amendment: when the backend replies "no_task" there is no running
    // sync, so no WS message will ever arrive — clearing locally is the ONLY
    // way the overlay comes down. That branch (and only that branch) may set
    // `inProgress: false`.

    /**
     * Removes the `if (result.status === 'no_task') { ... return; }` branch
     * so the remaining body can be checked for the historical unconditional
     * pre-flip.
     */
    function stripNoTaskBranch(body: string): string {
      return body.replace(
        /if\s*\(\s*result\.status\s*===\s*'no_task'\s*\)\s*\{[\s\S]*?return;\s*\}/,
        '',
      );
    }

    it('handleCancelSync does not set inProgress: false outside the no_task branch', () => {
      const body = extractHandleCancelSyncBody(APP_SOURCE);
      // The literal regression: an unconditional `inProgress: false` that
      // races the WS "Sync cancelled" message and skips the post-sync chain.
      expect(stripNoTaskBranch(body)).not.toMatch(/inProgress\s*:\s*false/);
    });

    it('handleCancelSync clears local state when the backend reports no_task', () => {
      // The stuck-overlay half of #137: on no_task no WS message is coming,
      // so the handler itself must drop `inProgress` or the z-50 overlay
      // stays up until a reload.
      const body = extractHandleCancelSyncBody(APP_SOURCE);
      expect(body).toMatch(
        /if\s*\(\s*result\.status\s*===\s*'no_task'\s*\)\s*\{[\s\S]*?inProgress\s*:\s*false[\s\S]*?return;\s*\}/,
      );
    });

    it('handleCancelSync body does not set hasSyncedInitially', () => {
      // Pre-flipping hasSyncedInitially in the cancel path also bypasses
      // the WS-driven post-sync chain in subtle ways (it short-circuits the
      // overlay) and was part of the same regression.
      const body = extractHandleCancelSyncBody(APP_SOURCE);
      expect(body).not.toMatch(/hasSyncedInitially\s*:/);
    });
  });

  describe('sync-status reconnect probe only clears state on reconnects', () => {
    // History (#137): the reconnect reconciliation probe added to fix the
    // stuck-overlay case must NOT run its clear direction on the initial
    // connect. On mount the probe races the auto-start-sync effect — the
    // GET /memory/sync/status snapshot can be served before POST /memory/sync
    // registers the task, and acting on that stale "not syncing" answer
    // drops the blocking overlay while a PRG bracket is open. Adopting a
    // running sync (set inProgress: true) is safe in both cases and stays
    // unconditional.

    it('the clear-direction reconciliation is gated on isReconnect', () => {
      expect(APP_SOURCE).toMatch(
        /if\s*\(\s*isReconnect\s*&&\s*currentSync\.inProgress\s*&&\s*!status\.in_progress\s*\)/,
      );
    });
  });

  describe('import progress is isolated from the sync WS handler', () => {
    // Import progress (task_id "import-csv"/"import-ss") drives the separate
    // importProgress overlay and must NEVER fall through to the
    // regression-guarded memory-sync logic in the same 'progress' handler.
    // The guard is an early `return` in the import branch — without it, import
    // messages would call updateSync and corrupt sync state / the sync overlay.

    it('the progress handler early-returns for import task_ids before any updateSync', () => {
      const start = APP_SOURCE.indexOf("ws.on('progress'");
      expect(start, 'progress handler must exist').toBeGreaterThan(-1);
      // Within the handler, the import branch must appear BEFORE the first
      // updateSync call, and must contain a `return`.
      const handler = APP_SOURCE.slice(start, start + 1600);
      const importIdx = handler.indexOf("task_id?.startsWith('import')");
      const updateSyncIdx = handler.indexOf('updateSync(');
      expect(importIdx, 'import branch must exist in the handler').toBeGreaterThan(-1);
      expect(updateSyncIdx, 'updateSync must exist in the handler').toBeGreaterThan(-1);
      expect(importIdx).toBeLessThan(updateSyncIdx);
      // The import branch returns before the sync logic runs.
      const importBranch = handler.slice(importIdx, updateSyncIdx);
      expect(importBranch).toMatch(/return;/);
    });
  });

  describe('leaving the Device page resumes scan', () => {
    // A Device-page write (unlock, bank/priority edit) parks the scanner in
    // HOLD at ch1 via its PRG/EPG bracket. We resume scanning when the user
    // navigates away from Device — not immediately after the write. Two ways to
    // regress: drop the leavingDevice resume in handleTabChange, or wire the
    // TabBar's onTabChange straight to setCurrentTab (bypassing the handler, so
    // tab-bar clicks never resume). Both are guarded here.

    it('handleTabChange resumes scan when leaving Device', () => {
      const start = APP_SOURCE.indexOf('const handleTabChange = useCallback');
      expect(start, 'handleTabChange must exist').toBeGreaterThan(-1);
      const body = stripComments(APP_SOURCE.slice(start, APP_SOURCE.indexOf('}, [', start)));
      // Must detect the Device -> non-Device transition and request a resume.
      expect(body).toMatch(/currentTab === 'Device'/);
      expect(body).toMatch(/requestScanResume\(/);
    });

    it('TabBar navigation routes through handleTabChange, not setCurrentTab', () => {
      // The tab bar is the primary navigation; if it calls setCurrentTab
      // directly the resume never fires on a tab-bar click.
      expect(APP_SOURCE).toMatch(/<TabBar[^>]*onTabChange=\{handleTabChange\}/);
      expect(APP_SOURCE).not.toMatch(/<TabBar[^>]*onTabChange=\{setCurrentTab\}/);
    });
  });

  describe('cached channels suppress the startup memory sync', () => {
    // History: before #413 every launch paid a blocking 30-45 s
    // PRG/CIN/EPG walk behind a full-screen overlay, because channel memory
    // lived only in RAM. #534/#537/#538 persist it and #540 adopts it back
    // into `shadow.channels` at connect, so the mount-time GET
    // /memory/channels now returns a full list on a warm cache.
    //
    // The ONLY thing that turns that into "no startup sync" is the
    // `channels.length > 0` early return in the auto-sync effect. There is no
    // WS message meaning "channels changed", so nothing else can suppress the
    // sync. Dropping the check -- or dropping `channels.length` from the deps
    // array, which stops the effect re-evaluating when the fetch lands --
    // restores the blocking overlay for every user with a warm cache, with no
    // error and no visible cause.
    //
    // CORRECTED (#576): this used to add "and the connect-edge device_info
    // broadcast never fires (#539)". It does fire -- #551 moved
    // `connection_status = "connected"` out of the port-open path so
    // `transitioned_to_connected` becomes true, and #552 built App's
    // connect-edge channel refetch on it. Acting on the old claim would have
    // read that refetch as dead code and removed it.
    //
    // This is asserted at source level for the reason given at the top of
    // this file: mounting App needs mocks for the WS context, Tauri shell,
    // store, menu bus, API client, toasts and routing.

    /**
     * Body of the auto-sync useEffect, anchored on the unique
     * `startMemorySync` identifier declared inside it.
     */
    function extractAutoSyncEffect(source: string): { body: string; deps: string } {
      const anchor = source.indexOf('const startMemorySync = async () => {');
      if (anchor === -1) throw new Error('Could not locate startMemorySync declaration');
      const effectOpen = source.lastIndexOf('useEffect(() => {', anchor);
      if (effectOpen === -1) throw new Error('Could not locate the auto-sync useEffect');
      const depsOpen = source.indexOf('}, [', anchor);
      if (depsOpen === -1) throw new Error('Could not locate auto-sync deps array open');
      const depsClose = source.indexOf(']);', depsOpen);
      if (depsClose === -1) throw new Error('Could not locate auto-sync deps array close');
      return {
        body: stripComments(source.slice(effectOpen, depsOpen)),
        deps: source.slice(depsOpen + 3, depsClose + 1),
      };
    }

    // Since the `reread_memory_on_connect` preference the early return is
    // CONDITIONAL. Both sides are asserted separately and deliberately: the
    // tempting edit when this first went red was to loosen the assertion to
    // "the body mentions channels.length", which passes for a build where
    // neither path works. That is the vacuous-guard shape this file exists to
    // prevent, and it nearly happened here.
    it('the auto-sync effect still returns early when the preference is OFF', () => {
      const { body } = extractAutoSyncEffect(AUTO_SYNC_SOURCE);
      expect(body).toMatch(
        /if\s*\(\s*!preferences\.rereadMemoryOnConnect\s*&&\s*channels\.length\s*>\s*0\s*\)\s*return\s*;/,
      );
    });

    it('the preference is what makes the early return conditional', () => {
      // Without the negation the effect would sync only when the preference is
      // OFF -- backwards, and green against a test that merely looked for the
      // identifier somewhere in the body.
      const { body } = extractAutoSyncEffect(AUTO_SYNC_SOURCE);
      expect(body).toMatch(/!preferences\.rereadMemoryOnConnect\s*&&/);
    });

    it('the effect waits for stored preferences before deciding', () => {
      // The store holds DEFAULTS until the preferences fetch settles, and
      // `rereadMemoryOnConnect` defaults true. Without this gate the effect
      // reads `true` on every launch and syncs regardless of what the user
      // stored -- turning the preference OFF did nothing.
      //
      // Shipped that way and caught by hardware verification, not by these
      // tests: they set the store synchronously, so nothing here ever
      // exercised the load race. The same hazard is already guarded for
      // `check_updates_on_launch`.
      const { body } = extractAutoSyncEffect(AUTO_SYNC_SOURCE);
      expect(body).toMatch(/if\s*\(\s*!preferencesLoaded\s*\)\s*return\s*;/);
    });

    it('the gate precedes the preference check', () => {
      // Reading the preference before waiting for it is the bug, so ordering
      // is the assertion. A build with both lines in the wrong order passes
      // any test that only checks both are present.
      const { body } = extractAutoSyncEffect(AUTO_SYNC_SOURCE);
      const wait = body.search(/!preferencesLoaded/);
      const use = body.search(/!preferences\.rereadMemoryOnConnect/);
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(use).toBeGreaterThanOrEqual(0);
      expect(wait).toBeLessThan(use);
    });

    it('the effect re-evaluates once preferences have loaded', () => {
      // Without it in the deps the effect never re-runs after the fetch
      // settles, so the early return above would permanently suppress the
      // launch sync for everyone.
      const { deps } = extractAutoSyncEffect(AUTO_SYNC_SOURCE);
      expect(deps).toMatch(/preferencesLoaded/);
    });

    it('the OFF path asks the backend before syncing, not the store', () => {
      // THE bug, and the one the source-level guards above could not catch.
      // The early return is `!rereadMemoryOnConnect && channels.length > 0`.
      // During startup `channels` is [] -- the mount fetch races the poll
      // loop's connect and the connect-edge refetch (#552) has not resolved
      // when this effect re-runs on the same device_info message. So the
      // condition is `true && false`, no early return, and it syncs anyway.
      //
      // Measured on hardware: preference stored OFF, every launch still
      // synced. A trace from the first API response showed in_progress:true
      // with a task_id already assigned.
      //
      // Asking the backend removes the ordering assumption instead of making
      // it likelier to hold.
      const { body } = extractAutoSyncEffect(AUTO_SYNC_SOURCE);
      const guardIdx = body.search(/if\s*\(\s*!preferences\.rereadMemoryOnConnect\s*\)\s*\{/);
      const fetchIdx = body.search(/await\s+api\.getChannels\(\)/);
      const syncIdx = body.search(/await\s+api\.syncMemory\(\)/);
      expect(guardIdx).toBeGreaterThanOrEqual(0);
      expect(fetchIdx).toBeGreaterThan(guardIdx);
      expect(syncIdx).toBeGreaterThan(fetchIdx);
    });

    it('the preference is read at invocation, not tracked as a dependency', () => {
      // REVERSED IN #568, deliberately. This guard used to assert the opposite
      // -- that `preferences.rereadMemoryOnConnect` IS in the deps array -- on
      // the reasoning that "the setting would appear to do nothing until the
      // next connect".
      //
      // That reasoning was backwards. The preference governs what happens when
      // a scanner CONNECTS, so taking effect at the next connect is correct.
      // As a dependency it made the toggle itself drive the hardware: flipping
      // it ON while connected re-ran the effect, cleared the early return, and
      // sent `api.syncMemory()` -- covering the settings page the user was
      // standing on with the full-screen overlay and holding the radio in
      // program mode for the whole walk.
      //
      // The old guard could not catch that: a build with the bug contains the
      // string perfectly. Presence of a string is not use of it.
      //
      // `preferencesLoaded` is what carries a stored value to an
      // already-connected launch, and it is asserted separately above.
      const { body, deps } = extractAutoSyncEffect(AUTO_SYNC_SOURCE);
      expect(deps).not.toMatch(/preferences\.rereadMemoryOnConnect/);
      expect(body).toMatch(/useStore\.getState\(\)\.preferences/);
    });

    it('the auto-sync effect re-evaluates when the channel count changes', () => {
      // Without `channels.length` in deps the effect runs once, before the
      // mount fetch resolves, and syncs anyway -- the check above would be
      // present and useless.
      const { deps } = extractAutoSyncEffect(AUTO_SYNC_SOURCE);
      expect(deps).toMatch(/\bchannels\.length\b/);
    });

    it('the early return precedes the syncMemory call', () => {
      // Ordering matters: a guard placed after `api.syncMemory()` reads as a
      // guard and suppresses nothing.
      const { body } = extractAutoSyncEffect(AUTO_SYNC_SOURCE);
      const guard = body.search(/channels\.length\s*>\s*0\s*\)\s*return\s*;/);
      const call = body.indexOf('api.syncMemory()');
      expect(guard).toBeGreaterThanOrEqual(0);
      expect(call).toBeGreaterThanOrEqual(0);
      expect(guard).toBeLessThan(call);
    });
  });

  describe('channels are refetched when the scanner connects', () => {
    // History: #413 made the backend adopt cached channel memory at connect,
    // but the frontend fetches channels exactly once at mount — and that fetch
    // races the poll loop's connect. Measured on hardware: sometimes the
    // backend won and 500 cached channels rendered instantly; sometimes the
    // frontend won, saw an empty list, and started a full memory sync the
    // cache exists to avoid. Both outcomes were observed on the same machine
    // minutes apart.
    //
    // #551 made the connect edge broadcast at all (it was dead code, #539).
    // This is the other half: on that edge, re-ask for channels. The backend
    // adopts the cache BEFORE broadcasting, so the list is already populated
    // server-side when this arrives.

    /**
     * Body of the `device_info` WS handler, anchored on its unique
     * `ws.on('device_info'` registration.
     */
    function extractDeviceInfoHandler(source: string): string {
      const start = source.indexOf("ws.on('device_info'");
      if (start === -1) throw new Error('Could not locate the device_info subscription');
      const end = source.indexOf("ws.on('progress'", start);
      if (end === -1) throw new Error('Could not locate the end of the device_info handler');
      return stripComments(source.slice(start, end));
    }

    /**
     * The condition of the `if` that guards the channel refetch — not merely
     * the handler text around it.
     *
     * Asserting that the handler CONTAINS `wasConnected` passes for a build
     * where the variable is still declared and the gate ignores it. Measured:
     * replacing the whole condition with `if (true)` left all four guards
     * green until this extractor existed.
     */
    function extractRefetchGate(source: string): string {
      const handler = extractDeviceInfoHandler(source);
      const call = handler.indexOf('.getChannels()');
      if (call === -1) throw new Error('Could not locate the channel refetch');
      const ifStart = handler.lastIndexOf('if (', call);
      if (ifStart === -1) throw new Error('The channel refetch is not inside an if');
      const open = handler.indexOf('(', ifStart);
      let depth = 0;
      for (let i = open; i < call; i += 1) {
        if (handler[i] === '(') depth += 1;
        if (handler[i] === ')') {
          depth -= 1;
          if (depth === 0) return handler.slice(open + 1, i);
        }
      }
      throw new Error('Unbalanced parentheses in the refetch gate');
    }

    it('the device_info handler refetches channels', () => {
      const handler = extractDeviceInfoHandler(APP_SOURCE);
      expect(handler).toMatch(/getChannels\(\)/);
      expect(handler).toMatch(/setChannels\(/);
    });

    it('the refetch is gated on the connected state', () => {
      // An unconditional refetch would fire on the DISCONNECT broadcast too,
      // asking a scanner that just vanished for its channel list.
      expect(extractRefetchGate(APP_SOURCE)).toMatch(/connection_status === 'connected'/);
    });

    it('the refetch is gated on the EDGE, not on every connected message', () => {
      // `broadcast_device_info` only fires on edges today, but a future caller
      // that broadcast every tick would turn an unconditional refetch into a
      // 5 Hz channel fetch against a 500-channel endpoint.
      expect(extractRefetchGate(APP_SOURCE)).toMatch(/wasConnected/);
    });

    it('reads the previous status via getState, not a closed-over value', () => {
      // Closing over `deviceInfo` would require adding it to this effect's
      // deps, which re-registers all four WS subscriptions whenever device
      // info changes — the churn the guard at the top of this file exists to
      // prevent.
      const handler = extractDeviceInfoHandler(APP_SOURCE);
      expect(handler).toMatch(/useStore\.getState\(\)/);

      const deps = extractWsEffectDepsArray(APP_SOURCE);
      expect(deps).not.toMatch(/\bdeviceInfo\b/);
      expect(deps).not.toMatch(/\bchannels\b/);
    });
  });
});
