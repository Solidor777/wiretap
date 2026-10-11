// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { BUDGETS, BUDGET_SEVERITY, getBudget } from '../../shared/budgets.js';

/**
 * Every context budget with its expected value, unit and severity. Written out independently of the module so a
 * changed number fails here and has to be changed deliberately.
 * @type {Array<[string, number, string, string]>}
 */
const EXPECTED = [
   [
      'CORE_TOOL_NAME_MAX_CHARS',
      32,
      'chars',
      'hard',
   ],
   [
      'PLUGIN_TOOL_NAME_MAX_CHARS',
      64,
      'chars',
      'hard',
   ],
   [
      'DEFINITION_MAX_BYTES',
      800,
      'bytes',
      'hard',
   ],
   [
      'DESCRIPTION_TARGET_CHARS',
      160,
      'chars',
      'warn',
   ],
   [
      'DESCRIPTION_MAX_CHARS',
      240,
      'chars',
      'hard',
   ],
   [
      'INSTRUCTIONS_MAX_CHARS',
      600,
      'chars',
      'hard',
   ],
   [
      'ALWAYS_LISTED_TOOLS_MAX',
      30,
      'count',
      'hard',
   ],
   [
      'ALL_DEFINITIONS_MAX_BYTES',
      16000,
      'bytes',
      'hard',
   ],
   [
      'ACK_MAX_BYTES',
      256,
      'bytes',
      'hard',
   ],
   [
      'COMPACT_VIEW_MAX_BYTES',
      2000,
      'bytes',
      'hard',
   ],
   [
      'COMPACT_EMBEDDED_TUPLES_MAX',
      40,
      'count',
      'hard',
   ],
   [
      'PROJECTION_BYTES_PER_10_FIELDS',
      1000,
      'bytes',
      'warn',
   ],
   [
      'SEARCH_PAGE_MAX_BYTES',
      4000,
      'bytes',
      'hard',
   ],
   [
      'SEARCH_DEFAULT_LIMIT',
      20,
      'count',
      'hard',
   ],
   [
      'SEARCH_MAX_LIMIT',
      100,
      'count',
      'hard',
   ],
   [
      'ERROR_MAX_BYTES',
      512,
      'bytes',
      'hard',
   ],
   [
      'ERROR_MAX_FAILURES',
      10,
      'count',
      'hard',
   ],
   [
      'RESULT_HARD_CAP_DEFAULT_BYTES',
      8000,
      'bytes',
      'hard',
   ],
   [
      'RESULT_HARD_CAP_MAX_BYTES',
      16000,
      'bytes',
      'hard',
   ],
   [
      'SHEET_LAYOUT_MAX_BYTES',
      4000,
      'bytes',
      'hard',
   ],
   [
      'IMAGE_DEFAULT_MAX_PIXELS',
      480000,
      'pixels',
      'hard',
   ],
   [
      'IMAGE_MAX_SIDE_PIXELS',
      1280,
      'pixels',
      'hard',
   ],
   [
      'IMAGE_MAX_PER_RESULT',
      1,
      'count',
      'hard',
   ],
   [
      'IMAGE_DATA_MAX_BYTES',
      1000000,
      'chars',
      'hard',
   ],
   [
      'HANDLE_ENTRY_MAX_BYTES',
      8000000,
      'bytes',
      'hard',
   ],
   [
      'HANDLE_MAX_COUNT',
      1024,
      'count',
      'hard',
   ],
   [
      'LIVE_RECALIBRATION_MAX_RUNS',
      6,
      'count',
      'warn',
   ],
   [
      'PATHS_PER_CALL_MAX',
      20,
      'count',
      'hard',
   ],
   [
      'PATH_ERROR_MAX_BYTES',
      256,
      'bytes',
      'hard',
   ],
   [
      'PATH_BYTES_MAX',
      512,
      'bytes',
      'hard',
   ],
   [
      'PATH_SEGMENTS_MAX',
      16,
      'count',
      'hard',
   ],
];

describe('getBudget', () => {
   it.each(EXPECTED)('%s is %d %s and %s', (name, value, unit, severity) => {
      expect(getBudget(name)).toEqual({
         name,
         value,
         unit,
         severity,
      });
   });

   it('covers exactly the expected budgets', () => {
      expect(Object.keys(BUDGETS).sort()).toEqual(EXPECTED.map(([name]) => name).sort());
   });

   it('throws for an unknown budget name', () => {
      expect(() => getBudget('NOT_A_BUDGET')).toThrow('Unknown budget: NOT_A_BUDGET');
   });

   it('does not resolve inherited object properties as budgets', () => {
      expect(() => getBudget('constructor')).toThrow('Unknown budget');
      expect(() => getBudget('__proto__')).toThrow('Unknown budget');
   });
});

describe('BUDGET_SEVERITY', () => {
   it('names the two severities', () => {
      expect(BUDGET_SEVERITY).toEqual({
         HARD: 'hard',
         WARN: 'warn',
      });
   });

   it('tags every budget with one of them', () => {
      for (const entry of Object.values(BUDGETS)) {
         expect(Object.values(BUDGET_SEVERITY)).toContain(entry.severity);
      }
   });
});

describe('immutability', () => {
   it('freezes the table, every entry and the severity map', () => {
      expect(Object.isFrozen(BUDGETS)).toBe(true);
      expect(Object.isFrozen(BUDGET_SEVERITY)).toBe(true);
      for (const entry of Object.values(BUDGETS)) {
         expect(Object.isFrozen(entry)).toBe(true);
      }
   });

   it('returns an entry that cannot change a stored value', () => {
      const entry = getBudget('ACK_MAX_BYTES');
      expect(() => {
         'use strict';
         entry.value = 1;
      }).toThrow(TypeError);
      expect(getBudget('ACK_MAX_BYTES').value).toBe(256);
   });
});
