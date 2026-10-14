// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js';
import { compileSchema } from '../../shared/schemaValidate.js';
import { shippedScripts } from './scriptFixtures.js';
import { argumentSchema, jsonSchemaToZodShape, sanitizeRegistry } from '../../server/toolRegistry.ts';

/**
 * A schema whose root and list entries declare `additionalProperties: false`.
 * @type {object}
 */
const STRICT = {
   type: 'object',
   properties: {
      dryRun: { type: 'boolean' },
      rows: {
         type: 'array',
         maxItems: 5,
         items: {
            type: 'object',
            properties: { id: { type: 'string' } },
            additionalProperties: false,
         },
      },
   },
   additionalProperties: false,
};

/**
 * The same shape with no `additionalProperties`, which keeps dropping what it does not declare.
 * @type {object}
 */
const LENIENT = {
   type: 'object',
   properties: {
      dryRun: { type: 'boolean' },
      rows: {
         type: 'array',
         maxItems: 5,
         items: {
            type: 'object',
            properties: { id: { type: 'string' } },
         },
      },
   },
};

/**
 * Judge a value with the sidecar's schema.
 * @param {object} schema - The JSON Schema.
 * @param {unknown} value - The arguments.
 * @returns {{ success: boolean, data?: unknown }} The zod verdict.
 * @throws {Error} When the schema is refused.
 */
function sidecarJudges(schema, value) {
   const converted = jsonSchemaToZodShape(schema);
   if (!converted.ok) {
      throw new Error(converted.reason);
   }
   return argumentSchema(converted).safeParse(value);
}

/**
 * Judge a value with the client's validator.
 * @param {object} schema - The JSON Schema.
 * @param {unknown} value - The arguments.
 * @returns {{ ok: boolean, value?: unknown, error?: string }} The validator verdict.
 * @throws {Error} When the schema is refused.
 */
function clientJudges(schema, value) {
   const compiled = compileSchema(schema);
   if (!compiled.ok) {
      throw new Error(compiled.reason);
   }
   return compiled.validate(value);
}

describe('additionalProperties false rejects what the schema does not declare', () => {
   const refused = [
      { dryrun: true },
      {
         dryRun: true,
         dryrun: false,
      },
      { rows: [{ idd: 'a' }] },
      { rows: [{
         id: 'a',
         junk: 1,
      }] },
   ];

   it.each(refused)('refuses %j on both sides', (value) => {
      expect(sidecarJudges(STRICT, value).success).toBe(false);
      expect(clientJudges(STRICT, value).ok).toBe(false);
   });

   it('accepts the declared arguments on both sides', () => {
      const value = {
         dryRun: true,
         rows: [{ id: 'a' }],
      };
      expect(sidecarJudges(STRICT, value).success).toBe(true);
      expect(clientJudges(STRICT, value).ok).toBe(true);
   });

   it('refuses an own __proto__ key in the client, and the sidecar never passes it on', () => {
      const value = JSON.parse('{"__proto__": {"dryRun": true}}');
      expect(clientJudges(STRICT, value).ok).toBe(false);
      // Zod skips the key rather than refusing it, so it is absent from what the handler receives.
      const verdict = sidecarJudges(STRICT, value);
      expect(Object.keys(verdict.data ?? {})).toEqual([]);
   });

   it('names no caller text in the client error', () => {
      const outcome = clientJudges(STRICT, { 'MOCK_secret_key': 1 });
      expect(outcome.ok).toBe(false);
      expect(outcome.error).not.toContain('MOCK_secret_key');
      expect(new TextEncoder().encode(outcome.error).length).toBeLessThanOrEqual(256);
   });

   it('keeps dropping undeclared properties when the schema does not say additionalProperties false', () => {
      const value = {
         dryRun: true,
         junk: 1,
         rows: [{
            id: 'a',
            junk: 2,
         }],
      };
      expect(sidecarJudges(LENIENT, value)).toEqual({
         success: true,
         data: {
            dryRun: true,
            rows: [{ id: 'a' }],
         },
      });
      expect(clientJudges(LENIENT, value)).toEqual({
         ok: true,
         value: {
            dryRun: true,
            rows: [{ id: 'a' }],
         },
      });
   });
});

describe('sanitizeRegistry: strict tools', () => {
   it('marks a tool whose root declares additionalProperties false', () => {
      /** @type {string[]} The log lines. */
      const lines = [];
      const outcome = sanitizeRegistry(
         {
            apiVersion: 1,
            scripts: [
               {
                  name: 'mock_tool',
                  version: '1.0.0',
                  description: 'A synthetic tool.',
                  inputSchema: STRICT,
                  result: { budgetBytes: 4000 },
                  requires: 'api',
                  mutates: false,
               },
               {
                  name: 'mock_lenient',
                  version: '1.0.0',
                  description: 'A synthetic tool.',
                  inputSchema: LENIENT,
                  result: { budgetBytes: 4000 },
                  requires: 'api',
                  mutates: false,
               },
            ],
         },
         (line) => lines.push(line),
      );
      expect(outcome.ok).toBe(true);
      expect(outcome.tools.map((tool) => [tool.name, tool.strict])).toEqual([
         ['mock_tool', true],
         ['mock_lenient', false],
      ]);
   });
});

describe('the client lists every shipped definition as the sidecar does', () => {
   it('gives the same listed schema, so both measure the same bytes', () => {
      for (const definition of shippedScripts()) {
         const sidecar = toJsonSchemaCompat(
            argumentSchema(jsonSchemaToZodShape(definition.inputSchema, definition.strictNested === true)),
            {
               strictUnions: true,
               pipeStrategy: 'input',
            },
         );
         expect(
            compileSchema(definition.inputSchema, { strictNested: definition.strictNested === true }).listed,
            definition.name,
         ).toEqual(sidecar);
      }
   });
});
