import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { prepareReplace, replaceDocument, runReplace } from '~/bridge/scripts/writeReplace.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} The live actor to replace. */
let actor;

beforeEach(() => {
   world = installWriteWorld(vi.fn, { userId: 'MOCKGM0000000001' });
   gates = {
      allowDelete: true,
      allowReplace: true,
   };
   globalThis.game.settings.get = (module, key) => gates[key];
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc',
      sort: 5,
      folder: 'MOCKFOLDER000001',
      ownership: { default: 0 },
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
 * Run a call and return what it threw.
 * @param {() => Promise<unknown>} call - The call to run.
 * @returns {Promise<Error>} The error.
 */
async function failure(call) {
   try {
      await call();
   } catch (error) {
      return error;
   }
   throw new Error('the call did not throw');
}

/**
 * Build the backed-up data of the actor: its fields as the backup holds them.
 * @param {Record<string, unknown>} [extra] - Fields that replace or add to the defaults.
 * @returns {Record<string, unknown>} The data.
 */
function backedUp(extra = {}) {
   return {
      _id: actor.id,
      name: 'MOCK_restored',
      type: 'npc',
      sort: 9,
      folder: 'MOCKFOLDER000002',
      ownership: { default: 0 },
      ...extra,
   };
}

describe('prepareReplace and runReplace', () => {
   it('replaceDocument keeps every existing result once split into prepareReplace and runReplace', async () => {
      world.addChild(actor, 'Item', {
         _id: 'MOCKITEM00000001',
         name: 'MOCK_item',
      });
      /** @type {Record<string, unknown>} Data that leaves the item out, so it is dropped. */
      const data = {
         name: 'MOCK_replaced',
         type: 'npc',
      };
      const plan = await prepareReplace({
         uuid: actor.uuid,
         data,
         dryRun: true,
      });
      expect(plan.target).toBe(actor);
      expect(plan.changed).toEqual([
         'name',
         'type',
      ]);
      expect(plan.dropped).toBe(1);
      expect(plan.dryRun).toBe(true);
      expect(await replaceDocument({
         uuid: actor.uuid,
         data,
         dryRun: true,
      })).toEqual({
         uuid: actor.uuid,
         changed: [
            'name',
            'type',
         ],
         dryRun: true,
         dropped: 1,
      });
      expect(actor.update).not.toHaveBeenCalled();
      const row = await runReplace(await prepareReplace({
         uuid: actor.uuid,
         data,
      }), true);
      expect(row.uuid).toBe(actor.uuid);
      expect(row.changed).toEqual([
         'name',
         'type',
      ]);
      expect(row.dropped).toBe(1);
      expect(row.exported).toBeDefined();
      expect(actor.update.mock.calls[0][1]).toEqual({
         diff: false,
         recursive: false,
      });
      expect(await replaceDocument({
         uuid: actor.uuid,
         data,
      })).toEqual({
         uuid: actor.uuid,
         changed: [
            'name',
            'type',
         ],
         dropped: 1,
      });
      world.cancel.cancelUpdate = true;
      const error = await failure(() => replaceDocument({
         uuid: actor.uuid,
         data,
      }));
      expect(error.code).toBe('WRITE_NOT_APPLIED');
   });
});

describe('prepareReplace: restore mode', () => {
   it('restore mode writes the backed-up sort, folder and ownership back into the replacement', async () => {
      const plan = await prepareReplace({
         uuid: actor.uuid,
         data: backedUp(),
         restore: true,
      });
      expect(plan.replacement.sort).toBe(9);
      expect(plan.replacement.folder).toBe('MOCKFOLDER000002');
      expect(plan.replacement.ownership).toEqual({ default: 0 });
      await runReplace(plan);
      const [sent] = actor.update.mock.calls[0];
      expect(sent.sort).toBe(9);
      expect(sent.folder).toBe('MOCKFOLDER000002');
      expect(sent.ownership).toEqual({ default: 0 });
      // A plain replace keeps the live values of the same fields.
      gates.allowOwnershipWrites = true;
      const plain = await prepareReplace({
         uuid: actor.uuid,
         data: backedUp(),
      });
      expect(plain.replacement.sort).toBeUndefined();
      expect(plain.replacement.folder).toBeUndefined();
      expect(plain.replacement.ownership).toBeUndefined();
   });

   it('restore mode needs no allowOwnershipWrites when ownership equals the live value', async () => {
      world.addChild(actor, 'Item', {
         _id: 'MOCKITEM00000001',
         name: 'MOCK_item',
         ownership: { default: 2 },
      });
      const plan = await prepareReplace({
         uuid: actor.uuid,
         data: backedUp({
            items: [
               {
                  _id: 'MOCKITEM00000001',
                  name: 'MOCK_item',
                  ownership: { default: 2 },
               },
               {
                  _id: 'MOCKITEM00000002',
                  name: 'MOCK_new_item',
                  ownership: { default: 0 },
               },
            ],
         }),
         restore: true,
      });
      expect(plan.replacement.ownership).toEqual({ default: 0 });
      // The same data without restore mode needs the gate.
      const error = await failure(() => prepareReplace({
         uuid: actor.uuid,
         data: backedUp(),
      }));
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowOwnershipWrites');
   });

   it('restore mode needs allowOwnershipWrites when ownership differs, and writes nothing without it', async () => {
      const error = await failure(async () => runReplace(await prepareReplace({
         uuid: actor.uuid,
         data: backedUp({
            ownership: {
               default: 0,
               MOCKPLAYER000001: 3,
            },
         }),
         restore: true,
      })));
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowOwnershipWrites');
      world.addChild(actor, 'Item', {
         _id: 'MOCKITEM00000001',
         name: 'MOCK_item',
         ownership: { default: 0 },
      });
      const embedded = await failure(() => prepareReplace({
         uuid: actor.uuid,
         data: backedUp({
            items: [
               {
                  _id: 'MOCKITEM00000001',
                  name: 'MOCK_item',
                  ownership: { default: 3 },
               },
            ],
         }),
         restore: true,
      }));
      expect(embedded.message).toContain('allowOwnershipWrites');
      expect(actor.update).not.toHaveBeenCalled();
      gates.allowOwnershipWrites = true;
      const plan = await prepareReplace({
         uuid: actor.uuid,
         data: backedUp({
            ownership: {
               default: 0,
               MOCKPLAYER000001: 3,
            },
         }),
         restore: true,
      });
      expect(plan.replacement.ownership).toEqual({
         default: 0,
         MOCKPLAYER000001: 3,
      });
   });

   it('restore mode restores the ownership of a kept embedded document', async () => {
      world.addChild(actor, 'Item', {
         _id: 'MOCKITEM00000001',
         name: 'MOCK_item',
         ownership: { default: 2 },
      });
      const plan = await prepareReplace({
         uuid: actor.uuid,
         data: backedUp({
            items: [
               {
                  _id: 'MOCKITEM00000001',
                  name: 'MOCK_item',
                  ownership: { default: 2 },
               },
            ],
         }),
         restore: true,
      });
      expect(plan.replacement.items).toEqual([
         {
            _id: 'MOCKITEM00000001',
            name: 'MOCK_item',
            ownership: { default: 2 },
         },
      ]);
      await runReplace(plan);
      expect(actor.update.mock.calls[0][0].items[0].ownership).toEqual({ default: 2 });
   });

   it('restore mode still needs allowReplace, and allowDelete when it removes an embedded document added since',
      async () => {
         gates.allowReplace = false;
         const replace = await failure(() => prepareReplace({
            uuid: actor.uuid,
            data: backedUp(),
            restore: true,
         }));
         expect(replace.code).toBe(GATE_DENIED);
         expect(replace.message).toContain('allowReplace');
         gates.allowReplace = true;
         gates.allowDelete = false;
         world.addChild(actor, 'Item', {
            _id: 'MOCKITEM00000009',
            name: 'MOCK_added_since',
         });
         const remove = await failure(() => prepareReplace({
            uuid: actor.uuid,
            data: backedUp(),
            restore: true,
         }));
         expect(remove.code).toBe(GATE_DENIED);
         expect(remove.message).toContain('allowDelete');
         expect(actor.update).not.toHaveBeenCalled();
      });
});
