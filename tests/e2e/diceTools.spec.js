import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { recordGateSettings, restoreGateSettings } from './gates.js';
import { E2E_PREFIX, assertSettled, recordDocument, settleRegistry, teardownRecorded } from './registry.js';

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {number} The most bytes a `roll` result may take. */
const ROLL_RESULT_MAX_BYTES = 512;

/** @type {number} The most bytes a `draw_table` result may take. */
const DRAW_RESULT_MAX_BYTES = 1000;

/** @type {number} The most bytes a script error may take. */
const ERROR_MAX_BYTES = 512;

/** @type {string} The `createdBy` value of every document this spec records. */
const CREATED_BY = 'diceTools.spec';

/** @type {string} The flavor the page hook gives every chat message a `toChat: true` call creates. */
const MESSAGE_FLAVOR = `${E2E_PREFIX}roll`;

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
 * The number of chat messages the GM client holds.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<number>} The size of `game.messages`.
 */
async function messageCount(page) {
   return page.evaluate(() => game.messages.size);
}

/**
 * Run a `toChat: true` call with two page hooks in place: `preCreateChatMessage` gives each new message the e2e
 * flavor, and `createChatMessage` collects each new message id in a page global. The hooks are removed and every
 * collected message is recorded in `finally`, so a failed call still leaves nothing unrecorded.
 * @param {import('@playwright/test').Page} page - The GM page that runs the tool.
 * @param {() => Promise<{ isError: boolean, text: string }>} call - The tool call.
 * @returns {Promise<{ reply: { isError: boolean, text: string }, messageIds: string[] }>} The reply and the ids of
 * the messages created while the call ran.
 */
async function withChatCapture(page, call) {
   await page.evaluate((flavor) => {
      globalThis.wiretapE2eMessageIds = [];
      globalThis.wiretapE2eChatHooks = {
         pre: Hooks.on('preCreateChatMessage', (message) => {
            message.updateSource({ flavor });
         }),
         created: Hooks.on('createChatMessage', (message) => {
            globalThis.wiretapE2eMessageIds.push(message.id);
         }),
      };
   }, MESSAGE_FLAVOR);
   /** @type {string[]} The ids of the messages created while the call ran. */
   const messageIds = [];
   try {
      /** @type {{ isError: boolean, text: string }} The tool reply. */
      const reply = await call();
      return {
         reply,
         messageIds,
      };
   } finally {
      messageIds.push(
         ...(await page.evaluate(() => {
            Hooks.off('preCreateChatMessage', globalThis.wiretapE2eChatHooks.pre);
            Hooks.off('createChatMessage', globalThis.wiretapE2eChatHooks.created);
            delete globalThis.wiretapE2eChatHooks;
            /** @type {string[]} The collected ids. */
            const ids = globalThis.wiretapE2eMessageIds;
            delete globalThis.wiretapE2eMessageIds;
            return ids;
         })),
      );
      for (const id of messageIds) {
         await recordDocument(page, {
            documentName: 'ChatMessage',
            id,
            uuid: `ChatMessage.${id}`,
            createdBy: CREATED_BY,
         });
      }
   }
}

/**
 * Create a RollTable of three text results, one for each face of its `1d3` formula, without replacement, and record
 * it at once.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<string>} The table uuid.
 */
async function createTable(page) {
   /** @type {string} The created table's id. */
   const id = await page.evaluate(
      async (name) => (await RollTable.create({
         name,
         formula: '1d3',
         replacement: false,
         results: [
            1,
            2,
            3,
         ].map((face) => ({
            type: CONST.TABLE_RESULT_TYPES.TEXT,
            name: `Result ${face}`,
            description: `<p>Text ${face}</p>`,
            range: [
               face,
               face,
            ],
         })),
      })).id,
      `${E2E_PREFIX}Table ${Date.now()}`,
   );
   await recordDocument(page, {
      documentName: 'RollTable',
      id,
      uuid: `RollTable.${id}`,
      createdBy: CREATED_BY,
   });
   return `RollTable.${id}`;
}

/**
 * Whether the table result whose range starts at a total is marked drawn in the world.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} uuid - The table uuid.
 * @param {number} total - The draw total.
 * @returns {Promise<boolean | undefined>} The result's `drawn` flag, or undefined when no result has that range.
 */
async function drawnAt(page, uuid, total) {
   return page.evaluate(
      ({ tableUuid, face }) => fromUuidSync(tableUuid).results.find((result) => result.range[0] === face)?.drawn,
      {
         tableUuid: uuid,
         face: total,
      },
   );
}

test.describe('wiretap dice tools', () => {
   test.beforeEach(async ({ page }) => {
      await login(page);
      // A run that died mid-test left its prior values and documents recorded; restore them before recording new ones.
      await restoreGateSettings(page);
      await teardownRecorded(page);
      await recordGateSettings(page);

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
            'roll',
            'draw_table',
         ]));
   });

   test.afterEach(async ({ page }) => {
      try {
         await client?.close();
         client = undefined;
      } finally {
         // Anything the flows created and did not record is swept and fails the test, as does any leftover.
         const settled = await settleRegistry(page);
         await restoreGateSettings(page);
         assertSettled(settled);
      }
   });

   test('roll returns the total and dice and posts nothing by default', async ({ page }) => {
      /** @type {number} The message count before the roll. */
      const before = await messageCount(page);
      const reply = await callText('roll', { formula: '2d6' });
      expect(reply.isError, reply.text).toBe(false);
      expect(bytesOf(reply.text)).toBeLessThanOrEqual(ROLL_RESULT_MAX_BYTES);
      /** @type {{ total: number, formula: string, dice: Array<[number, number[]]> }} The parsed result. */
      const result = JSON.parse(reply.text);
      expect(result.total).toBeGreaterThanOrEqual(2);
      expect(result.total).toBeLessThanOrEqual(12);
      expect(result.dice).toEqual([
         [
            6,
            [
               expect.any(Number),
               expect.any(Number),
            ],
         ],
      ]);
      /** @type {number[]} The two die results. */
      const faces = result.dice[0][1];
      for (const face of faces) {
         expect(face).toBeGreaterThanOrEqual(1);
         expect(face).toBeLessThanOrEqual(6);
      }
      expect(faces[0] + faces[1]).toBe(result.total);
      expect(await messageCount(page)).toBe(before);
   });

   test('roll with toChat true posts one message, recorded and torn down', async ({ page }) => {
      /** @type {number} The message count before the roll. */
      const before = await messageCount(page);
      const { reply, messageIds } = await withChatCapture(page, () => callText('roll', {
         formula: '2d6',
         toChat: true,
      }));
      expect(reply.isError, reply.text).toBe(false);
      expect(messageIds).toHaveLength(1);
      expect(await messageCount(page)).toBe(before + 1);
      /** @type {{ flavor: string, total: number } | null} The new message's flavor and first roll total. */
      const message = await page.evaluate((id) => {
         /** @type {ChatMessage | undefined} The new message. */
         const created = game.messages.get(id);
         return created
            ? {
               flavor: created.flavor,
               total: created.rolls[0].total,
            }
            : null;
      }, messageIds[0]);
      expect(message).toEqual({
         flavor: MESSAGE_FLAVOR,
         total: JSON.parse(reply.text).total,
      });
   });

   test('a 999d1000 roll stays within 512 bytes and reports cut; 1000d6 is ARGS_INVALID', async () => {
      const large = await callText('roll', { formula: '999d1000' });
      expect(large.isError, large.text).toBe(false);
      expect(bytesOf(large.text)).toBeLessThanOrEqual(ROLL_RESULT_MAX_BYTES);
      /** @type {{ total: number, dice: Array<[number, number[]]>, cut?: true }} The parsed result. */
      const result = JSON.parse(large.text);
      expect(result.cut).toBe(true);
      expect(result.dice[0][0]).toBe(1000);
      expect(result.total).toBeGreaterThanOrEqual(999);
      expect(result.total).toBeLessThanOrEqual(999000);

      const tooMany = await callText('roll', { formula: '1000d6' });
      expect(tooMany.isError).toBe(true);
      expect(tooMany.text).toContain('ARGS_INVALID');
      expect(bytesOf(tooMany.text)).toBeLessThanOrEqual(ERROR_MAX_BYTES);
   });

   test('draw_table draws from a recorded table, marks the result drawn and posts nothing by default', async ({
      page,
   }) => {
      /** @type {string} The uuid of the recorded table. */
      const uuid = await createTable(page);
      /** @type {number} The message count before the draw. */
      const before = await messageCount(page);
      const reply = await callText('draw_table', { uuid });
      expect(reply.isError, reply.text).toBe(false);
      expect(bytesOf(reply.text)).toBeLessThanOrEqual(DRAW_RESULT_MAX_BYTES);
      /** @type {{ total: number, results: Array<{ name: string, text?: string }>, count: number }} The parsed draw. */
      const result = JSON.parse(reply.text);
      expect(result.results).toHaveLength(1);
      expect(result.count).toBe(1);
      expect(result.total).toBeGreaterThanOrEqual(1);
      expect(result.total).toBeLessThanOrEqual(3);
      expect(result.results[0]).toEqual({
         name: `Result ${result.total}`,
         text: `Text ${result.total}`,
      });
      expect(await drawnAt(page, uuid, result.total)).toBe(true);
      expect(await messageCount(page)).toBe(before);
   });

   test('draw_table reports TABLE_EMPTY once every result is drawn', async ({ page }) => {
      /** @type {string} The uuid of the recorded table. */
      const uuid = await createTable(page);
      /** @type {number[]} The totals of the three draws. */
      const totals = [];
      for (let draw = 0; draw < 3; draw++) {
         const reply = await callText('draw_table', { uuid });
         expect(reply.isError, reply.text).toBe(false);
         totals.push(JSON.parse(reply.text).total);
      }
      // Without replacement every draw lands on a result not drawn before.
      expect([...totals].sort()).toEqual([
         1,
         2,
         3,
      ]);

      const empty = await callText('draw_table', { uuid });
      expect(empty.isError).toBe(true);
      expect(empty.text).toContain('TABLE_EMPTY');
      expect(bytesOf(empty.text)).toBeLessThanOrEqual(ERROR_MAX_BYTES);
   });

   test('draw_table with toChat true posts one message, recorded and torn down', async ({ page }) => {
      /** @type {string} The uuid of the recorded table. */
      const uuid = await createTable(page);
      /** @type {number} The message count before the draw. */
      const before = await messageCount(page);
      const { reply, messageIds } = await withChatCapture(page, () => callText('draw_table', {
         uuid,
         toChat: true,
      }));
      expect(reply.isError, reply.text).toBe(false);
      expect(messageIds).toHaveLength(1);
      expect(await messageCount(page)).toBe(before + 1);
      expect(await page.evaluate((id) => game.messages.get(id)?.flavor, messageIds[0])).toBe(MESSAGE_FLAVOR);
      expect(await drawnAt(page, uuid, JSON.parse(reply.text).total)).toBe(true);
   });
});
