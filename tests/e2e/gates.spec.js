import { test, expect } from '@playwright/test';
import { login } from './fixtures.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import {
   readGateSettings,
   readSidecarGateState,
   readSidecarObservation,
   recordGateSettings,
   restoreGateSettings,
} from './gates.js';

/** @type {number} The longest wait inside an already-loaded page, in milliseconds. */
const POLL_MS = 1000;

/** @type {import('node:child_process').ChildProcess | undefined} The e2e gate sidecar of this spec file. */
let sidecar;
test.beforeAll(async () => {
   sidecar = await startGateSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});

/**
 * Wait until this page's bridge endpoint is identified.
 * @param {import('@playwright/test').Page} page - The logged-in GM page.
 * @returns {Promise<void>} Resolves once the sidecar acked the identify.
 */
async function expectIdentified(page) {
   await expect
      .poll(() => page.evaluate(() => game.modules.get('wiretap').api.bridge.identified), { timeout: POLL_MS })
      .toBe(true);
}

test.describe('wiretap risk gates', () => {
   test.beforeEach(async ({ page }) => {
      await login(page);
      // A run that died mid-test left its prior values recorded; restore them before recording new ones.
      await restoreGateSettings(page);
      await recordGateSettings(page);
      await expectIdentified(page);
   });

   test.afterEach(async ({ page }) => {
      await restoreGateSettings(page);
   });

   test('toggling a gate as GM updates the sidecar snapshot, and the setting is restored', async ({ page }) => {
      const prior = await readGateSettings(page);
      expect(prior.allowUserWrites, 'the e2e world must start with the gate closed').toBe(false);
      await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({ allowUserWrites: false });

      await page.evaluate(() => game.settings.set('wiretap', 'allowUserWrites', true));
      await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({ allowUserWrites: true });

      await page.evaluate(() => game.settings.set('wiretap', 'allowedPluginModules', 'wiretap-e2e-mod, Bad Id'));
      await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({
         allowUserWrites: true,
         allowedPluginModules: ['wiretap-e2e-mod'],
      });

      await restoreGateSettings(page);
      await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({
         allowUserWrites: false,
         allowedPluginModules: [],
      });
      expect(await readGateSettings(page)).toEqual(prior);
   });

   test('resetting a gate to its default deletes the Setting document and closes the sidecar snapshot', async ({
      page,
   }) => {
      await page.evaluate(() => game.settings.set('wiretap', 'allowCompendiumWrites', true));
      await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({ allowCompendiumWrites: true });

      // Deleting the world Setting document is how Foundry resets a setting to its registered default.
      await page.evaluate(async () => {
         await game.settings.storage.get('world').getSetting('wiretap.allowCompendiumWrites').delete();
      });
      expect(await page.evaluate(() => game.settings.get('wiretap', 'allowCompendiumWrites'))).toBe(false);
      await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({ allowCompendiumWrites: false });
   });

   test('the identify after a reload carries the stored gate state', async ({ page }) => {
      await page.evaluate(() => game.settings.set('wiretap', 'allowFileUpload', true));
      await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({ allowFileUpload: true });
      /** @type {string[]} The sockets connected before the reload; the old endpoint is among them. */
      const oldSocketIds = (await readSidecarObservation()).socketIds;
      expect(oldSocketIds).toHaveLength(1);

      await page.reload();
      await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60_000 });
      await expectIdentified(page);

      // The old endpoint must be gone, so the snapshot below can only come from the new endpoint's identify; no setting
      // changes after the reload, so no push exists either.
      await expect
         .poll(async () => (await readSidecarObservation()).socketIds, { timeout: POLL_MS })
         .toHaveLength(1);
      const { socketIds, gateState } = await readSidecarObservation();
      expect(socketIds).not.toContain(oldSocketIds[0]);
      expect(gateState.allowFileUpload).toBe(true);
   });
});
