import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMissingBuildFiles, findUnexpectedDistFiles } from './lib/moduleBuildCheck.mjs';

/** @type {string} The module root, derived from this file's location (scripts/check-module-build.mjs). */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {boolean} Whether to also check that `dist/` holds only what a release ships (`--release`). */
const release = process.argv.includes('--release');

/** @type {string[]} The manifest paths with no file behind them. */
const missing = findMissingBuildFiles(root);
/** @type {string[]} The files in `dist/` a release must not ship; only looked for with `--release`. */
const unexpected = release ? findUnexpectedDistFiles(root) : [];

if (missing.length > 0) {
   console.error(`Wiretap build check | module.json names files that do not exist: ${missing.join(', ')}`);
}
if (unexpected.length > 0) {
   console.error(
      `Wiretap release check | dist/ holds files a release must not ship: ${unexpected.join(', ')}. ` +
         'Recycle them with trash, run `npm run build`, then `npm run check:release` again.',
   );
}
if (missing.length > 0 || unexpected.length > 0) {
   process.exit(1);
}
console.log(
   release
      ? 'Wiretap release check | dist/ holds only the production build and every file of module.json exists'
      : 'Wiretap build check | every esmodules and styles file of module.json exists',
);
