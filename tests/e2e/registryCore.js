import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** @type {string} The repo root, derived from this file's location. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {string} The running list of documents the e2e flows created; overwritten, never deleted. */
export const DEFAULT_RECORD_FILE = path.join(repoRoot, 'test', 'state', 'registry.json');

/** @type {string} The name prefix of every document an e2e flow creates; census, sweep and teardown key on it. */
export const E2E_PREFIX = 'Wiretap E2E ';

/** @type {string} The world the census, sweep and teardown may touch; override with FOUNDRY_WORLD. */
export const TEST_WORLD = process.env.FOUNDRY_WORLD || 'test-titan';

/**
 * The world document types a flow may create and the teardown or sweep may delete. Folders come last so their contents
 * are removed first. Every type here is a top-level world collection holding documents named by `name`.
 * @type {readonly string[]}
 */
export const ALLOWED_DOCUMENT_NAMES = Object.freeze([
   'Actor',
   'Item',
   'Scene',
   'JournalEntry',
   'Macro',
   'RollTable',
   'Playlist',
   'Cards',
   'Folder',
]);

/** @type {RegExp} A Foundry document id: 16 alphanumeric characters. */
const ID_PATTERN = /^[A-Za-z0-9]{16}$/;

/** @type {number} The most entries a record may hold; a longer record is corrupt. */
const ENTRIES_MAX = 1000;

/** @type {number} The longest `createdBy` text of an entry, in characters. */
const CREATED_BY_MAX_CHARS = 64;

/** @type {number} The most leftovers or violations a failure message lists. */
const REPORT_MAX = 10;

/**
 * @typedef {object} RegistryEntry
 * @property {string} documentName - The document class, one of `ALLOWED_DOCUMENT_NAMES`.
 * @property {string} id - The document id.
 * @property {string} uuid - The document uuid, `<documentName>.<id>`; resolved with `fromUuid` at teardown.
 * @property {string} createdBy - The spec that created it.
 */

/**
 * @typedef {object} RegistryRecord
 * @property {boolean} pending - True while recorded documents may still exist.
 * @property {string} world - The id of the world the documents belong to.
 * @property {RegistryEntry[]} entries - The documents created and not yet torn down.
 */

/**
 * @typedef {object} RegistryOptions
 * @property {string} [file] - The running-list file; defaults to `test/state/registry.json`.
 * @property {string} [world] - The only world that may be touched; defaults to `TEST_WORLD`.
 */

/**
 * @typedef {{ evaluate: (fn: Function, arg?: unknown) => Promise<unknown> }} EvaluatePage
 * The part of a Playwright page this module uses; unit tests pass a stand-in that runs the function in place.
 */

/**
 * Judge one recorded entry without touching the world.
 * @param {unknown} entry - The candidate entry.
 * @returns {string | null} Why the entry is refused, or null when it is well formed.
 */
export function entryProblem(entry) {
   if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return 'an entry is not an object';
   }
   /** @type {Record<string, unknown>} The entry as a plain record. */
   const fields = entry;
   if (typeof fields.documentName !== 'string' || !ALLOWED_DOCUMENT_NAMES.includes(fields.documentName)) {
      return `documentName '${String(fields.documentName).slice(0, 40)}' is not an allowed world document type`;
   }
   if (typeof fields.id !== 'string' || !ID_PATTERN.test(fields.id)) {
      return 'an entry id is not a 16-character document id';
   }
   if (fields.uuid !== `${fields.documentName}.${fields.id}`) {
      return `uuid '${String(fields.uuid).slice(0, 60)}' is not '${fields.documentName}.<id>' of its own id`;
   }
   if (typeof fields.createdBy !== 'string' || fields.createdBy.length > CREATED_BY_MAX_CHARS) {
      return 'createdBy is not a short string';
   }
   return null;
}

/**
 * Judge a parsed running list without touching the world.
 * @param {unknown} record - The parsed file content.
 * @param {string} world - The only world that may be touched.
 * @returns {string | null} Why the record is refused, or null when it is well formed.
 */
export function recordProblem(record, world) {
   if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      return 'the record is not an object';
   }
   /** @type {Record<string, unknown>} The record as a plain object. */
   const fields = record;
   if (typeof fields.pending !== 'boolean') {
      return 'pending is not a boolean';
   }
   if (fields.world !== world) {
      return `the record belongs to world '${String(fields.world).slice(0, 40)}', not '${world}'`;
   }
   if (!Array.isArray(fields.entries) || fields.entries.length > ENTRIES_MAX) {
      return `entries is not a list of at most ${ENTRIES_MAX}`;
   }
   for (const entry of fields.entries) {
      /** @type {string | null} Why this entry is refused. */
      const problem = entryProblem(entry);
      if (problem !== null) {
         return problem;
      }
   }
   return null;
}

/**
 * Read the running list.
 * @param {string} file - The running-list file.
 * @returns {unknown} The parsed record, or null when no file exists.
 * @throws {Error} When the file is not valid JSON.
 */
function readRecord(file) {
   if (!fs.existsSync(file)) {
      return null;
   }
   try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
   } catch {
      throw new Error(`e2e registry refuses a record that is not valid JSON: ${file}`);
   }
}

/**
 * Overwrite the running list.
 * @param {string} file - The running-list file.
 * @param {RegistryRecord} record - The record to write.
 * @returns {void}
 */
function writeRecord(file, record) {
   fs.mkdirSync(path.dirname(file), { recursive: true });
   fs.writeFileSync(file, JSON.stringify(record, null, 3));
}

/**
 * Read the running list and refuse a corrupt one.
 * @param {string} file - The running-list file.
 * @param {string} world - The only world that may be touched.
 * @returns {RegistryRecord | null} The validated record, or null when no file exists.
 * @throws {Error} When the record is corrupt, belongs to another world, or holds an entry the teardown must not touch.
 */
function readValidRecord(file, world) {
   /** @type {unknown} The parsed file. */
   const record = readRecord(file);
   if (record === null) {
      return null;
   }
   /** @type {string | null} Why the record is refused. */
   const problem = recordProblem(record, world);
   if (problem !== null) {
      throw new Error(`e2e registry refuses its running list (${file}): ${problem}.`);
   }
   return record;
}

/**
 * Throw unless the page is in the world the e2e suite may modify.
 * @param {EvaluatePage} page - The logged-in GM page.
 * @param {string} world - The only world that may be touched.
 * @returns {Promise<string>} The world id.
 */
export async function assertTestWorld(page, world = TEST_WORLD) {
   /** @type {string} The id of the world the page is in. */
   const actual = await page.evaluate(() => game.world.id);
   if (actual !== world) {
      throw new Error(`e2e registry refuses to run in world '${actual}'; it only runs in '${world}'.`);
   }
   return actual;
}

/**
 * Format a bounded list for a failure message.
 * @param {string[]} lines - The items.
 * @returns {string} The first items and the count of the rest.
 */
function listed(lines) {
   /** @type {string} The shown items. */
   const shown = lines.slice(0, REPORT_MAX).join('; ');
   return lines.length > REPORT_MAX ? `${shown}; and ${lines.length - REPORT_MAX} more` : shown;
}

/**
 * Record a document an e2e flow created, as soon as its id is known. The record survives a spec, a reload and a crash,
 * so the next run can tear the document down. An entry the teardown would refuse is refused here.
 * @param {EvaluatePage} page - The logged-in GM page, used for the world id.
 * @param {RegistryEntry} entry - The created document.
 * @param {RegistryOptions} [options] - The file and world.
 * @returns {Promise<void>} Resolves once the record is written.
 * @throws {Error} When the entry is malformed or the page is not in the test world.
 */
export async function recordDocument(page, entry, { file = DEFAULT_RECORD_FILE, world = TEST_WORLD } = {}) {
   /** @type {string | null} Why the entry is refused. */
   const problem = entryProblem(entry);
   if (problem !== null) {
      throw new Error(`e2e registry refuses to record a document: ${problem}.`);
   }
   await assertTestWorld(page, world);
   /** @type {unknown} The record so far. */
   const previous = readRecord(file);
   /** @type {RegistryEntry[]} Earlier entries of the same world that are still pending. */
   const kept =
      previous !== null && recordProblem(previous, world) === null && previous.pending ? previous.entries : [];
   writeRecord(file, {
      pending: true,
      world,
      entries: [
         ...kept,
         entry,
      ],
   });
}

/**
 * Check, in the page, that every recorded document is still one the teardown may delete, without deleting anything.
 * Runs in the browser: it reads only its argument and the Foundry globals.
 * @param {{ entries: RegistryEntry[], prefix: string }} input - The recorded entries and the e2e name prefix.
 * @returns {Promise<string[]>} One line per document that must not be deleted; empty when all are safe.
 */
async function inspectRecorded({ entries, prefix }) {
   /** @type {string[]} The violations found. */
   const violations = [];
   for (const entry of entries) {
      /** @type {any} The resolved document, or null when it no longer exists. */
      const document = await fromUuid(entry.uuid);
      if (!document) {
         continue;
      }
      if (document.documentName !== entry.documentName) {
         violations.push(`${entry.uuid} resolves to a ${document.documentName}, not a ${entry.documentName}`);
      } else if (document.pack) {
         violations.push(`${entry.uuid} is in a compendium`);
      } else if (document.parent) {
         violations.push(`${entry.uuid} is not a world document`);
      } else if (typeof document.name !== 'string' || !document.name.startsWith(prefix)) {
         violations.push(`${entry.uuid} is not named with the e2e prefix`);
      }
   }
   return violations;
}

/**
 * Delete the recorded documents, in the page, through `document.delete()`. Runs in the browser; every entry was
 * inspected first.
 * @param {{ entries: RegistryEntry[], order: string[] }} input - The recorded entries and the type deletion order.
 * @returns {Promise<void>} Resolves once the documents are gone.
 */
async function deleteRecorded({ entries, order }) {
   /** @type {RegistryEntry[]} The entries sorted so that each type is deleted in its place in the order. */
   const sorted = [...entries].sort((a, b) => order.indexOf(a.documentName) - order.indexOf(b.documentName));
   for (const entry of sorted) {
      /** @type {any} The resolved document, or null when it no longer exists. */
      const document = await fromUuid(entry.uuid);
      if (document) {
         await document.delete();
      }
   }
}

/**
 * Delete every recorded document through a Foundry document call, never by touching files, then mark the record as
 * restored. Every entry is validated first (document type, uuid shape, world document, e2e prefix); if any is not
 * safe, nothing is deleted, the record stays pending and the call throws.
 * @param {EvaluatePage} page - The logged-in GM page.
 * @param {RegistryOptions} [options] - The file and world.
 * @returns {Promise<void>} Resolves once the recorded documents are gone; does nothing when nothing is pending.
 * @throws {Error} When the record is corrupt, belongs to another world, or names a document that must not be deleted.
 */
export async function teardownRecorded(page, { file = DEFAULT_RECORD_FILE, world = TEST_WORLD } = {}) {
   /** @type {RegistryRecord | null} The validated running list, or null when no file exists. */
   const record = readValidRecord(file, world);
   if (record === null || !record.pending) {
      return;
   }
   await assertTestWorld(page, world);
   /** @type {string[]} The documents the teardown must not delete. */
   const violations = await page.evaluate(inspectRecorded, {
      entries: record.entries,
      prefix: E2E_PREFIX,
   });
   if (violations.length > 0) {
      throw new Error(`e2e registry refuses to delete: ${listed(violations)}. Nothing was deleted.`);
   }
   await page.evaluate(deleteRecorded, {
      entries: record.entries,
      order: [...ALLOWED_DOCUMENT_NAMES],
   });
   writeRecord(file, {
      ...record,
      pending: false,
      entries: [],
   });
}

/**
 * Find and delete, in the page, the world documents named with the e2e prefix. Runs in the browser. A candidate is
 * deleted only when it is a world document of an allowed type; anything else named with the prefix is reported as a
 * violation and left alone.
 * @param {{ prefix: string, order: string[] }} input - The e2e name prefix and the allowed types in deletion order.
 * @returns {Promise<{ swept: string[], violations: string[] }>} The documents deleted and the ones left alone.
 */
async function sweepPrefixed({ prefix, order }) {
   /** @type {string[]} The documents deleted. */
   const swept = [];
   /** @type {string[]} The documents named with the prefix that were not deleted. */
   const violations = [];
   for (const documentName of order) {
      /** @type {any} The world collection of this type, or undefined when the world has none. */
      const collection = game.collections.get(documentName);
      for (const document of [...(collection ?? [])]) {
         if (typeof document.name !== 'string' || !document.name.startsWith(prefix)) {
            continue;
         }
         if (document.documentName !== documentName || document.pack || document.parent) {
            violations.push(`${documentName} ${document.uuid}`);
            continue;
         }
         await document.delete();
         swept.push(`${documentName} ${document.name}`);
      }
   }
   return {
      swept,
      violations,
   };
}

/**
 * Sweep the world documents named with the e2e prefix that no running list recorded, deleting them through Foundry
 * document calls (`document.delete()`) with the same validation as the recorded teardown. Call it after
 * `teardownRecorded`: whatever it finds is unrecorded.
 * @param {EvaluatePage} page - The logged-in GM page.
 * @param {RegistryOptions} [options] - The world.
 * @returns {Promise<string[]>} `<DocumentName> <name>` of each unrecorded document that was deleted.
 * @throws {Error} When a document named with the prefix is not a world document of an allowed type.
 */
export async function sweepUnrecorded(page, { world = TEST_WORLD } = {}) {
   await assertTestWorld(page, world);
   /** @type {{ swept: string[], violations: string[] }} What the sweep did. */
   const outcome = await page.evaluate(sweepPrefixed, {
      prefix: E2E_PREFIX,
      order: [...ALLOWED_DOCUMENT_NAMES],
   });
   if (outcome.violations.length > 0) {
      throw new Error(`e2e sweep refuses to delete: ${listed(outcome.violations)}.`);
   }
   return outcome.swept;
}

/**
 * List, in the page, what the census counts. Runs in the browser.
 * @param {{ prefix: string, order: string[] }} input - The e2e name prefix and the world document types to scan.
 * @returns {string[]} One line per leftover.
 */
function countLeftovers({ prefix, order }) {
   /** @type {string[]} The leftovers found. */
   const found = [];
   for (const documentName of order) {
      for (const document of game.collections.get(documentName) ?? []) {
         if (typeof document.name === 'string' && document.name.startsWith(prefix)) {
            found.push(`${documentName} ${document.name}`);
         }
      }
   }
   for (const combat of game.combats ?? []) {
      found.push(`Combat ${combat.id}`);
   }
   for (const scene of game.scenes ?? []) {
      for (const token of scene.tokens ?? []) {
         if (token.actorId && !game.actors.has(token.actorId)) {
            found.push(`Token ${scene.id}.${token.id} (orphan)`);
         }
      }
   }
   return found;
}

/**
 * Count what a finished run must not leave in the test world: world documents named with the e2e prefix, every combat,
 * and every token whose actor no longer resolves. A non-empty result means a flow created something it did not record,
 * a teardown failed, or another run left combats behind.
 * @param {EvaluatePage} page - The logged-in GM page.
 * @param {RegistryOptions} [options] - The world.
 * @returns {Promise<string[]>} One line per leftover: `<DocumentName> <name>`, `Combat <id>`, `Token <scene>.<id>`.
 */
export async function censusPrefixed(page, { world = TEST_WORLD } = {}) {
   await assertTestWorld(page, world);
   return page.evaluate(countLeftovers, {
      prefix: E2E_PREFIX,
      order: [...ALLOWED_DOCUMENT_NAMES],
   });
}

/**
 * Tear down the recorded documents, sweep the unrecorded e2e documents and census the world, as the end of a run does.
 * @param {EvaluatePage} page - The logged-in GM page.
 * @param {RegistryOptions} [options] - The file and world.
 * @returns {Promise<{ swept: string[], census: string[] }>} The unrecorded documents deleted and the remaining
 * leftovers.
 */
export async function settleRegistry(page, options = {}) {
   await teardownRecorded(page, options);
   /** @type {string[]} The unrecorded documents deleted. */
   const swept = await sweepUnrecorded(page, options);
   return {
      swept,
      census: await censusPrefixed(page, options),
   };
}

/**
 * Throw when a settle found anything the running list did not record or left anything behind.
 * @param {{ swept: string[], census: string[] }} result - The outcome of `settleRegistry`.
 * @returns {void}
 * @throws {Error} Listing the unrecorded documents that were deleted and the leftovers.
 */
export function assertSettled({ swept, census }) {
   /** @type {string[]} The problems found. */
   const problems = [];
   if (swept.length > 0) {
      problems.push(`the sweep deleted ${swept.length} unrecorded e2e documents: ${listed(swept)}`);
   }
   if (census.length > 0) {
      problems.push(`the census found ${census.length} leftovers: ${listed(census)}`);
   }
   if (problems.length > 0) {
      throw new Error(`e2e registry: ${problems.join('. ')}.`);
   }
}
