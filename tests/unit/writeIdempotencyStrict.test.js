import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDocuments } from '~/bridge/scripts/writes.js';
import { BEST_PRACTICE, SizeNotes } from '~/bridge/scripts/sizeNotes.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

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
      ],
      userId: 'MOCKGM0000000001',
   });
   globalThis.game.settings.get = () => false;
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
 * @returns {Promise<Error>} The error.
 */
async function failure(params) {
   try {
      await createDocuments(params);
   } catch (error) {
      return error;
   }
   throw new Error('createDocuments did not throw');
}

/**
 * The parameters of a one-actor create with a key.
 * @param {string} key - The idempotency key.
 * @param {object} [extra] - More parameters.
 * @returns {object} The parameters.
 */
function oneActor(key, extra = {}) {
   return {
      documentName: 'Actor',
      data: [
         {
            name: 'MOCK_one',
            type: 'npc',
         },
      ],
      idempotencyKey: key,
      ...extra,
   };
}

describe('the record names its writer and its document', () => {
   it('stamps the writing user and the id of the carrying document, and creates with that id', async () => {
      const [row] = await createDocuments(oneActor('key-1'));
      const [sent] = world.classes.Actor.createDocuments.mock.calls[0][0];
      expect(world.classes.Actor.createDocuments.mock.calls[0][1].keepId).toBe(true);
      expect(sent._id).toMatch(/^[A-Za-z0-9]{16}$/);
      expect(sent.flags.wiretap.idem).toMatchObject({
         k: 'key-1',
         u: 'MOCKGM0000000001',
         d: sent._id,
      });
      expect(row.uuid).toBe(`Actor.${sent._id}`);
   });

   it('ignores any _id the data carries unless keepId was asked for', async () => {
      await createDocuments(
         oneActor('key-1', {
            data: [
               {
                  _id: 'MOCKCALLER000001',
                  name: 'MOCK_one',
                  type: 'npc',
               },
            ],
         }),
      );
      expect(world.classes.Actor.createDocuments.mock.calls[0][0][0]._id).not.toBe('MOCKCALLER000001');
   });

   it('does not replay a record that another user wrote, and creates instead', async () => {
      const first = await createDocuments(oneActor('key-1'));
      const live = world.byUuid.get(first[0].uuid);
      live.flags.wiretap.idem.u = 'MOCKPLAYER00001';
      const second = await createDocuments(oneActor('key-1'));
      expect(second[0].uuid).not.toBe(first[0].uuid);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(2);
   });

   it('does not let a duplicate that copied the record cause a conflict or a second replay row', async () => {
      const first = await createDocuments(oneActor('key-1'));
      const live = world.byUuid.get(first[0].uuid);
      world.add('Actor', {
         name: 'MOCK_copy',
         type: 'npc',
         flags: structuredClone(live.flags),
      });
      const second = await createDocuments(oneActor('key-1'));
      expect(second).toEqual(first);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
   });
});

describe('the lookup reads a collection of any size', () => {
   /**
    * Make the Actor collection report a size and hold the given documents.
    * @param {number} size - The reported size.
    * @param {object[]} documents - The documents it holds.
    * @returns {void}
    */
   function collectionOf(size, documents) {
      globalThis.game.collections.get = () => ({
         size,
         values: () => documents,
      });
   }

   it('creates in a collection past the best-practice size and notes its size once', async () => {
      collectionOf(BEST_PRACTICE.idempotencyLookup + 1, []);
      const notes = new SizeNotes('create_documents');
      await createDocuments(oneActor('key-1', { sizeNotes: notes }));
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
      const log = vi.fn();
      notes.write(log);
      expect(log.mock.calls).toEqual([
         [
            `Wiretap | create_documents: ${BEST_PRACTICE.idempotencyLookup + 1} documents read by the ` +
               `idempotencyKey lookup, over the ${BEST_PRACTICE.idempotencyLookup} best-practice size`,
         ],
      ]);
   });

   it('notes nothing for a collection of exactly the best-practice size', async () => {
      collectionOf(BEST_PRACTICE.idempotencyLookup, []);
      const notes = new SizeNotes('create_documents');
      await createDocuments(oneActor('key-1', { sizeNotes: notes }));
      const log = vi.fn();
      notes.write(log);
      expect(log).not.toHaveBeenCalled();
   });

   it('replays a record found in a collection past the best-practice size', async () => {
      const first = await createDocuments(oneActor('key-1'));
      const live = world.byUuid.get(first[0].uuid);
      collectionOf(BEST_PRACTICE.idempotencyLookup + 1, [live]);
      const second = await createDocuments(oneActor('key-1'));
      expect(second).toEqual(first);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
   });
});

describe('a replay honours dryRun, actAs and read-back', () => {
   it('answers a dry run with the existing documents marked as a preview and a replay, writing nothing', async () => {
      const first = await createDocuments(oneActor('key-1'));
      const preview = await createDocuments(oneActor('key-1', { dryRun: true }));
      expect(preview).toEqual([
         {
            ...first[0],
            dryRun: true,
            replay: true,
         },
      ]);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
   });

   it('checks the actAs user on a replay too', async () => {
      await createDocuments(oneActor('key-1'));
      const error = await failure(oneActor('key-1', { actAs: 'MOCKPLAYER00001' }));
      expect(error.code).toBe('ACT_AS_DENIED');
   });

   it('adds the export of the existing documents when read-back is asked for', async () => {
      await createDocuments(oneActor('key-1'));
      const [row] = await createDocuments(oneActor('key-1', { readback: true }));
      expect(row.exported).toBeDefined();
      expect(row.exported.name).toBe('MOCK_one');
   });
});

describe('concurrent calls with one key', () => {
   it('serialize: one create, and the second call replays it', async () => {
      const [first, second] = await Promise.all([
         createDocuments(oneActor('key-1')),
         createDocuments(oneActor('key-1')),
      ]);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
      expect(second).toEqual(first);
   });

   it('do not serialize across keys', async () => {
      const [first, second] = await Promise.all([
         createDocuments(oneActor('key-1')),
         createDocuments(oneActor('key-2')),
      ]);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(2);
      expect(second[0].uuid).not.toBe(first[0].uuid);
   });

   it('release the key when the first call fails', async () => {
      world.cancel.cancelCreate = true;
      const error = await failure(oneActor('key-1'));
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      world.cancel.cancelCreate = false;
      const rows = await createDocuments(oneActor('key-1'));
      expect(rows).toHaveLength(1);
   });
});

describe('a retry that cannot replay says why and what to do', () => {
   /**
    * The parameters of a two-actor create with a key.
    * @param {string} key - The idempotency key.
    * @returns {object} The parameters.
    */
   function twoActors(key) {
      return {
         documentName: 'Actor',
         data: [
            {
               name: 'MOCK_one',
               type: 'npc',
            },
            {
               name: 'MOCK_two',
               type: 'npc',
            },
         ],
         idempotencyKey: key,
      };
   }

   it('names the missing documents and the remedy when a hook cancelled one of the first call', async () => {
      world.cancel.createNames.add('MOCK_two');
      await failure(twoActors('key-1'));
      world.cancel.createNames.clear();
      const error = await failure(twoActors('key-1'));
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(error.message).toContain('1 of 2');
      expect(error.message).toMatch(/new idempotencyKey/);
      expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(256);
   });

   it('says the key belongs to a different request when the data changed', async () => {
      await createDocuments(twoActors('key-1'));
      const error = await failure({
         ...twoActors('key-1'),
         data: [
            {
               name: 'MOCK_other',
               type: 'npc',
            },
            {
               name: 'MOCK_two',
               type: 'npc',
            },
         ],
      });
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
      expect(error.message).toContain('different request');
   });
});
