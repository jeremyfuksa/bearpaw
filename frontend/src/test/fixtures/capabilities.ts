import type { ScannerCapabilities } from '../../types';
import manifest from './scanner-capabilities.json';

/**
 * Per-model capability fixtures, derived from the generated manifest.
 *
 * `scanner-capabilities.json` is written by the Rust test
 * `capability_manifest_is_written_for_the_frontend` from the real model
 * allowlist, and that test FAILS when the file is stale. Deriving these from it
 * means a fixture can never disagree with the backend descriptor it stands in
 * for.
 *
 * The hand-written literals these replace had to be edited in three separate
 * files every time a capability was added — four times in one day during the
 * BC75XLT Device tab audit (#469, #471, #475). Each edit was a chance to copy a
 * value wrong, and a wrong fixture makes a test pass while the app is broken.
 *
 * The cast is unavoidable: `resolveJsonModule` infers `number[][]` for
 * `coverage_bands` and `(string | null)[]` for `close_call_bands`, both wider
 * than the interface. `capabilities.contract.test.ts` is what actually holds the
 * manifest to the interface's shape — this file only names two of its entries.
 */
const models = manifest as unknown as Record<string, ScannerCapabilities>;

/** BC125AT family — 500 channels in banks of 50, every feature present. */
export const BC125AT_CAPS: ScannerCapabilities = models.BC125AT;

/** BC75XLT — 300 channels in banks of 30, and the feature flags that differ. */
export const BC75XLT_CAPS: ScannerCapabilities = models.BC75XLT;
