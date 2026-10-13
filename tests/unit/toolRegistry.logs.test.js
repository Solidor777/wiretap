// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { sanitizeRegistry } from '../../server/toolRegistry.ts';

/** @type {string} The Unicode line and paragraph separators. */
const LINE_SEPARATORS = String.fromCharCode(0x2028, 0x2029);

/** @type {RegExp} Control characters and Unicode line separators that must never reach a log line. */
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${LINE_SEPARATORS}]`);

/**
 * Build a registry entry whose schema is the given one.
 * @param {object} inputSchema - The schema to place in the entry.
 * @returns {object} A registry entry that is otherwise valid.
 */
function entryWith(inputSchema) {
   return {
      name: 'mock_tool',
      description: 'A synthetic tool.',
      inputSchema,
   };
}

describe('sanitizeRegistry: log lines are safe', () => {
   it.each([
      [
         'an unsupported keyword',
         { type: 'object', [`bad\nkey${LINE_SEPARATORS}x`]: 1 },
      ],
      [
         'a property name',
         { type: 'object', properties: { [`bad\nname${LINE_SEPARATORS}x`]: { type: 'string' } } },
      ],
      [
         'a very long property name',
         { type: 'object', properties: { ['p'.repeat(300)]: { type: 'string' } } },
      ],
   ])('writes one bounded line without control characters for %s', (_label, schema) => {
      /** @type {string[]} The log lines written during the call. */
      const lines = [];
      const outcome = sanitizeRegistry([entryWith(schema)], (line) => lines.push(line));
      expect(outcome.tools).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]).not.toMatch(CONTROL);
      expect(Buffer.byteLength(lines[0], 'utf8')).toBeLessThanOrEqual(400);
   });
});
