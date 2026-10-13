import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { getBudget } from '$shared/budgets.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { createDocuments } from '~/bridge/scripts/writes.js';
import { MockValidationError, installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

beforeEach(() => {
   world = installWriteWorld(vi.fn);
   gates = {};
   globalThis.game.settings.get = (module, key) => gates[key];
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
 * @returns {Promise<ScriptError | Error>} The error.
 */
async function failure(params) {
   try {
      await createDocuments(params);
   } catch (error) {
      return error;
   }
   throw new Error('createDocuments did not throw');
}

describe('createDocuments: world documents', () => {
   it('creates through the document class so system pre-create logic runs, and returns plain rows', async () => {
      const data = [{
         name: 'MOCK_actor',
         type: 'npc'
      }];
      const rows = await createDocuments({
         documentName: 'Actor',
         data,
      });
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
      const [sent, operation] = world.classes.Actor.createDocuments.mock.calls[0];
      expect(sent).toEqual([{
         name: 'MOCK_actor',
         type: 'npc'
      }]);
      expect(operation).toMatchObject({ keepId: false });
      expect(rows).toEqual([
         {
            uuid: expect.stringMatching(/^Actor\./),
            name: 'MOCK_actor',
            type: 'npc',
         },
      ]);
   });

   it('does not mutate the data the caller passed', async () => {
      const data = [{
         name: 'MOCK_actor',
         type: 'npc',
         system: { hp: 3 }
      }];
      const copy = structuredClone(data);
      await createDocuments({
         documentName: 'Actor',
         data,
      });
      expect(data).toEqual(copy);
   });

   it('passes keepId to the operation', async () => {
      await createDocuments({
         documentName: 'Actor',
         data: [{
            _id: 'AAAAAAAAAAAAAAAA',
            name: 'MOCK_actor'
         }],
         keepId: true,
      });
      expect(world.classes.Actor.createDocuments.mock.calls[0][1]).toMatchObject({ keepId: true });
   });

   it('creates several documents in one call', async () => {
      const rows = await createDocuments({
         documentName: 'Item',
         data: [
            {
               name: 'MOCK_a',
               type: 'weapon'
            },
            {
               name: 'MOCK_b',
               type: 'armor'
            },
         ],
      });
      expect(rows.map((row) => row.name)).toEqual([
         'MOCK_a',
         'MOCK_b',
      ]);
      expect(world.classes.Item.createDocuments).toHaveBeenCalledTimes(1);
   });

   it('names a Setting by its key', async () => {
      gates.allowSettingWrites = true;
      const rows = await createDocuments({
         documentName: 'Setting',
         data: [{
            key: 'mock.setting',
            value: '1'
         }],
      });
      expect(rows[0].name).toBe('mock.setting');
   });

   it('adds the exported document when read-back is requested', async () => {
      const rows = await createDocuments({
         documentName: 'Actor',
         data: [{
            name: 'MOCK_actor',
            type: 'npc'
         }],
         readback: true,
      });
      expect(rows[0].exported).toMatchObject({ name: 'MOCK_actor' });
      const bare = await createDocuments({
         documentName: 'Actor',
         data: [{
            name: 'MOCK_actor',
            type: 'npc'
         }],
      });
      expect(bare[0]).not.toHaveProperty('exported');
   });
});

describe('createDocuments: embedded documents and packs', () => {
   it('creates an embedded document through its parent', async () => {
      const actor = world.add('Actor', {
         name: 'MOCK_parent',
         type: 'npc'
      });
      const rows = await createDocuments({
         documentName: 'Item',
         data: [{
            name: 'MOCK_item',
            type: 'weapon'
         }],
         parentUuid: actor.uuid,
      });
      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      expect(actor.createEmbeddedDocuments.mock.calls[0][0]).toBe('Item');
      expect(world.classes.Item.createDocuments).not.toHaveBeenCalled();
      expect(rows[0].uuid).toBe(`${actor.uuid}.Item.${actor.items.keys().next().value}`);
   });

   it('refuses a parent that does not exist', async () => {
      const error = await failure({
         documentName: 'Item',
         data: [{ name: 'MOCK_item' }],
         parentUuid: 'Actor.AAAAAAAAAAAAAAAA',
      });
      expect(error.code).toBe('DOC_NOT_FOUND');
   });

   it('refuses a parent that does not embed the class', async () => {
      const scene = world.add('Scene', { name: 'MOCK_scene' });
      const error = await failure({
         documentName: 'Item',
         data: [{ name: 'MOCK_item' }],
         parentUuid: scene.uuid,
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('refuses an embedded-only class with no parent', async () => {
      const error = await failure({
         documentName: 'ActiveEffect',
         data: [{ name: 'MOCK_effect' }],
      });
      expect(error.code).toBe('ARGS_INVALID');
   });

   it('creates in a pack once allowCompendiumWrites is open', async () => {
      world = installWriteWorld(vi.fn, { packs: { 'world.items': { documentName: 'Item' } } });
      globalThis.game.settings.get = (module, key) => gates[key];
      const denied = await failure({
         documentName: 'Item',
         data: [{ name: 'MOCK_item' }],
         pack: 'world.items',
      });
      expect(denied.code).toBe(GATE_DENIED);
      expect(denied.message).toContain('allowCompendiumWrites');
      expect(world.classes.Item.createDocuments).not.toHaveBeenCalled();
      gates.allowCompendiumWrites = true;
      await createDocuments({
         documentName: 'Item',
         data: [{ name: 'MOCK_item' }],
         pack: 'world.items',
      });
      expect(world.classes.Item.createDocuments.mock.calls[0][1]).toMatchObject({ pack: 'world.items' });
   });

   it('refuses an unknown pack, a pack of another class and a pack with a parent', async () => {
      world = installWriteWorld(vi.fn, { packs: { 'world.actors': { documentName: 'Actor' } } });
      globalThis.game.settings.get = (module, key) => gates[key];
      gates.allowCompendiumWrites = true;
      expect(
         (await failure({
            documentName: 'Item',
            data: [{ name: 'MOCK_item' }],
            pack: 'world.missing'
         })).code,
      ).toBe('ARGS_INVALID');
      expect(
         (await failure({
            documentName: 'Item',
            data: [{ name: 'MOCK_item' }],
            pack: 'world.actors'
         })).code,
      ).toBe('ARGS_INVALID');
      const actor = world.add('Actor', { name: 'MOCK_parent' });
      expect(
         (
            await failure({
               documentName: 'Item',
               data: [{ name: 'MOCK_item' }],
               pack: 'world.actors',
               parentUuid: actor.uuid,
            })
         ).code,
      ).toBe('ARGS_INVALID');
   });

   it('gates a create under a parent that lives in a pack', async () => {
      const actor = world.add('Actor', { name: 'MOCK_parent' }, { pack: 'world.actors' });
      const error = await failure({
         documentName: 'Item',
         data: [{ name: 'MOCK_item' }],
         parentUuid: actor.uuid,
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowCompendiumWrites');
      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
   });
});

describe('createDocuments: arguments', () => {
   it('refuses an unknown document name', async () => {
      expect((await failure({
         documentName: 'Nope',
         data: [{}]
      })).code).toBe('ARGS_INVALID');
   });

   it('refuses an empty list, a non-object entry and more documents than the bound', async () => {
      expect((await failure({
         documentName: 'Actor',
         data: []
      })).code).toBe('ARGS_INVALID');
      expect((await failure({
         documentName: 'Actor',
         data: ['x']
      })).code).toBe('ARGS_INVALID');
      expect((await failure({
         documentName: 'Actor',
         data: [[]]
      })).code).toBe('ARGS_INVALID');
      const tooMany = Array.from({ length: getBudget('WRITE_DOCUMENTS_MAX').value + 1 }, () => ({ name: 'MOCK' }));
      expect((await failure({
         documentName: 'Actor',
         data: tooMany
      })).code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });
});

describe('createDocuments: unsafe data', () => {
   it('refuses a data object with a prototype-polluting key at any depth', async () => {
      for (const text of [
         '{"__proto__": {"x": 1}}',
         '{"system": {"constructor": {"x": 1}}}',
         '{"system": [{"prototype": 1}]}',
      ]) {
         const error = await failure({
            documentName: 'Actor',
            data: [JSON.parse(text)],
         });
         expect(error.code, text).toBe('PATH_UNSAFE_VALUE');
      }
      expect(world.calls).toEqual([]);
   });
});

describe('createDocuments: validation', () => {
   it('returns the failures of an invalid document and writes nothing', async () => {
      const error = await failure({
         documentName: 'Actor',
         data: [{
            name: 'MOCK_actor',
            invalid: { 'system.hp': 'must be a number' }
         }],
      });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.failures).toEqual([
         {
            path: '[0].system.hp',
            message: 'must be a number',
         },
      ]);
      expect(error.failureCount).toBe(1);
      expect(world.calls).toEqual([]);
   });

   it('numbers the failing document among several and writes none of them', async () => {
      const error = await failure({
         documentName: 'Actor',
         data: [
            { name: 'MOCK_ok' },
            {
               name: 'MOCK_bad',
               invalid: { name: 'bad' }
            },
         ],
      });
      expect(error.failures[0].path).toBe('[1].name');
      expect(world.calls).toEqual([]);
   });

   it('reports at most 10 failures with the true total of 30', async () => {
      const invalid = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`system.f${index}`, 'bad']));
      const error = await failure({
         documentName: 'Actor',
         data: [{
            name: 'MOCK_actor',
            invalid
         }],
      });
      expect(error.failures).toHaveLength(10);
      expect(error.failureCount).toBe(30);
      expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(256);
   });

   it('uses getAllFailures when it reports the failures', async () => {
      world.classes.Actor.cleanData.mockImplementation(() => {
         throw new MockValidationError({ 'system.hp': 'must be a number' }, true);
      });
      const error = await failure({
         documentName: 'Actor',
         data: [{ name: 'MOCK_actor' }],
      });
      expect(error.failures).toEqual([
         {
            path: '[0].system.hp',
            message: 'must be a number',
         },
      ]);
   });

   it('walks the failure tree, element and joint failures included, when getAllFailures reports none', async () => {
      world.classes.Actor.cleanData.mockImplementation(() => {
         throw Object.assign(new Error('tree'), {
            getAllFailures: () => ({}),
            getFailure: () => ({
               message: 'root',
               fields: {
                  system: {
                     message: 'inner',
                     fields: {
                        hp: {
                           message: 'must be a number',
                           fields: {},
                           elements: [],
                        },
                     },
                     elements: [],
                  },
               },
               elements: [
                  {
                     id: 'AAAAAAAAAAAAAAAA',
                     failure: {
                        message: 'bad item',
                        fields: {},
                        elements: [],
                     },
                  },
               ],
               joint: 'a conflicts with b',
            }),
         });
      });
      const error = await failure({
         documentName: 'Actor',
         data: [{ name: 'MOCK_actor' }],
      });
      expect(error.failures).toEqual([
         {
            path: '[0].system.hp',
            message: 'must be a number',
         },
         {
            path: '[0].AAAAAAAAAAAAAAAA',
            message: 'bad item',
         },
         {
            path: '[0]',
            message: 'a conflicts with b',
         },
      ]);
      expect(error.failureCount).toBe(3);
   });

   it('reports an error that has no failure table as one failure with its message', async () => {
      world.classes.Actor.cleanData.mockImplementation(() => {
         throw new Error('MOCK_unexpected');
      });
      const error = await failure({
         documentName: 'Actor',
         data: [{ name: 'MOCK_actor' }],
      });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.failures).toEqual([
         {
            path: '[0]',
            message: 'MOCK_unexpected',
         },
      ]);
   });
});

describe('createDocuments: gates and refusals', () => {
   it('judges the gates before it validates', async () => {
      const error = await failure({
         documentName: 'User',
         data: [{
            name: 'MOCK_user',
            invalid: { name: 'bad' }
         }],
      });
      expect(error.code).toBe(GATE_DENIED);
   });

   it('denies a User create while allowUserWrites is closed and creates it once open', async () => {
      const denied = await failure({
         documentName: 'User',
         data: [{
            name: 'MOCK_user',
            role: 1
         }],
      });
      expect(denied.message).toContain('allowUserWrites');
      expect(world.classes.User.createDocuments).not.toHaveBeenCalled();
      gates.allowUserWrites = true;
      const rows = await createDocuments({
         documentName: 'User',
         data: [{
            name: 'MOCK_user',
            role: 1
         }],
      });
      expect(rows).toHaveLength(1);
   });

   it('refuses a password in User data with the gate open', async () => {
      gates.allowUserWrites = true;
      const error = await failure({
         documentName: 'User',
         data: [{
            name: 'MOCK_user',
            password: 'MOCK_secret'
         }],
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('password');
      expect(world.classes.User.createDocuments).not.toHaveBeenCalled();
   });

   it('refuses a wiretap Setting with allowSettingWrites open', async () => {
      gates.allowSettingWrites = true;
      const error = await failure({
         documentName: 'Setting',
         data: [{
            key: 'wiretap.allowUserWrites',
            value: 'true'
         }],
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('Wiretap settings');
      expect(world.classes.Setting.createDocuments).not.toHaveBeenCalled();
   });

   it('judges a Setting create by its key alone: a namespace cannot hide a wiretap key', async () => {
      gates.allowSettingWrites = true;
      const error = await failure({
         documentName: 'Setting',
         data: [{
            key: 'wiretap.x',
            namespace: 'zzz'
         }],
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('Wiretap settings');
      expect(world.classes.Setting.createDocuments).not.toHaveBeenCalled();
   });

   it('judges the module configuration by its key alone: a namespace cannot hide it', async () => {
      gates.allowSettingWrites = true;
      const denied = await failure({
         documentName: 'Setting',
         data: [{
            key: 'core.moduleConfiguration',
            namespace: 'x',
            value: '{}'
         }],
      });
      expect(denied.message).toContain('allowModuleConfigWrites');
      expect(world.classes.Setting.createDocuments).not.toHaveBeenCalled();
   });

   it('writes the key that was checked: Foundry prunes a namespace and keeps data.key', async () => {
      gates.allowSettingWrites = true;
      await createDocuments({
         documentName: 'Setting',
         data: [{
            key: 'mock.setting',
            namespace: 'zzz',
            value: '1'
         }],
      });
      const [stored] = world.classes.Setting.createDocuments.mock.results;
      const [document] = await stored.value;
      expect(document.key).toBe('mock.setting');
      expect(document.toObject()).not.toHaveProperty('namespace');
   });

   it('refuses a Setting create whose key is not text', async () => {
      gates.allowSettingWrites = true;
      for (const key of [
         5,
         { value: 'wiretap.x' },
         ['wiretap.x'],
      ]) {
         const error = await failure({
            documentName: 'Setting',
            data: [{
               key,
               namespace: 'zzz'
            }],
         });
         expect(error.code).toBe(GATE_DENIED);
      }
      expect(world.classes.Setting.createDocuments).not.toHaveBeenCalled();
   });

   it('refuses a Setting create whose key cannot be read', async () => {
      gates.allowSettingWrites = true;
      expect(
         (await failure({
            documentName: 'Setting',
            data: [{ value: '1' }]
         })).code,
      ).toBe(GATE_DENIED);
   });

   it('needs allowModuleConfigWrites for core.moduleConfiguration', async () => {
      gates.allowSettingWrites = true;
      const denied = await failure({
         documentName: 'Setting',
         data: [{
            key: 'core.moduleConfiguration',
            value: '{}'
         }],
      });
      expect(denied.message).toContain('allowModuleConfigWrites');
   });

   it('needs allowOwnershipWrites for a dotted ownership key, also inside embedded data', async () => {
      for (const data of [
         {
            name: 'MOCK_actor',
            'ownership.default': 3
         },
         {
            name: 'MOCK_actor',
            items: [{
               name: 'MOCK_item',
               'ownership.default': 3
            }]
         },
         {
            name: 'MOCK_actor',
            '-=ownership': null
         },
      ]) {
         const error = await failure({
            documentName: 'Actor',
            data: [data],
         });
         expect(error.message).toContain('allowOwnershipWrites');
      }
      expect(world.calls).toEqual([]);
   });

   it('shows the ownership Foundry would write once the dotted key is expanded', async () => {
      gates.allowOwnershipWrites = true;
      await createDocuments({
         documentName: 'Actor',
         data: [{
            name: 'MOCK_actor',
            'ownership.default': 3
         }],
      });
      const [stored] = world.classes.Actor.createDocuments.mock.results;
      const [document] = await stored.value;
      expect(document.toObject().ownership).toEqual({ default: 3 });
   });

   it('cleans control characters out of the created name in the row', async () => {
      const [row] = await createDocuments({
         documentName: 'Actor',
         data: [{
            name: 'MOCK_a\u0000\nb\u001b[31m',
            type: 'npc'
         }],
      });
      expect(row.name).not.toMatch(/[\u0000-\u001f]/);
      expect(row.name.startsWith('MOCK_a')).toBe(true);
   });

   it('needs allowFileUpload for a data URI and allowOwnershipWrites for ownership', async () => {
      const upload = await failure({
         documentName: 'Actor',
         data: [{
            name: 'MOCK_actor',
            img: 'data:image/png;base64,AAAA'
         }],
      });
      expect(upload.message).toContain('allowFileUpload');
      const ownership = await failure({
         documentName: 'Actor',
         data: [{
            name: 'MOCK_actor',
            ownership: { default: 3 }
         }],
      });
      expect(ownership.message).toContain('allowOwnershipWrites');
      expect(world.calls).toEqual([]);
   });
});

describe('createDocuments: dryRun', () => {
   it('validates and returns the would-be rows without calling any write API', async () => {
      const actor = world.add('Actor', { name: 'MOCK_parent' });
      const rows = await createDocuments({
         documentName: 'Item',
         data: [{
            name: 'MOCK_item',
            type: 'weapon'
         }],
         parentUuid: actor.uuid,
         dryRun: true,
      });
      expect(rows).toEqual([
         {
            uuid: null,
            name: 'MOCK_item',
            type: 'weapon',
            dryRun: true,
         },
      ]);
      expect(world.calls).toEqual([]);
      expect(actor.createEmbeddedDocuments).not.toHaveBeenCalled();
      expect(world.classes.Item.createDocuments).not.toHaveBeenCalled();
   });

   it('calls no write API for a world document either', async () => {
      await createDocuments({
         documentName: 'Actor',
         data: [{
            name: 'MOCK_actor',
            type: 'npc'
         }],
         dryRun: true,
      });
      expect(world.calls).toEqual([]);
      expect(world.classes.Actor.createDocuments).not.toHaveBeenCalled();
   });

   it('still reports validation failures and gate denials', async () => {
      const invalid = await failure({
         documentName: 'Actor',
         data: [{
            name: 'MOCK_actor',
            invalid: { name: 'bad' }
         }],
         dryRun: true,
      });
      expect(invalid.code).toBe('VALIDATION_FAILED');
      const denied = await failure({
         documentName: 'User',
         data: [{ name: 'MOCK_user' }],
         dryRun: true,
      });
      expect(denied.code).toBe(GATE_DENIED);
   });
});

describe('createDocuments: documents a hook cancelled', () => {
   it('reports the shortfall instead of acknowledging documents that were not created', async () => {
      world.cancel.cancelCreate = true;
      const error = await failure({
         documentName: 'Actor',
         data: [{ name: 'MOCK_actor' }],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('0 of 1');
   });
});
