import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getBudget } from '$shared/budgets.js';
import { compileSchema } from '$shared/schemaValidate.js';
import { definitionBytes, validateScriptDefinition } from '$shared/scripts.js';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import { searchDocumentsDefinition } from '~/bridge/scripts/definitions.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import { searchDocuments } from '~/bridge/scripts/search.js';
import { searchDocumentsHandler } from '~/bridge/scripts/searchDocuments.js';
import { installWorld, mockDocument, removeWorld } from './mockDocuments.js';

/** @type {TextEncoder} Measures serialized sizes in UTF-8 bytes. */
const ENCODER = new TextEncoder();

/** @type {(params: unknown) => Promise<any>} The callTool handler over a registry of the shipped scripts. */
let callTool;

/**
 * Call search_documents.
 * @param {Record<string, unknown>} args - The arguments.
 * @returns {Promise<any>} The result.
 */
function search(args) {
   return callTool({
      name: 'search_documents',
      arguments: args,
   });
}

/**
 * Build mocked actors named `MOCK_Actor_<index>`.
 * @param {number} count - How many actors.
 * @param {(index: number) => Partial<import('./mockDocuments.js').MockDocumentOptions>} [extra] - Per-actor fields.
 * @returns {import('./mockDocuments.js').MockDocument[]} Actors named in ascending order.
 */
function actors(count, extra = () => ({})) {
   return Array.from({ length: count }, (_, index) =>
      mockDocument(
         {
            documentName: 'Actor',
            id: `MOCKACTOR${String(index).padStart(7, '0')}`,
            name: `MOCK_Actor_${String(index).padStart(3, '0')}`,
            type: index % 2 === 0 ? 'player' : 'npc',
            source: {
               system: {
                  rarity: index % 3 === 0 ? 'common' : 'rare',
                  level: index,
                  nested: { flag: index % 5 === 0 },
                  notes: 'N'.repeat(300),
               },
            },
            ...extra(index),
         },
         vi.fn,
      ),
   );
}

beforeEach(() => {
   const registry = createScriptRegistry({ log: () => {} });
   registerShippedScripts(registry);
   callTool = createCallTool({ registry });
});

afterEach(() => {
   removeWorld();
   delete globalThis.lastIndexFields;
});

describe('search_documents definition', () => {
   it('is a read-only api script within every definition budget', () => {
      const outcome = validateScriptDefinition(searchDocumentsDefinition, 'shipped');
      expect(outcome.ok).toBe(true);
      expect(outcome.warnings).toEqual([]);
      expect(searchDocumentsDefinition.mutates).toBe(false);
      expect(searchDocumentsDefinition.requires).toBe('api');
      expect(searchDocumentsDefinition.gate).toBeUndefined();
      expect(searchDocumentsDefinition.result.budgetBytes).toBe(getBudget('SEARCH_PAGE_MAX_BYTES').value);
      /** @type {import('$shared/scripts.js').ScriptDefinition} The definition under test. */
      const { name, description, inputSchema } = searchDocumentsDefinition;
      expect(definitionBytes(name, description, compileSchema(inputSchema).listed)).toBeLessThanOrEqual(
         getBudget('DEFINITION_MAX_BYTES').value,
      );
      expect(description.length).toBeLessThanOrEqual(getBudget('DESCRIPTION_TARGET_CHARS').value);
   });

   it('requires documentName and bounds limit, filters, fields, field length, query and cursor', () => {
      /** @type {{ properties: Record<string, any>, required: string[] }} The input schema under test. */
      const { properties, required } = searchDocumentsDefinition.inputSchema;
      expect(required).toEqual(['documentName']);
      expect(properties.limit).toMatchObject({
         type: 'integer',
         minimum: 1,
         maximum: getBudget('SEARCH_MAX_LIMIT').value,
      });
      expect(properties.filters.maxItems).toBe(5);
      expect(properties.fields.maxItems).toBe(getBudget('PATHS_PER_CALL_MAX').value);
      expect(properties.query.maxLength).toBeLessThanOrEqual(64);
      expect(properties.cursor.maxLength).toBeLessThanOrEqual(512);
      expect(properties.fields.items.maxLength).toBe(getBudget('SEARCH_FIELD_PATH_MAX_BYTES').value);
      expect(properties.maxBytes).toBeUndefined();
   });

   it('refuses what the schema bounds before anything is read', async () => {
      installWorld({ documents: actors(3) }, vi.fn);
      for (const args of [
         {
            documentName: 'Actor',
            limit: 0,
         },
         {
            documentName: 'Actor',
            limit: 101,
         },
         {
            documentName: 'Actor',
            limit: 2.5,
         },
         {
            documentName: 'Actor',
            cursor: 'c'.repeat(513),
         },
         {
            documentName: 'Actor',
            query: 'q'.repeat(65),
         },
         {
            documentName: 'Actor',
            filters: Array.from({ length: 6 }, (_, index) => `system.a${index}=1`),
         },
         {
            documentName: 'Actor',
            fields: ['f'.repeat(65)],
         },
         {},
      ]) {
         await expect(search(args)).rejects.toMatchObject({ code: 'ARGS_INVALID' });
      }
   });

   it('drops an undeclared maxBytes argument: the page budget is not a caller choice', async () => {
      installWorld({ documents: actors(3) }, vi.fn);
      const plain = await search({ documentName: 'Actor' });
      expect(await search({
         documentName: 'Actor',
         maxBytes: 16000,
      })).toEqual(plain);
   });
});

describe('search_documents paging', () => {
   it('lists rows as [uuid, name, type] in name order with the total and no cursor when all fit', async () => {
      installWorld({ documents: actors(3) }, vi.fn);
      const result = await search({ documentName: 'Actor' });
      expect(result).toEqual({
         rows: [
            [
               'Actor.MOCKACTOR0000000',
               'MOCK_Actor_000',
               'player',
            ],
            [
               'Actor.MOCKACTOR0000001',
               'MOCK_Actor_001',
               'npc',
            ],
            [
               'Actor.MOCKACTOR0000002',
               'MOCK_Actor_002',
               'player',
            ],
         ],
         total: 3,
      });
   });

   it('defaults to 20 rows, pages through every row exactly once and ends without a cursor', async () => {
      installWorld({ documents: actors(45) }, vi.fn);
      const seen = [];
      let cursor;
      let pages = 0;
      do {
         const page = await search({
            documentName: 'Actor',
            ...(cursor ? { cursor } : {}),
         });
         expect(page.total).toBe(45 - pages * 20);
         expect(page.rows.length).toBe(pages < 2 ? 20 : 5);
         seen.push(...page.rows.map((row) => row[0]));
         cursor = page.nextCursor;
         pages += 1;
      } while (cursor !== undefined);
      expect(pages).toBe(3);
      expect(new Set(seen).size).toBe(45);
      expect(seen).toEqual([...seen].sort((a, b) => (a < b ? -1 : 1)));
   });

   it('honours limit and returns the same order for the same query', async () => {
      installWorld({ documents: actors(30) }, vi.fn);
      const first = await search({
         documentName: 'Actor',
         limit: 7,
      });
      const again = await search({
         documentName: 'Actor',
         limit: 7,
      });
      expect(first.rows).toHaveLength(7);
      expect(first).toEqual(again);
      expect(first.fieldsDropped).toBeUndefined();
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(new TextEncoder().encode(first.nextCursor).length).toBeLessThanOrEqual(256);
   });

   it('keeps the cursor stable when a document is added or removed between pages', async () => {
      const all = actors(30);
      installWorld({ documents: all }, vi.fn);
      const first = await search({
         documentName: 'Actor',
         limit: 10,
      });
      const last = first.rows.at(-1)[0];
      // A row before the cursor is removed and one before it is added; the next page still starts after the last row.
      const added = mockDocument(
         {
            documentName: 'Actor',
            id: 'MOCKACTORAAAAAAA',
            name: 'MOCK_Actor_000a',
            type: 'npc',
         },
         vi.fn,
      );
      installWorld({ documents: [
         ...all.slice(1),
         added,
      ] }, vi.fn);
      const next = await search({
         documentName: 'Actor',
         limit: 10,
         cursor: first.nextCursor,
      });
      expect(next.rows[0][1]).toBe('MOCK_Actor_010');
      expect(next.rows.map((row) => row[0])).not.toContain(last);
      expect(next.rows).toHaveLength(10);
   });

   it('refuses a cursor that is not one of ours', async () => {
      installWorld({ documents: actors(3) }, vi.fn);
      for (const cursor of [
         'nope',
         'e30',
         btoa('[1,2]'),
         btoa('["a"]'),
      ]) {
         await expect(search({
            documentName: 'Actor',
            cursor,
         })).rejects.toMatchObject({ code: 'CURSOR_INVALID' });
      }
   });

   it('holds a page of 100 long rows with fields to the page budget and loses no row across pages', async () => {
      installWorld(
         {
            documents: actors(100, (index) => ({ name: `MOCK_${'L'.repeat(60)}_${String(index).padStart(3, '0')}` })),
         },
         vi.fn,
      );
      const seen = [];
      let cursor;
      do {
         const page = await search({
            documentName: 'Actor',
            limit: 100,
            fields: [
               'system.notes',
               'system.level',
               'system.rarity',
            ],
            ...(cursor ? { cursor } : {}),
         });
         expect(ENCODER.encode(JSON.stringify(page)).length).toBeLessThanOrEqual(
            getBudget('SEARCH_PAGE_MAX_BYTES').value,
         );
         expect(page.rows.length).toBeGreaterThan(0);
         seen.push(...page.rows.map((row) => row[0]));
         cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(new Set(seen).size).toBe(100);
   });
});

describe('search_documents limit clamps', () => {
   it('clamps a limit the schema would refuse, for a caller that bypasses it', async () => {
      // Short names and uuids keep 100 rows inside the page budget, so only the limit can stop the page.
      const small = actors(150, (index) => ({
         uuid: `A.${index}`,
         name: `n${String(index).padStart(3, '0')}`,
      }));
      installWorld({ documents: small }, vi.fn);
      const huge = await searchDocuments({
         documentName: 'Actor',
         limit: 500,
         filters: [],
      });
      expect(huge.rows).toHaveLength(100);
      expect((await searchDocuments({
         documentName: 'Actor',
         limit: 0,
      })).rows).toHaveLength(1);
      expect((await searchDocuments({
         documentName: 'Actor',
         limit: -5,
      })).rows).toHaveLength(1);
      expect((await searchDocuments({
         documentName: 'Actor',
         limit: 2.9,
      })).rows).toHaveLength(2);
      expect((await searchDocuments({ documentName: 'Actor' })).rows).toHaveLength(20);
   });
});

describe('search_documents filter limit', () => {
   it('refuses more than 5 filters for a caller that bypasses the schema, and accepts exactly 5', async () => {
      installWorld({ documents: actors(4) }, vi.fn);
      const filters = Array.from({ length: 5 }, () => 'system.rarity=common');
      await expect(
         searchDocuments({
            documentName: 'Actor',
            filters: [
               ...filters,
               'system.level=999',
            ],
         }),
      ).rejects.toMatchObject({
         code: 'ARGS_INVALID',
         message: expect.stringContaining('at most 5 filters'),
      });
      expect((await searchDocuments({
         documentName: 'Actor',
         filters,
      })).total).toBe(2);
   });
});

describe('search_documents matching', () => {
   it('matches the query as a case-insensitive name substring and the type exactly', async () => {
      installWorld({ documents: actors(12) }, vi.fn);
      const named = await search({
         documentName: 'Actor',
         query: 'actor_00',
      });
      expect(named.total).toBe(10);
      const typed = await search({
         documentName: 'Actor',
         type: 'npc',
      });
      expect(typed.total).toBe(6);
      expect(typed.rows.every((row) => row[2] === 'npc')).toBe(true);
      const both = await search({
         documentName: 'Actor',
         type: 'npc',
         query: 'ACTOR_01',
      });
      expect(both.rows.map((row) => row[1])).toEqual(['MOCK_Actor_011']);
   });

   it('filters on equality of scalar values at dotted paths, with numbers and booleans as text', async () => {
      installWorld({ documents: actors(30) }, vi.fn);
      const common = await search({
         documentName: 'Actor',
         filters: ['system.rarity=common'],
      });
      expect(common.total).toBe(10);
      const level = await search({
         documentName: 'Actor',
         filters: ['system.level=7'],
      });
      expect(level.rows.map((row) => row[1])).toEqual(['MOCK_Actor_007']);
      const flag = await search({
         documentName: 'Actor',
         filters: ['system.nested.flag=true'],
      });
      expect(flag.total).toBe(6);
      const both = await search({
         documentName: 'Actor',
         filters: [
            'system.rarity=common',
            'system.nested.flag=true',
         ],
      });
      expect(both.rows.map((row) => row[1])).toEqual([
         'MOCK_Actor_000',
         'MOCK_Actor_015',
      ].sort());
   });

   it('matches nothing for a path that is absent or not a scalar', async () => {
      installWorld({ documents: actors(5) }, vi.fn);
      expect((await search({
         documentName: 'Actor',
         filters: ['system.absent=1'],
      })).total).toBe(0);
      expect((await search({
         documentName: 'Actor',
         filters: ['system.nested=1'],
      })).total).toBe(0);
   });

   it('refuses a malformed filter, a wildcard, an unsafe segment and a too-long path', async () => {
      installWorld({ documents: actors(2) }, vi.fn);
      for (const filter of [
         'noequals',
         '=value',
         'items.*.name=x',
         '__proto__.x=1',
         `${'a'.repeat(600)}=1`,
      ]) {
         await expect(search({
            documentName: 'Actor',
            filters: [filter],
         })).rejects.toMatchObject({
            code: expect.stringMatching(/^(ARGS_INVALID|PATH_)/),
         });
      }
   });

   it('adds the requested fields to each row as a flat map of scalars, shortening long strings', async () => {
      installWorld({ documents: actors(2) }, vi.fn);
      const result = await search({
         documentName: 'Actor',
         fields: [
            'system.level',
            'system.notes',
            'system.nested',
            'system.absent',
         ],
      });
      expect(result.rows[1][3]['system.level']).toBe(1);
      expect(new TextEncoder().encode(result.rows[1][3]['system.notes']).length).toBeLessThanOrEqual(64);
      expect(Object.keys(result.rows[1][3])).toEqual([
         'system.level',
         'system.notes',
      ]);
   });

   it('rejects an unknown class and a class that is not a world collection', async () => {
      installWorld({ documents: actors(1) }, vi.fn);
      await expect(search({ documentName: 'Nonsense' })).rejects.toMatchObject({ code: 'ARGS_INVALID' });
      await expect(search({ documentName: 'ActiveEffect' })).rejects.toMatchObject({ code: 'ARGS_INVALID' });
   });
});

describe('search_documents exclusions', () => {
   /**
    * Install settings, one inside the wiretap namespace per gate name and two outside it.
    * @returns {void}
    */
   function worldWithSettings() {
      const make = (id, key, value) => {
         const setting = mockDocument(
            {
               documentName: 'Setting',
               id,
               name: key,
               source: {
                  key,
                  value,
               },
            },
            vi.fn,
         );
         setting.key = key;
         return setting;
      };
      installWorld(
         {
            documents: [
               make('MOCKSETTING00001', 'wiretap.allowMacroExecution', 'true'),
               make('MOCKSETTING00002', 'WIRETAP.allowUserWrites', 'true'),
               make('MOCKSETTING00003', 'core.mock', '1'),
               make('MOCKSETTING00004', 'core.other', '2'),
            ],
         },
         vi.fn,
      );
   }

   it('never lists, counts or matches a wiretap setting', async () => {
      worldWithSettings();
      const listed = await search({ documentName: 'Setting' });
      expect(listed.total).toBe(2);
      expect(JSON.stringify(listed)).not.toContain('wiretap');
      expect(JSON.stringify(listed).toLowerCase()).not.toContain('wiretap');
      const byName = await search({
         documentName: 'Setting',
         query: 'wiretap',
      });
      expect(byName).toEqual({
         rows: [],
         total: 0,
      });
      const byValue = await search({
         documentName: 'Setting',
         filters: ['value=true'],
      });
      expect(byValue).toEqual({
         rows: [],
         total: 0,
      });
   });

   it('answers a filter on a wiretap key like a filter on a key that does not exist', async () => {
      worldWithSettings();
      const present = await search({
         documentName: 'Setting',
         filters: ['key=wiretap.allowMacroExecution'],
      });
      const absent = await search({
         documentName: 'Setting',
         filters: ['key=wiretap.doesNotExist'],
      });
      expect(present).toEqual(absent);
   });

   it('refuses a filter or a field on a User password path and never returns one', async () => {
      const user = mockDocument(
         {
            documentName: 'User',
            id: 'MOCKUSER00000001',
            name: 'MOCK_User',
            source: {
               role: 4,
               password: 'MOCK_HASH',
               passwordSalt: 'MOCK_SALT',
            },
         },
         vi.fn,
      );
      installWorld({ documents: [user] }, vi.fn);
      for (const args of [
         { filters: ['password=MOCK_HASH'] },
         { filters: ['passwordSalt=x'] },
         { fields: ['password'] },
         { fields: [
            'passwordSalt',
            'role',
         ] },
      ]) {
         await expect(search({
            documentName: 'User',
            ...args,
         })).rejects.toMatchObject({ code: 'PATH_EXCLUDED' });
      }
      const ok = await search({
         documentName: 'User',
         filters: ['role=4'],
         fields: ['role'],
      });
      expect(ok.rows[0][3]).toEqual({ role: 4 });
      expect(JSON.stringify(ok)).not.toContain('MOCK_HASH');
      // The same names on a class that has no such field are ordinary paths.
      installWorld({ documents: actors(1, () => ({ source: { password: 'x' } })) }, vi.fn);
      expect((await search({
         documentName: 'Actor',
         filters: ['password=x'],
      })).total).toBe(1);
   });
});

describe('search_documents scopes', () => {
   it('searches a compendium through its index with only the requested fields and loads no document', async () => {
      const packed = actors(6, (index) => ({ uuid: `Compendium.mock.actors.Actor.MOCKACTOR000000${index}` }));
      installWorld({ packs: { 'mock.actors': packed } }, vi.fn);
      const result = await search({
         documentName: 'Actor',
         pack: 'mock.actors',
         filters: ['system.rarity=common'],
         fields: ['system.level'],
         limit: 5,
      });
      expect(globalThis.lastIndexFields.sort()).toEqual([
         'system.level',
         'system.rarity',
      ]);
      expect(result.total).toBe(2);
      expect(result.rows[0][0]).toMatch(/^Compendium\.mock\.actors\.Actor\./);
      expect(result.rows[0][3]).toEqual({ 'system.level': 0 });
      expect(globalThis.fromUuid).not.toHaveBeenCalled();
   });

   it('answers DOC_NOT_FOUND for a missing pack or a pack of another class and refuses excluded classes', async () => {
      installWorld({ packs: { 'mock.actors': actors(1) } }, vi.fn);
      await expect(search({
         documentName: 'Actor',
         pack: 'mock.missing',
      })).rejects.toMatchObject({
         code: 'DOC_NOT_FOUND',
      });
      await expect(search({
         documentName: 'Item',
         pack: 'mock.actors',
      })).rejects.toMatchObject({
         code: 'DOC_NOT_FOUND',
      });
      await expect(search({
         documentName: 'Setting',
         pack: 'mock.actors',
      })).rejects.toMatchObject({
         code: 'ARGS_INVALID',
      });
      await expect(search({
         documentName: 'User',
         pack: 'mock.actors',
      })).rejects.toMatchObject({
         code: 'ARGS_INVALID',
      });
   });

   it('searches the embedded documents of a parent', async () => {
      const parent = actors(1)[0];
      const items = Array.from({ length: 3 }, (_, index) =>
         mockDocument(
            {
               documentName: 'Item',
               id: `MOCKITEM${String(index).padStart(8, '0')}`,
               name: `MOCK_Item_${index}`,
               type: 'weapon',
            },
            vi.fn,
         ),
      );
      installWorld({
         documents: [parent],
         embedded: { [parent.uuid]: items },
      }, vi.fn);
      const result = await search({
         documentName: 'Item',
         parentUuid: parent.uuid,
         query: 'item_1',
      });
      expect(result.rows.map((row) => row[1])).toEqual(['MOCK_Item_1']);
      await expect(search({
         documentName: 'Item',
         parentUuid: 'Actor.MOCKMISSING00001',
      })).rejects.toMatchObject({
         code: 'DOC_NOT_FOUND',
      });
      await expect(
         search({
            documentName: 'Item',
            parentUuid: parent.uuid,
            pack: 'mock.actors',
         }),
      ).rejects.toMatchObject({ code: 'ARGS_INVALID' });
   });
});

/**
 * Count the exports made through a set of mocked documents.
 * @param {import('./mockDocuments.js').MockDocument[]} documents - The mocked documents whose exports are counted.
 * @returns {number} The number of times `toCompendium` ran across all of them.
 */
function exportCount(documents) {
   return documents.reduce((sum, document) => sum + document.toCompendium.mock.calls.length, 0);
}

/**
 * Build short-named actors so that many rows fit a page: ids and names are a few bytes.
 * @param {number} count - How many actors.
 * @returns {import('./mockDocuments.js').MockDocument[]} The actors, named in ascending order.
 */
function shortActors(count) {
   return Array.from({ length: count }, (_, index) =>
      mockDocument(
         {
            documentName: 'Actor',
            id: `A${String(index).padStart(5, '0')}`,
            name: `n${String(index).padStart(5, '0')}`,
            type: index % 2 === 0 ? 'player' : 'npc',
            uuid: `A.${index}`,
            source: { system: { rarity: index % 3 === 0 ? 'common' : 'rare' } },
         },
         vi.fn,
      ),
   );
}

/**
 * Page through a search with a cursor until it ends.
 * @param {Record<string, unknown>} args - The search arguments.
 * @returns {Promise<{ uuids: string[], calls: number, cuts: number }>} Every row uuid, the calls and the cut pages.
 */
async function drain(args) {
   /** @type {string[]} Every row uuid. */
   const uuids = [];
   /** @type {string | undefined} The cursor of the previous page. */
   let cursor;
   /** @type {number} The calls made. */
   let calls = 0;
   /** @type {number} The pages that reported a cut. */
   let cuts = 0;
   do {
      const page = await search({
         ...args,
         ...(cursor === undefined ? {} : { cursor }),
      });
      uuids.push(...page.rows.map((row) => row[0]));
      cuts += page.cut === true ? 1 : 0;
      cursor = page.nextCursor;
      calls += 1;
   } while (cursor !== undefined && calls < 200);
   return {
      uuids,
      calls,
      cuts,
   };
}

/**
 * Replace `MessageChannel` with a counting subclass for the duration of a callback.
 * @param {(created: number) => void} onCreate - Called with the running count of channels created.
 * @param {() => Promise<void>} body - The code that runs under the counting class.
 * @returns {Promise<number>} How many channels were created.
 */
async function countYields(onCreate, body) {
   /** @type {typeof MessageChannel} The real class. */
   const Original = globalThis.MessageChannel;
   /** @type {number} The channels created. */
   let created = 0;
   globalThis.MessageChannel = class extends Original {
      constructor() {
         super();
         created += 1;
         onCreate(created);
      }
   };
   try {
      await body();
   } finally {
      globalThis.MessageChannel = Original;
   }
   return created;
}

describe('search_documents work bounds', () => {
   it('reads name, type and folder from the live document and exports nothing for them', async () => {
      const all = shortActors(100);
      installWorld({ documents: all }, vi.fn);
      const typed = await search({
         documentName: 'Actor',
         type: 'npc',
         filters: ['type=npc'],
         query: 'n00',
      });
      expect(typed.total).toBe(50);
      const named = await search({
         documentName: 'Actor',
         filters: ['name=n00007'],
      });
      expect(named.rows.map((row) => row[1])).toEqual(['n00007']);
      const mismatched = await search({
         documentName: 'Actor',
         filters: ['type=npc'],
      });
      expect(mismatched.total).toBe(50);
      expect(exportCount(all)).toBe(0);
   });

   it('exports only the candidates that pass the cheap tests when a filter needs the data', async () => {
      const all = shortActors(100);
      installWorld({ documents: all }, vi.fn);
      const result = await search({
         documentName: 'Actor',
         type: 'npc',
         filters: ['system.rarity=common'],
      });
      expect(result.total).toBe(17);
      expect(exportCount(all)).toBe(50);
   });

   it('exports only the page rows for fields, and a document once for a filter and fields together', async () => {
      const all = shortActors(1000);
      installWorld({ documents: all }, vi.fn);
      await search({
         documentName: 'Actor',
         fields: ['system.rarity'],
         limit: 20,
      });
      expect(exportCount(all)).toBe(20);
      for (const document of all) {
         document.toCompendium.mockClear();
      }
      const both = await search({
         documentName: 'Actor',
         filters: ['system.rarity=common'],
         fields: ['system.rarity'],
         limit: 5,
      });
      expect(both.rows).toHaveLength(5);
      expect(exportCount(all)).toBe(getBudget('SEARCH_EXPORT_MAX').value);
   });

   it('stops after the scan cap, reports cut and scanned, and a cursor resumes to cover every document', async () => {
      const all = shortActors(4500);
      installWorld({ documents: all }, vi.fn);
      const scanMax = getBudget('SEARCH_SCAN_MAX').value;
      const first = await search({
         documentName: 'Actor',
         limit: 80,
      });
      expect(first.cut).toBe(true);
      expect(first.scanned).toBe(scanMax);
      expect(first.total).toBe(scanMax);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(exportCount(all)).toBe(0);
      const drained = await drain({
         documentName: 'Actor',
         limit: 80,
      });
      expect(drained.cuts).toBeGreaterThan(0);
      expect(new Set(drained.uuids).size).toBe(4500);
      expect(drained.uuids).toHaveLength(4500);
   });

   it('stops after the export cap, reports cut and resumes to find every match', async () => {
      const all = shortActors(1000);
      installWorld({ documents: all }, vi.fn);
      const exportMax = getBudget('SEARCH_EXPORT_MAX').value;
      const first = await search({
         documentName: 'Actor',
         filters: ['system.rarity=common'],
         limit: 5,
      });
      expect(first.cut).toBe(true);
      expect(first.scanned).toBe(exportMax);
      expect(exportCount(all)).toBe(exportMax);
      expect(first.total).toBe(100);
      const drained = await drain({
         documentName: 'Actor',
         filters: ['system.rarity=common'],
         limit: 80,
      });
      expect(new Set(drained.uuids).size).toBe(334);
      expect(drained.uuids).toHaveLength(334);
   });

   it('yields to the event loop once per batch', async () => {
      installWorld({ documents: shortActors(200) }, vi.fn);
      const created = await countYields(
         () => {},
         async () => {
            await search({ documentName: 'Actor' });
         },
      );
      // 200 documents are ordered and 200 scanned, 25 per batch.
      expect(created).toBe(16);
   });

   it('stops working once its signal aborts and reports SEARCH_ABORTED', async () => {
      const all = shortActors(1000);
      installWorld({ documents: all }, vi.fn);
      const controller = new AbortController();
      // Ordering 1000 documents takes 40 yields; the abort lands on the fifth yield of the scan.
      const created = await countYields(
         (count) => {
            if (count === 45) {
               controller.abort();
            }
         },
         async () => {
            await expect(
               searchDocuments(
                  {
                     documentName: 'Actor',
                     filters: ['system.rarity=common'],
                  },
                  controller.signal,
               ),
            ).rejects.toMatchObject({ code: 'SEARCH_ABORTED' });
         },
      );
      expect(created).toBe(45);
      expect(exportCount(all)).toBeLessThanOrEqual(125);
   });

   it('passes the call signal from the registered handler to the search', async () => {
      const searched = vi.fn(async () => ({
         rows: [],
         total: 0,
      }));
      /** @type {AbortSignal} The signal the handler receives. */
      const signal = new AbortController().signal;
      await searchDocumentsHandler(
         { documentName: 'Actor' },
         {
            core: { searchDocuments: searched },
            signal,
         },
      );
      expect(searched).toHaveBeenCalledWith({ documentName: 'Actor' }, signal);
   });
});

describe('search_documents compendium index', () => {
   /** @type {{ documentName: string, pack: string }} The scope shared by the searches. */
   const scope = {
      documentName: 'Actor',
      pack: 'mock.actors',
   };

   it('asks the index for at most 5 distinct short paths', async () => {
      installWorld({ packs: { 'mock.actors': actors(2) } }, vi.fn);
      await search({
         ...scope,
         filters: [
            'system.rarity=common',
            'system.rarity=rare',
         ],
         fields: [
            'system.rarity',
            'system.level',
            'system.nested.flag',
            'img',
            'sort',
         ],
      });
      expect(globalThis.lastIndexFields.sort()).toEqual([
         'img',
         'sort',
         'system.level',
         'system.nested.flag',
         'system.rarity',
      ]);
   });

   it('refuses a sixth distinct path, a path of four segments and a whole subtree before the index', async () => {
      installWorld({ packs: { 'mock.actors': actors(2) } }, vi.fn);
      for (const extra of [
         {
            fields: [
               'a',
               'b',
               'c',
               'd',
               'e',
               'f',
            ],
         },
         { fields: ['system.a.b.c'] },
         { fields: ['system'] },
         { filters: ['items=x'] },
         { fields: ['flags'] },
      ]) {
         await expect(search({
            ...scope,
            ...extra,
         })).rejects.toMatchObject({ code: 'ARGS_INVALID' });
      }
      expect(globalThis.lastIndexFields).toBeUndefined();
      // The same paths are ordinary for a world search, which reads live documents.
      installWorld({ documents: actors(2) }, vi.fn);
      await expect(search({
         documentName: 'Actor',
         fields: ['system.a.b.c'],
      })).resolves.toBeDefined();
   });
});

describe('search_documents compendium secrets and cursor size', () => {
   it('refuses an index path with a secret-named segment, for fields and filters', async () => {
      installWorld({ packs: { 'mock.actors': actors(2) } }, vi.fn);
      for (const extra of [
         { fields: ['flags.m.apiKey'] },
         { filters: ['flags.m.password=x'] },
         { fields: ['system.clientSecret'] },
         { filters: ['flags.token.value=1'] },
      ]) {
         await expect(search({ documentName: 'Actor', pack: 'mock.actors', ...extra })).rejects.toMatchObject({
            code: 'PATH_EXCLUDED',
         });
      }
      expect(globalThis.lastIndexFields).toBeUndefined();
      await expect(
         search({ documentName: 'Actor', pack: 'mock.actors', fields: ['flags.m.fine'] }),
      ).resolves.toBeDefined();
   });

   it('issues a cursor that fits the schema bound for the worst-case name and uuid', async () => {
      const worst = Array.from({ length: 2 }, (_, index) =>
         mockDocument(
            {
               documentName: 'Actor',
               id: `MOCKWORST${String(index).padStart(7, '0')}`,
               name: '\u0001'.repeat(60),
               uuid: `Compendium.${'s'.repeat(60)}.${'p'.repeat(60)}.Actor.${index}`,
            },
            vi.fn,
         ),
      );
      installWorld({ documents: worst }, vi.fn);
      const max = searchDocumentsDefinition.inputSchema.properties.cursor.maxLength;
      const first = await search({ documentName: 'Actor', limit: 1 });
      expect(first.nextCursor.length).toBeLessThanOrEqual(max);
      const second = await search({ documentName: 'Actor', limit: 1, cursor: first.nextCursor });
      expect(second.rows).toHaveLength(1);
      expect(second.rows[0][0]).not.toBe(first.rows[0][0]);
   });
});

describe('search_documents row size', () => {
   /** @type {string[]} Twenty field paths at the echo bound. */
   const fields = Array.from(
      { length: 20 },
      (_, field) => `system.${'k'.repeat(50)}${String(field).padStart(2, '0')}`,
   );

   /**
    * Build an actor with 20 long system fields whose values expand when serialized (control characters).
    * @param {number} index - The actor number.
    * @returns {import('./mockDocuments.js').MockDocument} The actor with its 20 expanding system fields.
    */
   function heavyActor(index) {
      /** @type {Record<string, string>} The system fields. */
      const system = {};
      for (const path of fields) {
         system[path.slice('system.'.length)] = '\u0001'.repeat(64);
      }
      return mockDocument(
         {
            documentName: 'Actor',
            id: `MOCKHEAVY${String(index).padStart(7, '0')}`,
            name: `MOCK_Heavy_${index}`,
            type: 'npc',
            source: { system },
         },
         vi.fn,
      );
   }

   it('degrades a lone row whose fields overflow the page to its uuid, name and type', async () => {
      installWorld({ documents: [heavyActor(0)] }, vi.fn);
      const result = await search({
         documentName: 'Actor',
         fields,
      });
      expect(result.rows).toEqual([
         [
            'Actor.MOCKHEAVY0000000',
            'MOCK_Heavy_0',
            'npc',
         ],
      ]);
      expect(result.fieldsDropped).toBe(true);
      expect(ENCODER.encode(JSON.stringify(result)).length).toBeLessThanOrEqual(
         getBudget('SEARCH_PAGE_MAX_BYTES').value,
      );
   });

   it('pages through oversized rows without losing one and keeps every page in budget', async () => {
      installWorld({ documents: [
         0,
         1,
         2,
      ].map(heavyActor) }, vi.fn);
      const seen = [];
      let cursor;
      do {
         const page = await search({
            documentName: 'Actor',
            fields,
            ...(cursor === undefined ? {} : { cursor }),
         });
         expect(ENCODER.encode(JSON.stringify(page)).length).toBeLessThanOrEqual(
            getBudget('SEARCH_PAGE_MAX_BYTES').value,
         );
         seen.push(...page.rows.map((row) => row[0]));
         cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(seen).toHaveLength(3);
   });

   it('refuses a field path longer than the echo bound', async () => {
      installWorld({ documents: actors(1) }, vi.fn);
      await expect(
         searchDocuments({
            documentName: 'Actor',
            fields: [`system.${'k'.repeat(getBudget('SEARCH_FIELD_PATH_MAX_BYTES').value)}`],
         }),
      ).rejects.toMatchObject({ code: 'PATH_INVALID' });
   });
});
