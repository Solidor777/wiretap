import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { GATE_DENIED } from '$shared/protocol.js';
import { fitPackAck, requireOpenGate } from '~/bridge/scripts/packCommon.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/** @type {Record<string, boolean>} The gate values the stubbed settings return. */
let gates;

/**
 * Measure a row as JSON in UTF-8 bytes.
 * @param {unknown} row - The row to measure.
 * @returns {number} The byte length of its JSON.
 */
function jsonBytes(row) {
   return new TextEncoder().encode(JSON.stringify(row)).length;
}

beforeEach(() => {
   gates = {};
   globalThis.game = {
      settings: {
         get: (module, key) => {
            if (key === 'allowedPluginModules') {
               return '';
            }
            return gates[key] ?? false;
         },
      },
   };
});

afterEach(() => {
   delete globalThis.game;
});

describe('requireOpenGate', () => {
   it('requireOpenGate throws GATE_DENIED naming the gate while it is closed and returns once it is open', () => {
      /** @type {unknown} What the closed gate threw. */
      let thrown = null;
      try {
         requireOpenGate('allowPackDeletion');
      } catch (error) {
         thrown = error;
      }
      expect(thrown).toBeInstanceOf(ScriptError);
      expect(thrown.code).toBe(GATE_DENIED);
      expect(thrown.message).toContain('allowPackDeletion');
      gates.allowPackDeletion = true;
      expect(requireOpenGate('allowPackDeletion')).toBeUndefined();
   });
});

describe('fitPackAck', () => {
   it('fitPackAck returns a row that already fits equal to the input', () => {
      /** @type {Record<string, unknown>} A row well under the budget. */
      const row = {
         dryRun: true,
         id: 'world.wiretap-e2e',
         label: 'Wiretap E2E',
         type: 'Item',
      };
      /** @type {Record<string, unknown>} The fitted row. */
      const fitted = fitPackAck(row);
      expect(fitted).toEqual(row);
      expect(fitted).not.toBe(row);
   });

   it('fitPackAck cuts a 128-character label of 4-byte characters so the row is at most 256 bytes', () => {
      /** @type {Record<string, unknown>} The fitted row. */
      const row = fitPackAck({
         dryRun: true,
         id: `world.${'a'.repeat(64)}`,
         label: '😀'.repeat(128),
         type: 'JournalEntry',
         documents: 99999,
      });
      expect(jsonBytes(row)).toBeLessThanOrEqual(256);
      expect(row.label.endsWith('…')).toBe(true);
      expect('😀'.repeat(128).startsWith(row.label.slice(0, -1))).toBe(true);
      // The largest prefix: one more character would not fit.
      expect(jsonBytes({
         ...row,
         label: `${row.label.slice(0, -1)}😀…`,
      })).toBeGreaterThan(256);
   });

   it('fitPackAck counts the JSON escapes of the label', () => {
      /** @type {Record<string, unknown>} The fitted row. */
      const row = fitPackAck({
         id: 'world.quotes',
         label: '"'.repeat(200),
         type: 'Item',
      });
      expect(jsonBytes(row)).toBeLessThanOrEqual(256);
      expect(row.label.endsWith('…')).toBe(true);
   });

   it('fitPackAck keeps a pack id longer than the budget whole and empties the label', () => {
      /** @type {Record<string, unknown>} A row whose id alone passes the budget. */
      const input = {
         id: `world.${'c'.repeat(300)}`,
         label: 'MOCK_PACK',
         type: 'Item',
      };
      /** @type {Record<string, unknown>} The fitted row. */
      const row = fitPackAck(input);
      expect(row.id).toBe(input.id);
      expect(row.type).toBe('Item');
      expect(row.label).toBe('');
      expect(jsonBytes(row)).toBeGreaterThan(256);
   });

   it('fitPackAck keeps every field but the label', () => {
      /** @type {Record<string, unknown>} A row whose label is too long. */
      const input = {
         dryRun: false,
         id: `world.${'b'.repeat(64)}`,
         label: 'L'.repeat(400),
         type: 'Actor',
         documents: 12,
      };
      /** @type {Record<string, unknown>} The fitted row. */
      const row = fitPackAck(input);
      expect(Object.keys(row)).toEqual(Object.keys(input));
      for (const key of [
         'dryRun',
         'id',
         'type',
         'documents',
      ]) {
         expect(row[key]).toBe(input[key]);
      }
      expect(row.label).not.toBe(input.label);
      expect(input.label).toHaveLength(400);
   });
});
