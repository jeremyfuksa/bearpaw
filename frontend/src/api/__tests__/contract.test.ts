import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ScannerAPIClient } from '../client';

/**
 * API contract test.
 *
 * This file used to assert string literals against regexes of themselves
 * (`expect('/api/v1/health').toMatch(/health$/)`), which passes whether or not
 * the backend routes that path — so it could never catch the drift it was
 * named for.
 *
 * The real check has two halves:
 *
 *  1. The Rust side (`frontend_routes_are_all_routed_and_manifest_is_written`
 *     in `crates/bearpaw-api/src/api/mod.rs`) probes the ACTUAL axum router and
 *     writes every path that resolves to the committed
 *     `src/test/fixtures/api-route-manifest.json`. That test fails if the file
 *     is stale, so the checked-in copy always matches the real router.
 *  2. This file drives the REAL `ScannerAPIClient` with a stubbed `fetch`,
 *     captures the URL each method requests, and asserts that URL is in the
 *     manifest.
 *
 * Neither side hand-maintains a route list, so a renamed or dropped backend
 * route fails here instead of silently 404ing at runtime.
 */

const MANIFEST_PATH = resolve(__dirname, '../../test/fixtures/api-route-manifest.json');
const BASE = '/api/v1';

type ManifestRoute = { method: string; path: string };

let routed: Set<string>;
let manifestPresent = false;

/** `/api/v1/memory/channels/7` -> `/api/v1/memory/channels/{index}` */
function normalize(path: string): string {
  return path
    .replace(/\/\d+\/priority$/, '/{index}/priority')
    .replace(/\/ranges\/\d+$/, '/ranges/{index}')
    .replace(/\/channels\/\d+$/, '/channels/{index}')
    .replace(/\/preferences\/[^/]+$/, '/preferences/{key}');
}

beforeAll(() => {
  manifestPresent = existsSync(MANIFEST_PATH);
  if (!manifestPresent) return;
  const parsed = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8')) as { routes: ManifestRoute[] };
  routed = new Set(parsed.routes.map((r) => `${r.method} ${normalize(r.path)}`));
});

/** Run one client method against a stubbed fetch and return the URL it hit. */
async function capture(fn: (c: ScannerAPIClient) => Promise<unknown>): Promise<{
  method: string;
  path: string;
}> {
  let seen: { method: string; path: string } | null = null;
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    seen = { method: (init?.method ?? 'GET').toUpperCase(), path: url.split('?')[0] };
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const original = globalThis.fetch;
  globalThis.fetch = stub as typeof fetch;
  try {
    await fn(new ScannerAPIClient(BASE)).catch(() => undefined);
  } finally {
    globalThis.fetch = original;
  }
  if (!seen) throw new Error('client method issued no fetch');
  return seen;
}

// Every client method, paired with a call that exercises it. Adding a method
// to ScannerAPIClient without adding it here is caught by the coverage test
// at the bottom.
const CALLS: Array<[string, (c: ScannerAPIClient) => Promise<unknown>]> = [
  ['sendHold', (c) => c.sendHold()],
  ['sendScan', (c) => c.sendScan()],
  ['sendKey', (c) => c.sendKey('H')],
  ['getStatus', (c) => c.getStatus()],
  ['getDeviceInfo', (c) => c.getDeviceInfo()],
  ['getBanks', (c) => c.getBanks()],
  ['setBanks', (c) => c.setBanks([true, ...Array(9).fill(false)])],
  ['getChannels', (c) => c.getChannels()],
  ['getChannel', (c) => c.getChannel(1)],
  ['setChannelPriority', (c) => c.setChannelPriority(1, true)],
  ['startProgramMode', (c) => c.startProgramMode()],
  ['endProgramMode', (c) => c.endProgramMode()],
  ['toggleTemporaryLockout', (c) => c.toggleTemporaryLockout({ channel: 1 })],
  ['togglePermanentLockout', (c) => c.togglePermanentLockout(146.52)],
  ['setVolume', (c) => c.setVolume(8)],
  ['getSquelch', (c) => c.getSquelch()],
  ['setSquelch', (c) => c.setSquelch(5)],
  ['getAllSettings', (c) => c.getAllSettings()],
  ['getBacklight', (c) => c.getBacklight()],
  ['getBatterySettings', (c) => c.getBatterySettings()],
  ['getKeyBeepSettings', (c) => c.getKeyBeepSettings()],
  ['getPrioritySettings', (c) => c.getPrioritySettings()],
  ['getCloseCallSettings', (c) => c.getCloseCallSettings()],
  ['getServiceSearchSettings', (c) => c.getServiceSearchSettings()],
  ['getCustomSearchSettings', (c) => c.getCustomSearchSettings()],
  ['getCustomSearchRange', (c) => c.getCustomSearchRange(1)],
  ['getContrastSettings', (c) => c.getContrastSettings()],
  ['getLockouts', (c) => c.getLockouts()],
  ['clearTemporaryLockouts', (c) => c.clearTemporaryLockouts()],
  ['clearGlobalLockouts', (c) => c.clearGlobalLockouts()],
  ['clearChannelLockouts', (c) => c.clearChannelLockouts()],
  ['syncMemory', (c) => c.syncMemory()],
  ['cancelSync', (c) => c.cancelSync()],
  ['getSyncStatus', (c) => c.getSyncStatus()],
  ['getAllPreferences', (c) => c.getAllPreferences()],
  ['resetPreferences', (c) => c.resetPreferences()],
  ['updateChannel', (c) => c.updateChannel(1, { frequency: 146.52 } as never)],
  ['setBacklight', (c) => c.setBacklight('AO')],
  ['setBatterySettings', (c) => c.setBatterySettings(3)],
  ['setKeyBeepSettings', (c) => c.setKeyBeepSettings(1, false)],
  ['setPrioritySettings', (c) => c.setPrioritySettings(0)],
  ['setSearchSettings', (c) => c.setSearchSettings(2, false)],
  ['setCloseCallSettings', (c) => c.setCloseCallSettings({ mode: 0 } as never)],
  ['setServiceSearchSettings', (c) => c.setServiceSearchSettings(Array(10).fill(false))],
  ['setCustomSearchSettings', (c) => c.setCustomSearchSettings(Array(10).fill(false))],
  ['setCustomSearchRange', (c) => c.setCustomSearchRange(1, 25.0, 28.0)],
  ['setWeatherSettings', (c) => c.setWeatherSettings(false)],
  ['setContrastSettings', (c) => c.setContrastSettings(8)],
  ['exportCsv', (c) => c.exportCsv()],
  ['exportBc125atSs', (c) => c.exportBc125atSs()],
  ['importCsv', (c) => c.importCsv(new File(['idx,freq\n1,146.52'], 'ch.csv'))],
  ['getPreference', (c) => c.getPreference('theme')],
  ['setPreference', (c) => c.setPreference('theme', 'dark')],
  ['setPreferences', (c) => c.setPreferences({ theme: 'dark' })],
];

describe('API contract: every client call hits a real backend route', () => {
  it('the backend route manifest exists', () => {
    expect(
      manifestPresent,
      `Missing ${MANIFEST_PATH}. Generate it with:\n` +
        `  cargo test -p bearpaw-api --lib frontend_routes_are_all_routed`,
    ).toBe(true);
  });

  for (const [name, call] of CALLS) {
    it(`${name} requests a routed path`, async () => {
      if (!manifestPresent) return;
      const { method, path } = await capture(call);
      const key = `${method} ${normalize(path)}`;
      expect(
        routed.has(key),
        `ScannerAPIClient.${name} requests "${key}", which is not routed by the backend.\n` +
          `Routed paths:\n  ${[...routed].sort().join('\n  ')}`,
      ).toBe(true);
    });
  }
});

describe('API contract: coverage', () => {
  it('every ScannerAPIClient method is exercised above', () => {
    const proto = ScannerAPIClient.prototype as unknown as Record<string, unknown>;
    // `private` is erased at runtime, so the class's internal helpers show up
    // on the prototype like any other method. They issue no requests of their
    // own — they're the plumbing the public methods call — so name them here.
    const INTERNAL = new Set(['constructor', 'buildUrl', 'request', 'requestText']);
    const methods = Object.getOwnPropertyNames(proto).filter(
      (n) => !INTERNAL.has(n) && typeof proto[n] === 'function' && !n.startsWith('_'),
    );
    const covered = new Set(CALLS.map(([n]) => n));
    const uncovered = methods.filter((m) => !covered.has(m));
    expect(
      uncovered,
      `These ScannerAPIClient methods are not contract-tested — add them to CALLS:\n  ${uncovered.join('\n  ')}`,
    ).toEqual([]);
  });
});
