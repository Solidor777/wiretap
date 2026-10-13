import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { recordGateSettings, restoreGateSettings } from './gates.js';
import {
   E2E_PREFIX,
   E2E_SETTING_KEY_PREFIX,
   assertSettled,
   recordDocument,
   settleRegistry,
   teardownRecorded,
} from './registry.js';
import KEY_FIELDS from '../../src/bridge/scripts/keyFields.json' with { type: 'json' };

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {number} The compact view budget, in UTF-8 bytes. */
const COMPACT_MAX = 2000;

/** @type {RegExp} A Foundry document id. */
const ID_PATTERN = /^[A-Za-z0-9]{16}$/;

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
   const text = result.content[0].text;
   return {
      isError: result.isError === true,
      text,
      bytes: new TextEncoder().encode(text).length,
   };
}

/**
 * Call get_document and parse its JSON result, failing the test when the call failed.
 * @param {object} args - The arguments.
 * @returns {Promise<any>} The parsed result.
 */
async function readJson(args) {
   const call = await callText('get_document', args);
   expect(call.isError, call.text).toBe(false);
   return JSON.parse(call.text);
}

/**
 * Create an Actor through the create_actor tool, record it for teardown and return its uuid.
 * @param {import('@playwright/test').Page} page - The Foundry page.
 * @returns {Promise<string>} The actor uuid.
 */
async function createRecordedActor(page) {
   const call = await callText('create_actor', { name: `${E2E_PREFIX}Read ${Date.now()}` });
   expect(call.isError, call.text).toBe(false);
   const reply = JSON.parse(call.text);
   await recordDocument(page, {
      documentName: 'Actor',
      id: reply.uuid.split('.').pop(),
      uuid: reply.uuid,
      createdBy: 'readTools.spec',
   });
   return reply.uuid;
}

test.describe('wiretap core read tools', () => {
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
            'create_actor',
            'get_document',
            'list_document_types',
         ]),
      );
   });

   test.afterEach(async ({ page }) => {
      await client?.close();
      client = undefined;
      const settled = await settleRegistry(page);
      await restoreGateSettings(page);
      assertSettled(settled);
   });

   test('reads a created actor: compact, paths, derived, ifModifiedSince, full and handle', async ({ page }) => {
      const uuid = await createRecordedActor(page);
      // Ten embedded items make the full export larger than the 8,000-byte default cap, and an effect adds 3 to a base
      // value so the prepared data differs from the stored data. All of them are removed with the recorded actor.
      const prepared = await page.evaluate(async (actorUuid) => {
         const actor = await fromUuid(actorUuid);
         const itemType = game.documentTypes.Item.find((type) => type !== CONST.BASE_DOCUMENT_TYPE);
         await actor.createEmbeddedDocuments(
            'Item',
            Array.from({ length: 10 }, (_, index) => ({
               name: `Wiretap E2E item ${index}`,
               type: itemType,
            })),
         );
         await actor.createEmbeddedDocuments('ActiveEffect', [
            {
               name: 'Wiretap E2E effect',
               type: 'effect',
               changes: [
                  {
                     key: 'system.attribute.body.baseValue',
                     mode: CONST.ACTIVE_EFFECT_MODES.ADD,
                     value: '3',
                  },
               ],
            },
         ]);
         return {
            sourceBytes: JSON.stringify(actor.toObject()).length,
            stored: actor._source.system.attribute.body.baseValue,
            prepared: actor.toObject(false).system.attribute.body.baseValue,
         };
      }, uuid);
      expect(prepared.sourceBytes).toBeGreaterThan(8000);
      expect(prepared.sourceBytes).toBeLessThan(16000);
      expect(prepared.prepared).not.toBe(prepared.stored);

      // Compact: within 2 KB, with the key leaves of the subtype and the item tuples with their total.
      const compact = await callText('get_document', { uuid });
      expect(compact.isError, compact.text).toBe(false);
      expect(compact.bytes).toBeLessThanOrEqual(COMPACT_MAX);
      const view = JSON.parse(compact.text);
      expect(view.uuid).toBe(uuid);
      expect(view.embedded.items.total).toBe(10);
      expect(view.embedded.items.rows[0]).toEqual([
         expect.stringMatching(ID_PATTERN),
         'Wiretap E2E item 0',
         expect.any(String),
      ]);
      expect(Object.keys(view.fields)).toEqual(
         expect.arrayContaining([
            'system.resource.stamina.value',
            'system.attribute.body.baseValue',
         ]),
      );
      expect(typeof view.modified).toBe('number');

      // Paths: a system slice and items.*.name keyed by _id.
      const slices = await readJson({
         uuid,
         paths: [
            'system.resource',
            'items.*.name',
            'system.nope',
         ],
      });
      expect(slices.values['system.resource'].stamina).toBeDefined();
      expect(Object.values(slices.values['items.*.name'])).toHaveLength(10);
      expect(Object.keys(slices.values['items.*.name']).every((id) => ID_PATTERN.test(id))).toBe(true);
      expect(slices.missing).toEqual(['system.nope']);

      // Derived: stored data without the flag, prepared data with it.
      const baseValue = ['system.attribute.body.baseValue'];
      const stored = await readJson({
         uuid,
         paths: baseValue,
      });
      const derived = await readJson({
         uuid,
         paths: baseValue,
         derived: true,
      });
      expect(stored.values[baseValue[0]]).toBe(prepared.stored);
      expect(derived.values[baseValue[0]]).toBe(prepared.prepared);

      // ifModifiedSince: unchanged until the document is updated.
      const unchanged = await callText('get_document', {
         uuid,
         ifModifiedSince: view.modified,
      });
      expect(JSON.parse(unchanged.text)).toEqual({ unchanged: true });
      expect(unchanged.bytes).toBeLessThanOrEqual(256);
      await page.evaluate(
         async (actorUuid) => (await fromUuid(actorUuid)).update({ name: `Wiretap E2E Read renamed ${Date.now()}` }),
         uuid,
      );
      const changed = await readJson({
         uuid,
         ifModifiedSince: view.modified,
      });
      expect(changed.modified).toBeGreaterThan(view.modified);

      // Full: over the default cap it is a handle that read_handle slices; with maxBytes 16000 it is inline.
      const full = await callText('get_document', {
         uuid,
         mode: 'full',
      });
      const handle = JSON.parse(full.text);
      expect(handle.handle).toEqual(expect.any(String));
      expect(full.bytes).toBeLessThanOrEqual(256);
      const slice = await client.callTool({
         name: 'read_handle',
         arguments: {
            handle: handle.handle,
            paths: ['items.*.name'],
         },
      });
      expect(slice.content[0].text).toContain('Wiretap E2E item 0');
      const inline = await callText('get_document', {
         uuid,
         mode: 'full',
         maxBytes: 16000,
      });
      expect(inline.isError, inline.text).toBe(false);
      expect(inline.bytes).toBeGreaterThan(8000);
      expect(inline.bytes).toBeLessThanOrEqual(16000);
      const exported = JSON.parse(inline.text);
      expect(exported._id).toBe(uuid.split('.').pop());
      expect(exported.items).toHaveLength(10);
      expect(exported.uuid).toBe(uuid);
   });

   test('enumerates every document type and reads one document of each type and subtype present', async ({ page }) => {
      await createRecordedActor(page);
      // The listing agrees with the world's own constants.
      const listing = await callText('list_document_types', {});
      expect(listing.isError, listing.text).toBe(false);
      expect(listing.bytes).toBeLessThanOrEqual(3000);
      const types = JSON.parse(listing.text);
      const world = await page.evaluate(() => ({
         all: [...CONST.ALL_DOCUMENT_TYPES],
         system: game.system.id,
         subtypes: Object.fromEntries(
            Object.entries(game.documentTypes)
               .map(([name, list]) => [
                  name,
                  list.filter((type) => type !== CONST.BASE_DOCUMENT_TYPE),
               ])
               .filter(([, list]) => list.length > 0),
         ),
      }));
      const listed = new Set([
         ...types.world,
         ...types.embedded,
         ...(types.packOnly ?? []),
      ]);
      expect([...listed].sort()).toEqual(world.all);
      expect(types.system).toBe(world.system);
      expect(types.omitted).toBeUndefined();
      expect(types.subtypes).toEqual(world.subtypes);

      // One existing document of each document class and subtype in the world, embedded documents included.
      const targets = await page.evaluate(() => {
         const found = [];
         const seen = new Set();
         const add = (document) => {
            const key = `${document.documentName}.${document.type ?? ''}`;
            if (!seen.has(key)) {
               seen.add(key);
               found.push({
                  key,
                  uuid: document.uuid,
                  documentName: document.documentName,
               });
            }
         };
         for (const name of CONST.WORLD_DOCUMENT_TYPES) {
            for (const document of game.collections.get(name) ?? []) {
               if (name === 'Setting' && document.key.startsWith('wiretap.')) {
                  continue;
               }
               add(document);
               for (const embedded of Object.keys(document.constructor.metadata.embedded ?? {})) {
                  for (const child of document.getEmbeddedCollection(embedded)) {
                     add(child);
                  }
               }
            }
         }
         return found;
      });
      const documentNames = new Set(targets.map((target) => target.documentName));
      for (const name of [
         'Actor',
         'Item',
         'Scene',
         'User',
         'Playlist',
         'Setting',
         'Folder',
      ]) {
         expect(documentNames.has(name), `the world holds a ${name}`).toBe(true);
      }
      const lists = KEY_FIELDS[world.system] ?? {};
      for (const target of targets) {
         const call = await callText('get_document', { uuid: target.uuid });
         expect(call.isError, `${target.key}: ${call.text}`).toBe(false);
         expect(call.bytes, target.key).toBeLessThanOrEqual(COMPACT_MAX);
         const view = JSON.parse(call.text);
         expect(view.uuid, target.key).toBe(target.uuid);
         if (lists[target.key] !== undefined && view.fields !== undefined) {
            const allowed = new Set(lists[target.key].map((path) => `system.${path}`));
            expect(
               Object.keys(view.fields).every((key) => allowed.has(key)),
               target.key,
            ).toBe(true);
         }
      }
   });

   test('refuses wiretap settings and never returns a User password field on the live world', async ({ page }) => {
      // The test creates its own wiretap Setting document by writing a gate, as the gates spec does; the gate's prior
      // value is restored by the afterEach restoreGateSettings (the record was taken in beforeEach).
      await page.evaluate(() => game.settings.set('wiretap', 'allowUserWrites', true));
      const ids = await page.evaluate(() => ({
         wiretap:
            game.settings.storage.get('world').find((setting) => setting.key === 'wiretap.allowUserWrites')?.uuid ??
            null,
         user: game.users.find((user) => user.isGM)?.uuid ?? null,
      }));
      expect(ids.wiretap).not.toBeNull();
      for (const args of [
         {},
         { mode: 'full' },
         { paths: ['value'] },
         { fields: ['value'] },
      ]) {
         const call = await callText('get_document', {
            uuid: ids.wiretap,
            ...args,
         });
         expect(call.isError).toBe(true);
         expect(call.text).toContain('DOC_EXCLUDED');
      }
      // The exclusion is only shown if the client really holds the fields it must not return.
      const raw = await page.evaluate((uuid) => {
         const source = fromUuidSync(uuid).toObject();
         return {
            password: Object.hasOwn(source, 'password'),
            passwordSalt: Object.hasOwn(source, 'passwordSalt'),
         };
      }, ids.user);
      expect(raw).toEqual({
         password: true,
         passwordSalt: true,
      });
      const read = await readJson({
         uuid: ids.user,
         paths: [
            'password',
            'passwordSalt',
            'role',
         ],
      });
      expect(read.values).toEqual({ role: expect.any(Number) });
      expect(read.missing).toEqual([
         'password',
         'passwordSalt',
      ]);
      const full = await callText('get_document', {
         uuid: ids.user,
         mode: 'full',
      });
      expect(full.text).not.toContain('"password"');
      expect(full.text).not.toContain('"passwordSalt"');
   });

   test('redacts secret-named keys in settings and flags and refuses secret-named settings', async ({ page }) => {
      const stamp = Date.now();
      /**
       * Create a Setting document with the given key and value and record it for teardown.
       * @param {string} key - The setting key, starting with the e2e setting prefix.
       * @param {unknown} value - The value, stored as JSON text.
       * @returns {Promise<string>} The setting uuid.
       */
      const createSetting = async (key, value) => {
         const uuid = await page.evaluate(
            async (input) => (await CONFIG.Setting.documentClass.create(input)).uuid,
            {
               key,
               value: JSON.stringify(value),
            },
         );
         await recordDocument(page, {
            documentName: 'Setting',
            id: uuid.split('.').pop(),
            uuid,
            createdBy: 'readTools.spec',
         });
         return uuid;
      };
      const config = await createSetting(`${E2E_SETTING_KEY_PREFIX}config.${stamp}`, {
         keep: 'MOCK_KEEP',
         nested: {
            password: 'MOCK_PASSWORD',
            list: [
               {
                  apiKey: 'MOCK_API_KEY',
                  fine: 1,
               },
            ],
         },
      });
      const named = await createSetting(`${E2E_SETTING_KEY_PREFIX}apiKey.${stamp}`, 'MOCK_SECRET_VALUE');

      // The value of an ordinary setting is returned with the secret-named keys dropped, on every read path.
      const full = await callText('get_document', {
         uuid: config,
         mode: 'full',
      });
      expect(full.isError, full.text).toBe(false);
      expect(full.text).toContain('MOCK_KEEP');
      expect(full.text).not.toContain('MOCK_PASSWORD');
      expect(full.text).not.toContain('MOCK_API_KEY');
      const sliced = await readJson({
         uuid: config,
         paths: ['value'],
      });
      expect(JSON.stringify(sliced)).not.toContain('MOCK_PASSWORD');

      // A setting whose key names a secret is unreadable, and is absent from searches by name and by listing.
      const refused = await callText('get_document', {
         uuid: named,
         mode: 'full',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('DOC_EXCLUDED');
      expect(refused.text).not.toContain('MOCK_SECRET_VALUE');
      const listed = await callText('search_documents', {
         documentName: 'Setting',
         query: E2E_SETTING_KEY_PREFIX,
         limit: 100,
      });
      expect(listed.isError, listed.text).toBe(false);
      expect(listed.text).toContain(`${E2E_SETTING_KEY_PREFIX}config.${stamp}`);
      expect(listed.text).not.toContain('apiKey');

      // Flags of a User and of an Actor drop secret-named keys as well.
      const actor = await createRecordedActor(page);
      const userUuid = await page.evaluate(() => game.users.find((user) => user.isGM).uuid);
      const flagged = await page.evaluate(
         async (input) => {
            const actorDocument = await fromUuid(input.actor);
            await actorDocument.update({
               flags: {
                  'wiretap-e2e': {
                     token: 'MOCK_FLAG_TOKEN',
                     keep: 'MOCK_FLAG_KEEP',
                  },
               },
            });
            return Object.keys(actorDocument.flags['wiretap-e2e']);
         },
         { actor },
      );
      expect(flagged).toContain('token');
      const flags = await readJson({
         uuid: actor,
         paths: ['flags'],
      });
      expect(JSON.stringify(flags)).toContain('MOCK_FLAG_KEEP');
      expect(JSON.stringify(flags)).not.toContain('MOCK_FLAG_TOKEN');
      expect((await callText('get_document', {
         uuid: userUuid,
         mode: 'full',
      })).text).not.toContain('"passwordSalt"');
   });

   test('reads an embedded document through its parent and a pack document through its pack', async ({ page }) => {
      const target = await page.evaluate(() => {
         const actor = game.actors.find((candidate) => candidate.items.size > 0);
         const item = actor?.items.contents[0];
         const pack = game.packs.find((candidate) => candidate.documentName === 'Item' && candidate.index.size > 0);
         return {
            parentUuid: actor?.uuid ?? null,
            itemId: item?.id ?? null,
            itemType: item?.type ?? null,
            pack: pack?.collection ?? null,
            packId: pack?.index.contents[0]?._id ?? null,
         };
      });
      expect(target.parentUuid).not.toBeNull();
      const embedded = await callText('get_document', {
         documentName: 'Item',
         id: target.itemId,
         parentUuid: target.parentUuid,
      });
      expect(embedded.isError, embedded.text).toBe(false);
      expect(JSON.parse(embedded.text).type).toBe(target.itemType);
      expect(embedded.bytes).toBeLessThanOrEqual(COMPACT_MAX);
      expect(target.pack).not.toBeNull();
      const packed = await callText('get_document', {
         documentName: 'Item',
         id: target.packId,
         pack: target.pack,
      });
      expect(packed.isError, packed.text).toBe(false);
      expect(packed.bytes).toBeLessThanOrEqual(COMPACT_MAX);
      const missing = await callText('get_document', {
         documentName: 'Item',
         id: 'DoesNotExist0000',
         pack: target.pack,
      });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('DOC_NOT_FOUND');
   });
});
