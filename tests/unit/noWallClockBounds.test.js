// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The tests directory, one level above this test file.
 * @type {string}
 */
const TESTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The test file extensions scanned.
 * @type {RegExp}
 */
const TEST_FILE = /\.(?:js|mjs|ts)$/;

/**
 * An assertion on a duration measured with the wall clock: `expect(` followed directly by `performance.now() -` or
 * `Date.now() -`. The suite runs files in parallel on one machine, so such a bound fails under load while the code is
 * correct. A test proves an early stop or linear work by finishing inside its per-test limit instead. A poll deadline
 * (`expect(Date.now()).toBeLessThan(deadline)`) is a wait, not a duration bound, and is not matched. The scan catches
 * only this direct form: a duration first stored in a variable or passed through a helper is not matched. The pattern
 * is built from joined strings so that this file's own text never matches it.
 * @type {RegExp}
 */
const WALL_CLOCK_BOUND = new RegExp(['expect', '\\(\\s*(?:performance|Date)\\.now\\(\\)\\s*-'].join(''));

/**
 * List every scanned test file under a directory.
 * @param {string} dir - An absolute directory path.
 * @returns {string[]} The absolute file paths.
 */
function listTests(dir) {
   /** @type {string[]} The files found so far. */
   const files = [];
   for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      /** @type {string} The entry's absolute path. */
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
         if (entry.name !== 'node_modules') {
            files.push(...listTests(full));
         }
      } else if (TEST_FILE.test(entry.name)) {
         files.push(full);
      }
   }
   return files;
}

describe('no wall-clock bounds in tests', () => {
   it('no test asserts on a wall-clock duration', () => {
      /** @type {string[]} Test files that assert on a wall-clock time, relative to the tests directory. */
      const offenders = listTests(TESTS_ROOT)
         .filter((file) => WALL_CLOCK_BOUND.test(fs.readFileSync(file, 'utf8')))
         .map((file) => path.relative(TESTS_ROOT, file).split(path.sep).join('/'));
      expect(offenders).toEqual([]);
   });

   it('the pattern catches what it bans', () => {
      expect(WALL_CLOCK_BOUND.test(['expect(perf', 'ormance.now() - start).toBeLessThan(250);'].join(''))).toBe(true);
      expect(WALL_CLOCK_BOUND.test(['expect( Da', 'te.now() - t0).toBeLessThan(9);'].join(''))).toBe(true);
      expect(WALL_CLOCK_BOUND.test('const elapsed = performance.now() - start;')).toBe(false);
      expect(WALL_CLOCK_BOUND.test(['expect(Da', 'te.now()).toBeLessThan(deadline);'].join(''))).toBe(false);
   });
});
