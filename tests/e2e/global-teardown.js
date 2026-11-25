import { restorePendingGateRecord } from './gates.js';
import { restorePendingFixtureRecord } from './pluginFixture.js';
import { finalizeRegistry } from './registry.js';

/**
 * Playwright global teardown: put back the fixture plugin module's entry in the world's module configuration and
 * restore any gate setting values a spec left recorded as pending, so a failed or interrupted spec cannot leave the
 * fixture enabled or a risk gate open in the test world, then tear down the documents a spec left recorded,
 * sweep the unrecorded e2e documents and census the world. The run fails when the sweep found anything unrecorded.
 * @returns {Promise<void>} Resolves once no fixture entry or gate value is pending and the world holds no e2e leftover.
 */
export default async function globalTeardown() {
   await restorePendingFixtureRecord();
   await restorePendingGateRecord();
   await finalizeRegistry();
}
