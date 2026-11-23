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
      // Deleting and replacing need their own gates; the tests open them and one test closes them again.
      await openGate(page, 'allowDelete');
      await openGate(page, 'allowReplace');
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
            type: actorType,
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
         type: actorType,
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
            type: itemType,
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
            b: 2,
         }, 'set')],
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

      // The whole actor is replaced from its own export: the preUpdateActor hook fires once with the new name and the
      // embedded item and effect, sent back inside the data, keep their ids and fields.
      const source = await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.toObject()), actorUuid);
      delete source.ownership;
      for (const embedded of [
         ...source.items,
         ...source.effects,
      ]) {
         delete embedded.ownership;
      }
      const replacedName = `${name} replaced`;
      await page.evaluate(() => {
         window.wiretapE2eHook = [];
         window.wiretapE2eHookId = Hooks.on('preUpdateActor', (document, changes) => {
            window.wiretapE2eHook.push({
               id: document.id,
               name: changes.name ?? null,
            });
         });
      });
      try {
         const replaced = await callJson('replace_document', {
            uuid: actorUuid,
            data: JSON.stringify({
               ...source,
               name: replacedName,
            }),
         });
         expect(replaced.changed).toContain('name');
         expect(await page.evaluate(() => window.wiretapE2eHook)).toEqual([
            {
               id: idOf(actorUuid),
               name: replacedName,
            },
         ]);
      } finally {
         await page.evaluate(() => Hooks.off('preUpdateActor', window.wiretapE2eHookId));
      }
      expect(
         await page.evaluate(
            (uuid) =>
               fromUuid(uuid).then((live) => ({
                  name: live.name,
                  items: live.items.map((embedded) => embedded.id),
                  effects: live.effects.map((embedded) => embedded.id),
                  itemFlags: live.items.contents[0].flags.wiretapE2e,
               })),
            actorUuid,
         ),
      ).toEqual({
         name: replacedName,
         items: [itemId],
         effects: [idOf(effect.uuid)],
         itemFlags: { c: 3 },
      });

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
            name: replacedName,
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
      ]) {
         const denied = await callText('create_documents', createArguments('Actor', [data]));
         expect(denied.isError, JSON.stringify(data)).toBe(true);
         expect(denied.text).toContain('allowOwnershipWrites');
      }
      const operator = await callText('create_documents', createArguments('Actor', [{
         name,
         type: actorType,
         '-=ownership': null,
      }]));
      expect(operator.isError).toBe(true);
      expect(operator.text).toContain('PATH_OPERATOR');
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

   test('replaces an actor like a JSON import: the preUpdateActor hook fires and the preserved fields stay', async ({
      page,
   }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const itemType = await firstSubtype(page, 'Item');
      const name = `${E2E_PREFIX}Replace ${Date.now()}`;
      const [created] = await callJson('create_documents', createArguments('Actor', [{ name, type: actorType }]));
      await record(page, 'Actor', created.uuid);
      const [item] = await callJson(
         'create_documents',
         createArguments('Item', [{ name: `${E2E_PREFIX}Item`, type: itemType }], { parentUuid: created.uuid }),
      );
      const before = await page.evaluate((uuid) => {
         const actor = fromUuid.sync?.(uuid) ?? game.actors.get(uuid.split('.').pop());
         return {
            sort: actor.sort,
            folder: actor.folder?.id ?? null,
            ownership: actor.toObject().ownership,
            source: actor.toObject(),
         };
      }, created.uuid);

      // A dry run validates and writes nothing: no hook, same name.
      const replaced = `${E2E_PREFIX}Replaced ${Date.now()}`;
      // Ownership is a preserved field; the guard reads the raw data, so a caller omits it unless the gate is open.
      const { ownership: dropped, ...replacement } = before.source;
      expect(dropped).toBeDefined();
      for (const embedded of replacement.items ?? []) {
         delete embedded.ownership;
      }
      const data = JSON.stringify({ ...replacement, name: replaced });
      const dry = await callJson('replace_document', {
         uuid: created.uuid,
         data,
         dryRun: true,
      });
      expect(dry.dryRun).toBe(true);
      expect(dry.changed).toContain('name');
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), created.uuid)).toBe(name);

      // The real replace goes through Document#update with hooks: a preUpdateActor listener sees the new name.
      await page.evaluate(() => {
         window.wiretapE2eHook = [];
         window.wiretapE2eHookId = Hooks.on('preUpdateActor', (document, changes) => {
            window.wiretapE2eHook.push({ id: document.id, name: changes.name ?? null });
         });
      });
      try {
         const row = await callJson('replace_document', {
            uuid: created.uuid,
            data,
            paths: ['name'],
         });
         expect(row.uuid).toBe(created.uuid);
         expect(row.changed).toContain('name');
         expect(row.values).toEqual({ name: replaced });
         expect(new TextEncoder().encode(JSON.stringify(row)).length).toBeLessThanOrEqual(ACK_MAX);
         expect(await page.evaluate(() => window.wiretapE2eHook)).toEqual([
            {
               id: idOf(created.uuid),
               name: replaced,
            },
         ]);
      } finally {
         await page.evaluate(() => Hooks.off('preUpdateActor', window.wiretapE2eHookId));
      }
      const after = await page.evaluate((uuid) => {
         const actor = game.actors.get(uuid.split('.').pop());
         return {
            name: actor.name,
            sort: actor.sort,
            folder: actor.folder?.id ?? null,
            ownership: actor.toObject().ownership,
            items: actor.items.size,
         };
      }, created.uuid);
      expect(after.name).toBe(replaced);
      expect(after.sort).toBe(before.sort);
      expect(after.folder).toBe(before.folder);
      expect(after.ownership).toEqual(before.ownership);
      expect(after.items).toBe(1);
      expect(item.uuid).toContain(created.uuid);

      // Data Foundry rejects is reported and nothing changes.
      const invalid = await callText('replace_document', {
         uuid: created.uuid,
         data: JSON.stringify({ ...replacement, name: '' }),
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.text).toContain('VALIDATION_FAILED');
      expect(invalid.bytes).toBeLessThanOrEqual(ERROR_MAX);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), created.uuid)).toBe(replaced);
      await callJson('delete_documents', { uuids: [created.uuid] });
   });

   test('runs creates, updates and deletes as one batch and reports a cancelled operation', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const stamp = Date.now();
      const rows = await callJson(
         'create_documents',
         createArguments('Actor', [
            { name: `${E2E_PREFIX}BatchA ${stamp}`, type: actorType },
            { name: `${E2E_PREFIX}BatchB ${stamp}`, type: actorType },
         ]),
      );
      for (const row of rows) {
         await record(page, 'Actor', row.uuid);
      }
      const [first, second] = rows;
      const before = await page.evaluate(() => game.actors.size);

      // A dry run sends nothing.
      const preview = await callJson('batch', {
         creates: [{ documentName: 'Actor', data: JSON.stringify({ name: `${E2E_PREFIX}Never`, type: actorType }) }],
         updates: [patch(first.uuid, 'name', `${E2E_PREFIX}Never`)],
         deletes: [second.uuid],
         dryRun: true,
      });
      expect(preview.dryRun).toBe(true);
      expect(await page.evaluate(() => game.actors.size)).toBe(before);

      // The real batch: one create, one update, one delete; the created actor is recorded first.
      const renamed = `${E2E_PREFIX}BatchRenamed ${stamp}`;
      const batch = await callText('batch', {
         creates: [
            {
               documentName: 'Actor',
               data: JSON.stringify({ name: `${E2E_PREFIX}BatchNew ${stamp}`, type: actorType }),
            },
         ],
         updates: [patch(first.uuid, 'name', renamed)],
         deletes: [second.uuid],
      });
      expect(batch.isError, batch.text).toBe(false);
      const result = JSON.parse(batch.text);
      for (const row of result.created) {
         await record(page, 'Actor', row.uuid);
      }
      expect(batch.bytes).toBeLessThanOrEqual(ACK_BATCH_MAX);
      expect(result.created).toHaveLength(1);
      expect(result.updated).toEqual([{ uuid: first.uuid, changed: ['name'] }]);
      expect(result.deleted).toEqual([expect.objectContaining({ uuid: second.uuid })]);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), first.uuid)).toBe(renamed);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live), second.uuid)).toBeNull();

      // A hook that cancels the delete leaves the earlier operations applied: the batch is not atomic.
      await page.evaluate(() => {
         window.wiretapE2eCancel = Hooks.on('preDeleteActor', () => false);
      });
      try {
         const partial = await callText('batch', {
            creates: [
               {
                  documentName: 'Actor',
                  data: JSON.stringify({ name: `${E2E_PREFIX}BatchKept ${stamp}`, type: actorType }),
               },
            ],
            deletes: [first.uuid],
         });
         expect(partial.isError).toBe(true);
         expect(partial.text).toContain('WRITE_NOT_APPLIED');
         expect(partial.text).toContain('1 of 2 operations applied');
         expect(partial.text).toContain('1 cancelled');
         expect(partial.bytes).toBeLessThanOrEqual(ERROR_MAX);
      } finally {
         await page.evaluate(() => Hooks.off('preDeleteActor', window.wiretapE2eCancel));
      }
      const keptByStamp = await page.evaluate(
         (name) => game.actors.filter((actor) => actor.name === name).map((actor) => actor.uuid),
         `${E2E_PREFIX}BatchKept ${stamp}`,
      );
      for (const uuid of keptByStamp) {
         await record(page, 'Actor', uuid);
      }
      expect(keptByStamp).toHaveLength(1);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live !== null), first.uuid)).toBe(true);
   });

   test('returns the first ack for a repeated idempotencyKey and refuses forged records', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const name = `${E2E_PREFIX}Idem ${Date.now()}`;
      const key = `e2e-${Date.now()}`;
      const args = createArguments('Actor', [{ name, type: actorType }], { idempotencyKey: key });
      const first = await callJson('create_documents', args);
      await record(page, 'Actor', first[0].uuid);
      const second = await callJson('create_documents', args);
      expect(second).toEqual(first);
      expect(
         await page.evaluate((prefixed) => game.actors.filter((actor) => actor.name === prefixed).length, name),
      ).toBe(1);
      // The record is a module flag on the created document.
      const flag = await page.evaluate(
         (uuid) => fromUuid(uuid).then((live) => live.flags.wiretap?.idem ?? null),
         first[0].uuid,
      );
      expect(flag).toMatchObject({
         k: key,
         i: 0,
         n: 1,
         u: await page.evaluate(() => game.user.id),
         d: idOf(first[0].uuid),
      });
      // The same key with other data is a conflict and creates nothing.
      const conflict = await callText(
         'create_documents',
         createArguments('Actor', [{ name: `${name} other`, type: actorType }], { idempotencyKey: key }),
      );
      expect(conflict.isError).toBe(true);
      expect(conflict.text).toContain('IDEMPOTENCY_CONFLICT');
      // The flag scope cannot be written by a caller.
      const forged = await callText('update_documents', {
         updates: [patch(first[0].uuid, 'flags.wiretap.idem', { k: 'forged', i: 0, n: 1, h: 'x' })],
      });
      expect(forged.isError).toBe(true);
      expect(forged.text).toContain('flags.wiretap');
      const forgedCreate = await callText(
         'create_documents',
         createArguments('Actor', [{ name: `${name} forged`, type: actorType, flags: { wiretap: { idem: {} } } }]),
      );
      expect(forgedCreate.isError).toBe(true);
      expect(forgedCreate.text).toContain('flags.wiretap');
      expect(
         await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.flags.wiretap?.idem.k), first[0].uuid),
      ).toBe(key);
      await callJson('delete_documents', { uuids: [first[0].uuid] });
   });

   test('checks the permission of the actAs user in advance and writes nothing when it is denied', async ({ page }) => {
      await openGate(page, 'allowUserWrites');
      await openGate(page, 'allowOwnershipWrites');
      const actorType = await firstSubtype(page, 'Actor');
      // The throwaway player is the only user the check is aimed at.
      const [player] = await callJson(
         'create_documents',
         createArguments('User', [{ name: `${E2E_PREFIX}Player ${Date.now()}`, role: 1 }]),
      );
      await record(page, 'User', player.uuid);
      const playerId = idOf(player.uuid);
      const name = `${E2E_PREFIX}ActAs ${Date.now()}`;
      const [plain] = await callJson('create_documents', createArguments('Actor', [{ name, type: actorType }]));
      await record(page, 'Actor', plain.uuid);
      const [owned] = await callJson(
         'create_documents',
         createArguments('Actor', [
            { name: `${name} owned`, type: actorType, ownership: { default: 0, [playerId]: 3 } },
         ]),
      );
      await record(page, 'Actor', owned.uuid);

      for (const [tool, args] of [
         ['update_documents', { updates: [patch(plain.uuid, 'name', `${name} changed`)] }],
         ['replace_document', { uuid: plain.uuid, data: JSON.stringify({ name: `${name} changed`, type: actorType }) }],
         ['delete_documents', { uuids: [plain.uuid] }],
         ['batch', { deletes: [plain.uuid] }],
      ]) {
         const denied = await callText(tool, { ...args, actAs: playerId });
         expect(denied.isError, tool).toBe(true);
         expect(denied.text, tool).toContain('ACT_AS_DENIED');
      }
      const deniedCreate = await callText(
         'create_documents',
         createArguments('Item', [{ name: `${E2E_PREFIX}Item`, type: await firstSubtype(page, 'Item') }], {
            parentUuid: plain.uuid,
            actAs: playerId,
         }),
      );
      expect(deniedCreate.isError).toBe(true);
      expect(deniedCreate.text).toContain('ACT_AS_DENIED');
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), plain.uuid)).toBe(name);
      // A dotted ownership path is judged as the nested change it is: the player may not give himself ownership.
      const ownershipDenied = await callText('update_documents', {
         updates: [patch(plain.uuid, 'ownership.default', 3)],
         actAs: playerId,
      });
      expect(ownershipDenied.isError).toBe(true);
      expect(ownershipDenied.text).toContain('ACT_AS_DENIED');
      expect(
         await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.toObject().ownership.default), plain.uuid),
      ).toBe(0);

      // The owner passes the check; the write still runs as the GM and a closed gate still stops it.
      const allowed = await callJson('update_documents', {
         updates: [patch(owned.uuid, 'name', `${name} owned changed`)],
         actAs: playerId,
      });
      expect(allowed[0].changed).toEqual(['name']);
      const unknown = await callText('delete_documents', { uuids: [plain.uuid], actAs: 'NoSuchUser00001' });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain('ARGS_INVALID');
      await callJson('delete_documents', { uuids: [plain.uuid, owned.uuid] });
      await callJson('delete_documents', { uuids: [player.uuid] });
   });

   test('runs a batch with an embedded create, an embedded path and the replace and delete ops', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const itemType = await firstSubtype(page, 'Item');
      const [owner] = await callJson(
         'create_documents',
         createArguments('Actor', [
            {
               name: `${E2E_PREFIX}Embedded ${Date.now()}`,
               type: actorType,
            },
         ]),
      );
      await record(page, 'Actor', owner.uuid);
      const [sword] = await callJson(
         'create_documents',
         createArguments(
            'Item',
            [
               {
                  name: `${E2E_PREFIX}Sword`,
                  type: itemType,
                  flags: {
                     wiretapE2e: {
                        a: 1,
                        b: 2,
                     },
                  },
               },
            ],
            { parentUuid: owner.uuid },
         ),
      );
      const swordId = idOf(sword.uuid);
      const stamp = Date.now();
      // Creates of two world classes interleaved with an embedded create: Foundry answers each create group in the
      // order its id lookups finish, so the rows prove that created row i is create entry i.
      /** @type {{ documentName: string, name: string, parentUuid?: string }[]} The create entries, in order. */
      const createEntries = [
         {
            documentName: 'Actor',
            name: `${E2E_PREFIX}OrderA ${stamp}`,
         },
         {
            documentName: 'Item',
            name: `${E2E_PREFIX}Shield`,
            parentUuid: owner.uuid,
         },
         {
            documentName: 'Item',
            name: `${E2E_PREFIX}OrderB ${stamp}`,
         },
         {
            documentName: 'Actor',
            name: `${E2E_PREFIX}OrderC ${stamp}`,
         },
      ];
      const result = await callJson('batch', {
         creates: createEntries.map((entry) => ({
            documentName: entry.documentName,
            data: JSON.stringify({
               name: entry.name,
               type: entry.documentName === 'Actor' ? actorType : itemType,
            }),
            ...(entry.parentUuid === undefined ? {} : { parentUuid: entry.parentUuid }),
         })),
         updates: [
            patch(owner.uuid, `items.${swordId}.name`, `${E2E_PREFIX}Sword renamed`),
            patch(owner.uuid, `items.${swordId}.flags.wiretapE2e`, { c: 3 }, 'replace'),
            patch(owner.uuid, 'flags.wiretapE2e', undefined, 'delete'),
         ],
      });
      // Every world document the batch created is recorded before any assertion, by the class its uuid names.
      for (const row of result.created) {
         if (!row.uuid.startsWith(`${owner.uuid}.`)) {
            await record(page, row.uuid.split('.')[0], row.uuid);
         }
      }
      expect(result.created.map((row) => row.name)).toEqual(createEntries.map((entry) => entry.name));
      expect(
         await page.evaluate(
            (uuids) => Promise.all(uuids.map((uuid) => fromUuid(uuid).then((live) => live?.name ?? null))),
            result.created.map((row) => row.uuid),
         ),
      ).toEqual(createEntries.map((entry) => entry.name));
      expect(result.created[0].uuid).toMatch(/^Actor\./);
      expect(result.created[1].uuid).toMatch(new RegExp(`^${owner.uuid}\\.Item\\.`));
      expect(result.created[2].uuid).toMatch(/^Item\./);
      expect(result.created[3].uuid).toMatch(/^Actor\./);
      expect(result.updated).toEqual([
         {
            uuid: owner.uuid,
            changed: [`items.${swordId}.name`, `items.${swordId}.flags.wiretapE2e`, 'flags.wiretapE2e'],
         },
      ]);
      expect(
         await page.evaluate(
            (uuid) => fromUuid(uuid).then((live) => live.items.map((embedded) => embedded.name).sort()),
            owner.uuid,
         ),
      ).toEqual([`${E2E_PREFIX}Shield`, `${E2E_PREFIX}Sword renamed`]);
      expect(
         await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.flags.wiretapE2e), sword.uuid),
      ).toEqual({ c: 3 });
      await callJson('delete_documents', { uuids: [owner.uuid] });
   });

   test('reports an unchanged and a hook-cancelled update as empty changed and names a cancelled operation', async ({
      page,
   }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const stamp = Date.now();
      const rows = await callJson(
         'create_documents',
         createArguments('Actor', [
            {
               name: `${E2E_PREFIX}MidA ${stamp}`,
               type: actorType,
            },
            {
               name: `${E2E_PREFIX}MidB ${stamp}`,
               type: actorType,
            },
            {
               name: `${E2E_PREFIX}MidC ${stamp}`,
               type: actorType,
            },
         ]),
      );
      for (const row of rows) {
         await record(page, 'Actor', row.uuid);
      }
      const [first, second, third] = rows;

      // The first update changes nothing, the second is cancelled by a hook, the third is applied: Foundry sends one
      // request, and the ack still names each document.
      await page.evaluate((id) => {
         window.wiretapE2eCancel = Hooks.on('preUpdateActor', (document) => (document.id === id ? false : undefined));
      }, idOf(second.uuid));
      try {
         const result = await callJson('batch', {
            updates: [
               patch(first.uuid, 'name', first.name),
               patch(second.uuid, 'name', `${E2E_PREFIX}never`),
               patch(third.uuid, 'name', `${E2E_PREFIX}MidC renamed ${stamp}`),
            ],
         });
         expect(result.updated).toEqual([
            {
               uuid: first.uuid,
               changed: [],
            },
            {
               uuid: second.uuid,
               changed: [],
            },
            {
               uuid: third.uuid,
               changed: ['name'],
            },
         ]);
      } finally {
         await page.evaluate(() => Hooks.off('preUpdateActor', window.wiretapE2eCancel));
      }
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), second.uuid)).toBe(second.name);

      // A delete cancelled in the middle is named; the create before it and the update after it stay applied.
      await page.evaluate((id) => {
         window.wiretapE2eCancel = Hooks.on('preDeleteActor', (document) => (document.id === id ? false : undefined));
      }, idOf(second.uuid));
      try {
         const partial = await callText('batch', {
            creates: [
               {
                  documentName: 'Actor',
                  data: JSON.stringify({
                     name: `${E2E_PREFIX}MidNew ${stamp}`,
                     type: actorType,
                  }),
               },
            ],
            deletes: [second.uuid],
            updates: [patch(first.uuid, 'name', `${E2E_PREFIX}MidA renamed ${stamp}`)],
         });
         expect(partial.isError).toBe(true);
         expect(partial.text).toContain('WRITE_NOT_APPLIED');
         expect(partial.text).toContain('2 of 3 operations applied');
         expect(partial.text).toContain('1 cancelled');
         expect(partial.bytes).toBeLessThanOrEqual(ERROR_MAX);
      } finally {
         await page.evaluate(() => Hooks.off('preDeleteActor', window.wiretapE2eCancel));
      }
      const added = await page.evaluate(
         (created) => game.actors.filter((actor) => actor.name === created).map((actor) => actor.uuid),
         `${E2E_PREFIX}MidNew ${stamp}`,
      );
      expect(added).toHaveLength(1);
      await record(page, 'Actor', added[0]);
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), first.uuid)).toBe(
         `${E2E_PREFIX}MidA renamed ${stamp}`,
      );
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live !== null), second.uuid)).toBe(true);
   });

   test('repairs the client after the server rejects a batch it had validated on the client', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const itemType = await firstSubtype(page, 'Item');
      const stamp = Date.now();
      const [keeper, parent] = await callJson(
         'create_documents',
         createArguments('Actor', [
            {
               name: `${E2E_PREFIX}Keeper ${stamp}`,
               type: actorType,
            },
            {
               name: `${E2E_PREFIX}Parent ${stamp}`,
               type: actorType,
            },
         ]),
      );
      await record(page, 'Actor', keeper.uuid);
      await record(page, 'Actor', parent.uuid);
      const [item] = await callJson(
         'create_documents',
         createArguments('Item', [
            {
               name: `${E2E_PREFIX}Item`,
               type: itemType,
            },
         ], { parentUuid: parent.uuid }),
      );
      // A client-only actor: a batch whose second request the server rejects (a duplicate embedded id) leaves the
      // dry-run echo of its first request in the client collection, which Foundry 14.364 handles as if it were real.
      const ghostId = await page.evaluate(
         async ({ type, kind, parentId, itemId, ghostName }) => {
            await foundry.documents.modifyBatch([
               {
                  action: 'create',
                  documentName: 'Actor',
                  data: [
                     {
                        name: ghostName,
                        type,
                     },
                  ],
               },
               {
                  action: 'create',
                  documentName: 'Item',
                  keepId: true,
                  parent: game.actors.get(parentId),
                  data: [
                     {
                        _id: itemId,
                        name: `${ghostName} duplicate`,
                        type: kind,
                     },
                  ],
               },
            ]);
            return game.actors.find((actor) => actor.name === ghostName)?.id ?? null;
         },
         {
            type: actorType,
            kind: itemType,
            parentId: idOf(parent.uuid),
            itemId: idOf(item.uuid),
            ghostName: `${E2E_PREFIX}Ghost ${stamp}`,
         },
      );
      try {
         expect(ghostId).not.toBeNull();
         // The server does not hold the ghost; the client lists it.
         expect(
            await page.evaluate(
               (id) =>
                  Actor.database
                     .get(Actor, { query: { _id: id } })
                     .then((found) => found.length),
               ghostId,
            ),
         ).toBe(0);

         // The update of the ghost fails on the server's validation pass, so the delete of the keeper is only echoed:
         // the client drops the keeper though the server keeps it. The tool reports 0 applied and restores it.
         const refused = await callText('batch', {
            updates: [patch(`Actor.${ghostId}`, 'name', `${E2E_PREFIX}Renamed ghost`)],
            deletes: [keeper.uuid],
         });
         expect(refused.isError).toBe(true);
         expect(refused.text).toContain('WRITE_NOT_APPLIED');
         expect(refused.text).toContain('0 of 2 operations applied');
         expect(refused.bytes).toBeLessThanOrEqual(ERROR_MAX);
         expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live?.name ?? null), keeper.uuid)).toBe(
            keeper.name,
         );
         expect(
            await page.evaluate(
               (id) =>
                  Actor.database
                     .get(Actor, { query: { _id: id } })
                     .then((found) => found.length),
               idOf(keeper.uuid),
            ),
         ).toBe(1);

         // A create that is only echoed leaves a ghost in the client; the tool removes it.
         const echoed = await callText('batch', {
            creates: [
               {
                  documentName: 'Actor',
                  data: JSON.stringify({
                     name: `${E2E_PREFIX}Echo ${stamp}`,
                     type: actorType,
                  }),
               },
            ],
            updates: [patch(`Actor.${ghostId}`, 'name', `${E2E_PREFIX}Renamed ghost`)],
         });
         expect(echoed.isError).toBe(true);
         expect(echoed.text).toContain('0 of 2 operations applied');
         expect(
            await page.evaluate(
               (created) => game.actors.filter((actor) => actor.name === created).length,
               `${E2E_PREFIX}Echo ${stamp}`,
            ),
         ).toBe(0);
      } finally {
         await page.evaluate((id) => {
            if (id !== null) {
               game.actors.delete(id);
            }
         }, ghostId);
      }
      await callJson('delete_documents', { uuids: [keeper.uuid, parent.uuid] });
   });

   test('resets a field the data omits, keeps the Wiretap record and the preserved fields', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const itemType = await firstSubtype(page, 'Item');
      const name = `${E2E_PREFIX}Omit ${Date.now()}`;
      const key = `e2e-omit-${Date.now()}`;
      const [created] = await callJson(
         'create_documents',
         createArguments(
            'Actor',
            [
               {
                  name,
                  type: actorType,
                  flags: { wiretapE2e: { keep: 1 } },
               },
            ],
            { idempotencyKey: key },
         ),
      );
      await record(page, 'Actor', created.uuid);
      await callJson(
         'create_documents',
         createArguments('Item', [
            {
               name: `${E2E_PREFIX}Item`,
               type: itemType,
            },
         ], { parentUuid: created.uuid }),
      );
      await callJson(
         'create_documents',
         createArguments('ActiveEffect', [{ name: `${E2E_PREFIX}Effect` }], { parentUuid: created.uuid }),
      );
      const before = await page.evaluate(
         (uuid) =>
            fromUuid(uuid).then((live) => ({
               sort: live.sort,
               folder: live.folder?.id ?? null,
               ownership: live.toObject().ownership,
               items: live.items.size,
               effects: live.effects.size,
               record: live.flags.wiretap.idem.k,
            })),
         created.uuid,
      );
      expect(before).toMatchObject({
         items: 1,
         effects: 1,
         record: key,
      });

      // The data names only the name and the type. Foundry's import resets everything else to the schema default: the
      // embedded collections are emptied and the flags of every other module are lost. The Wiretap record stays.
      const replaced = `${name} replaced`;
      const row = await callJson('replace_document', {
         uuid: created.uuid,
         data: JSON.stringify({
            name: replaced,
            type: actorType,
         }),
      });
      expect(row.changed).toEqual(expect.arrayContaining(['name', 'items', 'effects', 'flags']));
      expect(
         await page.evaluate(
            (uuid) =>
               fromUuid(uuid).then((live) => ({
                  name: live.name,
                  sort: live.sort,
                  folder: live.folder?.id ?? null,
                  ownership: live.toObject().ownership,
                  items: live.items.size,
                  effects: live.effects.size,
                  flagScopes: Object.keys(live.flags),
                  record: live.flags.wiretap?.idem.k ?? null,
               })),
            created.uuid,
         ),
      ).toEqual({
         name: replaced,
         sort: before.sort,
         folder: before.folder,
         ownership: before.ownership,
         items: 0,
         effects: 0,
         flagScopes: ['wiretap'],
         record: key,
      });
      await callJson('delete_documents', { uuids: [created.uuid] });
   });

   test('refuses to replace a User, and to write _id or erase flags through any path', async ({ page }) => {
      await openGate(page, 'allowUserWrites');
      const actorType = await firstSubtype(page, 'Actor');
      const [user] = await callJson(
         'create_documents',
         createArguments('User', [
            {
               name: `${E2E_PREFIX}Replace ${Date.now()}`,
               role: 1,
            },
         ]),
      );
      await record(page, 'User', user.uuid);
      const refusedUser = await callText('replace_document', {
         uuid: user.uuid,
         data: JSON.stringify({ name: `${E2E_PREFIX}Renamed` }),
      });
      expect(refusedUser.isError).toBe(true);
      expect(refusedUser.text).toContain('update_documents');
      expect(refusedUser.text).toContain('ARGS_INVALID');
      const [actor, victim] = await callJson(
         'create_documents',
         createArguments('Actor', [
            {
               name: `${E2E_PREFIX}Retarget A ${Date.now()}`,
               type: actorType,
            },
            {
               name: `${E2E_PREFIX}Retarget B ${Date.now()}`,
               type: actorType,
            },
         ]),
      );
      await record(page, 'Actor', actor.uuid);
      await record(page, 'Actor', victim.uuid);
      for (const [tool, args, code] of [
         ['update_documents', { updates: [patch(actor.uuid, '_id', idOf(victim.uuid))] }, 'PATH_UNSAFE_SEGMENT'],
         ['batch', { updates: [patch(actor.uuid, '_id', idOf(victim.uuid))] }, 'PATH_UNSAFE_SEGMENT'],
         ['update_documents', { updates: [patch(actor.uuid, '-=_id', null)] }, 'PATH_OPERATOR'],
      ]) {
         const refused = await callText(tool, args);
         expect(refused.isError, tool).toBe(true);
         expect(refused.text, tool).toContain(code);
      }
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), victim.uuid)).toBe(victim.name);
      for (const patchEntry of [
         patch(actor.uuid, 'flags', undefined, 'delete'),
         patch(actor.uuid, 'flags', {}, 'replace'),
         patch(actor.uuid, 'flags', null),
      ]) {
         const refused = await callText('update_documents', { updates: [patchEntry] });
         expect(refused.isError, JSON.stringify(patchEntry)).toBe(true);
         expect(refused.text).toContain('flags.wiretap');
      }

      // MEASURED on 14.364: a `==flags` key erases every flag of a document (the Wiretap records with them), at
      // document and embedded level; a bare `-=flags` key changes nothing. The tools refuse every operator key.
      const erased = await page.evaluate(async (uuid) => {
         const live = await fromUuid(uuid);
         await live.update({ 'flags.wiretapE2e': { marker: 1 } });
         const before = live.flags.wiretapE2e?.marker ?? null;
         await live.update({ '==flags': {} });
         return {
            before,
            after: live.flags.wiretapE2e ?? null,
         };
      }, victim.uuid);
      expect(erased).toEqual({
         before: 1,
         after: null,
      });
      const itemType = await firstSubtype(page, 'Item');
      const [item] = await callJson(
         'create_documents',
         createArguments('Item', [
            {
               name: `${E2E_PREFIX}Flags item`,
               type: itemType,
            },
         ], { parentUuid: actor.uuid }),
      );
      await callJson('update_documents', { updates: [patch(item.uuid, 'flags.wiretapE2e', { keep: 1 })] });
      for (const path of [
         '==flags',
         '-=flags',
         `items.${idOf(item.uuid)}.==flags`,
         `items.${idOf(item.uuid)}.-=flags`,
         'flags.__$OPERATOR$__',
         `items.${idOf(item.uuid)}.effects.__$OPERATOR$__`,
      ]) {
         for (const tool of [
            'update_documents',
            'batch',
         ]) {
            const value = path.includes('-=') ? null : {};
            const refused = await callText(tool, { updates: [patch(actor.uuid, path, value)] });
            expect(refused.isError, `${tool} ${path}`).toBe(true);
            expect(refused.text, `${tool} ${path}`).toContain('PATH_OPERATOR');
         }
      }
      // A serialized operator as a value is refused the same way (the target is a harmless flag, never a name).
      const wrapper = {
         __$OPERATOR$__: 'ForcedReplacement',
         value: {},
      };
      for (const tool of [
         'update_documents',
         'batch',
      ]) {
         const refused = await callText(tool, { updates: [patch(actor.uuid, 'flags.wiretapE2e', wrapper)] });
         expect(refused.isError, tool).toBe(true);
         expect(refused.text, tool).toContain('PATH_OPERATOR');
      }
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.flags.wiretapE2e), item.uuid)).toEqual({
         keep: 1,
      });
      await callJson('delete_documents', { uuids: [actor.uuid, victim.uuid, user.uuid] });
   });

   test('serializes concurrent calls with one idempotencyKey and refuses an undeclared argument', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const name = `${E2E_PREFIX}Concurrent ${Date.now()}`;
      const args = createArguments('Actor', [
         {
            name,
            type: actorType,
         },
      ], { idempotencyKey: `e2e-concurrent-${Date.now()}` });
      const [first, second] = await Promise.all([
         callText('create_documents', args),
         callText('create_documents', args),
      ]);
      expect(first.isError, first.text).toBe(false);
      expect(second.isError, second.text).toBe(false);
      expect(JSON.parse(second.text)).toEqual(JSON.parse(first.text));
      const created = await page.evaluate(
         (target) => game.actors.filter((actor) => actor.name === target).map((actor) => actor.uuid),
         name,
      );
      expect(created).toHaveLength(1);
      await record(page, 'Actor', created[0]);

      // A misspelled argument is refused by the sidecar before any client call, not dropped.
      const before = await page.evaluate(() => game.actors.size);
      const misspelled = await callText('batch', {
         deletes: [created[0]],
         dryrun: true,
      });
      expect(misspelled.isError).toBe(true);
      expect(await page.evaluate(() => game.actors.size)).toBe(before);
      // A misspelled key inside an entry is refused too: `parent` would otherwise create a world Item.
      const itemsBefore = await page.evaluate(() => game.items.size);
      const entry = await callText('batch', {
         creates: [{
            documentName: 'Item',
            data: JSON.stringify({
               name: `${E2E_PREFIX}Stray`,
               type: await firstSubtype(page, 'Item'),
            }),
            parent: created[0],
         }],
      });
      expect(entry.isError).toBe(true);
      expect(await page.evaluate(() => game.items.size)).toBe(itemsBefore);
      const dropped = await callText('update_documents', {
         updates: [patch(created[0], 'name', `${name} x`)],
         dryRun: true,
         paths2: [],
      });
      expect(dropped.isError).toBe(true);
      await callJson('delete_documents', { uuids: [created[0]] });
   });

   test('creates and replaces from a handle, and the client still guards the stored document', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const name = `${E2E_PREFIX}Handle ${Date.now()}`;
      // A document large enough that a full read is stored as a handle.
      const [source] = await callJson(
         'create_documents',
         createArguments('Actor', [
            {
               name,
               type: actorType,
               flags: { wiretapE2e: { pad: 'x'.repeat(9000) } },
            },
         ]),
      );
      await record(page, 'Actor', source.uuid);
      const read = await callJson('get_document', {
         uuid: source.uuid,
         mode: 'full',
      });
      expect(read.handle).toEqual(expect.any(String));
      const reference = `handle:${read.handle}`;

      // The stored export carries an ownership field, so the client's write guard refuses it while the gate is
      // closed: handle resolution happens before the guard and does not replace it.
      const guarded = await callText('create_documents', {
         documentName: 'Actor',
         data: [reference],
      });
      expect(guarded.isError).toBe(true);
      expect(guarded.text).toContain('allowOwnershipWrites');
      await openGate(page, 'allowOwnershipWrites');
      const preview = await callJson('create_documents', {
         documentName: 'Actor',
         data: [reference],
         dryRun: true,
      });
      expect(preview).toEqual([
         {
            uuid: null,
            name,
            type: actorType,
            dryRun: true,
         },
      ]);
      const [clone] = await callJson('create_documents', {
         documentName: 'Actor',
         data: [reference],
      });
      await record(page, 'Actor', clone.uuid);
      expect(clone.uuid).not.toBe(source.uuid);
      expect(
         await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.flags.wiretapE2e.pad.length), clone.uuid),
      ).toBe(9000);

      // replace_document takes the same reference.
      const replaced = await callJson('replace_document', {
         uuid: clone.uuid,
         data: reference,
         dryRun: true,
      });
      expect(replaced.dryRun).toBe(true);
      expect(replaced.changed).toContain('flags');

      // A handle that is not the caller's, or does not exist, is refused before the client is called.
      const missing = await callText('create_documents', {
         documentName: 'Actor',
         data: ['handle:AAAAAAAAAAAAAAAAAAAAAA'],
      });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('HANDLE_NOT_FOUND');
      await callJson('delete_documents', { uuids: [source.uuid, clone.uuid] });
   });

   test('denies delete and replace while their gates are closed, previews without them and runs once open', async ({
      page,
   }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const name = `${E2E_PREFIX}Gated ${Date.now()}`;
      const [created] = await callJson('create_documents', createArguments('Actor', [{
         name,
         type: actorType,
      }]));
      await record(page, 'Actor', created.uuid);
      for (const gate of [
         'allowDelete',
         'allowReplace',
      ]) {
         await page.evaluate((setting) => game.settings.set('wiretap', setting, false), gate);
         await expect
            .poll(() => page.evaluate((setting) => game.settings.get('wiretap', setting), gate), { timeout: POLL_MS })
            .toBe(false);
      }
      const data = JSON.stringify({
         name: `${name} replaced`,
         type: actorType,
      });
      for (const [tool, args, gate] of [
         ['replace_document', { uuid: created.uuid, data }, 'allowReplace'],
         ['delete_documents', { uuids: [created.uuid] }, 'allowDelete'],
         ['batch', { deletes: [created.uuid] }, 'allowDelete'],
      ]) {
         const denied = await callText(tool, args);
         expect(denied.isError, tool).toBe(true);
         expect(denied.text, tool).toContain('GATE_DENIED');
         expect(denied.text, tool).toContain(gate);
         const preview = await callText(tool, {
            ...args,
            dryRun: true,
         });
         expect(preview.isError, `${tool}: ${preview.text}`).toBe(false);
      }
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live?.name ?? null), created.uuid)).toBe(name);
      await openGate(page, 'allowReplace');
      await callJson('replace_document', {
         uuid: created.uuid,
         data,
      });
      await openGate(page, 'allowDelete');
      await callJson('delete_documents', { uuids: [created.uuid] });
      expect(await page.evaluate((uuid) => fromUuid(uuid), created.uuid)).toBeNull();
   });

   test('gates op replace and op delete on embedded collections and replaces that drop documents', async ({
      page,
   }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const itemType = await firstSubtype(page, 'Item');
      const effectType = await firstSubtype(page, 'ActiveEffect');
      const name = `${E2E_PREFIX}Collections ${Date.now()}`;
      const [actor] = await callJson('create_documents', createArguments('Actor', [{
         name,
         type: actorType,
      }]));
      await record(page, 'Actor', actor.uuid);
      const [item] = await callJson(
         'create_documents',
         createArguments('Item', [{
            name: `${E2E_PREFIX}Kept item`,
            type: itemType,
         }], { parentUuid: actor.uuid }),
      );
      await callJson(
         'create_documents',
         createArguments('ActiveEffect', [{
            name: `${E2E_PREFIX}Item effect`,
            type: effectType,
         }], { parentUuid: item.uuid }),
      );
      const counts = () =>
         page.evaluate(
            (uuid) =>
               fromUuid(uuid).then((live) => ({
                  items: live.items.size,
                  effects: live.items.contents[0]?.effects.size ?? null,
               })),
            actor.uuid,
         );
      expect(await counts()).toEqual({
         items: 1,
         effects: 1,
      });
      for (const gate of [
         'allowDelete',
         'allowReplace',
      ]) {
         await page.evaluate((setting) => game.settings.set('wiretap', setting, false), gate);
         await expect
            .poll(() => page.evaluate((setting) => game.settings.get('wiretap', setting), gate), { timeout: POLL_MS })
            .toBe(false);
      }

      // MEASURED on 14.364 (see the representation test below): an operator on an embedded collection removes the
      // documents, so the gates follow the field type; a preview needs none.
      const forms = [
         patch(actor.uuid, `items.${idOf(item.uuid)}.effects`, [], 'replace'),
         patch(actor.uuid, `items.${idOf(item.uuid)}.effects`, undefined, 'delete'),
      ];
      for (const tool of [
         'update_documents',
         'batch',
      ]) {
         for (const form of forms) {
            const denied = await callText(tool, { updates: [form] });
            expect(denied.isError, `${tool} ${form.op}`).toBe(true);
            expect(denied.text, `${tool} ${form.op}`).toContain('GATE_DENIED');
            const preview = await callText(tool, {
               updates: [form],
               dryRun: true,
            });
            // Foundry may reject the form itself (a collection cannot be undefined); the gate must not be what does.
            expect(preview.text, `${tool} ${form.op}`).not.toContain('GATE_DENIED');
         }
      }
      // The key-prefix spellings are refused whatever the gates; none reaches Foundry.
      for (const tool of [
         'update_documents',
         'batch',
      ]) {
         for (const form of [
            patch(actor.uuid, `items.${idOf(item.uuid)}.==effects`, []),
            patch(actor.uuid, `items.${idOf(item.uuid)}.-=effects`, null),
         ]) {
            const refused = await callText(tool, { updates: [form] });
            expect(refused.isError, `${tool} ${form.path}`).toBe(true);
            expect(refused.text, `${tool} ${form.path}`).toContain('PATH_OPERATOR');
         }
      }
      expect(await counts()).toEqual({
         items: 1,
         effects: 1,
      });

      // A replace whose data leaves out the item needs the delete gate as well; its preview counts what it drops.
      const data = JSON.stringify({
         name,
         type: actorType,
      });
      await openGate(page, 'allowReplace');
      const refused = await callText('replace_document', {
        uuid: actor.uuid,
        data,
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('allowDelete');
      const preview = await callJson('replace_document', {
         uuid: actor.uuid,
         data,
         dryRun: true,
      });
      expect(preview.dropped).toBe(2);
      expect(await counts()).toEqual({
         items: 1,
         effects: 1,
      });

      // keepId over an existing id is refused: Foundry would overwrite the stored document (MEASURED).
      for (const args of [
         createArguments('Actor', [{
            _id: idOf(actor.uuid),
            name: `${E2E_PREFIX}Overwrite`,
            type: actorType,
         }], { keepId: true }),
         createArguments('Item', [{
            _id: idOf(item.uuid),
            name: `${E2E_PREFIX}Overwrite item`,
            type: itemType,
         }], {
            keepId: true,
            parentUuid: actor.uuid,
         }),
      ]) {
         const clash = await callText('create_documents', args);
         expect(clash.isError).toBe(true);
         expect(clash.text).toContain('already exists');
      }
      expect(await page.evaluate((uuid) => fromUuid(uuid).then((live) => live.name), actor.uuid)).toBe(name);

      // With both gates open op replace empties the collection of the item, then the actor goes.
      await openGate(page, 'allowDelete');
      await callJson('update_documents', { updates: [forms[0]] });
      expect(await counts()).toEqual({
         items: 1,
         effects: 0,
      });
      await callJson('delete_documents', { uuids: [actor.uuid] });
   });

   test('gates the token delta of a throwaway scene by its field type, and refuses every other spelling', async ({
      page,
   }) => {
      const [scene] = await callJson(
         'create_documents',
         createArguments('Scene', [{ name: `${E2E_PREFIX}Scene ${Date.now()}` }]),
      );
      await record(page, 'Scene', scene.uuid);
      const [token] = await callJson(
         'create_documents',
         createArguments('Token', [{
            name: `${E2E_PREFIX}Token`,
            x: 0,
            y: 0,
         }], { parentUuid: scene.uuid }),
      );
      const tokenId = idOf(token.uuid);
      const tokens = () => page.evaluate((uuid) => fromUuid(uuid).then((live) => live.tokens.size), scene.uuid);
      expect(await tokens()).toBe(1);
      for (const gate of [
         'allowDelete',
         'allowReplace',
      ]) {
         await page.evaluate((setting) => game.settings.set('wiretap', setting, false), gate);
         await expect
            .poll(() => page.evaluate((setting) => game.settings.get('wiretap', setting), gate), { timeout: POLL_MS })
            .toBe(false);
      }
      for (const tool of [
         'update_documents',
         'batch',
      ]) {
         for (const form of [
            patch(scene.uuid, `tokens.${tokenId}.delta`, undefined, 'delete'),
            patch(scene.uuid, `tokens.${tokenId}.delta`, {}, 'replace'),
            patch(scene.uuid, `tokens.${tokenId}.delta.items`, [], 'replace'),
            patch(scene.uuid, `tokens.${tokenId}.delta.effects`, undefined, 'delete'),
         ]) {
            const denied = await callText(tool, { updates: [form] });
            expect(denied.isError, `${tool} ${form.path} ${form.op}`).toBe(true);
            expect(denied.text, `${tool} ${form.path} ${form.op}`).toContain('GATE_DENIED');
            const preview = await callText(tool, {
               updates: [form],
               dryRun: true,
            });
            expect(preview.text, `${tool} ${form.path} ${form.op}`).not.toContain('GATE_DENIED');
         }
         for (const form of [
            patch(scene.uuid, `tokens.${tokenId}.==delta`, {}),
            patch(scene.uuid, `tokens.${tokenId}.delta.-=items`, null),
            patch(scene.uuid, `tokens.${tokenId}.delta.items`, {
               __$OPERATOR$__: 'ForcedReplacement',
               value: [],
            }),
         ]) {
            const refused = await callText(tool, { updates: [form] });
            expect(refused.isError, `${tool} ${form.path}`).toBe(true);
            expect(refused.text, `${tool} ${form.path}`).toContain('PATH_OPERATOR');
         }
      }
      expect(await tokens()).toBe(1);
      await openGate(page, 'allowDelete');
      await callJson('delete_documents', { uuids: [scene.uuid] });
   });

   test('records how Foundry treats every spelling of an operator, on throwaway documents', async ({ page }) => {
      const actorType = await firstSubtype(page, 'Actor');
      const itemType = await firstSubtype(page, 'Item');
      /**
       * The expected outcome of one scenario.
       * @param {number} items - How many items remain.
       * @param {number | null} effects - How many effects the first item holds, null without an item.
       * @param {number | null} flag - The `wiretapE2e.k` flag of the actor.
       * @param {number | null} itemFlag - The `wiretapE2e.k` flag of the first item.
       * @returns {object} The expected counts.
       */
      const row = (items, effects, flag, itemFlag) => ({
         items,
         effects,
         flag,
         itemFlag,
      });
      const measured = await page.evaluate(
         async ({ prefix, actorType: type, itemType: kind }) => {
            const { ForcedDeletion, ForcedReplacement } = foundry.data.operators;
            /**
             * Build a serialized operator, the object form Foundry rebuilds into an operator.
             * @param {string} name - The operator class name.
             * @param {unknown} [value] - The value it carries.
             * @returns {object} The wrapper.
             */
            const wrap = (name, value) => ({
               __$OPERATOR$__: name,
               value,
            });
            /** @type {Actor[]} Every actor created, removed at the end. */
            const made = [];
            /** @type {Scene[]} Every scene created, removed at the end. */
            const scenes = [];
            /** @type {Record<string, unknown>} The outcome of each scenario. */
            const out = {};
            const fresh = async (label) => {
               const actor = await Actor.create({
                  name: `${prefix}Repr ${label}`,
                  type,
                  flags: { wiretapE2e: { k: 1 } },
               });
               made.push(actor);
               const [item] = await actor.createEmbeddedDocuments('Item', [{
                  name: `${prefix}Repr item`,
                  type: kind,
                  flags: { wiretapE2e: { k: 1 } },
               }]);
               await item.createEmbeddedDocuments('ActiveEffect', [{ name: `${prefix}Repr effect` }]);
               return {
                  actor,
                  item,
               };
            };
            const counts = (actor) => ({
               items: actor.items.size,
               effects: actor.items.contents[0]?.effects.size ?? null,
               flag: actor.flags.wiretapE2e?.k ?? null,
               itemFlag: actor.items.contents[0]?.flags.wiretapE2e?.k ?? null,
            });
            const attempt = async (label, run) => {
               const { actor, item } = await fresh(label);
               try {
                  await run(actor, item);
                  out[label] = counts(actor);
               } catch (error) {
                  out[label] = { error: String(error.message).includes('null') ? 'needs-null' : 'error' };
               }
            };
            const tokensAfter = async (label, run) => {
               const scene = await Scene.create({ name: `${prefix}Repr ${label}` });
               scenes.push(scene);
               await scene.createEmbeddedDocuments('Token', [{
                  name: `${prefix}Repr token`,
                  x: 0,
                  y: 0,
               }]);
               await run(scene);
               out[label] = scene.tokens.size;
            };
            try {
               await tokensAfter('scene plain tokens []', (scene) => scene.update({ tokens: [] }));
               await tokensAfter('scene key ==tokens', (scene) => scene.update({ '==tokens': [] }));
               await attempt('plain items []', (actor) => actor.update({ items: [] }));
               await attempt('operator replacement on items', (actor) =>
                  actor.update({ items: ForcedReplacement.create([]) }));
               await attempt('operator deletion on items', (actor) => actor.update({ items: new ForcedDeletion() }));
               await attempt('wrapper replacement on items', (actor) =>
                  actor.update({ items: wrap('ForcedReplacement', []) }));
               await attempt('wrapper deletion on items', (actor) =>
                  actor.update({ items: wrap('ForcedDeletion') }));
               await attempt('unknown wrapper on items', (actor) =>
                  actor.update({ items: wrap('NoSuchOperator', []) }));
               await attempt('key ==items', (actor) => actor.update({ '==items': [] }));
               await attempt('key -=items null', (actor) => actor.update({ '-=items': null }));
               await attempt('key -=items.id null', (actor, item) => actor.update({ [`-=items.${item.id}`]: null }));
               await attempt('plain effects []', (actor, item) => item.update({ effects: [] }));
               await attempt('operator replacement on effects', (actor, item) =>
                  item.update({ effects: ForcedReplacement.create([]) }));
               await attempt('wrapper replacement on effects', (actor, item) =>
                  item.update({ effects: wrap('ForcedReplacement', []) }));
               await attempt('key ==effects on the item', (actor, item) => item.update({ '==effects': [] }));
               await attempt('operator replacement on flags', (actor) =>
                  actor.update({ flags: ForcedReplacement.create({}) }));
               await attempt('wrapper replacement on flags', (actor) =>
                  actor.update({ flags: wrap('ForcedReplacement', {}) }));
               await attempt('key ==flags', (actor) => actor.update({ '==flags': {} }));
               await attempt('key -=flags null', (actor) => actor.update({ '-=flags': null }));
               await attempt('key flags.-=scope null', (actor) => actor.update({ 'flags.-=wiretapE2e': null }));
               await attempt('key ==flags on the item', (actor, item) => item.update({ '==flags': {} }));
               await attempt('plain flags null', (actor) => actor.update({ flags: null }));
               await attempt('dotted wrapper on flags', (actor) =>
                  actor.update({
                     'flags.__$OPERATOR$__': 'ForcedReplacement',
                     'flags.value': {},
                  }));
               await attempt('dotted wrapper on items', (actor) =>
                  actor.update({
                     'items.__$OPERATOR$__': 'ForcedReplacement',
                     'items.value': [],
                  }));
               await attempt('dotted wrapper on effects', (actor, item) =>
                  item.update({
                     'effects.__$OPERATOR$__': 'ForcedReplacement',
                     'effects.value': [],
                  }));
               await attempt('effect id as dotted key null', (actor, item) =>
                  item.update({ [`effects.${item.effects.contents[0].id}`]: null }));
               await attempt('effect id as object key null', (actor, item) =>
                  item.update({ effects: { [item.effects.contents[0].id]: null } }));
               const unlinked = async (label, run) => {
                  const { actor } = await fresh(label);
                  const scene = await Scene.create({ name: `${prefix}Repr ${label}` });
                  scenes.push(scene);
                  const [token] = await scene.createEmbeddedDocuments('Token', [{
                     name: `${prefix}Repr token`,
                     actorId: actor.id,
                     actorLink: false,
                     x: 0,
                     y: 0,
                  }]);
                  await token.actor.createEmbeddedDocuments('Item', [{
                     name: `${prefix}Repr delta item`,
                     type: kind,
                  }]);
                  const before = token.delta.items.size;
                  try {
                    await run(token);
                    out[label] = `${before} -> ${scene.tokens.get(token.id).delta.items.size}`;
                  } catch (error) {
                    out[label] = `${before} -> error`;
                  }
               };
               await unlinked('delta merge with items []', (token) => token.update({ delta: { items: [] } }));
               await unlinked('delta dotted items []', (token) => token.update({ 'delta.items': [] }));
               const created = await Actor.create({
                  name: `${prefix}Repr create ==flags`,
                  type,
                  '==flags': { wiretapE2e: { k: 2 } },
               });
               made.push(created);
               out['create key ==flags'] = created.flags.wiretapE2e?.k ?? null;
               const wrapped = await Actor.create({
                  name: `${prefix}Repr create wrapper flags`,
                  type,
                  flags: wrap('ForcedReplacement', { wiretapE2e: { k: 2 } }),
               });
               made.push(wrapped);
               out['create wrapper flags'] = wrapped.flags.wiretapE2e?.k ?? null;
               try {
                  const deleted = await Actor.create({
                     name: `${prefix}Repr create -=flags`,
                     type,
                     '-=flags': null,
                  });
                  made.push(deleted);
                  out['create key -=flags'] = deleted === undefined ? 'refused' : 'created';
               } catch (error) {
                  out['create key -=flags'] = error.name;
               }
            } finally {
               await Scene.deleteDocuments(scenes.map((scene) => scene.id));
               await Actor.deleteDocuments(
                  made.filter((actor) => actor !== undefined && game.actors.has(actor.id)).map((actor) => actor.id),
               );
            }
            return out;
         },
         {
            prefix: E2E_PREFIX,
            actorType,
            itemType,
         },
      );
      expect(measured).toEqual({
         'plain items []': row(1, 1, 1, 1),
         'operator replacement on items': row(0, null, 1, null),
         'operator deletion on items': row(1, 1, 1, 1),
         'wrapper replacement on items': row(0, null, 1, null),
         'wrapper deletion on items': row(1, 1, 1, 1),
         'unknown wrapper on items': row(1, 1, 1, 1),
         'key ==items': row(0, null, 1, null),
         'key -=items null': row(1, 1, 1, 1),
         'key -=items.id null': { error: 'needs-null' },
         'plain effects []': row(1, 1, 1, 1),
         'operator replacement on effects': row(1, 0, 1, 1),
         'wrapper replacement on effects': row(1, 0, 1, 1),
         'key ==effects on the item': row(1, 0, 1, 1),
         'operator replacement on flags': row(1, 1, null, 1),
         'wrapper replacement on flags': row(1, 1, null, 1),
         'key ==flags': row(1, 1, null, 1),
         'key -=flags null': row(1, 1, 1, 1),
         'key flags.-=scope null': row(1, 1, null, 1),
         'key ==flags on the item': row(1, 1, 1, null),
         'create key ==flags': 2,
         'create wrapper flags': 2,
         'create key -=flags': 'refused',
         'plain flags null': row(1, 1, 1, 1),
         'dotted wrapper on flags': row(1, 1, null, 1),
         'dotted wrapper on items': row(0, null, 1, null),
         'dotted wrapper on effects': row(1, 0, 1, 1),
         'effect id as dotted key null': row(1, 1, 1, 1),
         'effect id as object key null': row(1, 1, 1, 1),
         'delta merge with items []': '2 -> 2',
         'delta dotted items []': '2 -> 2',
         'scene plain tokens []': 1,
         'scene key ==tokens': 0,
      });
   });

   test('runs on the Foundry build the plan was read against', async ({ page }) => {
      const version = await page.evaluate(() => game.version);
      test.info().annotations.push({
         type: 'foundry-version',
         description: version,
      });
      expect(version).toMatch(/^14\.\d+$/);
   });
});
