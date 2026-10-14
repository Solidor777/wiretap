import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { groupWrites } from '$shared/docPath.js';
import { guardWrite, scanWriteValues } from '~/bridge/scripts/writeGuard.js';
import { batchDocuments, buildOperations } from '~/bridge/scripts/writeBatch.js';
import { replaceDocument } from '~/bridge/scripts/writeReplace.js';
import { updateDocuments } from '~/bridge/scripts/writes.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} A live actor with an item. */
let actor;

/** @type {object} The item of the actor. */
let sword;

/** @type {object} A second live actor the retarget attempts aim at. */
let victim;

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
   gates = {
      allowDelete: true,
      allowReplace: true,
   };
   globalThis.game.settings.get = (module, key) => gates[key];
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc',
      ownership: {
         default: 3,
         MOCKPLAYER00001: 3,
      },
   });
   victim = world.add('Actor', {
      name: 'MOCK_victim',
      type: 'npc',
      ownership: { default: 0 },
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
 * Run an async call and return what it threw.
 * @param {() => Promise<unknown>} call - The call expected to reject.
 * @returns {Promise<Error>} The rejection.
 */
async function failure(call) {
   try {
      await call();
   } catch (error) {
      return error;
   }
   throw new Error('expected the call to throw');
}

/**
 * Build one update entry.
 * @param {object} document - The document the patches address.
 * @param {object[]} patches - The patches to apply to it.
 * @returns {{ uuid: string, patches: object[] }} The update entry of that document.
 */
function entry(document, patches) {
   return {
      uuid: document.uuid,
      patches,
   };
}

describe('_id is not a writable path', () => {
   it('refuses _id on the document and on an embedded document', () => {
      for (const path of [
         '_id',
         `items.${sword.id}._id`,
      ]) {
         const result = groupWrites([
            {
               path,
               value: 'MOCKEVIL00000001',
            },
         ], ['items']);
         expect(result.ok, path).toBe(false);
         expect(result.error.code, path).toBe('PATH_UNSAFE_SEGMENT');
      }
   });

   it('refuses _id with an operator prefix as an operator', () => {
      for (const path of [
         '-=_id',
         '==_id',
         `items.${sword.id}.-=_id`,
      ]) {
         const result = groupWrites([
            {
               path,
               value: 'MOCKEVIL00000001',
            },
         ], ['items']);
         expect(result.ok, path).toBe(false);
         expect(result.error.code, path).toBe('PATH_OPERATOR');
      }
   });

   it('still allows a nested _id and the other fields', () => {
      for (const path of [
         'system._id',
         `items.${sword.id}.system._id`,
         'name',
      ]) {
         expect(
            groupWrites([
               {
                  path,
                  value: 'MOCK_x',
               },
            ], ['items']).ok,
            path,
         ).toBe(true);
      }
   });

   it('refuses an _id path in update_documents and writes nothing', async () => {
      for (const path of [
         '_id',
         `items.${sword.id}._id`,
      ]) {
         const error = await failure(() =>
            updateDocuments({
               updates: [entry(actor, [{
                  path,
                  value: victim.id,
               }])],
            }),
         );
         expect(error.code, path).toBe('PATH_UNSAFE_SEGMENT');
      }
      expect(actor.update).not.toHaveBeenCalled();
      expect(victim.update).not.toHaveBeenCalled();
      expect(world.calls).toEqual([]);
   });

   it('refuses an _id path in batch and sends nothing', async () => {
      const error = await failure(() =>
         batchDocuments({
            updates: [entry(actor, [{
               path: '_id',
               value: victim.id,
            }])],
         }),
      );
      expect(error.code).toBe('PATH_UNSAFE_SEGMENT');
      expect(foundry.documents.modifyBatch).not.toHaveBeenCalled();
   });

   it('builds update operations with the id of the planned document last, whatever the changes carry', () => {
      /** @type {object} A plan whose changes were tampered with. */
      const plan = {
         document: actor,
         patches: [{ path: 'name' }],
         changes: {
            _id: victim.id,
            name: 'MOCK_x',
         },
         paths: ['name'],
         embedded: [
            {
               documentName: 'Item',
               collection: 'items',
               entries: [
                  {
                     _id: sword.id,
                     document: sword,
                     changes: {
                        _id: victim.id,
                        name: 'MOCK_y',
                     },
                     paths: ['items.x.name'],
                  },
               ],
            },
         ],
      };
      const operations = buildOperations([], [plan], []);
      expect(operations[0].operation.updates[0]._id).toBe(actor.id);
      expect(operations[1].operation.updates[0]._id).toBe(sword.id);
   });

   it('drops an _id in replace data and replaces the addressed document', async () => {
      await replaceDocument({
         uuid: actor.uuid,
         data: {
            _id: victim.id,
            name: 'MOCK_replaced',
            type: 'npc',
         },
      });
      expect(actor.update).toHaveBeenCalledTimes(1);
      expect(victim.update).not.toHaveBeenCalled();
      expect(actor.update.mock.calls[0][0]._id).toBeUndefined();
   });
});

describe('the flags scope cannot be erased', () => {
   it('finds an operator on the flags key itself as an operator', () => {
      for (const value of [
         { '-=flags': null },
         { '==flags': {} },
         { 'system.-=flags': null },
         { items: [{ '==flags': {} }] },
      ]) {
         expect(scanWriteValues([value]).operator, JSON.stringify(value)).toBe(true);
      }
   });

   it('finds a flags value that is not an object', () => {
      for (const value of [
         { flags: null },
         { flags: 'MOCK_text' },
         { flags: [] },
         { items: [{ flags: null }] },
      ]) {
         expect(scanWriteValues([value]).wiretapFlag, JSON.stringify(value)).toBe(true);
      }
   });

   it('lets an ordinary flags object and a flags operator on another scope through', () => {
      for (const value of [
         { flags: { other: { a: 1 } } },
         { flags: { '-=other': null } },
         { flags: {} },
         { 'flags.other.a': 1 },
         { name: 'MOCK_x' },
      ]) {
         expect(scanWriteValues([value]).wiretapFlag, JSON.stringify(value)).toBe(false);
      }
   });

   it('refuses a replace or delete of flags in the cleaned changes and lets a replace of another scope through', () => {
      const { ForcedDeletion, ForcedReplacement } = foundry.data.operators;
      for (const [document, changes] of [
         [actor, { flags: ForcedReplacement.create({}) }],
         [actor, { flags: new ForcedDeletion() }],
         [sword, { flags: new ForcedDeletion() }],
         [actor, { flags: { wiretap: ForcedReplacement.create({}) } }],
      ]) {
         expect(
            () =>
               guardWrite({
                  documentName: 'Actor',
                  targets: [{
                     document,
                     changes,
                  }],
               }),
            JSON.stringify(changes),
         ).toThrowError(/flags\.wiretap/);
      }
      expect(() =>
         guardWrite({
            documentName: 'Actor',
            targets: [{
               document: actor,
               changes: { flags: { other: ForcedReplacement.create({}) } },
            }],
         }),
      ).not.toThrow();
      expect(() =>
         guardWrite({
            documentName: 'Actor',
            targets: [{
               document: actor,
               changes: { flags: { other: {} } },
            }],
         }),
      ).not.toThrow();
   });

   it('refuses update_documents ops that replace or delete flags, and a null flags value', async () => {
      for (const patchEntry of [
         {
            path: 'flags',
            op: 'delete',
         },
         {
            path: 'flags',
            op: 'replace',
            value: {},
         },
         {
            path: `items.${sword.id}.flags`,
            op: 'delete',
         },
         {
            path: 'flags',
            value: null,
         },
      ]) {
         const error = await failure(() => updateDocuments({ updates: [entry(actor, [patchEntry])] }));
         expect(error.code, JSON.stringify(patchEntry)).toBe(GATE_DENIED);
      }
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('refuses a flags operator hidden in a value as an operator', async () => {
      const error = await failure(() =>
        updateDocuments({
           updates: [entry(actor, [{
              path: 'system.x',
              value: { '-=flags': null },
           }])],
        }));
      expect(error.code).toBe('PATH_OPERATOR');
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('refuses an operator-prefixed flags path as an operator, in update_documents and batch', async () => {
      for (const path of [
         '==flags',
         '-=flags',
         `items.${sword.id}.==flags`,
         `items.${sword.id}.-=flags`,
      ]) {
         for (const op of [
            undefined,
            'set',
         ]) {
            /** @type {object} The patch under test. */
            const patch = {
               path,
               value: path.includes('-=') ? null : {},
               ...(op === undefined ? {} : { op }),
            };
            const single = await failure(() => updateDocuments({ updates: [entry(actor, [patch])] }));
            expect(single.code, JSON.stringify(patch)).toBe('PATH_OPERATOR');
            const batched = await failure(() => batchDocuments({ updates: [entry(actor, [patch])] }));
            expect(batched.code, JSON.stringify(patch)).toBe('PATH_OPERATOR');
         }
      }
      expect(actor.update).not.toHaveBeenCalled();
      expect(sword.update).not.toHaveBeenCalled();
      expect(foundry.documents.modifyBatch).not.toHaveBeenCalled();
   });

   it('refuses an operator-prefixed flags key in the guard whatever the op', () => {
      for (const key of [
         '==flags',
         '-=flags',
         `items.${sword.id}.-=flags`,
      ]) {
         expect(
            () =>
               guardWrite({
                  documentName: 'Actor',
                  values: [{ [key]: {} }],
               }),
            key,
         ).toThrowError(/operator/);
      }
   });

   it('lets update_documents replace another module scope', async () => {
      await updateDocuments({
         updates: [entry(actor, [{
            path: 'flags.other',
            op: 'replace',
            value: { a: 1 },
         }])],
      });
      expect(actor.update).toHaveBeenCalledTimes(1);
   });

   it('refuses the same writes in batch', async () => {
      const error = await failure(() =>
         batchDocuments({
            updates: [entry(actor, [{
               path: 'flags',
               op: 'delete',
            }])],
         }),
      );
      expect(error.code).toBe(GATE_DENIED);
      expect(foundry.documents.modifyBatch).not.toHaveBeenCalled();
   });
});

describe('actAs judges expanded changes', () => {
   it('hands canUserModify nested data for a dotted path', async () => {
      await updateDocuments({
         updates: [entry(actor, [{
            path: 'system.hp.value',
            value: 3,
         }])],
         actAs: 'MOCKPLAYER00001',
      });
      /** @type {unknown[]} The arguments of the permission check. */
      const call = actor.canUserModify.mock.calls.at(-1);
      expect(call[1]).toBe('update');
      expect(call[2]).toEqual({ system: { hp: { value: 3 } } });
   });

   it('sees an ownership change behind a dotted key and denies a player who is not the owner', async () => {
      gates.allowOwnershipWrites = true;
      const error = await failure(() =>
         updateDocuments({
            updates: [entry(victim, [{
               path: 'ownership.default',
               value: 3,
            }])],
            actAs: 'MOCKPLAYER00001',
         }),
      );
      expect(error.code).toBe('ACT_AS_DENIED');
      expect(victim.canUserModify.mock.calls.at(-1)[2]).toEqual({ ownership: { default: 3 } });
   });
});
