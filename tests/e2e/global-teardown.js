import { restorePendingGateRecord } from './gates.js';

/**
 * Playwright global teardown: restore any gate setting values a spec left recorded as pending, so a failed or
 * interrupted spec cannot leave a risk gate open in the test world.
 * @returns {Promise<void>} Resolves once no recorded gate value for this world is pending.
 */
export default async function globalTeardown() {
   await restorePendingGateRecord();
}
