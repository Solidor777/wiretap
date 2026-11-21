// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
   ALLOWED_DOCUMENT_NAMES,
   E2E_PREFIX,
   E2E_SETTING_KEY_PREFIX,
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

/**
 * A `Map` of mock packs by collection id that iterates its values, as Foundry's `Collection` does
 * (`common/utils/collection.mjs`).
 * @extends {Map<string, object>}
 */
class MockPacks extends Map {
   /**
    * Iterate the packs, not the entries.
    * @returns {IterableIterator<object>} An iterator over the mock packs, in insertion order.
    */
   [Symbol.iterator]() {
      return this.values();
   }
}

/** @type {MockPacks} The mock compendium packs of `game.packs`. */
let packs;

/** @type {string} A `compendiumConfiguration` key of a pack no e2e run created; it must always survive. */
const UNRELATED_PACK_KEY = 'MOCK-module.pack';

/** @type {Record<string, object>} The mock value of the core setting `compendiumConfiguration`, keyed by pack id. */
let packConfiguration;

/** @type {import('vitest').Mock} The mock `game.settings.set`. */
let settingsSet;

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
   /** @type {string} The document id. */
   const id = idOf(number);
   /** @type {string} The document uuid. */
   const uuid = `${documentName}.${id}`;
   /** @type {Record<string, any>} The mock document. */
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
 * Add a mock compendium pack. Its `deleteCompendium` records the id in `deleted` and removes the pack but not its
 * `compendiumConfiguration` key; its `configure` applies the given configuration and, as Foundry's does
 * (`client/documents/collections/compendium-collection.mjs`), writes it under the pack id in that setting.
 * @param {string} name - The pack name; the id is `world.<name>`.
 * @param {object} [overrides] - Fields replacing the defaults (`title`, `metadata`, `locked`).
 * @returns {Record<string, any>} The mock pack.
 */
function addPack(name, overrides = {}) {
   /** @type {string} The pack collection id. */
   const collection = `world.${name}`;
   /** @type {Record<string, any>} The mock pack. */
   const pack = {
      collection,
      title: `${E2E_PREFIX}pack ${name}`,
      metadata: { packageType: 'world' },
      locked: false,
      ...overrides,
   };
   pack.configure = vi.fn(async (configuration) => {
      Object.assign(pack, configuration);
      await game.settings.set('core', 'compendiumConfiguration', {
         ...packConfiguration,
         [collection]: {
            ...packConfiguration[collection],
            ...configuration,
         },
      });
   });
   pack.deleteCompendium = vi.fn(async () => {
      deleted.push(collection);
      packs.delete(collection);
   });
   packs.set(collection, pack);
   return pack;
}

/**
 * Build a valid running-list entry for a mock pack.
 * @param {string} name - The pack name; the id is `world.<name>`.
 * @returns {object} The running-list entry that names the mock pack.
 */
function packEntryOf(name) {
   return {
      documentName: 'Compendium',
      id: `world.${name}`,
      uuid: `Compendium.world.${name}`,
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
   packs = new MockPacks();
   packConfiguration = { [UNRELATED_PACK_KEY]: { folder: null } };
   settingsSet = vi.fn(async (namespace, key, value) => {
      if (namespace === 'core' && key === 'compendiumConfiguration') {
         packConfiguration = value;
      }
   });
   globalThis.game = {
      world: { id: TEST_WORLD },
      packs,
      settings: {
         get: (namespace, key) => (namespace === 'core' && key === 'compendiumConfiguration' ? packConfiguration : {}),
         set: settingsSet,
      },
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
         /** @type {object} A well-formed entry of this type; a pack is named by its collection id. */
         const entry = documentName === 'Compendium' ? packEntryOf('wiretap-e2e-1') : entryOf(documentName, 1);
         expect(entryProblem(entry), documentName).toBeNull();
      }
   });

   it('accepts a well-formed pack entry and refuses a pack id on another type', () => {
      expect(entryProblem({
         documentName: 'Compendium',
         id: 'world.wiretap-e2e-1',
         uuid: 'Compendium.world.wiretap-e2e-1',
         createdBy: 'unit',
      })).toBeNull();
      expect(entryProblem(packEntryOf('a_B-9'))).toBeNull();
      for (const id of [
         'system.pack',
         'world.',
         'world.a b',
         `world.${'a'.repeat(65)}`,
         idOf(1),
      ]) {
         expect(entryProblem({
            ...packEntryOf('x'),
            id,
            uuid: `Compendium.${id}`,
         }), id).toMatch(/pack id/);
      }
      expect(entryProblem(packEntryOf('a'.repeat(64)))).toBeNull();
      for (const uuid of [
         'world.x',
         'Compendium.world.y',
         'Actor.world.x',
         'Compendium.world.x.Actor.MOCKDOC000000001',
      ]) {
         expect(entryProblem({
            ...packEntryOf('x'),
            uuid,
         }), uuid).toMatch(/uuid/);
      }
      expect(entryProblem({
         documentName: 'Actor',
         id: 'world.x',
         uuid: 'Actor.world.x',
         createdBy: 'unit',
      })).toMatch(/16-character/);
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
            documentName: 'Adventure',
            uuid: `Adventure.${idOf(1)}`,
         },
         /allowed/,
      ],
      [
         'a FogExploration',
         {
            ...entryOf('Actor', 1),
            documentName: 'FogExploration',
            uuid: `FogExploration.${idOf(1)}`,
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
      expect(
         recordProblem(
            {
               ...pendingOf([]),
               world: 'other-world',
            },
            TEST_WORLD,
         ),
      ).toMatch(/world/);
      expect(
         recordProblem(
            {
               ...pendingOf([]),
               entries: {},
            },
            TEST_WORLD,
         ),
      ).toMatch(/entries/);
      expect(
         recordProblem(
            {
               ...pendingOf([]),
               pending: 'yes',
            },
            TEST_WORLD,
         ),
      ).toMatch(/pending/);
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
            documentName: 'Adventure',
            uuid: `Adventure.${idOf(2)}`,
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

describe('identity rules and deletion order', () => {
   it('deletes the types that point at others before the ones they point at, and Folders last', async () => {
      addDocument('Folder', 1);
      addDocument('Actor', 2);
      addDocument('Scene', 3);
      addDocument('Combat', 4);
      addDocument('ChatMessage', 5, {
         name: undefined,
         flavor: `${E2E_PREFIX}msg`,
      });
      addDocument('Setting', 6, {
         name: undefined,
         key: `${E2E_SETTING_KEY_PREFIX}one`,
      });
      writeRaw(pendingOf([
         entryOf('Folder', 1),
         entryOf('Actor', 2),
         entryOf('Scene', 3),
         entryOf('Combat', 4),
         entryOf('ChatMessage', 5),
         entryOf('Setting', 6),
      ]));
      await teardownRecorded(page, { file });
      expect(deleted).toEqual([
         `ChatMessage.${idOf(5)}`,
         `Combat.${idOf(4)}`,
         `Setting.${idOf(6)}`,
         `Scene.${idOf(3)}`,
         `Actor.${idOf(2)}`,
         `Folder.${idOf(1)}`,
      ]);
   });

   it('judges a chat message by its flavor and a setting by its key, never by name', async () => {
      addDocument('ChatMessage', 1, {
         name: `${E2E_PREFIX}in the name only`,
         flavor: 'a real message',
      });
      addDocument('Setting', 2, {
         name: `${E2E_PREFIX}in the name only`,
         key: 'core.time',
      });
      addDocument('ChatMessage', 3, {
         name: undefined,
         flavor: `${E2E_PREFIX}mine`,
      });
      addDocument('Setting', 4, {
         name: undefined,
         key: `${E2E_SETTING_KEY_PREFIX}mine`,
      });
      expect((await sweepUnrecorded(page)).sort()).toEqual([
         `ChatMessage ${E2E_PREFIX}mine`,
         `Setting ${E2E_SETTING_KEY_PREFIX}mine`,
      ]);
      expect([...documents.keys()].sort()).toEqual([
         `ChatMessage.${idOf(1)}`,
         `Setting.${idOf(2)}`,
      ]);
      writeRaw(pendingOf([entryOf('ChatMessage', 1)]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/not named with the e2e prefix/);
      writeRaw(pendingOf([entryOf('Setting', 2)]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/not named with the e2e prefix/);
      expect(deleted).toHaveLength(2);
   });

   it('counts a prefixed chat message and setting as leftovers', async () => {
      addDocument('ChatMessage', 1, {
         name: undefined,
         flavor: `${E2E_PREFIX}left`,
      });
      addDocument('Setting', 2, {
         name: undefined,
         key: `${E2E_SETTING_KEY_PREFIX}left`,
      });
      expect((await censusPrefixed(page)).sort()).toEqual([
         `ChatMessage ${E2E_PREFIX}left`,
         `Setting ${E2E_SETTING_KEY_PREFIX}left`,
      ]);
   });

   it('never deletes the signed-in user or a game master, recorded or swept', async () => {
      globalThis.game.user = { id: idOf(1) };
      addDocument('User', 1, { isGM: true });
      addDocument('User', 2, { isGM: true });
      addDocument('User', 3, { isGM: false });
      writeRaw(pendingOf([entryOf('User', 1)]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/signed-in user or a game master/);
      writeRaw(pendingOf([entryOf('User', 2)]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/signed-in user or a game master/);
      await expect(sweepUnrecorded(page)).rejects.toThrow(/refuses to delete: User/);
      // Nothing is deleted, not even the account that is neither the signed-in user nor a game master.
      expect(deleted).toEqual([]);
      expect(documents.size).toBe(3);
   });
});

describe('safety of the record, the sweep and the world guard', () => {
   it('refuses to record over a corrupt, foreign or invalid earlier record and keeps it as it was', async () => {
      for (const content of [
         '{ not json',
         JSON.stringify({
            pending: true,
            world: 'test-other',
            entries: [entryOf('Actor', 1)],
         }),
         JSON.stringify({
            pending: true,
            world: TEST_WORLD,
            entries: [{ documentName: 'Adventure' }],
         }),
      ]) {
         fs.writeFileSync(file, content);
         await expect(recordDocument(page, entryOf('Actor', 2), { file })).rejects.toThrow();
         expect(fs.readFileSync(file, 'utf8')).toBe(content);
      }
   });

   it('refuses to write a record of more than 1,000 entries', async () => {
      /** @type {object[]} A running list at the entry limit. */
      const entries = Array.from({ length: 1000 }, (_, index) => entryOf('Actor', index + 1));
      writeRaw(pendingOf(entries));
      /** @type {string} The running list as written before the refused call. */
      const before = fs.readFileSync(file, 'utf8');
      await expect(recordDocument(page, entryOf('Actor', 5000), { file })).rejects.toThrow(/1000/);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
   });

   it('re-tests the identity of each document right before deleting it', async () => {
      /** @type {Record<string, any>} The document that is renamed between the inspection and the delete. */
      const actor = addDocument('Actor', 1);
      addDocument('Actor', 2);
      writeRaw(pendingOf([
         entryOf('Actor', 1),
         entryOf('Actor', 2),
      ]));
      /** @type {number} The evaluate calls made so far. */
      let calls = 0;
      /** @type {{ evaluate: (fn: Function, arg?: unknown) => Promise<unknown> }} A page that renames the document. */
      const racing = {
         evaluate: async (fn, arg) => {
            calls += 1;
            // The inspection (call 2, after the world check) passed; the document is renamed before the delete runs.
            if (calls === 3) {
               actor.name = 'A real character';
            }
            return fn(arg);
         },
      };
      await expect(teardownRecorded(racing, { file })).rejects.toThrow(/not named with the e2e prefix/);
      expect(deleted).not.toContain(`Actor.${idOf(1)}`);
   });

   it('deletes nothing in a sweep that finds a violation, even for documents that are safe', async () => {
      addDocument('Actor', 1);
      addDocument('Item', 2, { pack: 'world.items' });
      await expect(sweepUnrecorded(page)).rejects.toThrow(/refuses to delete/);
      expect(deleted).toEqual([]);
   });

   it('refuses a world whose id does not start with test- unless it is named by the environment', async () => {
      /** @type {string | undefined} The environment value to restore. */
      const previous = process.env.WIRETAP_E2E_ALLOW_WORLD;
      globalThis.game.world.id = 'live-campaign';
      try {
         delete process.env.WIRETAP_E2E_ALLOW_WORLD;
         await expect(sweepUnrecorded(page, { world: 'live-campaign' })).rejects.toThrow(/test-/);
         process.env.WIRETAP_E2E_ALLOW_WORLD = 'another-world';
         await expect(sweepUnrecorded(page, { world: 'live-campaign' })).rejects.toThrow(/test-/);
         process.env.WIRETAP_E2E_ALLOW_WORLD = 'live-campaign';
         await expect(sweepUnrecorded(page, { world: 'live-campaign' })).resolves.toEqual([]);
         globalThis.game.world.id = 'test-spare';
         delete process.env.WIRETAP_E2E_ALLOW_WORLD;
         await expect(sweepUnrecorded(page, { world: 'test-spare' })).resolves.toEqual([]);
      } finally {
         if (previous === undefined) {
            delete process.env.WIRETAP_E2E_ALLOW_WORLD;
         } else {
            process.env.WIRETAP_E2E_ALLOW_WORLD = previous;
         }
      }
   });

   it('matches the setting key prefix at the start and with the same case only', async () => {
      addDocument('Setting', 1, {
         name: undefined,
         key: `core.${E2E_SETTING_KEY_PREFIX}mid`,
      });
      addDocument('Setting', 2, {
         name: undefined,
         key: E2E_SETTING_KEY_PREFIX.toUpperCase() + 'upper',
      });
      addDocument('Setting', 3, {
         name: undefined,
         key: `${E2E_SETTING_KEY_PREFIX}real`,
      });
      expect(await sweepUnrecorded(page)).toEqual([`Setting ${E2E_SETTING_KEY_PREFIX}real`]);
      expect(documents.size).toBe(2);
      writeRaw(pendingOf([entryOf('Setting', 1)]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/not named with the e2e prefix/);
      writeRaw(pendingOf([entryOf('Setting', 2)]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/not named with the e2e prefix/);
   });

   it('never deletes an assistant game master named with the prefix', async () => {
      globalThis.game.user = { id: idOf(9) };
      addDocument('User', 1, {
         isGM: true,
         role: 3,
      });
      writeRaw(pendingOf([entryOf('User', 1)]));
      await expect(teardownRecorded(page, { file })).rejects.toThrow(/signed-in user or a game master/);
      await expect(sweepUnrecorded(page)).rejects.toThrow(/refuses to delete: User/);
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

describe('compendium packs', () => {
   it('tears a recorded pack down through deleteCompendium, unlocking it first only when it is locked', async () => {
      /** @type {Record<string, any>} A pack the GM locked. */
      const locked = addPack('locked', { locked: true });
      /** @type {Record<string, any>} A pack that is not locked. */
      const open = addPack('open');
      writeRaw(pendingOf([
         packEntryOf('locked'),
         packEntryOf('open'),
      ]));
      await teardownRecorded(page, { file });
      expect(locked.configure).toHaveBeenCalledTimes(1);
      expect(locked.configure).toHaveBeenCalledWith({ locked: false });
      expect(locked.configure.mock.invocationCallOrder[0]).toBeLessThan(
         locked.deleteCompendium.mock.invocationCallOrder[0],
      );
      expect(locked.deleteCompendium).toHaveBeenCalledTimes(1);
      expect(open.configure).not.toHaveBeenCalled();
      expect(open.deleteCompendium).toHaveBeenCalledTimes(1);
      expect(deleted.sort()).toEqual([
         'world.locked',
         'world.open',
      ]);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).pending).toBe(false);
   });

   it('refuses to delete a recorded pack that is a system pack or whose title lacks the e2e prefix, and deletes '
      + 'nothing', async () => {
         /** @type {Record<string, any>} A safe pack recorded beside the unsafe ones. */
         const safe = addPack('safe');
         /** @type {Record<string, any>} A system pack named with the prefix. */
         const system = addPack('system', { metadata: { packageType: 'system' } });
         /** @type {Record<string, any>} A world pack a human titled. */
         const human = addPack('human', { title: 'MOCK_monsters' });
         for (const entries of [
            [
               packEntryOf('safe'),
               packEntryOf('system'),
            ],
            [
               packEntryOf('safe'),
               packEntryOf('human'),
            ],
         ]) {
            writeRaw(pendingOf(entries));
            await expect(teardownRecorded(page, { file })).rejects.toThrow(/refuses to delete: world\.(system|human)/);
            expect(JSON.parse(fs.readFileSync(file, 'utf8')).pending).toBe(true);
         }
         for (const pack of [
            safe,
            system,
            human,
         ]) {
            expect(pack.deleteCompendium).not.toHaveBeenCalled();
            expect(pack.configure).not.toHaveBeenCalled();
         }
         expect(deleted).toEqual([]);
      });

   it('re-tests the identity of a pack right before deleting it', async () => {
      /** @type {Record<string, any>} The pack that is retitled between the inspection and the delete. */
      const pack = addPack('racing', { locked: true });
      writeRaw(pendingOf([packEntryOf('racing')]));
      /** @type {number} The evaluate calls made so far. */
      let calls = 0;
      /** @type {{ evaluate: (fn: Function, arg?: unknown) => Promise<unknown> }} A page that retitles the pack. */
      const racing = {
         evaluate: async (fn, arg) => {
            calls += 1;
            // The inspection (call 2, after the world check) passed; the pack is retitled before the delete runs.
            if (calls === 3) {
               pack.title = 'MOCK_monsters';
            }
            return fn(arg);
         },
      };
      await expect(teardownRecorded(racing, { file })).rejects.toThrow(/world\.racing/);
      expect(pack.configure).not.toHaveBeenCalled();
      expect(pack.deleteCompendium).not.toHaveBeenCalled();
   });

   it('skips a recorded pack that no longer exists', async () => {
      writeRaw(pendingOf([packEntryOf('gone')]));
      await teardownRecorded(page, { file });
      expect(deleted).toEqual([]);
      expect(JSON.parse(fs.readFileSync(file, 'utf8')).pending).toBe(false);
   });

   it('deletes recorded packs after the documents', async () => {
      addPack('first');
      addDocument('Folder', 1);
      addDocument('Actor', 2);
      writeRaw(pendingOf([
         packEntryOf('first'),
         entryOf('Folder', 1),
         entryOf('Actor', 2),
      ]));
      await teardownRecorded(page, { file });
      expect(deleted).toEqual([
         `Actor.${idOf(2)}`,
         `Folder.${idOf(1)}`,
         'world.first',
      ]);
   });

   it('sweeps unrecorded world packs titled with the prefix and spares system packs, module packs and unprefixed '
      + 'world packs', async () => {
      /** @type {Record<string, any>} A locked world pack titled with the prefix. */
      const locked = addPack('locked', { locked: true });
      addPack('open');
      /** @type {Record<string, any>[]} The packs the sweep must leave alone. */
      const spared = [
         addPack('human', { title: 'MOCK_monsters' }),
         addPack('inside', { title: `MOCK ${E2E_PREFIX}not at the start` }),
         addPack('system', {
            title: 'MOCK_system_pack',
            metadata: { packageType: 'system' },
         }),
         addPack('module', {
            title: 'MOCK_module_pack',
            metadata: { packageType: 'module' },
         }),
      ];
      addDocument('Folder', 1);
      expect(await sweepUnrecorded(page)).toEqual([
         `Folder ${E2E_PREFIX}doc 1`,
         `Compendium ${E2E_PREFIX}pack locked`,
         `Compendium ${E2E_PREFIX}pack open`,
      ]);
      expect(locked.configure).toHaveBeenCalledWith({ locked: false });
      expect(deleted).toEqual([
         `Folder.${idOf(1)}`,
         'world.locked',
         'world.open',
      ]);
      for (const pack of spared) {
         expect(pack.deleteCompendium).not.toHaveBeenCalled();
         expect(pack.configure).not.toHaveBeenCalled();
      }
   });

   it('a sweep with a violation deletes no pack', async () => {
      /** @type {Record<string, any>} A world pack the sweep would delete without the violation. */
      const safe = addPack('safe');
      /** @type {Record<string, any>} A module pack titled with the prefix. */
      const foreign = addPack('foreign', { metadata: { packageType: 'module' } });
      addDocument('Actor', 1);
      await expect(sweepUnrecorded(page)).rejects.toThrow(/refuses to delete: Compendium world\.foreign/);
      expect(safe.deleteCompendium).not.toHaveBeenCalled();
      expect(foreign.deleteCompendium).not.toHaveBeenCalled();
      expect(deleted).toEqual([]);
   });

   it('counts a prefixed world pack as a leftover line "Compendium <title>"', async () => {
      addPack('left');
      addPack('human', { title: 'MOCK_monsters' });
      addPack('system', { metadata: { packageType: 'system' } });
      expect(await censusPrefixed(page)).toEqual([`Compendium ${E2E_PREFIX}pack left`]);
   });

   it('settleRegistry tears down, sweeps and counts packs together with documents', async () => {
      addPack('recorded', { locked: true });
      addPack('unrecorded');
      addDocument('Actor', 1);
      writeRaw(pendingOf([
         packEntryOf('recorded'),
         entryOf('Actor', 1),
      ]));
      /** @type {{ swept: string[], census: string[] }} The settle outcome. */
      const result = await settleRegistry(page, { file });
      expect(result).toEqual({
         swept: [`Compendium ${E2E_PREFIX}pack unrecorded`],
         census: [],
      });
      expect(deleted).toEqual([
         `Actor.${idOf(1)}`,
         'world.recorded',
         'world.unrecorded',
      ]);
      expect(packs.size).toBe(0);
   });
});

describe('compendiumConfiguration keys of e2e packs', () => {
   it('the teardown removes the key of each recorded pack it deleted or found gone, and nothing else', async () => {
      addPack('wiretap-e2e-locked', { locked: true });
      addPack('wiretap-e2e-open');
      packConfiguration['world.wiretap-e2e-gone'] = {
         folder: null,
         locked: false,
      };
      packConfiguration['world.wiretap-e2e-unrecorded'] = {
         folder: null,
         locked: false,
      };
      writeRaw(pendingOf([
         packEntryOf('wiretap-e2e-locked'),
         packEntryOf('wiretap-e2e-open'),
         packEntryOf('wiretap-e2e-gone'),
      ]));
      await teardownRecorded(page, { file });
      expect(packConfiguration).toEqual({
         [UNRELATED_PACK_KEY]: { folder: null },
         'world.wiretap-e2e-unrecorded': {
            folder: null,
            locked: false,
         },
      });
   });

   it('the teardown writes no setting when no recorded pack has a key', async () => {
      addPack('wiretap-e2e-open');
      writeRaw(pendingOf([packEntryOf('wiretap-e2e-open')]));
      await teardownRecorded(page, { file });
      expect(settingsSet).not.toHaveBeenCalled();
      expect(packConfiguration).toEqual({ [UNRELATED_PACK_KEY]: { folder: null } });
   });

   it('the sweep removes the key of each pack it deleted and leaves every other key', async () => {
      addPack('wiretap-e2e-locked', { locked: true });
      addPack('human', {
         title: 'MOCK_monsters',
         locked: true,
      });
      packConfiguration['world.human'] = { locked: true };
      packConfiguration['world.wiretap-e2e-stale'] = {
         folder: null,
         locked: false,
      };
      expect(await sweepUnrecorded(page)).toEqual([`Compendium ${E2E_PREFIX}pack wiretap-e2e-locked`]);
      expect(packConfiguration).toEqual({
         [UNRELATED_PACK_KEY]: { folder: null },
         'world.human': { locked: true },
         'world.wiretap-e2e-stale': {
            folder: null,
            locked: false,
         },
      });
   });

   it('the census reports an e2e pack key whose pack no longer exists', async () => {
      addPack('wiretap-e2e-live', { title: 'MOCK_live' });
      packConfiguration['world.wiretap-e2e-live'] = { locked: false };
      packConfiguration['world.wiretap-e2e-pack-1'] = {
         folder: null,
         locked: false,
      };
      packConfiguration['world.e2e-other-project'] = { locked: false };
      expect(await censusPrefixed(page)).toEqual(['compendiumConfiguration world.wiretap-e2e-pack-1']);
   });
});
