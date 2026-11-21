/**
 * The selection of a backup: which primary documents and Folders it holds, in the order they are written, and how
 * they are loaded. A selection is a list of uuids, a Folder with its subfolders and their contents, every world
 * document of one type, or one compendium pack. Folders come first, a parent before its children, so a restore can
 * re-create a Folder before what it holds.
 */

import { cleanForLog } from '$shared/logText.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * How many consecutive entries of one pack `loadEntries` loads with one `getDocuments` call.
 * @type {number}
 */
export const PACK_BATCH_SIZE = 100;

/**
 * Longest caller-supplied text echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const ECHO_MAX_BYTES = 64;

/**
 * The document classes a backup refuses: the export drops user passwords and redacts setting values, so a restore
 * would damage them.
 * @type {readonly string[]}
 */
const REFUSED_TYPES = Object.freeze([
   'User',
   'Setting',
]);

/**
 * The refusal of a User or Setting document.
 * @type {string}
 */
const REFUSED_TYPES_MESSAGE =
   'User and Setting documents cannot be backed up: the export drops passwords and redacts setting values.';

/**
 * @typedef {object} SelectionEntry
 * @property {string} uuid - The uuid of the document.
 * @property {string} documentName - Its document class name.
 * @property {string | null} pack - The id of the pack holding it, or null for a world document.
 * @property {string} id - Its document id.
 */

/**
 * @typedef {object} SelectionPlan
 * @property {SelectionEntry[]} entries - The documents, in the order they are written.
 * @property {number} parents - How many embedded uuids were replaced by their primary parent.
 */

/**
 * @typedef {{ id: string, uuid: string, documentName: string, pack?: string | null, type?: string, parent?: object |
 * null, _source: { folder?: string | null } }} SelectedDocument
 */

/**
 * Describe a loaded document as a selection entry.
 * @param {SelectedDocument} document - A primary document or Folder.
 * @returns {SelectionEntry} Its entry.
 */
function entryOf(document) {
   return {
      uuid: document.uuid,
      documentName: document.documentName,
      pack: document.pack ?? null,
      id: document.id,
   };
}

/**
 * Count how many Folders lie above a Folder, following `_source.folder` within its collection.
 * @param {SelectedDocument} folder - The Folder to measure.
 * @param {{ get: (id: string) => SelectedDocument | undefined }} folders - The Folders of the same world or pack.
 * @returns {number} 0 for a top-level Folder.
 */
function folderDepth(folder, folders) {
   /** @type {number} The Folders counted so far. */
   let depth = 0;
   /** @type {string | null | undefined} The id of the next Folder up. */
   let parentId = folder._source.folder;
   while (parentId) {
      depth += 1;
      parentId = folders.get(parentId)?._source.folder;
   }
   return depth;
}

/**
 * Order Folders so that a parent comes before its children: by depth in each Folder's own world or pack, keeping the
 * given order within a depth.
 * @param {SelectedDocument[]} list - The Folders.
 * @returns {SelectedDocument[]} A new, ordered list.
 */
function sortByDepth(list) {
   /** @type {Map<SelectedDocument, number>} The depth of each Folder. */
   const depths = new Map(list.map((folder) => [
      folder,
      folderDepth(folder, folderCollectionOf(folder)),
   ]));
   return [...list].sort((left, right) => depths.get(left) - depths.get(right));
}

/**
 * The Folder collection a Folder belongs to: its pack's Folders, or the world's.
 * @param {SelectedDocument} folder - A world or pack Folder.
 * @returns {{ get: (id: string) => SelectedDocument | undefined }} The Folders of its world or pack.
 */
function folderCollectionOf(folder) {
   return folder.pack ? game.packs.get(folder.pack).folders : game.folders;
}

/**
 * Resolve a uuid, treating a malformed one as missing.
 * @param {string} uuid - The caller-supplied document address.
 * @returns {Promise<SelectedDocument | null>} The document, or null when nothing has that address.
 */
async function resolveUuid(uuid) {
   try {
      return (await fromUuid(uuid)) ?? null;
   } catch {
      return null;
   }
}

/**
 * Plan a selection named by uuids: each embedded document becomes its primary parent, duplicates keep their first
 * position, and Folders move to the front ordered by depth.
 * @param {string[]} uuids - The caller-supplied document addresses.
 * @returns {Promise<SelectionPlan>} The entries and the count of parents.
 * @throws {ScriptError} `DOC_NOT_FOUND` for a uuid that resolves to nothing, `ARGS_INVALID` for a User or Setting.
 */
async function planUuids(uuids) {
   /** @type {Map<string, SelectedDocument>} The primary documents by uuid, in first-named order. */
   const selected = new Map();
   /** @type {number} How many embedded uuids were replaced by their parent. */
   let parents = 0;
   for (const uuid of uuids) {
      /** @type {SelectedDocument | null} The named document. */
      let document = await resolveUuid(uuid);
      if (document === null) {
         throw new ScriptError('DOC_NOT_FOUND', `No document has uuid ${cleanForLog(uuid, ECHO_MAX_BYTES)}.`);
      }
      if (document.parent) {
         parents += 1;
         while (document.parent) {
            document = document.parent;
         }
      }
      if (REFUSED_TYPES.includes(document.documentName)) {
         throw new ScriptError('ARGS_INVALID', REFUSED_TYPES_MESSAGE);
      }
      if (!selected.has(document.uuid)) {
         selected.set(document.uuid, document);
      }
   }
   /** @type {SelectedDocument[]} The selected documents in first-named order. */
   const documents = Array.from(selected.values());
   /** @type {SelectedDocument[]} The selected Folders. */
   const folders = sortByDepth(documents.filter((document) => document.documentName === 'Folder'));
   return {
      entries: [
         ...folders,
         ...documents.filter((document) => document.documentName !== 'Folder'),
      ].map(entryOf),
      parents,
   };
}

/**
 * Collect a Folder and every Folder below it, a level at a time, so a parent comes before its children.
 * @param {SelectedDocument} root - The Folder at the top of the group.
 * @param {Iterable<SelectedDocument>} folders - Every Folder of the same world or pack.
 * @returns {SelectedDocument[]} The Folder, then its descendants by depth.
 */
function folderTree(root, folders) {
   /** @type {SelectedDocument[]} The Folders found, in order. */
   const tree = [root];
   /** @type {Set<string>} The ids of the Folders found. */
   const ids = new Set([root.id]);
   /** @type {SelectedDocument[]} The Folders found at the last level. */
   let level = [root];
   while (level.length > 0) {
      /** @type {Set<string>} The ids of the last level. */
      const levelIds = new Set(level.map((folder) => folder.id));
      level = [];
      for (const folder of folders) {
         if (!ids.has(folder.id) && levelIds.has(folder._source.folder)) {
            level.push(folder);
         }
      }
      for (const folder of level) {
         ids.add(folder.id);
         tree.push(folder);
      }
   }
   return tree;
}

/**
 * Plan a Folder group: the Folder, its descendant Folders, then every document they hold.
 * @param {string} folderUuid - The address of the Folder at the top of the group.
 * @returns {Promise<SelectionPlan>} The Folders first, then their contents.
 * @throws {ScriptError} `ARGS_INVALID` when the uuid does not name a Folder or names a Folder of packs.
 */
async function planFolder(folderUuid) {
   /** @type {SelectedDocument | null} The named document. */
   const folder = await resolveUuid(folderUuid);
   if (folder === null || folder.documentName !== 'Folder') {
      throw new ScriptError('ARGS_INVALID', 'folderUuid must name a Folder.');
   }
   if (folder.type === 'Compendium') {
      throw new ScriptError('ARGS_INVALID', 'A folder of compendium packs cannot be backed up; name a pack.');
   }
   if (folder.pack) {
      /** @type {any} The pack holding the Folder. */
      const pack = game.packs.get(folder.pack);
      /** @type {SelectedDocument[]} The Folder and its descendants. */
      const tree = folderTree(folder, pack.folders);
      /** @type {Set<string>} The ids of every Folder in the tree. */
      const ids = new Set(tree.map((member) => member.id));
      /** @type {Iterable<{ _id: string, uuid: string, folder?: string | null }>} The pack index with folders. */
      const index = await pack.getIndex({ fields: ['folder'] });
      /** @type {SelectionEntry[]} The indexed documents inside the tree. */
      const contents = [];
      for (const indexed of index) {
         if (ids.has(indexed.folder)) {
            contents.push(indexEntry(pack, indexed));
         }
      }
      return {
         entries: [
            ...tree.map(entryOf),
            ...contents,
         ],
         parents: 0,
      };
   }
   /** @type {SelectedDocument[]} The Folder and its descendants. */
   const tree = folderTree(folder, game.folders);
   /** @type {Set<string>} The ids of every Folder in the tree. */
   const ids = new Set(tree.map((member) => member.id));
   /** @type {SelectedDocument[]} The world documents of the Folder's type inside the tree. */
   const contents = [];
   for (const document of game.collections.get(folder.type)) {
      if (ids.has(document._source.folder)) {
         contents.push(document);
      }
   }
   return {
      entries: [
         ...tree,
         ...contents,
      ].map(entryOf),
      parents: 0,
   };
}

/**
 * Plan a type group: every world Folder of the type by depth, then every world document of the type.
 * @param {string} documentName - The world document type; for `Folder`, every world Folder.
 * @returns {SelectionPlan} The Folders first, then the documents.
 * @throws {ScriptError} `ARGS_INVALID` for User, Setting or a type that is not a world document type.
 */
function planType(documentName) {
   if (REFUSED_TYPES.includes(documentName)) {
      throw new ScriptError('ARGS_INVALID', REFUSED_TYPES_MESSAGE);
   }
   if (!CONST.WORLD_DOCUMENT_TYPES.includes(documentName)) {
      throw new ScriptError(
         'ARGS_INVALID',
         `${cleanForLog(documentName, ECHO_MAX_BYTES)} is not a world document type.`,
      );
   }
   /** @type {SelectedDocument[]} Every world Folder. */
   const allFolders = Array.from(game.folders);
   if (documentName === 'Folder') {
      return {
         entries: sortByDepth(allFolders).map(entryOf),
         parents: 0,
      };
   }
   /** @type {SelectedDocument[]} The Folders of the type, by depth. */
   const folders = sortByDepth(allFolders.filter((folder) => folder.type === documentName));
   return {
      entries: [
         ...folders,
         ...game.collections.get(documentName),
      ].map(entryOf),
      parents: 0,
   };
}

/**
 * Describe a pack index entry as a selection entry.
 * @param {{ collection: string, documentName: string }} pack - The compendium holding the entry.
 * @param {{ _id: string, uuid: string }} indexed - One entry of its index.
 * @returns {SelectionEntry} The entry as the plan holds it.
 */
function indexEntry(pack, indexed) {
   return {
      uuid: indexed.uuid,
      documentName: pack.documentName,
      pack: pack.collection,
      id: indexed._id,
   };
}

/**
 * Plan a whole pack: its Folders by depth, then every entry of its index.
 * @param {string} packId - The pack id, for example `world.items`.
 * @returns {Promise<SelectionPlan>} The Folders first, then the indexed documents.
 * @throws {ScriptError} `ARGS_INVALID` for an unknown pack.
 */
async function planPack(packId) {
   /** @type {any} The compendium collection, when it exists. */
   const pack = game.packs.get(packId);
   if (pack === undefined) {
      throw new ScriptError('ARGS_INVALID', `Unknown pack ${cleanForLog(packId, ECHO_MAX_BYTES)}.`);
   }
   /** @type {SelectionEntry[]} The pack's Folders by depth. */
   const folders = sortByDepth(Array.from(pack.folders)).map(entryOf);
   /** @type {SelectionEntry[]} Every indexed document. */
   const contents = [];
   for (const indexed of await pack.getIndex()) {
      contents.push(indexEntry(pack, indexed));
   }
   return {
      entries: [
         ...folders,
         ...contents,
      ],
      parents: 0,
   };
}

/**
 * Plan the selection of a backup from the one selector its parameters name: `uuids`, `folderUuid`, `documentName` or
 * `pack`.
 * @param {import('./exportBackup.js').ExportParams} params - The backup parameters.
 * @returns {Promise<SelectionPlan>} The entries in write order and the count of embedded uuids mapped to a parent.
 * @throws {ScriptError} `DOC_NOT_FOUND` or `ARGS_INVALID` for a selection that cannot be backed up.
 */
export async function planSelection(params) {
   if (params.uuids !== undefined) {
      return planUuids(params.uuids);
   }
   if (params.folderUuid !== undefined) {
      return planFolder(params.folderUuid);
   }
   if (params.documentName !== undefined) {
      return planType(params.documentName);
   }
   return planPack(params.pack);
}

/**
 * Load a run of consecutive entries of one pack with one `getDocuments` call.
 * @param {SelectionEntry[]} batch - At most `PACK_BATCH_SIZE` entries of the same pack, none a Folder.
 * @returns {Promise<Map<string, object>>} The loaded documents by id; an entry gone from the pack is absent.
 */
async function loadPackBatch(batch) {
   /** @type {any} The pack, or undefined when it is gone. */
   const pack = game.packs.get(batch[0].pack);
   if (pack === undefined) {
      return new Map();
   }
   /** @type {Array<{ id: string }>} The documents still in the pack. */
   const documents = await pack.getDocuments({ _id__in: batch.map((entry) => entry.id) });
   return new Map(documents.map((document) => [
      document.id,
      document,
   ]));
}

/**
 * Load one world entry or pack Folder.
 * @param {SelectionEntry} entry - A world entry or a pack Folder.
 * @returns {object | null} The document, or null when it is gone.
 */
function loadSingle(entry) {
   if (entry.pack === null) {
      return game.collections.get(entry.documentName)?.get(entry.id) ?? null;
   }
   return game.packs.get(entry.pack)?.folders.get(entry.id) ?? null;
}

/**
 * Load the planned entries in order. World documents come from their collection and pack Folders from the pack's
 * Folders; other pack documents are loaded `PACK_BATCH_SIZE` consecutive entries of one pack at a time.
 * @param {SelectionEntry[]} entries - The planned entries.
 * @returns {AsyncGenerator<{ entry: SelectionEntry, document: object | null }>} The generator of the pairs.
 * @yields {{ entry: SelectionEntry, document: object | null }} Each entry with its document, or null when the
 * document is gone since the plan.
 */
export async function* loadEntries(entries) {
   /** @type {number} The position of the next entry. */
   let position = 0;
   while (position < entries.length) {
      /** @type {SelectionEntry} The next entry. */
      const entry = entries[position];
      if (entry.pack === null || entry.documentName === 'Folder') {
         yield {
            entry,
            document: loadSingle(entry),
         };
         position += 1;
         continue;
      }
      /** @type {SelectionEntry[]} The run of entries of the same pack that load together. */
      const batch = [];
      while (position < entries.length
         && batch.length < PACK_BATCH_SIZE
         && entries[position].pack === entry.pack
         && entries[position].documentName !== 'Folder') {
         batch.push(entries[position]);
         position += 1;
      }
      /** @type {Map<string, object>} The loaded documents by id. */
      const loaded = await loadPackBatch(batch);
      for (const member of batch) {
         yield {
            entry: member,
            document: loaded.get(member.id) ?? null,
         };
      }
   }
}
