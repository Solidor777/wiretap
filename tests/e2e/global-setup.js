import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The repo root, derived from this file's location (tests/e2e/global-setup.js).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Playwright global setup: build the e2e bundle (probe-enabled) once before the suite. Each spec file manages
 * its own fresh sidecar (see tests/e2e/sidecar.js), so the sidecar is no longer started here.
 * @returns {Promise<void>} Resolves once the e2e bundle is built.
 */
export default async function globalSetup() {
   execSync('npm run build:e2e', { cwd: repoRoot, stdio: 'inherit' });
}
