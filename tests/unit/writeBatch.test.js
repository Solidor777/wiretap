import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { getBudget } from '$shared/budgets.js';
import { batchDocuments } from '~/bridge/scripts/writeBatch.js';
import { batchHandler } from '~/bridge/scripts/batch.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} A live actor with an item. */
let actor;

/** @type {object} The item of that actor. */
let sword;

/** @type {object} A second actor, to delete or update. */
let other;

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
   });
   sword = world.addChild(actor, 'Item', {
      name: 'MOCK_sword',
      type: 'weapon',
   });
   other = world.add('Actor', {
      name: 'MOCK_other',
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
 * Run `batchDocuments` and return what it threw.
 * @param {object} params - The parameters.
 * @returns {Promise<Error>} The error.
 */
async function failure(params) {
   try {
      await batchDocuments(params);
   } catch (error) {
      return error;
   }
   throw new Error('batchDocuments did not throw');
}

/**
 * A create entry for one actor.
 * @param {string} name - The actor name.
 * @returns {object} The create entry for that actor.
 */
function createEntry(name) {
   return {
      documentName: 'Actor',
      data: [
         {
            name,
            type: 'npc',
         },
      ],
   };
}

/**
 * An update entry for one document.
 * @param {object} document - The document to update.
 * @param {object[]} patches - The patches to apply to it.
 * @returns {object} The update entry for that document.
 */
function updateEntry(document, patches) {
   return {
      uuid: document.uuid,
      patches,
   };
}

describe('batchDocuments: one modifyBatch call', () => {
   it('sends creates, then updates, then deletes as the operations of one batch, and no other write', async () => {
      const result = await batchDocuments({
         creates: [createEntry('MOCK_new')],
         updates: [
            updateEntry(actor, [
               {
                  path: 'system.hp',
                  value: 5
               },
               {
                  path: `items.${sword.id}.name`,
                  value: 'MOCK_renamed'
               },
            ]),
         ],
         deletes: [other.uuid],
      });
      expect(world.calls).toEqual(['modifyBatch']);
      const operations = foundry.documents.modifyBatch.mock.calls[0][0];
      expect(operations.map((operation) => [operation.action, operation.documentName])).toEqual([
         ['create', 'Actor'],
         ['update', 'Actor'],
         ['update', 'Item'],
         ['delete', 'Actor'],
      ]);
      expect(operations[0].data).toEqual([
         {
            name: 'MOCK_new',
            type: 'npc',
            _id: expect.stringMatching(/^[A-Za-z0-9]{16}$/),
         },
      ]);
      expect(operations[0].keepId).toBe(true);
      expect(result.created[0].uuid).toBe(`Actor.${operations[0].data[0]._id}`);
      expect(operations[1].updates).toEqual([
         {
            _id: actor.id,
            'system.hp': 5,
         },
      ]);
      expect(operations[2].parentUuid).toBe(actor.uuid);
      expect(operations[2].updates).toEqual([
         {
            _id: sword.id,
            name: 'MOCK_renamed',
         },
      ]);
      expect(operations[3].ids).toEqual([other.id]);
      expect(result.created).toEqual([
         {
            uuid: expect.stringMatching(/^Actor\./),
            name: 'MOCK_new',
            type: 'npc',
         },
      ]);
      expect(result.updated).toEqual([
         {
            uuid: actor.uuid,
            changed: [
               'system.hp',
               `items.${sword.id}.name`,
            ],
         },
      ]);
      expect(result.deleted).toEqual([
         {
            uuid: other.uuid,
            name: 'MOCK_other',
            type: 'npc',
         },
      ]);
   });

   it('creates embedded documents under a parent and in a pack', async () => {
      await batchDocuments({
         creates: [
            {
               documentName: 'Item',
               data: [
                  {
                     name: 'MOCK_item',
                     type: 'weapon',
                  },
               ],
               parentUuid: actor.uuid,
            },
         ],
      });
      const [operation] = foundry.documents.modifyBatch.mock.calls[0][0];
      expect(operation.parentUuid).toBe(actor.uuid);
      expect(operation.documentName).toBe('Item');
   });

   it('does not mutate the data the caller passed', async () => {
      const params = {
         creates: [createEntry('MOCK_new')],
         updates: [updateEntry(actor, [{
            path: 'system.hp',
            value: { nested: 1 }
         }])],
      };
      const copy = structuredClone(params);
      await batchDocuments(params);
      expect(params).toEqual(copy);
   });

   it('reports a dry run as the would-be result and calls no write API', async () => {
      const result = await batchDocuments({
         creates: [createEntry('MOCK_new')],
         updates: [updateEntry(actor, [{
            path: 'system.hp',
            value: 5
         }])],
         deletes: [other.uuid],
         dryRun: true,
      });
      expect(world.calls).toEqual([]);
      expect(result).toEqual({
         dryRun: true,
         created: [
            {
               uuid: null,
               name: 'MOCK_new',
               type: 'npc',
               dryRun: true,
            },
         ],
         updated: [
            {
               uuid: actor.uuid,
               changed: ['system.hp'],
               dryRun: true,
            },
         ],
         deleted: [
            {
               uuid: other.uuid,
               name: 'MOCK_other',
               type: 'npc',
            },
         ],
      });
   });
});

describe('batchDocuments: validated before anything is written', () => {
   it('returns the failures of a later invalid operation and sends nothing', async () => {
      const error = await failure({
         creates: [createEntry('MOCK_new')],
         updates: [updateEntry(actor, [{
            path: 'system.hp',
            value: 'INVALID'
         }])],
      });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.failures[0].path).toContain('updates[0]');
      expect(world.calls).toEqual([]);
   });

   it('names the create entry that failed', async () => {
      const error = await failure({
         creates: [
            createEntry('MOCK_fine'),
            {
               documentName: 'Actor',
               data: [
                  {
                     name: 'MOCK_bad',
                     invalid: { name: 'bad' },
                  },
               ],
            },
         ],
      });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.failures[0].path).toBe('creates[1][0].name');
      expect(world.calls).toEqual([]);
   });

   it('refuses an empty batch and one over the document limit', async () => {
      expect((await failure({})).code).toBe('ARGS_INVALID');
      const max = getBudget('WRITE_DOCUMENTS_MAX').value;
      const error = await failure({
         creates: [
            {
               documentName: 'Actor',
               data: Array.from({ length: max }, (_, index) => ({ name: `MOCK_${index}` })),
            },
         ],
         deletes: [other.uuid],
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('refuses operations that touch one document twice', async () => {
      for (const params of [
         {
            updates: [updateEntry(actor, [{
               path: 'name',
               value: 'MOCK_x'
            }])],
            deletes: [actor.uuid],
         },
         {
            updates: [updateEntry(sword, [{
               path: 'name',
               value: 'MOCK_x'
            }])],
            deletes: [actor.uuid],
         },
         { deletes: [other.uuid, other.uuid] },
      ]) {
         const error = await failure(params);
         expect(error.code, JSON.stringify(params)).toBe('ARGS_INVALID');
      }
      expect(world.calls).toEqual([]);
   });
});

describe('batchDocuments: every operation goes through the write guard', () => {
   it('needs allowUserWrites for a User create, update and delete, with nothing sent', async () => {
      const user = world.add('User', {
         name: 'MOCK_user',
         role: 1,
      });
      for (const params of [
         {
            creates: [{
               documentName: 'User',
               data: [{ name: 'MOCK_new' }]
            }]
         },
         {
            updates: [updateEntry(user, [{
               path: 'name',
               value: 'MOCK_x'
            }])]
         },
         { deletes: [user.uuid] },
      ]) {
         const error = await failure(params);
         expect(error.code, JSON.stringify(params)).toBe(GATE_DENIED);
         expect(error.message).toContain('allowUserWrites');
      }
      expect(world.calls).toEqual([]);
   });

   it('refuses a User password in any operation, whatever the gate', async () => {
      gates.allowUserWrites = true;
      const user = world.add('User', {
         name: 'MOCK_user',
         role: 1,
      });
      for (const params of [
         {
            creates: [{
               documentName: 'User',
               data: [{
                  name: 'MOCK_new',
                  password: 'MOCK_secret'
               }]
            }]
         },
         {
            updates: [updateEntry(user, [{
               path: 'password',
               value: 'MOCK_secret'
            }])]
         },
      ]) {
         const error = await failure(params);
         expect(error.message).toContain('password');
      }
      expect(world.calls).toEqual([]);
   });

   it('refuses a wiretap Setting in a create, an update and a delete even with allowSettingWrites open', async () => {
      gates.allowSettingWrites = true;
      const gate = world.add('Setting', {
         key: 'wiretap.allowUserWrites',
         value: 'false',
      });
      for (const params of [
         {
            creates: [{
               documentName: 'Setting',
               data: [{
                  key: 'wiretap.x',
                  namespace: 'zzz',
                  value: '1'
               }]
            }]
         },
         {
            updates: [updateEntry(gate, [{
               path: 'value',
               value: 'true'
            }])]
         },
         { deletes: [gate.uuid] },
      ]) {
         const error = await failure(params);
         expect(error.code, JSON.stringify(params)).toBe(GATE_DENIED);
         expect(error.message).toContain('Wiretap settings');
      }
      expect(world.calls).toEqual([]);
   });

   it('needs allowSettingWrites and allowModuleConfigWrites for Settings', async () => {
      const setting = world.add('Setting', {
         key: 'core.moduleConfiguration',
         value: '{}',
      });
      const closed = await failure({ deletes: [setting.uuid] });
      expect(closed.message).toContain('allowSettingWrites');
      gates.allowSettingWrites = true;
      const config = await failure({ deletes: [setting.uuid] });
      expect(config.message).toContain('allowModuleConfigWrites');
   });

   it('needs allowOwnershipWrites, allowFileUpload and allowCompendiumWrites', async () => {
      const packed = world.add(
         'Actor',
         {
            name: 'MOCK_packed',
            type: 'npc',
         },
         { pack: 'mock.pack' },
      );
      const cases = [
         [
            {
               creates: [{
                  documentName: 'Actor',
                  data: [{
                     name: 'MOCK_a',
                     'ownership.default': 3
                  }]
               }]
            },
            'allowOwnershipWrites',
         ],
         [
            {
               updates: [updateEntry(actor, [{
                  path: 'ownership.default',
                  value: 3
               }])]
            },
            'allowOwnershipWrites',
         ],
         [
            {
               updates: [updateEntry(actor, [{
                  path: 'img',
                  value: 'data:image/png;base64,AAAA'
               }])]
            },
            'allowFileUpload',
         ],
         [
            { deletes: [packed.uuid] },
            'allowCompendiumWrites',
         ],
      ];
      for (const [params, gate] of cases) {
         const error = await failure(params);
         expect(error.message, gate).toContain(gate);
      }
      expect(world.calls).toEqual([]);
   });

   it('refuses the reserved wiretap flag scope in a create and an update', async () => {
      for (const params of [
         {
            creates: [{
               documentName: 'Actor',
               data: [{
                  name: 'MOCK_a',
                  flags: { wiretap: {} }
               }]
            }]
         },
         {
            updates: [updateEntry(actor, [{
               path: 'flags.wiretap.x',
               value: 1
            }])]
         },
      ]) {
         const error = await failure(params);
         expect(error.message).toContain('flags.wiretap');
      }
      expect(world.calls).toEqual([]);
   });

   it('refuses to delete the signed-in user', async () => {
      gates.allowUserWrites = true;
      const me = world.add('User', {
         _id: 'MOCKGM0000000001',
         name: 'MOCK_gm',
         role: 4,
      });
      me.id = 'MOCKGM0000000001';
      globalThis.fromUuid = vi.fn(async () => me);
      const error = await failure({ deletes: [me.uuid] });
      expect(error.code).toBe('DELETE_REFUSED');
   });
});

describe('batchDocuments: actAs', () => {
   it('refuses when the user may not perform any operation, nothing is sent', async () => {
      for (const params of [
         { creates: [createEntry('MOCK_a')] },
         {
            updates: [updateEntry(actor, [{
               path: 'name',
               value: 'MOCK_x'
            }])]
         },
         { deletes: [other.uuid] },
      ]) {
         const error = await failure({
            ...params,
            actAs: 'MOCKPLAYER00001',
         });
         expect(error.code, JSON.stringify(params)).toBe('ACT_AS_DENIED');
      }
      expect(world.calls).toEqual([]);
   });

   it('lets a game master through', async () => {
      const result = await batchDocuments({
         deletes: [other.uuid],
         actAs: 'MOCKGM0000000001',
      });
      expect(result.deleted).toHaveLength(1);
   });
});

describe('batchDocuments: not atomic', () => {
   it('reports how many operations were applied when Foundry stops part way', async () => {
      world.batch.failAt = 1;
      const error = await failure({
         creates: [createEntry('MOCK_new')],
         updates: [updateEntry(actor, [{
            path: 'name',
            value: 'MOCK_x'
         }])],
         deletes: [other.uuid],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('1 of 3 operations');
      expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(256);
   });

   it('says nothing was applied when Foundry refuses the whole batch', async () => {
      world.batch.rejectAll = true;
      const error = await failure({ deletes: [other.uuid] });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('0 of 1 operations');
   });

   it('reports a hook that cancelled part of an operation', async () => {
      world.cancel.cancelDelete = true;
      const error = await failure({ deletes: [other.uuid] });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
   });
});

describe('batch: created rows follow the order of the entries', () => {
   /** @type {string[]} The names created, in entry order. */
   const names = [
      'MOCK_0',
      'MOCK_1',
      'MOCK_2',
   ];

   it('answers one group of several creates in data order when Foundry answers in reverse', async () => {
      world.createOrder.reverse = true;
      const result = await batchDocuments({
         creates: [
            {
               documentName: 'Actor',
               data: names.map((name) => ({
                  name,
                  type: 'npc',
               })),
            },
         ],
      });
      expect(result.created.map((row) => row.name)).toEqual(names);
      expect(result.created.map((row) => world.byUuid.get(row.uuid)?.name)).toEqual(names);
   });

   it('answers mixed classes [Actor A, embedded P, Item B, Actor C, embedded Q] in entry order, also on a dry run',
      async () => {
         world.createOrder.reverse = true;
         /** @type {object} The batch arguments: two actors and a world item, with two embedded items between them. */
         const args = {
            creates: [
               {
                  documentName: 'Actor',
                  data: '{"name":"MOCK_A","type":"npc"}',
               },
               {
                  documentName: 'Item',
                  parentUuid: actor.uuid,
                  data: '{"name":"MOCK_P","type":"weapon"}',
               },
               {
                  documentName: 'Item',
                  data: '{"name":"MOCK_B","type":"weapon"}',
               },
               {
                  documentName: 'Actor',
                  data: '{"name":"MOCK_C","type":"npc"}',
               },
               {
                  documentName: 'Item',
                  parentUuid: actor.uuid,
                  data: '{"name":"MOCK_Q","type":"weapon"}',
               },
            ],
         };
         /** @type {object} A context whose core runs the real batch. */
         const ctx = { core: { batchDocuments } };
         /** @type {string[]} The names in entry order. */
         const expected = [
            'MOCK_A',
            'MOCK_P',
            'MOCK_B',
            'MOCK_C',
            'MOCK_Q',
         ];
         const preview = await batchHandler(
            {
               ...args,
               dryRun: true,
            },
            ctx,
         );
         expect(preview.created.map((row) => row.name)).toEqual(expected);
         const result = await batchHandler(args, ctx);
         expect(result.created.map((row) => row.name)).toEqual(expected);
         expect(result.created.map((row) => world.byUuid.get(row.uuid)?.name)).toEqual(expected);
         expect(result.created[1].uuid.startsWith(`${actor.uuid}.Item.`)).toBe(true);
         expect(result.created[4].uuid.startsWith(`${actor.uuid}.Item.`)).toBe(true);
      });
});
