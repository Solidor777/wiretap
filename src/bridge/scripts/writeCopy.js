/**
 * Build create data from source documents named by uuid, so a copy is made without the source body passing through
 * the agent. The result is plain data for `prepareCreate`, which judges it like any other create data; this module
 * writes nothing.
 *
 * Foundry has three copy paths, read in the v14 tree (`C:\FoundryVTT\V14\dev\foundry\`):
 *
 * - `ClientDocument#toCompendium(pack, { clearSort = true, clearFolder = false, clearFlags = false, clearSource =
 * true, clearOwnership = true, clearState = true, keepId = false })` (`client/documents/abstract/client-document.mjs`
 * :1113-1134) starts from `toObject()` (embedded documents included), deletes `_id` unless `keepId`, the top-level
 * `sort` when `clearSort`, `folder` when `clearFolder` and `active` when `clearState`. With `clearSource` it deletes
 * `_stats.compendiumSource`, `duplicateSource` and `exportSource`, and with `clearOwnership` it deletes `author`, of the
 * document and of every embedded document (`Document._clearFieldsRecursively`, `common/abstract/document.mjs`
 * :1311-1330, which follows `hierarchy`). With `clearOwnership` it also replaces the `ownership` of every such
 * document with `{ default }`, or drops it when it has no numeric `default`: the key stays (:1125-1132).
 * - A pack import of a world document calls `document.toCompendium(pack, options)`, with `clearOwnership` defaulting to
 * true for a world pack (`client/documents/collections/compendium-collection.mjs:469-474`); `folder` is kept.
 * - A world import calls `WorldCollection#fromCompendium(document, { clearFolder = false, clearState = true, clearSort
 * = true, clearOwnership = true, keepId = false })` (`client/documents/abstract/world-collection.mjs:109-137`). It
 * keeps `folder`, sets `_stats.compendiumSource` to the source uuid only for a Document with a `pack` (:115), clears
 * `ownership` of the document and of every embedded document (:123-127), and then always adds a top-level `ownership`
 * of `{ default: NONE, [game.user.id]: OWNER }` (:134-135). It exists only on the world collections.
 * - An embedded create takes the data as given; neither method runs.
 *
 * The subclass overrides change state only, never `_id`, `folder`, `sort` or `ownership`: `ActiveEffect` sets `origin`
 * and `start` to null (`client/documents/active-effect.mjs:481-488`), `Playlist` stops the playlist and its sounds and
 * clears `seed` (`client/documents/playlist.mjs:480-491`), `RollTable` marks every result undrawn
 * (`client/documents/roll-table.mjs:510-518`), and `Scene` deletes `fog.reset`, sets `navigation` to false and deletes
 * `navOrder` (`client/documents/scene.mjs:1554-1562`). Each runs whenever the matching option is not false.
 *
 * A create whose data holds no `ownership` gets the schema initial: `DocumentOwnershipField` starts as `{ default:
 * NONE }` (`common/data/fields.mjs:3784-3790`), a JournalEntryPage as `{ default: INHERIT }`
 * (`common/documents/journal-entry-page.mjs:74`), and an ActorDelta as null (`common/documents/actor-delta.mjs:54`).
 * Neither `ClientDocument#_preCreate` (`client/documents/abstract/client-document.mjs:431-439`, which only forwards to
 * the type data model) nor `Document#_preCreate` (`common/abstract/document.mjs:1028`, empty) adds one, and an embedded
 * document whose level is INHERIT, or which has no ownership field, defers to its parent (`getUserLevel`,
 * `common/abstract/document.mjs:392-401`).
 *
 * This module builds one copy for every target kind (world, pack, embedded): `toCompendium` with `clearSort`,
 * `clearFolder`, `clearOwnership`, `clearSource` and `clearState`, then every `ownership` deleted, of the document and
 * of each embedded document, by the same `_clearFieldsRecursively` walk `fromCompendium` uses. An `ownership` key
 * anywhere in create data needs the `allowOwnershipWrites` gate, so a copy carries none, and the copy gets the
 * ownership a create with no `ownership` gets: Foundry's world import differs here only in granting the importing user
 * an explicit OWNER level. `_id` (unless `keepId`), `sort` and `folder` are deleted again so the result does not depend
 * on which options a subclass honours; an embedded document has no `folder`, so that deletion is a no-op there.
 * `_stats.compendiumSource` is set to the source uuid for a source inside a pack, as `fromCompendium` sets it. Every
 * `flags.wiretap` record is removed, so a copy never carries an idempotency record.
 *
 * The copy is built from the raw document, not from the redacted read export, so secret-named keys are copied
 * unchanged as Foundry's own import copies them; every read of the copy is redacted. A source a read refuses outright
 * (`unreadable` of `canonical.js`) is refused with the same code, and a `User` is never copied.
 */

import { getBudget } from '$shared/budgets.js';
import { cleanForLog } from '$shared/logText.js';
import { resolveDocument, unreadable } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { stripWiretapFlags } from '~/bridge/scripts/writeReplace.js';

/**
 * Longest class name echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const CLASS_ECHO_MAX_BYTES = 48;

/**
 * The options of every `toCompendium` call of a copy; `keepId` is added per call.
 * @type {Readonly<Record<string, boolean>>}
 */
const COPY_OPTIONS = Object.freeze({
   clearSort: true,
   clearFolder: true,
   clearOwnership: true,
   clearSource: true,
   clearState: true,
});

/**
 * @typedef {object} CopyParams
 * @property {string} documentName - The class of the documents to create; every source must be of this class.
 * @property {unknown} fromUuids - The uuids of the sources, 1 to `WRITE_DOCUMENTS_MAX` strings.
 * @property {boolean} [keepId] - Keep the `_id` of each source in its copy.
 */

/**
 * Check the uuid list of a copy: an array of 1 to `WRITE_DOCUMENTS_MAX` strings.
 * @param {unknown} fromUuids - The list the call carries.
 * @returns {void}
 * @throws {ScriptError} `ARGS_INVALID` when the list is not such an array.
 */
function checkUuids(fromUuids) {
   /** @type {number} The most sources one call copies. */
   const max = getBudget('WRITE_DOCUMENTS_MAX').value;
   if (
      !Array.isArray(fromUuids) ||
      fromUuids.length < 1 ||
      fromUuids.length > max ||
      !fromUuids.every((uuid) => typeof uuid === 'string')
   ) {
      throw new ScriptError('ARGS_INVALID', `Give 1 to ${max} fromUuids.`);
   }
}

/**
 * Resolve one source and check that it may be copied as the class asked for.
 * @param {string} uuid - Names the document to copy.
 * @param {number} index - Its position in `fromUuids`.
 * @param {string} documentName - The class of the documents to create.
 * @returns {Promise<object>} The live source document.
 * @throws {ScriptError} `DOC_NOT_FOUND` when nothing matches, `ARGS_INVALID` for a source of another class, or the
 * code of `unreadable` (`DOC_EXCLUDED`) for a source no read may see.
 */
async function resolveSource(uuid, index, documentName) {
   /** @type {object} The live source. */
   const source = await resolveDocument({ uuid });
   if (source.documentName !== documentName) {
      throw new ScriptError(
         'ARGS_INVALID',
         `fromUuids.${index} is of class ${cleanForLog(String(source.documentName), CLASS_ECHO_MAX_BYTES)}, not ` +
            `${cleanForLog(String(documentName), CLASS_ECHO_MAX_BYTES)}.`,
      );
   }
   /** @type {{ code: string, message: string } | null} The refusal of a read, if any. */
   const refusal = unreadable(source);
   if (refusal !== null) {
      throw new ScriptError(refusal.code, refusal.message);
   }
   return source;
}

/**
 * Build the create data of one copy from its source.
 * @param {object} source - The live source document.
 * @param {boolean} keepId - Keep the `_id` of the source.
 * @returns {Record<string, unknown>} The plain create data, a copy the caller owns.
 */
function copyOf(source, keepId) {
   /** @type {Record<string, unknown>} The exported data. */
   const data = source.toCompendium(null, {
      ...COPY_OPTIONS,
      keepId,
   });
   source.constructor._clearFieldsRecursively(data, ['ownership']);
   if (!keepId) {
      delete data._id;
   }
   delete data.sort;
   delete data.folder;
   if (source.pack) {
      data._stats = {
         ...data._stats,
         compendiumSource: source.uuid,
      };
   }
   stripWiretapFlags(data);
   return data;
}

/**
 * Turn source uuids into create data: one plain data object per uuid, in `fromUuids` order. Every source is resolved
 * and checked before any copy is built; nothing is written.
 * @param {CopyParams} params - The class, the sources and whether ids are kept.
 * @returns {Promise<Record<string, unknown>[]>} The create data, ready for `prepareCreate`.
 * @throws {ScriptError} `ARGS_INVALID` for a bad uuid list, a `User` copy or a source of another class,
 * `DOC_NOT_FOUND` for a missing source, `DOC_EXCLUDED` for a source no read may see.
 */
export async function copyDataFromUuids({ documentName, fromUuids, keepId = false }) {
   checkUuids(fromUuids);
   if (documentName === 'User') {
      throw new ScriptError('ARGS_INVALID', 'fromUuids does not copy a User; create it from data.');
   }
   /** @type {object[]} The live sources, in `fromUuids` order. */
   const sources = [];
   for (const [index, uuid] of fromUuids.entries()) {
      sources.push(await resolveSource(uuid, index, documentName));
   }
   return sources.map((source) => copyOf(source, keepId));
}
