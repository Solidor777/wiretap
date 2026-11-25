/**
 * Page-side enable and restore of the e2e fixture module (`wiretap-e2e-plugin`) in the shared world's module
 * configuration, with a running record so a killed run is restored by the next run's global setup or by the global
 * teardown. The record `test/state/plugin-fixture.json` is gitignored, overwritten and never deleted.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import config from '../../playwright.config.mjs';
import { login } from './fixtures.js';
import { FIXTURE_MODULE_ID } from './pluginFixtureInstall.js';

/** @type {string} The repo root, derived from this file's location. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {string} The running record of the fixture's prior module configuration entry. */
const RECORD_FILE = path.join(repoRoot, 'test', 'state', 'plugin-fixture.json');

/** @type {string} The plugin tool the fixture module registers. */
export const FIXTURE_TOOL_NAME = 'wiretap-e2e-plugin__echo';

/**
 * @typedef {object} FixtureRecord
 * @property {boolean} pending - True while the prior entry still has to be put back.
 * @property {string} world - The id of the world the entry belongs to.
 * @property {boolean | null} prior - The fixture's entry in `core.moduleConfiguration` before the run enabled it;
 * null when the key was absent.
 */

/**
 * Write the running record.
 * @param {FixtureRecord} record - The record to write.
 * @returns {void}
 */
function writeRecord(record) {
   fs.mkdirSync(path.dirname(RECORD_FILE), { recursive: true });
   fs.writeFileSync(RECORD_FILE, JSON.stringify(record, null, 3));
}

/**
 * Record the fixture's current module configuration entry, enable the fixture module the way Foundry's module
 * management does (one `game.settings.set` of `core.moduleConfiguration`, read:
 * `client/applications/sidebar/apps/module-management.mjs:504-507`), then reload so Foundry loads its code.
 * @param {import('@playwright/test').Page} page - The logged-in GM page.
 * @returns {Promise<void>} Resolves once the reloaded world is ready with the fixture module active.
 */
export async function enableFixturePlugin(page) {
   /** @type {{ world: string, prior: boolean | null }} The world id and the fixture's entry before the change. */
   const found = await page.evaluate((id) => {
      /** @type {Record<string, boolean>} The world's module configuration. */
      const current = game.settings.get('core', 'moduleConfiguration');
      return {
         world: game.world.id,
         prior: Object.hasOwn(current, id) ? current[id] : null,
      };
   }, FIXTURE_MODULE_ID);
   writeRecord({
      pending: true,
      world: found.world,
      prior: found.prior,
   });
   await page.evaluate(async (id) => {
      /** @type {Record<string, boolean>} The module configuration with the fixture enabled. */
      const next = {
         ...game.settings.get('core', 'moduleConfiguration'),
         [id]: true,
      };
      await game.settings.set('core', 'moduleConfiguration', next);
   }, FIXTURE_MODULE_ID);
   await page.reload();
   await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60_000 });
}

/**
 * Put the fixture's module configuration entry back as recorded, removing the key when it was absent, and mark the
 * record restored. A no-op unless the record is pending for this world, so it is safe before and after every test.
 * The page keeps the module's code loaded until it reloads.
 * @param {import('@playwright/test').Page} page - The logged-in GM page.
 * @returns {Promise<void>} Resolves once the stored configuration holds the recorded entry.
 */
export async function restoreFixturePlugin(page) {
   if (!fs.existsSync(RECORD_FILE)) {
      return;
   }
   /** @type {FixtureRecord} The parsed running record. */
   const record = JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8'));
   if (!record.pending || record.world !== (await page.evaluate(() => game.world.id))) {
      return;
   }
   await page.evaluate(
      async ({ id, prior }) => {
         /** @type {Record<string, boolean>} The module configuration with the recorded entry. */
         const next = { ...game.settings.get('core', 'moduleConfiguration') };
         if (prior === null) {
            delete next[id];
         } else {
            next[id] = prior;
         }
         await game.settings.set('core', 'moduleConfiguration', next);
      },
      {
         id: FIXTURE_MODULE_ID,
         prior: record.prior,
      },
   );
   writeRecord({
      ...record,
      pending: false,
   });
}

/**
 * Restore a pending fixture record from a headless browser of its own, for the global setup (a killed run) and the
 * global teardown. Launches nothing when no record is pending.
 * @returns {Promise<void>} Resolves once any pending record is restored or found to belong to another world.
 */
export async function restorePendingFixtureRecord() {
   if (!fs.existsSync(RECORD_FILE) || !JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8')).pending) {
      return;
   }
   /** @type {import('@playwright/test').Browser} A headless browser used only for this restore. */
   const browser = await chromium.launch({ headless: true });
   try {
      /** @type {import('@playwright/test').Page} The page that logs in as the GM. */
      const page = await browser.newPage({ baseURL: config.use.baseURL });
      await login(page);
      await restoreFixturePlugin(page);
   } finally {
      await browser.close();
   }
}
