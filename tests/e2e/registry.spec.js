import { test, expect } from '@playwright/test';
import { login } from './fixtures.js';
import {
   E2E_PREFIX,
   assertSettled,
   censusPrefixed,
   recordDocument,
   settleRegistry,
   sweepUnrecorded,
   teardownRecorded,
} from './registry.js';

/** @type {number} The longest wait inside an already-loaded page, in milliseconds. */
const POLL_MS = 1000;

test.describe('e2e document registry safety nets', () => {
   test.beforeEach(async ({ page }) => {
      await login(page);
      await teardownRecorded(page);
   });

   test.afterEach(async ({ page }) => {
      assertSettled(await settleRegistry(page));
   });

   test('sweeps an e2e document that no running list recorded and reports it', async ({ page }) => {
      const name = `${E2E_PREFIX}Unrecorded ${Date.now()}`;
      await page.evaluate((actorName) => Actor.create({
         name: actorName,
         type: game.documentTypes.Actor.find((type) => type !== CONST.BASE_DOCUMENT_TYPE),
      }), name);
      await expect.poll(() => censusPrefixed(page), { timeout: POLL_MS }).toContain(`Actor ${name}`);
      expect(await sweepUnrecorded(page)).toEqual([`Actor ${name}`]);
      expect(await page.evaluate((actorName) => game.actors.some((actor) => actor.name === actorName), name)).toBe(
         false,
      );
      expect(await censusPrefixed(page)).toEqual([]);
   });

   test('refuses to delete a recorded document that is not named with the e2e prefix', async ({ page }) => {
      const name = `Not an e2e name ${Date.now()}`;
      const uuid = await page.evaluate(async (actorName) => {
         const actor = await Actor.create({
            name: actorName,
            type: game.documentTypes.Actor.find((type) => type !== CONST.BASE_DOCUMENT_TYPE),
         });
         return actor.uuid;
      }, name);
      try {
         await recordDocument(page, {
            documentName: 'Actor',
            id: uuid.split('.').pop(),
            uuid,
            createdBy: 'registry.spec',
         });
         await expect(teardownRecorded(page)).rejects.toThrow(/not named with the e2e prefix/);
         expect(await page.evaluate((target) => fromUuid(target).then((actor) => actor !== null), uuid)).toBe(true);
      } finally {
         // The spec made this document itself, so it removes it itself, then lets the teardown clear the record.
         await page.evaluate(async (target) => (await fromUuid(target))?.delete(), uuid);
         await teardownRecorded(page);
      }
   });
});
