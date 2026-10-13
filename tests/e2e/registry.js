import { chromium } from '@playwright/test';
import config from '../../playwright.config.mjs';
import { login } from './fixtures.js';
import { e2eLog } from './log.js';
import { assertSettled, settleRegistry } from './registryCore.js';

export {
   ALLOWED_DOCUMENT_NAMES,
   E2E_PREFIX,
   E2E_SETTING_KEY_PREFIX,
   assertSettled,
   censusPrefixed,
   recordDocument,
   settleRegistry,
   sweepUnrecorded,
   teardownRecorded,
} from './registryCore.js';

/**
 * Run a settle from a headless browser of its own, for the global setup and the global teardown.
 * @returns {Promise<{ swept: string[], census: string[] }>} The unrecorded documents deleted and the leftovers.
 */
async function settleInOwnBrowser() {
   /** @type {import('@playwright/test').Browser} A headless browser used only for this settle. */
   const browser = await chromium.launch({ headless: true });
   try {
      /** @type {import('@playwright/test').Page} The page that logs in as the GM. */
      const page = await browser.newPage({ baseURL: config.use.baseURL });
      await login(page);
      return await settleRegistry(page);
   } finally {
      await browser.close();
   }
}

/**
 * Global setup step: tear down the documents a crashed earlier run left recorded and sweep the unrecorded ones. A
 * crashed run's leftovers are deleted and reported as a warning, not as a failure of this run.
 * @returns {Promise<void>} Resolves once the world holds no recorded or prefixed e2e document.
 */
export async function restorePendingRegistry() {
   /** @type {{ swept: string[], census: string[] }} What the settle did and found. */
   const { swept, census } = await settleInOwnBrowser();
   if (swept.length > 0) {
      e2eLog(`removed ${swept.length} unrecorded e2e documents left by an earlier run.`);
   }
   if (census.length > 0) {
      assertSettled({
         swept: [],
         census,
      });
   }
}

/**
 * Global teardown step: tear down the documents a spec left recorded, sweep the unrecorded e2e documents and census
 * the world. The run fails when the sweep found anything the running list did not record or the census is not empty.
 * @returns {Promise<void>} Resolves when the world is clean and nothing unrecorded was found.
 * @throws {Error} Listing the unrecorded documents deleted and the leftovers.
 */
export async function finalizeRegistry() {
   assertSettled(await settleInOwnBrowser());
}
