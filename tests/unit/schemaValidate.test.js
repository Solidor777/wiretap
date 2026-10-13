// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { getBudget } from '../../shared/budgets.js';
import { compileSchema, VALUE_NODES_MAX } from '../../shared/schemaValidate.js';
import { jsonSchemaToZodShape } from '../../server/toolRegistry.ts';

/**
 * Compile a schema that must be accepted.
 * @param {unknown} schema - The JSON Schema.
 * @returns {(value: unknown) => { ok: boolean, value?: unknown, error?: string }} The validator.
 * @throws {Error} When the schema is refused.
 */
function compiled(schema) {
   const outcome = compileSchema(schema);
   if (!outcome.ok) {
      throw new Error(`schema refused: ${outcome.reason}`);
   }
   return outcome.validate;
}

/**
 * Build a schema with one required string property.
 * @param {object} [overrides] - Keywords added to the property.
 * @returns {object} An object schema with a required `text` property.
 */
function textSchema(overrides = {}) {
   return {
      type: 'object',
      properties: {
         text: {
            type: 'string',
            ...overrides,
         },
      },
      required: ['text'],
   };
}

/**
 * Schemas the sidecar converts, each with the argument values both sides judge.
 * @type {Array<{ label: string, schema: object, values: unknown[] }>}
 */
const ACCEPTED_SCHEMAS = [
   {
      label: 'string bounds',
      schema: textSchema({
         minLength: 2,
         maxLength: 5,
      }),
      values: [
         { text: 'ab' },
         { text: 'abcde' },
         { text: 'a' },
         { text: 'abcdef' },
         { text: '' },
         {},
         { text: 1 },
         { text: null },
         { text: ['ab'] },
         { text: '😀😀' },
         { text: '😀😀😀' },
      ],
   },
   {
      label: 'string enum',
      schema: textSchema({ enum: ['red', 'green'] }),
      values: [
         { text: 'red' },
         { text: 'blue' },
         { text: 'RED' },
         { text: 1 },
         { text: 'constructor' },
      ],
   },
   {
      label: 'number and integer bounds',
      schema: {
         type: 'object',
         properties: {
            n: {
               type: 'number',
               minimum: -1.5,
               maximum: 2.5,
            },
            i: {
               type: 'integer',
               minimum: 1,
               maximum: 10,
            },
         },
         required: ['i'],
      },
      values: [
         { i: 1 },
         { i: 10 },
         { i: 11 },
         { i: 0 },
         { i: 2.5 },
         { i: '3' },
         { i: 3, n: 2.5 },
         { i: 3, n: 2.6 },
         { i: 3, n: -1.5 },
         { i: 3, n: -1.6 },
         { i: 3, n: null },
         { i: 3, n: '1' },
         { n: 1 },
         { i: 2 ** 60 },
         { i: Number.NaN },
         { i: Number.POSITIVE_INFINITY },
         { i: 1e-3 },
      ],
   },
   {
      label: 'unbounded numbers',
      schema: {
         type: 'object',
         properties: {
            n: { type: 'number' },
            i: { type: 'integer' },
         },
      },
      values: [
         { n: 1.5 },
         { n: Number.NaN },
         { n: Number.POSITIVE_INFINITY },
         { n: Number.NEGATIVE_INFINITY },
         { i: Number.NaN },
         { i: Number.POSITIVE_INFINITY },
         { i: 3 },
         { i: 3.5 },
         { n: '1' },
      ],
   },
   {
      label: 'boolean',
      schema: {
         type: 'object',
         properties: { flag: { type: 'boolean' } },
      },
      values: [
         {},
         { flag: true },
         { flag: false },
         { flag: 0 },
         { flag: 'true' },
         { flag: null },
      ],
   },
   {
      label: 'arrays',
      schema: {
         type: 'object',
         properties: {
            list: {
               type: 'array',
               items: {
                  type: 'integer',
                  minimum: 0,
               },
               minItems: 1,
               maxItems: 3,
            },
         },
         required: ['list'],
      },
      values: [
         { list: [0] },
         { list: [0, 1, 2] },
         { list: [] },
         { list: [0, 1, 2, 3] },
         { list: [-1] },
         { list: ['a'] },
         { list: 'a' },
         { list: { 0: 1 } },
         { list: [1, 'x'] },
         {},
      ],
   },
   {
      label: 'nested objects',
      schema: {
         type: 'object',
         properties: {
            outer: {
               type: 'object',
               properties: {
                  inner: {
                     type: 'object',
                     properties: { v: { type: 'string' } },
                     required: ['v'],
                  },
                  opt: { type: 'boolean' },
               },
               required: ['inner'],
            },
         },
         required: ['outer'],
      },
      values: [
         { outer: { inner: { v: 'x' } } },
         { outer: { inner: {} } },
         { outer: {} },
         { outer: [] },
         { outer: null },
         { outer: { inner: { v: 'x' }, opt: 'no' } },
         { outer: { inner: { v: 'x' }, opt: true } },
         {},
      ],
   },
   {
      label: 'array of objects',
      schema: {
         type: 'object',
         properties: {
            rows: {
               type: 'array',
               maxItems: 5,
               items: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
               },
            },
         },
      },
      values: [
         {},
         { rows: [] },
         { rows: [{ id: 'a' }] },
         { rows: [{ id: 1 }] },
         { rows: [{}] },
         { rows: [null] },
         { rows: [[]] },
      ],
   },
   {
      label: 'additionalProperties false and described nodes',
      schema: {
         type: 'object',
         description: 'The arguments.',
         properties: {
            a: {
               type: 'string',
               description: 'A text.',
            },
         },
         additionalProperties: false,
      },
      values: [
         {},
         { a: 'x' },
         { a: 'x', extra: 1 },
         { extra: 1 },
         { a: 1 },
      ],
   },
   {
      label: 'an array at the item cap',
      schema: {
         type: 'object',
         properties: {
            list: {
               type: 'array',
               maxItems: 1000,
               items: { type: 'integer' },
            },
         },
      },
      values: [
         { list: Array.from({ length: 1000 }, () => 1) },
         { list: Array.from({ length: 1001 }, () => 1) },
         { list: Array.from({ length: 10_001 }, () => 1) },
         { list: [] },
      ],
   },
   {
      label: 'integers with one bound, enums with length bounds and untyped descriptions',
      schema: {
         type: 'object',
         properties: {
            low: {
               type: 'integer',
               minimum: 2,
            },
            high: {
               type: 'integer',
               maximum: 9,
            },
            mode: {
               type: 'string',
               enum: ['a', 'b'],
               minLength: 1,
               description: 'The mode.',
            },
            items: {
               type: 'array',
               maxItems: 2,
               items: {
                  type: 'string',
                  description: 'An item.',
               },
               description: 'The items.',
            },
         },
         required: ['low'],
      },
      values: [
         { low: 2 },
         { low: 1 },
         { low: 2, high: 10 },
         { low: 2, mode: 'a', items: ['x'] },
      ],
   },
   {
      label: 'no properties',
      schema: { type: 'object' },
      values: [
         {},
         { anything: 1 },
      ],
   },
];

/**
 * Schemas judged by the sidecar, one construct each; `acceptedByBoth` marks the cases at a bound that both accept.
 * @type {Array<{ label: string, schema: unknown }>}
 */
const SCHEMA_JUDGEMENTS = [
   {
      label: 'non-object root',
      schema: { type: 'string' },
   },
   {
      label: 'array root',
      schema: [],
   },
   {
      label: 'null root',
      schema: null,
   },
   {
      label: 'missing type',
      schema: {
        properties: {},
      },
   },
   {
      label: 'unknown type',
      schema: { type: 'null' },
   },
   {
      label: 'type list',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: [
                  'string',
                  'null',
               ],
            },
         },
      },
   },
   {
      label: '$ref',
      schema: {
         type: 'object',
         properties: { a: { $ref: '#/x' } },
      },
   },
   {
      label: 'anyOf',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: 'string',
               anyOf: [{ type: 'string' }],
            },
         },
      },
   },
   {
      label: 'pattern',
      schema: textSchema({ pattern: '^a' }),
   },
   {
      label: 'format',
      schema: textSchema({ format: 'uri' }),
   },
   {
      label: 'default',
      schema: textSchema({ default: 'x' }),
   },
   {
      label: 'const',
      schema: textSchema({ const: 'x' }),
   },
   {
      label: 'number keyword on a string',
      schema: textSchema({ minimum: 1 }),
   },
   {
      label: 'additionalProperties true',
      schema: {
         type: 'object',
         additionalProperties: true,
      },
   },
   {
      label: 'additionalProperties object',
      schema: {
         type: 'object',
         additionalProperties: { type: 'string' },
      },
   },
   {
      label: 'empty enum',
      schema: textSchema({ enum: [] }),
   },
   {
      label: 'non-string enum',
      schema: textSchema({ enum: [1] }),
   },
   {
      label: 'enum with 33 values',
      schema: textSchema({ enum: Array.from({ length: 33 }, (_, index) => `v${index}`) }),
   },
   {
      label: 'enum value over 64 characters',
      schema: textSchema({ enum: ['x'.repeat(65)] }),
   },
   {
      label: 'enum with 32 values is fine at the bound',
      schema: textSchema({ enum: Array.from({ length: 32 }, (_, index) => `v${index}`) }),
      acceptedByBoth: true,
   },
   {
      label: 'negative minLength',
      schema: textSchema({ minLength: -1 }),
   },
   {
      label: 'fractional maxLength',
      schema: textSchema({ maxLength: 1.5 }),
   },
   {
      label: 'maxLength over the bound',
      schema: textSchema({ maxLength: 100_001 }),
   },
   {
      label: 'string minimum',
      schema: {
         type: 'object',
         properties: {
            n: {
               type: 'number',
               minimum: '1',
            },
         },
      },
   },
   {
      label: 'infinite maximum',
      schema: {
         type: 'object',
         properties: {
            n: {
               type: 'number',
               maximum: Number.POSITIVE_INFINITY,
            },
         },
      },
   },
   {
      label: 'array without items',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: 'array',
               maxItems: 2,
            },
         },
      },
   },
   {
      label: 'array without maxItems',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: 'array',
               items: { type: 'string' },
            },
         },
      },
   },
   {
      label: 'maxItems over the shared cap',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: 'array',
               items: { type: 'string' },
               maxItems: 1001,
            },
         },
      },
   },
   {
      label: 'maxItems exactly at the shared cap',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: 'array',
               items: { type: 'string' },
               maxItems: 1000,
            },
         },
      },
      acceptedByBoth: true,
   },
   {
      label: 'negative minItems',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: 'array',
               items: { type: 'string' },
               maxItems: 2,
               minItems: -1,
            },
         },
      },
   },
   {
      label: 'required names an undeclared property',
      schema: {
         type: 'object',
         properties: {},
         required: ['ghost'],
      },
   },
   {
      label: 'required is not a list',
      schema: {
         type: 'object',
         properties: {},
         required: 'a',
      },
   },
   {
      label: 'properties is an array',
      schema: {
         type: 'object',
         properties: [],
      },
   },
   {
      label: 'property name with a dash',
      schema: {
         type: 'object',
         properties: { 'a-b': { type: 'string' } },
      },
   },
   {
      label: 'property name over 64 characters',
      schema: {
         type: 'object',
         properties: { [`a${'b'.repeat(64)}`]: { type: 'string' } },
      },
   },
   {
      label: 'property named like an Object.prototype member',
      schema: {
         type: 'object',
         properties: { toString: { type: 'string' } },
      },
   },
   {
      label: 'property named constructor',
      schema: {
         type: 'object',
         properties: { constructor: { type: 'string' } },
      },
   },
   {
      label: 'a description with a newline',
      schema: textSchema({ description: 'two\nlines' }),
   },
   {
      label: 'an empty description',
      schema: textSchema({ description: '' }),
   },
   {
      label: 'a description over 240 characters',
      schema: textSchema({ description: 'd'.repeat(241) }),
   },
   {
      label: 'a description that is not a string',
      schema: textSchema({ description: 1 }),
   },
   {
      label: '33 properties',
      schema: {
         type: 'object',
         properties: Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`p${index}`, { type: 'string' }])),
      },
   },
   {
      label: '32 properties is fine at the bound',
      schema: {
         type: 'object',
         properties: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`p${index}`, { type: 'string' }])),
      },
      acceptedByBoth: true,
   },
   {
      label: 'nesting deeper than 4 levels',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: 'object',
               properties: {
                  b: {
                     type: 'object',
                     properties: {
                        c: {
                           type: 'object',
                           properties: {
                              d: {
                                 type: 'object',
                                 properties: {},
                              },
                           },
                        },
                     },
                  },
               },
            },
         },
      },
   },
   {
      label: 'nesting of exactly 4 levels',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: 'object',
               properties: {
                  b: {
                     type: 'object',
                     properties: {
                        c: {
                           type: 'object',
                           properties: { d: { type: 'string' } },
                        },
                     },
                  },
               },
            },
         },
      },
      acceptedByBoth: true,
   },
   {
      label: 'arrays count toward depth',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: 'array',
               maxItems: 2,
               items: {
                  type: 'array',
                  maxItems: 2,
                  items: {
                     type: 'array',
                     maxItems: 2,
                     items: {
                        type: 'array',
                        maxItems: 2,
                        items: { type: 'string' },
                     },
                  },
               },
            },
         },
      },
   },
   {
      label: 'more than 64 nodes',
      schema: {
         type: 'object',
         properties: {
            a: {
               type: 'array',
               maxItems: 2,
               items: {
                  type: 'object',
                  properties: Object.fromEntries(
                     Array.from({ length: 32 }, (_, index) => [`p${index}`, { type: 'string' }]),
                  ),
               },
            },
            b: {
               type: 'array',
               maxItems: 2,
               items: {
                  type: 'object',
                  properties: Object.fromEntries(
                     Array.from({ length: 32 }, (_, index) => [`p${index}`, { type: 'string' }]),
                  ),
               },
            },
         },
      },
   },
];

describe('compileSchema: the same schemas the sidecar converts', () => {
   it.each(ACCEPTED_SCHEMAS)('accepts $label as the sidecar does', ({ schema }) => {
      expect(jsonSchemaToZodShape(schema).ok).toBe(true);
      expect(compileSchema(schema).ok).toBe(true);
   });

   it.each(SCHEMA_JUDGEMENTS)('judges $label as the sidecar does', ({ schema, acceptedByBoth }) => {
      const sidecar = jsonSchemaToZodShape(schema).ok;
      const client = compileSchema(schema).ok;
      expect(sidecar).toBe(acceptedByBoth === true);
      expect(client).toBe(sidecar);
   });

   it('gives a short reason for a refusal', () => {
      const outcome = compileSchema(textSchema({ pattern: '^a' }));
      expect(outcome.ok).toBe(false);
      expect(outcome.reason).toMatch(/pattern/);
   });

   it('never throws for a hostile schema', () => {
      const hostile = {
         type: 'object',
         get properties() {
            throw new Error('boom');
         },
      };
      expect(compileSchema(hostile).ok).toBe(false);
   });
});

describe('validate: the same arguments the sidecar accepts and refuses', () => {
   for (const { label, schema, values } of ACCEPTED_SCHEMAS) {
      it(`judges every ${label} fixture as zod does`, () => {
         const shape = jsonSchemaToZodShape(schema).shape;
         const sidecar = z.object(shape);
         const validate = compiled(schema);
         for (const value of values) {
            const expected = sidecar.safeParse(value);
            const actual = validate(value);
            expect(actual.ok, JSON.stringify(value)).toBe(expected.success);
            if (expected.success) {
               expect(actual.value).toEqual(expected.data);
            }
         }
      });
   }
});

describe('validate: results and errors', () => {
   it('returns a fresh copy holding only the declared properties', () => {
      const validate = compiled(textSchema());
      const input = {
         text: 'hello',
         extra: 1,
      };
      const outcome = validate(input);
      expect(outcome).toEqual({
         ok: true,
         value: { text: 'hello' },
      });
      expect(outcome.value).not.toBe(input);
   });

   it('drops undeclared properties at every depth, in objects and in lists', () => {
      const validate = compiled({
         type: 'object',
         properties: {
            outer: {
               type: 'object',
               properties: {
                  rows: {
                     type: 'array',
                     maxItems: 5,
                     items: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                     },
                  },
               },
            },
         },
      });
      const outcome = validate({
         outer: {
            rows: [
               {
                  id: 'a',
                  junk: 1,
               },
            ],
            junk: 2,
         },
         junk: 3,
      });
      expect(outcome).toEqual({
         ok: true,
         value: { outer: { rows: [{ id: 'a' }] } },
      });
   });

   it('does not take an inherited or prototype property for an argument', () => {
      const validate = compiled(textSchema());
      const inherited = Object.create({ text: 'inherited' });
      expect(validate(inherited).ok).toBe(false);
      const polluted = JSON.parse('{"text":"ok","__proto__":{"text":"x"},"constructor":{"a":1}}');
      const outcome = validate(polluted);
      expect(outcome.ok).toBe(true);
      expect(Object.keys(outcome.value)).toEqual(['text']);
      expect(Object.getPrototypeOf(outcome.value)).toBe(Object.prototype);
   });

   it('names the path of the first problem and no caller text', () => {
      const validate = compiled({
         type: 'object',
         properties: {
            outer: {
               type: 'object',
               properties: {
                  rows: {
                     type: 'array',
                     maxItems: 5,
                     items: {
                        type: 'object',
                        properties: { id: { type: 'string' } },
                        required: ['id'],
                     },
                  },
               },
               required: ['rows'],
            },
         },
         required: ['outer'],
      });
      const outcome = validate({ outer: { rows: [{ id: 'a' }, { id: 'SECRET-VALUE'.repeat(1) }, { id: 5 }] } });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/^outer\.rows\.2\.id: /);
      expect(outcome.error).not.toContain('SECRET-VALUE');
   });

   it('refuses a missing required property by name', () => {
      const outcome = compiled(textSchema())({});
      expect(outcome).toEqual({
         ok: false,
         error: 'text: is required',
      });
   });

   it('refuses an argument value that is not an object', () => {
      const validate = compiled(textSchema());
      for (const value of [null, 'text', 1, [], undefined]) {
         const outcome = validate(value);
         expect(outcome.ok).toBe(false);
         expect(outcome.error).toMatch(/^arguments: /);
      }
   });

   it('keeps every error within 256 bytes', () => {
      const deep = {
         type: 'object',
         properties: {
            [`a${'b'.repeat(63)}`]: {
               type: 'object',
               properties: {
                  [`c${'d'.repeat(63)}`]: {
                     type: 'object',
                     properties: {
                        [`e${'f'.repeat(63)}`]: {
                           type: 'object',
                           properties: { [`g${'h'.repeat(63)}`]: { type: 'string' } },
                           required: [`g${'h'.repeat(63)}`],
                        },
                     },
                     required: [`e${'f'.repeat(63)}`],
                  },
               },
               required: [`c${'d'.repeat(63)}`],
            },
         },
         required: [`a${'b'.repeat(63)}`],
      };
      const validate = compiled(deep);
      const outcome = validate({ [`a${'b'.repeat(63)}`]: { [`c${'d'.repeat(63)}`]: { [`e${'f'.repeat(63)}`]: {} } } });
      expect(outcome.ok).toBe(false);
      expect(new TextEncoder().encode(outcome.error).length).toBeLessThanOrEqual(256);
   });

   it('refuses an argument tree larger than the value bound', () => {
      const cap = getBudget('SCHEMA_ARRAY_ITEMS_MAX').value;
      const lists = Object.fromEntries(
         Array.from({ length: 12 }, (_, index) => [
            `list${index}`,
            {
               type: 'array',
               maxItems: cap,
               items: { type: 'integer' },
            },
         ]),
      );
      const validate = compiled({
         type: 'object',
         properties: lists,
      });
      const full = (count) => Object.fromEntries(
         Array.from({ length: count }, (_, index) => [`list${index}`, Array.from({ length: cap }, () => 1)]),
      );
      expect(validate(full(9)).ok).toBe(true);
      const outcome = validate(full(10));
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/too large/);
   });

   it('does not read an enormous array past its cap', () => {
      const validate = compiled({
         type: 'object',
         properties: {
            list: {
               type: 'array',
               maxItems: 10,
               items: { type: 'integer' },
            },
         },
      });
      let reads = 0;
      const hostile = new Proxy([], {
         get(target, key) {
            if (key === 'length') {
               return 1_000_000_000;
            }
            reads += 1;
            return 1;
         },
         getPrototypeOf: () => Array.prototype,
      });
      const outcome = validate({ list: hostile });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/allows at most 10 items/);
      expect(reads).toBe(0);
   });

   it('lists a schema in the same form as the sidecar, for every accepted fixture', () => {
      for (const { label, schema } of ACCEPTED_SCHEMAS) {
         const shape = jsonSchemaToZodShape(schema).shape;
         const sidecar = toJsonSchemaCompat(z.object(shape), {
            strictUnions: true,
            pipeStrategy: 'input',
         });
         expect(compileSchema(schema).listed, label).toEqual(sidecar);
      }
   });

   it('does not throw when a getter on the arguments throws', () => {
      const validate = compiled(textSchema());
      const hostile = {
         get text() {
            throw new Error('boom');
         },
      };
      const outcome = validate(hostile);
      expect(outcome.ok).toBe(false);
      expect(outcome.error).toMatch(/^arguments: /);
   });
});
