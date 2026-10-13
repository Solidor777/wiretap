// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { buildOutput, e2eOutputNames } from '../../scripts/lib/buildOutput.mjs';
import {
   RELEASE_DIST_FILES,
   findMissingBuildFiles,
   findUnexpectedDistFiles,
} from '../../scripts/lib/moduleBuildCheck.mjs';

/** @type {string} The module root. */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {number} Counter that makes each scratch root unique inside one run. */
let counter = 0;

/**
 * Create a unique scratch module root under the gitignored `test/tmp/` holding a manifest and the given files.
 * @param {object} manifest - The `module.json` content.
 * @param {string[]} files - Paths, relative to the root, of the files to create.
 * @returns {string} The scratch root.
 */
function scratchModule(manifest, files) {
   counter += 1;
   /** @type {string} The unique root; `test/tmp/` itself is created when a clean checkout does not have it yet. */
   const root = path.join(MODULE_ROOT, 'test', 'tmp', `build-${Date.now()}-${process.pid}-${counter}`);
   mkdirSync(root, { recursive: true });
   writeFileSync(path.join(root, 'module.json'), JSON.stringify(manifest));
   for (const file of files) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), '');
   }
   return root;
}

describe('build configuration', () => {
   it('writes the production and the e2e build to dist/ without emptying it', () => {
      for (const mode of ['production', 'e2e']) {
         const build = buildOutput(mode, MODULE_ROOT);
         expect(build.outDir).toBe(path.join(MODULE_ROOT, 'dist'));
         expect(build.emptyOutDir).toBe(false);
      }
   });

   it('gives the e2e build file names with no content hash, so builds overwrite each other', () => {
      const build = buildOutput('e2e', MODULE_ROOT);
      expect(build.rollupOptions.output).toEqual(e2eOutputNames());
      for (const pattern of Object.values(build.rollupOptions.output)) {
         expect(pattern).not.toContain('[hash]');
      }
   });

   it('leaves the production file naming at the bundler default', () => {
      expect(buildOutput('production', MODULE_ROOT).rollupOptions).toEqual({});
   });
});

describe('module.json build paths', () => {
   it('points esmodules and styles into dist/, where the build writes', () => {
      /** @type {{ esmodules: string[], styles: string[] }} The shipped manifest. */
      const manifest = JSON.parse(readFileSync(path.join(MODULE_ROOT, 'module.json'), 'utf8'));
      expect(manifest.esmodules).toEqual(['dist/index.js']);
      expect(manifest.styles).toEqual(['dist/style.css']);
   });

   it('reports nothing missing when every named file exists', () => {
      const root = scratchModule({
         esmodules: ['dist/index.js'],
         styles: ['dist/style.css'],
      }, ['dist/index.js', 'dist/style.css']);
      expect(findMissingBuildFiles(root)).toEqual([]);
   });

   it('reports each named file that does not exist', () => {
      const root = scratchModule({
         esmodules: ['dist/index.js', 'dist/other.js'],
         styles: ['dist/style.css'],
      }, ['dist/index.js']);
      expect(findMissingBuildFiles(root)).toEqual(['dist/other.js', 'dist/style.css']);
   });

   it('tolerates a manifest with neither list', () => {
      expect(findMissingBuildFiles(scratchModule({}, []))).toEqual([]);
   });
});

describe('release check of dist/', () => {
   it('allows exactly the production build files', () => {
      expect(RELEASE_DIST_FILES).toEqual(['index.js', 'index.js.map', 'style.css']);
   });

   it('reports nothing for a dist/ that holds only the production build', () => {
      const root = scratchModule({}, RELEASE_DIST_FILES.map((name) => `dist/${name}`));
      expect(findUnexpectedDistFiles(root)).toEqual([]);
   });

   it('names every extra file, such as the e2e chunks and their maps', () => {
      const root = scratchModule({}, [
         ...RELEASE_DIST_FILES.map((name) => `dist/${name}`),
         'dist/registerProbe.js',
         'dist/registerProbe.js.map',
         'dist/TerminalConnection.svelte.js',
      ]);
      expect(findUnexpectedDistFiles(root)).toEqual([
         'TerminalConnection.svelte.js',
         'registerProbe.js',
         'registerProbe.js.map',
      ]);
   });

   it('reports nothing when dist/ does not exist (the missing-file check covers that)', () => {
      expect(findUnexpectedDistFiles(scratchModule({}, []))).toEqual([]);
   });
});
