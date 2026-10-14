import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { createDocuments, deleteDocuments, updateDocuments } from '~/bridge/scripts/writes.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} An actor the owner user owns and the player does not. */
let actor;

/** @type {object} An item of that actor. */
let sword;

beforeEach(() => {
   world = installWriteWorld(vi.fn, {
      users: [
         {
            id: 'MOCKGM0000000001',
            role: 4,
            name: 'MOCK_gm',
         },
         {
            id: 'MOCKPLAYER00001',
            role: 1,
            name: 'MOCK_player',
         },
         {
            id: 'MOCKOWNER000001',
            role: 1,
            name: 'MOCK_owner',
         },
      ],
      userId: 'MOCKGM0000000001',
   });
   gates = {
      allowDelete: true,
      allowReplace: true,
   };
   globalThis.game.settings.get = (module, key) => gates[key];
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc',
      ownership: {
         default: 0,
         MOCKOWNER000001: 3,
      },
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
 * Run an operation and return what it threw.
 * @param {() => Promise<unknown>} run - The operation.
 * @returns {Promise<Error>} The error.
 */
async function failure(run) {
   try {
      await run();
   } catch (error) {
      return error;
   }
   throw new Error('the operation did not throw');
}

describe('actAs: create', () => {
   const params = {
      documentName: 'Item',
      data: [
         {
            name: 'MOCK_item',
            type: 'weapon',
         },
      ],
   };

   it('refuses a user who may not create under the parent, and writes nothing, also as a dry run', async () => {
      for (const dryRun of [
         false,
         true,
      ]) {
         const error = await failure(() =>
            createDocuments({
               ...params,
               parentUuid: actor.uuid,
               actAs: 'MOCKPLAYER00001',
               dryRun,
            }),
         );
         expect(error.code).toBe('ACT_AS_DENIED');
         expect(error.message).toContain('MOCK_player');
         expect(error.message).toContain('create');
      }
      expect(world.calls).toEqual([]);
   });

   it('lets an owner of the parent and a game master through', async () => {
      for (const actAs of [
         'MOCKOWNER000001',
         'MOCKGM0000000001',
      ]) {
         const rows = await createDocuments({
            ...params,
            parentUuid: actor.uuid,
            actAs,
         });
         expect(rows).toHaveLength(1);
      }
   });

   it('refuses an unknown user before anything else', async () => {
      const error = await failure(() =>
         createDocuments({
            ...params,
            parentUuid: actor.uuid,
            actAs: 'NOSUCHUSER00001',
         }),
      );
      expect(error.code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('never grants more than the gates: an allowed user does not open a closed gate', async () => {
      const error = await failure(() =>
         createDocuments({
            documentName: 'User',
            data: [{ name: 'MOCK_user' }],
            actAs: 'MOCKGM0000000001',
         }),
      );
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowUserWrites');
      expect(world.calls).toEqual([]);
   });
});

describe('actAs: update', () => {
   it('refuses a user who may not update the document, and writes nothing, also as a dry run', async () => {
      for (const dryRun of [
         false,
         true,
      ]) {
         const error = await failure(() =>
            updateDocuments({
               updates: [
                  {
                     uuid: actor.uuid,
                     patches: [{
                        path: 'name',
                        value: 'MOCK_new'
                     }],
                  },
               ],
               actAs: 'MOCKPLAYER00001',
               dryRun,
            }),
         );
         expect(error.code).toBe('ACT_AS_DENIED');
      }
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('checks the embedded document of an embedded path too', async () => {
      const error = await failure(() =>
         updateDocuments({
            updates: [
               {
                  uuid: actor.uuid,
                  patches: [{
                     path: `items.${sword.id}.name`,
                     value: 'MOCK_new'
                  }],
               },
            ],
            actAs: 'MOCKPLAYER00001',
         }),
      );
      expect(error.code).toBe('ACT_AS_DENIED');
      expect(actor.updateEmbeddedDocuments).not.toHaveBeenCalled();
   });

   it('lets the owner update', async () => {
      const rows = await updateDocuments({
         updates: [
            {
               uuid: actor.uuid,
               patches: [{
                  path: 'name',
                  value: 'MOCK_new'
               }],
            },
         ],
         actAs: 'MOCKOWNER000001',
      });
      expect(rows[0].changed).toEqual(['name']);
   });
});

describe('actAs: delete', () => {
   it('refuses a user who may not delete, and deletes nothing, also as a dry run', async () => {
      for (const dryRun of [
         false,
         true,
      ]) {
         const error = await failure(() =>
            deleteDocuments({
               uuids: [actor.uuid],
               actAs: 'MOCKPLAYER00001',
               dryRun,
            }),
         );
         expect(error.code).toBe('ACT_AS_DENIED');
      }
      expect(world.calls).toEqual([]);
   });

   it('lets the owner delete', async () => {
      const rows = await deleteDocuments({
         uuids: [actor.uuid],
         actAs: 'MOCKOWNER000001',
      });
      expect(rows).toHaveLength(1);
   });
});
