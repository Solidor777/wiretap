import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { recordGateSettings, restoreGateSettings } from './gates.js';
import { E2E_PREFIX, assertSettled, recordDocument, settleRegistry, teardownRecorded } from './registry.js';

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {number} The search page budget, in UTF-8 bytes. */
const PAGE_MAX = 4000;

/** @type {number} The describe_schema budget, in UTF-8 bytes. */
const SCHEMA_MAX = 8000;

/** @type {import('node:child_process').ChildProcess | undefined} The e2e sidecar of this spec file. */
let sidecar;
test.beforeAll(async () => {
   sidecar = await startGateSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});

/** @type {Client | undefined} The fake MCP client of the running test. */
let client;

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
 * @returns {Promise<{ isError: boolean, text: string, bytes: number }>} Whether the call failed, its text and size.
 */
async function callText(name, args) {
   const result = await client.callTool({
      name,
      arguments: args,
   });
   const text = result.content[0].text;
   return {
      isError: result.isError === true,
      text,
      bytes: new TextEncoder().encode(text).length,
   };
}

/**
 * Call a tool, require success and parse its JSON.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @param {number} [max] - The size the text must not exceed, in bytes.
 * @returns {Promise<any>} The parsed result.
 */
async function callJson(name, args, max = Infinity) {
   const call = await callText(name, args);
   expect(call.isError, `${name} ${JSON.stringify(args)}: ${call.text}`).toBe(false);
   expect(call.bytes, `${name} ${JSON.stringify(args)}`).toBeLessThanOrEqual(max);
   return JSON.parse(call.text);
}

/**
 * Create an Actor through the create_actor tool and record it for teardown.
 * @param {import('@playwright/test').Page} page - The Foundry page.
 * @param {string} name - The full name, starting with the e2e prefix.
 * @returns {Promise<string>} The actor uuid.
 */
async function createRecordedActor(page, name) {
   const reply = await callJson('create_actor', { name });
   await recordDocument(page, {
      documentName: 'Actor',
      id: reply.uuid.split('.').pop(),
      uuid: reply.uuid,
      createdBy: 'searchSchema.spec',
   });
   return reply.uuid;
}

test.describe('wiretap search_documents and describe_schema', () => {
   test.beforeEach(async ({ page }) => {
      await login(page);
      await restoreGateSettings(page);
      await teardownRecorded(page);
      await recordGateSettings(page);
      await expect
         .poll(() => page.evaluate(() => game.modules.get('wiretap').api.bridge.identified), { timeout: POLL_MS })
         .toBe(true);
      client = new Client({
         name: 'wiretap-e2e',
         version: '0.0.0',
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${E2E_MCP_PORT}/mcp`)));
      await expect.poll(toolNames, { timeout: POLL_MS }).toEqual(
         expect.arrayContaining([
            'create_actor',
            'describe_schema',
            'search_documents',
         ]),
      );
   });

   test.afterEach(async ({ page }) => {
      await client?.close();
      client = undefined;
      const settled = await settleRegistry(page);
      await restoreGateSettings(page);
      assertSettled(settled);
   });

   test('lists actors and items, finds created actors by prefix and pages with a small limit', async ({ page }) => {
      const stamp = Date.now();
      const created = [];
      for (const suffix of [
         'a',
         'b',
         'c',
         'd',
         'e',
      ]) {
         created.push(await createRecordedActor(page, `${E2E_PREFIX}Search ${stamp} ${suffix}`));
      }
      // Every actor and item of the world is listed, in name order, with the world's own counts.
      const counts = await page.evaluate(() => ({
         actors: game.actors.size,
         items: game.items.size,
      }));
      const actors = await callJson('search_documents', { documentName: 'Actor' }, PAGE_MAX);
      expect(actors.total).toBe(counts.actors);
      expect(actors.rows.length).toBeLessThanOrEqual(20);
      expect((await callJson('search_documents', { documentName: 'Item' }, PAGE_MAX)).total).toBe(counts.items);

      // The name prefix finds the five created actors; a page of 2 follows the cursor to the end.
      const prefix = `${E2E_PREFIX}Search ${stamp}`;
      const seen = [];
      let cursor;
      let pages = 0;
      do {
         const page_ = await callJson(
            'search_documents',
            {
               documentName: 'Actor',
               query: prefix,
               limit: 2,
               ...(cursor === undefined ? {} : { cursor }),
            },
            PAGE_MAX,
         );
         // The total counts the matches from the cursor onward: 5, then 3, then 1.
         expect(page_.total).toBe(5 - pages * 2);
         seen.push(...page_.rows.map((row) => row[0]));
         cursor = page_.nextCursor;
         pages += 1;
      } while (cursor !== undefined && pages < 10);
      expect(pages).toBe(3);
      expect(seen).toEqual(created);

      // A field filter and the added fields: the exact name finds one actor and returns its value.
      const exact = await callJson('search_documents', {
         documentName: 'Actor',
         filters: [`name=${prefix} c`],
         fields: ['name'],
      });
      expect(exact.rows).toHaveLength(1);
      expect(exact.rows[0][0]).toBe(created[2]);
      expect(exact.rows[0][3]).toEqual({ name: `${prefix} c` });

      // An embedded search through the parent.
      const parent = await page.evaluate(() => game.actors.find((actor) => actor.items.size > 0)?.uuid ?? null);
      expect(parent).not.toBeNull();
      const embedded = await callJson('search_documents', {
         documentName: 'Item',
         parentUuid: parent,
      });
      expect(embedded.total).toBeGreaterThan(0);
   });

   test('never lists or matches a wiretap setting and refuses a User password filter', async ({ page }) => {
      // The test creates its own wiretap Setting document by writing a gate; the beforeEach record restores it.
      await page.evaluate(() => game.settings.set('wiretap', 'allowUserWrites', true));
      const expected = await page.evaluate(() => ({
         wiretap: game.settings.storage.get('world').filter((setting) => setting.key.startsWith('wiretap.')).length,
         others: game.settings.storage.get('world').filter((setting) => !setting.key.startsWith('wiretap.')).length,
      }));
      expect(expected.wiretap).toBeGreaterThan(0);
      const settings = await callJson('search_documents', {
         documentName: 'Setting',
         limit: 100,
      });
      expect(settings.total).toBe(expected.others);
      expect(JSON.stringify(settings).toLowerCase()).not.toContain('wiretap');
      const byName = await callJson('search_documents', {
         documentName: 'Setting',
         query: 'wiretap',
      });
      expect(byName).toEqual({
         rows: [],
         total: 0,
      });
      const present = await callJson('search_documents', {
         documentName: 'Setting',
         filters: ['key=wiretap.allowUserWrites'],
      });
      const absent = await callJson('search_documents', {
         documentName: 'Setting',
         filters: ['key=wiretap.doesNotExist'],
      });
      expect(present).toEqual(absent);

      const users = await callJson('search_documents', {
         documentName: 'User',
         fields: ['role'],
      });
      expect(users.total).toBeGreaterThan(1);
      expect(typeof users.rows[0][3].role).toBe('number');
      for (const args of [
         { filters: ['password='] },
         { filters: ['passwordSalt=x'] },
         { fields: ['password'] },
      ]) {
         const call = await callText('search_documents', {
            documentName: 'User',
            ...args,
         });
         expect(call.isError).toBe(true);
         expect(call.text).toContain('PATH_EXCLUDED');
      }
   });

   test('describe_schema shows no User password field and nothing of the wiretap settings', async ({ page }) => {
      // The exclusion is only shown if the client schema really declares the fields it must not describe.
      const declared = await page.evaluate(() => Object.keys(CONFIG.User.documentClass.schema.fields));
      expect(declared).toContain('password');
      const user = await callJson('describe_schema', { documentName: 'User' }, SCHEMA_MAX);
      expect(JSON.stringify(user)).not.toMatch(/password/i);
      expect(user.outline.map((entry) => entry[0])).toContain('role');
      for (const path of [
         'password',
         'passwordSalt',
      ]) {
         const refused = await callText('describe_schema', {
            documentName: 'User',
            path,
         });
         expect(refused.isError, path).toBe(true);
         expect(refused.text, path).toContain('PATH_EXCLUDED');
      }
      const role = await callJson(
         'describe_schema',
         {
            documentName: 'User',
            path: 'role',
         },
         SCHEMA_MAX,
      );
      expect(role.schema.class).toBe('NumberField');
      const setting = await callJson('describe_schema', { documentName: 'Setting' }, SCHEMA_MAX);
      expect(JSON.stringify(setting).toLowerCase()).not.toContain('wiretap');
      expect(setting.outline.map((entry) => entry[0])).toEqual(expect.arrayContaining([
         'key',
         'value',
      ]));
   });

   test('searches a compendium through its index without loading its documents', async ({ page }) => {
      const pack = await page.evaluate(() => {
         const found = game.packs.find((candidate) => candidate.documentName === 'Item' && candidate.index.size > 1);
         return found === undefined
            ? null
            : {
                 id: found.collection,
                 size: found.index.size,
                 loaded: found.contents.length,
              };
      });
      expect(pack).not.toBeNull();
      const all = await callJson(
         'search_documents',
         {
            documentName: 'Item',
            pack: pack.id,
            limit: 100,
         },
         PAGE_MAX,
      );
      expect(all.total).toBe(pack.size);
      expect(all.rows[0][0]).toMatch(/^Compendium\./);
      const filtered = await callJson('search_documents', {
         documentName: 'Item',
         pack: pack.id,
         filters: [`type=${all.rows[0][2]}`],
         fields: ['type'],
      });
      expect(filtered.total).toBeGreaterThan(0);
      expect(filtered.rows.every((row) => row[3].type === all.rows[0][2])).toBe(true);
      expect(await page.evaluate((id) => game.packs.get(id).contents.length, pack.id)).toBe(pack.loaded);
   });

   test('describes every document class and subtype within 8,000 bytes and path examples with constraints', async ({
      page,
   }) => {
      const listing = await callJson('list_document_types', {});
      const classes = await page.evaluate(() => [...CONST.ALL_DOCUMENT_TYPES]);
      const all = [];
      for (const documentName of classes) {
         const subtypes = listing.subtypes[documentName] ?? [];
         const variants = [
            undefined,
            ...subtypes,
         ];
         for (const subtype of variants) {
            const args = subtype === undefined ? { documentName } : {
               documentName,
               subtype,
            };
            const call = await callText('describe_schema', args);
            expect(call.isError, `${documentName}.${subtype}: ${call.text}`).toBe(false);
            expect(call.bytes, `${documentName}.${subtype}`).toBeLessThanOrEqual(SCHEMA_MAX);
            const result = JSON.parse(call.text);
            expect(result.outline.length, `${documentName}.${subtype}`).toBeGreaterThan(0);
            all.push({
               documentName,
               subtype,
               bytes: call.bytes,
               text: call.text,
               example: result.example,
            });
         }
      }
      expect(all.length).toBeGreaterThan(classes.length);
      // Nothing in any description carries a password field, and the Setting description has no wiretap content.
      const users = all.filter((entry) => entry.documentName === 'User');
      expect(users.every((entry) => !/password/i.test(entry.text))).toBe(true);
      const settings = all.filter((entry) => entry.documentName === 'Setting');
      expect(settings.every((entry) => !/wiretap/i.test(entry.text))).toBe(true);
      // Blank examples exist for the main classes; the failures are only classes that need a parent or more data.
      const missing = all.filter((entry) => entry.example === null).map((entry) => entry.documentName);
      for (const documentName of [
         'Actor',
         'Item',
         'Scene',
         'Folder',
         'Setting',
         'User',
      ]) {
         expect(missing, `${documentName} has a blank example`).not.toContain(documentName);
      }
      test.info().annotations.push({
         type: 'describe_schema',
         description: JSON.stringify({
            calls: all.length,
            largest: Math.max(...all.map((entry) => entry.bytes)),
            noBlankExample: [...new Set(missing)],
         }),
      });

      const attribute = await callJson('describe_schema', {
         documentName: 'Actor',
         subtype: 'player',
         path: 'system.attribute',
      }, SCHEMA_MAX);
      expect(attribute.example.body.baseValue).toEqual(expect.any(Number));
      expect(attribute.schema.class).toBe('SchemaField');
      expect(attribute.schema.fields.body.fields.baseValue.class).toBe('NumberField');
      const stamina = await callJson('describe_schema', {
         documentName: 'Actor',
         subtype: 'player',
         path: 'system.resource.stamina.value',
      }, SCHEMA_MAX);
      expect(stamina.schema.class).toBe('NumberField');
      const embedded = await callText('describe_schema', {
         documentName: 'Actor',
         subtype: 'player',
         path: 'items.0',
      });
      expect(embedded.isError).toBe(true);
      expect(embedded.text).toContain('PATH_EMBEDDED');
      const password = await callText('describe_schema', {
         documentName: 'User',
         path: 'password',
      });
      expect(password.isError).toBe(true);
      expect(password.text).toContain('PATH_EXCLUDED');
   });
});
