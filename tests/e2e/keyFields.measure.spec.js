import fs from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { login } from './fixtures.js';

/**
 * Candidate generator for the per-subtype compact-view key-field lists (`src/bridge/scripts/keyFields.json`). It is a
 * measurement, not a test: it runs only when `WIRETAP_MEASURE_KEYFIELDS=1` is set, reads the live world without
 * writing to it, and writes `debug/dumps/keyfields-candidates.json` (the ranked candidates) and
 * `debug/dumps/keyfields-reviewed.json` (the candidates after the review filter, in the committed format).
 * `docs/experiments/2026-10-m4-keyfields.md` records the command, the date and the review.
 *
 * Command: `WIRETAP_MEASURE_KEYFIELDS=1 npx playwright test tests/e2e/keyFields.measure.spec.js`.
 *
 * Candidate rules, applied to the blank `system` export of every document class and subtype that the system registers
 * a data model for (`CONFIG[documentName].dataModels`), built in memory and never persisted:
 *
 * Rule 1: a candidate is a scalar leaf, meaning a number, a boolean, or a string whose blank value is non-empty and at
 * most 24 bytes (an empty string may be free text or an id and says nothing about the leaf's role).
 *
 * Rule 2: `documentVersion` leaves are dropped (migration bookkeeping).
 *
 * Rule 3: an object node with 8 or more object children is a table of look-alike rows (a skill list) and its subtree
 * is skipped.
 *
 * Rule 4: candidates are ranked by depth (fewer segments first), then by schema order, and the first 24 are kept.
 *
 * Review filter, applied after the candidates are written: leaves ending in `mod.static` are dropped (static modifier
 * bookkeeping, 0 on every blank document) and the core-defined `RegionBehavior` subtypes are left out (the system did
 * not define them); a subtype left with no leaf gets no list and falls back to the default key-name pattern.
 */

/** @type {boolean} Whether the measurement was requested. */
const REQUESTED = process.env.WIRETAP_MEASURE_KEYFIELDS === '1';

/** @type {string} The candidate file, under the gitignored debug sink. */
const OUTPUT = path.resolve(import.meta.dirname, '../../debug/dumps/keyfields-candidates.json');

/** @type {string} The reviewed lists, in the format of the committed data file. */
const REVIEWED = path.resolve(import.meta.dirname, '../../debug/dumps/keyfields-reviewed.json');

test.skip(!REQUESTED, 'Set WIRETAP_MEASURE_KEYFIELDS=1 to generate key-field candidates.');

test('generate key-field candidates from the live world', async ({ page }) => {
   await login(page);
   /**
    * @type {{ system: string, generatedAt: string, lists: Record<string, string[]>,
    * skipped: Record<string, string> }} The candidates found in the live world.
    */
   const result = await page.evaluate(() => {
      /** @type {number} Most paths per list. */
      const LIST_MAX = 24;
      /** @type {number} Child objects that make an object node a table. */
      const TABLE_ROWS = 8;
      /** @type {number} Longest blank string value that counts as a candidate, in bytes. */
      const STRING_MAX = 24;
      /** @type {Record<string, string[]>} The candidate lists by `<documentName>.<type>`. */
      const lists = {};
      /** @type {Record<string, string>} Pairs that could not be built, with the reason. */
      const skipped = {};
      for (const documentName of CONST.ALL_DOCUMENT_TYPES) {
         /** @type {Record<string, unknown> | undefined} The data models the system registered. */
         const models = CONFIG[documentName]?.dataModels;
         if (models === undefined) {
            continue;
         }
         for (const type of Object.keys(models)) {
            try {
               /** @type {object} The blank document, never persisted. */
               const blank = new CONFIG[documentName].documentClass({
                  name: 'MOCK_BLANK',
                  type,
               });
               /** @type {Record<string, unknown>} Its canonical export. */
               const data = blank.toCompendium(null, {
                  clearSource: false,
                  keepId: true,
                  clearSort: false,
                  clearOwnership: false,
               });
               /** @type {Array<{ path: string, depth: number }>} The candidates in schema order. */
               const found = [];
               const walk = (node, prefix, depth) => {
                  for (const [key, value] of Object.entries(node)) {
                     if (key === 'documentVersion') {
                        continue;
                     }
                     if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
                        const rows = Object.values(value).filter(
                           (member) => member !== null && typeof member === 'object' && !Array.isArray(member),
                        ).length;
                        if (rows < TABLE_ROWS && depth < 6) {
                           walk(value, `${prefix}${key}.`, depth + 1);
                        }
                     } else if (
                        typeof value === 'number' ||
                        typeof value === 'boolean' ||
                        (typeof value === 'string' &&
                           value.length > 0 &&
                           new TextEncoder().encode(value).length <= STRING_MAX)
                     ) {
                        found.push({
                           path: `${prefix}${key}`,
                           depth,
                        });
                     }
                  }
               };
               walk(data.system ?? {}, '', 1);
               lists[`${documentName}.${type}`] = found
                  .map((entry, order) => ({
                     ...entry,
                     order,
                  }))
                  .sort((a, b) => a.depth - b.depth || a.order - b.order)
                  .slice(0, LIST_MAX)
                  .map((entry) => entry.path);
            } catch (error) {
               skipped[`${documentName}.${type}`] = String(error).slice(0, 120);
            }
         }
      }
      return {
         system: game.system.id,
         generatedAt: new Date().toISOString(),
         lists,
         skipped,
      };
   });
   fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
   fs.writeFileSync(OUTPUT, `${JSON.stringify(result, null, 3)}\n`);
   /** @type {Record<string, string[]>} The lists after the review filter. */
   const reviewed = {};
   for (const [pair, paths] of Object.entries(result.lists)) {
      /** @type {string[]} The leaves that survive the review filter. */
      const kept = paths.filter((leaf) => !leaf.endsWith('mod.static'));
      if (!pair.startsWith('RegionBehavior.') && kept.length > 0) {
         reviewed[pair] = kept;
      }
   }
   fs.writeFileSync(REVIEWED, `${JSON.stringify({ [result.system]: reviewed }, null, 3)}\n`);
});
