import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { getBudget } from '$shared/budgets.js';
import { definitionBytes } from '$shared/scripts.js';
import { compileSchema } from '$shared/schemaValidate.js';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import { createDocumentsDefinition } from '~/bridge/scripts/definitions.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {(params: unknown) => Promise<unknown>} The callTool handler over the shipped scripts. */
let callTool;

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values by gate name; a gate is closed unless a test opens it. */
let gates;

/** @type {string} The id of the compendium pack that holds the pack sources. */
const SOURCE_PACK_ID = 'world.mocksources';

/**
 * The stored fields a placed source carries and no copy may send.
 * @type {Record<string, unknown>}
 */
const PLACED = {
   folder: 'MOCKFOLDER000001',
   sort: 5,
   ownership: {
      default: 2,
      MOCKUSER00000001: 3,
   },
};

beforeEach(() => {
   /** @type {ReturnType<typeof createScriptRegistry>} A registry holding the shipped scripts. */
   const registry = createScriptRegistry({ log: () => {} });
   registerShippedScripts(registry);
   callTool = createCallTool({ registry });
   world = installWriteWorld(vi.fn, {
      packs: {
         'world.actors': { documentName: 'Actor' },
         'world.items': { documentName: 'Item' },
         'world.adventures': { documentName: 'Adventure' },
      },
   });
   gates = {};
   globalThis.game.settings.get = (module, key) => gates[key];
});

afterEach(() => {
   for (const name of [
      'CONST',
      'CONFIG',
      'fromUuid',
      'game',
   ]) {
      delete globalThis[name];
   }
});

/**
 * Call `create_documents` through the script dispatcher.
 * @param {Record<string, unknown>} args - The tool arguments.
 * @returns {Promise<Record<string, unknown>[]>} The acknowledgement rows.
 */
function create(args) {
   return callTool({
      name: 'create_documents',
      arguments: args,
   });
}

/**
 * Call `create_documents` where it must fail, and return the error.
 * @param {Record<string, unknown>} args - The tool arguments.
 * @returns {Promise<Error>} The error.
 */
async function failure(args) {
   try {
      await create(args);
   } catch (error) {
      return error;
   }
   throw new Error('create_documents did not throw');
}

/**
 * Add a document to a compendium pack of the mock world, reachable by its `Compendium.<pack>.<Class>.<id>` uuid.
 * @param {string} documentName - The class name.
 * @param {Record<string, unknown>} data - The source data.
 * @returns {object} The pack document.
 */
function addPacked(documentName, data) {
   /** @type {object} The document, held by the pack. */
   const document = world.add(documentName, data, { pack: SOURCE_PACK_ID });
   /** @type {string} The uuid of a document inside a compendium pack. */
   const uuid = `Compendium.${SOURCE_PACK_ID}.${documentName}.${document.id}`;
   Object.defineProperty(document, 'uuid', { value: uuid });
   world.byUuid.set(uuid, document);
   return document;
}

/**
 * Add a world Actor source.
 * @param {string} name - Its name.
 * @param {Record<string, unknown>} [extra] - More stored data.
 * @returns {object} The source.
 */
function addActor(name, extra = {}) {
   return world.add('Actor', {
      name,
      type: 'npc',
      ...extra,
   });
}

/**
 * The data the world Actor class was asked to create, per call.
 * @returns {Record<string, unknown>[][]} The data arrays sent, one per `createDocuments` call.
 */
function sentActors() {
   return world.classes.Actor.createDocuments.mock.calls.map(([data]) => data);
}

/**
 * Build an Adventure source in a pack that holds the given macros. Every content set of the mock schema is stored,
 * empty or not, as Foundry's `toObject()` of an Adventure always holds each SetField (`common/documents/adventure.mjs`
 * :41-50).
 * @param {Record<string, unknown>[]} macros - The stored macro entries.
 * @returns {object} The pack Adventure, reachable by its compendium uuid.
 */
function addAdventure(macros) {
   return addPacked('Adventure', {
      name: 'MOCK_adventure',
      actors: [
         {
            _id: 'MOCKACTOR0000001',
            name: 'MOCK_actor',
            type: 'npc',
            ownership: { default: 0 },
         },
      ],
      macros,
      scenes: [],
   });
}

describe('create_documents with fromUuids', () => {
   it('creates world copies from fromUuids and acks { uuid, name, type } per document in order', async () => {
      /** @type {object} The first source. */
      const first = addActor('MOCK_first');
      /** @type {object} The second source. */
      const second = addActor('MOCK_second');
      /** @type {Record<string, unknown>[]} The acknowledgement. */
      const rows = await create({
         documentName: 'Actor',
         fromUuids: [
            second.uuid,
            first.uuid,
         ],
      });
      expect(rows).toEqual([
         {
            uuid: expect.stringMatching(/^Actor\./),
            name: 'MOCK_second',
            type: 'npc',
         },
         {
            uuid: expect.stringMatching(/^Actor\./),
            name: 'MOCK_first',
            type: 'npc',
         },
      ]);
      expect(rows.map((row) => row.uuid)).not.toContain(first.uuid);
      expect(rows.map((row) => row.uuid)).not.toContain(second.uuid);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
   });

   it('creates embedded copies under parentUuid and copies into a pack', async () => {
      /** @type {object} The actor that holds the source item. */
      const holder = addActor('MOCK_holder');
      /** @type {object} The source item. */
      const item = world.addChild(holder, 'Item', {
         name: 'MOCK_item',
         type: 'weapon',
      });
      /** @type {object} The actor that receives the copy. */
      const target = addActor('MOCK_target');
      /** @type {Record<string, unknown>[]} The embedded acknowledgement. */
      const embedded = await create({
         documentName: 'Item',
         fromUuids: [item.uuid],
         parentUuid: target.uuid,
      });
      expect(target.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      expect(embedded[0].uuid.startsWith(`${target.uuid}.Item.`)).toBe(true);
      expect(embedded[0].name).toBe('MOCK_item');
      gates.allowCompendiumWrites = true;
      /** @type {Record<string, unknown>[]} The pack acknowledgement. */
      const packed = await create({
         documentName: 'Item',
         fromUuids: [item.uuid],
         pack: 'world.items',
      });
      expect(packed[0].name).toBe('MOCK_item');
      expect(world.classes.Item.createDocuments.mock.calls[0][1]).toMatchObject({ pack: 'world.items' });
   });

   it.each([
      [
         undefined,
         undefined,
      ],
      [
         ['{"name":"MOCK_a"}'],
         ['Item.MOCKSOURCE0001'],
      ],
   ])('refuses data %j with fromUuids %j', async (data, fromUuids) => {
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName: 'Item',
         ...(data === undefined ? {} : { data }),
         ...(fromUuids === undefined ? {} : { fromUuids }),
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('Give data or fromUuids, not both and not neither');
      expect(world.calls).toEqual([]);
   });

   it('refuses a closed gate exactly as it does for data', async () => {
      /** @type {object} The document copied. */
      const source = world.add('Item', {
         name: 'MOCK_item',
         type: 'weapon',
      });
      /** @type {Error} The refusal of the copy. */
      const copied = await failure({
         documentName: 'Item',
         fromUuids: [source.uuid],
         pack: 'world.items',
      });
      /** @type {Error} The refusal of the same create from data. */
      const given = await failure({
         documentName: 'Item',
         data: ['{"name":"MOCK_item","type":"weapon"}'],
         pack: 'world.items',
      });
      expect(copied.code).toBe(GATE_DENIED);
      expect(copied.message).toContain('allowCompendiumWrites');
      expect(copied.message).toBe(given.message);
      expect(world.calls).toEqual([]);
   });

   it('copies a source with ownership, folder and sort with every gate closed', async () => {
      /** @type {object} The placed source. */
      const source = addActor('MOCK_placed', structuredClone(PLACED));
      world.addChild(source, 'Item', {
         name: 'MOCK_item',
         type: 'weapon',
         ownership: { default: 3 },
      });
      await create({
         documentName: 'Actor',
         fromUuids: [source.uuid],
      });
      /** @type {Record<string, unknown>} The data sent for the copy. */
      const [sent] = sentActors()[0];
      expect(Object.hasOwn(sent, 'ownership')).toBe(false);
      expect(Object.hasOwn(sent, 'folder')).toBe(false);
      expect(Object.hasOwn(sent, 'sort')).toBe(false);
      expect(Object.hasOwn(sent.items[0], 'ownership')).toBe(false);
   });

   it('a dryRun copy returns rows with dryRun: true and a null uuid and creates nothing', async () => {
      /** @type {object} The document copied. */
      const source = addActor('MOCK_actor');
      /** @type {Record<string, unknown>[]} The preview. */
      const rows = await create({
         documentName: 'Actor',
         fromUuids: [source.uuid],
         dryRun: true,
      });
      expect(rows).toEqual([
         {
            uuid: null,
            name: 'MOCK_actor',
            type: 'npc',
            dryRun: true,
         },
      ]);
      expect(world.calls).toEqual([]);
   });

   it('writes nothing when one of several sources is missing', async () => {
      /** @type {object} A source that exists. */
      const source = addActor('MOCK_actor');
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName: 'Actor',
         fromUuids: [
            source.uuid,
            'Actor.MOCKMISSING00001',
         ],
      });
      expect(error.code).toBe('DOC_NOT_FOUND');
      expect(world.calls).toEqual([]);
   });

   it.each([
      [
         'a User',
         'User',
         () => ['User.MOCKUSER00000001'],
         'ARGS_INVALID',
         'fromUuids does not copy a User',
      ],
      [
         'a source of another class',
         'Item',
         () => [addActor('MOCK_actor').uuid],
         'ARGS_INVALID',
         'fromUuids.0 is of class Actor',
      ],
      [
         'a credential Setting',
         'Setting',
         () => [
            world.add('Setting', {
               key: 'mockmodule.apiKey',
               value: '"MOCK_value"',
            }).uuid,
         ],
         'DOC_EXCLUDED',
         '',
      ],
      [
         'a wiretap.* Setting',
         'Setting',
         () => [
            world.add('Setting', {
               key: 'wiretap.allowDelete',
               value: 'true',
            }).uuid,
         ],
         'DOC_EXCLUDED',
         '',
      ],
   ])('writes nothing for %s', async (label, documentName, uuids, code, text) => {
      gates.allowUserWrites = true;
      gates.allowSettingWrites = true;
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName,
         fromUuids: uuids(),
      });
      expect(error.code).toBe(code);
      expect(error.message).toContain(text);
      expect(world.calls).toEqual([]);
   });

   it.each([
      [
         [],
         'fromUuids: needs at least 1 items',
      ],
      [
         Array.from({ length: 51 }, (_, index) => `Actor.MOCK${index}`),
         'fromUuids:',
      ],
   ])('writes nothing for the fromUuids list %#', async (fromUuids, text) => {
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName: 'Actor',
         fromUuids,
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain(text);
      expect(world.calls).toEqual([]);
   });

   it('replays the first result for the same idempotencyKey and fromUuids after the source was edited', async () => {
      /** @type {object} The document copied. */
      const source = addActor('MOCK_actor');
      /** @type {Record<string, unknown>} The arguments of both calls. */
      const args = {
         documentName: 'Actor',
         fromUuids: [source.uuid],
         idempotencyKey: 'MOCK-copy-1',
      };
      /** @type {Record<string, unknown>[]} The first result. */
      const first = await create(args);
      await source.update({ name: 'MOCK_edited' });
      source.name = 'MOCK_edited';
      /** @type {Record<string, unknown>[]} The repeated result. */
      const second = await create(args);
      expect(second).toEqual(first);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
   });

   it('treats the same key with other fromUuids as IDEMPOTENCY_CONFLICT', async () => {
      /** @type {object} The first source. */
      const first = addActor('MOCK_first');
      /** @type {object} The second source. */
      const second = addActor('MOCK_second');
      await create({
         documentName: 'Actor',
         fromUuids: [first.uuid],
         idempotencyKey: 'MOCK-copy-2',
      });
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName: 'Actor',
         fromUuids: [second.uuid],
         idempotencyKey: 'MOCK-copy-2',
      });
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
   });

   /** @type {string} The name of the flags test, too long for one line with its callback. */
   const flagsTest =
      'does not pass a source flags.wiretap record on, with or without an idempotencyKey on the copy call';

   it(flagsTest, async () => {
      /** @type {object} A source that one keyed create made, carrying a complete record of this client. */
      const source = addActor('MOCK_actor', {
         flags: {
            mockmodule: { note: 'kept' },
         },
      });
      source.flags.wiretap = {
         idem: {
            k: 'MOCK-old',
            i: 0,
            n: 1,
            h: '00000000000000',
            u: globalThis.game.user.id,
            d: source.id,
         },
      };
      source._source.flags = structuredClone(source.flags);
      await create({
         documentName: 'Actor',
         fromUuids: [source.uuid],
      });
      await create({
         documentName: 'Actor',
         fromUuids: [source.uuid],
         idempotencyKey: 'MOCK-new',
      });
      /** @type {Record<string, unknown>[][]} The data of both creates. */
      const [plain, keyed] = sentActors();
      expect(plain[0].flags).toEqual({ mockmodule: { note: 'kept' } });
      expect(keyed[0].flags.mockmodule).toEqual({ note: 'kept' });
      expect(keyed[0].flags.wiretap.idem).toMatchObject({
         k: 'MOCK-new',
         i: 0,
         n: 1,
         u: globalThis.game.user.id,
         d: keyed[0]._id,
      });
      expect(keyed[0].flags.wiretap.idem.h).not.toBe('00000000000000');
   });

   it('applies keepId to the copies and refuses a taken _id', async () => {
      /** @type {object} The actor that holds the source item. */
      const holder = addActor('MOCK_holder');
      /** @type {object} The source item. */
      const item = world.addChild(holder, 'Item', {
         _id: 'MOCKITEM00000001',
         name: 'MOCK_item',
         type: 'weapon',
      });
      /** @type {object} The actor that receives the copy. */
      const target = addActor('MOCK_target');
      /** @type {Record<string, unknown>[]} The acknowledgement. */
      const rows = await create({
         documentName: 'Item',
         fromUuids: [item.uuid],
         parentUuid: target.uuid,
         keepId: true,
      });
      expect(rows[0].uuid).toBe(`${target.uuid}.Item.MOCKITEM00000001`);
      expect(target.createEmbeddedDocuments.mock.calls[0][2]).toMatchObject({ keepId: true });
      expect(target.createEmbeddedDocuments.mock.calls[0][1][0]._id).toBe('MOCKITEM00000001');
      /** @type {number} The write calls before the refused copy. */
      const before = world.calls.length;
      /** @type {Error} The refusal of a copy whose _id is already taken where it would land. */
      const error = await failure({
         documentName: 'Actor',
         fromUuids: [holder.uuid],
         keepId: true,
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('already exists');
      expect(world.calls.slice(before).filter((name) => !name.endsWith('.get'))).toEqual([]);
   });

   it('adds read-back for paths', async () => {
      /** @type {object} The document copied. */
      const source = addActor('MOCK_actor', { system: { hp: 3 } });
      /** @type {Record<string, unknown>[]} The acknowledgement. */
      const rows = await create({
         documentName: 'Actor',
         fromUuids: [source.uuid],
         paths: [
            'system.hp',
            'system.missing',
         ],
      });
      expect(rows[0].values).toEqual({ 'system.hp': 3 });
      expect(rows[0].missing).toEqual(['system.missing']);
   });

   it('copies an Adventure whose macros set is empty with every gate but the compendium gate closed', async () => {
      // An Adventure lives only in a compendium pack, so the compendium gate is the one gate open.
      gates.allowCompendiumWrites = true;
      /** @type {object} An Adventure with no macros; its data still holds the `macros` key. */
      const adventure = addAdventure([]);
      /** @type {Record<string, unknown>[]} The acknowledgement. */
      const rows = await create({
         documentName: 'Adventure',
         fromUuids: [adventure.uuid],
         pack: 'world.adventures',
      });
      expect(rows[0].name).toBe('MOCK_adventure');
   });

   it('refuses an Adventure whose macros set holds command text while allowMacroExecution is closed', async () => {
      gates.allowCompendiumWrites = true;
      /** @type {object} An Adventure holding a script macro. */
      const adventure = addAdventure([
         {
            _id: 'MOCKMACRO0000001',
            name: 'MOCK_macro',
            type: 'script',
            command: 'return 1;',
         },
      ]);
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName: 'Adventure',
         fromUuids: [adventure.uuid],
         pack: 'world.adventures',
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowMacroExecution');
      expect(world.calls).toEqual([]);
   });

   it('declares fromUuids and keeps the definition within its bounds', () => {
      expect(createDocumentsDefinition.inputSchema.properties.fromUuids).toEqual({
         type: 'array',
         minItems: 1,
         maxItems: getBudget('WRITE_DOCUMENTS_MAX').value,
         items: {
            type: 'string',
            maxLength: 256,
         },
      });
      expect(getBudget('WRITE_DOCUMENTS_MAX').value).toBe(50);
      expect(createDocumentsDefinition.inputSchema.required).toEqual(['documentName']);
      expect(createDocumentsDefinition.handleArgs).toEqual(['data']);
      /** @type {string} The tool description. */
      const description = createDocumentsDefinition.description;
      expect(description.length).toBeLessThanOrEqual(160);
      expect(description).toContain('fromUuids');
      expect(description).toContain('idempotencyKey');
      /** @type {ReturnType<typeof compileSchema>} The compiled schema. */
      const compiled = compileSchema(createDocumentsDefinition.inputSchema);
      expect(compiled.ok).toBe(true);
      expect(definitionBytes(createDocumentsDefinition.name, description, compiled.listed)).toBeLessThanOrEqual(800);
   });
});
