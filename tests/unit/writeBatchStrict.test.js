import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { batchDocuments } from '~/bridge/scripts/writeBatch.js';
import { settle } from '~/bridge/scripts/writeBatchSettle.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {object} The first of three live actors the batches address. */
let first;

/** @type {object} The second live actor. */
let second;

/** @type {object} The third live actor. */
let third;

/** @type {object} A live actor with an item. */
let owner;

/** @type {object} The item of that actor. */
let sword;

beforeEach(() => {
   world = installWriteWorld(vi.fn, {
      users: [
         {
            id: 'MOCKGM0000000001',
            role: 4,
            name: 'MOCK_gm',
         },
      ],
      userId: 'MOCKGM0000000001',
   });
   globalThis.game.settings.get = (module, key) => key === 'allowDelete';
   first = world.add('Actor', {
      name: 'MOCK_first',
      type: 'npc',
   });
   second = world.add('Actor', {
      name: 'MOCK_second',
      type: 'npc',
   });
   third = world.add('Actor', {
      name: 'MOCK_third',
      type: 'npc',
   });
   owner = world.add('Actor', {
      name: 'MOCK_owner',
      type: 'npc',
   });
   sword = world.addChild(owner, 'Item', {
      name: 'MOCK_sword',
      type: 'weapon',
   });
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
 * Run `batchDocuments` and return what it threw.
 * @param {object} params - The parameters.
 * @returns {Promise<Error>} The error.
 */
async function failure(params) {
   try {
      await batchDocuments(params);
   } catch (error) {
      return error;
   }
   throw new Error('batchDocuments did not throw');
}

/**
 * An update entry that renames one document.
 * @param {object} document - The document to rename.
 * @param {string} name - The new name.
 * @returns {{ uuid: string, patches: object[] }} The update entry.
 */
function rename(document, name) {
   return {
      uuid: document.uuid,
      patches: [
         {
            path: 'name',
            value: name,
         },
      ],
   };
}

/**
 * A create entry for one actor.
 * @param {string} name - The actor name.
 * @returns {object} The create entry for that actor.
 */
function make(name) {
   return {
      documentName: 'Actor',
      data: [
         {
            name,
            type: 'npc',
         },
      ],
   };
}

describe('batchDocuments: operations Foundry drops before it sends', () => {
   it('reports an unchanged and a hook-cancelled update as empty `changed` and applies the later one', async () => {
      world.cancel.updateIds.add(second.id);
      const result = await batchDocuments({
         updates: [
            rename(first, 'MOCK_first'),
            rename(second, 'MOCK_second_renamed'),
            rename(third, 'MOCK_third_renamed'),
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
      expect(third._source.name).toBe('MOCK_third_renamed');
      expect(second._source.name).toBe('MOCK_second');
   });

   it('acknowledges a batch whose updates all changed nothing, though Foundry sends no request', async () => {
      const result = await batchDocuments({ updates: [rename(first, 'MOCK_first')] });
      expect(result.updated).toEqual([
         {
            uuid: first.uuid,
            changed: [],
         },
      ]);
   });

   it('matches the results to the operations by document, not by position', async () => {
      world.cancel.updateIds.add(first.id);
      const result = await batchDocuments({
         creates: [make('MOCK_new')],
         updates: [
            rename(first, 'MOCK_x'),
            rename(second, 'MOCK_y'),
         ],
         deletes: [third.uuid],
      });
      expect(result.created).toHaveLength(1);
      expect(result.updated.map((row) => row.changed)).toEqual([
        [],
        ['name'],
      ]);
      expect(result.deleted.map((row) => row.uuid)).toEqual([third.uuid]);
   });

   it('names the operation a hook cancelled in the middle and keeps the others applied', async () => {
      world.cancel.deleteIds.add(second.id);
      const error = await failure({
         creates: [make('MOCK_new')],
         deletes: [second.uuid],
         updates: [rename(third, 'MOCK_third_renamed')],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('2 of 3 operations applied');
      expect(error.message).toContain('1 cancelled');
      expect(third._source.name).toBe('MOCK_third_renamed');
      expect(world.byUuid.has(second.uuid)).toBe(true);
   });

   it('reports a create a hook cancelled', async () => {
      world.cancel.createNames.add('MOCK_blocked');
      const error = await failure({
         creates: [make('MOCK_blocked')],
         updates: [rename(third, 'MOCK_third_renamed')],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('1 of 2 operations applied');
   });

   it('reports the entries of an operation that were cancelled in part', async () => {
      world.cancel.deleteIds.add(second.id);
      const error = await failure({ deletes: [first.uuid, second.uuid] });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('cancelled');
      expect(world.byUuid.has(first.uuid)).toBe(false);
   });
});

describe('batchDocuments: the server fails', () => {
   it('stops at the failing operation (phase 2): earlier operations stay applied and are counted', async () => {
      world.batch.failure = {
         index: 1,
         phase: 2,
      };
      const error = await failure({
         creates: [make('MOCK_new')],
         deletes: [second.uuid],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('1 of 2 operations applied');
      expect(error.message).toContain('1 failed');
      expect(world.byUuid.has(second.uuid)).toBe(true);
   });

   it('says 0 applied and removes the ghost documents when the validation pass failed (phase 1)', async () => {
      world.batch.failure = {
         index: 1,
         phase: 1,
      };
      const error = await failure({
         creates: [make('MOCK_ghost')],
         updates: [rename(first, 'MOCK_x')],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('0 of 2 operations applied');
      /** @type {object[]} Actors named like the ghost that the client still lists. */
      const listed = [...world.byUuid.values()].filter((document) => document.name === 'MOCK_ghost');
      expect(listed).toEqual([]);
      expect(world.server.size).toBeGreaterThan(0);
   });

   it('restores a document the client dropped on the echo of a failed validation pass', async () => {
      world.batch.failure = {
         index: 1,
         phase: 1,
      };
      const error = await failure({
         deletes: [second.uuid],
         updates: [rename(first, 'MOCK_x')],
      });
      expect(error.message).toContain('0 of 2 operations applied');
      expect(world.byUuid.has(second.uuid)).toBe(true);
      expect(world.server.has(second.uuid)).toBe(true);
   });

   it('does not count an echoed update as applied after a failed validation pass', async () => {
      world.batch.failure = {
         index: 1,
         phase: 1,
      };
      const error = await failure({
         updates: [rename(first, 'MOCK_x')],
         deletes: [second.uuid],
      });
      expect(error.message).toContain('0 of 2 operations applied');
      expect(first._source.name).toBe('MOCK_first');
   });

   it('reports a batch Foundry refuses as a whole', async () => {
      world.batch.rejectAll = true;
      const error = await failure({ deletes: [second.uuid] });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('0 of 1 operations applied');
   });

   it('keeps the message within 256 bytes', async () => {
      world.batch.failure = {
         index: 1,
         phase: 2,
      };
      const error = await failure({
         creates: [make('MOCK_new')],
         deletes: [second.uuid],
         updates: [rename(owner, 'MOCK_o')],
      });
      expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(256);
   });
});

describe('batchDocuments: an embedded operation', () => {
   it('matches an embedded update to its result', async () => {
      const result = await batchDocuments({
         updates: [
            {
               uuid: owner.uuid,
               patches: [
                  {
                     path: `items.${sword.id}.name`,
                     value: 'MOCK_renamed',
                  },
               ],
            },
         ],
      });
      expect(result.updated).toEqual([
         {
            uuid: owner.uuid,
            changed: [`items.${sword.id}.name`],
         },
      ]);
   });
});

describe('batchDocuments: results are matched to operations by document id', () => {
   it('does not give the echo of a later operation to the failed first one of the same size', async () => {
      world.batch.failure = {
         index: 0,
         phase: 1,
      };
      const error = await failure({
         updates: [
            rename(first, 'MOCK_x'),
            rename(second, 'MOCK_y'),
         ],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('0 of 2 operations applied');
      expect(error.message).toContain('1 failed');
      expect(first._source.name).toBe('MOCK_first');
      expect(second._source.name).toBe('MOCK_second');
   });
});

describe('batchDocuments: a failed create does not take the echo of another operation', () => {
   it('counts a create and an update of one class as 0 applied when the create failed validation', async () => {
      world.batch.failure = {
         index: 0,
         phase: 1,
      };
      const error = await failure({
         creates: [make('MOCK_new')],
         updates: [rename(first, 'MOCK_x')],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('0 of 2 operations applied');
      expect(error.message).toContain('1 failed');
      expect(first._source.name).toBe('MOCK_first');
   });

   it('settles two creates of one class under different parents by the parent of the result', () => {
      /** @type {object} The parents. */
      const parentX = { uuid: 'Actor.MOCKX' };
      const parentY = { uuid: 'Actor.MOCKY' };
      /**
       * A create operation of one embedded document under a parent.
       * @param {object} parent - The actor the item is created under.
       * @returns {object} The settle entry.
       */
      const createUnder = (parent) => ({
         kind: 'create',
         expected: 1,
         parent,
         operation: {
            documentName: 'Item',
            data: [{ name: 'MOCK_item' }],
            dryRun: false,
         },
      });
      /** @type {object} The dry-run echo of the create under Y. */
      const echo = {
         documentName: 'Item',
         id: 'MOCKECHO0000001',
         parent: parentY,
      };
      const states = settle([createUnder(parentX), createUnder(parentY)], [[echo]]);
      expect(states.map((state) => state.state)).toEqual([
         'failed',
         'applied',
      ]);
   });

   it('does not give a delete result to a delete under another parent', () => {
      /** @type {object} The parents. */
      const parentX = { uuid: 'Actor.MOCKX' };
      const parentY = { uuid: 'Actor.MOCKY' };
      /**
       * A delete operation of one embedded document under a parent.
       * @param {object} parent - The actor the item is deleted from.
       * @param {string} id - The id of the item.
       * @returns {object} The settle entry.
       */
      const deleteUnder = (parent, id) => ({
         kind: 'delete',
         expected: 1,
         parent,
         operation: {
            documentName: 'Item',
            ids: [id],
            dryRun: false,
         },
      });
      const states = settle(
         [
            deleteUnder(parentX, 'MOCKSAMEID00001'),
            deleteUnder(parentY, 'MOCKSAMEID00001'),
         ],
         [[{
            documentName: 'Item',
            id: 'MOCKSAMEID00001',
            parent: parentY,
         }]],
      );
      expect(states.map((state) => state.state)).toEqual([
         'failed',
         'applied',
      ]);
   });
});

describe('batchDocuments: an embedded operation after a failed validation pass', () => {
   it('removes the ghost item from the parent and restores a phantom-deleted item', async () => {
      world.batch.failure = {
         index: 2,
         phase: 1,
      };
      const error = await failure({
         creates: [{
            documentName: 'Item',
            data: [{
               name: 'MOCK_ghost_item',
               type: 'weapon',
            }],
            parentUuid: owner.uuid,
         }],
         deletes: [sword.uuid],
         updates: [rename(first, 'MOCK_x')],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('0 of 3 operations applied');
      expect([...owner.getEmbeddedCollection('Item').values()].map((item) => item.name)).toEqual(['MOCK_sword']);
   });
});

describe('batchDocuments: an embedded create that the server wrote before a later failure', () => {
   it('counts the item as applied, asking the server under its parent', async () => {
      world.batch.failure = {
         index: 1,
         phase: 2,
      };
      const error = await failure({
         creates: [{
            documentName: 'Item',
            data: [{
               name: 'MOCK_kept_item',
               type: 'weapon',
            }],
            parentUuid: owner.uuid,
         }],
         deletes: [second.uuid],
      });
      expect(error.message).toContain('1 of 2 operations applied');
      expect([...owner.getEmbeddedCollection('Item').values()].map((item) => item.name).sort()).toEqual([
         'MOCK_kept_item',
         'MOCK_sword',
      ]);
   });
});

describe('batchDocuments: an embedded update group with entries a hook dropped', () => {
   it('acknowledges only the paths of the entries that were written, without an error', async () => {
      const shield = world.addChild(owner, 'Item', {
         name: 'MOCK_shield',
         type: 'armor',
      });
      world.cancel.updateIds.add(shield.id);
      const result = await batchDocuments({
         updates: [{
            uuid: owner.uuid,
            patches: [
               {
                  path: `items.${sword.id}.name`,
                  value: 'MOCK_sword_renamed',
               },
               {
                  path: `items.${shield.id}.name`,
                  value: 'MOCK_shield_renamed',
               },
            ],
         }],
      });
      expect(result.updated).toEqual([
         {
            uuid: owner.uuid,
            changed: [`items.${sword.id}.name`],
         },
      ]);
      expect(sword._source.name).toBe('MOCK_sword_renamed');
      expect(shield._source.name).toBe('MOCK_shield');
   });
});
