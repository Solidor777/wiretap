// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
   ALLOWED_DOCUMENT_NAMES,
   E2E_PREFIX,
   TEST_WORLD,
   assertSettled,
   censusPrefixed,
   entryProblem,
   recordDocument,
   recordProblem,
   settleRegistry,
   sweepUnrecorded,
   teardownRecorded,
} from '../e2e/registryCore.js';

/** @type {string} The scratch directory of these tests; its files are overwritten, never deleted. */
const SCRATCH = path.resolve('test', 'tmp', 'e2e-registry-unit');

/** @type {string} The running-list file of the test now running. */
let file;

/** @type {Map<string, object>} The mock world documents by uuid. */
let documents;

/** @type {string[]} The uuids passed to a mock `delete`. */
let deleted;

/** @type {{ combats: object[], scenes: object[] }} The mock world state. */
let world;

/** @type {number} Counter that makes each test's file distinct. */
let serial = 0;

/**
 * Build a 16-character document id from a number.
 * @param {number} number - The counter placed in the id digits.
 * @returns {string} A 16-character alphanumeric id.
 */
function idOf(number) {
   return `MOCKDOC${String(number).padStart(9, '0')}`;
}

/**
 * Add a mock world document.
 * @param {string} documentName - The document class.
 * @param {number} number - The counter placed in the id digits.
 * @param {object} [overrides] - Fields replacing the defaults (`name`, `pack`, `parent`, `documentName`).
 * @returns {object} The mock document.
 */
function addDocument(documentName, number, overrides = {}) {
   const id = idOf(number);
   const uuid = `${documentName}.${id}`;
   const document = {
      id,
      uuid,
      documentName,
      name: `${E2E_PREFIX}doc ${number}`,
      pack: null,
      parent: null,
      delete: async () => {
         deleted.push(uuid);
         documents.delete(uuid);
      },
      ...overrides,
   };
   documents.set(uuid, document);
   return document;
}

/**
 * Build a valid running-list entry for a mock document.
 * @param {string} documentName - The document class.
 * @param {number} number - The counter placed in the id digits.
 * @returns {object} The running-list entry that names the mock document.
 */
function entryOf(documentName, number) {
   return {
      documentName,
      id: idOf(number),
      uuid: `${documentName}.${idOf(number)}`,
      createdBy: 'unit',
   };
}

/**
 * Write a running list straight to the file.
 * @param {object} record - The running-list content to write as JSON.
 * @returns {void}
 */
function writeRaw(record) {
   fs.mkdirSync(SCRATCH, { recursive: true });
   fs.writeFileSync(file, JSON.stringify(record));
}

/**
 * Build a pending record of the test world.
 * @param {object[]} entries - The documents the record lists as created.
 * @returns {object} The record.
 */
function pendingOf(entries) {
   return {
      pending: true,
      world: TEST_WORLD,
      entries,
   };
}

/** @type {{ evaluate: (fn: Function, arg?: unknown) => Promise<unknown> }} A page whose evaluate runs in place. */
const page = { evaluate: async (fn, arg) => fn(arg) };

beforeEach(() => {
   serial += 1;
   file = path.join(SCRATCH, `case-${serial}.json`);
   writeRaw({
      pending: false,
      world: TEST_WORLD,
      entries: [],
   });
   documents = new Map();
   deleted = [];
   world = {
      combats: [],
      scenes: [],
   };
   globalThis.game = {
      world: { id: TEST_WORLD },
      get combats() {
         return world.combats;
      },
      get scenes() {
         return world.scenes;
      },
      actors: { has: (id) => documents.has(`Actor.${id}`) },
      collections: {
         get: (documentName) => [...documents.values()].filter((document) => document.documentName === documentName),
      },
   };
   globalThis.fromUuid = async (uuid) => documents.get(uuid) ?? null;
});

afterEach(() => {
   delete globalThis.game;
   delete globalThis.fromUuid;
});

describe('entryProblem and recordProblem', () => {
   it('accepts a well-formed entry of every allowed type', () => {
      for (const documentName of ALLOWED_DOCUMENT_NAMES) {
         expect(entryProblem(entryOf(documentName, 1)), documentName).toBeNull();
      }
   });

   it.each([
      [
         'a compendium uuid',
         {
            ...entryOf('Actor', 1),
            uuid: `Compendium.world.pack.Actor.${idOf(1)}`,
         },
         /uuid/,
      ],
      [
         'a type that is not allowed',
         {
            ...entryOf('Actor', 1),
            documentName: 'User',
            uuid: `User.${idOf(1)}`,
         },
         /allowed/,
      ],
      [
         'a Combat',
         {
            ...entryOf('Actor', 1),
            documentName: 'Combat',
            uuid: `Combat.${idOf(1)}`,
         },
         /allowed/,
      ],
      [
         'an id of the wrong shape',
         {
            ...entryOf('Actor', 1),
            id: 'short',
            uuid: 'Actor.short',
         },
         /16-character/,
      ],
      [
         'a uuid of another id',
         {
            ...entryOf('Actor', 1),
            uuid: `Actor.${idOf(2)}`,
         },
         /uuid/,
      ],
      [
         'a uuid of another type',
         {
            ...entryOf('Actor', 1),
            uuid: `Item.${idOf(1)}`,
         },
         /uuid/,
      ],
      [
         'an embedded uuid',
         {
            ...entryOf('Actor', 1),
            uuid: `Actor.${idOf(1)}.Item.${idOf(2)}`,
         },
         /uuid/,
      ],
      [
         'a createdBy that is not text',
         {
            ...entryOf('Actor', 1),
            createdBy: 5,
         },
         /createdBy/,
      ],
      [
         'null',
         null,
         /object/,
      ],
      [
         'a list',
         [],
         /object/,
      ],
   ])('refuses %s', (label, entry, reason) => {
      expect(entryProblem(entry)).toMatch(reason);
   });

   it('refuses a record of another world, a non-list of entries and a bad entry', () => {
      expect(recordProblem({ ...pendingOf([]), world: 'other-world' }, TEST_WORLD)).toMatch(/world/);
      expect(recordProblem({ ...pendingOf([]), entries: {} }, TEST_WORLD)).toMatch(/entries/);
      expect(recordProblem({ ...pendingOf([]), pending: 'yes' }, TEST_WORLD)).toMatch(/pending/);
      expect(recordProblem(pendingOf([{}]), TEST_WORLD)).toMatch(/allowed/);
      expect(recordProblem(pendingOf([entryOf('Actor', 1)]), TEST_WORLD)).toBeNull();
   });
});

describe('recordDocument', () => {
   it('records a valid entry and accumulates entries of the same world', async () => {
      await recordDocument(page, entryOf('Actor', 1), { file });
      await recordDocument(page, entryOf('Item', 2), { file });
      const record = JSON.parse(fs.readFileSync(file, 'utf8'));
      expect(record.pending).toBe(true);
      expect(record.entries.map((entry) => entry.uuid)).toEqual([
         `Actor.${idOf(1)}`,
         `Item.${idOf(2)}`,
      ]);
   });

   it('refuses an entry the teardown would refuse, and records nothing', async () => {
      const entry = {
         ...entryOf('Actor', 1),
         uuid: `Compendium.world.pack.Actor.${idOf(1)}`,
      };
      await expect(recordDocument(page, entry, { file })).rejects.toThrow(/refuses to record/);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).pending).toBe(false);
   });

   it('refuses to record in a world other than the test world', async () => {
      globalThis.game.world.id = 'live-campaign';
      await expect(recordDocument(page, entryOf('Actor', 1), { file })).rejects.toThrow(/only runs in/);
   });
});

describe('teardownRecorded', () => {
   it('deletes the recorded documents through document.delete and marks the record done', async () => {
      addDocument('Actor', 1);
      addDocument('Item', 2);
      writeRaw(pendingOf([
         entryOf('Actor', 1),
         entryOf('Item', 2),
      ]));
      await teardownRecorded(page, { file });
      expect(deleted.sort()).toEqual([
         `Actor.${idOf(1)}`,
         `Item.${idOf(2)}`,
      ]);
      expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
         pending: false,
         world: TEST_WORLD,
         entries: [],
      });
   });

   it('deletes a Folder after the documents it holds', async () => {
      addDocument('Folder', 1);
      addDocument('Actor', 2);
      writeRaw(pendingOf([
         entryOf('Folder', 1),
         entryOf('Actor', 2),
      ]));
      await teardownRecorded(page, { file });
      expect(deleted).toEqual([
         `Actor.${idOf(2)}`,
         `Folder.${idOf(1)}`,
      ]);
   });

   it('skips a recorded document that no longer exists', async () => {
      writeRaw(pendingOf([entryOf('Actor', 1)]));
      await teardownRecorded(page, { file });
      expect(deleted).toEqual([]);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).pending).toBe(false);
   });

   it('does nothing when nothing is pending or no file exists', async () => {
      addDocument('Actor', 1);
      await teardownRecorded(page, { file });
      await teardownRecorded(page, { file: path.join(SCRATCH, 'never-written.json') });
      expect(deleted).toEqual([]);
   });

   it('throws for a record with a compendium uuid and deletes nothing', async () => {
      addDocument('Actor', 1);
      writeRaw(pendingOf([
         entryOf('Actor', 1),
         {
            ...entryOf('Actor', 2),
            uuid: `Compendium.world.pack.Actor.${idOf(2)}`,
         },
      ]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/uuid/);
      expect(deleted).toEqual([]);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).pending).toBe(true);
   });

   it('throws for a record with a document type that is not allowed and deletes nothing', async () => {
      addDocument('Actor', 1);
      writeRaw(pendingOf([
         entryOf('Actor', 1),
         {
            ...entryOf('Actor', 2),
            documentName: 'User',
            uuid: `User.${idOf(2)}`,
         },
      ]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/allowed/);
      expect(deleted).toEqual([]);
   });

   it('throws for a record of another world and deletes nothing', async () => {
      addDocument('Actor', 1);
      writeRaw({
         ...pendingOf([entryOf('Actor', 1)]),
         world: 'live-campaign',
      });
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/belongs to world 'live-campaign'/);
      expect(deleted).toEqual([]);
   });

   it('throws when the page is in another world than the test world', async () => {
      addDocument('Actor', 1);
      writeRaw(pendingOf([entryOf('Actor', 1)]));
      globalThis.game.world.id = 'live-campaign';
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/only runs in/);
      expect(deleted).toEqual([]);
   });

   it('throws for a record that is not valid JSON', async () => {
      fs.writeFileSync(file, '{ not json');
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/not valid JSON/);
   });

   it('refuses a document whose type differs from the recorded one, and deletes nothing', async () => {
      addDocument('Actor', 1);
      addDocument('Actor', 2, { documentName: 'Item' });
      writeRaw(pendingOf([
         entryOf('Actor', 1),
         entryOf('Actor', 2),
      ]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/resolves to a Item, not a Actor/);
      expect(deleted).toEqual([]);
   });

   it('refuses a document without the e2e prefix, and deletes nothing', async () => {
      addDocument('Actor', 1);
      addDocument('Actor', 2, { name: 'MOCK_player_character' });
      writeRaw(pendingOf([
         entryOf('Actor', 1),
         entryOf('Actor', 2),
      ]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/not named with the e2e prefix/);
      expect(deleted).toEqual([]);
   });

   it('refuses a document in a compendium pack, and deletes nothing', async () => {
      addDocument('Actor', 1, { pack: 'world.monsters' });
      writeRaw(pendingOf([entryOf('Actor', 1)]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/in a compendium/);
      expect(deleted).toEqual([]);
   });

   it('refuses an embedded document, and deletes nothing', async () => {
      addDocument('Item', 1, { parent: { id: 'MOCKPARENT' } });
      writeRaw(pendingOf([entryOf('Item', 1)]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/not a world document/);
      expect(deleted).toEqual([]);
   });
});

describe('sweepUnrecorded', () => {
   it('deletes the world documents named with the prefix across the allowed types and spares the rest', async () => {
      addDocument('Actor', 1);
      addDocument('Item', 2);
      addDocument('Scene', 3);
      addDocument('Actor', 4, { name: 'MOCK_player_character' });
      addDocument('Actor', 5, { name: `Prefix inside ${E2E_PREFIX}not at the start` });
      const swept = await sweepUnrecorded(page);
      expect(swept.sort()).toEqual([
         `Actor ${E2E_PREFIX}doc 1`,
         `Item ${E2E_PREFIX}doc 2`,
         `Scene ${E2E_PREFIX}doc 3`,
      ]);
      expect(deleted).toHaveLength(3);
      expect([...documents.keys()].sort()).toEqual([
         `Actor.${idOf(4)}`,
         `Actor.${idOf(5)}`,
      ]);
   });

   it('deletes a Folder after the documents', async () => {
      addDocument('Folder', 1);
      addDocument('Actor', 2);
      await sweepUnrecorded(page);
      expect(deleted).toEqual([
         `Actor.${idOf(2)}`,
         `Folder.${idOf(1)}`,
      ]);
   });

   it('returns nothing when nothing is named with the prefix', async () => {
      addDocument('Actor', 1, { name: 'MOCK_other' });
      expect(await sweepUnrecorded(page)).toEqual([]);
      expect(deleted).toEqual([]);
   });

   it('refuses to delete a prefixed document that is in a pack or embedded, and throws', async () => {
      addDocument('Actor', 1, { pack: 'world.monsters' });
      addDocument('Item', 2, { parent: { id: 'MOCKPARENT' } });
      await expect(sweepUnrecorded(page)).rejects.toThrow(/refuses to delete: Actor Actor\.\w+; Item Item\.\w+/);
      expect(deleted).toEqual([]);
   });

   it('throws in a world other than the test world and deletes nothing', async () => {
      addDocument('Actor', 1);
      globalThis.game.world.id = 'live-campaign';
      await expect(sweepUnrecorded(page)).rejects.toThrow(/only runs in/);
      expect(deleted).toEqual([]);
   });
});

describe('censusPrefixed', () => {
   it('counts prefixed documents, every combat and every token whose actor does not resolve', async () => {
      addDocument('Actor', 1);
      addDocument('Actor', 2, { name: 'MOCK_kept' });
      world.combats = [{ id: 'combat1' }];
      world.scenes = [
         {
            id: 'scene1',
            tokens: [
               {
                  id: 'tokenA',
                  actorId: idOf(2),
               },
               {
                  id: 'tokenB',
                  actorId: idOf(99),
               },
               {
                  id: 'tokenC',
                  actorId: null,
               },
            ],
         },
      ];
      expect(await censusPrefixed(page)).toEqual([
         `Actor ${E2E_PREFIX}doc 1`,
         'Combat combat1',
         'Token scene1.tokenB (orphan)',
      ]);
   });

   it('is empty for a clean world', async () => {
      expect(await censusPrefixed(page)).toEqual([]);
   });
});

describe('settleRegistry and assertSettled', () => {
   it('tears down, sweeps and counts, and reports a clean world', async () => {
      addDocument('Actor', 1);
      writeRaw(pendingOf([entryOf('Actor', 1)]));
      const result = await settleRegistry(page, { file });
      expect(result).toEqual({
         swept: [],
         census: [],
      });
      expect(() => assertSettled(result)).not.toThrow();
   });

   it('fails the run when the sweep found an unrecorded document', async () => {
      addDocument('Actor', 1);
      const result = await settleRegistry(page, { file });
      expect(result.swept).toEqual([`Actor ${E2E_PREFIX}doc 1`]);
      expect(() => assertSettled(result)).toThrow(/sweep deleted 1 unrecorded e2e documents: Actor/);
   });

   it('fails the run when the census is not empty', async () => {
      world.combats = [{ id: 'combat1' }];
      const result = await settleRegistry(page, { file });
      expect(() => assertSettled(result)).toThrow(/census found 1 leftovers: Combat combat1/);
   });

   it('bounds the failure message for a long list', () => {
      const swept = Array.from({ length: 50 }, (_, index) => `Actor ${E2E_PREFIX}${index}`);
      expect(() => assertSettled({
         swept,
         census: [],
      })).toThrow(/and 40 more/);
   });
});
