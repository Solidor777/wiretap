/**
 * File-system helpers for the backup tests: unique scratch roots under the gitignored `test/tmp/`, and a recycle bin
 * stand-in so no unit or integration test runs the real `trash` package. Vitest does not collect this file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @typedef {import('../../server/backups.ts').TrashFunction} TrashFunction */

/** @type {string} The module root, two levels above this file. */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {number} Counter that makes every scratch root of this process unique. */
let counter = 0;

/**
 * Create a scratch directory no earlier run or test has used: `test/tmp/<prefix>-<Date.now()>-<pid>-<counter>/`. The
 * directory itself is created without `recursive`, so a stale one fails loudly instead of letting a test pass on
 * leftovers. Nothing is ever removed; scratch roots stay in the gitignored `test/tmp/`.
 * @param {string} prefix - A label for the test file.
 * @returns {string} The absolute path of the new, empty directory.
 * @throws {Error} When the directory already exists.
 */
export function scratchRoot(prefix) {
   counter += 1;
   /** @type {string} The unique root. */
   const root = path.join(MODULE_ROOT, 'test', 'tmp', `${prefix}-${Date.now()}-${process.pid}-${counter}`);
   fs.mkdirSync(path.dirname(root), { recursive: true });
   fs.mkdirSync(root);
   return root;
}

/**
 * Build a recycle bin stand-in: it records each call's paths and moves each existing file into `binDir` with
 * `fs.renameSync`, creating `binDir` first. A missing path is ignored, as the `trash` package does.
 * @param {string} binDir - The directory files are moved into.
 * @returns {TrashFunction & { calls: string[][] }} The function, with the paths of every call in order.
 */
export function fakeTrash(binDir) {
   /** @type {string[][]} The paths of every call, in order. */
   const calls = [];
   /**
    * Move the given files into the bin directory.
    * @param {string[]} paths - The files to move.
    * @returns {Promise<void>} Resolves once every existing file is moved.
    */
   async function moveToBin(paths) {
      calls.push([...paths]);
      fs.mkdirSync(binDir, { recursive: true });
      for (const filePath of paths) {
         if (fs.existsSync(filePath)) {
            fs.renameSync(filePath, path.join(binDir, path.basename(filePath)));
         }
      }
   }
   return Object.assign(moveToBin, { calls });
}
