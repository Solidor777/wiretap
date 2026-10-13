// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { getBudget } from '../../shared/budgets.js';
import { RESERVED_TOOL_NAMES, jsonSchemaToZodShape, sanitizeRegistry } from '../../server/toolRegistry.ts';

/**
 * Build a valid registry entry; fields in `overrides` replace the defaults.
 * @param {object} [overrides] - Fields to set on the entry.
 * @returns {object} A registry entry that passes every budget.
 */
function entry(overrides = {}) {
   return {
      name: 'mock_tool',
      description: 'A synthetic tool.',
      inputSchema: {
         type: 'object',
         properties: { text: { type: 'string' } },
         required: ['text'],
      },
      ...overrides,
   };
}

/**
 * Sanitize a payload and collect the log lines.
 * @param {unknown} payload - The registry payload.
 * @returns {{ outcome: ReturnType<typeof sanitizeRegistry>, lines: string[] }} The outcome and the log lines.
 */
function run(payload) {
   /** @type {string[]} The log lines written during the call. */
   const lines = [];
   return {
      outcome: sanitizeRegistry(payload, (line) => lines.push(line)),
      lines,
   };
}

describe('sanitizeRegistry: accepted tools', () => {
   it('accepts a valid tool and keeps only the known fields', () => {
      const { outcome, lines } = run([entry({
         extra: 'ignored',
         budgetBytes: 4000,
      })]);
      expect(outcome.ok).toBe(true);
      expect(outcome.refused).toBe(0);
      expect(outcome.tools).toHaveLength(1);
      const [tool] = outcome.tools;
      expect(tool.name).toBe('mock_tool');
      expect(tool.description).toBe('A synthetic tool.');
      expect(tool.budgetBytes).toBe(4000);
      expect(Object.keys(tool.shape)).toEqual(['text']);
      expect(tool).not.toHaveProperty('extra');
      expect(lines).toEqual([]);
   });

   it('accepts an empty registry, which clears the tools', () => {
      const { outcome } = run([]);
      expect(outcome).toEqual({
         ok: true,
         tools: [],
         refused: 0,
      });
   });

   it('accepts a name of exactly the core name budget and refuses one character more', () => {
      const limit = getBudget('CORE_TOOL_NAME_MAX_CHARS').value;
      expect(run([entry({ name: 'a'.repeat(limit) })]).outcome.tools).toHaveLength(1);
      const { outcome, lines } = run([entry({ name: 'a'.repeat(limit + 1) })]);
      expect(outcome.tools).toEqual([]);
      expect(outcome.refused).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('name');
   });

   it('accepts a description of exactly the hard maximum and refuses one character more', () => {
      const limit = getBudget('DESCRIPTION_MAX_CHARS').value;
      /** @type {object} The smallest schema, so only the description length decides. */
      const inputSchema = { type: 'object' };
      expect(run([entry({
         description: 'd'.repeat(limit),
         inputSchema,
      })]).outcome.tools).toHaveLength(1);
      const { outcome, lines } = run([entry({
         description: 'd'.repeat(limit + 1),
         inputSchema,
      })]);
      expect(outcome.tools).toEqual([]);
      expect(lines[0]).toContain('description');
   });
});

describe('sanitizeRegistry: refused tools', () => {
   it('refuses a payload that is not an array without throwing', () => {
      for (const payload of [undefined, null, 'x', 7, {}, { tools: [] }]) {
         const { outcome } = run(payload);
         expect(outcome.ok).toBe(false);
      }
   });

   it.each([
      [
         'an empty name',
         { name: '' },
         'name',
      ],
      [
         'an uppercase name',
         { name: 'Mock' },
         'name',
      ],
      [
         'a name starting with a digit',
         { name: '1mock' },
         'name',
      ],
      [
         'a name with a space',
         { name: 'mock tool' },
         'name',
      ],
      [
         'a name with a path separator',
         { name: 'mock/tool' },
         'name',
      ],
      [
         'a non-string name',
         { name: 5 },
         'name',
      ],
      [
         'the __proto__ name',
         { name: '__proto__' },
         'name',
      ],
      [
         'the constructor name',
         { name: 'constructor' },
         'reserved',
      ],
      [
         'a built-in tool name',
         { name: 'create_actor' },
         'reserved',
      ],
      [
         'the read_handle name',
         { name: 'read_handle' },
         'reserved',
      ],
      [
         'an empty description',
         { description: '' },
         'description',
      ],
      [
         'a non-string description',
         { description: 12 },
         'description',
      ],
      [
         'a description with a line break',
         { description: 'one\ntwo' },
         'description',
      ],
      [
         'a description over the hard maximum',
         { description: 'd'.repeat(241) },
         'description',
      ],
      [
         'a missing schema',
         { inputSchema: undefined },
         'inputSchema',
      ],
      [
         'a schema that is an array',
         { inputSchema: [] },
         'inputSchema',
      ],
      [
         'a zero byte budget',
         { budgetBytes: 0 },
         'budgetBytes',
      ],
      [
         'a fractional byte budget',
         { budgetBytes: 1.5 },
         'budgetBytes',
      ],
      [
         'a string byte budget',
         { budgetBytes: '500' },
         'budgetBytes',
      ],
      [
         'a byte budget over the per-call maximum',
         { budgetBytes: 16001 },
         'budgetBytes',
      ],
      [
         'an unknown gate',
         { gate: 'allowEverything' },
         'gate',
      ],
      [
         'an inherited gate name',
         { gate: 'constructor' },
         'gate',
      ],
      [
         'a plugin gate without a module id',
         { gate: 'allowedPluginModules' },
         'moduleId',
      ],
      [
         'a plugin gate with a malformed module id',
         {
            gate: 'allowedPluginModules',
            moduleId: 'Bad Module',
         },
         'moduleId',
      ],
      [
         'a module id on a boolean gate',
         {
            gate: 'allowUserWrites',
            moduleId: 'some-module',
         },
         'moduleId',
      ],
   ])('refuses %s and logs the reason', (_label, overrides, word) => {
      const { outcome, lines } = run([entry(overrides)]);
      expect(outcome).toEqual({
         ok: true,
         tools: [],
         refused: 1,
      });
      expect(lines).toHaveLength(1);
      expect(lines[0].startsWith('Wiretap sidecar | registry refused tool ')).toBe(true);
      expect(lines[0]).toContain(word);
   });

   it('refuses an entry that is not an object, null or an array', () => {
      const { outcome, lines } = run([
         null,
         'tool',
         7,
         [],
         entry(),
      ]);
      expect(outcome.tools.map((tool) => tool.name)).toEqual(['mock_tool']);
      expect(outcome.refused).toBe(4);
      expect(lines).toHaveLength(4);
   });

   it('refuses the second of two tools with the same name', () => {
      const { outcome, lines } = run([
         entry(),
         entry({ description: 'Another.' }),
      ]);
      expect(outcome.tools).toHaveLength(1);
      expect(outcome.tools[0].description).toBe('A synthetic tool.');
      expect(outcome.refused).toBe(1);
      expect(lines[0]).toContain('duplicate');
   });

   it('keeps the valid tools of a payload that also holds refused ones', () => {
      const { outcome } = run([
         entry({ name: 'first' }),
         entry({ name: 'BAD' }),
         entry({ name: 'third' }),
      ]);
      expect(outcome.tools.map((tool) => tool.name)).toEqual([
         'first',
         'third',
      ]);
      expect(outcome.refused).toBe(1);
   });

   it('counts reserved names as the built-in tools', () => {
      expect([...RESERVED_TOOL_NAMES].sort()).toEqual([
         'create_actor',
         'read_handle',
      ]);
   });

   it('replaces control characters and cuts a hostile name in the log line', () => {
      const { lines } = run([entry({ name: `evil\n${'x'.repeat(200)}\u2028forged line` })]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toMatch(/[\n\r\u2028]/);
      expect(Buffer.byteLength(lines[0])).toBeLessThan(300);
   });
});

describe('sanitizeRegistry: definition budget', () => {
   it('refuses a schema whose received definition is over the definition budget', () => {
      const properties = Object.fromEntries(
         Array.from({ length: 12 }, (_, index) => [
            `field${index}`,
            {
               type: 'string',
               description: 'x'.repeat(40),
            },
         ]),
      );
      const { outcome, lines } = run([entry({ inputSchema: {
         type: 'object',
         properties,
      } })]);
      expect(outcome.tools).toEqual([]);
      expect(lines[0]).toMatch(/definition is \d+ bytes, at most 800 bytes/);
   });

   it('measures the definition as the client will list it, not as it was received', () => {
      /** @type {object} A schema that is within the budget as received. */
      const inputSchema = {
         type: 'object',
         properties: Object.fromEntries(
            ['alpha', 'beta', 'gamma'].map((key) => [
               key,
               {
                  type: 'string',
                  description: 'p'.repeat(150),
               },
            ]),
         ),
         required: ['alpha'],
      };
      /** @type {number} The bytes of the name, an empty description and the schema as received. */
      const base = Buffer.byteLength(JSON.stringify({
         name: 'mock_tool',
         description: '',
         inputSchema,
      }));
      // 790 received bytes: within the 800 byte budget as received, over it once listed with its `$schema` key.
      const description = 'd'.repeat(790 - base);
      expect(description.length).toBeGreaterThan(0);
      const { outcome, lines } = run([entry({ description, inputSchema })]);
      expect(outcome.tools).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/listed definition is \d+ bytes, at most 800 bytes/);
   });

   it('accepts a definition that is within the budget as listed', () => {
      expect(run([entry({ description: 'd'.repeat(100) })]).outcome.tools).toHaveLength(1);
   });
});

describe('sanitizeRegistry: tool count budget', () => {
   it('accepts tools up to the always-listed budget less the built-ins and refuses the rest with one line', () => {
      const room = getBudget('ALWAYS_LISTED_TOOLS_MAX').value - RESERVED_TOOL_NAMES.length;
      const payload = Array.from({ length: room + 5 }, (_, index) => entry({ name: `tool_${index}` }));
      const { outcome, lines } = run(payload);
      expect(outcome.tools).toHaveLength(room);
      expect(outcome.refused).toBe(5);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('tool count');
   });

   it('does not examine every entry of an enormous payload', () => {
      const payload = Array.from({ length: 50_000 }, () => null);
      const { outcome, lines } = run(payload);
      expect(outcome.tools).toEqual([]);
      expect(outcome.refused).toBe(50_000);
      expect(lines.length).toBeLessThan(100);
   });
});

describe('sanitizeRegistry: hostile payloads', () => {
   it('does not pollute Object.prototype from an own __proto__ key in a parsed entry', () => {
      const payload = JSON.parse(
         '[{"name":"mock_tool","description":"d","__proto__":{"polluted":true},' +
            '"inputSchema":{"type":"object","__proto__":{"polluted":true}}}]',
      );
      const { outcome } = run(payload);
      expect({}.polluted).toBeUndefined();
      expect(outcome.tools.length + outcome.refused).toBe(1);
      for (const tool of outcome.tools) {
         expect(tool.polluted).toBeUndefined();
      }
   });

   it('refuses a schema property named __proto__ without changing any prototype', () => {
      const payload = JSON.parse(
         '[{"name":"mock_tool","description":"d","inputSchema":{"type":"object","properties":' +
            '{"__proto__":{"type":"string"}}}}]',
      );
      const { outcome, lines } = run(payload);
      expect(outcome.tools).toEqual([]);
      expect(lines[0]).toContain('property name');
      expect({}.type).toBeUndefined();
   });

   it('refuses a property named after an Object.prototype member', () => {
      for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
         const result = jsonSchemaToZodShape({
            type: 'object',
            properties: { [name]: { type: 'string' } },
         });
         expect(result.ok).toBe(false);
      }
   });

   it('refuses an entry whose property reads throw, without throwing', () => {
      const hostile = new Proxy(
         {},
         {
            get() {
               throw new Error('hostile getter');
            },
            ownKeys() {
               throw new Error('hostile keys');
            },
            has() {
               throw new Error('hostile has');
            },
            getOwnPropertyDescriptor() {
               throw new Error('hostile descriptor');
            },
         },
      );
      const { outcome, lines } = run([
         hostile,
         entry(),
      ]);
      expect(outcome.tools.map((tool) => tool.name)).toEqual(['mock_tool']);
      expect(outcome.refused).toBe(1);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('unreadable');
   });

   it('does not read inherited fields', () => {
      Object.prototype.name = 'inherited_name';
      try {
         const { outcome } = run([{
            description: 'd',
            inputSchema: { type: 'object' },
         }]);
         expect(outcome.tools).toEqual([]);
         expect(outcome.refused).toBe(1);
      } finally {
         delete Object.prototype.name;
      }
   });
});

describe('jsonSchemaToZodShape: supported constructs', () => {
   /**
    * Convert a schema and fail the test when it is refused.
    * @param {unknown} schema - The JSON Schema.
    * @returns {import('zod').ZodObject} An object schema over the shape.
    */
   function objectOf(schema) {
      const result = jsonSchemaToZodShape(schema);
      expect(result.ok).toBe(true);
      return z.object(result.shape);
   }

   it('converts an empty object schema to an empty shape', () => {
      expect(jsonSchemaToZodShape({ type: 'object' })).toEqual({
         ok: true,
         shape: {},
      });
   });

   it('makes a property required only when it is listed in required', () => {
      const schema = objectOf({
         type: 'object',
         properties: {
            a: { type: 'string' },
            b: { type: 'string' },
         },
         required: ['a'],
      });
      expect(schema.safeParse({ a: 'x' }).success).toBe(true);
      expect(schema.safeParse({ b: 'x' }).success).toBe(false);
   });

   it('converts strings with length bounds and enums', () => {
      const schema = objectOf({
         type: 'object',
         properties: {
            word: {
               type: 'string',
               minLength: 2,
               maxLength: 4,
            },
            kind: {
               type: 'string',
               enum: [
                  'npc',
                  'pc',
               ],
            },
         },
      });
      expect(schema.safeParse({ word: 'ab' }).success).toBe(true);
      expect(schema.safeParse({ word: 'a' }).success).toBe(false);
      expect(schema.safeParse({ word: 'abcde' }).success).toBe(false);
      expect(schema.safeParse({ kind: 'npc' }).success).toBe(true);
      expect(schema.safeParse({ kind: 'dragon' }).success).toBe(false);
   });

   it('converts numbers, integers and booleans with bounds', () => {
      const schema = objectOf({
         type: 'object',
         properties: {
            ratio: {
               type: 'number',
               minimum: 0,
               maximum: 1,
            },
            count: {
               type: 'integer',
               minimum: 1,
               maximum: 5,
            },
            flag: { type: 'boolean' },
         },
      });
      expect(schema.safeParse({
         ratio: 0.5,
         count: 2,
         flag: true,
      }).success).toBe(true);
      expect(schema.safeParse({ ratio: 2 }).success).toBe(false);
      expect(schema.safeParse({ count: 2.5 }).success).toBe(false);
      expect(schema.safeParse({ count: 6 }).success).toBe(false);
      expect(schema.safeParse({ flag: 'yes' }).success).toBe(false);
   });

   it('converts arrays with item schemas and size bounds, and nested objects', () => {
      const schema = objectOf({
         type: 'object',
         properties: {
            ids: {
               type: 'array',
               items: { type: 'string' },
               minItems: 1,
               maxItems: 2,
            },
            inner: {
               type: 'object',
               properties: { n: { type: 'integer' } },
               required: ['n'],
            },
         },
      });
      expect(schema.safeParse({ ids: ['a'] }).success).toBe(true);
      expect(schema.safeParse({ ids: [] }).success).toBe(false);
      expect(schema.safeParse({ ids: [
         'a',
         'b',
         'c',
      ] }).success).toBe(false);
      expect(schema.safeParse({ ids: [1] }).success).toBe(false);
      expect(schema.safeParse({ inner: { n: 1 } }).success).toBe(true);
      expect(schema.safeParse({ inner: {} }).success).toBe(false);
   });

   it('keeps a property description', () => {
      const result = jsonSchemaToZodShape({
         type: 'object',
         properties: { a: {
            type: 'string',
            description: 'The a.',
         } },
      });
      expect(result.ok).toBe(true);
      expect(result.shape.a.description).toBe('The a.');
   });

   it('accepts additionalProperties: false', () => {
      expect(jsonSchemaToZodShape({
         type: 'object',
         additionalProperties: false,
      }).ok).toBe(true);
   });
});

describe('jsonSchemaToZodShape: refused constructs', () => {
   it.each([
      [
         'a root that is not an object schema',
         { type: 'string' },
      ],
      [
         'a root with no type',
         {},
      ],
      [
         'a $ref',
         {
            type: 'object',
            properties: { a: { $ref: '#/definitions/a' } },
         },
      ],
      [
         'a $schema keyword',
         {
            $schema: 'http://json-schema.org/draft-07/schema#',
            type: 'object',
         },
      ],
      [
         'oneOf',
         {
            type: 'object',
            properties: { a: { oneOf: [
               { type: 'string' },
               { type: 'number' },
            ] } },
         },
      ],
      [
         'anyOf',
         {
            type: 'object',
            properties: { a: { anyOf: [{ type: 'string' }] } },
         },
      ],
      [
         'allOf',
         {
            type: 'object',
            properties: { a: { allOf: [{ type: 'string' }] } },
         },
      ],
      [
         'a not',
         {
            type: 'object',
            properties: { a: { not: { type: 'string' } } },
         },
      ],
      [
         'a type list',
         {
            type: 'object',
            properties: { a: { type: [
               'string',
               'null',
            ] } },
         },
      ],
      [
         'the null type',
         {
            type: 'object',
            properties: { a: { type: 'null' } },
         },
      ],
      [
         'a regular expression pattern',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               pattern: '(a+)+$',
            } },
         },
      ],
      [
         'a format',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               format: 'uri',
            } },
         },
      ],
      [
         'a default',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               default: 'x',
            } },
         },
      ],
      [
         'a const',
         {
            type: 'object',
            properties: { a: { const: 'x' } },
         },
      ],
      [
         'additionalProperties true',
         {
            type: 'object',
            additionalProperties: true,
         },
      ],
      [
         'additionalProperties as a schema',
         {
            type: 'object',
            additionalProperties: { type: 'string' },
         },
      ],
      [
         'patternProperties',
         {
            type: 'object',
            patternProperties: { '^a': { type: 'string' } },
         },
      ],
      [
         'an array with no items',
         {
            type: 'object',
            properties: { a: { type: 'array' } },
         },
      ],
      [
         'an enum of non-strings',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               enum: [
                  1,
                  2,
               ],
            } },
         },
      ],
      [
         'an empty enum',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               enum: [],
            } },
         },
      ],
      [
         'a required name that is not a property',
         {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: ['b'],
         },
      ],
      [
         'a non-array required',
         {
            type: 'object',
            properties: { a: { type: 'string' } },
            required: 'a',
         },
      ],
      [
         'a non-finite bound',
         {
            type: 'object',
            properties: { a: {
               type: 'number',
               minimum: 'zero',
            } },
         },
      ],
      [
         'a negative length bound',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               maxLength: -1,
            } },
         },
      ],
      [
         'properties that are not an object',
         {
            type: 'object',
            properties: [],
         },
      ],
      [
         'a property schema that is not an object',
         {
            type: 'object',
            properties: { a: 'string' },
         },
      ],
      [
         'an unknown keyword',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               madeUp: 1,
            } },
         },
      ],
      [
         'a non-string description',
         {
            type: 'object',
            properties: { a: {
               type: 'string',
               description: 5,
            } },
         },
      ],
      [
         'a property name with a space',
         {
            type: 'object',
            properties: { 'a b': { type: 'string' } },
         },
      ],
   ])('refuses %s with a reason', (_label, schema) => {
      const result = jsonSchemaToZodShape(schema);
      expect(result.ok).toBe(false);
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason.length).toBeLessThan(200);
   });

   it('refuses nesting deeper than four levels and accepts four', () => {
      /**
       * Wrap a leaf schema in object levels.
       * @param {number} levels - How many object levels.
       * @returns {object} The nested schema.
       */
      function nest(levels) {
         let node = { type: 'string' };
         for (let level = 0; level < levels; level += 1) {
            node = {
               type: 'object',
               properties: { a: node },
            };
         }
         return node;
      }
      expect(jsonSchemaToZodShape(nest(4)).ok).toBe(true);
      expect(jsonSchemaToZodShape(nest(5)).ok).toBe(false);
   });

   it('refuses a schema with more properties than the node budget', () => {
      const properties = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [
         `p${index}`,
         { type: 'string' },
      ]));
      expect(jsonSchemaToZodShape({
         type: 'object',
         properties,
      }).ok).toBe(false);
   });

   it('refuses a self-referencing structure instead of looping', () => {
      /** @type {Record<string, unknown>} A schema that contains itself. */
      const loop = {
         type: 'object',
         properties: {},
      };
      loop.properties.again = loop;
      expect(jsonSchemaToZodShape(loop).ok).toBe(false);
   });
});
