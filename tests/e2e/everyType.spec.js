import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { e2eLog } from './log.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { recordGateSettings, restoreGateSettings } from './gates.js';
import {
   E2E_PREFIX,
   E2E_SETTING_KEY_PREFIX,
   assertSettled,
   recordDocument,
   settleRegistry,
   teardownRecorded,
} from './registry.js';

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {number} The compact view budget, in UTF-8 bytes. */
const COMPACT_MAX = 2000;

/** @type {number} The list_document_types budget, in UTF-8 bytes. */
const LISTING_MAX = 3000;

/**
 * Document classes that no flow creates, and the reason, by class. Each reason is a property of Foundry or of the
 * registry, not a gap of the test. Every other class is created at least once, and every other subtype once per
 * subtype; a document Foundry refuses to create fails the spec.
 * @type {Readonly<Record<string, string>>}
 */
const CLASS_NOT_CREATED = Object.freeze({
   Adventure: 'exists only inside a compendium pack; a world has no Adventure collection',
   FogExploration:
      'has no name-like field to carry the e2e prefix, so the registry could not tell a test document from a real one',
});

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
   /** @type {string} The text of the first result item. */
   const text = result.content[0].text;
   return {
      isError: result.isError === true,
      text,
      bytes: new TextEncoder().encode(text).length,
   };
}

/**
 * Create one document in the page: a world document, or an embedded document under a parent.
 * @param {{ documentName: string, data: object, parentUuid?: string }} input - What to create.
 * @returns {Promise<{ uuid?: string, error?: string }>} The new uuid, or the refusal text.
 */
async function createInPage({ documentName, data, parentUuid }) {
   try {
      if (parentUuid !== undefined) {
         /** @type {any} The parent document. */
         const parent = await fromUuid(parentUuid);
         const [created] = await parent.createEmbeddedDocuments(documentName, [data]);
         return { uuid: created.uuid };
      }
      const created = await CONFIG[documentName].documentClass.create(data);
      return { uuid: created.uuid };
   } catch (error) {
      return { error: String(error?.message ?? error).slice(0, 160) };
   }
}

/**
 * What one creation attempt produced.
 * @typedef {object} Attempt
 * @property {string} key - `<DocumentName>.<subtype>`; the subtype is empty for a class without subtypes.
 * @property {string} documentName - The document class.
 * @property {string | undefined} uuid - The uuid when the document was created.
 * @property {string | undefined} error - The refusal when it was not.
 */

/** @type {Attempt[]} Every creation attempt of the running test. */
let attempts;

/**
 * Create a document and remember the attempt; a world document is recorded for teardown as soon as it exists.
 * @param {import('@playwright/test').Page} page - The Foundry page.
 * @param {string} documentName - The document class.
 * @param {string | undefined} subtype - The subtype, or undefined for a class without subtypes.
 * @param {object} data - The creation data.
 * @param {string} [parentUuid] - The parent of an embedded document.
 * @returns {Promise<Attempt>} The outcome of the creation, with the uuid or the refusal.
 */
async function attempt(page, documentName, subtype, data, parentUuid) {
   /** @type {{ uuid?: string, error?: string }} The outcome in the page. */
   const outcome = await page.evaluate(createInPage, {
      documentName,
      data,
      parentUuid,
   });
   /** @type {Attempt} The attempt. */
   const result = {
      key: `${documentName}.${subtype ?? ''}`,
      documentName,
      uuid: outcome.uuid,
      error: outcome.error,
   };
   if (outcome.uuid !== undefined && parentUuid === undefined) {
      await recordDocument(page, {
         documentName,
         id: outcome.uuid.split('.').pop(),
         uuid: outcome.uuid,
         createdBy: 'everyType.spec',
      });
   }
   attempts.push(result);
   return result;
}

/**
 * The subtypes of a class in the world, without the base type; a class without subtypes has one undefined entry.
 * @param {Record<string, string[]>} types - The `game.documentTypes` of the page.
 * @param {string} documentName - The document class.
 * @returns {Array<string | undefined>} The subtypes to create.
 */
function subtypesOf(types, documentName) {
   /** @type {string[]} The declared subtypes without the base type. */
   const declared = (types[documentName] ?? []).filter((type) => type !== 'base');
   return declared.length === 0 ? [undefined] : declared;
}

test.describe('wiretap reads every document class and subtype', () => {
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
            'get_document',
            'list_document_types',
         ]),
      );
      attempts = [];
   });

   test.afterEach(async ({ page }) => {
      await client?.close();
      client = undefined;
      const settled = await settleRegistry(page);
      await restoreGateSettings(page);
      assertSettled(settled);
   });

   test('creates every class and subtype that can be created blank and reads each in 2,000 bytes or less', async ({
      page,
   }) => {
      test.setTimeout(240_000);
      // A Folder type is skipped when the collection Foundry's folder handler reads for it is missing. The handler
      // reads `game.packs` for `Compendium` and `game.collections.get(type)` for any other type, and a folder of a
      // type without one cannot be deleted afterwards (MEASURED on titan: ActiveEffect and Adventure).
      /** @type {WorldInfo} What the world declares. */
      const world = await page.evaluate(() => ({
         all: [...CONST.ALL_DOCUMENT_TYPES],
         types: Object.fromEntries(Object.entries(game.documentTypes).map(([name, list]) => [
            name,
            [...list],
         ])),
         roleNone: CONST.USER_ROLES.NONE,
         foldersWithoutCollection: (game.documentTypes.Folder ?? []).filter(
            (type) => (type === 'Compendium' ? game.packs : game.collections.get(type)) === undefined,
         ),
      }));
      /** @type {Set<string>} The `<DocumentName>.<subtype>` keys not attempted because they cannot be deleted. */
      const notAttempted = new Set(world.foldersWithoutCollection.map((type) => `Folder.${type}`));
      /** @type {number} The time the documents of this run are stamped with. */
      const stamp = Date.now();
      /**
       * Build the e2e name of a document.
       * @param {string} documentName - The document class.
       * @param {string | undefined} subtype - The subtype, or undefined for a class without subtypes.
       * @returns {string} A name that starts with the e2e prefix.
       */
      const label = (documentName, subtype) => `${E2E_PREFIX}${documentName} ${subtype ?? 'base'} ${stamp}`;
      /** @type {Record<string, Attempt[]>} The documents created by class, parents first. */
      const created = {};
      /**
       * Create one document per subtype of a class (or one for a class without subtypes) from a data builder.
       * @param {string} documentName - The document class.
       * @param {(subtype: string | undefined) => object} data - Builds the creation data of a subtype.
       * @param {string} [parentUuid] - The parent of an embedded document.
       * @returns {Promise<void>} Resolves when every subtype was attempted.
       */
      const createAll = async (documentName, data, parentUuid) => {
         created[documentName] ??= [];
         for (const subtype of subtypesOf(world.types, documentName)) {
            if (notAttempted.has(`${documentName}.${subtype ?? ''}`)) {
               continue;
            }
            created[documentName].push(
               await attempt(
                  page,
                  documentName,
                  subtype,
                  {
                     ...data(subtype),
                     ...(subtype === undefined ? {} : { type: subtype }),
                  },
                  parentUuid,
               ),
            );
         }
      };
      /**
       * The uuid of the first document of a class that was created.
       * @param {string} documentName - The document class.
       * @returns {string} The uuid.
       */
      const first = (documentName) => {
         const found = created[documentName]?.find((entry) => entry.uuid !== undefined);
         expect(found, `a ${documentName} exists to hold embedded documents`).toBeDefined();
         return found.uuid;
      };
      /**
       * A creation-data builder that names a document.
       * @param {string} documentName - The document class.
       * @param {object} [extra] - More fields.
       * @returns {(subtype: string | undefined) => object} The builder.
       */
      const named =
         (documentName, extra = {}) =>
         (subtype) => ({
            name: label(documentName, subtype),
            ...extra,
         });

      // World documents, recorded as they are created.
      for (const documentName of [
         'Actor',
         'Item',
         'Cards',
         'Macro',
         'Folder',
         'JournalEntry',
         'RollTable',
         'Playlist',
         'Scene',
         'Combat',
      ]) {
         await createAll(documentName, named(documentName));
      }
      await createAll('ChatMessage', (subtype) => ({
         flavor: label('ChatMessage', subtype),
         content: '',
      }));
      await createAll('Setting', () => ({
         key: `${E2E_SETTING_KEY_PREFIX}every`,
         value: JSON.stringify('MOCK_VALUE'),
      }));
      await createAll('User', (subtype) => ({
         name: label('User', subtype),
         role: world.roleNone,
      }));

      // Embedded documents, created under the world documents above and removed with them.
      const actor = first('Actor');
      const actorId = actor.split('.').pop();
      await createAll('Item', named('Item'), actor);
      await createAll('ActiveEffect', named('ActiveEffect'), actor);
      const entry = first('JournalEntry');
      await createAll('JournalEntryPage', named('JournalEntryPage'), entry);
      await createAll('JournalEntryCategory', named('JournalEntryCategory'), entry);
      await createAll('PlaylistSound', named('PlaylistSound'), first('Playlist'));
      // A result without a range is silently not created, so each subtype gets its own one-number range.
      await createAll(
         'TableResult',
         (subtype) => {
            const point = subtype === 'text' ? 1 : 2;
            return {
               name: label('TableResult', subtype),
               description: 'MOCK_RESULT',
               range: [
                  point,
                  point,
               ],
            };
         },
         first('RollTable'),
      );
      await createAll('Card', named('Card'), first('Cards'));
      const combat = first('Combat');
      await createAll('Combatant', () => ({ actorId }), combat);
      await createAll('CombatantGroup', named('CombatantGroup'), combat);
      const scene = first('Scene');
      await createAll(
         'AmbientLight',
         () => ({
            x: 100,
            y: 100,
         }),
         scene,
      );
      await createAll(
         'AmbientSound',
         () => ({
            x: 100,
            y: 100,
            radius: 10,
         }),
         scene,
      );
      await createAll(
         'Drawing',
         () => ({
            shape: {
               type: 'r',
               width: 100,
               height: 100,
            },
         }),
         scene,
      );
      await createAll(
         'Note',
         () => ({
            x: 100,
            y: 100,
         }),
         scene,
      );
      await createAll(
         'Region',
         named('Region', {
            shapes: [
               {
                  type: 'rectangle',
                  x: 0,
                  y: 0,
                  width: 100,
                  height: 100,
               },
            ],
         }),
         scene,
      );
      await createAll('Level', named('Level'), scene);
      await createAll(
         'Tile',
         () => ({
            x: 100,
            y: 100,
            width: 100,
            height: 100,
         }),
         scene,
      );
      await createAll(
         'Token',
         named('Token', {
            actorId,
            x: 100,
            y: 100,
         }),
         scene,
      );
      await createAll(
         'Wall',
         () => ({
            c: [
               0,
               0,
               100,
               0,
            ],
         }),
         scene,
      );
      if (created.Region?.[0]?.uuid !== undefined) {
         await createAll('RegionBehavior', named('RegionBehavior'), created.Region[0].uuid);
      }
      // An unlinked token holds its actor changes in an ActorDelta, which exists only inside the token.
      const tokenUuid = created.Token?.[0]?.uuid;
      if (tokenUuid !== undefined) {
         const deltaUuid = await page.evaluate(async (uuid) => (await fromUuid(uuid))?.delta?.uuid ?? null, tokenUuid);
         attempts.push({
            key: 'ActorDelta.',
            documentName: 'ActorDelta',
            uuid: deltaUuid ?? undefined,
            error: deltaUuid === null ? 'the token has no delta' : undefined,
         });
      }

      // Every attempt produced a document; the documents that are not attempted are listed with their reason above.
      /** @type {Attempt[]} The attempts Foundry refused. */
      const refused = attempts.filter((item) => item.uuid === undefined);
      /** @type {Set<string>} The classes with at least one attempt. */
      const createdClasses = new Set(attempts.map((item) => item.documentName));
      /** @type {string} The summary of the creation phase. */
      const summary =
         `${attempts.length - refused.length} documents created across ${createdClasses.size} of ` +
         `${world.all.length} classes; ${Object.keys(CLASS_NOT_CREATED).length} classes never created ` +
         `(${Object.keys(CLASS_NOT_CREATED).join(', ')}); ${notAttempted.size} subtypes not attempted ` +
         `(${[...notAttempted].join(', ')}); ${refused.length} refused by Foundry`;
      e2eLog(`everyType: ${summary}`);
      test.info().annotations.push({
         type: 'everyType',
         description: summary,
      });
      expect(refused.map((item) => [
         item.key,
         item.error,
      ])).toEqual([]);
      expect([...createdClasses].sort()).toEqual(world.all.filter((name) => CLASS_NOT_CREATED[name] === undefined));

      // Every class is created at least once or listed with a reason; every subtype likewise.
      /** @type {Set<string>} The keys of the documents that were created. */
      const createdKeys = new Set(attempts.filter((item) => item.uuid !== undefined).map((item) => item.key));
      /** @type {Set<string>} The keys that were created or are listed with a reason. */
      const accounted = new Set([
         ...createdKeys,
         ...notAttempted,
         ...Object.keys(CLASS_NOT_CREATED).map((name) => `${name}.`),
      ]);
      for (const documentName of world.all) {
         for (const subtype of subtypesOf(world.types, documentName)) {
            expect(accounted.has(`${documentName}.${subtype ?? ''}`), `${documentName} ${subtype ?? ''}`).toBe(true);
         }
      }

      // list_document_types agrees with the world's own constants and names every created subtype.
      /** @type {{ isError: boolean, text: string, bytes: number }} The listing call. */
      const listing = await callText('list_document_types', {});
      expect(listing.isError, listing.text).toBe(false);
      expect(listing.bytes).toBeLessThanOrEqual(LISTING_MAX);
      /** @type {ListedTypes} The parsed listing. */
      const types = JSON.parse(listing.text);
      // A class that is both a world collection and embedded (Item) is listed under both.
      expect([...new Set([
         ...types.world,
         ...types.embedded,
         ...(types.packOnly ?? []),
      ])].sort()).toEqual(world.all);
      for (const item of attempts.filter((candidate) => candidate.uuid !== undefined)) {
         const [documentName, subtype] = item.key.split('.');
         if (subtype !== '') {
            expect(types.subtypes[documentName], item.key).toContain(subtype);
         }
      }

      // Each created document reads in the compact view within 2,000 bytes.
      /** @type {number} The largest compact view, in bytes. */
      let largest = 0;
      for (const item of attempts.filter((candidate) => candidate.uuid !== undefined)) {
         const call = await callText('get_document', { uuid: item.uuid });
         expect(call.isError, `${item.key}: ${call.text}`).toBe(false);
         expect(call.bytes, item.key).toBeLessThanOrEqual(COMPACT_MAX);
         expect(JSON.parse(call.text).uuid, item.key).toBe(item.uuid);
         largest = Math.max(largest, call.bytes);
         if (item.documentName === 'User') {
            expect(call.text).not.toMatch(/password/i);
         }
      }
      e2eLog(`everyType: largest compact view ${largest} bytes`);
      test.info().annotations.push({
         type: 'everyType-largest-compact-bytes',
         description: String(largest),
      });
   });
});
