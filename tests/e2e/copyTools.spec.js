import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { readSidecarGateState, recordGateSettings, restoreGateSettings } from './gates.js';
import { e2eLog } from './log.js';
import { createArguments, firstSubtype, idOf } from './writeHelpers.js';
import { E2E_PREFIX, assertSettled, recordDocument, settleRegistry, teardownRecorded } from './registry.js';

/**
 * `create_documents` with `fromUuids` on the live world: world items copied onto an actor, and a world item copied
 * into a world pack and back. What a copy carries is set by `src/bridge/scripts/writeCopy.js`; the two Foundry steps
 * a mock cannot show are checked here: what Foundry stores for the fields a copy leaves out (`ownership`, `folder`,
 * `sort`), and the `_stats.compendiumSource` of a copy made from a pack document.
 */

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {number} The most bytes the ack of a multi-document write may take (`ACK_BATCH_MAX_BYTES`). */
const ACK_BATCH_MAX = 4000;

/** @type {string} The gate that guards writing into a compendium pack. */
const PACK_GATE = 'allowCompendiumWrites';

/** @type {string} The `createdBy` value of every entry this spec records. */
const CREATED_BY = 'copyTools.spec';

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
 * @returns {Promise<{ isError: boolean, text: string, bytes: number }>} Whether the call failed, its text and size.
 */
async function callText(name, args) {
   const result = await client.callTool({
      name,
      arguments: args,
   });
   /** @type {string} The text of the first result item. */
   const text = result.content[0].text;
   return {
      isError: result.isError === true,
      text,
      bytes: new TextEncoder().encode(text).length,
   };
}

/**
 * Call a tool, require success and parse its JSON.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @returns {Promise<any>} The parsed result.
 */
async function callJson(name, args) {
   /** @type {{ isError: boolean, text: string, bytes: number }} The tool reply. */
   const call = await callText(name, args);
   expect(call.isError, `${name}: ${call.text}`).toBe(false);
   return JSON.parse(call.text);
}

/**
 * Require a reply to be a failure with an error code.
 * @param {{ isError: boolean, text: string }} reply - The tool reply.
 * @param {string} code - The expected error code.
 * @returns {void}
 */
function expectRefused(reply, code) {
   expect(reply.isError, reply.text).toBe(true);
   expect(reply.text).toContain(code);
}

/**
 * Record a world document the flows created, so the teardown removes it.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} documentName - The document class.
 * @param {string} uuid - The document uuid.
 * @returns {Promise<void>} Resolves once the record is written.
 */
async function record(page, documentName, uuid) {
   await recordDocument(page, {
      documentName,
      id: idOf(uuid),
      uuid,
      createdBy: CREATED_BY,
   });
}

/**
 * Create one world document through `create_documents` and record it at once.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} documentName - The document class.
 * @param {object} data - The create data; its `name` carries the e2e prefix.
 * @param {object} [extra] - More `create_documents` arguments, such as `idempotencyKey`.
 * @returns {Promise<{ uuid: string, name: string, type: string }>} The ack row of the new document.
 */
async function createRecorded(page, documentName, data, extra = {}) {
   /** @type {Array<{ uuid: string, name: string, type: string }>} The ack rows. */
   const rows = await callJson('create_documents', createArguments(documentName, [data], extra));
   expect(rows).toHaveLength(1);
   await record(page, documentName, rows[0].uuid);
   return rows[0];
}

/**
 * Open a gate on the GM page, and wait until both the page and the sidecar's snapshot hold it open; the spec's
 * afterEach restores it.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} name - The setting key of the gate to open, from the GATES registry.
 * @returns {Promise<void>} Resolves once the gate reads open in the page and in the sidecar.
 */
async function openGate(page, name) {
   await page.evaluate((gate) => game.settings.set('wiretap', gate, true), name);
   await expect.poll(() => page.evaluate((gate) => game.settings.get('wiretap', gate), name), { timeout: POLL_MS })
      .toBe(true);
   await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({ [name]: true });
}

/**
 * Read the stored data of a document in the page.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} uuid - The document uuid.
 * @returns {Promise<Record<string, any> | null>} Its `toObject()` data, or null when no document matches.
 */
async function storedData(page, uuid) {
   return page.evaluate(async (target) => (await fromUuid(target))?.toObject() ?? null, uuid);
}

test.describe('wiretap create_documents fromUuids', () => {
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
            'create_documents',
            'create_pack',
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

   test('copies world items onto a recorded actor with fromUuids', async ({ page }) => {
      /** @type {string} The actor subtype of the live system. */
      const actorType = await firstSubtype(page, 'Actor');
      /** @type {string} The item subtype of the live system. */
      const itemType = await firstSubtype(page, 'Item');
      /** @type {number} The timestamp that makes the names unique. */
      const stamp = Date.now();

      /** @type {{ uuid: string }} The target actor. */
      const actor = await createRecorded(page, 'Actor', {
         name: `${E2E_PREFIX}Copy Actor ${stamp}`,
         type: actorType,
      });
      /** @type {{ uuid: string, name: string }} The first source, which carries an idempotency record. */
      const first = await createRecorded(page, 'Item', {
         name: `${E2E_PREFIX}Copy Source A ${stamp}`,
         type: itemType,
      }, { idempotencyKey: `e2e-copy-${stamp}` });
      /** @type {{ uuid: string, name: string }} The second source. */
      const second = await createRecorded(page, 'Item', {
         name: `${E2E_PREFIX}Copy Source B ${stamp}`,
         type: itemType,
      });
      /** @type {Array<Record<string, any>>} The stored data of both sources before the copy. */
      const sourcesBefore = [
         await storedData(page, first.uuid),
         await storedData(page, second.uuid),
      ];
      expect(sourcesBefore[0].flags.wiretap?.idem, 'the first source must carry an idempotency record').toBeDefined();

      /** @type {{ isError: boolean, text: string, bytes: number }} The copy reply. */
      const copied = await callText('create_documents', {
         documentName: 'Item',
         parentUuid: actor.uuid,
         fromUuids: [
            first.uuid,
            second.uuid,
         ],
      });
      expect(copied.isError, copied.text).toBe(false);
      e2eLog(`two-item copy ack: ${copied.bytes} B`);
      expect(copied.bytes).toBeLessThanOrEqual(ACK_BATCH_MAX);
      /** @type {Array<{ uuid: string, name: string, type: string }>} The ack rows, in fromUuids order. */
      const rows = JSON.parse(copied.text);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.name)).toEqual([
         first.name,
         second.name,
      ]);
      for (const row of rows) {
         expect(row.uuid.startsWith(`${actor.uuid}.Item.`), row.uuid).toBe(true);
      }

      /** @type {{ size: number, copies: Array<{ id: string, flags: object }> }} The actor's items as stored. */
      const onActor = await page.evaluate(async (uuid) => {
         /** @type {Actor} The target actor. */
         const target = await fromUuid(uuid);
         return {
            size: target.items.size,
            copies: target.items.map((item) => ({
               id: item.id,
               flags: item.toObject().flags,
            })),
         };
      }, actor.uuid);
      e2eLog(`embedded copies store ownership ${JSON.stringify(await page.evaluate(
         async (uuid) => (await fromUuid(uuid)).items.map((item) => item.toObject().ownership),
         actor.uuid,
      ))}`);
      expect(onActor.size).toBe(2);
      expect(onActor.copies.map((copy) => copy.id).sort()).toEqual(rows.map((row) => idOf(row.uuid)).sort());
      for (const copy of onActor.copies) {
         expect(copy.id).not.toBe(idOf(first.uuid));
         expect(copy.id).not.toBe(idOf(second.uuid));
         expect(copy.flags.wiretap, `copy ${copy.id} carries flags.wiretap`).toBeUndefined();
      }
      expect([
         await storedData(page, first.uuid),
         await storedData(page, second.uuid),
      ]).toEqual(sourcesBefore);

      // Refusals use well-formed uuids only; none reaches Foundry's create.
      expectRefused(await callText('create_documents', {
         documentName: 'Item',
         parentUuid: actor.uuid,
         data: [JSON.stringify({
            name: `${E2E_PREFIX}Copy Both ${stamp}`,
            type: itemType,
         })],
         fromUuids: [first.uuid],
      }), 'ARGS_INVALID');
      expectRefused(await callText('create_documents', {
         documentName: 'Actor',
         fromUuids: [first.uuid],
      }), 'ARGS_INVALID');
      expect(await callJson('create_documents', {
         documentName: 'Item',
         parentUuid: actor.uuid,
         fromUuids: [first.uuid],
         dryRun: true,
      })).toEqual([
         {
            uuid: null,
            name: first.name,
            type: itemType,
            dryRun: true,
         },
      ]);
      expect(await page.evaluate(async (uuid) => (await fromUuid(uuid)).items.size, actor.uuid)).toBe(2);
   });

   test('copies a world document into a recorded throwaway world pack and back into the world', async ({ page }) => {
      /** @type {string} The item subtype of the live system. */
      const itemType = await firstSubtype(page, 'Item');
      /** @type {number} The timestamp that makes the names unique. */
      const stamp = Date.now();

      await openGate(page, PACK_GATE);
      /** @type {{ id: string }} The ack of the new pack. */
      const pack = await callJson('create_pack', {
         label: `${E2E_PREFIX}Copy ${stamp}`,
         type: 'Item',
      });
      await recordDocument(page, {
         documentName: 'Compendium',
         id: pack.id,
         uuid: `Compendium.${pack.id}`,
         createdBy: CREATED_BY,
      });

      /** @type {{ uuid: string, name: string }} The world source. */
      const source = await createRecorded(page, 'Item', {
         name: `${E2E_PREFIX}Copy Pack Source ${stamp}`,
         type: itemType,
      });

      // Pack documents are removed with the pack, so they are never recorded on their own.
      /** @type {Array<{ uuid: string, name: string, type: string }>} The ack of the pack copy. */
      const intoPack = await callJson('create_documents', {
         documentName: 'Item',
         pack: pack.id,
         fromUuids: [source.uuid],
      });
      expect(intoPack).toHaveLength(1);
      /** @type {string} The uuid of the document inside the pack. */
      const packUuid = intoPack[0].uuid;
      expect(packUuid.startsWith(`Compendium.${pack.id}.Item.`), packUuid).toBe(true);
      expect(await page.evaluate(
         (id) => game.packs.get(id).index.map((entry) => entry.name),
         pack.id,
      )).toEqual([source.name]);

      /** @type {{ uuid: string, name: string }} The world copy of the pack document. */
      const back = (await callJson('create_documents', {
         documentName: 'Item',
         fromUuids: [packUuid],
      }))[0];
      await record(page, 'Item', back.uuid);
      expect(back.uuid).toMatch(/^Item\.[A-Za-z0-9]{16}$/);
      expect(back.name).toBe(source.name);

      /** @type {Record<string, any>} The stored data of the world copy. */
      const stored = await storedData(page, back.uuid);
      /** @type {string} The id of the signed-in GM, who made the copy. */
      const gmId = await page.evaluate(() => game.user.id);
      e2eLog(`world source created from data stores ownership ${JSON.stringify(
         (await storedData(page, source.uuid)).ownership,
      )}, GM user ${gmId}`);
      e2eLog(`world copy of a pack document stores ${JSON.stringify({
         folder: stored.folder,
         sort: stored.sort,
         ownership: stored.ownership,
         compendiumSource: stored._stats.compendiumSource,
      })}`);
      expect(stored._stats.compendiumSource).toBe(packUuid);
      // `folder` is a nullable ForeignDocumentField and `sort` an IntegerSortField with initial 0
      // (`common/data/fields.mjs:3969-3979`). A copy carries no `ownership`, so it stores what a plain GM create with
      // no `ownership` stores: the schema initial `{ default: NONE }` plus the creating user as OWNER, which the
      // server's `_preCreate` adds (`dist/database/backend/server-document.mjs`; NONE is 0, OWNER is 3).
      expect({
         folder: stored.folder,
         sort: stored.sort,
         ownership: stored.ownership,
      }).toEqual({
         folder: null,
         sort: 0,
         ownership: {
            default: 0,
            [gmId]: 3,
         },
      });
   });
});
