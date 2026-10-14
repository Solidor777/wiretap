import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { getBudget } from '$shared/budgets.js';
import { definitionBytes, validateScriptDefinition } from '$shared/scripts.js';
import { compileSchema } from '$shared/schemaValidate.js';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import { batchDefinition, replaceDocumentDefinition } from '~/bridge/scripts/definitions.js';
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

/** @type {object} A live actor. */
let actor;

beforeEach(() => {
   registry = createScriptRegistry({ log: () => {} });
   registerShippedScripts(registry);
   callTool = createCallTool({ registry });
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
   globalThis.game.version = '14.364';
   globalThis.CONST.PRIMARY_DOCUMENT_TYPES = [
      'Actor',
      'Item',
      'ActiveEffect',
      'Setting',
      'User',
      'JournalEntry',
      'Scene',
   ];
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
 * Call a registered tool.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @returns {Promise<any>} The result.
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

describe.each([
   [
      'replace_document',
      replaceDocumentDefinition,
      'ACK_MAX_BYTES',
   ],
   [
      'batch',
      batchDefinition,
      'ACK_BATCH_MAX_BYTES',
   ],
])('%s definition', (name, definition, budgetName) => {
   it('is a mutating api script with no whole-tool gate and the budgeted result', () => {
      expect(definition.name).toBe(name);
      expect(definition.mutates).toBe(true);
      expect(definition.requires).toBe('api');
      expect(definition.gate).toBeUndefined();
      expect(definition.result.budgetBytes).toBe(getBudget(budgetName).value);
   });

   it('passes the shared validator with no warning and lists within the budgets', () => {
      const outcome = validateScriptDefinition(definition, 'shipped');
      expect(outcome.ok, outcome.reason).toBe(true);
      expect(outcome.warnings).toEqual([]);
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

describe('handle inputs', () => {
   it('names data as the handle argument of create_documents and replace_document and of no other tool', () => {
      for (const definition of registry.definitions()) {
         expect(definition.handleArgs, definition.name).toEqual(
            ['create_documents', 'replace_document'].includes(definition.name) ? ['data'] : undefined,
         );
      }
   });
});

describe('batch definition', () => {
   it('says the batch is not atomic', () => {
      expect(batchDefinition.description).toMatch(/not atomic/i);
   });
});

describe('every write tool accepts actAs', () => {
   it('lists an optional actAs string in each write definition', () => {
      for (const name of [
         'create_documents',
         'update_documents',
         'delete_documents',
         'replace_document',
         'batch',
      ]) {
         const definition = registry.definitions().find((entry) => entry.name === name);
         expect(definition.inputSchema.properties.actAs, name).toEqual({ type: 'string' });
         expect(definition.inputSchema.required ?? [], name).not.toContain('actAs');
      }
   });

   it('refuses an actAs user who may not write, for each tool, and writes nothing', async () => {
      const calls = [
         [
            'create_documents',
            {
               documentName: 'Actor',
               data: ['{"name":"MOCK_a","type":"npc"}'],
            },
         ],
         [
            'update_documents',
            {
               updates: [{
                  uuid: actor.uuid,
                  path: 'name',
                  value: '"MOCK_x"'
               }]
            },
         ],
         [
            'delete_documents',
            { uuids: [actor.uuid] },
         ],
         [
            'replace_document',
            {
               uuid: actor.uuid,
               data: '{"name":"MOCK_x","type":"npc"}'
            },
         ],
         [
            'batch',
            { deletes: [actor.uuid] },
         ],
      ];
      for (const [name, args] of calls) {
         const error = await failure(name, {
            ...args,
            actAs: 'MOCKPLAYER00001',
         });
         expect(error.code, name).toBe('ACT_AS_DENIED');
      }
      expect(world.calls).toEqual([]);
   });
});

describe('create_documents: idempotencyKey', () => {
   it('is a bounded optional string and a repeated call returns the first rows', async () => {
      const definition = registry.definitions().find((entry) => entry.name === 'create_documents');
      expect(definition.inputSchema.properties.idempotencyKey.type).toBe('string');
      expect(definition.inputSchema.properties.idempotencyKey.maxLength).toBe(64);
      const args = {
         documentName: 'Actor',
         data: ['{"name":"MOCK_a","type":"npc"}'],
         idempotencyKey: 'call-1',
      };
      const first = await call('create_documents', args);
      const second = await call('create_documents', args);
      expect(second).toEqual(first);
      expect(world.classes.Actor.createDocuments).toHaveBeenCalledTimes(1);
   });

   it('refuses a different request under the same key', async () => {
      await call('create_documents', {
         documentName: 'Actor',
         data: ['{"name":"MOCK_a","type":"npc"}'],
         idempotencyKey: 'call-1',
      });
      const error = await failure('create_documents', {
         documentName: 'Actor',
         data: ['{"name":"MOCK_b","type":"npc"}'],
         idempotencyKey: 'call-1',
      });
      expect(error.code).toBe('IDEMPOTENCY_CONFLICT');
   });

   it('cannot be forged through update_documents, replace_document or create data', async () => {
      const forged = '{"k":"call-1","i":0,"n":1,"h":"x"}';
      for (const [name, args] of [
         [
            'update_documents',
            {
               updates: [{
                  uuid: actor.uuid,
                  path: 'flags.wiretap.idem',
                  value: forged
               }]
            },
         ],
         [
            'update_documents',
            {
               updates: [{
                  uuid: actor.uuid,
                  path: 'flags',
                  value: `{"wiretap":{"idem":${forged}}}`,
                  op: 'replace'
               }]
            },
         ],
         [
            'replace_document',
            {
               uuid: actor.uuid,
               data: `{"name":"MOCK_x","type":"npc","flags.wiretap.idem":${forged}}`
            },
         ],
         [
            'create_documents',
            {
               documentName: 'Actor',
               data: [`{"name":"MOCK_x","flags.wiretap.idem":${forged}}`]
            },
         ],
      ]) {
         const error = await failure(name, args);
         expect(error.code, name).toBe(GATE_DENIED);
         expect(error.message).toContain('flags.wiretap');
      }
      expect(world.calls).toEqual([]);
   });
});

describe('replace_document', () => {
   it('parses the JSON text, replaces and acks uuid and the changed top-level fields within 256 bytes', async () => {
      const result = await call('replace_document', {
         uuid: actor.uuid,
         data: '{"name":"MOCK_replaced","type":"npc","system":{"hp":9}}',
      });
      expect(actor.update).toHaveBeenCalledTimes(1);
      expect(actor.update.mock.calls[0][1]).toEqual({
         diff: false,
         recursive: false,
      });
      expect(result).toEqual({
         uuid: actor.uuid,
         changed: [
            'name',
            'type',
            'system',
         ],
      });
      expect(bytes(result)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
   });

   it('marks a dry run and writes nothing', async () => {
      const result = await call('replace_document', {
         uuid: actor.uuid,
         data: '{"name":"MOCK_replaced","type":"npc"}',
         dryRun: true,
      });
      expect(result.dryRun).toBe(true);
      expect(actor.update).not.toHaveBeenCalled();
      expect(world.calls).toEqual([]);
   });

   it('refuses data that is not a JSON object', async () => {
      for (const data of [
         'not json',
         '[1]',
         '5',
      ]) {
         const error = await failure('replace_document', {
            uuid: actor.uuid,
            data,
         });
         expect(error.code, data).toBe('ARGS_INVALID');
      }
      expect(actor.update).not.toHaveBeenCalled();
   });

   it('keeps the ack within 256 bytes for a document with many top-level fields', async () => {
      const fields = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`field${index}Name`, index]));
      const result = await call('replace_document', {
         uuid: actor.uuid,
         data: JSON.stringify({
            name: 'MOCK_replaced',
            type: 'npc',
            ...fields,
         }),
      });
      expect(bytes(result)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
      expect(result.more).toBeGreaterThan(0);
   });

   it('reads back paths on the ack within 256 bytes', async () => {
      const result = await call('replace_document', {
         uuid: actor.uuid,
         data: '{"name":"MOCK_replaced","type":"npc","system":{"hp":9}}',
         paths: ['system.hp'],
      });
      expect(result.values).toEqual({ 'system.hp': 9 });
      expect(bytes(result)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
   });

   it('goes through the write guard: a closed gate stops the write', async () => {
      const error = await failure('replace_document', {
         uuid: actor.uuid,
         data: '{"name":"MOCK_renamed","ownership":{"default":3}}',
      });
      expect(error.code).toBe(GATE_DENIED);
      expect(error.message).toContain('allowOwnershipWrites');
      expect(actor.update).not.toHaveBeenCalled();
   });
});

describe('batch', () => {
   it('groups the flat patches by uuid, parses the JSON texts and acks created, updated and deleted rows', async () => {
      const other = world.add('Actor', {
         name: 'MOCK_other',
         type: 'npc',
      });
      const result = await call('batch', {
         creates: [
            {
               documentName: 'Actor',
               data: '{"name":"MOCK_new","type":"npc"}',
            },
         ],
         updates: [
            {
               uuid: actor.uuid,
               path: 'system.hp',
               value: '5'
            },
            {
               uuid: actor.uuid,
               path: 'system.note',
               value: '"x"'
            },
         ],
         deletes: [other.uuid],
      });
      expect(world.calls).toEqual(['modifyBatch']);
      expect(result.created).toHaveLength(1);
      expect(result.updated).toEqual([
         {
            uuid: actor.uuid,
            changed: [
               'system.hp',
               'system.note',
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

   it('groups the create entries of one class and parent into one operation', async () => {
      await call('batch', {
         creates: [
            {
               documentName: 'Actor',
               data: '{"name":"MOCK_a","type":"npc"}'
            },
            {
               documentName: 'Actor',
               data: '{"name":"MOCK_b","type":"npc"}'
            },
         ],
      });
      const operations = foundry.documents.modifyBatch.mock.calls[0][0];
      expect(operations).toHaveLength(1);
      expect(operations[0].data.map((item) => item.name)).toEqual([
         'MOCK_a',
         'MOCK_b',
      ]);
   });

   it('refuses a create entry without documentName and data', async () => {
      const error = await failure('batch', { creates: [{ documentName: 'Actor' }] });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('creates[0]');
   });

   it('refuses a value that is not JSON text, naming the entry', async () => {
      const error = await failure('batch', {
         updates: [{
            uuid: actor.uuid,
            path: 'system.hp',
            value: 'nope'
         }]
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('updates[0]');
   });

   it('acks a 50-document batch within 4,000 bytes', async () => {
      const targets = Array.from({ length: 15 }, (_, index) =>
         world.add('Actor', {
            name: `MOCK_target_${'T'.repeat(100)}_${index}`,
            type: 'npc',
         }),
      );
      const doomed = Array.from({ length: 15 }, (_, index) =>
         world.add('Actor', {
            name: `MOCK_doomed_${'D'.repeat(100)}_${index}`,
            type: 'npc',
         }),
      );
      const result = await call('batch', {
         creates: Array.from({ length: 20 }, (_, index) => ({
            documentName: 'Actor',
            data: JSON.stringify({
               name: `MOCK_new_${'N'.repeat(100)}_${index}`,
               type: 'npc',
            }),
         })),
         updates: targets.flatMap((target) => [
            {
               uuid: target.uuid,
               path: 'system.some.rather.long.field.path.one',
               value: '1'
            },
            {
               uuid: target.uuid,
               path: 'system.some.rather.long.field.path.two',
               value: '2'
            },
         ]),
         deletes: doomed.map((document) => document.uuid),
      });
      expect(bytes(result)).toBeLessThanOrEqual(getBudget('ACK_BATCH_MAX_BYTES').value);
      expect(result.created.length + result.updated.length + result.deleted.length).toBeGreaterThan(0);
   });

   it('marks a dry run and sends nothing', async () => {
      const result = await call('batch', {
         deletes: [actor.uuid],
         dryRun: true,
      });
      expect(result.dryRun).toBe(true);
      expect(world.calls).toEqual([]);
   });

   it('reports a partial batch as WRITE_NOT_APPLIED', async () => {
      const other = world.add('Actor', {
         name: 'MOCK_other',
         type: 'npc',
      });
      world.batch.failAt = 1;
      const error = await failure('batch', {
         updates: [{
            uuid: actor.uuid,
            path: 'name',
            value: '"MOCK_x"'
         }],
         deletes: [other.uuid],
      });
      expect(error.code).toBe('WRITE_NOT_APPLIED');
      expect(error.message).toContain('1 of 2 operations');
   });
});

describe('batch arguments', () => {
   it('refuses a misspelled top-level argument and sends nothing', async () => {
      const error = await failure('batch', {
         deletes: [actor.uuid],
         dryrun: true,
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(world.calls).toEqual([]);
   });

   it('checks each entry in the handler: required keys, op and the path grammar', async () => {
      for (const [args, code] of [
         [
            { creates: [{
               documentName: 'Actor',
               dataa: '{}'
            }] },
            'ARGS_INVALID',
         ],
         [
            { creates: [{ data: '{"name":"MOCK_a","type":"npc"}' }] },
            'ARGS_INVALID',
         ],
         [
            { updates: [{
               uuid: actor.uuid,
               path: 'name',
               value: '"MOCK_x"',
               op: 'merge'
            }] },
            'PATH_INVALID_OP',
         ],
         [
            { updates: [{
               path: 'name',
               value: '"MOCK_x"'
            }] },
            'ARGS_INVALID',
         ],
         [
            { updates: [{ uuid: actor.uuid }] },
            'ARGS_INVALID',
         ],
      ]) {
         const error = await failure('batch', args);
         expect(error.code, JSON.stringify(args)).toBe(code);
      }
      expect(world.calls).toEqual([]);
   });

   it('counts the data of the creates and the values of the updates against one total', async () => {
      /** @type {string} A data text of about 90,000 bytes. */
      const big = `{"name":"${'a'.repeat(89_980)}","type":"npc"}`;
      const error = await failure('batch', {
         creates: [
            {
               documentName: 'Actor',
               data: big,
            },
            {
               documentName: 'Actor',
               data: big,
            },
         ],
         updates: [{
            uuid: actor.uuid,
            path: 'system.note',
            value: JSON.stringify('b'.repeat(89_980)),
         }],
      });
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('in all');
      expect(world.calls).toEqual([]);
   });
});
