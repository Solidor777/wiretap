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

/** @type {string} The code of a call whose data Foundry's validation refuses. */
const VALIDATION_FAILED = 'VALIDATION_FAILED';

/** @type {RegExp} The entries of `world.calls` that write to the mock world (lookups such as `.get` do not). */
const WRITE_CALL = /^modifyBatch$|\.(createDocuments|createEmbeddedDocuments|update|updateEmbeddedDocuments)$/;

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
 * List the writes the mock world logged from a position of its call log on.
 * @param {number} start - The length of `world.calls` before the call under test.
 * @returns {string[]} The logged calls from `start` on that write to the mock world.
 */
function writeCallsSince(start) {
   return world.calls.slice(start).filter((call) => WRITE_CALL.test(call));
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

   it.each([
      'set',
      'replace',
   ])('update of a Macro already of type script that sets type script with op %s needs no gate', async (op) => {
      /** @type {object} A live script Macro. */
      const script = world.add('Macro', {
         name: 'MOCK_script',
         type: 'script',
         command: 'MOCK_code',
      });
      expect(
         await outcome(() => updateDocuments({
            updates: [{
               uuid: script.uuid,
               patches: [patchOf('type', 'script', op)],
            }],
         })),
      ).toBeNull();
      expect(script.update).toHaveBeenCalledTimes(1);
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
         /** @type {number} How many calls the mock world logged before this write. */
         const start = world.calls.length;
         expect(await outcome(write), `write ${index}`).toBeNull();
         expect(writeCallsSince(start), `write ${index}`).not.toEqual([]);
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

/**
 * Build the data of a region behavior that runs a script.
 * @param {string} [id] - The `_id` of the behavior, for data that names a stored one.
 * @returns {Record<string, unknown>} The behavior data.
 */
function scriptBehavior(id) {
   return {
      ...(id === undefined ? {} : { _id: id }),
      name: 'MOCK_behavior',
      type: 'executeScript',
      system: { source: 'MOCK_code' },
   };
}

describe('writing a region script behavior needs allowMacroExecution', () => {
   /** @type {object} A live Scene that holds the Region. */
   let scene;

   /** @type {object} A live Region of the Scene that holds the behaviors. */
   let region;

   /** @type {object} A live behavior that runs a script. */
   let stored;

   /** @type {object} A live behavior of a type that runs no code. */
   let pause;

   beforeEach(() => {
      scene = world.add('Scene', { name: 'MOCK_scene' });
      region = world.addChild(scene, 'Region', { name: 'MOCK_region' });
      stored = world.addChild(region, 'RegionBehavior', scriptBehavior());
      pause = world.addChild(region, 'RegionBehavior', {
         name: 'MOCK_pause',
         type: 'pauseGame',
      });
   });

   /**
    * Update one live document with patches.
    * @param {object} document - The document addressed by its uuid.
    * @param {Array<{ path: string, value?: unknown, op?: string }>} patches - The patches to write.
    * @param {boolean} [dryRun] - Whether the call only previews.
    * @returns {Promise<unknown>} The result of the update.
    */
   function updateOf(document, patches, dryRun = false) {
      return updateDocuments({
         updates: [{
            uuid: document.uuid,
            patches,
         }],
         dryRun,
      });
   }

   /**
    * Each write that stores the code of a script behavior, by name.
    * @type {Record<string, () => Promise<unknown>>}
    */
   const storing = {
      'create of a script behavior': () => createDocuments({
         documentName: 'RegionBehavior',
         parentUuid: region.uuid,
         data: [scriptBehavior()],
      }),
      'create of a script behavior with no source': () => createDocuments({
         documentName: 'RegionBehavior',
         parentUuid: region.uuid,
         data: [{
            name: 'MOCK_behavior',
            type: 'executeScript',
         }],
      }),
      'update of a behavior type to executeScript': () => updateOf(pause, [patchOf('type', 'executeScript', 'set')]),
      'update of a behavior type to executeScript with op replace': () =>
         updateOf(pause, [patchOf('type', 'executeScript', 'replace')]),
      'update of the source of a script behavior': () => updateOf(stored, [patchOf('system.source', 'x', 'set')]),
      'update of the system of a script behavior with op replace': () =>
         updateOf(stored, [patchOf('system', { source: 'x' }, 'replace')]),
      'update of a Region that writes the source of its script behavior': () =>
         updateOf(region, [patchOf(`behaviors.${stored.id}.system.source`, 'x', 'set')]),
      'update of a Region that changes a behavior type to executeScript': () =>
         updateOf(region, [patchOf(`behaviors.${pause.id}.type`, 'executeScript', 'set')]),
      'create of a Region holding a script behavior': () => createDocuments({
         documentName: 'Region',
         parentUuid: scene.uuid,
         data: [{
            name: 'MOCK_region',
            behaviors: [scriptBehavior()],
         }],
      }),
      'create of a Scene holding a script behavior': () => createDocuments({
         documentName: 'Scene',
         data: [{
            name: 'MOCK_scene',
            regions: [{
               name: 'MOCK_region',
               behaviors: [scriptBehavior()],
            }],
         }],
      }),
      'update of a Scene region that adds a script behavior': () =>
         updateOf(scene, [patchOf(`regions.${region.id}.behaviors`, [scriptBehavior()], 'set')]),
      'update of a Scene region that rewrites a stored script behavior with its source': () =>
         updateOf(scene, [patchOf(`regions.${region.id}.behaviors`, [scriptBehavior(stored.id)], 'set')]),
      'replace of a Scene whose data holds a script behavior': () => replaceDocument({
         uuid: scene.uuid,
         data: {
            name: 'MOCK_scene',
            regions: [{
               name: 'MOCK_region',
               behaviors: [scriptBehavior()],
            }],
         },
      }),
      'batch create of a script behavior': () => batchDocuments({
         creates: [{
            documentName: 'RegionBehavior',
            parentUuid: region.uuid,
            data: [scriptBehavior()],
         }],
      }),
      'batch update of the source of a script behavior': () => batchDocuments({
         updates: [{
            uuid: stored.uuid,
            patches: [patchOf('system.source', 'x', 'set')],
         }],
      }),
      'dry run of a script behavior create': () => createDocuments({
         documentName: 'RegionBehavior',
         parentUuid: region.uuid,
         data: [scriptBehavior()],
         dryRun: true,
      }),
      'dry run of a script behavior source update': () =>
         updateOf(stored, [patchOf('system.source', 'x', 'set')], true),
      'create of an Adventure whose scenes hold a script behavior': () => createDocuments({
         documentName: 'Adventure',
         pack: ADVENTURE_PACK,
         data: [{
            name: 'MOCK_adventure',
            scenes: [{
               name: 'MOCK_scene',
               regions: [{
                  name: 'MOCK_region',
                  behaviors: [scriptBehavior()],
               }],
            }],
         }],
      }),
      'update of an Adventure whose scenes hold a script behavior': async () => {
         /** @type {object} A live Adventure inside the pack. */
         const adventure = world.add(
            'Adventure',
            {
               name: 'MOCK_adventure',
               scenes: [],
            },
            { pack: ADVENTURE_PACK },
         );
         return updateOf(adventure, [patchOf(
            'scenes',
            [{
               name: 'MOCK_scene',
               regions: [{
                  name: 'MOCK_region',
                  behaviors: [scriptBehavior()],
               }],
            }],
            'set',
         )]);
      },
   };

   it.each(Object.keys(storing))('%s is denied while the gate is closed', async (name) => {
      gates.allowDelete = true;
      gates.allowReplace = true;
      gates.allowCompendiumWrites = true;
      expectMacroDenial(await outcome(storing[name]));
      for (const document of [
         scene,
         region,
         stored,
         pause,
      ]) {
         expect(document.update).not.toHaveBeenCalled();
      }
   });

   it.each(Object.keys(storing))('%s runs once allowMacroExecution is open', async (name) => {
      gates.allowMacroExecution = true;
      gates.allowDelete = true;
      gates.allowReplace = true;
      gates.allowCompendiumWrites = true;
      /** @type {number} How many calls the mock world logged before the write. */
      const start = world.calls.length;
      expect(await outcome(storing[name])).toBeNull();
      if (!name.startsWith('dry run')) {
         expect(writeCallsSince(start)).not.toEqual([]);
      }
   });

   it('writes that store no script code need no gate', async () => {
      /**
       * Each write that leaves script code untouched.
       * @type {Array<() => Promise<unknown>>}
       */
      const writes = [
         () => createDocuments({
            documentName: 'RegionBehavior',
            parentUuid: region.uuid,
            data: [{
               name: 'MOCK_pause',
               type: 'pauseGame',
            }],
         }),
         () => updateOf(stored, [patchOf('name', 'MOCK_renamed', 'set')]),
         () => updateOf(stored, [patchOf('type', 'executeScript', 'set')]),
         () => updateOf(stored, [patchOf('type', 'pauseGame', 'set')]),
         () => updateOf(pause, [patchOf('name', 'MOCK_renamed', 'set')]),
         () => updateOf(region, [patchOf(`behaviors.${stored.id}.name`, 'MOCK_renamed', 'set')]),
         () => updateOf(scene, [patchOf(
            `regions.${region.id}.behaviors`,
            [{
               _id: stored.id,
               name: 'MOCK_renamed',
            }],
            'set',
         )]),
         () => createDocuments({
            documentName: 'Region',
            parentUuid: scene.uuid,
            data: [{
               name: 'MOCK_region',
               behaviors: [{
                  name: 'MOCK_pause',
                  type: 'pauseGame',
               }],
            }],
         }),
      ];
      for (const [index, write] of writes.entries()) {
         expect(await outcome(write), `write ${index}`).toBeNull();
      }
   });

   /**
    * Each write whose data puts an entry that is not an object in a `behaviors` array, by name. The mock world fails
    * validation only on data that marks its failures, so each payload carries the `invalid` table Foundry's validation
    * would report for it; the guard itself must let the call through to that validation.
    * @type {Record<string, () => Promise<unknown>>}
    */
   const malformed = {
      'create of a Region': () => createDocuments({
         documentName: 'Region',
         parentUuid: scene.uuid,
         data: [{
            name: 'MOCK_region',
            behaviors: ['x'],
            invalid: { 'behaviors.0': 'is not an object' },
         }],
      }),
      'create of a Scene': () => createDocuments({
         documentName: 'Scene',
         data: [{
            name: 'MOCK_scene',
            regions: [{
               name: 'MOCK_region',
               behaviors: [1],
            }],
            invalid: { 'regions.0.behaviors.0': 'is not an object' },
         }],
      }),
      'replace of a Scene': () => replaceDocument({
         uuid: scene.uuid,
         data: {
            name: 'MOCK_scene',
            regions: [{
               name: 'MOCK_region',
               behaviors: ['x'],
            }],
            invalid: { 'regions.0.behaviors.0': 'is not an object' },
         },
      }),
      'batch create of a Region': () => batchDocuments({
         creates: [{
            documentName: 'Region',
            parentUuid: scene.uuid,
            data: [{
               name: 'MOCK_region',
               behaviors: ['x'],
               invalid: { 'behaviors.0': 'is not an object' },
            }],
         }],
      }),
   };

   it.each(Object.keys(malformed))('%s with a behavior that is not an object fails validation', async (name) => {
      gates.allowDelete = true;
      gates.allowReplace = true;
      /** @type {Error | null} What the call threw. */
      const error = await outcome(malformed[name]);
      expect(error?.code, error?.message).toBe(VALIDATION_FAILED);
      expect(writeCallsSince(0)).toEqual([]);
      expect(foundry.documents.modifyBatch).not.toHaveBeenCalled();
   });
});
