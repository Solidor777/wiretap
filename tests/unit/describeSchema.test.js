import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getBudget } from '$shared/budgets.js';
import { compileSchema } from '$shared/schemaValidate.js';
import { definitionBytes, validateScriptDefinition } from '$shared/scripts.js';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import { describeSchemaDefinition } from '~/bridge/scripts/definitions.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import * as F from './mockFields.js';

/** @type {TextEncoder} Measures serialized sizes in UTF-8 bytes. */
const ENCODER = new TextEncoder();

/** @type {(params: unknown) => Promise<any>} The callTool handler over a registry of the shipped scripts. */
let callTool;

/** @type {Array<[string, Record<string, unknown>]>} The data each mocked blank document was constructed with. */
let constructed;

/**
 * Call describe_schema.
 * @param {Record<string, unknown>} args - The arguments.
 * @returns {Promise<any>} The result.
 */
function describe_(args) {
   return callTool({
      name: 'describe_schema',
      arguments: args,
   });
}

/**
 * Build a mocked document class whose blank export is the data it was built with plus given extra fields.
 * @param {string} documentName - The document class the mock stands for.
 * @param {Record<string, F.DataField>} fields - The top-level schema fields.
 * @param {object} [options] - Extra blank fields and whether construction throws.
 * @param {Record<string, unknown>} [options.blank] - Extra fields of the blank export.
 * @param {boolean} [options.throws] - Whether construction throws.
 * @param {string} [options.failure] - The message of the construction error.
 * @returns {Function} A class with a static schema and a blank-export method.
 */
function documentClass(documentName, fields, { blank = {}, throws = false, failure = 'MOCK_BLANK_FAILS' } = {}) {
   return class {
      static documentName = documentName;
      static schema = new F.SchemaField(fields);

      /**
       * Build a blank document.
       * @param {Record<string, unknown>} data - The construction data.
       */
      constructor(data) {
         if (throws) {
            throw new Error(failure);
         }
         constructed.push([
            documentName,
            data,
         ]);
         this.documentName = documentName;
         this.data = data;
         this.key = data.key;
      }

      /**
       * Export the blank document.
       * @returns {Record<string, unknown>} The data plus the extra blank fields.
       */
      toCompendium() {
         return {
            _id: null,
            ...this.data,
            ...blank,
         };
      }
   };
}

beforeEach(() => {
   constructed = [];
   const registry = createScriptRegistry({ log: () => {} });
   registerShippedScripts(registry);
   callTool = createCallTool({ registry });
   const typeData = new F.TypeDataField();
   typeData.document = { documentName: 'Actor' };
   globalThis.CONST = {
      BASE_DOCUMENT_TYPE: 'base',
      ALL_DOCUMENT_TYPES: [
         'Actor',
         'Folder',
         'Item',
         'Setting',
         'User',
      ],
   };
   globalThis.game = {
      documentTypes: {
         Actor: [
            'base',
            'player',
         ],
         Folder: [
            'Actor',
            'Item',
         ],
         Item: ['base'],
         Setting: ['base'],
         User: ['base'],
      },
      settings: { get: () => false },
   };
   globalThis.CONFIG = {
      Actor: {
         documentClass: documentClass(
            'Actor',
            {
               name: new F.StringField({ required: true }),
               type: new F.StringField({ required: true }),
               system: typeData,
               items: new F.EmbeddedCollectionField({ documentName: 'Item' }),
               flags: new F.DocumentFlagsField(),
            },
            { blank: { system: {
               attributes: { hp: 3 },
               notes: '',
            } } },
         ),
         dataModels: {
            player: {
               schema: new F.SchemaField({
                  attributes: new F.SchemaField({
                     hp: new F.NumberField({
                        integer: true,
                        min: 0,
                        max: 99,
                        required: true,
                     }),
                     mode: new F.StringField({ choices: [
                        'a',
                        'b',
                     ] }),
                  }),
                  notes: new F.HTMLField({ blank: true }),
               }),
            },
         },
      },
      Folder: {
         documentClass: documentClass('Folder', {
            name: new F.StringField(),
            type: new F.StringField({ choices: [
               'Actor',
               'Item',
            ] }),
         }),
      },
      Item: { documentClass: documentClass('Item', { name: new F.StringField() }) },
      Setting: {
         documentClass: documentClass('Setting', {
            key: new F.StringField({ required: true }),
            value: new F.AnyField(),
         }),
      },
      User: {
         documentClass: documentClass(
            'User',
            {
               name: new F.StringField(),
               password: new F.StringField(),
               passwordSalt: new F.StringField(),
               role: new F.NumberField({ integer: true }),
            },
            { blank: {
               password: 'MOCK_HASH',
               passwordSalt: 'MOCK_SALT',
               role: 1,
            } },
         ),
      },
   };
});

afterEach(() => {
   delete globalThis.CONST;
   delete globalThis.CONFIG;
   delete globalThis.game;
});

describe('describe_schema definition', () => {
   it('is a read-only api script within the definition and result budgets', () => {
      const outcome = validateScriptDefinition(describeSchemaDefinition, 'shipped');
      expect(outcome.ok).toBe(true);
      expect(outcome.warnings).toEqual([]);
      expect(describeSchemaDefinition.mutates).toBe(false);
      expect(describeSchemaDefinition.requires).toBe('api');
      expect(describeSchemaDefinition.gate).toBeUndefined();
      expect(describeSchemaDefinition.result.budgetBytes).toBe(getBudget('DESCRIBE_SCHEMA_MAX_BYTES').value);
      expect(describeSchemaDefinition.inputSchema.required).toEqual(['documentName']);
      /** @type {import('$shared/scripts.js').ScriptDefinition} The definition under test. */
      const { name, description, inputSchema } = describeSchemaDefinition;
      expect(definitionBytes(name, description, compileSchema(inputSchema).listed)).toBeLessThanOrEqual(
         getBudget('DEFINITION_MAX_BYTES').value,
      );
      expect(description.length).toBeLessThanOrEqual(getBudget('DESCRIPTION_TARGET_CHARS').value);
   });

   it('refuses a missing documentName and an over-long path before anything runs', async () => {
      await expect(describe_({})).rejects.toMatchObject({ code: 'ARGS_INVALID' });
      await expect(describe_({
         documentName: 'Actor',
         path: 'p'.repeat(600),
      })).rejects.toMatchObject({
         code: 'ARGS_INVALID',
      });
   });
});

describe('describe_schema without a path', () => {
   it('returns the blank export, the core outline and the outline of the subtype system schema', async () => {
      const result = await describe_({
         documentName: 'Actor',
         subtype: 'player',
      });
      expect(result.documentName).toBe('Actor');
      expect(result.subtype).toBe('player');
      expect(result.example).toMatchObject({
         name: 'Example',
         type: 'player',
         system: { attributes: { hp: 3 } },
      });
      expect(result.outline).toEqual([
         [
            'name',
            'StringField',
         ],
         [
            'type',
            'StringField',
         ],
         [
            'system',
            'TypeDataField',
         ],
         [
            'items',
            'EmbeddedCollectionField',
            'Item',
         ],
         [
            'flags',
            'DocumentFlagsField',
         ],
      ]);
      expect(result.systemOutline).toEqual([
         [
            'attributes',
            'SchemaField',
         ],
         [
            'notes',
            'HTMLField',
         ],
      ]);
   });

   it('uses the base type for a typed class without a subtype, and refuses an unknown subtype', async () => {
      const result = await describe_({ documentName: 'Actor' });
      expect(result.subtype).toBe('base');
      expect(constructed[0][1].type).toBe('base');
      const error = await describe_({
         documentName: 'Actor',
         subtype: 'vehicle',
      }).catch((caught) => caught);
      expect(error.code).toBe('ARGS_INVALID');
      expect(error.message).toContain('player');
      expect(ENCODER.encode(error.message).length).toBeLessThanOrEqual(256);
      await expect(describe_({ documentName: 'Nonsense' })).rejects.toMatchObject({ code: 'ARGS_INVALID' });
   });

   it('builds blank examples that need minimal data and reports a failed blank without throwing', async () => {
      const folder = await describe_({
         documentName: 'Folder',
         subtype: 'Item',
      });
      expect(constructed.find(([name]) => name === 'Folder')[1]).toMatchObject({ type: 'Item' });
      expect(folder.example).toBeDefined();
      const setting = await describe_({ documentName: 'Setting' });
      expect(constructed.find(([name]) => name === 'Setting')[1].key).toBe('core.example');
      expect(JSON.stringify(setting).toLowerCase()).not.toContain('wiretap');
      globalThis.CONFIG.Item.documentClass = documentClass('Item', { name: new F.StringField() }, { throws: true });
      const failed = await describe_({ documentName: 'Item' });
      expect(failed.example).toBeNull();
      expect(failed.exampleNote).toEqual(expect.any(String));
      expect(failed.outline).toEqual([[
         'name',
         'StringField',
      ]]);
   });

   it('logs a bounded, sanitized note when a blank cannot be built and keeps the example null', async () => {
      /** @type {string[]} The lines the registry log sink received. */
      const lines = [];
      const registry = createScriptRegistry({ log: (line) => lines.push(line) });
      registerShippedScripts(registry);
      callTool = createCallTool({ registry });
      lines.length = 0;
      globalThis.CONFIG.Item.documentClass = documentClass(
         'Item',
         { name: new F.StringField() },
         {
            throws: true,
            failure: `MOCK_FAILS
[31m${'x'.repeat(600)}`,
         },
      );
      const failed = await describe_({ documentName: 'Item' });
      expect(failed.example).toBeNull();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('Item');
      expect(lines[0]).toContain('MOCK_FAILS');
      expect(lines[0]).not.toMatch(/[ -]/);
      expect(ENCODER.encode(lines[0]).length).toBeLessThanOrEqual(256);
   });

   it('shows no password field of a User in the example or the outline', async () => {
      const result = await describe_({ documentName: 'User' });
      const text = JSON.stringify(result);
      expect(text).not.toContain('password');
      expect(text).not.toContain('MOCK_HASH');
      expect(result.example.role).toBe(1);
      expect(result.outline.map((entry) => entry[0])).toEqual([
         'name',
         'role',
      ]);
   });

   it('holds the result to 8,000 bytes by cutting the example, however large the schema and blank are', async () => {
      globalThis.CONFIG.Item.documentClass = documentClass(
         'Item',
         Object.fromEntries(Array.from({ length: 400 }, (_, index) => [
            `field${index}`,
            new F.StringField(),
         ])),
         { blank: Object.fromEntries(Array.from({ length: 400 }, (_, index) => [
            `field${index}`,
            'v'.repeat(100),
         ])) },
      );
      const result = await describe_({ documentName: 'Item' });
      expect(ENCODER.encode(JSON.stringify(result)).length).toBeLessThanOrEqual(8000);
      expect(result.exampleCut).toBe(true);
      expect(result.outline.length).toBeGreaterThan(0);
   });
});

describe('describe_schema with a path', () => {
   it('returns the blank subtree and the constraints of the fields under the path', async () => {
      const result = await describe_({
         documentName: 'Actor',
         subtype: 'player',
         path: 'system.attributes',
      });
      expect(result.path).toBe('system.attributes');
      expect(result.example).toEqual({ hp: 3 });
      expect(result.schema).toEqual({
         class: 'SchemaField',
         fields: {
            hp: {
               class: 'NumberField',
               required: true,
               integer: true,
               min: 0,
               max: 99,
            },
            mode: {
               class: 'StringField',
               choices: [
                  'a',
                  'b',
               ],
            },
         },
      });
   });

   it('describes a single field, and marks a free-form or embedded one instead of expanding it', async () => {
      const hp = await describe_({
         documentName: 'Actor',
         subtype: 'player',
         path: 'system.attributes.hp',
      });
      expect(hp.example).toBe(3);
      expect(hp.schema.max).toBe(99);
      const flags = await describe_({
         documentName: 'Actor',
         subtype: 'player',
         path: 'flags',
      });
      expect(flags.schema).toEqual({
         class: 'DocumentFlagsField',
         free: true,
      });
      const items = await describe_({
         documentName: 'Actor',
         subtype: 'player',
         path: 'items',
      });
      expect(items.schema).toEqual({
         class: 'EmbeddedCollectionField',
         document: 'Item',
      });
   });

   it('refuses a path that cannot be described with a short coded error', async () => {
      for (const [path, code] of [
         [
            'system.nope',
            'PATH_NOT_FOUND',
         ],
         [
            'items.0.name',
            'PATH_EMBEDDED',
         ],
         [
            'flags.core.x',
            'PATH_FREE_FORM',
         ],
         [
            '__proto__.x',
            'PATH_UNSAFE_SEGMENT',
         ],
         [
            'a..b',
            'PATH_INVALID',
         ],
         [
            'system.attributes.*',
            'PATH_INVALID',
         ],
      ]) {
         const error = await describe_({
            documentName: 'Actor',
            subtype: 'player',
            path,
         }).catch((caught) => caught);
         expect(error.code, path).toBe(code);
         expect(ENCODER.encode(error.message).length).toBeLessThanOrEqual(256);
      }
   });

   it('refuses a path to a User password field and reveals nothing about it', async () => {
      for (const path of [
         'password',
         'passwordSalt',
      ]) {
         const error = await describe_({
            documentName: 'User',
            path,
         }).catch((caught) => caught);
         expect(error.code).toBe('PATH_EXCLUDED');
      }
      const salted = await describe_({
         documentName: 'User',
         path: 'role',
      });
      expect(JSON.stringify(salted)).not.toContain('MOCK_SALT');
   });

   it('cuts the example before the schema depth when the subtree is too large', async () => {
      globalThis.CONFIG.Actor.documentClass = documentClass(
         'Actor',
         {
            name: new F.StringField({ required: true }),
            type: new F.StringField({ required: true }),
            system: Object.assign(new F.TypeDataField(), { document: { documentName: 'Actor' } }),
         },
         { blank: { system: {
            attributes: { hp: 3 },
            notes: 'x'.repeat(9000),
         } } },
      );
      const result = await describe_({
         documentName: 'Actor',
         subtype: 'player',
         path: 'system',
      });
      expect(ENCODER.encode(JSON.stringify(result)).length).toBeLessThanOrEqual(8000);
      expect(result.example).toBeUndefined();
      expect(result.exampleCut).toBe(true);
      expect(result.cut).toBeUndefined();
      expect(JSON.stringify(result.schema)).toContain('attributes');
      expect(JSON.stringify(result.schema)).toContain('hp');
   });

   it('holds a deep wide path result to 8,000 bytes', async () => {
      const wide = new F.SchemaField(
         Object.fromEntries(
            Array.from({ length: 60 }, (_, index) => [
               `group${index}`,
               new F.SchemaField(
                  Object.fromEntries(
                     Array.from({ length: 10 }, (_, leaf) => [
                        `leaf${leaf}`,
                        new F.StringField({
                           choices: Array.from({ length: 16 }, (_, choice) => `choice_${index}_${choice}`),
                        }),
                     ]),
                  ),
               ),
            ]),
         ),
      );
      globalThis.CONFIG.Actor.dataModels.player.schema = wide;
      const result = await describe_({
         documentName: 'Actor',
         subtype: 'player',
         path: 'system',
      });
      expect(ENCODER.encode(JSON.stringify(result)).length).toBeLessThanOrEqual(8000);
      expect(result.cut).toBe(true);
   });
});
