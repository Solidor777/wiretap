import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { firstSubtype, idOf } from './writeHelpers.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { recordGateSettings, restoreGateSettings } from './gates.js';
import { E2E_PREFIX, assertSettled, recordDocument, settleRegistry, teardownRecorded } from './registry.js';

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {number} The most bytes an `open_sheet` or `close_sheet` result may take. */
const SHEET_RESULT_MAX_BYTES = 128;

/** @type {number} The most bytes a script error may take. */
const ERROR_MAX_BYTES = 512;

/**
 * Foundry's document ownership levels the spec sets (`CONST.DOCUMENT_OWNERSHIP_LEVELS`, which exists only in the page).
 * @type {{ NONE: number, LIMITED: number, OBSERVER: number }}
 */
const OWNERSHIP = {
   NONE: 0,
   LIMITED: 1,
   OBSERVER: 2,
};

/** @type {string} The `createdBy` value of every document this spec records. */
const CREATED_BY = 'sheetTools.spec';

/** @type {import('node:child_process').ChildProcess | undefined} The e2e sidecar of this spec file. */
let sidecar;
test.beforeAll(async () => {
   sidecar = await startGateSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});

/** @type {Client | undefined} The fake MCP client of the running test. */
let client;

/** @type {import('@playwright/test').BrowserContext | undefined} The browser context the player logs in through. */
let playerContext;

/** @type {import('@playwright/test').Page | undefined} The player's Foundry page. */
let playerPage;

/** @type {{ uuid: string, userId: string, userName: string }} The actor and the player the running test uses. */
let fixture;

/**
 * List the tool names the MCP session offers now.
 * @returns {Promise<string[]>} Tool names in listing order.
 */
async function toolNames() {
   return (await client.listTools()).tools.map((tool) => tool.name);
}

/**
 * Call a tool and return its first text item.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @returns {Promise<{ isError: boolean, text: string }>} Whether the call failed, and its text.
 */
async function callText(name, args) {
   const result = await client.callTool({
      name,
      arguments: args,
   });
   return {
      isError: result.isError === true,
      text: result.content[0].text,
   };
}

/**
 * The raw UTF-8 byte length of a text.
 * @param {string} text - A tool reply's text.
 * @returns {number} Its byte length.
 */
function bytesOf(text) {
   return new TextEncoder().encode(text).length;
}

/**
 * Whether a document's sheet is rendered on a page's client.
 * @param {import('@playwright/test').Page} page - The Foundry page.
 * @param {string} uuid - The document uuid.
 * @returns {Promise<boolean>} True when the sheet is rendered there.
 */
async function sheetRendered(page, uuid) {
   return page.evaluate((target) => fromUuidSync(target)?.sheet?.rendered === true, uuid);
}

/**
 * Create a player user in the live world as the GM and record it at once.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} name - The user name, starting with the e2e prefix.
 * @returns {Promise<string>} The new user's id.
 */
async function createPlayer(page, name) {
   /** @type {string} The created user's id. */
   const id = await page.evaluate(
      async (userName) => (await User.create({
         name: userName,
         role: CONST.USER_ROLES.PLAYER,
      })).id,
      name,
   );
   await recordDocument(page, {
      documentName: 'User',
      id,
      uuid: `User.${id}`,
      createdBy: CREATED_BY,
   });
   return id;
}

/**
 * Set the player's ownership level on the actor as the GM, and wait until the player's client sees it.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {number} level - The ownership level.
 * @returns {Promise<void>} Resolves once the player's client holds the level.
 */
async function setPlayerLevel(page, level) {
   await page.evaluate(
      async ({ uuid, userId, ownership }) => {
         await fromUuidSync(uuid).update({ ownership: { [userId]: ownership } });
      },
      {
         uuid: fixture.uuid,
         userId: fixture.userId,
         ownership: level,
      },
   );
   await expect
      .poll(() => playerPage.evaluate((uuid) => fromUuidSync(uuid)?.getUserLevel(game.user), fixture.uuid), {
         timeout: POLL_MS,
      })
      .toBe(level);
}

/**
 * Send a sheet query from the player's client to the active GM's client.
 * @param {string} queryName - The registered query, `wiretap.openSheet` or `wiretap.closeSheet`.
 * @returns {Promise<unknown>} The GM client's answer.
 */
async function playerQuery(queryName) {
   return playerPage.evaluate(
      ({ name, uuid, timeout }) => game.users.activeGM.query(name, { uuid }, { timeout }),
      {
         name: queryName,
         uuid: fixture.uuid,
         timeout: POLL_MS,
      },
   );
}

test.describe('wiretap sheet tools', () => {
   test.beforeEach(async ({ page, browser }) => {
      await login(page);
      // A run that died mid-test left its prior values and documents recorded; restore them before recording new ones.
      await restoreGateSettings(page);
      await teardownRecorded(page);
      await recordGateSettings(page);

      /** @type {number} The timestamp that makes this test's names unique. */
      const stamp = Date.now();
      /** @type {string} The first concrete Actor subtype of the world's system. */
      const type = await firstSubtype(page, 'Actor');
      /** @type {string} The id of the throwaway actor whose sheet the test opens. */
      const actorId = await page.evaluate(
         async ({ name, actorType }) => (await Actor.create({
            name,
            type: actorType,
         })).id,
         {
            name: `${E2E_PREFIX}Sheet Actor ${stamp}`,
            actorType: type,
         },
      );
      await recordDocument(page, {
         documentName: 'Actor',
         id: actorId,
         uuid: `Actor.${actorId}`,
         createdBy: CREATED_BY,
      });
      /** @type {string} The player's name. */
      const userName = `${E2E_PREFIX}Player ${stamp}`;
      fixture = {
         uuid: `Actor.${actorId}`,
         userId: await createPlayer(page, userName),
         userName,
      };

      playerContext = await browser.newContext();
      playerPage = await playerContext.newPage();
      await login(playerPage, userName);
      await expect
         .poll(() => page.evaluate((id) => game.users.get(id)?.active === true, fixture.userId), { timeout: POLL_MS })
         .toBe(true);

      await expect
         .poll(() => page.evaluate(() => game.modules.get('wiretap').api.bridge.identified), { timeout: POLL_MS })
         .toBe(true);
      // The MCP session opens after the page registered its scripts, as a real client's does.
      client = new Client({
         name: 'wiretap-e2e',
         version: '0.0.0',
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${E2E_MCP_PORT}/mcp`)));
      await expect
         .poll(toolNames, { timeout: POLL_MS })
         .toEqual(expect.arrayContaining([
            'open_sheet',
            'close_sheet',
         ]));
   });

   test.afterEach(async ({ page }) => {
      try {
         await client?.close();
         client = undefined;
      } finally {
         // The player's client closes before the teardown deletes its user.
         await playerContext?.close();
         playerContext = undefined;
         playerPage = undefined;
         // Anything the flows created and did not record is swept and fails the test, as does any leftover.
         const settled = await settleRegistry(page);
         await restoreGateSettings(page);
         assertSettled(settled);
      }
   });

   test('opens the sheet on the GM tab when no userId is given, and close_sheet closes it', async ({ page }) => {
      const opened = await callText('open_sheet', { uuid: fixture.uuid });
      expect(opened.isError, opened.text).toBe(false);
      expect(JSON.parse(opened.text)).toEqual({
         ok: true,
         appId: expect.any(String),
      });
      expect(bytesOf(opened.text)).toBeLessThanOrEqual(SHEET_RESULT_MAX_BYTES);
      await expect.poll(() => sheetRendered(page, fixture.uuid), { timeout: POLL_MS }).toBe(true);

      const closed = await callText('close_sheet', { uuid: fixture.uuid });
      expect(closed.isError, closed.text).toBe(false);
      expect(JSON.parse(closed.text)).toEqual({
         ok: true,
         closed: true,
      });
      await expect.poll(() => sheetRendered(page, fixture.uuid), { timeout: POLL_MS }).toBe(false);
   });

   test('opens the sheet on the player client only once the player has OBSERVER, then closes it there', async ({
      page,
   }) => {
      /** @type {{ uuid: string, userId: string }} The arguments that target the player's client. */
      const onPlayer = {
         uuid: fixture.uuid,
         userId: fixture.userId,
      };

      await setPlayerLevel(page, OWNERSHIP.NONE);
      const none = await callText('open_sheet', onPlayer);
      expect(none.isError).toBe(true);
      expect(none.text).toContain('SHEET_DENIED');
      expect(await sheetRendered(playerPage, fixture.uuid)).toBe(false);

      // LIMITED is Foundry's own sheet threshold; the query asks for more.
      await setPlayerLevel(page, OWNERSHIP.LIMITED);
      const limited = await callText('open_sheet', onPlayer);
      expect(limited.isError).toBe(true);
      expect(limited.text).toContain('SHEET_DENIED');
      expect(await sheetRendered(playerPage, fixture.uuid)).toBe(false);

      await setPlayerLevel(page, OWNERSHIP.OBSERVER);
      const observer = await callText('open_sheet', onPlayer);
      expect(observer.isError, observer.text).toBe(false);
      expect(JSON.parse(observer.text)).toEqual({
         ok: true,
         appId: expect.any(String),
      });
      await expect.poll(() => sheetRendered(playerPage, fixture.uuid), { timeout: POLL_MS }).toBe(true);
      expect(await sheetRendered(page, fixture.uuid)).toBe(false);

      const closed = await callText('close_sheet', onPlayer);
      expect(closed.isError, closed.text).toBe(false);
      expect(JSON.parse(closed.text)).toEqual({
         ok: true,
         closed: true,
      });
      expect(bytesOf(closed.text)).toBeLessThanOrEqual(SHEET_RESULT_MAX_BYTES);
      await expect.poll(() => sheetRendered(playerPage, fixture.uuid), { timeout: POLL_MS }).toBe(false);

      const again = await callText('close_sheet', onPlayer);
      expect(again.isError, again.text).toBe(false);
      expect(JSON.parse(again.text)).toEqual({
         ok: true,
         closed: false,
      });
   });

   test('an offline user gives USER_OFFLINE naming the user, for open_sheet and close_sheet', async ({ page }) => {
      /** @type {string} The name of a player who never logs in. */
      const offlineName = `${E2E_PREFIX}Offline Player ${Date.now()}`;
      /** @type {{ uuid: string, userId: string }} The arguments that target the offline player. */
      const onOffline = {
         uuid: fixture.uuid,
         userId: await createPlayer(page, offlineName),
      };

      for (const name of [
         'open_sheet',
         'close_sheet',
      ]) {
         const call = await callText(name, onOffline);
         expect(call.isError, `${name}: ${call.text}`).toBe(true);
         expect(call.text).toContain('USER_OFFLINE');
         expect(call.text).toContain(offlineName);
         expect(bytesOf(call.text)).toBeLessThanOrEqual(ERROR_MAX_BYTES);
      }
   });

   test('the GM client refuses either query a player sends', async ({ page }) => {
      expect(await playerQuery('wiretap.openSheet')).toMatchObject({
         ok: false,
         code: 'SHEET_DENIED',
      });
      expect(await sheetRendered(page, fixture.uuid)).toBe(false);

      const opened = await callText('open_sheet', { uuid: fixture.uuid });
      expect(opened.isError, opened.text).toBe(false);
      await expect.poll(() => sheetRendered(page, fixture.uuid), { timeout: POLL_MS }).toBe(true);

      expect(await playerQuery('wiretap.closeSheet')).toMatchObject({
         ok: false,
         code: 'SHEET_DENIED',
      });
      expect(await sheetRendered(page, fixture.uuid)).toBe(true);
   });
});
