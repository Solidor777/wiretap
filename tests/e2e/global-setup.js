import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, derived from this setup file's location (tests/e2e/global-setup.js).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Playwright global setup: build the module with the e2e probe enabled so the live world loads a bundle
 * exposing `game.modules.get('wiretap').api._probe`.
 * @returns {Promise<void>} Resolves once `vite build --mode e2e` completes.
 */
export default async function globalSetup() {
   execSync('npm run build:e2e', { cwd: repoRoot, stdio: 'inherit' });
}
