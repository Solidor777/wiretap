/**
 * The four backup tools on the live world: a backup to the Backup folder setting with a valid header, a restore of
 * changed, deleted and added-to documents to their backed-up export, a dry run and a closed `allowReplace`, the
 * `allowBackupAnyFolder` gate for a named folder, no document text in any MCP message, a real recycle-bin delete, and
 * a dry run of the largest compendium pack. Every backup file lives under a scratch root in `test/tmp/`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import config from '../../playwright.config.mjs';
import { HEADER_LINE_BYTES, parseHeaderLine } from '../../shared/backup.js';
import { login } from './fixtures.js';
import { e2eLog } from './log.js';
import { firstSubtype } from './writeHelpers.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { readSidecarGateState, recordGateSettings, restoreGateSettings } from './gates.js';
import { E2E_PREFIX, assertSettled, recordDocument, settleRegistry, teardownRecorded } from './registry.js';

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {string} The text the test actor carries in a flag; no MCP message may contain it. */
const MARKER = 'WIRETAP-MARKER-7f3a';

/** @type {string} The `createdBy` value of every document this spec records. */
const CREATED_BY = 'backupTools.spec';

/** @type {number} The `timeoutMs` of the largest pack's dry run: the longest a backup call may set. */
const DRY_RUN_TIMEOUT_MS = 300_000;

/** @type {number} The MCP request wait of the largest pack's dry run: its time limit plus the sidecar's reply grace. */
const DRY_RUN_REQUEST_MS = DRY_RUN_TIMEOUT_MS + 10_000;

/** @type {number} The bytes the largest backup may hold, used to project the export time at the measured rate. */
const PROJECTED_BYTES = 64_000_000;

/** @type {number} The most bytes a `delete_backup` result may take. */
const DELETE_RESULT_MAX_BYTES = 128;

/** @type {string} The repo root, derived from this file's location. */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** @type {string} The scratch root of this run, unique per run. */
const scratch = path.join(repoRoot, 'test', 'tmp', `e2e-backups-${Date.now()}-${process.pid}-0`);

/** @type {string} The folder the Backup folder setting names during the run. */
const settingDir = path.join(scratch, 'setting');

/** @type {string} A folder that is neither the default nor the setting. */
const namedDir = path.join(scratch, 'named');

/**
 * @typedef {object} TestDocuments
 * @property {string} folderUuid - The Actor Folder.
 * @property {string} actorUuid - The Actor in the Folder.
 * @property {string[]} itemIds - The ids of the Actor's two embedded Items.
 * @property {string} journalUuid - The JournalEntry.
 */

/** @type {import('node:child_process').ChildProcess | undefined} The e2e sidecar of this spec file. */
let sidecar;

/** @type {string | undefined} The Backup folder setting's value before the run. */
let priorBackupFolder;

/**
 * Open a GM page of its own in the given browser, for the hooks that have no test page.
 * @param {import('@playwright/test').Browser} browser - The worker's browser.
 * @returns {Promise<import('@playwright/test').Page>} The logged-in page.
 */
async function gmPage(browser) {
   /** @type {import('@playwright/test').Page} The page that logs in as the GM. */
   const page = await browser.newPage({ baseURL: config.use.baseURL });
   await login(page);
   return page;
}

test.beforeAll(async ({ browser }) => {
   fs.mkdirSync(settingDir, { recursive: true });
   fs.mkdirSync(namedDir, { recursive: true });
   /** @type {import('@playwright/test').Page} The page that reads the setting. */
   const page = await gmPage(browser);
   try {
      priorBackupFolder = await page.evaluate(() => game.settings.get('wiretap', 'backupFolder'));
   } finally {
      await page.close();
   }
   sidecar = await startGateSidecar();
});

test.afterAll(async ({ browser }) => {
   try {
      await stopSidecar(sidecar);
   } finally {
      if (priorBackupFolder !== undefined) {
         /** @type {import('@playwright/test').Page} The page that restores the setting. */
         const page = await gmPage(browser);
         try {
            await page.evaluate((value) => game.settings.set('wiretap', 'backupFolder', value), priorBackupFolder);
         } finally {
            await page.close();
         }
      }
   }
});

/** @type {Client | undefined} The fake MCP client of the running test. */
let client;

/** @type {Array<{ file: string, folder?: string }>} The backup files the running test made and has not trashed. */
let made = [];

/**
 * List the tool names the MCP session offers now.
 * @returns {Promise<string[]>} Tool names in listing order.
 */
async function toolNames() {
   return (await client.listTools()).tools.map((tool) => tool.name);
}

/**
 * Call a tool and return its first text item.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @param {{ timeout?: number }} [options] - The MCP request options, such as a longer request wait.
 * @returns {Promise<{ isError: boolean, text: string }>} Whether the call failed, and its text.
 */
async function callText(name, args, options) {
   const result = await client.callTool({
      name,
      arguments: args,
   }, undefined, options);
   return {
      isError: result.isError === true,
      text: result.content[0].text,
   };
}

/**
 * Call a tool, require success and parse its JSON.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @param {{ timeout?: number }} [options] - The MCP request options.
 * @returns {Promise<any>} The parsed result.
 */
async function callJson(name, args, options) {
   const call = await callText(name, args, options);
   expect(call.isError, `${name}: ${call.text}`).toBe(false);
   return JSON.parse(call.text);
}

/**
 * Make a backup and remember its file, so the teardown moves it to the recycle bin.
 * @param {object} args - The `backup_documents` arguments.
 * @returns {Promise<any>} The parsed result.
 */
async function backup(args) {
   const result = await callJson('backup_documents', args);
   made.push({
      file: result.file,
      ...(args.folder === undefined ? {} : { folder: args.folder }),
   });
   return result;
}

/**
 * The raw UTF-8 byte length of a text.
 * @param {string} text - A tool reply's text.
 * @returns {number} Its byte length.
 */
function bytesOf(text) {
   return new TextEncoder().encode(text).length;
}

/**
 * Read the document lines of a backup file.
 * @param {string} file - The path of the backup file.
 * @returns {Array<{ uuid: string, documentName: string, data: Record<string, unknown> }>} The lines, in file order.
 */
function readLines(file) {
   return fs.readFileSync(file).subarray(HEADER_LINE_BYTES).toString('utf8').split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
}

/**
 * Copy an export without any `_stats` key at any depth: Foundry rewrites `_stats` on every write
 * (common/abstract/document.mjs, `_stats` of `_preCreate` and `_preUpdate`), so a restore cannot keep it.
 * @param {unknown} value - The export.
 * @returns {unknown} The copy.
 */
function withoutStats(value) {
   if (Array.isArray(value)) {
      return value.map((member) => withoutStats(member));
   }
   if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value)
         .filter(([key]) => key !== '_stats')
         .map(([key, member]) => [
            key,
            withoutStats(member),
         ]));
   }
   return value;
}

/**
 * Read the page's canonical export of a world document, the form a backup line holds, without `_stats`.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} uuid - The document.
 * @returns {Promise<unknown>} The live document's stored data in backup form.
 */
async function pageExport(page, uuid) {
   return withoutStats(await page.evaluate((target) => fromUuidSync(target).toCompendium(null, {
      clearSource: false,
      keepId: true,
      clearSort: false,
      clearOwnership: false,
   }), uuid));
}

/**
 * Record a world document the setup created, so the teardown removes it.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} documentName - The document class.
 * @param {string} id - The document id.
 * @returns {Promise<string>} The document uuid.
 */
async function record(page, documentName, id) {
   /** @type {string} The world document's uuid. */
   const uuid = `${documentName}.${id}`;
   await recordDocument(page, {
      documentName,
      id,
      uuid,
      createdBy: CREATED_BY,
   });
   return uuid;
}

/**
 * Create the test's Folder, the Actor in it with two Items and the marker flag, and the JournalEntry, each recorded
 * right after it is created.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<TestDocuments>} The uuids of the created documents and the Item ids.
 */
async function createDocuments(page) {
   /** @type {number} The timestamp that makes this test's names unique. */
   const stamp = Date.now();
   /** @type {string} The id of the Actor Folder the Actor sits in. */
   const folderId = await page.evaluate(async (name) => (await Folder.create({
      name,
      type: 'Actor',
   })).id, `${E2E_PREFIX}Folder ${stamp}`);
   /** @type {string} The uuid a folderUuid backup names. */
   const folderUuid = await record(page, 'Folder', folderId);
   /** @type {string} The id of the Actor that carries the marker flag. */
   const actorId = await page.evaluate(async ({ name, type, folder, marker }) => (await Actor.create({
      name,
      type,
      folder,
      flags: { world: { e2eText: marker } },
   })).id, {
      name: `${E2E_PREFIX}Actor ${stamp}`,
      type: await firstSubtype(page, 'Actor'),
      folder: folderId,
      marker: MARKER,
   });
   /** @type {string} The uuid the backups and restores name for the Actor. */
   const actorUuid = await record(page, 'Actor', actorId);
   /** @type {string} The subtype of the embedded Items. */
   const itemType = await firstSubtype(page, 'Item');
   /** @type {string[]} The embedded Item ids. */
   const itemIds = await page.evaluate(async ({ id, names, type }) => {
      /** @type {Item[]} The created Items. */
      const items = await game.actors.get(id).createEmbeddedDocuments('Item', names.map((name) => ({
         name,
         type,
      })));
      return items.map((item) => item.id);
   }, {
      id: actorId,
      names: [
         `${E2E_PREFIX}Item A ${stamp}`,
         `${E2E_PREFIX}Item B ${stamp}`,
      ],
      type: itemType,
   });
   /** @type {string} The JournalEntry id. */
   const journalId = await page.evaluate(
      async (name) => (await JournalEntry.create({ name })).id,
      `${E2E_PREFIX}Journal ${stamp}`,
   );
   /** @type {string} The JournalEntry uuid. */
   const journalUuid = await record(page, 'JournalEntry', journalId);
   return {
      folderUuid,
      actorUuid,
      itemIds,
      journalUuid,
   };
}

/**
 * Open gates on the GM page, and wait until both the page and the sidecar's snapshot hold them open; the spec's
 * afterEach restores them.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string[]} names - The gates to open.
 * @returns {Promise<void>} Resolves once every gate reads open in the page and in the sidecar.
 */
async function openGates(page, names) {
   await page.evaluate(async (gates) => {
      for (const name of gates) {
         await game.settings.set('wiretap', name, true);
      }
   }, names);
   /** @type {Record<string, boolean>} The open state every gate must reach. */
   const open = Object.fromEntries(names.map((name) => [
      name,
      true,
   ]));
   await expect.poll(() => page.evaluate((gates) => Object.fromEntries(gates.map((name) => [
      name,
      game.settings.get('wiretap', name),
   ])), names), { timeout: POLL_MS }).toEqual(open);
   await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject(open);
}

/**
 * Require gates to be closed on the GM page, which the closed-gate checks depend on.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string[]} names - The gate setting names that must read false.
 * @returns {Promise<void>} Resolves once the check passed.
 */
async function expectGatesClosed(page, names) {
   for (const name of names) {
      expect(await page.evaluate((gate) => game.settings.get('wiretap', gate), name), `${name} must start closed`)
         .toBe(false);
   }
}

test.describe('wiretap backup tools', () => {
   /** @type {TestDocuments} The documents of the running test. */
   let docs;

   test.beforeEach(async ({ page }) => {
      await login(page);
      // A run that died mid-test left its prior values and documents recorded; restore them before recording new ones.
      await restoreGateSettings(page);
      await teardownRecorded(page);
      await recordGateSettings(page);
      made = [];

      await expect
         .poll(() => page.evaluate(() => game.modules.get('wiretap').api.bridge.identified), { timeout: POLL_MS })
         .toBe(true);
      client = new Client({
         name: 'wiretap-e2e',
         version: '0.0.0',
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${E2E_MCP_PORT}/mcp`)));
      await expect
         .poll(toolNames, { timeout: POLL_MS })
         .toEqual(expect.arrayContaining([
            'backup_documents',
            'list_backups',
            'restore_backup',
            'delete_backup',
         ]));
      // Every backup of the run goes to the scratch folder the setting names, never to the sidecar's default folder.
      await page.evaluate((dir) => game.settings.set('wiretap', 'backupFolder', dir), settingDir);
      await expect.poll(async () => (await callJson('list_backups', {})).folder, { timeout: POLL_MS })
         .toBe('setting');
      docs = await createDocuments(page);
   });

   test.afterEach(async ({ page }) => {
      try {
         // A named-folder file needs `allowBackupAnyFolder`, which stays open until the gates are restored below.
         for (const entry of made) {
            await callJson('delete_backup', entry);
         }
         made = [];
      } finally {
         try {
            await client?.close();
            client = undefined;
         } finally {
            // Anything the flows created and did not record is swept and fails the test, as does any leftover.
            const settled = await settleRegistry(page);
            await restoreGateSettings(page);
            assertSettled(settled);
         }
      }
   });

   test('backs up to the Backup folder setting, lists the file, and the file holds a valid header', async ({ page }) => {
      expect(await callJson('list_backups', {})).toMatchObject({ folder: 'setting' });
      const result = await backup({ folderUuid: docs.folderUuid });
      expect(result).toEqual({
         file: result.file,
         folder: 'setting',
         documents: 2,
         bytes: result.bytes,
      });
      /** @type {string} The path of the written file. */
      const file = path.join(settingDir, result.file);
      expect(fs.existsSync(file)).toBe(true);
      /** @type {import('../../shared/backup.js').BackupHeader | null} The parsed header line. */
      const header = parseHeaderLine(fs.readFileSync(file).subarray(0, HEADER_LINE_BYTES).toString('utf8'));
      expect(header).not.toBeNull();
      expect(header.worldId).toBe(await page.evaluate(() => game.world.id));
      expect(header).toMatchObject({
         documents: 2,
         bytes: fs.statSync(file).size,
      });
      expect((await callJson('list_backups', {})).rows[0][0]).toBe(result.file);
   });

   test('restores changed, deleted and added-to documents to their backed-up export', async ({ page }) => {
      const result = await backup({
         uuids: [
            docs.actorUuid,
            docs.journalUuid,
         ],
      });
      /** @type {{ data: Record<string, unknown> }} The backup line of the Actor. */
      const actorLine = readLines(path.join(settingDir, result.file)).find((line) => line.uuid === docs.actorUuid);
      expect(await pageExport(page, docs.actorUuid)).toEqual(withoutStats(actorLine.data));

      await page.evaluate(async ({ actorUuid, itemId, journalUuid, itemName, itemType }) => {
         /** @type {Actor} The Actor the backup holds. */
         const actor = fromUuidSync(actorUuid);
         await actor.update({ name: `${actor.name} renamed` });
         await actor.items.get(itemId).delete();
         await actor.createEmbeddedDocuments('Item', [{
            name: itemName,
            type: itemType,
         }]);
         await fromUuidSync(journalUuid).delete();
      }, {
         actorUuid: docs.actorUuid,
         itemId: docs.itemIds[0],
         journalUuid: docs.journalUuid,
         itemName: `${E2E_PREFIX}Item C ${Date.now()}`,
         itemType: await firstSubtype(page, 'Item'),
      });
      expect(await page.evaluate((uuid) => fromUuidSync(uuid) === null, docs.journalUuid)).toBe(true);

      await openGates(page, [
         'allowReplace',
         'allowDelete',
         'allowOwnershipWrites',
      ]);
      expect(await callJson('restore_backup', { file: result.file })).toMatchObject({
         file: result.file,
         replaced: 1,
         created: 1,
         failed: 0,
      });
      expect(await pageExport(page, docs.actorUuid)).toEqual(withoutStats(actorLine.data));
      expect(await page.evaluate((uuid) => fromUuidSync(uuid).items.map((item) => item.id).sort(), docs.actorUuid))
         .toEqual([...docs.itemIds].sort());
      expect(await page.evaluate((uuid) => fromUuidSync(uuid)?.uuid ?? null, docs.journalUuid)).toBe(docs.journalUuid);
   });

   test('a restore dry run writes nothing, and a closed allowReplace fails the document naming the gate',
      async ({ page }) => {
         await expectGatesClosed(page, ['allowReplace']);
         const result = await backup({ uuids: [docs.actorUuid] });
         /** @type {string} The name the Actor carries after the change. */
         const renamed = await page.evaluate(async (uuid) => {
            /** @type {Actor} The Actor the backup holds. */
            const actor = fromUuidSync(uuid);
            await actor.update({ name: `${actor.name} renamed` });
            return actor.name;
         }, docs.actorUuid);
         await openGates(page, ['allowOwnershipWrites']);

         const denied = await callJson('restore_backup', { file: result.file });
         expect(denied).toMatchObject({
            replaced: 0,
            created: 0,
            failed: 1,
         });
         expect(denied.rows[0][0]).toBe(docs.actorUuid);
         expect(denied.rows[0][1]).toBe('failed');
         expect(denied.rows[0][2]).toContain('GATE_DENIED');
         expect(denied.rows[0][2]).toContain('allowReplace');
         expect(await page.evaluate((uuid) => fromUuidSync(uuid).name, docs.actorUuid)).toBe(renamed);

         await openGates(page, ['allowReplace']);
         expect(await callJson('restore_backup', {
            file: result.file,
            dryRun: true,
         })).toMatchObject({
            replaced: 1,
            created: 0,
            failed: 0,
            dryRun: true,
         });
         expect(await page.evaluate((uuid) => fromUuidSync(uuid).name, docs.actorUuid)).toBe(renamed);
      });

   test('a folder argument outside the default and the setting needs allowBackupAnyFolder', async ({ page }) => {
      await expectGatesClosed(page, ['allowBackupAnyFolder']);
      const denied = await callText('backup_documents', {
         uuids: [docs.actorUuid],
         folder: namedDir,
      });
      expect(denied.isError, denied.text).toBe(true);
      expect(denied.text).toContain('GATE_DENIED');
      expect(denied.text).toContain('allowBackupAnyFolder');
      expect(fs.readdirSync(namedDir)).toEqual([]);

      await openGates(page, ['allowBackupAnyFolder']);
      const result = await backup({
         uuids: [docs.actorUuid],
         folder: namedDir,
      });
      expect(result).toMatchObject({
         folder: 'named',
         documents: 1,
      });
      expect(fs.existsSync(path.join(namedDir, result.file))).toBe(true);
   });

   test('no document text appears in any MCP message of a backup or restore', async ({ page }) => {
      /** @type {import('@modelcontextprotocol/sdk/shared/transport.js').Transport} The SDK client's transport. */
      const transport = client.transport;
      /** @type {Function} The SDK's own message handler. */
      const original = transport.onmessage;
      /** @type {string[]} Every message the client received, as JSON. */
      const received = [];
      transport.onmessage = (message, extra) => {
         received.push(JSON.stringify(message));
         original(message, extra);
      };

      const result = await backup({
         uuids: [
            docs.actorUuid,
            docs.journalUuid,
         ],
      });
      expect(fs.readFileSync(path.join(settingDir, result.file), 'utf8')).toContain(MARKER);
      expect(await callJson('list_backups', {})).toMatchObject({ folder: 'setting' });
      await openGates(page, [
         'allowReplace',
         'allowOwnershipWrites',
      ]);
      expect(await callJson('restore_backup', { file: result.file })).toMatchObject({
         replaced: 2,
         failed: 0,
      });
      expect(await callJson('delete_backup', { file: result.file })).toEqual({
         file: result.file,
         trashed: true,
      });
      made = [];

      /** @type {string[]} The received tool results. */
      const results = received.filter((message) => message.includes('"result"'));
      expect(results.length).toBeGreaterThanOrEqual(4);
      expect(received.filter((message) => message.includes(MARKER))).toEqual([]);
   });

   test('delete_backup moves the file to the recycle bin, and a second delete is BACKUP_NOT_FOUND', async () => {
      const result = await backup({ uuids: [docs.actorUuid] });
      /** @type {string} The path of the written file. */
      const file = path.join(settingDir, result.file);
      expect(fs.existsSync(file)).toBe(true);

      const deleted = await callText('delete_backup', { file: result.file });
      expect(deleted.isError, deleted.text).toBe(false);
      made = [];
      expect(JSON.parse(deleted.text)).toEqual({
         file: result.file,
         trashed: true,
      });
      expect(bytesOf(deleted.text)).toBeLessThanOrEqual(DELETE_RESULT_MAX_BYTES);
      expect(fs.existsSync(file)).toBe(false);

      const again = await callText('delete_backup', { file: result.file });
      expect(again.isError, again.text).toBe(true);
      expect(again.text).toContain('BACKUP_NOT_FOUND');
   });

   test('a dry run of the largest pack reports its documents and bytes', async ({ page }) => {
      test.setTimeout(DRY_RUN_REQUEST_MS + 60_000);
      /** @type {{ id: string, entries: number } | null} The pack with the most index entries. */
      const largest = await page.evaluate(() => {
         /** @type {{ id: string, entries: number } | null} The largest pack so far. */
         let best = null;
         for (const pack of game.packs) {
            if (best === null || pack.index.size > best.entries) {
               best = {
                  id: pack.collection,
                  entries: pack.index.size,
               };
            }
         }
         return best;
      });
      expect(largest, 'the world must have a compendium pack').not.toBeNull();
      /** @type {number} The clock before the call. */
      const start = performance.now();
      const result = await callJson('backup_documents', {
         pack: largest.id,
         dryRun: true,
         timeoutMs: DRY_RUN_TIMEOUT_MS,
      }, { timeout: DRY_RUN_REQUEST_MS });
      /** @type {number} The call's duration in milliseconds. */
      const elapsed = performance.now() - start;
      expect(result).toMatchObject({
         dryRun: true,
         folder: 'setting',
      });
      expect(result.documents).toBeGreaterThan(0);
      expect(result.bytes).toBeGreaterThan(HEADER_LINE_BYTES);
      /** @type {number} The time 64,000,000 bytes would take at the measured rate, in milliseconds. */
      const projected = (PROJECTED_BYTES / result.bytes) * elapsed;
      /** @type {string} The measurement, as the annotation and the log line show it. */
      const description = `${largest.id}: ${largest.entries} index entries, ${result.documents} documents, `
         + `${result.bytes} bytes, ${elapsed.toFixed(0)} ms; ${PROJECTED_BYTES} bytes at this rate: `
         + `${projected.toFixed(0)} ms`;
      test.info().annotations.push({
         type: 'largest pack dry run',
         description,
      });
      e2eLog(`largest pack dry run: ${description}`);
   });
});
