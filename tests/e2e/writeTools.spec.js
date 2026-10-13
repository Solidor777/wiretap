import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { recordGateSettings, restoreGateSettings } from './gates.js';
import { createArguments, firstSubtype, idOf, patch } from './writeHelpers.js';
import {
   E2E_PREFIX,
   E2E_SETTING_KEY_PREFIX,
   assertSettled,
   recordDocument,
   settleRegistry,
   teardownRecorded,
} from './registry.js';

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {number} The most bytes one error text may take. */
const ERROR_MAX = 512;

/** @type {number} The most bytes the ack of one document may take. */
const ACK_MAX = 256;

/** @type {number} The most bytes the ack of a 50-document write may take. */
const ACK_BATCH_MAX = 4000;

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
   const call = await callText(name, args);
   expect(call.isError, `${name}: ${call.text}`).toBe(false);
   return JSON.parse(call.text);
}

/**
 * Record a world document the flows created, so the teardown removes it.
 * @param {import('@playwright/test').Page} page - The Foundry page.
 * @param {string} documentName - The document class.
 * @param {string} uuid - The document uuid.
 * @returns {Promise<void>} Resolves once the record is written.
 */
async function record(page, documentName, uuid) {
   await recordDocument(page, {
      documentName,
      id: idOf(uuid),
      uuid,
      createdBy: 'writeTools.spec',
   });
}

/**
 * Open a gate on the GM page; the spec's afterEach restores every gate.
 * @param {import('@playwright/test').Page} page - The Foundry page.
 * @param {string} gate - The gate setting name.
 * @returns {Promise<void>} Resolves once the setting reads open in the page.
 */
async function openGate(page, gate) {
   await page.evaluate((name) => game.settings.set('wiretap', name, true), gate);
   await expect.poll(() => page.evaluate((name) => game.settings.get('wiretap', name), gate), { timeout: POLL_MS })
      .toBe(true);
}

test.describe('wiretap core write tools', () => {
   test.beforeEach(async ({ page }) => {
      await login(page);
      // A run that died mid-test left its prior values and documents recorded; restore them before recording new ones.
      await restoreGateSettings(page);
      await teardownRecorded(page);
      await recordGateSettings(page);
      await expect
         .poll(() => page.evaluate(() => game.modules.get('wiretap').api.bridge.identified), { timeout: POLL_MS })
         .toBe(true);
      client = new Client({
         name: 'wiretap-e2e',
         version: '0.0.0',
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${E2E_MCP_PORT}/mcp`)));
      await expect.poll(toolNames, { timeout: POLL_MS }).toEqual(
         expect.arrayContaining([
            'create_documents',
            'delete_documents',
            'update_documents',
         ]),
      );
   });

   test.afterEach(async ({ page }) => {
      await client?.close();
      client = undefined;
      // Anything the flows created and did not record is swept and fails the test, as does any leftover.
      const settled = await settleRegistry(page);
      await restoreGateSettings(page);
      assertSettled(settled);
   });

   test('creates an actor with an item and an effect, updates an embedded path, previews and deletes', async ({
      page,
   }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const itemType = await firstSubtype(page, 'Item');
      const effectType = await firstSubtype(page, 'ActiveEffect');
      const name = `${E2E_PREFIX}Write ${Date.now()}`;
      const before = await page.evaluate(() => game.actors.size);

      // A dry run validates and writes nothing.
      const preview = await callJson(
         'create_documents',
         createArguments('Actor', [{
            name,
            type: actorType
         }], { dryRun: true }),
      );
      expect(preview).toEqual([
         {
            uuid: null,
            name,
            type: actorType,
            dryRun: true,
         },
      ]);
      expect(await page.evaluate(() => game.actors.size)).toBe(before);

      // The real create runs through Actor.createDocuments, so the system pre-create logic ran.
      const created = await callJson('create_documents', createArguments('Actor', [{
         name,
         type: actorType
      }]));
      expect(created).toHaveLength(1);
      const actorUuid = created[0].uuid;
      await record(page, 'Actor', actorUuid);
      expect(created[0]).toEqual({
         uuid: expect.stringMatching(/^Actor\.[A-Za-z0-9]{16}$/),
         name,
         type: actorType,
      });
      expect(new TextEncoder().encode(JSON.stringify(created[0])).length).toBeLessThanOrEqual(ACK_MAX);
      expect(await page.evaluate(() => game.actors.size)).toBe(before + 1);

      // Embedded documents are created under the parent.
      const [item] = await callJson(
         'create_documents',
         createArguments('Item', [{
            name: `${E2E_PREFIX}Item`,
            type: itemType
         }], { parentUuid: actorUuid }),
      );
      expect(item.uuid).toMatch(new RegExp(`^${actorUuid}\\.Item\\.[A-Za-z0-9]{16}$`));
      const [effect] = await callJson(
         'create_documents',
         createArguments(
            'ActiveEffect',
            [
               {
                  name: `${E2E_PREFIX}Effect`,
                  type: effectType,
               },
            ],
            { parentUuid: actorUuid },
         ),
      );
      expect(effect.uuid).toMatch(new RegExp(`^${actorUuid}\\.ActiveEffect\\.[A-Za-z0-9]{16}$`));
      expect(
         await page.evaluate(
            (uuid) => fromUuid(uuid).then((actor) => [actor.items.size, actor.effects.size]),
            actorUuid,
         ),
      ).toEqual([1, 1]);

      // An embedded path is grouped into updateEmbeddedDocuments of the parent; a read-back rides on the ack.
      const itemId = idOf(item.uuid);
      const renamed = `${E2E_PREFIX}Item renamed`;
      const [updated] = await callJson('update_documents', {
         updates: [patch(actorUuid, `items.${itemId}.name`, renamed)],
         paths: [`items.${itemId}.name`],
      });
      expect(updated.uuid).toBe(actorUuid);
      expect(updated.changed).toEqual([`items.${itemId}.name`]);
      expect(updated.values).toEqual({ [`items.${itemId}.name`]: renamed });
      expect(
         await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), item.uuid),
      ).toBe(renamed);

      // op set / delete on a flag: set merges a value in, delete removes the field with Foundry's _del operator.
      const flagPath = `items.${itemId}.flags.wiretapE2e.marker`;
      await callJson('update_documents', { updates: [patch(actorUuid, flagPath, 'MOCK_VALUE', 'set')] });
      expect(
         await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.flags.wiretapE2e?.marker ?? null), item.uuid),
      ).toBe('MOCK_VALUE');
      await callJson('update_documents', { updates: [patch(actorUuid, flagPath, undefined, 'delete')] });
      expect(
         await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.flags.wiretapE2e?.marker ?? null), item.uuid),
      ).toBeNull();

      // op replace swaps a whole object instead of merging into it.
      await callJson('update_documents', {
         updates: [patch(item.uuid, 'flags.wiretapE2e', {
            a: 1,
            b: 2
         }, 'set')]
      });
      await callJson('update_documents', { updates: [patch(item.uuid, 'flags.wiretapE2e', { c: 3 }, 'replace')] });
      expect(
         await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.flags.wiretapE2e), item.uuid),
      ).toEqual({ c: 3 });

      // A dry run of an update changes nothing.
      const dry = await callJson('update_documents', {
         updates: [patch(actorUuid, 'name', `${E2E_PREFIX}never`)],
         dryRun: true,
      });
      expect(dry).toEqual([
         {
            uuid: actorUuid,
            changed: ['name'],
            dryRun: true,
         },
      ]);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), actorUuid)).toBe(name);

      // A value Foundry refuses is reported as VALIDATION_FAILED and nothing is written.
      const invalid = await callText('update_documents', { updates: [patch(actorUuid, 'name', '')] });
      expect(invalid.isError).toBe(true);
      expect(invalid.text).toContain('VALIDATION_FAILED');
      expect(invalid.bytes).toBeLessThanOrEqual(ERROR_MAX);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), actorUuid)).toBe(name);

      // The delete preview lists the cascade and deletes nothing.
      const cascade = await callJson('delete_documents', {
         uuids: [actorUuid],
         dryRun: true,
      });
      expect(cascade.dryRun).toBe(true);
      expect(cascade.total).toBe(3);
      expect(cascade.rows.map((row) => row[0])).toEqual([actorUuid, item.uuid, effect.uuid]);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live !== null), actorUuid)).toBe(true);

      // The real delete removes the actor and its embedded documents.
      const deleted = await callJson('delete_documents', { uuids: [actorUuid] });
      expect(deleted).toEqual([
         {
            uuid: actorUuid,
            name,
            type: actorType,
         },
      ]);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live), actorUuid)).toBeNull();
      expect(await page.evaluate(() => game.actors.size)).toBe(before);
   });

   test('returns the failures of 30 invalid documents in one error of at most 512 bytes', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const before = await page.evaluate(() => game.actors.size);
      // An empty name is refused by the schema twice per document (name and prototypeToken.name): 60 failures in all.
      const call = await callText(
         'create_documents',
         createArguments('Actor', Array.from({ length: 30 }, () => ({
            name: '',
            type: actorType
         }))),
      );
      expect(call.isError).toBe(true);
      expect(call.text).toContain('VALIDATION_FAILED');
      expect(call.text).toContain('(+50 more)');
      expect(call.bytes).toBeLessThanOrEqual(ERROR_MAX);
      expect(await page.evaluate(() => game.actors.size)).toBe(before);
   });

   test('acks 50 created and 50 deleted documents within 4,000 bytes', async ({ page }) => {
      const itemType = await firstSubtype(page, 'Item');
      const stamp = Date.now();
      const created = await callJson(
         'create_documents',
         createArguments(
            'Item',
            Array.from({ length: 50 }, (_, index) => ({
               name: `${E2E_PREFIX}Bulk ${stamp} ${index}`,
               type: itemType
            })),
         ),
      );
      for (const row of created) {
         await record(page, 'Item', row.uuid);
      }
      expect(created).toHaveLength(50);
      expect(new TextEncoder().encode(JSON.stringify(created)).length).toBeLessThanOrEqual(ACK_BATCH_MAX);
      const deleted = await callJson('delete_documents', { uuids: created.map((row) => row.uuid) });
      expect(deleted).toHaveLength(50);
      expect(new TextEncoder().encode(JSON.stringify(deleted)).length).toBeLessThanOrEqual(ACK_BATCH_MAX);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live), created[0].uuid)).toBeNull();
   });

   test('denies User and Setting writes while their gates are closed and writes nothing', async ({ page }) => {
      const userName = `${E2E_PREFIX}User ${Date.now()}`;
      const userCount = await page.evaluate(() => game.users.size);
      const user = await callText('create_documents', createArguments('User', [{
         name: userName,
         role: 0
      }]));
      expect(user.isError).toBe(true);
      expect(user.text).toContain('GATE_DENIED');
      expect(user.text).toContain('allowUserWrites');
      expect(await page.evaluate(() => game.users.size)).toBe(userCount);

      const key = `${E2E_SETTING_KEY_PREFIX}closed`;
      const setting = await callText('create_documents', createArguments('Setting', [{
         key,
         value: '"1"'
      }]));
      expect(setting.isError).toBe(true);
      expect(setting.text).toContain('allowSettingWrites');
      expect(
         await page.evaluate((name) => game.settings.storage.get('world').getSetting(name) ?? null, key),
      ).toBeNull();
   });

   test('refuses a password on a throwaway User, and creates and deletes it without one', async ({ page }) => {
      await openGate(page, 'allowUserWrites');
      const userCount = await page.evaluate(() => game.users.size);
      const refused = await callText(
         'create_documents',
         createArguments('User', [{
            name: `${E2E_PREFIX}User ${Date.now()}`,
            role: 0,
            password: 'MOCK_secret'
         }]),
      );
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('GATE_DENIED');
      expect(refused.text).toContain('password');
      expect(await page.evaluate(() => game.users.size)).toBe(userCount);

      // The throwaway user is the only target of every credential write; nothing here aims at a real user.
      const [row] = await callJson(
         'create_documents',
         createArguments('User', [{
            name: `${E2E_PREFIX}User ${Date.now()}`,
            role: 0
         }]),
      );
      await record(page, 'User', row.uuid);
      for (const path of [
         'password',
         'passwordSalt',
         'flags.x.password',
      ]) {
         const update = await callText('update_documents', { updates: [patch(row.uuid, path, 'MOCK_secret')] });
         expect(update.isError, path).toBe(true);
         expect(update.text, path).toContain('password');
      }
      const nested = await callText('update_documents', {
         updates: [patch(row.uuid, 'flags.x', { 'a.hashedPassword': 'MOCK_secret' })],
      });
      expect(nested.isError).toBe(true);
      expect(nested.text).toContain('password');
      const removed = await callJson('delete_documents', { uuids: [row.uuid] });
      expect(removed).toHaveLength(1);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live), row.uuid)).toBeNull();
      expect(await page.evaluate(() => game.users.size)).toBe(userCount);
   });

   test('refuses wiretap setting keys with the gate open, whatever namespace the data carries', async ({ page }) => {
      await openGate(page, 'allowSettingWrites');
      /** @type {string} A key in the wiretap namespace that no setting registers, so a regression cannot hurt. */
      const probeKey = 'wiretap.e2eNamespaceProbe';
      /**
       * Tell whether a Setting document with the probe key exists.
       * @returns {Promise<boolean>} True when the world holds one.
       */
      const probeExists = () =>
         page.evaluate(
            (name) => game.settings.storage.get('world').getSetting(name) !== undefined,
            probeKey,
         );
      try {
         for (const data of [
            {
               key: probeKey,
               value: '"1"'
            },
            {
               key: probeKey,
               namespace: 'zzz',
               value: '"1"'
            },
         ]) {
            const created = await callText('create_documents', createArguments('Setting', [data]));
            expect(created.isError, JSON.stringify(data)).toBe(true);
            expect(created.text).toContain('GATE_DENIED');
            expect(created.text).toContain('Wiretap settings');
            expect(await probeExists()).toBe(false);
         }
      } finally {
         // A regression would have stored the probe document; remove it so the shared world stays clean.
         await page.evaluate(
            (name) => game.settings.storage.get('world').getSetting(name)?.delete(),
            probeKey,
         );
      }
      expect(await page.evaluate(() => game.settings.get('wiretap', 'allowMacroExecution'))).toBe(false);
   });

   test('a namespace on Setting data is pruned by Foundry, so the stored key is the checked key', async ({ page }) => {
      await openGate(page, 'allowSettingWrites');
      const key = `${E2E_SETTING_KEY_PREFIX}namespace`;
      const [row] = await callJson(
         'create_documents',
         createArguments('Setting', [{
            key,
            namespace: 'zzz',
            value: '"1"'
         }]),
      );
      await record(page, 'Setting', row.uuid);
      expect(row.name).toBe(key);
      expect(
         await page.evaluate(
            (uuid) => fromUuid(uuid).then((live) => [live.key, 'namespace' in live._source]),
            row.uuid,
         ),
      ).toEqual([key, false]);
      // An ordinary setting is updated and deleted once the gate is open.
      await callJson('update_documents', { updates: [patch(row.uuid, 'value', '"2"')] });
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.value), row.uuid)).toBe('2');
      await callJson('delete_documents', { uuids: [row.uuid] });
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live), row.uuid)).toBeNull();
   });

   test('needs allowOwnershipWrites for a dotted ownership key, in data and in embedded data', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const itemType = await firstSubtype(page, 'Item');
      const before = await page.evaluate(() => game.actors.size);
      const name = `${E2E_PREFIX}Owner ${Date.now()}`;
      for (const data of [
         {
            name,
            type: actorType,
            'ownership.default': 3
         },
         {
            name,
            type: actorType,
            items: [{
               name: `${E2E_PREFIX}Item`,
               type: itemType,
               'ownership.default': 3
            }]
         },
         {
            name,
            type: actorType,
            '-=ownership': null
         },
      ]) {
         const denied = await callText('create_documents', createArguments('Actor', [data]));
         expect(denied.isError, JSON.stringify(data)).toBe(true);
         expect(denied.text).toContain('allowOwnershipWrites');
      }
      expect(await page.evaluate(() => game.actors.size)).toBe(before);

      // Only a throwaway actor is written, with the gate open; the dotted key is expanded by Foundry.
      await openGate(page, 'allowOwnershipWrites');
      const [row] = await callJson(
         'create_documents',
         createArguments('Actor', [{
            name,
            type: actorType,
            'ownership.default': 3
         }]),
      );
      await record(page, 'Actor', row.uuid);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.ownership.default), row.uuid)).toBe(3);
      await callJson('delete_documents', { uuids: [row.uuid] });
   });

   test('refuses an ownership path of an update on a throwaway actor while the gate is closed', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const [row] = await callJson(
         'create_documents',
         createArguments('Actor', [{
            name: `${E2E_PREFIX}Owner ${Date.now()}`,
            type: actorType
         }]),
      );
      await record(page, 'Actor', row.uuid);
      const denied = await callText('update_documents', { updates: [patch(row.uuid, 'ownership.default', 3)] });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('allowOwnershipWrites');
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.ownership.default), row.uuid)).toBe(0);
      await callJson('delete_documents', { uuids: [row.uuid] });
   });
});
