/**
 * `replace_document`: replace a document with the data given, Foundry's import semantics. The steps follow
 * `ClientDocument#importFromJSON` (`client/documents/abstract/client-document.mjs`, read on Foundry 14.364) with two
 * differences: the update fires the document hooks (`preUpdate*`, `update*`) where the core JSON import passes
 * `noHook: true`, and any primary document class is accepted where the core import takes world documents only.
 *
 * 1. `Document.fromImport(source)` builds the document from the data with strict validation. Foundry migrates data
 * over the socket (`migrateDocumentData`, which has no timeout) unless `_stats.coreVersion` equals the running core
 * version, so the caller's `_stats` is never used: `coreVersion` is always set to the running version. Invalid
 * embedded documents are dropped by Foundry (`dropInvalidEmbedded`), not reported.
 * 2. `toObject()` and the steps of `WorldCollection#fromCompendium` (`client/documents/abstract/world-collection.mjs`):
 * `_id`, `sort` and `active` are dropped and `ownership` is cleared recursively.
 * 3. The fields in `metadata.preserveOnImport` (`_id`, `sort`, `ownership`, `folder`, `active` for a Scene) are
 * dropped, so the live document keeps them; `_stats` is dropped too.
 * 4. `document.update(data, { diff: false, recursive: false })`.
 *
 * What the update writes (MEASURED live on a throwaway actor, Foundry 14.364): `toObject()` of the imported document
 * holds EVERY top-level field, with the schema default for each field the caller omitted, and `recursive: false`
 * replaces each top-level field as a whole. A field the data omits therefore resets to its default. That includes the
 * embedded collections: an omitted `items` or `effects` array empties the collection, so the embedded documents are
 * deleted, and an omitted `flags` leaves `{}`, so the flags of every module are lost. Callers send the whole document
 * (the shape of a full read) with the changes made in it.
 *
 * Wiretap's own records are the one exception: `flags.wiretap` of the document and of every embedded document that
 * stays (matched by `_id`) is carried over from the live document, and a `flags.wiretap` in the data is ignored, so
 * that a full read round-trips and no record can be forged or erased. Any other way of reaching the scope (a dotted
 * key, an operator prefix, a `flags` value that is not an object) is refused by the write guard.
 *
 * The call is guarded as a whole before it writes: `guardWrite` judges the data as given and then the replacement
 * that would be written (the schema defaults included), validated by step 1, and a dry run stops before step 4. A
 * `User` cannot be replaced: the import would reset its role, permissions and password to defaults; use
 * `update_documents`.
 */

import { cleanForLog } from '$shared/logText.js';
import { exportDocument } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { checkActAs, resolveActAs } from '~/bridge/scripts/writeActAs.js';
import { FLAG_SCOPE } from '$shared/writeKeys.js';
import { isPlainObject, walkEmbedded } from '~/bridge/scripts/writeFields.js';
import { guardWrite } from '~/bridge/scripts/writeGuard.js';
import {
   failuresOf,
   refuseUnsafeData,
   resolveWritable,
   settingKeyOf,
   validationError,
} from '~/bridge/scripts/writes.js';

/**
 * @typedef {object} ReplaceParams
 * @property {string} uuid - The document to replace, a world, embedded or pack document of a primary class.
 * @property {Record<string, unknown>} data - The new data of the document, the shape of a full read.
 * @property {boolean} [dryRun] - Validate and report; write nothing.
 * @property {boolean} [readback] - Add the canonical export of the replaced document as `exported`.
 * @property {string} [actAs] - The id of a user whose permission to update is checked in advance (advisory).
 */

/**
 * @typedef {object} ReplacedRow
 * @property {string} uuid - The replaced document.
 * @property {string[]} changed - The top-level fields written, in data order.
 * @property {boolean} [dryRun] - True when nothing was written.
 * @property {number} [dropped] - How many embedded documents (nested ones included) the replacement removes; absent
 * when none.
 * @property {Record<string, unknown>} [exported] - The canonical export, only when read-back was requested.
 */

/**
 * Remove the `wiretap` scope from every `flags` object of a data tree, in place, so a full read can be sent back.
 * Only a structured `flags: { wiretap: ... }` is removed; any other way of naming the scope stays for the guard.
 * @param {unknown} root - The data tree, a copy the caller owns.
 * @returns {void}
 */
function stripWiretapFlags(root) {
   /** @type {unknown[]} Nodes still to visit. */
   const pending = [root];
   /** @type {Set<unknown>} Nodes already visited, so a cyclic value ends. */
   const seen = new Set();
   while (pending.length > 0) {
      /** @type {unknown} The node to visit. */
      const node = pending.pop();
      if (typeof node !== 'object' || node === null || seen.has(node)) {
         continue;
      }
      seen.add(node);
      if (Array.isArray(node)) {
         pending.push(...node);
         continue;
      }
      if (isPlainObject(node.flags) && Object.hasOwn(node.flags, FLAG_SCOPE)) {
         delete node.flags[FLAG_SCOPE];
      }
      pending.push(...Object.values(node));
   }
}

/**
 * Copy the `flags.wiretap` record of a live document and of its surviving embedded documents into the replacement,
 * in place. An embedded document survives when the replacement holds an element with the same `_id`; the schema finds
 * the embedded documents of every kind and depth (collections, a single embedded document, a token delta).
 * @param {Record<string, unknown>} replacement - The data that will be written.
 * @param {Record<string, unknown>} live - `toObject()` of the live document.
 * @param {{ schema: object }} documentClass - The class of both.
 * @returns {void}
 */
function carryWiretapFlags(replacement, live, documentClass) {
   walkEmbedded(documentClass, live, replacement, (model, liveData, replacementData) => {
      /** @type {unknown} The live record. */
      const record = liveData.flags?.[FLAG_SCOPE];
      if (replacementData !== undefined && record !== undefined) {
         replacementData.flags = {
            ...replacementData.flags,
            [FLAG_SCOPE]: structuredClone(record),
         };
      }
   });
}

/**
 * Count the embedded documents of every kind and depth that a replacement removes: those of the live data that the
 * replacement has no element with the same `_id` (or no value, for a single embedded document) for, with everything
 * inside them, and the same inside the documents that stay. Embedded data models that are not documents are not
 * counted.
 * @param {Record<string, unknown>} live - `toObject()` of the live document.
 * @param {Record<string, unknown>} replacement - The replacement data for the same document.
 * @param {{ schema: object }} documentClass - The class of both.
 * @returns {number} How many embedded documents are removed.
 */
function droppedEmbedded(live, replacement, documentClass) {
   /** @type {number} The documents removed so far. */
   let dropped = 0;
   walkEmbedded(documentClass, live, replacement, (model, liveData, replacementData) => {
      if (replacementData === undefined && model.documentName !== undefined) {
         dropped += 1;
      }
   });
   return dropped;
}

/**
 * Build the data an update writes from the data a caller gave, by the import steps above.
 * @param {Function} documentClass - The document class of the target.
 * @param {object} target - The live document.
 * @param {Record<string, unknown>} data - The data the caller gave.
 * @returns {Promise<Record<string, unknown>>} The replacement data, with the schema defaults of omitted fields.
 * @throws {ScriptError} `VALIDATION_FAILED` when Foundry rejects the data as invalid; any other error passes through.
 */
async function replacementOf(documentClass, target, data) {
   /** @type {Record<string, unknown>} A copy of the data that carries the running core version. */
   const source = foundry.utils.deepClone(data);
   source._stats = {
      ...source._stats,
      coreVersion: game.version,
   };
   /** @type {{ toObject: () => Record<string, unknown> }} The document built with strict validation. */
   let imported;
   try {
      imported = await documentClass.fromImport(source, {
         parent: target.parent,
         pack: target.pack,
      });
   } catch (error) {
      if (error instanceof foundry.data.validation.DataModelValidationError) {
         throw validationError(failuresOf(error, ''), 1, 1);
      }
      throw error;
   }
   /** @type {Record<string, unknown>} The data of the imported document. */
   const replacement = imported.toObject();
   delete replacement._id;
   delete replacement.sort;
   delete replacement.active;
   documentClass._clearFieldsRecursively(replacement, ['ownership']);
   for (const key of documentClass.metadata.preserveOnImport) {
      delete replacement[key];
   }
   delete replacement._stats;
   return replacement;
}

/**
 * Judge a replace with the write guard: the data as given, or the replacement that would be written.
 * @param {object} target - The live document.
 * @param {Record<string, unknown>} values - The data or the replacement.
 * @param {boolean} dryRun - Whether the replace is only previewed, which needs no `allowReplace` gate.
 * @param {boolean} [drops] - Whether the replacement removes embedded documents, which also needs `allowDelete`.
 * @returns {void}
 * @throws {ScriptError} `GATE_DENIED`.
 */
function guardReplace(target, values, dryRun, drops = false) {
   /** @type {string} The class of the document. */
   const documentName = target.documentName;
   guardWrite({
      documentName,
      operations: drops
         ? [
            'replace',
            'delete',
         ]
         : ['replace'],
      dryRun,
      values: [values],
      ...(documentName === 'Setting'
         ? {
            settingTargets: [
               settingKeyOf(target.key),
               ...('key' in values ? [settingKeyOf(values.key)] : []),
            ],
         }
         : {}),
      inPack: Boolean(target.pack),
   });
}

/**
 * Replace a document with the data given. See the file header for the exact semantics.
 * @param {ReplaceParams} params - What to replace.
 * @returns {Promise<ReplacedRow>} The acknowledgement: the uuid and the top-level fields written.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `PATH_UNSAFE_VALUE`, `GATE_DENIED`, `VALIDATION_FAILED`,
 * `ACT_AS_DENIED` or `WRITE_NOT_APPLIED`.
 */
export async function replaceDocument({ uuid, data, dryRun = false, readback = false, actAs }) {
   if (!isPlainObject(data)) {
      throw new ScriptError('ARGS_INVALID', 'data must be a JSON object.');
   }
   refuseUnsafeData(data);
   /** @type {Awaited<ReturnType<typeof resolveWritable>>} The live document to replace. */
   const target = await resolveWritable(uuid);
   /** @type {string} The class of the document. */
   const documentName = target.documentName;
   if (!CONST.PRIMARY_DOCUMENT_TYPES.includes(documentName)) {
      throw new ScriptError(
         'ARGS_INVALID',
         `${cleanForLog(documentName, 48)} cannot be replaced; use update_documents with op replace.`,
      );
   }
   if (documentName === 'User') {
      throw new ScriptError(
         'ARGS_INVALID',
         'A User cannot be replaced: the import resets role, permissions and password. Use update_documents.',
      );
   }
   /** @type {Record<string, unknown>} The data without any Wiretap record, which a caller cannot write. */
   const given = foundry.utils.deepClone(data);
   stripWiretapFlags(given);
   guardReplace(target, given, dryRun);
   /** @type {{ id: string, name?: string } | null} The advisory user, if any. */
   const actAsUser = resolveActAs(actAs);
   /** @type {Function} The configured document class of the target. */
   const documentClass = CONFIG[documentName].documentClass;
   /** @type {Record<string, unknown>} The data an update writes. */
   const replacement = await replacementOf(documentClass, target, given);
   /** @type {Record<string, unknown>} The live data. */
   const live = target.toObject();
   /** @type {number} How many embedded documents the replacement removes. */
   const dropped = droppedEmbedded(live, replacement, documentClass);
   guardReplace(target, replacement, dryRun, dropped > 0);
   carryWiretapFlags(replacement, live, documentClass);
   checkActAs(actAsUser, 'update', [
      {
         document: target,
         data: replacement,
      },
   ]);
   /** @type {string[]} The fields the replacement writes. */
   const changed = Object.keys(replacement);
   if (dryRun) {
      return {
         uuid: target.uuid,
         changed,
         dryRun: true,
         ...(dropped > 0 ? { dropped } : {}),
      };
   }
   /** @type {object | undefined} The updated document, or undefined when a hook cancelled the update. */
   const updated = await target.update(foundry.utils.deepClone(replacement), {
      diff: false,
      recursive: false,
   });
   if (updated === undefined) {
      throw new ScriptError('WRITE_NOT_APPLIED', 'A hook cancelled the replacement; nothing was written.');
   }
   /** @type {ReplacedRow} The acknowledgement. */
   const row = {
      uuid: target.uuid,
      changed,
      ...(dropped > 0 ? { dropped } : {}),
   };
   if (readback) {
      /** @type {ReturnType<typeof exportDocument>} The canonical export, or its refusal. */
      const exported = exportDocument(target, {});
      if (exported.ok) {
         row.exported = exported.data;
      }
   }
   return row;
}
