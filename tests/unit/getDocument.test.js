import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getBudget } from '$shared/budgets.js';
import { compileSchema } from '$shared/schemaValidate.js';
import { definitionBytes, validateScriptDefinition } from '$shared/scripts.js';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import { getDocumentDefinition } from '~/bridge/scripts/definitions.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';
import KEY_FIELDS from '~/bridge/scripts/keyFields.json';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import { installWorld, mockDocument, removeWorld } from './mockDocuments.js';

/** @type {TextEncoder} Measures serialized sizes in UTF-8 bytes. */
const ENCODER = new TextEncoder();

/**
 * Measure a value as the JSON text a tool returns.
 * @param {unknown} value - The value to measure.
 * @returns {number} The UTF-8 byte length of its JSON.
 */
function bytes(value) {
   return ENCODER.encode(JSON.stringify(value)).length;
}

/** @type {(params: unknown) => Promise<any>} The callTool handler over a registry of the shipped scripts. */
let callTool;

/**
 * Call get_document.
 * @param {Record<string, unknown>} args - The arguments.
 * @returns {Promise<any>} The result.
 */
function get(args) {
   return callTool({
      name: 'get_document',
      arguments: args,
   });
}

/**
 * Build the stored data of a synthetic titan-like actor with embedded items.
 * @param {number} [items] - How many embedded items.
 * @returns {Record<string, unknown>} The source fields.
 */
function actorSource(items = 3) {
   return {
      system: {
         inspiration: true,
         xp: { earned: 12 },
         attribute: { body: { baseValue: 3 } },
         resource: {
            stamina: { value: 6 },
            resolve: { value: 1 },
         },
         bio: { description: 'MOCK_BIO' },
      },
      ownership: { default: 0 },
      items: Array.from({ length: items }, (_, index) => ({
         _id: `MOCKITEM${String(index).padStart(8, '0')}`,
         name: `MOCK_item_${index}`,
         type: 'weapon',
         system: { quantity: index },
      })),
      effects: [],
   };
}

/**
 * Install a world holding one actor and return it.
 * @param {Partial<import('./mockDocuments.js').MockDocumentOptions>} [overrides] - Fields replacing the defaults.
 * @param {string} [systemId] - The mocked system id.
 * @returns {import('./mockDocuments.js').MockDocument} The installed actor `MOCKACTOR0000001`.
 */
function worldWithActor(overrides = {}, systemId = 'titan') {
   const actor = mockDocument(
      {
         documentName: 'Actor',
         id: 'MOCKACTOR0000001',
         name: 'MOCK_Actor',
         type: 'player',
         source: actorSource(),
         modifiedTime: 1000,
         ...overrides,
      },
      vi.fn,
   );
   installWorld({ documents: [actor] }, vi.fn);
   globalThis.game.system.id = systemId;
   return actor;
}

beforeEach(() => {
   const registry = createScriptRegistry({ log: () => {} });
   registerShippedScripts(registry);
   callTool = createCallTool({ registry });
});

afterEach(() => {
   removeWorld();
});

describe('get_document definition', () => {
   it('is a read-only api script within the definition, description and result budgets', () => {
      const outcome = validateScriptDefinition(getDocumentDefinition, 'shipped');
      expect(outcome.ok).toBe(true);
      expect(outcome.warnings).toEqual([]);
      expect(getDocumentDefinition.mutates).toBe(false);
      expect(getDocumentDefinition.requires).toBe('api');
      expect(getDocumentDefinition.gate).toBeUndefined();
      expect(getDocumentDefinition.result.budgetBytes).toBe(getBudget('RESULT_HARD_CAP_MAX_BYTES').value);
      /** @type {import('$shared/scripts.js').ScriptDefinition} The definition under test. */
      const { name, description, inputSchema } = getDocumentDefinition;
      expect(definitionBytes(name, description, compileSchema(inputSchema).listed)).toBeLessThanOrEqual(
         getBudget('DEFINITION_MAX_BYTES').value,
      );
      expect(description.length).toBeLessThanOrEqual(getBudget('DESCRIPTION_TARGET_CHARS').value);
   });

   it('declares maxBytes as an optional integer up to 16000 and bounds both path lists at 20', () => {
      /** @type {{ properties: Record<string, any>, required: string[] }} The input schema under test. */
      const { properties, required } = getDocumentDefinition.inputSchema;
      expect(properties.maxBytes).toMatchObject({
         type: 'integer',
         maximum: getBudget('RESULT_HARD_CAP_MAX_BYTES').value,
      });
      expect(required ?? []).not.toContain('maxBytes');
      expect(properties.paths.maxItems).toBe(getBudget('PATHS_PER_CALL_MAX').value);
      expect(properties.fields.maxItems).toBe(getBudget('PATHS_PER_CALL_MAX').value);
   });
});

describe('get_document argument validation', () => {
   it('refuses what the schema bounds before any document is read', async () => {
      worldWithActor();
      const twentyOne = Array.from({ length: 21 }, (_, index) => `name${index}`);
      for (const args of [
         {
            uuid: 'Actor.MOCKACTOR0000001',
            paths: twentyOne,
         },
         {
            uuid: 'Actor.MOCKACTOR0000001',
            fields: twentyOne,
         },
         {
            uuid: 'Actor.MOCKACTOR0000001',
            maxBytes: 16001,
         },
         {
            uuid: 'Actor.MOCKACTOR0000001',
            maxBytes: 12.5,
         },
         {
            uuid: 'Actor.MOCKACTOR0000001',
            mode: 'huge',
         },
         { uuid: 5 },
      ]) {
         await expect(get(args)).rejects.toMatchObject({ code: 'ARGS_INVALID' });
      }
      expect(globalThis.fromUuid).not.toHaveBeenCalled();
   });

   it('accepts maxBytes of 16000', async () => {
      worldWithActor();
      await expect(
         get({
            uuid: 'Actor.MOCKACTOR0000001',
            maxBytes: 16000,
         }),
      ).resolves.toBeTypeOf('object');
   });

   it('refuses combinations that have no single meaning', async () => {
      worldWithActor();
      const uuid = 'Actor.MOCKACTOR0000001';
      for (const args of [
         {
            uuid,
            paths: ['name'],
            fields: ['name'],
         },
         {
            uuid,
            mode: 'full',
            paths: ['name'],
         },
         {
            uuid,
            mode: 'full',
            fields: ['name'],
         },
         {
            uuid,
            derived: true,
         },
         {
            uuid,
            derived: true,
            mode: 'full',
         },
         {
            uuid,
            documentName: 'Actor',
            id: 'MOCKACTOR0000001',
         },
         {},
         { documentName: 'Actor' },
      ]) {
         await expect(get(args)).rejects.toMatchObject({ code: 'ARGS_INVALID' });
      }
   });

   it('answers DOC_NOT_FOUND for a missing document', async () => {
      worldWithActor();
      await expect(get({ uuid: 'Actor.MOCKMISSING00001' })).rejects.toMatchObject({ code: 'DOC_NOT_FOUND' });
   });
});

describe('get_document compact view', () => {
   it('shows uuid, name, type, the subtype key leaves, the modified time and the item tuples', async () => {
      worldWithActor();
      const view = await get({ uuid: 'Actor.MOCKACTOR0000001' });
      expect(view).toMatchObject({
         uuid: 'Actor.MOCKACTOR0000001',
         name: 'MOCK_Actor',
         type: 'player',
         modified: 1000,
         fields: {
            'system.inspiration': true,
            'system.xp.earned': 12,
            'system.attribute.body.baseValue': 3,
            'system.resource.stamina.value': 6,
         },
      });
      expect(view.fields['system.bio.description']).toBeUndefined();
      expect(view.embedded.items.total).toBe(3);
      expect(view.embedded.items.rows[0]).toEqual([
         'MOCKITEM00000000',
         'MOCK_item_0',
         'weapon',
      ]);
      expect(bytes(view)).toBeLessThanOrEqual(getBudget('COMPACT_VIEW_MAX_BYTES').value);
   });

   it('is the default for a world id read, a pack read and an embedded read', async () => {
      const actor = worldWithActor();
      const child = mockDocument(
         {
            documentName: 'Item',
            id: 'MOCKITEM00000009',
            type: 'weapon',
            source: { system: { value: 4 } },
         },
         vi.fn,
      );
      installWorld(
         {
            documents: [actor],
            embedded: { [actor.uuid]: [child] },
            packs: { 'mock.items': [child] },
         },
         vi.fn,
      );
      globalThis.game.system.id = 'titan';
      expect((await get({
         documentName: 'Actor',
         id: 'MOCKACTOR0000001',
      })).name).toBe('MOCK_Actor');
      const embedded = await get({
         documentName: 'Item',
         id: 'MOCKITEM00000009',
         parentUuid: actor.uuid,
      });
      expect(embedded.fields['system.value']).toBe(4);
      const packed = await get({
         documentName: 'Item',
         id: 'MOCKITEM00000009',
         pack: 'mock.items',
      });
      expect(packed.type).toBe('weapon');
   });

   it('uses the default key-name pattern for a system without lists', async () => {
      worldWithActor(
         {
            source: {
               system: {
                  hp: {
                     value: 7,
                     max: 9,
                  },
                  notes: 'MOCK_NOTES',
               },
            },
         },
         'mock-other-system',
      );
      const view = await get({ uuid: 'Actor.MOCKACTOR0000001' });
      expect(view.fields).toEqual({
         'system.hp.value': 7,
         'system.hp.max': 9,
      });
   });

   it('holds 2 KB for every listed subtype with every key leaf at its longest and 120 long-named items', async () => {
      for (const [systemId, lists] of Object.entries(KEY_FIELDS)) {
         for (const [pair, paths] of Object.entries(lists)) {
            const [documentName, type] = pair.split('.');
            const system = {};
            for (const keyPath of paths) {
               const names = keyPath.split('.');
               let node = system;
               for (const name of names.slice(0, -1)) {
                  node[name] ??= {};
                  node = node[name];
               }
               node[names.at(-1)] = 'V'.repeat(200);
            }
            const document = mockDocument(
               {
                  documentName,
                  id: 'MOCKDOCUMENT0001',
                  name: 'N'.repeat(200),
                  type,
                  source: {
                     system,
                     items: Array.from({ length: 120 }, (_, index) => ({
                        _id: `MOCKITEM${String(index).padStart(8, '0')}`,
                        name: `MOCK_long_item_${index}_xxxxxxxxxxxxxxxx`,
                        type: 'weapon',
                     })),
                  },
                  modifiedTime: 1_760_000_000_000,
               },
               vi.fn,
            );
            installWorld({ documents: [document] }, vi.fn);
            globalThis.game.system.id = systemId;
            const view = await get({ uuid: document.uuid });
            expect(bytes(view), pair).toBeLessThanOrEqual(getBudget('COMPACT_VIEW_MAX_BYTES').value);
            expect(Object.keys(view.fields ?? {}).length, pair).toBeLessThanOrEqual(24);
         }
      }
   });
});

describe('get_document ifModifiedSince', () => {
   it('answers a tiny unchanged ack when the document is not newer', async () => {
      worldWithActor({ modifiedTime: 1000 });
      for (const since of [
         1000,
         5000,
      ]) {
         expect(
            await get({
               uuid: 'Actor.MOCKACTOR0000001',
               ifModifiedSince: since,
            }),
         ).toEqual({ unchanged: true });
      }
   });

   it('returns the view when the document is newer, or has no modified time', async () => {
      worldWithActor({ modifiedTime: 1000 });
      expect(
         (
            await get({
               uuid: 'Actor.MOCKACTOR0000001',
               ifModifiedSince: 999,
            })
         ).name,
      ).toBe('MOCK_Actor');
      worldWithActor({ modifiedTime: null });
      expect(
         (
            await get({
               uuid: 'Actor.MOCKACTOR0000001',
               ifModifiedSince: 999999,
            })
         ).name,
      ).toBe('MOCK_Actor');
   });

   it('applies to paths and full reads too', async () => {
      worldWithActor({ modifiedTime: 1000 });
      for (const extra of [
         { paths: ['name'] },
         { fields: ['name'] },
         { mode: 'full' },
      ]) {
         expect(
            await get({
               uuid: 'Actor.MOCKACTOR0000001',
               ifModifiedSince: 1000,
               ...extra,
            }),
         ).toEqual({ unchanged: true });
      }
   });

   it('never answers unchanged for an unreadable document', async () => {
      const setting = mockDocument(
         {
            documentName: 'Setting',
            id: 'MOCKSETTING00001',
            modifiedTime: 1,
         },
         vi.fn,
      );
      setting.key = 'wiretap.allowUserWrites';
      installWorld({ documents: [setting] }, vi.fn);
      await expect(
         get({
            uuid: setting.uuid,
            ifModifiedSince: 99999,
         }),
      ).rejects.toMatchObject({ code: 'DOC_EXCLUDED' });
   });
});

describe('get_document fields and paths', () => {
   it('projects fields in nested form and lists the missing ones', async () => {
      worldWithActor();
      const result = await get({
         uuid: 'Actor.MOCKACTOR0000001',
         fields: [
            'system.resource.stamina',
            'system.nope',
         ],
      });
      expect(result).toEqual({
         fields: { system: { resource: { stamina: { value: 6 } } } },
         missing: ['system.nope'],
      });
   });

   it('slices system.attributes-style paths and items.*.name keyed by _id', async () => {
      worldWithActor();
      const result = await get({
         uuid: 'Actor.MOCKACTOR0000001',
         paths: [
            'system.resource',
            'items.*.name',
            'items.MOCKITEM00000001.system.quantity',
            'system.absent',
         ],
      });
      expect(result.values['system.resource']).toEqual({
         stamina: { value: 6 },
         resolve: { value: 1 },
      });
      expect(result.values['items.*.name']).toEqual({
         MOCKITEM00000000: 'MOCK_item_0',
         MOCKITEM00000001: 'MOCK_item_1',
         MOCKITEM00000002: 'MOCK_item_2',
      });
      expect(result.values['items.MOCKITEM00000001.system.quantity']).toBe(1);
      expect(result.missing).toEqual(['system.absent']);
   });

   it('turns a refused path into its code and a short message', async () => {
      worldWithActor();
      await expect(get({
         uuid: 'Actor.MOCKACTOR0000001',
         paths: ['__proto__.x'],
      })).rejects.toMatchObject({
         code: 'PATH_UNSAFE_SEGMENT',
      });
      await expect(get({
         uuid: 'Actor.MOCKACTOR0000001',
         fields: ['items.*.name'],
      })).rejects.toMatchObject({
         code: 'PATH_INVALID',
      });
   });

   it('reads prepared values when derived and stored values otherwise', async () => {
      worldWithActor({
         source: { system: { hp: { max: 1 } } },
         prepared: { system: { hp: { max: 9 } } },
      });
      const stored = await get({
         uuid: 'Actor.MOCKACTOR0000001',
         paths: ['system.hp.max'],
      });
      expect(stored.values['system.hp.max']).toBe(1);
      const prepared = await get({
         uuid: 'Actor.MOCKACTOR0000001',
         paths: ['system.hp.max'],
         derived: true,
      });
      expect(prepared.values['system.hp.max']).toBe(9);
      const projected = await get({
         uuid: 'Actor.MOCKACTOR0000001',
         fields: ['system.hp.max'],
         derived: true,
      });
      expect(projected.fields.system.hp.max).toBe(9);
   });
});

describe('get_document full mode', () => {
   it('returns the whole canonical export with ids, ownership and the uuid', async () => {
      worldWithActor();
      const full = await get({
         uuid: 'Actor.MOCKACTOR0000001',
         mode: 'full',
      });
      expect(full._id).toBe('MOCKACTOR0000001');
      expect(full.uuid).toBe('Actor.MOCKACTOR0000001');
      expect(full.ownership).toEqual({ default: 0 });
      expect(full.items).toHaveLength(3);
      expect(full.system.bio.description).toBe('MOCK_BIO');
   });

   it('leaves the size to the sidecar: a large export is returned whole', async () => {
      worldWithActor({ source: actorSource(1500) });
      const full = await get({
         uuid: 'Actor.MOCKACTOR0000001',
         mode: 'full',
      });
      expect(full.items).toHaveLength(1500);
      expect(bytes(full)).toBeGreaterThan(getBudget('RESULT_HARD_CAP_MAX_BYTES').value);
   });
});

describe('get_document exclusions', () => {
   /**
    * Install a world with a User holding password fields.
    * @returns {import('./mockDocuments.js').MockDocument} The installed user `MOCKUSER00000001`.
    */
   function worldWithUser() {
      const user = mockDocument(
         {
            documentName: 'User',
            id: 'MOCKUSER00000001',
            name: 'MOCK_User',
            source: {
               role: 4,
               password: 'MOCK_HASH',
               passwordSalt: 'MOCK_SALT',
            },
         },
         vi.fn,
      );
      installWorld({ documents: [user] }, vi.fn);
      return user;
   }

   it('lists a password path in missing and never returns the value, in every read mode', async () => {
      const user = worldWithUser();
      const paths = await get({
         uuid: user.uuid,
         paths: [
            'password',
            'passwordSalt',
            'role',
         ],
      });
      expect(paths).toEqual({
         values: { role: 4 },
         missing: [
            'password',
            'passwordSalt',
         ],
      });
      const derived = await get({
         uuid: user.uuid,
         paths: ['password'],
         derived: true,
      });
      expect(derived).toEqual({
         values: {},
         missing: ['password'],
      });
      const fields = await get({
         uuid: user.uuid,
         fields: [
            'password',
            'role',
         ],
      });
      expect(fields).toEqual({
         fields: { role: 4 },
         missing: ['password'],
      });
      for (const args of [
         { mode: 'full' },
         {},
         {
            fields: ['password'],
            derived: true,
         },
      ]) {
         const text = JSON.stringify(await get({
            uuid: user.uuid,
            ...args,
         }));
         expect(text).not.toContain('MOCK_HASH');
         expect(text).not.toContain('MOCK_SALT');
      }
   });

   it('refuses a wiretap setting in every read mode and reads another setting', async () => {
      const secret = mockDocument(
         {
            documentName: 'Setting',
            id: 'MOCKSETTING00001',
            source: { value: 'true' },
         },
         vi.fn,
      );
      secret.key = 'wiretap.allowMacroExecution';
      const other = mockDocument(
         {
            documentName: 'Setting',
            id: 'MOCKSETTING00002',
            source: { value: '1' },
         },
         vi.fn,
      );
      other.key = 'core.mock';
      installWorld({ documents: [
         secret,
         other,
      ] }, vi.fn);
      for (const args of [
         {},
         { mode: 'full' },
         { paths: ['value'] },
         {
            paths: ['value'],
            derived: true,
         },
         { fields: ['value'] },
      ]) {
         await expect(get({
            uuid: secret.uuid,
            ...args,
         })).rejects.toMatchObject({ code: 'DOC_EXCLUDED' });
      }
      await expect(
         get({
            documentName: 'Setting',
            id: 'MOCKSETTING00001',
         }),
      ).rejects.toMatchObject({ code: 'DOC_EXCLUDED' });
      expect(secret.toCompendium).not.toHaveBeenCalled();
      expect(secret.toObject).not.toHaveBeenCalled();
      expect((await get({
         uuid: other.uuid,
         paths: ['value'],
      })).values.value).toBe('1');
   });
});
