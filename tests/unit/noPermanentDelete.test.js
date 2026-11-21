// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The module root, two levels above this test file.
 * @type {string}
 */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The source directories scanned, relative to the module root.
 * @type {string[]}
 */
const SOURCE_DIRS = [
   'server',
   'shared',
   'src',
   'scripts',
   'tests',
];

/**
 * The source file extensions scanned.
 * @type {RegExp}
 */
const SOURCE_FILE = /\.(?:js|mjs|ts|svelte)$/;

// The patterns below are built from joined strings so that this file's own text never matches them.

/**
 * A call of a permanent file-deletion function: `unlink`, `rm`, `rmdir` and their sync forms.
 * @type {RegExp}
 */
const DELETE_CALL = new RegExp(`\\b(?:${[
   'unlink',
   'unlinkSync',
   'rm',
   'rmSync',
   'rmdir',
   'rmdirSync',
].join('|')})\\s*\\(`);

/**
 * Build a pattern that matches an import or require of one of the named packages: a quoted module specifier equal to
 * one of them after `from`, a bare `import`, `import(` or `require(`.
 * @param {string[]} names - The package names to match exactly.
 * @returns {RegExp} A pattern that tests source text for such an import.
 */
function importPattern(names) {
   return new RegExp(`(?:\\bfrom\\s*|\\bimport\\s*\\(?\\s*|\\brequire\\s*\\(\\s*)(['"\`])(?:${names.join('|')})\\1`);
}

/**
 * An import or require of a recursive-removal package.
 * @type {RegExp}
 */
const DELETE_PACKAGE = importPattern([
   'rim' + 'raf',
   'd' + 'el',
]);

/**
 * An import of the recycle-bin package.
 * @type {RegExp}
 */
const TRASH_IMPORT = importPattern(['tra' + 'sh']);

/**
 * List every scanned source file under a directory, skipping `node_modules`.
 * @param {string} dir - An absolute directory path.
 * @returns {string[]} The absolute file paths.
 */
function listSources(dir) {
   /** @type {string[]} The files found so far. */
   const files = [];
   for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      /** @type {string} The entry's absolute path. */
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
         if (entry.name !== 'node_modules') {
            files.push(...listSources(full));
         }
      } else if (SOURCE_FILE.test(entry.name)) {
         files.push(full);
      }
   }
   return files;
}

/**
 * Every scanned source file, as `{ rel, text }` with a forward-slash path relative to the module root.
 * @type {Array<{ rel: string, text: string }>}
 */
const SOURCES = SOURCE_DIRS.flatMap((dir) => listSources(path.join(MODULE_ROOT, dir))).map((file) => ({
   rel: path.relative(MODULE_ROOT, file).split(path.sep).join('/'),
   text: fs.readFileSync(file, 'utf8'),
}));

describe('recycle bin only', () => {
   it('scans the source tree', () => {
      expect(SOURCES.some(({ rel }) => rel === 'tests/unit/noPermanentDelete.test.js')).toBe(true);
   });

   it('no product or test file calls a permanent-delete API', () => {
      /** @type {string[]} Files that call a deletion function or import a removal package. */
      const offenders = SOURCES
         .filter(({ text }) => DELETE_CALL.test(text) || DELETE_PACKAGE.test(text))
         .map(({ rel }) => rel);
      expect(offenders).toEqual([]);
   });

   it('only server/backups.ts imports trash', () => {
      /** @type {string[]} Files that import the recycle-bin package. */
      const importers = SOURCES.filter(({ text }) => TRASH_IMPORT.test(text)).map(({ rel }) => rel);
      expect(['server/backups.ts']).toEqual(expect.arrayContaining(importers));
   });

   it('the patterns catch what they ban', () => {
      expect(DELETE_CALL.test(['fs.', 'rm', 'Sync(p)'].join(''))).toBe(true);
      expect(DELETE_CALL.test(['await un', 'link (p)'].join(''))).toBe(true);
      expect(DELETE_CALL.test('confirm(x)')).toBe(false);
      expect(DELETE_PACKAGE.test(`import x from '${'rim' + 'raf'}';`)).toBe(true);
      expect(DELETE_PACKAGE.test(`const d = require("${'d' + 'el'}");`)).toBe(true);
      expect(DELETE_PACKAGE.test(`import x from '${'d' + 'elta'}';`)).toBe(false);
      expect(TRASH_IMPORT.test(`import t from '${'tra' + 'sh'}';`)).toBe(true);
   });
});
