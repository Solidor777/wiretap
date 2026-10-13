import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { getBudget } from '$shared/budgets.js';
import { updateDocuments } from '~/bridge/scripts/writes.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} A live actor with two items and an effect. */
let actor;

/** @type {object} The first item of the actor. */
let sword;

/** @type {object} The second item of the actor. */
let shield;

/** @type {object} The effect of the actor. */
let glow;

beforeEach(() => {
   world = installWriteWorld(vi.fn);
   gates = {};
   globalThis.game.settings.get = (module, key) => gates[key];
   actor = world.add('Actor', {
      name: 'MOCK_actor',
      type: 'npc'
   });
   sword = world.addChild(actor, 'Item', {
      name: 'MOCK_sword',
      type: 'weapon'
   });
   shield = world.addChild(actor, 'Item', {
      name: 'MOCK_shield',
      type: 'armor'
   });
   glow = world.addChild(actor, 'ActiveEffect', { name: 'MOCK_glow' });
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
 * Run `updateDocuments` and return what it threw.
 * @param {object} params - The parameters.
 * @returns {Promise<Error>} The error.
 */
async function failure(params) {
   try {
      await updateDocuments(params);
   } catch (error) {
      return error;
   }
   throw new Error('updateDocuments did not throw');
}

/**
 * Build the update of one document.
 * @param {object} document - The mock document to update.
 * @param {object[]} patches - The patches to apply to the document.
 * @returns {{ uuid: string, patches: object[] }} One update entry for the document.
 */
function update(document, patches) {
   return {
      uuid: document.uuid,
      patches,
   };
}

describe('updateDocuments: targets', () => {
   it('refuses the uuid of a compendium pack and a value that is not a document', async () => {
      const pack = await failure({
         updates: [{
            uuid: 'Compendium.mock.pack',
            patches: [{
               path: 'name',
               value: 'MOCK_x'
            }]
         }],
      });
      expect(pack.code).toBe('ARGS_INVALID');
      globalThis.fromUuid = vi.fn(async () => ({ uuid: 'Mock.thing' }));
      const error = await failure({
         updates: [{
            uuid: 'Mock.thing',
            patches: [{
               path: 'name',
               value: 'MOCK_x'
            }]
         }],
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('refuses two updates that resolve to the same document, whatever their uuid text', async () => {
      globalThis.fromUuid = vi.fn(async () => actor);
      const error = await failure({
         updates: [
            update(actor, [{
               path: 'name',
               value: 'MOCK_one'
            }]),
            {
               uuid: 'Alias.of.actor',
               patches: [{
                  path: 'system.hp',
                  value: 1
               }],
            },
         ],
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('refuses an embedded document updated both through its parent and by its own uuid', async () => {
      const error = await failure({
         updates: [
            update(actor, [{
               path: `items.${sword.id}.name`,
               value: 'MOCK_one'
            }]),
            update(sword, [{
               path: 'name',
               value: 'MOCK_two'
            }]),
         ],
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('reports which updates were applied when a later one fails', async () => {
      const other = world.add('Actor', {
         name: 'MOCK_other',
         type: 'npc'
      });
      other.update.mockRejectedValueOnce(new Error('MOCK_db_down'));
      const error = await failure({
         updates: [
            update(actor, [{
               path: 'name',
               value: 'MOCK_one'
            }]),
            update(other, [{
               path: 'name',
               value: 'MOCK_two'
            }]),
         ],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain(actor.uuid);
      expect(error.message).toContain('MOCK_db_down');
      expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(256);
   });

   it('rethrows the failure of the first update as it is, since nothing was applied', async () => {
      actor.update.mockRejectedValueOnce(new Error('MOCK_db_down'));
      const error = await failure({
         updates: [update(actor, [{
            path: 'name',
            value: 'MOCK_one'
         }])]
      });
      expect(error.message).toBe('MOCK_db_down');
   });
});

describe('updateDocuments: document paths', () => {
   it('updates the document with the paths as dotted keys and acks the changed paths', async () => {
      const rows = await updateDocuments({
         updates: [
            update(actor, [
               {
                  path: 'system.hp',
                  value: 5
               },
               {
                  path: 'name',
                  value: 'MOCK_renamed'
               },
            ]),
         ],
      });
      expect(actor.update).toHaveBeenCalledTimes(1);
      expect(actor.update.mock.calls[0][0]).toEqual({
         'system.hp': 5,
         name: 'MOCK_renamed',
      });
      expect(actor.updateEmbeddedDocuments).not.toHaveBeenCalled();
      expect(rows).toEqual([
         {
            uuid: actor.uuid,
            changed: [
               'system.hp',
               'name',
            ],
         },
      ]);
   });

   it('maps op replace to ForcedReplacement and op delete to ForcedDeletion', async () => {
      await updateDocuments({
         updates: [
            update(actor, [
               {
                  path: 'system.a',
                  value: { x: 1 },
                  op: 'replace'
               },
               {
                  path: 'system.b',
                  op: 'delete'
               },
               {
                  path: 'system.c',
                  value: 3,
                  op: 'set'
               },
            ]),
         ],
      });
      const changes = actor.update.mock.calls[0][0];
      expect(changes['system.a']).toEqual({
         operator: 'replace',
         operatorValue: { x: 1 },
      });
      expect(changes['system.b'].operator).toBe('delete');
      expect(changes['system.c']).toBe(3);
   });

   it('updates an embedded document addressed by its own uuid', async () => {
      const rows = await updateDocuments({
         updates: [update(sword, [{
            path: 'system.quantity',
            value: 2
         }])]
      });
      expect(sword.update.mock.calls[0][0]).toEqual({ 'system.quantity': 2 });
      expect(rows[0].uuid).toBe(sword.uuid);
   });

   it('reports an empty changed list when Foundry applied nothing', async () => {
      world.cancel.cancelUpdate = true;
      const rows = await updateDocuments({
         updates: [update(actor, [{
            path: 'name',
            value: 'MOCK_x'
         }])]
      });
      expect(rows).toEqual([
         {
            uuid: actor.uuid,
            changed: [],
         },
      ]);
   });

   it('does not mutate the patches the caller passed', async () => {
      const patches = [{
         path: 'system.a',
         value: { x: 1 }
      }];
      const copy = structuredClone(patches);
      await updateDocuments({ updates: [update(actor, patches)] });
      expect(patches).toEqual(copy);
   });
});

describe('updateDocuments: embedded paths', () => {
   it('groups embedded paths into one updateEmbeddedDocuments call per collection', async () => {
      const rows = await updateDocuments({
         updates: [
            update(actor, [
               {
                  path: `items.${sword.id}.system.uses`,
                  value: 2
               },
               {
                  path: `items.${sword.id}.name`,
                  value: 'MOCK_blade'
               },
               {
                  path: `items.${shield.id}.system.armor`,
                  value: 7
               },
               {
                  path: `effects.${glow.id}.disabled`,
                  value: true
               },
            ]),
         ],
      });
      expect(actor.update).not.toHaveBeenCalled();
      expect(actor.updateEmbeddedDocuments).toHaveBeenCalledTimes(2);
      expect(actor.updateEmbeddedDocuments.mock.calls[0]).toEqual([
         'Item',
         [
            {
               _id: sword.id,
               'system.uses': 2,
               name: 'MOCK_blade',
            },
            {
               _id: shield.id,
               'system.armor': 7,
            },
         ],
      ]);
      expect(actor.updateEmbeddedDocuments.mock.calls[1]).toEqual([
         'ActiveEffect',
         [
            {
               _id: glow.id,
               disabled: true,
            },
         ],
      ]);
      expect(rows[0].changed).toEqual([
         `items.${sword.id}.system.uses`,
         `items.${sword.id}.name`,
         `items.${shield.id}.system.armor`,
         `effects.${glow.id}.disabled`,
      ]);
   });

   it('updates the document and its embedded documents in one call', async () => {
      await updateDocuments({
         updates: [
            update(actor, [
               {
                  path: 'name',
                  value: 'MOCK_renamed'
               },
               {
                  path: `items.${sword.id}.name`,
                  value: 'MOCK_blade'
               },
            ]),
         ],
      });
      expect(actor.update).toHaveBeenCalledTimes(1);
      expect(actor.updateEmbeddedDocuments).toHaveBeenCalledTimes(1);
   });

   it('maps op replace and op delete inside an embedded document', async () => {
      await updateDocuments({
         updates: [
            update(actor, [
               {
                  path: `items.${sword.id}.system.a`,
                  value: [1],
                  op: 'replace'
               },
               {
                  path: `items.${sword.id}.system.b`,
                  op: 'delete'
               },
            ]),
         ],
      });
      const [, entries] = actor.updateEmbeddedDocuments.mock.calls[0];
      expect(entries[0]['system.a']).toEqual({
         operator: 'replace',
         operatorValue: [1],
      });
      expect(entries[0]['system.b'].operator).toBe('delete');
   });

   it('refuses an embedded id that does not exist, before it writes anything', async () => {
      const error = await failure({
         updates: [
            update(shield, [{
               path: 'name',
               value: 'MOCK_x'
            }]),
            update(actor, [{
               path: 'items.AAAAAAAAAAAAAAAA.name',
               value: 'MOCK_y'
            }]),
         ],
      });
      expect(error.code).toBe('DOC_NOT_FOUND');
      expect(world.calls).toEqual([]);
   });
});

describe('updateDocuments: path grammar refusals', () => {
   it.each([
      [
         'a wildcard',
         [{
            path: 'items.*.name',
            value: 'MOCK_x'
         }],
         'PATH_WILDCARD_WRITE',
      ],
      [
         'a path that is the prefix of another',
         [
            {
               path: 'system',
               value: {}
            },
            {
               path: 'system.hp',
               value: 1
            },
         ],
         'PATH_CONFLICT',
      ],
      [
         'an unsafe segment',
         [{
            path: 'system.__proto__.x',
            value: 1
         }],
         'PATH_UNSAFE_SEGMENT',
      ],
      [
         'an unsafe key in a value',
         [{
            path: 'system',
            value: JSON.parse('{"__proto__": {"x": 1}}')
         }],
         'PATH_UNSAFE_VALUE',
      ],
      [
         'a numeric embedded id',
         [{
            path: 'items.0.name',
            value: 'MOCK_x'
         }],
         'PATH_INVALID',
      ],
      [
         'a duplicate path',
         [
            {
               path: 'name',
               value: 'MOCK_a'
            },
            {
               path: 'name',
               value: 'MOCK_b'
            },
         ],
         'PATH_DUPLICATE',
      ],
      [
         'a set with no value',
         [{ path: 'name' }],
         'PATH_INVALID',
      ],
   ])('refuses %s with its path code and writes nothing', async (label, patches, code) => {
      const error = await failure({ updates: [update(actor, patches)] });
      expect(error.code).toBe(code);
      expect(world.calls).toEqual([]);
   });

   it('refuses a missing document and a repeated uuid', async () => {
      const missing = await failure({
         updates: [{
            uuid: 'Actor.AAAAAAAAAAAAAAAA',
            patches: [{
               path: 'name',
               value: 'MOCK_x'
            }]
         }],
      });
      expect(missing.code).toBe('DOC_NOT_FOUND');
      expect(
         (
            await failure({
               updates: [
                  update(actor, [{
                     path: 'name',
                     value: 'MOCK_a'
                  }]),
                  update(actor, [{
                     path: 'system.hp',
                     value: 1
                  }]),
               ],
            })
         ).code,
      ).toBe('ARGS_INVALID');
   });

   it('refuses an empty call and a call over the document bound', async () => {
      expect((await failure({ updates: [] })).code).toBe('ARGS_INVALID');
      const tooMany = Array.from({ length: getBudget('WRITE_DOCUMENTS_MAX').value + 1 }, () =>
         update(actor, [{
            path: 'name',
            value: 'MOCK_x'
         }]),
      );
      expect((await failure({ updates: tooMany })).code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });
});

describe('updateDocuments: validation', () => {
   it('returns the failures and writes none of the updates', async () => {
      const error = await failure({
         updates: [
            update(actor, [{
               path: 'name',
               value: 'MOCK_ok'
            }]),
            update(shield, [{
               path: 'system.armor',
               value: 'INVALID'
            }]),
         ],
      });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.failures).toEqual([
         {
            path: '[1].system.armor',
            message: 'is invalid',
         },
      ]);
      expect(world.calls).toEqual([]);
   });

   it('names the embedded path of a failing embedded change', async () => {
      const error = await failure({
         updates: [update(actor, [{
            path: `items.${sword.id}.system.uses`,
            value: 'INVALID'
         }])],
      });
      expect(error.failures[0].path).toBe(`[0].items.${sword.id}.system.uses`);
      expect(world.calls).toEqual([]);
   });

   it('reports at most 10 failures with the true total of 30', async () => {
      const patches = Array.from({ length: 20 }, (_, index) => ({
         path: `system.a${index}`,
         value: 'INVALID'
      }));
      const more = Array.from({ length: 10 }, (_, index) => ({
         path: `system.b${index}`,
         value: 'INVALID'
      }));
      const error = await failure({
         updates: [
            update(actor, patches),
            update(shield, more),
         ],
      });
      expect(error.failures).toHaveLength(10);
      expect(error.failureCount).toBe(30);
   });
});

describe('updateDocuments: gates and refusals', () => {
   it('denies a User update while allowUserWrites is closed and updates it once open', async () => {
      const user = world.add('User', {
         name: 'MOCK_user',
         role: 1
      });
      const denied = await failure({
         updates: [update(user, [{
            path: 'role',
            value: 2
         }])]
      });
      expect(denied.code).toBe(GATE_DENIED);
      expect(denied.message).toContain('allowUserWrites');
      expect(user.update).not.toHaveBeenCalled();
      gates.allowUserWrites = true;
      await updateDocuments({
         updates: [update(user, [{
            path: 'role',
            value: 2
         }])]
      });
      expect(user.update).toHaveBeenCalledTimes(1);
   });

   it('refuses a password path of a User update with the gate open', async () => {
      gates.allowUserWrites = true;
      const user = world.add('User', { name: 'MOCK_user' });
      for (const path of [
         'password',
         'passwordSalt',
      ]) {
         const error = await failure({
            updates: [update(user, [{
               path,
               value: 'MOCK_secret'
            }])]
         });
         expect(error.code, path).toBe(GATE_DENIED);
         expect(error.message, path).toContain('password');
      }
      expect(user.update).not.toHaveBeenCalled();
   });

   it('refuses a by-id update of a wiretap Setting that carries no key, using the key of the document', async () => {
      gates.allowSettingWrites = true;
      const setting = world.add('Setting', {
         key: 'wiretap.allowUserWrites',
         value: 'false'
      });
      const error = await failure({
         updates: [update(setting, [{
            path: 'value',
            value: 'true'
         }])]
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('Wiretap settings');
      expect(setting.update).not.toHaveBeenCalled();
   });

   it('refuses an update that renames a Setting into the wiretap namespace', async () => {
      gates.allowSettingWrites = true;
      const setting = world.add('Setting', {
         key: 'mock.setting',
         value: '1'
      });
      for (const value of [
         'wiretap.allowUserWrites',
         5,
         null,
      ]) {
         const error = await failure({
            updates: [update(setting, [{
               path: 'key',
               value
            }])]
         });
         expect(error.code, String(value)).toBe(GATE_DENIED);
      }
      expect(setting.update).not.toHaveBeenCalled();
   });

   it('judges a Setting key patch by the patch value alone: an object with a namespace is refused', async () => {
      gates.allowSettingWrites = true;
      const setting = world.add('Setting', {
         key: 'mock.setting',
         value: '1'
      });
      for (const value of [
         {
            key: 'wiretap.x',
            namespace: 'zzz'
         },
         {
            key: 'core.moduleConfiguration',
            namespace: 'x'
         },
         ['wiretap.x'],
      ]) {
         const error = await failure({
            updates: [update(setting, [{
               path: 'key',
               value
            }])]
         });
         expect(error.code, JSON.stringify(value)).toBe(GATE_DENIED);
      }
      expect(setting.update).not.toHaveBeenCalled();
   });

   it('updates an ordinary Setting once allowSettingWrites is open, and not before', async () => {
      const setting = world.add('Setting', {
         key: 'mock.setting',
         value: '1'
      });
      const denied = await failure({
         updates: [update(setting, [{
            path: 'value',
            value: '2'
         }])]
      });
      expect(denied.message).toContain('allowSettingWrites');
      gates.allowSettingWrites = true;
      await updateDocuments({
         updates: [update(setting, [{
            path: 'value',
            value: '2'
         }])]
      });
      expect(setting.update).toHaveBeenCalledTimes(1);
   });

   it('needs allowModuleConfigWrites for the module configuration setting', async () => {
      gates.allowSettingWrites = true;
      const setting = world.add('Setting', {
         key: 'core.moduleConfiguration',
         value: '{}'
      });
      const denied = await failure({
         updates: [update(setting, [{
            path: 'value',
            value: '{}'
         }])]
      });
      expect(denied.message).toContain('allowModuleConfigWrites');
      gates.allowModuleConfigWrites = true;
      await updateDocuments({
         updates: [update(setting, [{
            path: 'value',
            value: '{}'
         }])]
      });
      expect(setting.update).toHaveBeenCalledTimes(1);
   });

   it('needs allowOwnershipWrites for a dotted ownership key inside a value', async () => {
      const error = await failure({
         updates: [update(actor, [{
            path: 'system.x',
            value: { 'ownership.default': 3 }
         }])],
      });
      expect(error.message).toContain('allowOwnershipWrites');
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('needs allowOwnershipWrites for an ownership path, also inside an embedded path', async () => {
      const own = await failure({
         updates: [update(actor, [{
            path: 'ownership.default',
            value: 3
         }])]
      });
      expect(own.message).toContain('allowOwnershipWrites');
      const embedded = await failure({
         updates: [update(actor, [{
            path: `items.${sword.id}.ownership.default`,
            value: 3
         }])],
      });
      expect(embedded.message).toContain('allowOwnershipWrites');
      gates.allowOwnershipWrites = true;
      await updateDocuments({
         updates: [update(actor, [{
            path: 'ownership.default',
            value: 3
         }])]
      });
      expect(actor.update).toHaveBeenCalledTimes(1);
   });

   it('needs allowFileUpload for a data URI value', async () => {
      const uri = 'data:image/png;base64,AAAA';
      const denied = await failure({
         updates: [update(actor, [{
            path: 'img',
            value: uri
         }])]
      });
      expect(denied.message).toContain('allowFileUpload');
      await updateDocuments({
         updates: [update(actor, [{
            path: 'img',
            value: 'icons/svg/mystery-man.svg'
         }])]
      });
      expect(actor.update).toHaveBeenCalledTimes(1);
   });

   it('needs allowCompendiumWrites for a document that lives in a pack', async () => {
      const packed = world.add('Actor', { name: 'MOCK_packed' }, { pack: 'world.actors' });
      const denied = await failure({
         updates: [update(packed, [{
            path: 'name',
            value: 'MOCK_x'
         }])]
      });
      expect(denied.message).toContain('allowCompendiumWrites');
      expect(packed.update).not.toHaveBeenCalled();
   });

   it('writes none of the updates when a later one is denied', async () => {
      const user = world.add('User', { name: 'MOCK_user' });
      const error = await failure({
         updates: [
            update(actor, [{
               path: 'name',
               value: 'MOCK_x'
            }]),
            update(user, [{
               path: 'role',
               value: 2
            }]),
         ],
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(world.calls).toEqual([]);
   });
});

describe('updateDocuments: dryRun', () => {
   it('validates and returns the would-be rows without calling any write API', async () => {
      const rows = await updateDocuments({
         updates: [
            update(actor, [
               {
                  path: 'name',
                  value: 'MOCK_x'
               },
               {
                  path: `items.${sword.id}.name`,
                  value: 'MOCK_y'
               },
            ]),
         ],
         dryRun: true,
      });
      expect(rows).toEqual([
         {
            uuid: actor.uuid,
            changed: [
               'name',
               `items.${sword.id}.name`,
            ],
            dryRun: true,
         },
      ]);
      expect(world.calls).toEqual([]);
      expect(actor.update).not.toHaveBeenCalled();
      expect(actor.updateEmbeddedDocuments).not.toHaveBeenCalled();
      expect(sword.update).not.toHaveBeenCalled();
   });

   it('still reports validation failures and gate denials', async () => {
      expect(
         (await failure({
            updates: [update(actor, [{
               path: 'name',
               value: 'INVALID'
            }])],
            dryRun: true
         })).code,
      ).toBe('VALIDATION_FAILED');
      const user = world.add('User', { name: 'MOCK_user' });
      expect(
         (await failure({
            updates: [update(user, [{
               path: 'role',
               value: 2
            }])],
            dryRun: true
         })).code,
      ).toBe(GATE_DENIED);
   });
});

describe('updateDocuments: read-back', () => {
   it('adds the exported document after the write when requested', async () => {
      const rows = await updateDocuments({
         updates: [update(actor, [{
            path: 'name',
            value: 'MOCK_x'
         }])],
         readback: true,
      });
      expect(rows[0].exported).toMatchObject({ name: 'MOCK_actor' });
   });
});
