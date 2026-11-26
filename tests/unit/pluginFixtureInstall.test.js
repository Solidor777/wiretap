// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
   FIXTURE_FILES,
   FIXTURE_MODULE_ID,
   fixtureInstallDir,
   installFixturePlugin,
} from '../e2e/pluginFixtureInstall.js';

/** @type {string} The module root, two levels above this file. */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {string} The fixture module's source folder in the repo. */
const SOURCE_DIR = path.join(MODULE_ROOT, 'tests', 'e2e', 'plugin-fixture');

/** @type {string} The gitignored scratch directory every test here writes into; never the real Foundry data folder. */
const SCRATCH = path.join(MODULE_ROOT, 'test', 'tmp', 'pluginFixtureInstall');

/** @type {number} Epoch milliseconds at module load; separates this run's roots from an earlier run's recycled pid. */
const RUN_STAMP = Date.now();

/** @type {number} Counter that makes every scratch root of this process unique. */
let rootCounter = 0;

/**
 * Return a data path no earlier run or test has used: `<SCRATCH>/<timestamp>-<pid>-<counter>`. It must not exist
 * yet, so a stale scratch directory fails the test loudly. Nothing is ever removed; leftovers stay in the gitignored
 * scratch directory.
 * @returns {string} The absolute path of a data path that does not exist.
 */
function freshDataPath() {
   rootCounter += 1;
   /** @type {string} The unique root. */
   const root = path.join(SCRATCH, `${RUN_STAMP}-${process.pid}-${rootCounter}`);
   expect(fs.existsSync(root), `stale scratch root ${root}`).toBe(false);
   return root;
}

describe('installFixturePlugin', () => {
   it('installs the fixture files into <dataPath>/Data/modules/wiretap-e2e-plugin', () => {
      /** @type {string} The scratch Foundry data path. */
      const dataPath = freshDataPath();
      /** @type {string} The folder the install wrote. */
      const installed = installFixturePlugin(dataPath);
      expect(installed).toBe(path.join(dataPath, 'Data', 'modules', FIXTURE_MODULE_ID));
      expect(fixtureInstallDir(dataPath)).toBe(installed);
      expect(FIXTURE_FILES).toEqual([
         'module.json',
         'index.js',
      ]);
      for (const name of FIXTURE_FILES) {
         expect(fs.readFileSync(path.join(installed, name)).equals(fs.readFileSync(path.join(SOURCE_DIR, name))))
            .toBe(true);
      }
   });

   it('overwrites an earlier install and leaves extra files in place', () => {
      /** @type {string} The scratch Foundry data path. */
      const dataPath = freshDataPath();
      /** @type {string} The folder an earlier install left. */
      const earlier = fixtureInstallDir(dataPath);
      fs.mkdirSync(earlier, { recursive: true });
      fs.writeFileSync(path.join(earlier, 'index.js'), '// MOCK_STALE_FIXTURE\n');
      fs.writeFileSync(path.join(earlier, 'notes.txt'), 'MOCK_NOTES\n');

      installFixturePlugin(dataPath);

      expect(fs.readFileSync(path.join(earlier, 'index.js')).equals(fs.readFileSync(path.join(SOURCE_DIR, 'index.js'))))
         .toBe(true);
      expect(fs.readFileSync(path.join(earlier, 'notes.txt'), 'utf8')).toBe('MOCK_NOTES\n');
   });
});
