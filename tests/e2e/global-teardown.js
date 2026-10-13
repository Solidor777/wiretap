import { restorePendingGateRecord } from './gates.js';
import { finalizeRegistry } from './registry.js';

/**
 * Playwright global teardown: restore any gate setting values a spec left recorded as pending, so a failed or
 * interrupted spec cannot leave a risk gate open in the test world, then tear down the documents a spec left recorded,
 * sweep the unrecorded e2e documents and census the world. The run fails when the sweep found anything unrecorded.
 * @returns {Promise<void>} Resolves once no recorded gate value is pending and the world holds no e2e leftover.
 */
export default async function globalTeardown() {
   await restorePendingGateRecord();
   await finalizeRegistry();
}
