import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
   getAncestors,
   pickStandaloneWatchPid,
   pickWatchPid,
   superviseServer,
} from './lib/superviseServer.mjs';

// Launcher for the Foundry server that e2e runs against. Used as Playwright's `webServer.command` and, with the
// `--standalone` argument, as `npm run foundry:start`. Launches Foundry on the configured world when nothing answers
// on the Foundry port, and reuses an already-running server otherwise. A launched server is killed when this process
// ends (signals, exit) and whenever the watched process disappears. Under Playwright the watched process is the
// nearest non-shell ancestor (the runner). With `--standalone` it is the process that launched the run: the shell or
// program that ran `npm run foundry:start`, skipping the npm wrapper, which outlives a killed invoker.
// Environment overrides: FOUNDRY_DATA_PATH, FOUNDRY_APP_DIR, FOUNDRY_PORT, FOUNDRY_WORLD, FOUNDRY_SERVER_LOG.

/** @type {string} The module repository root (…/foundryuserdata/Data/modules/wiretap). */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {string} The Foundry user-data directory: three levels above the module folder unless overridden. */
const dataPath = process.env.FOUNDRY_DATA_PATH ?? path.resolve(repoRoot, '..', '..', '..');

/** @type {string} The Foundry application directory (holds main.js): a sibling of the data directory. */
const appDir = process.env.FOUNDRY_APP_DIR ?? path.resolve(dataPath, '..', 'foundry');

/** @type {number} The port Foundry binds (its options.json default is 30000). */
const port = Number(process.env.FOUNDRY_PORT ?? 30000);

/** @type {string} The world Foundry launches on start, so a fresh server lands on the join screen the specs expect. */
const world = process.env.FOUNDRY_WORLD ?? 'test-titan';

/** @type {boolean} Whether the `--standalone` argument was passed (`npm run foundry:start`). */
const standalone = process.argv.includes('--standalone');

/** @type {{ pid: number, name: string }[]} The ancestor chain of this process, nearest first. */
const ancestors = getAncestors(process.pid);

/**
 * The process whose death stops the server: the launching process when standalone (`npm_execpath` set means the
 * run came through npm), otherwise the nearest non-shell ancestor (the Playwright runner). Falls back to the parent
 * when the chain is exhausted.
 * @type {number}
 */
const watchPid = (standalone
   ? pickStandaloneWatchPid(ancestors, Boolean(process.env.npm_execpath))
   : pickWatchPid(ancestors)) ?? process.ppid;

/**
 * Timestamped copy of everything the launched server prints, so a server death mid-suite can be lined up
 * against the failing specs afterwards. Lives under the gitignored debug sink; `FOUNDRY_SERVER_LOG`
 * relocates it.
 * @type {string}
 */
const logFile = process.env.FOUNDRY_SERVER_LOG ?? path.join(repoRoot, 'debug', 'dumps', 'e2e-server.log');

/** @type {import('./lib/superviseServer.mjs').SuperviseHandle} The supervised server. */
const handle = await superviseServer({
   command: process.execPath,
   args: [
      'main.js',
      `--dataPath=${dataPath}`,
      `--world=${world}`,
   ],
   cwd: appDir,
   port,
   watchPid,
   logFile,
});

for (const signal of [
   'SIGINT',
   'SIGTERM',
   'SIGHUP',
   'SIGBREAK',
]) {
   process.on(signal, () => handle.stop());
}
process.on('exit', () => handle.stop());

process.exitCode = await handle.done;
