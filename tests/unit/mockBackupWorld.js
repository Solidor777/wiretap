/**
 * A mocked world for the backup export tests: world Folders nested two deep, Actors with embedded Items, a
 * JournalEntry, a User, a Setting and one Item pack with two Folders and indexed Items. Not a test file (vitest only
 * collects `*.test.js`). Every name is a `MOCK_` value.
 */

import { mockDocument } from './mockDocuments.js';

/**
 * A Map that iterates its values, as Foundry's `Collection` does (`common/utils/collection.mjs`).
 * @extends {Map<string, any>}
 */
export class MockCollection extends Map {
   /**
    * Iterate the values, not the entries.
    * @returns {MapIterator<any>} The value iterator.
    */
   [Symbol.iterator]() {
      return this.values();
   }

   /**
    * The values as an array.
    * @returns {any[]} Every value in insertion order.
    */
   get contents() {
      return Array.from(this.values());
   }
}

/**
 * The id of the mocked pack.
 * @type {string}
 */
export const MOCK_PACK_ID = 'world.mock-items';

/**
 * @typedef {object} BackupWorldOptions
 * @property {number} [extraActors] - Extra Actors without a folder, added after the named ones.
 * @property {number} [packItems] - Indexed Items in the pack (default 3); the first sits in pack Folder A, the second
 * in pack Folder B.
 */

/**
 * @typedef {object} BackupWorld
 * @property {Record<string, any>} docs - The named documents: `folderA`, `folderB`, `folderC`, `folderJ`,
 * `folderPacks`, `actor1`, `actor2`, `actor3`, `item1` (embedded in `actor1`), `journal`, `user`, `setting`,
 * `packFolderA`, `packFolderB` and `packItem0`, `packItem1`, ….
 * @property {any} pack - The mocked pack.
 * @property {MockCollection} actors - The world Actor collection.
 */

/**
 * Pad a number into a 16-character mock id.
 * @param {string} prefix - The id prefix, letters only.
 * @param {number} index - The number.
 * @returns {string} The prefix, then zeros, then the number.
 */
function mockId(prefix, index) {
   return `${prefix}${String(index).padStart(16 - prefix.length, '0')}`;
}

/**
 * Build a mocked document with the fields the backup code reads besides the export: `parent`, `pack` and
 * `_source.folder`, plus `type` for a Folder.
 * @param {(implementation: Function) => Function} fn - The mock-function factory (`vi.fn`).
 * @param {object} options - The document fields.
 * @param {string} options.documentName - The document class name.
 * @param {string} options.id - The 16-character id.
 * @param {string} [options.uuid] - The uuid; defaults to `<documentName>.<id>`.
 * @param {string | null} [options.folder] - The id of the Folder holding the document.
 * @param {string} [options.type] - The subtype (a Folder's document type).
 * @param {string | null} [options.pack] - The pack id when the document is in a pack.
 * @param {object | null} [options.parent] - The parent of an embedded document.
 * @param {Record<string, unknown>} [options.source] - Extra stored fields.
 * @returns {any} The mocked document.
 */
function makeDocument(fn, { documentName, id, uuid, folder = null, type, pack = null, parent = null, source = {} }) {
   /** @type {any} The document built by the shared mock. */
   const document = mockDocument(
      {
         documentName,
         id,
         uuid,
         type,
         source: {
            folder,
            ...source,
         },
      },
      fn,
   );
   document._source = { folder };
   document.pack = pack;
   document.parent = parent;
   return document;
}

/**
 * Install the mocked backup world on `globalThis`: `game`, `CONST` and `fromUuid`.
 * @param {(implementation: Function) => Function} fn - The mock-function factory (`vi.fn`).
 * @param {BackupWorldOptions} [options] - The sizes of the world.
 * @returns {BackupWorld} The documents, the pack and the Actor collection.
 */
export function installBackupWorld(fn, { extraActors = 0, packItems = 3 } = {}) {
   /** @type {Record<string, any>} The named documents. */
   const docs = {};
   // Listed children first so that the code under test has to order Folders by depth itself.
   docs.folderC = makeDocument(fn, {
      documentName: 'Folder',
      id: 'MOCKFOLDERC00001',
      type: 'Actor',
      folder: 'MOCKFOLDERB00001',
   });
   docs.folderB = makeDocument(fn, {
      documentName: 'Folder',
      id: 'MOCKFOLDERB00001',
      type: 'Actor',
      folder: 'MOCKFOLDERA00001',
   });
   docs.folderA = makeDocument(fn, {
      documentName: 'Folder',
      id: 'MOCKFOLDERA00001',
      type: 'Actor',
   });
   docs.folderJ = makeDocument(fn, {
      documentName: 'Folder',
      id: 'MOCKFOLDERJ00001',
      type: 'JournalEntry',
   });
   docs.folderPacks = makeDocument(fn, {
      documentName: 'Folder',
      id: 'MOCKFOLDERP00001',
      type: 'Compendium',
   });
   docs.actor1 = makeDocument(fn, {
      documentName: 'Actor',
      id: 'MOCKACTOR0000001',
      folder: 'MOCKFOLDERA00001',
      source: {
         items: [{
            _id: 'MOCKITEM00000001',
            name: 'MOCK_Item',
         }],
      },
   });
   docs.item1 = makeDocument(fn, {
      documentName: 'Item',
      id: 'MOCKITEM00000001',
      uuid: 'Actor.MOCKACTOR0000001.Item.MOCKITEM00000001',
      parent: docs.actor1,
   });
   docs.actor2 = makeDocument(fn, {
      documentName: 'Actor',
      id: 'MOCKACTOR0000002',
      folder: 'MOCKFOLDERC00001',
   });
   docs.actor3 = makeDocument(fn, {
      documentName: 'Actor',
      id: 'MOCKACTOR0000003',
   });
   docs.journal = makeDocument(fn, {
      documentName: 'JournalEntry',
      id: 'MOCKJOURNAL00001',
      folder: 'MOCKFOLDERJ00001',
   });
   docs.user = makeDocument(fn, {
      documentName: 'User',
      id: 'MOCKUSER00000001',
   });
   docs.setting = makeDocument(fn, {
      documentName: 'Setting',
      id: 'MOCKSETTING00001',
   });
   docs.setting.key = 'mock-module.option';
   docs.packFolderB = makeDocument(fn, {
      documentName: 'Folder',
      id: 'MOCKPFOLDERB0001',
      uuid: `Compendium.${MOCK_PACK_ID}.Folder.MOCKPFOLDERB0001`,
      type: 'Item',
      folder: 'MOCKPFOLDERA0001',
      pack: MOCK_PACK_ID,
   });
   docs.packFolderA = makeDocument(fn, {
      documentName: 'Folder',
      id: 'MOCKPFOLDERA0001',
      uuid: `Compendium.${MOCK_PACK_ID}.Folder.MOCKPFOLDERA0001`,
      type: 'Item',
      pack: MOCK_PACK_ID,
   });

   /** @type {MockCollection} The world Actors. */
   const actors = new MockCollection();
   for (const name of [
      'actor1',
      'actor2',
      'actor3',
   ]) {
      actors.set(docs[name].id, docs[name]);
   }
   for (let index = 0; index < extraActors; index += 1) {
      /** @type {any} One extra actor. */
      const extra = makeDocument(fn, {
         documentName: 'Actor',
         id: mockId('MOCKXACTOR', index),
      });
      actors.set(extra.id, extra);
   }

   /** @type {MockCollection} The world Folders, children listed before their parents. */
   const folders = new MockCollection();
   for (const name of [
      'folderC',
      'folderB',
      'folderA',
      'folderJ',
      'folderPacks',
   ]) {
      folders.set(docs[name].id, docs[name]);
   }

   /** @type {Map<string, MockCollection>} The world collections by document class. */
   const collections = new Map([
      [
         'Actor',
         actors,
      ],
      [
         'Folder',
         folders,
      ],
      [
         'JournalEntry',
         new MockCollection([[
            docs.journal.id,
            docs.journal,
         ]]),
      ],
      [
         'User',
         new MockCollection([[
            docs.user.id,
            docs.user,
         ]]),
      ],
      [
         'Setting',
         new MockCollection([[
            docs.setting.id,
            docs.setting,
         ]]),
      ],
   ]);

   /** @type {MockCollection} The pack's Folders, the child listed first. */
   const packFolders = new MockCollection([
      [
         docs.packFolderB.id,
         docs.packFolderB,
      ],
      [
         docs.packFolderA.id,
         docs.packFolderA,
      ],
   ]);
   /** @type {MockCollection} The pack's stored documents by id. */
   const packDocuments = new MockCollection();
   /** @type {MockCollection} The pack index. */
   const index = new MockCollection();
   for (let position = 0; position < packItems; position += 1) {
      /** @type {string | null} The pack Folder the item sits in. */
      const folder = [
         'MOCKPFOLDERA0001',
         'MOCKPFOLDERB0001',
      ][position] ?? null;
      /** @type {any} One pack item. */
      const item = makeDocument(fn, {
         documentName: 'Item',
         id: mockId('MOCKPITEM', position),
         uuid: `Compendium.${MOCK_PACK_ID}.Item.${mockId('MOCKPITEM', position)}`,
         folder,
         pack: MOCK_PACK_ID,
      });
      docs[`packItem${position}`] = item;
      packDocuments.set(item.id, item);
      index.set(item.id, {
         _id: item.id,
         uuid: item.uuid,
         name: item.name,
         folder,
      });
   }
   /** @type {any} The mocked pack. */
   const pack = {
      collection: MOCK_PACK_ID,
      documentName: 'Item',
      folders: packFolders,
      documents: packDocuments,
      getIndex: fn(async () => index),
      getDocuments: fn(async ({ _id__in: ids }) => ids
         .map((id) => packDocuments.get(id))
         .filter((document) => document !== undefined)),
   };

   /** @type {Map<string, any>} Every resolvable document by uuid. */
   const byUuid = new Map();
   for (const document of Object.values(docs)) {
      byUuid.set(document.uuid, document);
   }
   for (const actor of actors) {
      byUuid.set(actor.uuid, actor);
   }

   globalThis.CONST = {
      WORLD_DOCUMENT_TYPES: [
         'Actor',
         'Folder',
         'Item',
         'JournalEntry',
         'Setting',
         'User',
      ],
   };
   globalThis.fromUuid = fn(async (uuid) => byUuid.get(uuid) ?? null);
   globalThis.game = {
      world: { id: 'mock-world' },
      version: '14.364',
      system: {
         id: 'mock-system',
         version: '1.2.3',
      },
      folders,
      collections: { get: (documentName) => collections.get(documentName) },
      packs: new Map([[
         MOCK_PACK_ID,
         pack,
      ]]),
   };
   return {
      docs,
      pack,
      actors,
   };
}

/**
 * Remove the mocked world from `globalThis`.
 * @returns {void}
 */
export function removeBackupWorld() {
   delete globalThis.CONST;
   delete globalThis.fromUuid;
   delete globalThis.game;
}
