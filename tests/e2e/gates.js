import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import config from '../../playwright.config.mjs';
import { GATES } from '../../shared/gates.js';
import { login } from './fixtures.js';
import { GATE_OBSERVER_PORT } from './ports.js';

/** @type {string} The repo root, derived from this file's location. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {string} The running list of prior setting values; overwritten, never deleted, restored by setup and teardown. */
const RECORD_FILE = path.join(repoRoot, 'test', 'state', 'gate-settings.json');

/** @type {number} The longest a request to the gate observer may take, in milliseconds. */
const OBSERVER_TIMEOUT_MS = 1000;

/**
 * @type {string[]} The world settings the record holds: every gate, and the Backup folder setting, which
 * `backupTools.spec.js` points at a `test/tmp/` scratch folder for each test.
 */
const RECORDED_SETTINGS = [
   ...Object.keys(GATES),
   'backupFolder',
];

/**
 * @typedef {object} GateRecord
 * @property {boolean} pending - True while the recorded values still have to be restored.
 * @property {string} world - The id of the world the values belong to.
 * @property {Record<string, unknown>} values - The prior values of the recorded settings keyed by setting name.
 */

/**
 * @typedef {object} SidecarObservation
 * @property {Record<string, unknown>} gateState - The gate snapshot of the endpoint a call would reach now.
 * @property {string[]} socketIds - The ids of the sockets currently connected to the sidecar.
 */

/**
 * Read the current value of every recorded setting (the gates and the Backup folder) in the page.
 * @param {import('@playwright/test').Page} page - The logged-in GM page.
 * @returns {Promise<Record<string, unknown>>} The stored values keyed by setting name.
 */
export async function readGateSettings(page) {
   return page.evaluate(
      (names) =>
         Object.fromEntries(
            names.map((name) => [
               name,
               game.settings.get('wiretap', name),
            ]),
         ),
      RECORDED_SETTINGS,
   );
}

/**
 * Record the current values of the recorded settings and the world id so they can be restored after a spec, even
 * after a crash.
 * @param {import('@playwright/test').Page} page - The logged-in GM page.
 * @returns {Promise<void>} Resolves once the record is written.
 */
export async function recordGateSettings(page) {
   /** @type {GateRecord} The record to write. */
   const record = {
      pending: true,
      world: await page.evaluate(() => game.world.id),
      values: await readGateSettings(page),
   };
   fs.mkdirSync(path.dirname(RECORD_FILE), { recursive: true });
   fs.writeFileSync(RECORD_FILE, JSON.stringify(record, null, 3));
}

/**
 * Restore every recorded setting through the settings API and mark the record as restored. A no-op when nothing is
 * pending or when the record belongs to another world, so it is safe to call at the start of a run, after every test
 * and at the end of the run.
 * @param {import('@playwright/test').Page} page - The logged-in GM page.
 * @returns {Promise<void>} Resolves once the settings hold their recorded values.
 */
export async function restoreGateSettings(page) {
   if (!fs.existsSync(RECORD_FILE)) {
      return;
   }
   /** @type {GateRecord} The parsed running list. */
   const record = JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8'));
   if (!record.pending || record.world !== (await page.evaluate(() => game.world.id))) {
      return;
   }
   await page.evaluate(async (values) => {
      for (const [name, value] of Object.entries(values)) {
         if (game.settings.get('wiretap', name) !== value) {
            await game.settings.set('wiretap', name, value);
         }
      }
   }, record.values);
   fs.writeFileSync(RECORD_FILE, JSON.stringify({ ...record, pending: false }, null, 3));
}

/**
 * Restore a pending gate record from a headless browser of its own, for the global setup (a crashed run) and the
 * global teardown. Launches nothing when no record is pending.
 * @returns {Promise<void>} Resolves once any pending record is restored or found to belong to another world.
 */
export async function restorePendingGateRecord() {
   if (!fs.existsSync(RECORD_FILE) || !JSON.parse(fs.readFileSync(RECORD_FILE, 'utf8')).pending) {
      return;
   }
   /** @type {import('@playwright/test').Browser} A headless browser used only for this restore. */
   const browser = await chromium.launch({ headless: true });
   try {
      /** @type {import('@playwright/test').Page} The page that logs in as the GM. */
      const page = await browser.newPage({ baseURL: config.use.baseURL });
      await login(page);
      await restoreGateSettings(page);
   } finally {
      await browser.close();
   }
}

/**
 * Read what the e2e sidecar currently holds.
 * @returns {Promise<SidecarObservation>} The observer's answer.
 */
export async function readSidecarObservation() {
   /** @type {Response} The observer's response. */
   const response = await fetch(`http://127.0.0.1:${GATE_OBSERVER_PORT}/`, {
      signal: AbortSignal.timeout(OBSERVER_TIMEOUT_MS),
   });
   return response.json();
}

/**
 * Read the risk-gate snapshot the e2e sidecar currently holds for the endpoint it would route to.
 * @returns {Promise<Record<string, unknown>>} The sidecar's gate snapshot.
 */
export async function readSidecarGateState() {
   return (await readSidecarObservation()).gateState;
}
