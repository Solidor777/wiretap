import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDocuments } from '~/bridge/scripts/writes.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {object} A live actor whose id the data reuses. */
let actor;

/** @type {object} A live item of that actor. */
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
   globalThis.game.settings.get = () => false;
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc',
   });
   sword = world.addChild(actor, 'Item', {
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
 * Run `createDocuments` and return what it threw.
 * @param {object} params - The parameters.
 * @returns {Promise<Error | null>} The error, or null when the call resolved.
 */
async function outcome(params) {
   try {
      await createDocuments(params);
   } catch (error) {
      return error;
   }
   return null;
}

describe('keepId never overwrites a document that exists', () => {
   it('refuses a world document whose id is taken, before any write', async () => {
      const error = await outcome({
         documentName: 'Actor',
         data: [{
            _id: actor.id,
            name: 'MOCK_dup',
            type: 'npc',
         }],
         keepId: true,
      });
      expect(error?.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('already exists');
      expect(error.message).toContain('update_documents');
      expect(world.classes.Actor.createDocuments).not.toHaveBeenCalled();
   });

   it('refuses an embedded document whose id is taken under the parent', async () => {
      const error = await outcome({
         documentName: 'Item',
         parentUuid: actor.uuid,
         data: [{
            _id: sword.id,
            name: 'MOCK_dup',
            type: 'weapon',
         }],
         keepId: true,
      });
      expect(error?.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('already exists');
      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
   });

   it('refuses the same id twice in one call', async () => {
      const error = await outcome({
         documentName: 'Actor',
         data: [
            {
               _id: 'MOCKFREEID000001',
               name: 'MOCK_a',
               type: 'npc',
            },
            {
               _id: 'MOCKFREEID000001',
               name: 'MOCK_b',
               type: 'npc',
            },
         ],
         keepId: true,
      });
      expect(error?.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('twice');
   });

   it('refuses on a dry run too, and under an idempotency key', async () => {
      for (const extra of [
         { dryRun: true },
         { idempotencyKey: 'key-1' },
      ]) {
         const error = await outcome({
            documentName: 'Actor',
            data: [{
               _id: actor.id,
               name: 'MOCK_dup',
               type: 'npc',
            }],
            keepId: true,
            ...extra,
         });
         expect(error?.code, JSON.stringify(extra)).toBe('ARGS_INVALID');
      }
      expect(world.classes.Actor.createDocuments).not.toHaveBeenCalled();
   });

   it('replays a keyed keepId retry whose ids the first call took, and writes once', async () => {
      /** @type {object} The arguments of both calls: an explicit free id kept under one key. */
      const params = {
         documentName: 'Actor',
         data: [{
            _id: 'MOCKFREEID000003',
            name: 'MOCK_kept',
            type: 'npc',
         }],
         keepId: true,
         idempotencyKey: 'MOCK-keep-1',
      };
      /** @type {object[]} The rows of the first call. */
      const first = await createDocuments(params);
      expect(first[0].uuid).toBe('Actor.MOCKFREEID000003');
      /** @type {object[]} The rows of the retry. */
      const second = await createDocuments(params);
      expect(second).toEqual(first);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
   });

   it('lets a free id through, and ignores the id of the data without keepId', async () => {
      expect(
         await outcome({
            documentName: 'Actor',
            data: [{
               _id: 'MOCKFREEID000002',
               name: 'MOCK_free',
               type: 'npc',
            }],
            keepId: true,
         }),
      ).toBeNull();
      expect(
         await outcome({
            documentName: 'Actor',
            data: [{
               _id: actor.id,
               name: 'MOCK_ignored_id',
               type: 'npc',
            }],
         }),
      ).toBeNull();
   });
});
