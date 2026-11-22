import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { getBudget } from '$shared/budgets.js';
import { definitionBytes, validateScriptDefinition } from '$shared/scripts.js';
import { compileSchema } from '$shared/schemaValidate.js';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import {
   createDocumentsDefinition,
   deleteDocumentsDefinition,
   updateDocumentsDefinition,
} from '~/bridge/scripts/definitions.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import { installWriteWorld } from './mockWriteWorld.js';

/** @type {ReturnType<typeof createScriptRegistry>} A registry holding the shipped scripts. */
let registry;

/** @type {(params: unknown) => Promise<unknown>} The callTool handler over that registry. */
let callTool;

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

/** @type {object} A live actor with two items. */
let actor;

/** @type {object} The first item. */
let sword;

/** @type {object} The second item. */
let shield;

beforeEach(() => {
   registry = createScriptRegistry({ log: () => {} });
   registerShippedScripts(registry);
   callTool = createCallTool({ registry });
   world = installWriteWorld(vi.fn, {
      users: [
         {
            id: 'MOCKGM0000000001',
            role: 4,
         },
         {
            id: 'MOCKGM0000000002',
            role: 4,
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
 * Call a registered tool.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @returns {Promise<unknown>} The result.
 */
function call(name, args) {
   return callTool({
      name,
      arguments: args,
   });
}

/**
 * Call a tool that must fail and return the error.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @returns {Promise<Error>} The error.
 */
async function failure(name, args) {
   try {
      await call(name, args);
   } catch (error) {
      return error;
   }
   throw new Error(`${name} did not throw`);
}

/**
 * Measure a value as serialized JSON.
 * @param {unknown} value - The value whose serialized size is measured.
 * @returns {number} The UTF-8 bytes.
 */
function bytes(value) {
   return new TextEncoder().encode(JSON.stringify(value)).length;
}

describe('shipped scripts', () => {
   it('register without a refusal, in the shipped order', () => {
      const fresh = createScriptRegistry({ log: () => {} });
      const outcomes = registerShippedScripts(fresh);
      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      expect(fresh.definitions().map((definition) => definition.name)).toEqual([
         'list_document_types',
         'get_document',
         'search_documents',
         'describe_schema',
         'create_documents',
         'update_documents',
         'delete_documents',
         'replace_document',
         'batch',
         'open_sheet',
         'close_sheet',
         'roll',
         'draw_table',
         'execute_macro',
         'create_pack',
         'delete_pack',
      ]);
   });

   it('keep the whole listed definition set within the total budget', () => {
      let total = 0;
      for (const definition of registry.definitions()) {
         const { listed } = compileSchema(definition.inputSchema);
         total += definitionBytes(definition.name, definition.description, listed);
      }
      expect(total).toBeLessThanOrEqual(getBudget('ALL_DEFINITIONS_MAX_BYTES').value);
   });
});

describe.each([
   [
      'create_documents',
      createDocumentsDefinition,
      'ACK_BATCH_MAX_BYTES',
   ],
   [
      'update_documents',
      updateDocumentsDefinition,
      'ACK_BATCH_MAX_BYTES',
   ],
   [
      'delete_documents',
      deleteDocumentsDefinition,
      'RESULT_HARD_CAP_DEFAULT_BYTES',
   ],
])('%s definition', (name, definition, budgetName) => {
   it('is a mutating api script with no whole-tool gate and the budgeted result', () => {
      expect(definition.name).toBe(name);
      expect(definition.mutates).toBe(true);
      expect(definition.requires).toBe('api');
      expect(definition.gate).toBeUndefined();
      expect(definition.result.budgetBytes).toBe(getBudget(budgetName).value);
   });

   it('passes the shared validator with no warning', () => {
      const outcome = validateScriptDefinition(definition, 'shipped');
      expect(outcome.ok, outcome.reason).toBe(true);
      expect(outcome.warnings).toEqual([]);
   });

   it('lists within the definition budget and the description limit', () => {
      const compiled = compileSchema(definition.inputSchema);
      expect(compiled.ok).toBe(true);
      expect(definitionBytes(definition.name, definition.description, compiled.listed)).toBeLessThanOrEqual(
         getBudget('DEFINITION_MAX_BYTES').value,
      );
      expect(definition.description.length).toBeLessThanOrEqual(getBudget('DESCRIPTION_TARGET_CHARS').value);
   });

   it('registers in the shipped registry', () => {
      expect(registry.definitions().map((entry) => entry.name)).toContain(name);
   });
});

describe('delete_documents definition', () => {
   it('says the deletion is irreversible within 240 characters', () => {
      expect(deleteDocumentsDefinition.description).toMatch(/irreversible/i);
      expect(deleteDocumentsDefinition.description.length).toBeLessThanOrEqual(240);
   });
});

describe('create_documents', () => {
   it('parses the JSON text of each document and acks uuid, name and type', async () => {
      const result = await call('create_documents', {
         documentName: 'Actor',
         data: [
            '{"name":"MOCK_a","type":"npc","system":{"hp":3}}',
            '{"name":"MOCK_b","type":"npc"}',
         ],
      });
      expect(world.classes.Actor.createDocuments.mock.calls[0][0]).toEqual([
         {
            name: 'MOCK_a',
            type: 'npc',
            system: { hp: 3 },
            _id: expect.stringMatching(/^[A-Za-z0-9]{16}$/),
         },
         {
            name: 'MOCK_b',
            type: 'npc',
            _id: expect.stringMatching(/^[A-Za-z0-9]{16}$/),
         },
      ]);
      expect(result).toEqual([
         {
            uuid: expect.stringMatching(/^Actor\./),
            name: 'MOCK_a',
            type: 'npc',
         },
         {
            uuid: expect.stringMatching(/^Actor\./),
            name: 'MOCK_b',
            type: 'npc',
         },
      ]);
      for (const row of result) {
         expect(bytes(row)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
      }
   });

   it('creates embedded documents under parentUuid and passes keepId', async () => {
      await call('create_documents', {
         documentName: 'Item',
         data: ['{"_id":"AAAAAAAAAAAAAAAA","name":"MOCK_item","type":"weapon"}'],
         parentUuid: actor.uuid,
         keepId: true,
      });
      expect(actor.createEmbeddedDocuments).toHaveBeenCalledTimes(1);
      expect(actor.createEmbeddedDocuments.mock.calls[0][2]).toMatchObject({ keepId: true });
   });

   it('acks 50 documents with 128-character names within 4 KB and 256 B each', async () => {
      const data = Array.from({ length: 50 }, (_, index) =>
         JSON.stringify({
            name: `${index}`.padEnd(128, 'N'),
            type: 'weapon',
         }),
      );
      const result = await call('create_documents', {
         documentName: 'Item',
         data,
         parentUuid: actor.uuid,
      });
      expect(result).toHaveLength(50);
      expect(bytes(result)).toBeLessThanOrEqual(getBudget('ACK_BATCH_MAX_BYTES').value);
      for (const row of result) {
         expect(bytes(row)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
         expect(row.uuid).toMatch(/^Actor\./);
      }
   });

   it('refuses text that is not a JSON object, naming the entry', async () => {
      for (const text of [
         'not json',
         '[1]',
         '5',
         'null',
         '"x"',
         '',
      ]) {
         const error = await failure('create_documents', {
            documentName: 'Actor',
            data: [
               '{"name":"MOCK_ok"}',
               text,
            ],
         });
         expect(error.code, text).toBe('ARGS_INVALID');
         expect(error.message, text).toContain('data[1]');
      }
      expect(world.calls).toEqual([]);
   });

   it('refuses more JSON text than the data bound before parsing it', async () => {
      const big = JSON.stringify({ name: 'x'.repeat(90_000) });
      const error = await failure('create_documents', {
         documentName: 'Actor',
         data: [
            big,
            big,
            big,
         ],
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('200000');
      expect(world.calls).toEqual([]);
   });

   it('refuses more than 50 documents through the argument schema', async () => {
      const error = await failure('create_documents', {
         documentName: 'Actor',
         data: Array.from({ length: 51 }, () => '{"name":"MOCK"}'),
      });
      expect(error.code).toBe('ARGS_INVALID');
   });

   it('dry-runs: rows marked dryRun and no write API called', async () => {
      const result = await call('create_documents', {
         documentName: 'Actor',
         data: ['{"name":"MOCK_a","type":"npc"}'],
         dryRun: true,
      });
      expect(result).toEqual([
         {
            uuid: null,
            name: 'MOCK_a',
            type: 'npc',
            dryRun: true,
         },
      ]);
      expect(world.calls).toEqual([]);
   });

   it('reads back paths on the ack of each created document', async () => {
      const result = await call('create_documents', {
         documentName: 'Actor',
         data: ['{"name":"MOCK_a","type":"npc","system":{"hp":3}}'],
         paths: [
            'system.hp',
            'system.missing',
         ],
      });
      expect(result[0].values).toEqual({ 'system.hp': 3 });
      expect(result[0].missing).toEqual(['system.missing']);
      expect(bytes(result)).toBeLessThanOrEqual(getBudget('ACK_BATCH_MAX_BYTES').value);
   });

   it('keeps every ack row with read-back within 256 bytes: a value that does not fit is marked cut', async () => {
      const note = 'N'.repeat(300);
      const result = await call('create_documents', {
         documentName: 'Actor',
         data: [JSON.stringify({
            name: 'MOCK_a',
            type: 'npc',
            system: { note }
         })],
         paths: ['system.note'],
      });
      expect(bytes(result[0])).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
      expect(result[0]).toMatchObject({
         name: 'MOCK_a',
         type: 'npc',
         cut: true,
      });
      expect(result[0].values).toBeUndefined();
      expect(result[0].uuid).toMatch(/^Actor\./);
   });

   it('refuses a bad read-back path before writing anything', async () => {
      const error = await failure('create_documents', {
         documentName: 'Actor',
         data: ['{"name":"MOCK_a","type":"npc"}'],
         paths: ['system..hp'],
      });
      expect(error.code).toBe('PATH_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('returns at most 10 failures with the true count of 30 for invalid data', async () => {
      const invalid = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`system.f${index}`, 'bad']));
      const error = await failure('create_documents', {
         documentName: 'Actor',
         data: [JSON.stringify({
            name: 'MOCK_a',
            invalid
         })],
      });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.failures).toHaveLength(10);
      expect(error.failureCount).toBe(30);
   });

   it('denies a User create while the gate is closed', async () => {
      const error = await failure('create_documents', {
         documentName: 'User',
         data: ['{"name":"MOCK_user"}'],
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(world.calls).toEqual([]);
   });
});

describe('update_documents', () => {
   it('parses each value as JSON, groups the entries of one uuid and acks the changed paths', async () => {
      const result = await call('update_documents', {
         updates: [
            {
               uuid: actor.uuid,
               path: 'system.hp',
               value: '5',
            },
            {
               uuid: actor.uuid,
               path: 'name',
               value: '"MOCK_renamed"',
            },
            {
               uuid: shield.uuid,
               path: 'system.armor',
               value: '{"value":2}',
            },
         ],
      });
      expect(actor.update).toHaveBeenCalledTimes(1);
      expect(actor.update.mock.calls[0][0]).toEqual({
         'system.hp': 5,
         name: 'MOCK_renamed',
      });
      expect(shield.update.mock.calls[0][0]).toEqual({ 'system.armor': { value: 2 } });
      expect(result).toEqual([
         {
            uuid: actor.uuid,
            changed: [
               'system.hp',
               'name',
            ],
         },
         {
            uuid: shield.uuid,
            changed: ['system.armor'],
         },
      ]);
   });

   it('groups embedded paths into updateEmbeddedDocuments and maps op replace and delete', async () => {
      await call('update_documents', {
         updates: [
            {
               uuid: actor.uuid,
               path: `items.${sword.id}.system.a`,
               value: '[1]',
               op: 'replace',
            },
            {
               uuid: actor.uuid,
               path: `items.${sword.id}.system.b`,
               op: 'delete',
            },
            {
               uuid: actor.uuid,
               path: `items.${shield.id}.name`,
               value: '"MOCK_buckler"',
            },
         ],
      });
      expect(actor.updateEmbeddedDocuments).toHaveBeenCalledTimes(1);
      const [name, entries] = actor.updateEmbeddedDocuments.mock.calls[0];
      expect(name).toBe('Item');
      expect(entries[0]['system.a']).toBeInstanceOf(foundry.data.operators.ForcedReplacement);
      expect(foundry.data.operators.DataFieldOperator.get(entries[0]['system.a'])).toEqual([1]);
      expect(entries[0]['system.b']).toBeInstanceOf(foundry.data.operators.ForcedDeletion);
      expect(entries[1].name).toBe('MOCK_buckler');
   });

   it('refuses a value that is not JSON, a value with op delete and a wildcard', async () => {
      const bad = await failure('update_documents', {
         updates: [
            {
               uuid: actor.uuid,
               path: 'name',
               value: 'not json',
            },
         ],
      });
      expect(bad.code).toBe('ARGS_INVALID');
      expect(bad.message).toContain('updates[0].value');
      const withDelete = await failure('update_documents', {
         updates: [
            {
               uuid: actor.uuid,
               path: 'name',
               value: '1',
               op: 'delete',
            },
         ],
      });
      expect(withDelete.code).toBe('ARGS_INVALID');
      const wildcard = await failure('update_documents', {
         updates: [
            {
               uuid: actor.uuid,
               path: 'items.*.name',
               value: '"MOCK_x"',
            },
         ],
      });
      expect(wildcard.code).toBe('PATH_WILDCARD_WRITE');
      expect(world.calls).toEqual([]);
   });

   it('refuses a set with no value', async () => {
      const error = await failure('update_documents', {
         updates: [
            {
               uuid: actor.uuid,
               path: 'name',
            },
         ],
      });
      expect(error.code).toBe('PATH_INVALID');
   });

   it('dry-runs: rows marked dryRun and no write API called', async () => {
      const result = await call('update_documents', {
         updates: [
            {
               uuid: actor.uuid,
               path: 'name',
               value: '"MOCK_x"',
            },
         ],
         dryRun: true,
      });
      expect(result).toEqual([
         {
            uuid: actor.uuid,
            changed: ['name'],
            dryRun: true,
         },
      ]);
      expect(world.calls).toEqual([]);
   });

   it('reads back paths after the write', async () => {
      const result = await call('update_documents', {
         updates: [
            {
               uuid: actor.uuid,
               path: 'name',
               value: '"MOCK_x"',
            },
         ],
         paths: [
            'name',
            'nope',
         ],
      });
      expect(result[0].values).toEqual({ name: 'MOCK_x' });
      expect(result[0].missing).toEqual(['nope']);
   });

   it('acks 50 documents within 4 KB and 256 B each', async () => {
      const documents = Array.from({ length: 50 }, (_, index) => world.add('Item', { name: `MOCK_item${index}` }));
      const result = await call('update_documents', {
         updates: documents.flatMap((document) =>
            Array.from({ length: 4 }, (_, index) => ({
               uuid: document.uuid,
               path: `system.some.long.field.name.number${index}`,
               value: '1',
            })),
         ),
      });
      expect(result).toHaveLength(50);
      expect(bytes(result)).toBeLessThanOrEqual(getBudget('ACK_BATCH_MAX_BYTES').value);
      for (const row of result) {
         expect(bytes(row)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
      }
   });

   it('refuses updates of more than 50 documents', async () => {
      const documents = Array.from({ length: 51 }, (_, index) => world.add('Item', { name: `MOCK_item${index}` }));
      const error = await failure('update_documents', {
         updates: documents.map((document) => ({
            uuid: document.uuid,
            path: 'name',
            value: '"MOCK_x"',
         })),
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('returns at most 10 failures with the true count of 30 for invalid values', async () => {
      const updates = Array.from({ length: 30 }, (_, index) => ({
         uuid: index < 20 ? actor.uuid : shield.uuid,
         path: `system.f${index}`,
         value: '"INVALID"',
      }));
      const error = await failure('update_documents', { updates });
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.failures).toHaveLength(10);
      expect(error.failureCount).toBe(30);
   });

   it('denies a wiretap Setting update with the gate open', async () => {
      gates.allowSettingWrites = true;
      const setting = world.add('Setting', {
         key: 'wiretap.allowUserWrites',
         value: 'false'
      });
      const error = await failure('update_documents', {
         updates: [
            {
               uuid: setting.uuid,
               path: 'value',
               value: '"true"',
            },
         ],
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(setting.update).not.toHaveBeenCalled();
   });
});

describe('delete_documents', () => {
   it('deletes and acks uuid, name and type', async () => {
      const result = await call('delete_documents', { uuids: [actor.uuid] });
      expect(result).toEqual([
         {
            uuid: actor.uuid,
            name: 'MOCK_actor',
            type: 'npc',
         },
      ]);
   });

   it('dry-runs: lists `[uuid, name, type]` rows with the embedded cascade and calls no write API', async () => {
      const result = await call('delete_documents', {
         uuids: [actor.uuid],
         dryRun: true,
      });
      expect(result.dryRun).toBe(true);
      expect(result.total).toBe(3);
      expect(result.rows).toEqual([
         [
            actor.uuid,
            'MOCK_actor',
            'npc',
         ],
         [
            sword.uuid,
            'MOCK_sword',
            'weapon',
         ],
         [
            shield.uuid,
            'MOCK_shield',
            'armor',
         ],
      ]);
      expect(world.calls).toEqual([]);
   });

   it('keeps a dry run within the hard cap for a huge cascade', async () => {
      for (let index = 0; index < 600; index += 1) {
         world.addChild(actor, 'Item', {
            name: `MOCK_${index}`.padEnd(64, 'N'),
            type: 'weapon'
         });
      }
      const result = await call('delete_documents', {
         uuids: [actor.uuid],
         dryRun: true,
      });
      expect(bytes(result)).toBeLessThanOrEqual(getBudget('RESULT_HARD_CAP_DEFAULT_BYTES').value);
      expect(result.total).toBe(603);
      expect(result.cut).toBe(true);
      expect(result.rows.length).toBeGreaterThan(0);
   });

   it('acks 50 deletions within 4 KB and 256 B each', async () => {
      const documents = Array.from({ length: 50 }, (_, index) =>
         world.add('Item', {
            name: `${index}`.padEnd(100, 'N'),
            type: 'weapon'
         }),
      );
      const result = await call('delete_documents', { uuids: documents.map((document) => document.uuid) });
      expect(result).toHaveLength(50);
      expect(bytes(result)).toBeLessThanOrEqual(getBudget('ACK_BATCH_MAX_BYTES').value);
      for (const row of result) {
         expect(bytes(row)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
      }
   });

   it('denies a User deletion while the gate is closed and writes nothing', async () => {
      const user = world.add('User', {
         _id: 'MOCKGM0000000002',
         name: 'MOCK_gm',
         role: 4,
      });
      const error = await failure('delete_documents', { uuids: [user.uuid] });
      expect(error.code).toBe(GATE_DENIED);
      expect(world.calls).toEqual([]);
   });

   it('refuses more than 50 uuids through the argument schema', async () => {
      const error = await failure('delete_documents', {
         uuids: Array.from({ length: 51 }, (_, index) => `Actor.${index}`),
      });
      expect(error.code).toBe('ARGS_INVALID');
   });
});
