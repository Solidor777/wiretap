import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { batchDocuments } from '~/bridge/scripts/writeBatch.js';
import { replaceDocument } from '~/bridge/scripts/writeReplace.js';
import { createDocuments, updateDocuments } from '~/bridge/scripts/writes.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} A live chat Macro the updates address. */
let macro;

/** @type {string} The id of the compendium pack that holds Adventures. */
const ADVENTURE_PACK = 'world.mock-adventures';

beforeEach(() => {
   world = installWriteWorld(vi.fn, {
      users: [{
         id: 'MOCKGM0000000001',
         role: 4,
         name: 'MOCK_gm',
      }],
      userId: 'MOCKGM0000000001',
      packs: {
         [ADVENTURE_PACK]: { documentName: 'Adventure' },
      },
   });
   gates = {};
   globalThis.game.settings.get = (module, key) => gates[key];
   macro = world.add('Macro', {
      name: 'MOCK_macro',
      type: 'chat',
      command: 'MOCK_text',
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
 * @param {() => Promise<unknown>} call - The operation to attempt.
 * @returns {Promise<Error | null>} The rejection, or null when the call resolved.
 */
async function outcome(call) {
   try {
      await call();
   } catch (error) {
      return error;
   }
   return null;
}

/**
 * Assert that a call was refused naming `allowMacroExecution` and that no write API ran.
 * @param {Error | null} error - What the call threw.
 * @returns {void}
 */
function expectMacroDenial(error) {
   expect(error?.code).toBe(GATE_DENIED);
   expect(error.message).toContain('allowMacroExecution');
   expect(world.calls).toEqual([]);
   expect(foundry.documents.modifyBatch).not.toHaveBeenCalled();
}

/**
 * Update the live Macro with one patch.
 * @param {{ path: string, value?: unknown, op?: string }} patch - The path, value and op to write.
 * @param {boolean} [dryRun] - Whether the call only previews.
 * @returns {Promise<unknown>} The result of the update.
 */
function updateMacro(patch, dryRun = false) {
   return updateDocuments({
      updates: [{
         uuid: macro.uuid,
         patches: [patch],
      }],
      dryRun,
   });
}

/**
 * Build the patch of an op: a delete carries no value.
 * @param {string} path - The field the patch writes.
 * @param {unknown} value - What a set or replace writes; a delete ignores it.
 * @param {'set' | 'replace' | 'delete'} op - Whether the patch sets, replaces or deletes the field.
 * @returns {{ path: string, value?: unknown, op: string }} The patch entry of an update.
 */
function patchOf(path, value, op) {
   return op === 'delete'
      ? {
         path,
         op,
      }
      : {
         path,
         value,
         op,
      };
}

describe('writing Macro code needs allowMacroExecution', () => {
   it.each([
      'chat',
      'script',
   ])('create of a %s Macro with a command is denied while the gate is closed', async (type) => {
      const error = await outcome(() => createDocuments({
         documentName: 'Macro',
         data: [{
            name: 'MOCK_M',
            type,
            command: 'x',
         }],
      }));
      expectMacroDenial(error);
   });

   it('create of a Macro with no command needs no gate', async () => {
      expect(
         await outcome(() => createDocuments({
            documentName: 'Macro',
            data: [{
               name: 'MOCK_M',
               type: 'script',
            }],
         })),
      ).toBeNull();
      expect(world.calls).toContain('Macro.createDocuments');
   });

   it.each([
      'set',
      'replace',
      'delete',
   ])('update of a Macro command with op %s is denied', async (op) => {
      expectMacroDenial(await outcome(() => updateMacro(patchOf('command', 'x', op))));
      expect(macro.update).not.toHaveBeenCalled();
   });

   it.each([
      'set',
      'replace',
   ])('update of a Macro type to script with op %s is denied', async (op) => {
      expectMacroDenial(await outcome(() => updateMacro(patchOf('type', 'script', op))));
      expect(macro.update).not.toHaveBeenCalled();
   });

   it('update of a Macro type to chat, or a delete of type, needs no gate', async () => {
      for (const patch of [
         patchOf('type', 'chat', 'set'),
         patchOf('type', 'chat', 'replace'),
         patchOf('type', undefined, 'delete'),
      ]) {
         expect(await outcome(() => updateMacro(patch)), patch.op).toBeNull();
      }
      expect(macro.update).toHaveBeenCalledTimes(3);
   });

   it('update of a Macro name needs no gate', async () => {
      expect(await outcome(() => updateMacro(patchOf('name', 'MOCK_renamed', 'set')))).toBeNull();
      expect(macro.update).toHaveBeenCalledTimes(1);
   });

   it('replace of a Macro is denied even when its data omits command', async () => {
      gates.allowReplace = true;
      const error = await outcome(() => replaceDocument({
         uuid: macro.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'chat',
         },
      }));
      expectMacroDenial(error);
      expect(macro.update).not.toHaveBeenCalled();
   });

   it('batch creates and updates of a Macro command are denied and nothing is sent', async () => {
      expectMacroDenial(
         await outcome(() => batchDocuments({
            creates: [{
               documentName: 'Macro',
               data: [{
                  name: 'MOCK_M',
                  type: 'script',
                  command: 'x',
               }],
            }],
         })),
      );
      expectMacroDenial(
         await outcome(() => batchDocuments({
            updates: [{
               uuid: macro.uuid,
               patches: [{
                  path: 'command',
                  value: 'x',
               }],
            }],
         })),
      );
   });

   it('a dry run of a Macro command write is denied while the gate is closed', async () => {
      expectMacroDenial(
         await outcome(() => createDocuments({
            documentName: 'Macro',
            data: [{
               name: 'MOCK_M',
               command: 'x',
            }],
            dryRun: true,
         })),
      );
      expectMacroDenial(await outcome(() => updateMacro(patchOf('command', 'x', 'set'), true)));
   });

   it('every write above runs once allowMacroExecution is open', async () => {
      gates.allowMacroExecution = true;
      gates.allowReplace = true;
      gates.allowCompendiumWrites = true;
      /** @type {object} A live Adventure inside the pack. */
      const adventure = world.add(
         'Adventure',
         {
            name: 'MOCK_adventure',
            macros: [],
         },
         { pack: ADVENTURE_PACK },
      );
      /**
       * Each write the closed gate refuses.
       * @type {Array<() => Promise<unknown>>}
       */
      const writes = [
         () => createDocuments({
            documentName: 'Macro',
            data: [{
               name: 'MOCK_M',
               type: 'script',
               command: 'x',
            }],
         }),
         () => updateMacro(patchOf('command', 'x', 'set')),
         () => updateMacro(patchOf('command', 'y', 'replace')),
         () => updateMacro(patchOf('command', undefined, 'delete')),
         () => updateMacro(patchOf('type', 'script', 'set')),
         () => updateMacro(patchOf('type', 'chat', 'replace')),
         () => updateMacro(patchOf('type', 'script', 'replace')),
         () => replaceDocument({
            uuid: macro.uuid,
            data: {
               name: 'MOCK_replaced',
               type: 'chat',
            },
         }),
         () => batchDocuments({
            creates: [{
               documentName: 'Macro',
               data: [{
                  name: 'MOCK_M',
                  command: 'x',
               }],
            }],
            updates: [{
               uuid: macro.uuid,
               patches: [{
                  path: 'command',
                  value: 'z',
               }],
            }],
         }),
         () => createDocuments({
            documentName: 'Adventure',
            pack: ADVENTURE_PACK,
            data: [{
               name: 'MOCK_adventure',
               macros: [{
                  name: 'MOCK_M',
                  command: 'x',
               }],
            }],
         }),
         () => updateDocuments({
            updates: [{
               uuid: adventure.uuid,
               patches: [{
                  path: 'macros',
                  value: [{
                     name: 'MOCK_M',
                     command: 'x',
                  }],
               }],
            }],
         }),
      ];
      for (const [index, write] of writes.entries()) {
         expect(await outcome(write), `write ${index}`).toBeNull();
      }
      expect(foundry.documents.modifyBatch).toHaveBeenCalledTimes(1);
   });

   it('create of an Adventure holding macros is denied while the gate is closed', async () => {
      gates.allowCompendiumWrites = true;
      const error = await outcome(() => createDocuments({
         documentName: 'Adventure',
         pack: ADVENTURE_PACK,
         data: [{
            name: 'MOCK_adventure',
            macros: [{
               name: 'MOCK_M',
               type: 'script',
               command: 'x',
            }],
         }],
      }));
      expectMacroDenial(error);
   });

   it('update of an Adventure\'s macros is denied while the gate is closed', async () => {
      gates.allowCompendiumWrites = true;
      /** @type {object} A live Adventure inside the pack. */
      const adventure = world.add(
         'Adventure',
         {
            name: 'MOCK_adventure',
            macros: [],
         },
         { pack: ADVENTURE_PACK },
      );
      const error = await outcome(() => updateDocuments({
         updates: [{
            uuid: adventure.uuid,
            patches: [{
               path: 'macros',
               value: [{
                  name: 'MOCK_M',
                  command: 'x',
               }],
            }],
         }],
      }));
      expectMacroDenial(error);
      expect(adventure.update).not.toHaveBeenCalled();
   });

   it('a command key on a document that is not a Macro needs no gate', async () => {
      expect(
         await outcome(() => createDocuments({
            documentName: 'Actor',
            data: [{
               name: 'MOCK_actor',
               type: 'npc',
               system: { command: 'x' },
               flags: { mod: { command: 'x' } },
            }],
         })),
      ).toBeNull();
      /** @type {object} A live actor to update. */
      const actor = world.add('Actor', {
         name: 'MOCK_actor',
         type: 'npc',
      });
      expect(
         await outcome(() => updateDocuments({
            updates: [{
               uuid: actor.uuid,
               patches: [
                  {
                     path: 'system.command',
                     value: 'x',
                  },
                  {
                     path: 'flags.mod.command',
                     value: 'x',
                  },
               ],
            }],
         })),
      ).toBeNull();
      expect(actor.update).toHaveBeenCalledTimes(1);
   });
});
