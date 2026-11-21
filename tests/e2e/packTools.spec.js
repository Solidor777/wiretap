import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { readSidecarGateState, recordGateSettings, restoreGateSettings } from './gates.js';
import { E2E_PREFIX, assertSettled, recordDocument, settleRegistry, teardownRecorded } from './registry.js';

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {number} The most bytes a pack tool result may take (`ACK_MAX_BYTES`). */
const ACK_MAX_BYTES = 256;

/** @type {string} The gate that guards creating a world pack. */
const CREATE_GATE = 'allowCompendiumWrites';

/** @type {string} The gate that guards deleting a world pack. */
const DELETE_GATE = 'allowPackDeletion';

/** @type {string} The document type every pack this spec creates holds; it needs no system data. */
const PACK_TYPE = 'JournalEntry';

/** @type {string} The `createdBy` value of every pack this spec records. */
const CREATED_BY = 'packTools.spec';

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
 * Call a tool, require success and parse its JSON.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @returns {Promise<any>} The parsed result.
 */
async function callJson(name, args) {
   /** @type {{ isError: boolean, text: string }} The tool reply. */
   const call = await callText(name, args);
   expect(call.isError, `${name}: ${call.text}`).toBe(false);
   return JSON.parse(call.text);
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
 * Require a gate to be closed on the GM page, which the closed-gate tests depend on.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} name - The setting key of the gate that must be closed, from the GATES registry.
 * @returns {Promise<void>} Resolves once the check passed.
 */
async function expectGateClosed(page, name) {
   expect(await page.evaluate((gate) => game.settings.get('wiretap', gate), name), `${name} must start closed`)
      .toBe(false);
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
 * Require a reply to be a gate refusal naming a gate.
 * @param {{ isError: boolean, text: string }} reply - The tool reply.
 * @param {string} name - The gate the refusal must name.
 * @returns {void}
 */
function expectGateDenied(reply, name) {
   expectRefused(reply, 'GATE_DENIED');
   expect(reply.text).toContain(name);
}

/**
 * Whether the world has a pack with an id.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} id - The pack collection id, `world.<name>`.
 * @returns {Promise<boolean>} True while `game.packs` holds the id.
 */
async function hasPack(page, id) {
   return page.evaluate((packId) => game.packs.has(packId), id);
}

/**
 * Create a `JournalEntry` world pack through `create_pack` and record it at once, so the teardown removes it. The
 * caller has opened `allowCompendiumWrites`.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<{ id: string, label: string, type: string, text: string }>} The parsed ack and its raw text.
 */
async function createPack(page) {
   /** @type {string} The pack title, which carries the e2e prefix the teardown checks. */
   const label = `${E2E_PREFIX}Pack ${Date.now()}`;
   /** @type {{ isError: boolean, text: string }} The `create_pack` reply. */
   const call = await callText('create_pack', {
      label,
      type: PACK_TYPE,
   });
   expect(call.isError, `create_pack: ${call.text}`).toBe(false);
   /** @type {{ id: string, label: string, type: string }} The ack of the new pack. */
   const ack = JSON.parse(call.text);
   await recordDocument(page, {
      documentName: 'Compendium',
      id: ack.id,
      uuid: `Compendium.${ack.id}`,
      createdBy: CREATED_BY,
   });
   return {
      ...ack,
      text: call.text,
   };
}

/**
 * Install a page-side counter on `ui.notifications.error`, which counts the error notifications the GM screen shows.
 * The original method still runs. `removeErrorSpy` restores it.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<void>} Resolves once the counter is installed.
 */
async function installErrorSpy(page) {
   await page.evaluate(() => {
      /** @type {Function} The method the counter wraps. */
      const original = ui.notifications.error;
      globalThis.wiretapE2eErrorSpy = {
         calls: 0,
         original,
         own: Object.hasOwn(ui.notifications, 'error'),
      };
      ui.notifications.error = function countedError(...args) {
         globalThis.wiretapE2eErrorSpy.calls += 1;
         return original.apply(this, args);
      };
   });
}

/**
 * Read how many error notifications the GM screen showed since `installErrorSpy`.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<number>} The count.
 */
async function errorSpyCalls(page) {
   return page.evaluate(() => globalThis.wiretapE2eErrorSpy.calls);
}

/**
 * Remove the counter of `installErrorSpy`, restoring `ui.notifications.error` as it was. Does nothing when no counter
 * is installed.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<void>} Resolves once the method is restored.
 */
async function removeErrorSpy(page) {
   await page.evaluate(() => {
      /** @type {{ original: Function, own: boolean } | undefined} The installed counter. */
      const spy = globalThis.wiretapE2eErrorSpy;
      if (spy === undefined) {
         return;
      }
      // A method read from the prototype is restored by removing the own property the counter added.
      if (spy.own) {
         ui.notifications.error = spy.original;
      } else {
         delete ui.notifications.error;
      }
      delete globalThis.wiretapE2eErrorSpy;
   });
}

test.describe('wiretap pack tools', () => {
   test.beforeEach(async ({ page }) => {
      await login(page);
      // A run that died mid-test left its prior values and packs recorded; restore them before recording new ones.
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
            'create_pack',
            'delete_pack',
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

   test('lists create_pack and delete_pack, and only delete_pack carries the user-interaction meta', async () => {
      /** @type {Array<{ name: string, _meta?: object }>} The listed tools. */
      const tools = (await client.listTools()).tools;
      /** @type {{ name: string, _meta?: object } | undefined} The listed `create_pack`. */
      const createTool = tools.find((tool) => tool.name === 'create_pack');
      /** @type {{ name: string, _meta?: object } | undefined} The listed `delete_pack`. */
      const deleteTool = tools.find((tool) => tool.name === 'delete_pack');
      expect(createTool).toBeDefined();
      expect(deleteTool).toBeDefined();
      expect(deleteTool._meta).toEqual({ 'anthropic/requiresUserInteraction': true });
      expect(createTool._meta).toBeUndefined();
   });

   test('a create_pack dry run with the gate closed returns the id and creates no pack', async ({ page }) => {
      await expectGateClosed(page, CREATE_GATE);
      /** @type {number} The timestamp that makes the label unique. */
      const stamp = Date.now();
      /** @type {string} The pack title of the preview. */
      const label = `${E2E_PREFIX}Pack ${stamp}`;
      /** @type {string} The id a real run would give the pack: the strict slug of the label. */
      const id = `world.wiretap-e2e-pack-${stamp}`;
      expect(await callJson('create_pack', {
         label,
         type: PACK_TYPE,
         dryRun: true,
      })).toEqual({
         dryRun: true,
         id,
         label,
         type: PACK_TYPE,
      });
      expect(await hasPack(page, id)).toBe(false);
   });

   test('create_pack is denied while allowCompendiumWrites is closed and creates nothing', async ({ page }) => {
      await expectGateClosed(page, CREATE_GATE);
      /** @type {number} The timestamp that makes the label unique. */
      const stamp = Date.now();
      expectGateDenied(await callText('create_pack', {
         label: `${E2E_PREFIX}Pack ${stamp}`,
         type: PACK_TYPE,
      }), CREATE_GATE);
      expect(await hasPack(page, `world.wiretap-e2e-pack-${stamp}`)).toBe(false);
   });

   test('create_pack creates the world pack, and refusals before Foundry raise no GM-screen error', async ({
      page,
   }) => {
      await expectGateClosed(page, CREATE_GATE);
      await installErrorSpy(page);
      try {
         /** @type {object[]} Malformed dry runs, sent while the gate is closed so none could create a pack. */
         const malformed = [
            {
               label: `${E2E_PREFIX}Pack reserved`,
               type: PACK_TYPE,
               name: 'con',
               dryRun: true,
            },
            {
               label: `${E2E_PREFIX}Pack bad type`,
               type: 'Wall',
               dryRun: true,
            },
            {
               label: `${E2E_PREFIX}Pack bad name`,
               type: PACK_TYPE,
               name: 'a b',
               dryRun: true,
            },
         ];
         for (const args of malformed) {
            expectRefused(await callText('create_pack', args), 'ARGS_INVALID');
         }

         await openGate(page, CREATE_GATE);
         /** @type {{ id: string, label: string, type: string, text: string }} The created pack's ack. */
         const created = await createPack(page);
         expect(created.type).toBe(PACK_TYPE);
         expect(created.id).toMatch(/^world\.wiretap-e2e-pack-\d+$/);
         expect(created.label.startsWith(`${E2E_PREFIX}Pack `)).toBe(true);
         expect(Object.keys(JSON.parse(created.text)).sort()).toEqual([
            'id',
            'label',
            'type',
         ]);
         expect(bytesOf(created.text)).toBeLessThanOrEqual(ACK_MAX_BYTES);
         expect(await page.evaluate((id) => game.packs.get(id)?.metadata.packageType, created.id)).toBe('world');

         // The same-label collision needs the created pack, so this dry run follows the create.
         expectRefused(await callText('create_pack', {
            label: created.label,
            type: PACK_TYPE,
            dryRun: true,
         }), 'ARGS_INVALID');
         expect(await errorSpyCalls(page)).toBe(0);
      } finally {
         await removeErrorSpy(page);
      }
   });

   test('a delete_pack dry run lists the pack and its document count and deletes nothing', async ({ page }) => {
      await openGate(page, CREATE_GATE);
      await expectGateClosed(page, DELETE_GATE);
      /** @type {{ id: string, label: string, type: string, text: string }} The created pack's ack. */
      const created = await createPack(page);
      await page.evaluate(
         ({ name, pack }) => JournalEntry.implementation.create({ name }, { pack }),
         {
            name: `${E2E_PREFIX}Pack Entry`,
            pack: created.id,
         },
      );
      expect(await callJson('delete_pack', {
         id: created.id,
         dryRun: true,
      })).toEqual({
         dryRun: true,
         id: created.id,
         label: created.label,
         type: PACK_TYPE,
         documents: 1,
      });
      expect(await hasPack(page, created.id)).toBe(true);
   });

   test('delete_pack is denied while allowPackDeletion is closed, refuses what it must, then deletes', async ({
      page,
   }) => {
      await openGate(page, CREATE_GATE);
      await expectGateClosed(page, DELETE_GATE);
      /** @type {{ id: string, label: string, type: string, text: string }} The created pack's ack. */
      const created = await createPack(page);

      expectGateDenied(await callText('delete_pack', { id: created.id }), DELETE_GATE);
      expect(await hasPack(page, created.id)).toBe(true);

      // The system-pack and missing-pack dry runs are sent while the gate is closed, so neither could delete a pack.
      /** @type {string | undefined} The id of a system pack, which is only ever named in a dry run. */
      const systemPackId = await page.evaluate(
         () => game.packs.find((pack) => pack.metadata.packageType === 'system')?.collection,
      );
      expect(systemPackId, 'the world must have a system pack').toBeDefined();
      expectRefused(await callText('delete_pack', {
         id: systemPackId,
         dryRun: true,
      }), 'ARGS_INVALID');
      expectRefused(await callText('delete_pack', {
         id: 'world.no-such-pack',
         dryRun: true,
      }), 'PACK_NOT_FOUND');

      await openGate(page, DELETE_GATE);
      await installErrorSpy(page);
      try {
         await page.evaluate((id) => game.packs.get(id).configure({ locked: true }), created.id);
         await expect.poll(() => page.evaluate((id) => game.packs.get(id).locked, created.id), { timeout: POLL_MS })
            .toBe(true);
         expectRefused(await callText('delete_pack', { id: created.id }), 'PACK_LOCKED');
         expect(await hasPack(page, created.id)).toBe(true);
         expect(await errorSpyCalls(page)).toBe(0);
      } finally {
         await removeErrorSpy(page);
      }

      await page.evaluate((id) => game.packs.get(id).configure({ locked: false }), created.id);
      await expect.poll(() => page.evaluate((id) => game.packs.get(id).locked, created.id), { timeout: POLL_MS })
         .toBe(false);
      /** @type {{ isError: boolean, text: string }} The reply of the real deletion. */
      const deleted = await callText('delete_pack', { id: created.id });
      expect(deleted.isError, deleted.text).toBe(false);
      expect(JSON.parse(deleted.text)).toEqual({
         id: created.id,
         deleted: true,
      });
      expect(bytesOf(deleted.text)).toBeLessThanOrEqual(ACK_MAX_BYTES);
      await expect.poll(() => hasPack(page, created.id), { timeout: POLL_MS }).toBe(false);
   });
});
