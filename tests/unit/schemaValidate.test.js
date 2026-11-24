// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { getBudget } from '../../shared/budgets.js';
import {
   SCHEMA_GUIDELINES,
   compileSchema,
   guidelineWarning,
   isWellFormedDescription,
} from '../../shared/schemaValidate.js';
import { argumentSchema, jsonSchemaToZodShape } from '../../server/toolRegistry.ts';

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
         const sidecar = argumentSchema(jsonSchemaToZodShape(schema));
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
         const sidecar = toJsonSchemaCompat(argumentSchema(jsonSchemaToZodShape(schema)), {
            strictUnions: true,
            pipeStrategy: 'input',
         });
         expect(compileSchema(schema).listed, label).toEqual(sidecar);
      }
   });

   it('lists a strict-nested schema without the nested additionalProperties, as the sidecar does', () => {
      /** @type {object} A root with a nested entry object. */
      const schema = {
         type: 'object',
         properties: {
            entries: {
               type: 'array',
               maxItems: 3,
               items: {
                  type: 'object',
                  properties: { a: { type: 'string' } },
               },
            },
         },
         additionalProperties: false,
      };
      const sidecar = toJsonSchemaCompat(argumentSchema(jsonSchemaToZodShape(schema, true)), {
         strictUnions: true,
         pipeStrategy: 'input',
      });
      expect(compileSchema(schema, { strictNested: true }).listed).toEqual(sidecar);
      expect(JSON.stringify(sidecar).match(/additionalProperties/g)).toHaveLength(1);
   });

   it('refuses an undeclared key of a nested object only when strictNested is set, on both validators', () => {
      /** @type {object} A root with a nested entry object. */
      const schema = {
         type: 'object',
         properties: {
            entry: {
               type: 'object',
               properties: { a: { type: 'string' } },
            },
         },
      };
      /** @type {object} Arguments with a typo in the entry. */
      const typo = { entry: { a: 'x', b: 'y' } };
      expect(compileSchema(schema).validate(typo).ok).toBe(true);
      expect(compileSchema(schema, { strictNested: true }).validate(typo).ok).toBe(false);
      expect(argumentSchema(jsonSchemaToZodShape(schema)).safeParse(typo).success).toBe(true);
      expect(argumentSchema(jsonSchemaToZodShape(schema, true)).safeParse(typo).success).toBe(false);
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

/**
 * Build an object chain `levels` deep with a string leaf; the root object is level 1.
 * @param {number} levels - How many object levels.
 * @returns {object} The nested schema.
 */
const depth = (levels) => {
   let node = { type: 'string' };
   for (let level = 1; level < levels; level += 1) {
      node = {
         type: 'object',
         properties: { n: node },
      };
   }
   return {
      type: 'object',
      properties: { n: node },
   };
};

/**
 * Build `count` boolean properties named `b0`, `b1`, and so on.
 * @param {number} count - How many properties.
 * @returns {Record<string, object>} The properties.
 */
const booleans = (count) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`b${i}`, { type: 'boolean' }]));

/**
 * Wrap one property schema in an object root.
 * @param {object} node - The schema of property `a`.
 * @returns {object} The root schema.
 */
const rootOf = (node) => {
   return {
      type: 'object',
      properties: { a: node },
   };
};

describe('the plugin switch: guidelines warn for plugin schemas and refuse shipped ones', () => {
   it.each([
      [
         'depth',
         depth(5),
         'schema nests objects and arrays 5 levels deep, over the 4-level guideline',
      ],
      [
         'nodes',
         {
            type: 'object',
            properties: {
               a: {
                  type: 'object',
                  properties: booleans(32),
               },
               b: {
                  type: 'object',
                  properties: booleans(32),
               },
            },
         },
         'schema has 67 nodes, over the 64-node guideline',
      ],
      [
         'properties',
         {
            type: 'object',
            properties: booleans(33),
         },
         'an object schema has 33 properties, over the 32-property guideline',
      ],
      [
         'enum values',
         rootOf({
            type: 'string',
            enum: Array.from({ length: 33 }, (_, i) => `v${i}`),
         }),
         'an enum has 33 values, over the 32-value guideline',
      ],
      [
         'enum value length',
         rootOf({
            type: 'string',
            enum: ['v'.repeat(65)],
         }),
         'an enum value is 65 characters, over the 64-character guideline',
      ],
      [
         'bound',
         rootOf({
            type: 'string',
            maxLength: 100001,
         }),
         'a length or item bound is 100001, over the 100000 guideline',
      ],
      [
         'no maxItems',
         rootOf({
            type: 'array',
            items: { type: 'string' },
         }),
         'an array schema declares no maxItems; the guideline is a maxItems of at most 1000',
      ],
      [
         'maxItems',
         rootOf({
            type: 'array',
            maxItems: 1001,
            items: { type: 'string' },
         }),
         'an array schema allows 1001 items, over the 1000-item guideline',
      ],
      [
         'description',
         rootOf({
            type: 'string',
            description: 'd'.repeat(241),
         }),
         'a schema description is 241 characters, over the 240-character guideline',
      ],
   ])('a plugin schema over the %s guideline compiles with one warning on both sides; a shipped one is refused',
      (_, schema, warning) => {
         const client = compileSchema(schema, { source: 'plugin' });
         const sidecar = jsonSchemaToZodShape(schema, false, 'plugin');
         expect(client.ok).toBe(true);
         expect(client.warnings).toEqual([warning]);
         expect(sidecar.ok).toBe(true);
         expect(sidecar.warnings).toEqual([warning]);
         expect(client.listed).toEqual(toJsonSchemaCompat(argumentSchema(sidecar), {
            strictUnions: true,
            pipeStrategy: 'input',
         }));
         expect(compileSchema(schema).ok).toBe(false);
         expect(jsonSchemaToZodShape(schema).ok).toBe(false);
      });

   it('warns once per guideline, in guideline order, with the largest measured value', () => {
      const schema = {
         type: 'object',
         properties: {
            a: {
               type: 'string',
               enum: Array.from({ length: 33 }, (_, i) => `a${i}`),
            },
            b: {
               type: 'string',
               enum: Array.from({ length: 40 }, (_, i) => `b${i}`),
            },
            c: {
               type: 'string',
               maxLength: 100001,
            },
         },
      };
      const expected = [
         'an enum has 40 values, over the 32-value guideline',
         'a length or item bound is 100001, over the 100000 guideline',
      ];
      expect(compileSchema(schema, { source: 'plugin' }).warnings).toEqual(expected);
      expect(jsonSchemaToZodShape(schema, false, 'plugin').warnings).toEqual(expected);
   });

   it('refuses a plugin schema deeper than 32 levels on both sides without overflowing the stack', () => {
      for (const levels of [33, 5000]) {
         const client = compileSchema(depth(levels), { source: 'plugin' });
         const sidecar = jsonSchemaToZodShape(depth(levels), false, 'plugin');
         expect(client).toEqual({
            ok: false,
            reason: 'schema nests objects and arrays deeper than 32 levels',
         });
         expect(sidecar).toEqual({
            ok: false,
            reason: 'schema nests objects and arrays deeper than 32 levels',
         });
      }
      expect(compileSchema(depth(32), { source: 'plugin' }).ok).toBe(true);
      expect(jsonSchemaToZodShape(depth(32), false, 'plugin').ok).toBe(true);
   });

   it('lists a plugin array without maxItems with no item cap and parses more than 1000 items on both sides', () => {
      const schema = rootOf({
         type: 'array',
         items: { type: 'integer' },
      });
      const client = compileSchema(schema, { source: 'plugin' });
      const sidecar = jsonSchemaToZodShape(schema, false, 'plugin');
      expect(client.listed.properties.a.maxItems).toBeUndefined();
      const many = { a: Array.from({ length: 1500 }, () => 1) };
      expect(client.validate(many).ok).toBe(true);
      expect(argumentSchema(sidecar).safeParse(many).success).toBe(true);
   });

   it.each([
      [
         'a $ref keyword',
         rootOf({
            type: 'string',
            $ref: '#/x',
         }),
      ],
      [
         'oneOf',
         rootOf({
            type: 'string',
            oneOf: [{ type: 'string' }],
         }),
      ],
      [
         'pattern',
         rootOf({
            type: 'string',
            pattern: '^a',
         }),
      ],
      [
         'format',
         rootOf({
            type: 'string',
            format: 'uri',
         }),
      ],
      [
         'default',
         rootOf({
            type: 'string',
            default: 'x',
         }),
      ],
      [
         'const',
         rootOf({
            type: 'string',
            const: 'x',
         }),
      ],
      [
         'an unknown keyword',
         rootOf({
            type: 'string',
            x: 1,
         }),
      ],
      [
         'additionalProperties true',
         {
            type: 'object',
            additionalProperties: true,
         },
      ],
      [
         'a fractional maxLength',
         rootOf({
            type: 'string',
            maxLength: 1.5,
         }),
      ],
      [
         'a negative minItems',
         rootOf({
            type: 'array',
            items: { type: 'string' },
            minItems: -1,
         }),
      ],
      [
         'an empty enum',
         rootOf({
            type: 'string',
            enum: [],
         }),
      ],
      [
         'a non-string enum',
         rootOf({
            type: 'string',
            enum: [1],
         }),
      ],
      [
         'a property named __proto__',
         JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
      ],
      [
         'a property named a-b',
         {
            type: 'object',
            properties: { 'a-b': { type: 'string' } },
         },
      ],
      [
         'a description with a newline',
         rootOf({
            type: 'string',
            description: 'a\nb',
         }),
      ],
      [
         'an empty description',
         rootOf({
            type: 'string',
            description: '',
         }),
      ],
      [
         'a root that is not an object schema',
         { type: 'string' },
      ],
   ])('refuses what the converter cannot support for plugin schemas as for shipped ones: %s', (_, schema) => {
      expect(compileSchema(schema, { source: 'plugin' }).ok).toBe(false);
      expect(jsonSchemaToZodShape(schema, false, 'plugin').ok).toBe(false);
   });

   it('returns no warnings for a shipped schema that compiles', () => {
      const validSchema = textSchema({ maxLength: 10 });
      expect(compileSchema(validSchema).warnings).toEqual([]);
      expect(jsonSchemaToZodShape(validSchema).warnings).toEqual([]);
   });

   it('names the guidelines in warning order and checks a description without a length limit', () => {
      expect(SCHEMA_GUIDELINES).toEqual([
         'depth',
         'nodes',
         'properties',
         'enumValues',
         'enumValueChars',
         'bound',
         'maxItemsMissing',
         'maxItems',
         'descriptionChars',
      ]);
      expect(guidelineWarning('nodes', 70)).toBe('schema has 70 nodes, over the 64-node guideline');
      expect(isWellFormedDescription('d'.repeat(500))).toBe(true);
      expect(isWellFormedDescription('')).toBe(false);
      expect(isWellFormedDescription('a\tb')).toBe(false);
      expect(isWellFormedDescription(1)).toBe(false);
   });
});
