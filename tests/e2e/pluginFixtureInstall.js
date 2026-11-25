/**
 * Installs the e2e fixture module (`tests/e2e/plugin-fixture/`) into the Foundry data folder, where Foundry finds
 * module folders when its server starts. Node `fs` only and no Playwright import, so the Foundry launcher
 * (`scripts/e2e-foundry-server.mjs`) can load it before Playwright's global setup runs. It overwrites the fixture
 * files and never deletes anything.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {string} The directory of this file (tests/e2e). */
const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {string} The module repository root (…/foundryuserdata/Data/modules/wiretap). */
const repoRoot = path.resolve(here, '..', '..');

/** @type {string} The fixture module's source folder in the repo. */
const SOURCE_DIR = path.join(here, 'plugin-fixture');

/**
 * @type {string} The Foundry user-data directory by default: `FOUNDRY_DATA_PATH`, else three levels above the repo, the
 * same default as `scripts/e2e-foundry-server.mjs`.
 */
const DEFAULT_DATA_PATH = process.env.FOUNDRY_DATA_PATH ?? path.resolve(repoRoot, '..', '..', '..');

/** @type {string} The fixture module's id, as its module.json names it. */
export const FIXTURE_MODULE_ID = 'wiretap-e2e-plugin';

/** @type {string[]} The files the install copies, all of the fixture module. */
export const FIXTURE_FILES = [
   'module.json',
   'index.js',
];

/**
 * The folder the fixture module is installed in.
 * @param {string} [dataPath] - The Foundry user-data directory; `DEFAULT_DATA_PATH` when omitted.
 * @returns {string} `<dataPath>/Data/modules/wiretap-e2e-plugin`.
 */
export function fixtureInstallDir(dataPath = DEFAULT_DATA_PATH) {
   return path.join(dataPath, 'Data', 'modules', FIXTURE_MODULE_ID);
}

/**
 * Write every fixture file into the install folder, creating the folder when it is missing. Files already there are
 * overwritten; other files in the folder are left in place.
 * @param {string} [dataPath] - The Foundry user-data directory, defaulted as `fixtureInstallDir` does.
 * @returns {string} The install folder.
 */
export function installFixturePlugin(dataPath) {
   /** @type {string} The folder the files are written to. */
   const dir = fixtureInstallDir(dataPath);
   fs.mkdirSync(dir, { recursive: true });
   for (const name of FIXTURE_FILES) {
      fs.copyFileSync(path.join(SOURCE_DIR, name), path.join(dir, name));
   }
   return dir;
}
