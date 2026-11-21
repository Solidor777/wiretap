import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATES } from '$shared/gates.js';
import { GATE_DENIED } from '$shared/protocol.js';
import { executeMacroDefinition } from '~/bridge/scripts/macroDefinitions.js';
import { batchDocuments } from '~/bridge/scripts/writeBatch.js';
import { replaceDocument } from '~/bridge/scripts/writeReplace.js';
import { deleteDocuments, updateDocuments } from '~/bridge/scripts/writes.js';
import { shippedScripts } from './scriptFixtures.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} A live actor the calls address. */
let actor;

beforeEach(() => {
   world = installWriteWorld(vi.fn, {
      users: [
         {
            id: 'MOCKGM0000000001',
            role: 4,
            name: 'MOCK_gm',
         },
         {
            id: 'MOCKGM0000000002',
            role: 4,
            name: 'MOCK_gm_two',
         },
      ],
      userId: 'MOCKGM0000000001',
   });
   gates = {};
   globalThis.game.settings.get = (module, key) => gates[key];
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
 * How each risky script is run, and the gate it needs.
 * @type {Record<string, { gate: string, run: (dryRun: boolean) => Promise<unknown> }>}
 */
const RISKY = {
   delete_documents: {
      gate: 'allowDelete',
      run: (dryRun) => deleteDocuments({
         uuids: [actor.uuid],
         dryRun,
      }),
   },
   replace_document: {
      gate: 'allowReplace',
      run: (dryRun) => replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
         },
         dryRun,
      }),
   },
   batch: {
      gate: 'allowDelete',
      run: (dryRun) => batchDocuments({
         deletes: [actor.uuid],
         dryRun,
      }),
   },
};

describe('the delete and replace gates', () => {
   it('exist, default closed, and are boolean world settings', () => {
      for (const name of [
         'allowDelete',
         'allowReplace',
      ]) {
         expect(GATES[name].type, name).toBe('boolean');
         expect(GATES[name].default, name).toBe(false);
      }
   });

   for (const [name, risky] of Object.entries(RISKY)) {
      it(`${name} is denied naming ${risky.gate} while the gate is closed, and changes nothing`, async () => {
         const error = await outcome(() => risky.run(false));
         expect(error?.code).toBe(GATE_DENIED);
         expect(error.message).toContain(risky.gate);
         expect(world.byUuid.has(actor.uuid)).toBe(true);
         expect(actor.update).not.toHaveBeenCalled();
         expect(foundry.documents.modifyBatch).not.toHaveBeenCalled();
      });

      it(`${name} previews with a dry run while the gate is closed, calling no write API`, async () => {
         expect(await outcome(() => risky.run(true))).toBeNull();
         expect(world.byUuid.has(actor.uuid)).toBe(true);
         expect(actor.update).not.toHaveBeenCalled();
         expect(actor.delete).not.toHaveBeenCalled();
         expect(world.classes.Actor.deleteDocuments).not.toHaveBeenCalled();
         expect(foundry.documents.modifyBatch).not.toHaveBeenCalled();
         expect(world.calls.filter((call) => /create|update|delete|modify/i.test(call))).toEqual([]);
      });

      it(`${name} runs once ${risky.gate} is open`, async () => {
         gates[risky.gate] = true;
         expect(await outcome(() => risky.run(false))).toBeNull();
      });
   }

   it('keeps the delete gate and the replace gate apart', async () => {
      gates.allowDelete = true;
      expect((await outcome(() => RISKY.replace_document.run(false)))?.code).toBe(GATE_DENIED);
      gates.allowDelete = false;
      gates.allowReplace = true;
      expect((await outcome(() => RISKY.delete_documents.run(false)))?.code).toBe(GATE_DENIED);
   });

   it('does not gate a batch that deletes nothing', async () => {
      expect(
         await outcome(() => batchDocuments({
            updates: [{
               uuid: actor.uuid,
               patches: [{
                  path: 'name',
                  value: 'MOCK_x',
               }],
            }],
         })),
      ).toBeNull();
   });
});

describe('every risky script is gated', () => {
   /** @type {RegExp} Verbs that name an irreversible operation or the running of arbitrary code. */
   const RISKY_VERB = /delete|replace|remove|destroy|purge|wipe|execute/;

   it('has an enforcement check or a declared gate for each mutating script with a risky verb', () => {
      /** @type {object[]} Scripts that mutate and carry a risky verb, or may delete as one of several operations. */
      const needed = shippedScripts().filter(
         (definition) =>
            definition.mutates === true && (RISKY_VERB.test(definition.name) || definition.name === 'batch'),
      );
      expect(needed.length).toBeGreaterThan(0);
      for (const definition of needed) {
         if (Object.hasOwn(RISKY, definition.name)) {
            expect(GATES, definition.name).toHaveProperty(RISKY[definition.name].gate);
         } else {
            expect(
               Object.hasOwn(GATES, definition.gate ?? ''),
               `${definition.name} needs a closed-gate denial test in RISKY or a declared gate`,
            ).toBe(true);
         }
      }
   });

   it('gates execute_macro behind allowMacroExecution', () => {
      expect(executeMacroDefinition.gate).toBe('allowMacroExecution');
   });
});

describe('op replace and op delete on embedded collections are deletes and replaces', () => {
   /** @type {object} An item of the actor. */
   let sword;

   /**
    * Add an item and an effect to the actor, and an effect to the item.
    * @returns {void}
    */
   function fill() {
      sword = world.addChild(actor, 'Item', {
         name: 'MOCK_sword',
         type: 'weapon',
      });
      world.addChild(actor, 'ActiveEffect', { name: 'MOCK_glow' });
      world.addChild(sword, 'ActiveEffect', { name: 'MOCK_edge' });
   }

   /**
    * The patches that remove or replace an embedded collection of an item, with the gates each needs.
    * @returns {Array<{ patch: object, needs: string[] }>} A patch for each form, with the gates it needs.
    */
   function cases() {
      /** @type {Array<{ patch: object, needs: string[] }>} The cases built so far. */
      const built = [];
      for (const collection of Object.values(world.classes.Item.metadata.embedded)) {
         built.push(
            {
               patch: {
                  path: `items.${sword.id}.${collection}`,
                  op: 'replace',
                  value: [],
               },
               needs: [
                  'allowReplace',
                  'allowDelete',
               ],
            },
            {
               patch: {
                  path: `items.${sword.id}.${collection}`,
                  op: 'delete',
               },
               needs: ['allowDelete'],
            },
         );
      }
      return built;
   }

   /**
    * The tools that take patches, each as a name and a runner.
    * @type {Array<[string, (patch: object, dryRun: boolean) => Promise<unknown>]>}
    */
   const TOOLS = [
      [
         'update_documents',
         (patch, dryRun) => updateDocuments({
            updates: [{
               uuid: actor.uuid,
               patches: [patch],
            }],
            dryRun,
         }),
      ],
      [
         'batch',
         (patch, dryRun) => batchDocuments({
            updates: [{
               uuid: actor.uuid,
               patches: [patch],
            }],
            dryRun,
         }),
      ],
   ];

   /**
    * Assert that no write API was called.
    * @returns {void}
    */
   function expectNoWrites() {
      expect(actor.update).not.toHaveBeenCalled();
      expect(actor.updateEmbeddedDocuments).not.toHaveBeenCalled();
      expect(actor.deleteEmbeddedDocuments).not.toHaveBeenCalled();
      expect(foundry.documents.modifyBatch).not.toHaveBeenCalled();
   }

   it('covers every embedded collection of the item', () => {
      fill();
      expect(cases().length).toBe(2);
   });

   for (const [tool, run] of TOOLS) {
      it(`${tool} denies each form while the gates are closed, and writes nothing`, async () => {
         fill();
         for (const { patch } of cases()) {
            const error = await outcome(() => run(patch, false));
            expect(error?.code, `${tool} ${patch.path}`).toBe(GATE_DENIED);
            expectNoWrites();
         }
      });

      it(`${tool} denies a form while one of its gates is still closed`, async () => {
         fill();
         for (const { patch, needs } of cases()) {
            for (const open of needs) {
               gates = { [open]: true };
               if (needs.length === 1) {
                  continue;
               }
               const error = await outcome(() => run(patch, false));
               expect(error?.code, `${tool} ${patch.path} with only ${open}`).toBe(GATE_DENIED);
               expectNoWrites();
            }
         }
      });

      it(`${tool} previews each form with every gate closed, and writes nothing`, async () => {
         fill();
         for (const { patch } of cases()) {
            expect(await outcome(() => run(patch, true)), `${tool} ${patch.path}`).toBeNull();
            expectNoWrites();
         }
      });

      it(`${tool} runs each form once its gates are open`, async () => {
         fill();
         for (const { patch, needs } of cases()) {
            gates = Object.fromEntries(needs.map((name) => [name, true]));
            expect(await outcome(() => run(patch, false)), `${tool} ${patch.path}`).toBeNull();
         }
      });
   }

   it('refuses every operator-prefixed collection key as an operator, with every gate open', async () => {
      fill();
      gates = {
         allowReplace: true,
         allowDelete: true,
      };
      for (const collection of Object.values(world.classes.Actor.metadata.embedded)) {
         for (const patch of [
            {
               path: `==${collection}`,
               value: [],
            },
            {
               path: `-=${collection}`,
               value: null,
            },
            {
               path: `-=${collection}.${sword.id}`,
               value: null,
            },
         ]) {
            for (const [, run] of TOOLS) {
               const error = await outcome(() => run(patch, false));
               expect(error?.code, patch.path).toBe('PATH_OPERATOR');
               expectNoWrites();
            }
         }
      }
   });

   it('leaves plain field ops ungated and refuses an op on a collection or an embedded document', async () => {
      fill();
      for (const patch of [
         {
            path: 'system.hp',
            op: 'delete',
         },
         {
            path: 'system.attributes',
            op: 'replace',
            value: { a: 1 },
         },
         {
            path: `items.${sword.id}.system.damage`,
            op: 'delete',
         },
      ]) {
         expect(await outcome(() => TOOLS[0][1](patch, false)), patch.path).toBeNull();
      }
      for (const patch of [
         {
            path: 'items',
            op: 'delete',
         },
         {
            path: 'items',
            op: 'replace',
            value: [],
         },
         {
            path: `items.${sword.id}`,
            op: 'delete',
         },
         {
            path: `items.${sword.id}`,
            op: 'replace',
            value: {},
         },
      ]) {
         const error = await outcome(() => TOOLS[0][1](patch, false));
         expect(error?.code, patch.path).toBe('PATH_INVALID');
      }
   });
});

describe('a replace that drops embedded documents is also a delete', () => {
   /** @type {object} An item of the actor, with an effect of its own. */
   let sword;

   beforeEach(() => {
      sword = world.addChild(actor, 'Item', {
         name: 'MOCK_sword',
         type: 'weapon',
      });
      world.addChild(actor, 'ActiveEffect', { name: 'MOCK_glow' });
      world.addChild(sword, 'ActiveEffect', { name: 'MOCK_edge' });
   });

   /**
    * Replace the actor with data that omits the embedded collections.
    * @param {boolean} [dryRun] - Whether to only preview.
    * @returns {Promise<object>} The acknowledgement.
    */
   function replaceWithoutChildren(dryRun = false) {
      return replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
         },
         dryRun,
      });
   }

   it('needs allowDelete as well as allowReplace, and writes nothing without it', async () => {
      gates = { allowReplace: true };
      const error = await outcome(() => replaceWithoutChildren());
      expect(error?.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowDelete');
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('needs allowReplace as well as allowDelete', async () => {
      gates = { allowDelete: true };
      const error = await outcome(() => replaceWithoutChildren());
      expect(error?.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowReplace');
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('runs once both gates are open', async () => {
      gates = {
         allowReplace: true,
         allowDelete: true,
      };
      await replaceWithoutChildren();
      expect(actor.update).toHaveBeenCalledTimes(1);
   });

   it('reports the dropped documents on a dry run, nested ones included, without any gate', async () => {
      const row = await replaceWithoutChildren(true);
      expect(row).toMatchObject({
         dryRun: true,
         dropped: 3,
      });
      expect(actor.update).not.toHaveBeenCalled();
      expect(foundry.documents.modifyBatch).not.toHaveBeenCalled();
   });

   it('needs no allowDelete when every embedded document is kept', async () => {
      gates = { allowReplace: true };
      const row = await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
            items: [{
               _id: sword.id,
               name: 'MOCK_sword',
               type: 'weapon',
               effects: [{
                  _id: [...sword.getEmbeddedCollection('ActiveEffect').values()][0].id,
                  name: 'MOCK_edge',
               }],
            }],
            effects: [{
               _id: [...actor.getEmbeddedCollection('ActiveEffect').values()][0].id,
               name: 'MOCK_glow',
            }],
         },
      });
      expect(row.dropped).toBeUndefined();
      expect(actor.update).toHaveBeenCalledTimes(1);
   });

   it('counts a dropped effect of a kept item', async () => {
      const row = await replaceDocument({
         uuid: actor.uuid,
         data: {
            name: 'MOCK_replaced',
            type: 'npc',
            items: [{
               _id: sword.id,
               name: 'MOCK_sword',
               type: 'weapon',
            }],
            effects: [{
               _id: [...actor.getEmbeddedCollection('ActiveEffect').values()][0].id,
               name: 'MOCK_glow',
            }],
         },
         dryRun: true,
      });
      expect(row.dropped).toBe(1);
   });
});
