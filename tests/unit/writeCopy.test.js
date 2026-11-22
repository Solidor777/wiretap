import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { copyDataFromUuids } from '~/bridge/scripts/writeCopy.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {string} The id of the compendium pack that holds the pack sources. */
const PACK_ID = 'world.mockpack';

/**
 * The stored fields every kind of source carries and no copy may keep.
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
   world = installWriteWorld(vi.fn);
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
 * Add a document to a compendium pack of the mock world, reachable by its `Compendium.<pack>.<Class>.<id>` uuid.
 * @param {string} documentName - The class name.
 * @param {Record<string, unknown>} data - The source data.
 * @returns {object} The pack document.
 */
function addPacked(documentName, data) {
   /** @type {object} The document, held by the pack. */
   const document = world.add(documentName, data, { pack: PACK_ID });
   /** @type {string} The uuid of a document inside a compendium pack. */
   const uuid = `Compendium.${PACK_ID}.${documentName}.${document.id}`;
   Object.defineProperty(document, 'uuid', { value: uuid });
   world.byUuid.set(uuid, document);
   return document;
}

/**
 * Add a source of one kind carrying the given data: a world Actor, a pack Actor or an Item embedded in an Actor.
 * @param {'world' | 'pack' | 'embedded'} kind - Where the source lives.
 * @param {Record<string, unknown>} data - What the source stores.
 * @returns {{ source: object, documentName: string }} The source and its class.
 */
function addSource(kind, data) {
   if (kind === 'world') {
      return {
         source: world.add('Actor', data),
         documentName: 'Actor',
      };
   }
   if (kind === 'pack') {
      return {
         source: addPacked('Actor', data),
         documentName: 'Actor',
      };
   }
   /** @type {object} The parent of the embedded source. */
   const parent = world.add('Actor', {
      name: 'MOCK_parent',
      type: 'npc',
   });
   return {
      source: world.addChild(parent, 'Item', data),
      documentName: 'Item',
   };
}

/**
 * Run `copyDataFromUuids` and return what it threw.
 * @param {object} params - The parameters.
 * @returns {Promise<Error>} The error.
 */
async function failure(params) {
   try {
      await copyDataFromUuids(params);
   } catch (error) {
      return error;
   }
   throw new Error('copyDataFromUuids did not throw');
}

describe('copyDataFromUuids', () => {
   it('returns one data object per uuid in fromUuids order', async () => {
      /** @type {object} The first source. */
      const first = world.add('Actor', {
         name: 'MOCK_first',
         type: 'npc',
      });
      /** @type {object} The second source. */
      const second = world.add('Actor', {
         name: 'MOCK_second',
         type: 'npc',
      });
      /** @type {Record<string, unknown>[]} One create data object per uuid. */
      const copies = await copyDataFromUuids({
         documentName: 'Actor',
         fromUuids: [
            second.uuid,
            first.uuid,
            second.uuid,
         ],
      });
      expect(copies.map((copy) => copy.name)).toEqual([
         'MOCK_second',
         'MOCK_first',
         'MOCK_second',
      ]);
      expect(copies[0]).not.toBe(copies[2]);
   });

   it('clears _id unless keepId, and keeps it with keepId', async () => {
      /** @type {object} The document copied twice. */
      const source = world.add('Actor', {
         name: 'MOCK_actor',
         type: 'npc',
      });
      /** @type {Record<string, unknown>[]} The copies without keepId. */
      const fresh = await copyDataFromUuids({
         documentName: 'Actor',
         fromUuids: [source.uuid],
      });
      expect(Object.hasOwn(fresh[0], '_id')).toBe(false);
      /** @type {Record<string, unknown>[]} The copies with keepId. */
      const kept = await copyDataFromUuids({
         documentName: 'Actor',
         fromUuids: [source.uuid],
         keepId: true,
      });
      expect(kept[0]._id).toBe(source.id);
   });

   it.each([
      'world',
      'pack',
      'embedded',
   ])('clears folder, sort and ownership, and keeps the rest, for a %s source', async (kind) => {
      /** @type {{ source: object, documentName: string }} The source and its class. */
      const { source, documentName } = addSource(kind, {
         name: 'MOCK_source',
         type: 'npc',
         ...structuredClone(PLACED),
         system: { hp: 3 },
      });
      /** @type {Record<string, unknown>[]} The copies. */
      const [copy] = await copyDataFromUuids({
         documentName,
         fromUuids: [source.uuid],
         keepId: true,
      });
      expect(Object.hasOwn(copy, 'folder')).toBe(false);
      expect(Object.hasOwn(copy, 'sort')).toBe(false);
      expect(Object.hasOwn(copy, 'ownership')).toBe(false);
      expect(copy.system).toEqual({ hp: 3 });
      expect(copy.name).toBe('MOCK_source');
      expect(copy._id).toBe(source.id);
   });

   it('clears the ownership of embedded documents too', async () => {
      /** @type {object} The source actor. */
      const source = world.add('Actor', {
         name: 'MOCK_actor',
         type: 'npc',
      });
      world.addChild(source, 'Item', {
         name: 'MOCK_item',
         type: 'gear',
         sort: 7,
         ownership: {
            default: 0,
            MOCKUSER00000001: 3,
         },
      });
      /** @type {Record<string, unknown>[]} The copies. */
      const [copy] = await copyDataFromUuids({
         documentName: 'Actor',
         fromUuids: [source.uuid],
      });
      expect(copy.items).toHaveLength(1);
      expect(Object.hasOwn(copy.items[0], 'ownership')).toBe(false);
      expect(copy.items[0].sort).toBe(7);
   });

   it('sets _stats.compendiumSource to the source uuid for a pack source only', async () => {
      /** @type {object} The pack source. */
      const packed = addPacked('Actor', {
         name: 'MOCK_packed',
         type: 'npc',
      });
      /** @type {object} The world source, itself once imported from a pack. */
      const local = world.add('Actor', {
         name: 'MOCK_local',
         type: 'npc',
         _stats: {
            compendiumSource: 'Compendium.world.other.Actor.MOCKOLD000000001',
            duplicateSource: 'Actor.MOCKOLD000000002',
            createdTime: 1,
         },
      });
      /** @type {Record<string, unknown>[]} The copies. */
      const [fromPack, fromWorld] = await copyDataFromUuids({
         documentName: 'Actor',
         fromUuids: [
            packed.uuid,
            local.uuid,
         ],
      });
      expect(fromPack._stats.compendiumSource).toBe(`Compendium.${PACK_ID}.Actor.${packed.id}`);
      expect(fromWorld._stats).toEqual({ createdTime: 1 });
   });

   it('removes flags.wiretap from the copy and from embedded documents, and keeps other flags', async () => {
      /** @type {object} The source carrying an idempotency record. */
      const source = world.add('Actor', {
         name: 'MOCK_actor',
         type: 'npc',
         flags: {
            wiretap: {
               idem: {
                  k: 'MOCK-key',
                  i: 0,
                  n: 1,
               },
            },
            mockmodule: { note: 'kept' },
         },
      });
      world.addChild(source, 'Item', {
         name: 'MOCK_item',
         type: 'gear',
         flags: {
            wiretap: { idem: { k: 'MOCK-key' } },
            mockmodule: { level: 2 },
         },
      });
      /** @type {Record<string, unknown>[]} The copies. */
      const [copy] = await copyDataFromUuids({
         documentName: 'Actor',
         fromUuids: [source.uuid],
      });
      expect(copy.flags).toEqual({ mockmodule: { note: 'kept' } });
      expect(copy.items[0].flags).toEqual({ mockmodule: { level: 2 } });
   });

   it('does not mutate the source', async () => {
      /** @type {object} The document whose data must stay as it was. */
      const source = world.add('Actor', {
         name: 'MOCK_actor',
         type: 'npc',
         ...structuredClone(PLACED),
         flags: { wiretap: { idem: { k: 'MOCK-key' } } },
      });
      world.addChild(source, 'Item', {
         name: 'MOCK_item',
         type: 'gear',
         ownership: { default: 1 },
      });
      /** @type {Record<string, unknown>} The data before the copy. */
      const before = source.toObject();
      await copyDataFromUuids({
         documentName: 'Actor',
         fromUuids: [source.uuid],
      });
      expect(source.toObject()).toEqual(before);
   });

   it('refuses a missing source with DOC_NOT_FOUND naming the uuid, and calls no create', async () => {
      /** @type {object} A source that exists. */
      const source = world.add('Actor', {
         name: 'MOCK_actor',
         type: 'npc',
      });
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName: 'Actor',
         fromUuids: [
            source.uuid,
            'Actor.MOCKMISSING00001',
         ],
      });
      expect(error.code).toBe('DOC_NOT_FOUND');
      expect(error.message).toContain('Actor.MOCKMISSING00001');
      expect(world.calls).toEqual([]);
   });

   it('refuses a source of another class with ARGS_INVALID naming the index', async () => {
      /** @type {{ source: object }} An embedded Item. */
      const { source: item } = addSource('embedded', {
         name: 'MOCK_item',
         type: 'gear',
      });
      /** @type {object} A source of a class other than the one asked for. */
      const actor = world.add('Actor', {
         name: 'MOCK_actor',
         type: 'npc',
      });
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName: 'Item',
         fromUuids: [
            item.uuid,
            actor.uuid,
         ],
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('fromUuids.1');
      expect(error.message).toContain('Actor');
      expect(error.message).toContain('Item');
      expect(world.calls).toEqual([]);
   });

   it('refuses a User copy with ARGS_INVALID before resolving anything', async () => {
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName: 'User',
         fromUuids: ['User.MOCKUSER00000001'],
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('fromUuids does not copy a User');
      expect(globalThis.fromUuid).not.toHaveBeenCalled();
   });

   it('refuses a credential Setting and a wiretap.* Setting with DOC_EXCLUDED', async () => {
      for (const key of [
         'mockmodule.apiKey',
         'wiretap.allowDelete',
      ]) {
         /** @type {object} A Setting no read may see. */
         const setting = world.add('Setting', {
            key,
            value: '"MOCK_value"',
         });
         /** @type {Error} The refusal. */
         const error = await failure({
            documentName: 'Setting',
            fromUuids: [setting.uuid],
         });
         expect(error.code).toBe('DOC_EXCLUDED');
         expect(error.message).not.toContain('MOCK_value');
      }
      expect(world.calls).toEqual([]);
   });

   it.each([
      [[]],
      ['MOCK'],
      [Array.from({ length: 51 }, (_, i) => `Actor.MOCK${i}`)],
      [[42]],
   ])('refuses fromUuids %j', async (fromUuids) => {
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName: 'Actor',
         fromUuids,
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toBe('Give 1 to 50 fromUuids.');
      expect(globalThis.fromUuid).not.toHaveBeenCalled();
   });

   it('bounds a long uuid in the not-found message to 256 bytes', async () => {
      /** @type {Error} The refusal. */
      const error = await failure({
         documentName: 'Actor',
         fromUuids: [`Actor.${'x'.repeat(4000)}`],
      });
      expect(error.code).toBe('DOC_NOT_FOUND');
      expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThanOrEqual(256);
   });
});
