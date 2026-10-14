import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDocuments } from '~/bridge/scripts/writes.js';
import { IDEMPOTENCY_RETENTION_MS, requestHash } from '~/bridge/scripts/writeIdempotency.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {object} A live actor, the parent of embedded creates. */
let actor;

beforeEach(() => {
   world = installWriteWorld(vi.fn);
   globalThis.game.settings.get = () => false;
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc',
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

describe('requestHash', () => {
   it('is stable and tells different requests apart', () => {
      expect(requestHash(['a', 1])).toBe(requestHash(['a', 1]));
      expect(requestHash(['a', 1])).not.toBe(requestHash(['a', 2]));
      expect(requestHash(['a', 1])).toMatch(/^[0-9a-f]{14}$/);
   });
});

describe('createDocuments: idempotencyKey', () => {
   it('stores the record as a wiretap module flag on each created document', async () => {
      await createDocuments(twoActors('key-1'));
      const sent = world.classes.Actor.createDocuments.mock.calls[0][0];
      expect(sent).toHaveLength(2);
      expect(sent[0].flags.wiretap.idem).toMatchObject({
         k: 'key-1',
         i: 0,
         n: 2,
         h: expect.stringMatching(/^[0-9a-f]{14}$/),
      });
      expect(sent[1].flags.wiretap.idem).toMatchObject({
         k: 'key-1',
         i: 1,
         n: 2,
      });
   });

   it('replays the first call: the same rows, no second write', async () => {
      const first = await createDocuments(twoActors('key-1'));
      const second = await createDocuments(twoActors('key-1'));
      expect(second).toEqual(first);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
   });

   it('replays an embedded create under the same parent', async () => {
      const params = {
         documentName: 'Item',
         data: [
            {
               name: 'MOCK_item',
               type: 'weapon',
            },
         ],
         parentUuid: actor.uuid,
         idempotencyKey: 'embedded-1',
      };
      const first = await createDocuments(params);
      const second = await createDocuments(params);
      expect(second).toEqual(first);
      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
   });

   it('refuses the same key with a different request, and writes nothing', async () => {
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
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
   });

   it('refuses the key when one of the first call documents is gone', async () => {
      const [first] = await createDocuments(twoActors('key-1'));
      world.byUuid.delete(first.uuid);
      const error = await failure(twoActors('key-1'));
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
   });

   it('does not replay a record older than the retention bound, and creates again', async () => {
      await createDocuments(twoActors('key-1'));
      for (const document of world.byUuid.values()) {
         if (document.flags?.wiretap?.idem !== undefined) {
            document._stats = { createdTime: Date.now() - IDEMPOTENCY_RETENTION_MS - 1000 };
         }
      }
      await createDocuments(twoActors('key-1'));
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(2);
   });

   it('keeps keys apart', async () => {
      await createDocuments(twoActors('key-1'));
      await createDocuments(twoActors('key-2'));
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(2);
   });

   it('validates the key and refuses a pack target', async () => {
      for (const idempotencyKey of [
         '',
         'a b',
         'x'.repeat(65),
         'é',
      ]) {
         const error = await failure({
            ...twoActors('k'),
            idempotencyKey,
         });
         expect(error.code, idempotencyKey).toBe('ARGS_INVALID');
      }
      expect(world.calls).toEqual([]);
   });

   it('does not let a caller plant or forge the record through data', async () => {
      const error = await failure({
         documentName: 'Actor',
         data: [
            {
               name: 'MOCK_forged',
               type: 'npc',
               flags: {
                  wiretap: {
                     idem: {
                        k: 'key-1',
                        i: 0,
                        n: 1,
                        h: 'abc'
                     }
                  }
               },
            },
         ],
      });
      expect(error.code).toBe('GATE_DENIED');
      expect(error.message).toContain('flags.wiretap');
      expect(world.calls).toEqual([]);
   });

   it('does not write on a dry run, and still reports a conflict', async () => {
      await createDocuments(twoActors('key-1'));
      const preview = await createDocuments({
         ...twoActors('key-2'),
         dryRun: true,
      });
      expect(preview).toHaveLength(2);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
      const error = await failure({
         ...twoActors('key-1'),
         data: [
            {
               name: 'MOCK_changed',
               type: 'npc',
            },
         ],
         dryRun: true,
      });
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
   });
});
