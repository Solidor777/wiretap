/**
 * The core write operations scripts call through `ctx.core`: create, update and delete documents of the live world.
 * Every operation follows one order, so nothing is written unless the whole call is acceptable:
 *
 * 1. The arguments are checked and every target is resolved.
 * 2. `guardWrite` judges the whole call (password rule, Wiretap setting rule, category gates).
 * 3. The input is validated by Foundry without writing (`DataModelValidationError.getAllFailures()`, see
 * `common/data/validation-failure.mjs:374`); failures return as one `VALIDATION_FAILED` error that carries at most
 * 10 failures and the true count.
 * 4. With `dryRun` the operation stops here and returns the would-be result; no create, update or delete API runs.
 * 5. Otherwise the Foundry document APIs run (`createDocuments`, `createEmbeddedDocuments`, `update`,
 * `updateEmbeddedDocuments`, `deleteDocuments`, `deleteEmbeddedDocuments`), so system and module pre-write logic
 * and hooks run exactly as for a write made in the UI.
 *
 * A call that touches several documents is not atomic once Foundry starts writing: a database error at a later
 * document leaves the earlier ones applied. An update reports it as `WRITE_NOT_APPLIED` naming how many were applied
 * and which; a create or delete reports a shortfall the same way.
 *
 * Step 3 is done here, ahead of Foundry's own validation, because the client database backend swallows validation
 * errors of a create or update: it shows a notification, skips the document and resolves with fewer documents
 * (`client/data/client-backend.mjs:76-123`, `:239-258`). Pre-validating is the only way to return the failures.
 */

import { getBudget } from '$shared/budgets.js';
import { OPERATOR_VALUE_MESSAGE, UNSAFE_SEGMENTS, findUnsafeValue, groupWrites } from '$shared/docPath.js';
import { cleanForLog } from '$shared/logText.js';
import { exportDocument, resolveDocument } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { createId } from '~/bridge/scripts/writeArgs.js';
import { applyIdempotency, withKeyLock } from '~/bridge/scripts/writeIdempotency.js';
import { checkActAs, resolveActAs } from '~/bridge/scripts/writeActAs.js';
import { FLAGS_KEY } from '$shared/writeKeys.js';
import { cleanChanges } from '~/bridge/scripts/writeFields.js';
import { guardWrite } from '~/bridge/scripts/writeGuard.js';

/**
 * Longest created or deleted name echoed in a row, in UTF-8 bytes; longer text is cut and control characters removed.
 * @type {number}
 */
const ROW_NAME_BYTES = 128;

/**
 * Longest subtype echoed in a row, in UTF-8 bytes.
 * @type {number}
 */
const ROW_TYPE_BYTES = 64;

/**
 * The text of a Setting key for the write guard. Only a string counts: an object or any other value is not a key, and
 * a `namespace` is never read, because Foundry's `Setting` schema has no such field and prunes it
 * (`common/documents/setting.mjs`), so the stored key is `key` alone.
 * @param {unknown} value - The `key` of Setting data, of a Setting document or of a key patch.
 * @returns {string | null} The key text, or null so the guard refuses the write.
 */
export function settingKeyOf(value) {
   return typeof value === 'string' ? value : null;
}

/**
 * Longest caller-supplied text echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const ECHO_MAX_BYTES = 48;

/**
 * Longest path or message of one reported validation failure, in UTF-8 bytes.
 * @type {number}
 */
const FAILURE_TEXT_MAX_BYTES = 160;

/**
 * @typedef {object} ValidationFailure
 * @property {string} path - Where the problem lies, for example `[0].system.hp`.
 * @property {string} message - What is wrong.
 */

/**
 * @typedef {object} CreateParams
 * @property {string} documentName - The document class to create.
 * @property {Record<string, unknown>[]} data - The data of each document.
 * @property {string} [parentUuid] - The uuid of the parent when the documents are embedded.
 * @property {string} [pack] - The id of the compendium pack when the documents are created in a pack.
 * @property {boolean} [keepId] - Keep the `_id` of each data object.
 * @property {boolean} [dryRun] - Validate and report; write nothing.
 * @property {boolean} [readback] - Add the canonical export of each created document as `exported`.
 * @property {string} [idempotencyKey] - A key that makes a repeated call return the first call's documents.
 * @property {string} [actAs] - The id of a user whose permission to create is checked in advance (advisory).
 * @property {unknown} [requestData] - The request as the caller gave it, hashed for `idempotencyKey` in place of
 * `data` when `data` was built from it (a copy's `{ fromUuids }`), so a source edited between two calls is no conflict.
 * @property {import('~/bridge/scripts/sizeNotes.js').SizeNotes} [sizeNotes] - The call's best-practice size notes;
 * the `idempotencyKey` lookup adds the size of the collection it reads.
 */

/**
 * @typedef {object} CreatedRow
 * @property {string | null} uuid - The uuid of the created document; null for a dry run.
 * @property {string} name - The name of the document, or the key of a Setting.
 * @property {string} type - The subtype, or an empty text.
 * @property {boolean} [dryRun] - True when nothing was written.
 * @property {Record<string, unknown>} [exported] - The canonical export, only when read-back was requested.
 * @property {true} [partial] - Set with `exported` when the export left part of the document out at a redaction bound.
 */

/**
 * Most failures one validation error contributes; the count is exact up to this bound.
 * @type {number}
 */
const FAILURES_COLLECT_MAX = 1000;

/**
 * Most failure nodes one walk visits.
 * @type {number}
 */
const FAILURE_NODES_MAX = 5000;

/**
 * Join a failure path and a child key.
 * @param {string} path - The path so far; empty at the root.
 * @param {string} key - A field name or an element id.
 * @returns {string} The child path.
 */
function joinPath(path, key) {
   return path === '' ? key : `${path}.${key}`;
}

/**
 * Collect the leaf failures of a validation error by walking the failure tree its `getFailure()` returns for no key
 * (the root `DataModelValidationFailure`, `common/data/validation-failure.mjs:100-160`). A node with nested field or
 * element failures is skipped in favour of its nested ones; a node with none is a leaf and is reported; a `joint`
 * message is reported at its node.
 * @param {unknown} error - The thrown validation error.
 * @returns {Array<{ path: string, message: string }>} The leaf failures with dotted field paths, in tree order.
 */
function walkFailureTree(error) {
   /** @type {Array<{ path: string, message: string }>} The failures found. */
   const found = [];
   /** @type {object | null} The root failure. */
   const root = typeof error?.getFailure === 'function' ? error.getFailure() : null;
   if (root === null || typeof root !== 'object') {
      return found;
   }
   /** @type {Array<{ node?: any, path: string, joint?: string }>} Entries still to visit; the next one is the last. */
   const pending = [
      {
         node: root,
         path: '',
      },
   ];
   /** @type {number} Count of failure nodes walked so far, bounded by the walk limit. */
   let visited = 0;
   while (pending.length > 0 && found.length < FAILURES_COLLECT_MAX && visited < FAILURE_NODES_MAX) {
      /** @type {{ node?: any, path: string, joint?: string }} The entry to visit. */
      const entry = pending.pop();
      if (entry.joint !== undefined) {
         found.push({
            path: entry.path,
            message: entry.joint,
         });
         continue;
      }
      visited += 1;
      /** @type {string} The joint message of the node; empty when it has none. */
      const joint = typeof entry.node.joint === 'string' ? entry.node.joint : '';
      /** @type {Array<[string, any]>} The nested failures, fields then elements. */
      const children = [
         ...Object.entries(entry.node.fields ?? {}),
         ...(entry.node.elements ?? []).map((element) => [String(element.id), element.failure]),
      ];
      if (children.length === 0 && joint === '') {
         found.push({
            path: entry.path,
            message: String(entry.node.message ?? 'is invalid'),
         });
         continue;
      }
      // The joint is reported after the nested failures, so it is pushed first; children are pushed in reverse so
      // the first child is visited first and the failures keep tree order.
      if (joint !== '') {
         pending.push({
            path: entry.path,
            joint,
         });
      }
      for (const [key, child] of children.reverse()) {
         pending.push({
            node: child,
            path: joinPath(entry.path, key),
         });
      }
   }
   return found;
}

/**
 * Collect the failures of a thrown validation error as path and message pairs. `getAllFailures()` is asked first
 * (`common/data/validation-failure.mjs:374`); on Foundry 14.364 it reports none for a real failure because its
 * aggregation drops every leaf, so the failure tree is walked then. An error with no failure at all is reported as one
 * failure at the prefix, with its own message.
 * @param {unknown} error - The thrown value.
 * @param {string} prefix - The path prefix, for example `[0]`.
 * @returns {ValidationFailure[]} The failures; never empty.
 */
export function failuresOf(error, prefix) {
   /** @type {Array<{ path: string, message: string }>} The raw failures. */
   let raw = [];
   try {
      /** @type {Record<string, { message?: unknown }>} The failure table of a validation error. */
      const table = typeof error?.getAllFailures === 'function' ? error.getAllFailures() : {};
      raw = Object.entries(table).map(([path, failure]) => ({
         path,
         message: String(failure?.message ?? 'is invalid'),
      }));
      if (raw.length === 0) {
         raw = walkFailureTree(error);
      }
   } catch {
      // A failure table that cannot be read is reported through the error message below.
   }
   if (raw.length === 0) {
      raw.push({
         path: '',
         message: String(error?.message ?? 'is invalid'),
      });
   }
   return raw.map((failure) => ({
      path: cleanForLog(
         prefix === '' || failure.path === '' ? `${prefix}${failure.path}` : `${prefix}.${failure.path}`,
         FAILURE_TEXT_MAX_BYTES,
      ),
      message: cleanForLog(failure.message, FAILURE_TEXT_MAX_BYTES),
   }));
}

/**
 * Build the error for a call whose input Foundry reports as invalid.
 * @param {ValidationFailure[]} failures - Every failure found.
 * @param {number} invalid - How many documents or updates failed.
 * @param {number} total - How many were checked.
 * @returns {ScriptError} A `VALIDATION_FAILED` error holding the first 10 failures and the true count.
 */
export function validationError(failures, invalid, total) {
   return new ScriptError(
      'VALIDATION_FAILED',
      `Validation failed: ${failures.length} invalid field${failures.length === 1 ? '' : 's'} in ${invalid} of ` +
         `${total} item${total === 1 ? '' : 's'}; nothing was written.`,
      {
         failures: failures.slice(0, getBudget('ERROR_MAX_FAILURES').value),
         failureCount: failures.length,
      },
   );
}

/**
 * Check the list a call carries: a non-empty array of plain objects.
 * @param {unknown} data - The list.
 * @param {string} label - What the entries are called in the error.
 * @returns {void}
 * @throws {ScriptError} `ARGS_INVALID`.
 */
function checkObjects(data, label) {
   if (!Array.isArray(data) || data.length === 0) {
      throw new ScriptError('ARGS_INVALID', `Give one or more ${label}.`);
   }
   for (const [index, entry] of data.entries()) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
         throw new ScriptError('ARGS_INVALID', `${label} ${index} must be an object.`);
      }
   }
}

/**
 * Refuse a data object whose keys or nesting are unsafe, or that spells an update operator anywhere (a `==` or `-=`
 * key prefix, a `__$OPERATOR$__` object): operators exist only through the `op` field of an update patch.
 * @param {unknown} item - A data object.
 * @returns {void}
 * @throws {ScriptError} `PATH_UNSAFE_VALUE` or `PATH_OPERATOR`.
 */
export function refuseUnsafeData(item) {
   /** @type {ReturnType<typeof findUnsafeValue>} What makes the data unsafe, if anything. */
   const unsafe = findUnsafeValue(item);
   if (unsafe === 'operator') {
      throw new ScriptError('PATH_OPERATOR', OPERATOR_VALUE_MESSAGE);
   }
   if (unsafe !== null) {
      throw new ScriptError(
         'PATH_UNSAFE_VALUE',
         unsafe === 'key'
            ? `Data keys may not use ${UNSAFE_SEGMENTS.join(', ')} or an Object.prototype name, dotted or not.`
            : 'Data may be nested at most 32 levels.',
      );
   }
}

/**
 * Resolve where a create lands.
 * @param {string} documentName - The class to create.
 * @param {string | undefined} parentUuid - The parent uuid, for embedded documents.
 * @param {string | undefined} pack - The pack id, for documents created in a pack.
 * @returns {Promise<{ parent: object | null, pack: string | null, inPack: boolean }>}
 * The parent, the pack and whether the write lands in a pack.
 * @throws {ScriptError} `ARGS_INVALID` or `DOC_NOT_FOUND`.
 */
async function resolveCreateTarget(documentName, parentUuid, pack) {
   if (!CONST.ALL_DOCUMENT_TYPES.includes(documentName)) {
      throw new ScriptError('ARGS_INVALID', `Unknown documentName '${cleanForLog(documentName, ECHO_MAX_BYTES)}'.`);
   }
   if (pack !== undefined && parentUuid !== undefined) {
      throw new ScriptError('ARGS_INVALID', 'pack and parentUuid exclude each other.');
   }
   if (parentUuid !== undefined) {
      /** @type {{ documentName: string, constructor: object, pack?: string }} The parent document. */
      const parent = await resolveDocument({ uuid: parentUuid });
      if (parent.constructor.metadata?.embedded?.[documentName] === undefined) {
         throw new ScriptError('ARGS_INVALID', `${parent.documentName} does not embed ${documentName}.`);
      }
      return {
         parent,
         pack: null,
         inPack: Boolean(parent.pack),
      };
   }
   if (pack !== undefined) {
      /** @type {{ documentName: string } | undefined} The compendium collection named by the pack argument. */
      const compendium = game.packs.get(pack);
      if (compendium === undefined) {
         throw new ScriptError('ARGS_INVALID', `No pack '${cleanForLog(pack, ECHO_MAX_BYTES)}'.`);
      }
      if (compendium.documentName !== documentName) {
         throw new ScriptError('ARGS_INVALID', `Pack '${cleanForLog(pack, ECHO_MAX_BYTES)}' holds another class.`);
      }
      return {
         parent: null,
         pack,
         inPack: true,
      };
   }
   if (!CONST.WORLD_DOCUMENT_TYPES.includes(documentName)) {
      throw new ScriptError('ARGS_INVALID', `${documentName} is embedded: give parentUuid, or a pack.`);
   }
   return {
      parent: null,
      pack: null,
      inPack: false,
   };
}

/**
 * Refuse `keepId` data whose `_id` is already taken in the collection it would land in, with one early `ARGS_INVALID`.
 * Foundry 14.364's server `_createDocuments` (`dist/database/backend/server-backend.mjs`) throws "The _id [..] already
 * exists within the parent collection" for a taken embedded id (MEASURED: the create rejects with that text and the
 * stored item is unchanged) and has no such check for a top-level document: a taken world id resolves and overwrites
 * the stored document (MEASURED), and the client's world collection then holds the new document under that id.
 * @param {string} documentName - The class created.
 * @param {Awaited<ReturnType<typeof resolveCreateTarget>>} target - Where the documents land.
 * @param {Record<string, unknown>[]} data - The data of each document.
 * @returns {Promise<void>} Resolves when no `_id` is taken.
 * @throws {ScriptError} `ARGS_INVALID` for an `_id` that exists, or that the call gives twice.
 */
async function refuseTakenIds(documentName, target, data) {
   /** @type {Set<string>} The ids seen in this call. */
   const seen = new Set();
   /** @type {{ index?: { has: (id: string) => boolean }, getIndex?: Function } | undefined} The pack, if any. */
   const compendium = target.pack === null ? undefined : game.packs.get(target.pack);
   await compendium?.getIndex?.();
   for (const item of data) {
      /** @type {unknown} The id the data asks to keep. */
      const id = item._id;
      if (typeof id !== 'string' || id === '') {
         continue;
      }
      /** @type {string} The id as it is shown in a message. */
      const shown = cleanForLog(id, ECHO_MAX_BYTES);
      if (seen.has(id)) {
         throw new ScriptError('ARGS_INVALID', `keepId: the _id '${shown}' is given twice in this call.`);
      }
      seen.add(id);
      /** @type {boolean} Whether a document of that class already has the id. */
      const taken =
         target.parent !== null
            ? target.parent.getEmbeddedCollection(documentName).get(id) !== undefined
            : compendium === undefined
               ? game.collections.get(documentName)?.get(id) !== undefined
               : compendium.index?.has(id) === true;
      if (taken) {
         throw new ScriptError(
            'ARGS_INVALID',
            `keepId: ${documentName} '${shown}' already exists. Use update_documents or ` +
               'replace_document, or leave out keepId.',
         );
      }
   }
}

/**
 * Build the row that acknowledges one document.
 * @param {{ uuid: string | null, name?: unknown, key?: unknown, type?: unknown }} document - The document, or the
 * in-memory document of a dry run.
 * @param {boolean} dryRun - Whether nothing was written.
 * @returns {CreatedRow} The acknowledgement of the document.
 */
export function rowOf(document, dryRun) {
   return {
      uuid: dryRun ? null : document.uuid,
      name: cleanForLog(String(document.name ?? document.key ?? ''), ROW_NAME_BYTES),
      type: cleanForLog(String(document.type ?? ''), ROW_TYPE_BYTES),
      ...(dryRun ? { dryRun: true } : {}),
   };
}

/**
 * @typedef {object} CreatePlan
 * @property {string} documentName - The class created.
 * @property {Awaited<ReturnType<typeof resolveCreateTarget>>} target - Where the documents land.
 * @property {object[]} built - The in-memory documents the data builds.
 * @property {Record<string, unknown>[]} payload - The data to send, copies that carry the idempotency record.
 * @property {boolean} keepId - Whether the `_id` of each data object is kept; always true under an idempotency key,
 * which gives each document the id its record names.
 * @property {CreatedRow[] | null} replay - The rows of the documents an earlier call with the same idempotency key
 * created; when set nothing is to be written.
 * @property {object[]} replayDocuments - The live documents behind `replay`, in the same order.
 */

/**
 * Check, guard and validate the creation of documents of one class without writing. The whole call is judged before
 * any write: arguments, target, the write guard, the idempotency record, Foundry validation and the `actAs` check.
 * @param {object} params - What to create.
 * @param {string} params.documentName - The document class to create.
 * @param {Record<string, unknown>[]} params.data - The data of each document.
 * @param {string} [params.parentUuid] - The uuid of the parent when the documents are embedded.
 * @param {string} [params.pack] - The id of the compendium pack when the documents are created in a pack.
 * @param {boolean} [params.keepId] - Keep the `_id` of each data object.
 * @param {string} [params.idempotencyKey] - The key that makes a repeated call return the first call's documents.
 * @param {unknown} [params.requestData] - What the idempotency hash reads in place of `data`, when given.
 * @param {object | null} [params.actAsUser] - The user whose permission is checked in advance, if any.
 * @param {string} [params.prefix] - The path prefix of reported failures, for example `creates[1]`.
 * @param {import('~/bridge/scripts/sizeNotes.js').SizeNotes} [params.sizeNotes] - The call's best-practice size
 * notes, given to the idempotency lookup.
 * @returns {Promise<CreatePlan>} The plan to run.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `GATE_DENIED`, `VALIDATION_FAILED`, `ACT_AS_DENIED` or
 * `IDEMPOTENCY_CONFLICT`.
 */
export async function prepareCreate({
   documentName,
   data,
   parentUuid,
   pack,
   keepId = false,
   idempotencyKey,
   requestData,
   actAsUser = null,
   prefix = '',
   sizeNotes,
}) {
   checkObjects(data, 'documents');
   for (const item of data) {
      refuseUnsafeData(item);
   }
   /** @type {Awaited<ReturnType<typeof resolveCreateTarget>>} Where the documents land. */
   const target = await resolveCreateTarget(documentName, parentUuid, pack);
   guardWrite({
      documentName,
      values: data,
      ...(documentName === 'Setting' ? { settingTargets: data.map((item) => settingKeyOf(item.key)) } : {}),
      inPack: target.inPack,
   });
   /** @type {Record<string, unknown>[]} The data with the idempotency record added. */
   let records = data;
   /** @type {boolean} Whether the documents are created with the ids the idempotency records name. */
   let keptIds = keepId;
   if (idempotencyKey !== undefined) {
      if (target.pack !== null) {
         throw new ScriptError('ARGS_INVALID', 'An idempotencyKey does not apply to documents created in a pack.');
      }
      if (CONFIG[documentName].documentClass.schema.getField(FLAGS_KEY) === undefined) {
         // The record is a flag of the document; Foundry prunes it from a class with no `flags` field.
         throw new ScriptError(
            'ARGS_INVALID',
            `An idempotencyKey does not apply to ${documentName}: it has no flags field to carry the record.`,
         );
      }
      /** @type {ReturnType<typeof applyIdempotency>} The earlier documents, or the records to write. */
      const idempotent = applyIdempotency({
         key: idempotencyKey,
         documentName,
         parent: target.parent,
         request: [
            documentName,
            parentUuid ?? null,
            keepId,
            requestData ?? data,
         ],
         data,
         keepId,
         sizeNotes,
      });
      if (idempotent.replay !== null) {
         checkActAs(
            actAsUser,
            'create',
            idempotent.replay.map((document, index) => ({
               document,
               data: data[index],
            })),
         );
         return {
            documentName,
            target,
            built: [],
            payload: [],
            keepId,
            replay: idempotent.replay.map((document) => rowOf(document, false)),
            replayDocuments: idempotent.replay,
         };
      }
      records = idempotent.records;
      keptIds = true;
   }
   // The taken-id check follows the key lookup: a keyed retry finds the ids its first call took and replays above,
   // while a call with no matching record is still refused here before any write.
   if (keepId) {
      await refuseTakenIds(documentName, target, data);
   }
   /** @type {Function} The configured document class. */
   const documentClass = CONFIG[documentName].documentClass;
   /** @type {object[]} The in-memory documents the data builds. */
   const built = [];
   /** @type {ValidationFailure[]} Every failure found. */
   const failures = [];
   /** @type {number} How many entries failed. */
   let invalid = 0;
   /** @type {Record<string, unknown>[]} The data the caller gave, after cleaning, for the guard. */
   const cleanedItems = [];
   for (const [index, item] of records.entries()) {
      try {
         /** @type {Record<string, unknown>} The data cleaned the way the database backend cleans a creation. */
         const cleaned = documentClass.cleanData(foundry.utils.deepClone(item), { partial: true }, { creation: true });
         // The idempotency record is Wiretap's own write and the guard must not judge it, so the caller's data is
         // cleaned alone when the records differ from it.
         cleanedItems.push(
            records === data
               ? cleaned
               : documentClass.cleanData(foundry.utils.deepClone(data[index]), { partial: true }, { creation: true }),
         );
         built.push(
            new documentClass(foundry.utils.deepClone(cleaned), {
               parent: target.parent,
               pack: target.pack,
               creation: true,
               clean: {
                  migrate: false,
                  sanitize: false,
               },
            }),
         );
      } catch (error) {
         invalid += 1;
         failures.push(...failuresOf(error, `${prefix}[${index}]`));
      }
   }
   // The cleaned data is judged again: whatever spelling reached an operator, it is an operator object now.
   guardWrite({
      documentName,
      values: cleanedItems,
      ...(documentName === 'Setting' ? { settingTargets: cleanedItems.map((item) => settingKeyOf(item.key)) } : {}),
      inPack: target.inPack,
   });
   if (failures.length > 0) {
      throw validationError(failures, invalid, data.length);
   }
   checkActAs(
      actAsUser,
      'create',
      built.map((document, index) => ({
         document,
         data: records[index],
      })),
   );
   return {
      documentName,
      target,
      built,
      payload: records.map((item) => foundry.utils.deepClone(item)),
      keepId: keptIds,
      replay: null,
      replayDocuments: [],
   };
}

/**
 * Write a prepared creation through the Foundry document APIs.
 *
 * Foundry answers a create in an order of its own: the server's `_createDocuments`
 * (`dist/database/backend/server-backend.mjs`) builds each document inside `Promise.all`, pushing it only after
 * `await createNewId()` (`sublevel-database.mjs`, a database lookup) resolves, so documents whose ids the server
 * generates come back in the order those lookups finish. World, embedded and pack creates all take that path. Every
 * document is therefore sent with an id: the kept `_id` under `keepId`, otherwise a fresh `foundry.utils.randomID()`
 * in place of any `_id` the data holds, which is what the server would do (it ignores that `_id` without `keepId`).
 * The created documents are then matched to the data by id.
 * @param {CreatePlan} plan - A plan from `prepareCreate` with no replay.
 * @param {boolean} [readback] - Add the canonical export of each created document as `exported`.
 * @returns {Promise<CreatedRow[]>} One row per document, row i for data i, whatever order Foundry answers in.
 * @throws {ScriptError} `WRITE_NOT_APPLIED` when Foundry created fewer documents than asked.
 */
export async function runCreate(plan, readback = false) {
   /** @type {Function} The configured document class. */
   const documentClass = CONFIG[plan.documentName].documentClass;
   /** @type {Record<string, unknown>[]} The data to send, each with the id its document is created with. */
   const payload = plan.payload.map((item) => ({
      ...item,
      _id: createId(item, plan.keepId),
   }));
   /** @type {{ id: string, uuid: string }[]} The documents that were created, in the order Foundry answered. */
   const created = plan.target.parent
      ? await plan.target.parent.createEmbeddedDocuments(plan.documentName, payload, { keepId: true })
      : await documentClass.createDocuments(payload, {
         keepId: true,
         ...(plan.target.pack === null ? {} : { pack: plan.target.pack }),
      });
   if (created.length !== payload.length) {
      throw new ScriptError(
         'WRITE_NOT_APPLIED',
         `${created.length} of ${payload.length} documents were created; a hook or the system cancelled the rest.`,
      );
   }
   /** @type {Map<string, { id: string, uuid: string }>} The created documents by id. */
   const byId = new Map(created.map((document) => [
      document.id,
      document,
   ]));
   return payload.map((item) => byId.get(item._id)).map((document) => {
      /** @type {CreatedRow} The acknowledgement of this document. */
      const row = rowOf(document, false);
      if (readback) {
         /** @type {ReturnType<typeof exportDocument>} The canonical export, or its refusal. */
         const exported = exportDocument(document, {});
         if (exported.ok) {
            row.exported = exported.data;
            if (exported.partial === true) {
               row.partial = true;
            }
         }
      }
      return row;
   });
}

/**
 * Create documents of one class: world documents, embedded documents under a parent, or documents in a pack. The
 * whole call is guarded and validated before the first write, and a dry run stops before it. With an
 * `idempotencyKey`, a repeated call returns the rows of the documents the first call created, and calls with one key
 * run one after another.
 * @param {CreateParams} params - What to create.
 * @returns {Promise<CreatedRow[]>} One row per document, in the order of `data`.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `GATE_DENIED`, `VALIDATION_FAILED`, `ACT_AS_DENIED`,
 * `IDEMPOTENCY_CONFLICT` or `WRITE_NOT_APPLIED`.
 */
export async function createDocuments(params) {
   if (params.idempotencyKey === undefined) {
      return createChecked(params);
   }
   return withKeyLock(`${params.documentName}|${params.parentUuid ?? ''}|${params.idempotencyKey}`, () =>
      createChecked(params),
   );
}

/**
 * Check, then write or preview, one create call. `createDocuments` runs it, under the key lock when the call has an
 * idempotency key.
 * @param {CreateParams} params - What to create.
 * @returns {Promise<CreatedRow[]>} One row per document, in the order of `data`.
 * @throws {ScriptError} As `createDocuments`.
 */
async function createChecked({
   documentName,
   data,
   parentUuid,
   pack,
   keepId = false,
   dryRun = false,
   readback = false,
   idempotencyKey,
   actAs,
   requestData,
   sizeNotes,
}) {
   /** @type {CreatePlan} The checked plan. */
   const plan = await prepareCreate({
      documentName,
      data,
      parentUuid,
      pack,
      keepId,
      idempotencyKey,
      requestData,
      actAsUser: resolveActAs(actAs),
      sizeNotes,
   });
   if (plan.replay !== null) {
      return plan.replay.map((row, index) => {
         /** @type {ReturnType<typeof exportDocument>} The export of the existing document, when asked for. */
         const exported = readback && !dryRun ? exportDocument(plan.replayDocuments[index], {}) : { ok: false };
         return {
            ...row,
            ...(dryRun
               ? {
                  dryRun: true,
                  replay: true,
               }
               : {}),
            ...(exported.ok ? { exported: exported.data } : {}),
            ...(exported.ok && exported.partial === true ? { partial: true } : {}),
         };
      });
   }
   if (dryRun) {
      return plan.built.map((document) => rowOf(document, true));
   }
   return runCreate(plan, readback);
}

/**
 * @typedef {object} UpdatePatch
 * @property {string} path - The dotted path, relative to the document (`items.<_id>.system.x` for an embedded one).
 * @property {unknown} [value] - The new value; absent for `op: 'delete'`.
 * @property {'set' | 'replace' | 'delete'} [op] - `set` merges (the default), `replace` swaps the whole value
 * (Foundry's `ForcedReplacement`) and `delete` removes the field (`ForcedDeletion`).
 */

/**
 * @typedef {object} UpdateEntry
 * @property {string} uuid - The document to update, a world, embedded or pack document.
 * @property {UpdatePatch[]} patches - The path-scoped writes.
 */

/**
 * @typedef {object} UpdateParams
 * @property {UpdateEntry[]} updates - One entry per document; a uuid may appear once.
 * @property {boolean} [dryRun] - Validate and report; write nothing.
 * @property {boolean} [readback] - Add the canonical export of each updated document as `exported`.
 * @property {string} [actAs] - The id of a user whose permission to update is checked in advance (advisory).
 */

/**
 * @typedef {object} UpdatedRow
 * @property {string} uuid - The updated document.
 * @property {string[]} changed - The paths Foundry applied; empty when it applied none (the values were unchanged, or
 * a hook cancelled the update). For a dry run, the paths that would be written.
 * @property {boolean} [dryRun] - True when nothing was written.
 * @property {Record<string, unknown>} [exported] - The canonical export, only when read-back was requested.
 * @property {true} [partial] - Set with `exported` when the export left part of the document out at a redaction bound.
 */

/**
 * @typedef {object} EmbeddedPlan
 * @property {string} documentName - The embedded document class, for example `Item`.
 * @property {string} collection - The collection name as written in the paths, for example `items`.
 * @property {Array<{ _id: string, document: object, changes: Record<string, unknown>, paths: string[] }>} entries -
 * One entry per embedded document.
 */

/**
 * @typedef {object} UpdatePlan
 * @property {object} document - The live document.
 * @property {UpdatePatch[]} patches - The patches in the order given.
 * @property {Record<string, unknown>} changes - The changes on the document itself, by dotted key.
 * @property {string[]} paths - The paths of the changes on the document itself.
 * @property {EmbeddedPlan[]} embedded - The changes on embedded documents, per collection.
 */

/**
 * Build the Foundry change value of one patch: the plain value, `ForcedReplacement.create(value)` or a
 * `ForcedDeletion`. The operators cannot cross the JSON wire, so they are built here
 * (`common/data/operators.mjs`, `client/client.mjs:65-81`).
 * @param {{ op?: string, value?: unknown }} change - The patch, relative to its document.
 * @returns {unknown} The value to put in the change object.
 */
function changeValue(change) {
   if (change.op === 'delete') {
      return new foundry.data.operators.ForcedDeletion();
   }
   /** @type {unknown} A copy of the value, so Foundry cannot mutate the caller's data. */
   const value = foundry.utils.deepClone(change.value);
   return change.op === 'replace' ? foundry.data.operators.ForcedReplacement.create(value) : value;
}

/**
 * Turn the changes of a path group into a change object.
 * @param {Array<{ path: string, value?: unknown, op?: string }>} changes - The changes, relative to one document.
 * @returns {Record<string, unknown>} The change object, keyed by dotted path.
 */
function changeObject(changes) {
   /** @type {Record<string, unknown>} The change object. */
   const result = {};
   for (const change of changes) {
      Object.defineProperty(result, change.path, {
         value: changeValue(change),
         enumerable: true,
         writable: true,
         configurable: true,
      });
   }
   return result;
}

/**
 * Resolve one update entry to a plan: its document, the grouped paths and the embedded documents they address.
 * @param {UpdateEntry} entry - One document's grouped patches.
 * @returns {Promise<UpdatePlan>} The resolved target and parsed patches of the entry.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND` or a `PATH_*` code of the path grammar.
 */
async function planUpdate(entry) {
   if (typeof entry.uuid !== 'string' || !Array.isArray(entry.patches)) {
      throw new ScriptError('ARGS_INVALID', 'Each update needs a uuid and a list of patches.');
   }
   /**
    * The live document the entry targets.
    * @type {{ uuid: string, constructor: { metadata?: { embedded?: Record<string, string> } } }}
    */
   const document = await resolveWritable(entry.uuid);
   /** @type {Record<string, string>} The embedded collections: document name to collection name. */
   const children = document.constructor.metadata?.embedded ?? {};
   /** @type {ReturnType<typeof groupWrites>} The patches grouped by the document they address. */
   const grouped = groupWrites(entry.patches, Object.values(children));
   if (!grouped.ok) {
      throw new ScriptError(grouped.error.code, grouped.error.message);
   }
   /** @type {EmbeddedPlan[]} The embedded plans. */
   const embedded = [];
   for (const group of grouped.embedded) {
      /** @type {string} The embedded document class of this collection. */
      const documentName = Object.keys(children).find((name) => children[name] === group.collection);
      /** @type {EmbeddedPlan['entries']} The entries of this collection. */
      const entries = [];
      for (const item of group.entries) {
         /** @type {object | undefined} The embedded document. */
         const child = document.getEmbeddedCollection(documentName).get(item._id);
         if (child === undefined) {
            throw new ScriptError(
               'DOC_NOT_FOUND',
               `No ${documentName} '${cleanForLog(item._id, ECHO_MAX_BYTES)}' in ${cleanForLog(entry.uuid, 80)}.`,
            );
         }
         entries.push({
            _id: item._id,
            document: child,
            changes: changeObject(item.changes),
            paths: item.changes.map((change) => `${group.collection}.${item._id}.${change.path}`),
         });
      }
      embedded.push({
         documentName,
         collection: group.collection,
         entries,
      });
   }
   return {
      document,
      patches: entry.patches,
      changes: changeObject(grouped.document),
      paths: grouped.document.map((change) => change.path),
      embedded,
   };
}

/**
 * Judge an update plan with the write guard.
 * @param {UpdatePlan} plan - The resolved update plan of one document.
 * @param {boolean} dryRun - Whether the update is only previewed, which needs no `allowDelete` or `allowReplace`.
 * @returns {void}
 * @throws {ScriptError} `GATE_DENIED`.
 */
function guardUpdate(plan, dryRun) {
   /** @type {string} The class of the document. */
   const documentName = plan.document.documentName;
   // Each document written with its changes cleaned as the database backend cleans them, so the guard sees every
   // operator spelling as an operator object.
   /** @type {Array<{ document: object, changes: Record<string, unknown> }>} The documents and their changes. */
   const targets = plan.embedded.flatMap((group) =>
      group.entries.map((item) => ({
         document: item.document,
         changes: cleanChanges(item.document, item.changes),
      })));
   if (plan.paths.length > 0) {
      targets.unshift({
         document: plan.document,
         changes: cleanChanges(plan.document, plan.changes),
      });
   }
   guardWrite({
      documentName,
      targets,
      dryRun,
      // Each patch is judged as the dotted-key object it writes (a delete writes null), so a password, ownership or
      // flag-scope segment in the path counts, and a `flags` path with a value that is not an object is caught.
      values: plan.patches.map((patch) => ({ [patch.path]: patch.op === 'delete' ? null : patch.value })),
      ...(documentName === 'Setting'
         ? {
            settingTargets: [
               settingKeyOf(plan.document.key),
               ...(plan.paths.length > 0 && 'key' in targets[0].changes
                  ? [settingKeyOf(foundry.data.operators.DataFieldOperator.get(targets[0].changes.key))]
                  : []),
            ],
         }
         : {}),
      inPack: Boolean(plan.document.pack),
   });
}

/**
 * Validate the changes of a plan without writing them.
 * @param {UpdatePlan} plan - The resolved update plan of one document.
 * @param {number} index - The position of the update in the call.
 * @param {ValidationFailure[]} failures - Receives the failures found.
 * @param {string} [prefix] - The path prefix of reported failures, for example `updates`.
 * @returns {boolean} Whether the update failed validation.
 */
function validateUpdate(plan, index, failures, prefix = '') {
   /** @type {number} The failure count before this update. */
   const before = failures.length;
   if (plan.paths.length > 0) {
      try {
         plan.document.validate({
            changes: plan.changes,
            strict: true,
         });
      } catch (error) {
         failures.push(...failuresOf(error, `${prefix}[${index}]`));
      }
   }
   for (const group of plan.embedded) {
      for (const item of group.entries) {
         try {
            item.document.validate({
               changes: item.changes,
               strict: true,
            });
         } catch (error) {
            failures.push(...failuresOf(error, `${prefix}[${index}].${group.collection}.${item._id}`));
         }
      }
   }
   return failures.length > before;
}

/**
 * Apply one plan through the Foundry document APIs and report which paths Foundry applied.
 * @param {UpdatePlan} plan - The resolved update plan of one document.
 * @returns {Promise<string[]>} The applied paths, in the order of the patches.
 */
async function applyUpdate(plan) {
   /** @type {Set<string>} The paths Foundry applied. */
   const applied = new Set();
   if (plan.paths.length > 0) {
      /** @type {object | undefined} The updated document, or undefined when nothing was applied. */
      const updated = await plan.document.update(plan.changes);
      if (updated !== undefined) {
         for (const path of plan.paths) {
            applied.add(path);
         }
      }
   }
   for (const group of plan.embedded) {
      /** @type {object[]} The updated embedded documents. */
      const updated = await plan.document.updateEmbeddedDocuments(
         group.documentName,
         group.entries.map((item) => ({
            ...item.changes,
            _id: item._id,
         })),
      );
      /** @type {Set<string>} The ids Foundry updated. */
      const ids = new Set(updated.filter((document) => document !== undefined).map((document) => document.id));
      for (const item of group.entries) {
         if (ids.has(item._id)) {
            for (const path of item.paths) {
               applied.add(path);
            }
         }
      }
   }
   return plan.patches.map((patch) => patch.path).filter((path) => applied.has(path));
}

/**
 * Resolve, guard and validate updates without writing. Every update is resolved to a plan, the plans are judged by
 * the write guard, validated by Foundry and checked for the `actAs` user, all before the first write.
 * @param {UpdateEntry[]} updates - One entry per document.
 * @param {object} [options] - How to check.
 * @param {object | null} [options.actAsUser] - The user whose permission is checked in advance, if any.
 * @param {string} [options.prefix] - The path prefix of reported failures, for example `updates`.
 * @param {boolean} [options.dryRun] - Whether the updates are only previewed.
 * @returns {Promise<UpdatePlan[]>} The plans, in the order given.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, a `PATH_*` code, `GATE_DENIED`, `VALIDATION_FAILED` or
 * `ACT_AS_DENIED`.
 */
export async function prepareUpdates(updates, { actAsUser = null, prefix = '', dryRun = false } = {}) {
   checkObjects(updates, 'updates');
   /** @type {UpdatePlan[]} The plans, in the order given. */
   const plans = [];
   /** @type {Set<string>} The canonical uuids of every document the plans write, embedded ones included. */
   const seen = new Set();
   for (const entry of updates) {
      /** @type {UpdatePlan} The plan of this entry. */
      const plan = await planUpdate(entry);
      for (const identity of [
         plan.document.uuid,
         ...plan.embedded.flatMap((group) => group.entries.map((item) => item.document.uuid)),
      ]) {
         if (seen.has(identity)) {
            throw new ScriptError(
               'ARGS_INVALID',
               'A document may be written once per call: give all its patches in one entry.',
            );
         }
         seen.add(identity);
      }
      plans.push(plan);
   }
   for (const plan of plans) {
      guardUpdate(plan, dryRun);
   }
   /** @type {ValidationFailure[]} Every failure found. */
   const failures = [];
   /** @type {number} How many updates failed. */
   let invalid = 0;
   for (const [index, plan] of plans.entries()) {
      if (validateUpdate(plan, index, failures, prefix)) {
         invalid += 1;
      }
   }
   if (failures.length > 0) {
      throw validationError(failures, invalid, plans.length);
   }
   for (const plan of plans) {
      /** @type {Array<{ document: object, data: Record<string, unknown> }>} The documents the plan updates. */
      const targets = plan.embedded.flatMap((group) =>
         group.entries.map((item) => ({
            document: item.document,
            data: item.changes,
         })),
      );
      if (plan.paths.length > 0) {
         targets.unshift({
            document: plan.document,
            data: plan.changes,
         });
      }
      checkActAs(actAsUser, 'update', targets);
   }
   return plans;
}

/**
 * Build the error text of an update that failed after earlier updates were applied.
 * @param {unknown} error - What the failing update threw.
 * @param {number} index - The position of the failing update in the call.
 * @param {number} total - How many updates the call carried.
 * @param {UpdatedRow[]} applied - The rows of the updates already applied.
 * @returns {string} The text, at most 256 bytes: the failure first, then the uuids that were applied.
 */
function notAppliedMessage(error, index, total, applied) {
   /** @type {string} The reason, cleaned and bounded. */
   const reason = cleanForLog(String(error?.message ?? error), 80);
   /** @type {string} The applied uuids, as many as fit. */
   const uuids = applied.map((row) => row.uuid).join(', ');
   return cleanForLog(`Update [${index}] failed (${reason}); ${applied.length} of ${total} applied: ${uuids}`, 256);
}

/**
 * Write prepared updates through the Foundry document APIs, one plan after another, or report them as a dry run.
 * @param {UpdatePlan[]} plans - The plans from `prepareUpdates`.
 * @param {object} [options] - How to run.
 * @param {boolean} [options.dryRun] - Report the paths that would be written and write nothing.
 * @param {boolean} [options.readback] - Add the canonical export of each updated document as `exported`.
 * @returns {Promise<UpdatedRow[]>} One row per update, in the order given.
 * @throws {ScriptError} `WRITE_NOT_APPLIED` when a later update fails after earlier ones were applied.
 */
export async function runUpdates(plans, { dryRun = false, readback = false } = {}) {
   /** @type {UpdatedRow[]} The acknowledgements. */
   const rows = [];
   for (const [index, plan] of plans.entries()) {
      /** @type {string[]} The paths written, or that would be written. */
      let changed;
      try {
         changed = dryRun ? plan.patches.map((patch) => patch.path) : await applyUpdate(plan);
      } catch (error) {
         if (rows.length === 0) {
            throw error;
         }
         throw new ScriptError('WRITE_NOT_APPLIED', notAppliedMessage(error, index, plans.length, rows));
      }
      /** @type {UpdatedRow} The acknowledgement of this document. */
      const row = {
         uuid: plan.document.uuid,
         changed,
         ...(dryRun ? { dryRun: true } : {}),
      };
      if (readback && !dryRun) {
         /** @type {ReturnType<typeof exportDocument>} The canonical export, or its refusal. */
         const exported = exportDocument(plan.document, {});
         if (exported.ok) {
            row.exported = exported.data;
            if (exported.partial === true) {
               row.partial = true;
            }
         }
      }
      rows.push(row);
   }
   return rows;
}

/**
 * Update documents with path-scoped patches. Every update is resolved, guarded and validated before the first write,
 * and a dry run stops before it. A database error at a later update leaves the earlier ones applied.
 * @param {UpdateParams} params - What to update.
 * @returns {Promise<UpdatedRow[]>} One row per update, in the order given.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, a `PATH_*` code, `GATE_DENIED`, `VALIDATION_FAILED`,
 * `ACT_AS_DENIED` or `WRITE_NOT_APPLIED`.
 */
export async function updateDocuments({ updates, dryRun = false, readback = false, actAs }) {
   /** @type {UpdatePlan[]} The checked plans. */
   const plans = await prepareUpdates(updates, {
      actAsUser: resolveActAs(actAs),
      dryRun,
   });
   return runUpdates(plans, {
      dryRun,
      readback,
   });
}

/**
 * Most rows a delete preview lists; the true total is reported beside them.
 * @type {number}
 */
export const DELETE_PREVIEW_ROWS_MAX = 500;

/**
 * Longest name in a delete row, in UTF-8 bytes.
 * @type {number}
 */
const ROW_NAME_MAX_BYTES = 64;

/**
 * Matches the uuid of a compendium pack itself (`Compendium.<scope>.<name>`), which is not a document.
 * @type {RegExp}
 */
const PACK_UUID = /^Compendium\.[^.]+\.[^.]+$/;

/**
 * @typedef {object} DeleteParams
 * @property {string[]} uuids - The documents to delete: world, embedded or pack documents.
 * @property {boolean} [dryRun] - List what would be deleted; delete nothing.
 * @property {string} [actAs] - The id of a user whose permission to delete is checked in advance (advisory).
 */

/**
 * @typedef {object} DeletePreview
 * @property {true} dryRun - Marks the result as a preview.
 * @property {Array<[string, string, string]>} rows - `[uuid, name, type]` of each document that would be deleted,
 * the named documents first and their embedded descendants after each.
 * @property {number} total - How many documents would be deleted in all.
 * @property {boolean} [cut] - True when `rows` is shorter than `total`.
 */

/**
 * Describe one document as a `[uuid, name, type]` row.
 * @param {{ uuid: string, name?: unknown, key?: unknown, type?: unknown }} document -
 * The live document that would be deleted.
 * @returns {[string, string, string]} The uuid, name and type of the document.
 */
function previewRow(document) {
   return [
      document.uuid,
      cleanForLog(String(document.name ?? document.key ?? ''), ROW_NAME_MAX_BYTES),
      String(document.type ?? ''),
   ];
}

/**
 * Resolve one uuid to a live document that a write can target, refusing the uuid of a compendium pack and a value that
 * is not a document.
 * @param {unknown} uuid - The uuid given by the caller.
 * @returns {Promise<{ id: string, uuid: string, documentName: string }>} The live document.
 * @throws {ScriptError} `ARGS_INVALID` or `DOC_NOT_FOUND`.
 */
export async function resolveWritable(uuid) {
   if (typeof uuid !== 'string' || PACK_UUID.test(uuid)) {
      throw new ScriptError('ARGS_INVALID', 'A compendium pack is not a document; give document uuids.');
   }
   /** @type {{ id?: unknown, uuid?: unknown, delete?: unknown }} The resolved document. */
   const document = await resolveDocument({ uuid });
   if (typeof document.id !== 'string' || typeof document.uuid !== 'string' || typeof document.delete !== 'function') {
      throw new ScriptError('ARGS_INVALID', `'${cleanForLog(uuid, ECHO_MAX_BYTES)}' is not a document.`);
   }
   return document;
}

/**
 * Resolve the uuids of a delete call to live documents, refusing what is not a deletable document.
 * @param {unknown} uuids - The uuids the call asked to delete.
 * @returns {Promise<object[]>} The documents, in the order given.
 * @throws {ScriptError} `ARGS_INVALID` or `DOC_NOT_FOUND`.
 */
async function resolveDeletions(uuids) {
   if (!Array.isArray(uuids) || uuids.length === 0) {
      throw new ScriptError('ARGS_INVALID', 'Give one or more uuids.');
   }
   /** @type {object[]} The live documents the uuids resolve to. */
   const documents = [];
   /** @type {Set<string>} The canonical uuids of the documents resolved so far. */
   const seen = new Set();
   for (const uuid of uuids) {
      /** @type {{ id: string, uuid: string, documentName: string }} A document that would be deleted. */
      const document = await resolveWritable(uuid);
      if (seen.has(document.uuid)) {
         throw new ScriptError('ARGS_INVALID', 'A document may appear once per call.');
      }
      seen.add(document.uuid);
      documents.push(document);
   }
   return documents;
}

/**
 * Refuse the deletions that would lock the world: the signed-in user, or every remaining game master.
 * @param {object[]} documents - The documents to delete.
 * @returns {void}
 * @throws {ScriptError} `DELETE_REFUSED`.
 */
function checkUserDeletions(documents) {
   /** @type {Set<string>} The ids of the User documents to delete. */
   const ids = new Set(documents.filter((document) => document.documentName === 'User').map((document) => document.id));
   if (ids.size === 0) {
      return;
   }
   if (ids.has(game.user.id)) {
      throw new ScriptError('DELETE_REFUSED', 'The signed-in user cannot be deleted.');
   }
   /** @type {object[]} The users with the game master role. */
   const masters = game.users.filter((user) => user.role === CONST.USER_ROLES.GAMEMASTER);
   if (masters.some((user) => ids.has(user.id)) && masters.every((user) => ids.has(user.id))) {
      throw new ScriptError('DELETE_REFUSED', 'The last game master cannot be deleted.');
   }
}

/**
 * List what a deletion removes: each named document followed by its embedded descendants, each once.
 * @param {object[]} documents - The documents to delete.
 * @returns {DeletePreview} The rows that would be deleted, cut at the hard cap.
 */
function previewDeletion(documents) {
   /** @type {Set<string>} The uuids already listed. */
   const listed = new Set();
   /** @type {Array<[string, string, string]>} The rows kept. */
   const rows = [];
   /**
    * List one document.
    * @param {{ uuid: string }} document - The document whose embedded cascade is walked.
    * @returns {void}
    */
   const list = (document) => {
      if (listed.has(document.uuid)) {
         return;
      }
      listed.add(document.uuid);
      if (rows.length < DELETE_PREVIEW_ROWS_MAX) {
         rows.push(previewRow(document));
      }
   };
   for (const document of documents) {
      list(document);
      for (const [, child] of document.traverseEmbeddedDocuments?.() ?? []) {
         list(child);
      }
   }
   return {
      dryRun: true,
      rows,
      total: listed.size,
      ...(rows.length < listed.size ? { cut: true } : {}),
   };
}

/**
 * Resolve and guard a deletion without deleting: every uuid is resolved, judged by the write guard, checked against
 * the rules that keep the world usable and against the `actAs` user.
 * @param {unknown} uuids - The uuids the call asked to delete.
 * @param {object | null} [actAsUser] - The user whose permission is checked in advance, if any.
 * @param {boolean} [dryRun] - Whether the deletion is only previewed, which needs no `allowDelete` gate.
 * @returns {Promise<object[]>} The live documents, in the order given.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `GATE_DENIED`, `DELETE_REFUSED` or `ACT_AS_DENIED`.
 */
export async function prepareDeletes(uuids, actAsUser = null, dryRun = false) {
   /** @type {object[]} The documents to delete. */
   const documents = await resolveDeletions(uuids);
   for (const document of documents) {
      guardWrite({
         documentName: document.documentName,
         operations: ['delete'],
         dryRun,
         ...(document.documentName === 'Setting' ? { settingTargets: [settingKeyOf(document.key)] } : {}),
         inPack: Boolean(document.pack),
      });
   }
   checkUserDeletions(documents);
   checkActAs(
      actAsUser,
      'delete',
      documents.map((document) => ({
         document,
         data: {},
      })),
   );
   return documents;
}

/**
 * Describe a prepared deletion as rows `{ uuid, name, type }`, read before the documents are gone.
 * @param {object[]} documents - The documents to delete.
 * @returns {CreatedRow[]} One row per document.
 */
export function deletionRows(documents) {
   return documents.map((document) => ({
      uuid: document.uuid,
      name: cleanForLog(String(document.name ?? document.key ?? ''), ROW_NAME_MAX_BYTES),
      type: String(document.type ?? ''),
   }));
}

/**
 * Group the documents of a deletion by the call that deletes them. A document named together with one of its
 * ancestors goes with the ancestor and is left out.
 * @param {object[]} documents - The documents to delete.
 * @returns {Array<{ parent: object | null, documentName: string, pack: string | null, ids: string[] }>} One group
 * per parent, class and pack.
 */
export function groupDeletions(documents) {
   /** @type {Set<string>} The uuids named, to find the documents an ancestor already covers. */
   const named = new Set(documents.map((document) => document.uuid));
   /** @type {object[]} The documents to delete directly. */
   const direct = documents.filter((document) => {
      for (let parent = document.parent; parent; parent = parent.parent) {
         if (named.has(parent.uuid)) {
            return false;
         }
      }
      return true;
   });
   /**
    * The documents grouped by the call that deletes them.
    * @type {Map<string, { parent: object | null, documentName: string, pack: string | null, ids: string[] }>}
    */
   const groups = new Map();
   for (const document of direct) {
      /** @type {string} The group key: parent, class and pack. */
      const key = `${document.parent?.uuid ?? ''}|${document.documentName}|${document.pack ?? ''}`;
      if (!groups.has(key)) {
         groups.set(key, {
            parent: document.parent ?? null,
            documentName: document.documentName,
            pack: document.pack ?? null,
            ids: [],
         });
      }
      groups.get(key).ids.push(document.id);
   }
   return [...groups.values()];
}

/**
 * Delete prepared documents through the Foundry document APIs: world and pack documents by their class, embedded
 * documents by their parent.
 * @param {object[]} documents - The documents from `prepareDeletes`.
 * @returns {Promise<CreatedRow[]>} The rows of the deleted documents.
 * @throws {ScriptError} `WRITE_NOT_APPLIED` when Foundry deleted fewer documents than asked.
 */
export async function runDeletes(documents) {
   /** @type {CreatedRow[]} The rows, read before the documents are gone. */
   const rows = deletionRows(documents);
   /** @type {ReturnType<typeof groupDeletions>} The deleting calls. */
   const groups = groupDeletions(documents);
   /** @type {number} How many documents the groups name. */
   const expected = groups.reduce((sum, group) => sum + group.ids.length, 0);
   /** @type {number} How many documents Foundry deleted. */
   let deleted = 0;
   for (const group of groups) {
      /** @type {object[]} The documents Foundry deleted in this call. */
      const result = group.parent
         ? await group.parent.deleteEmbeddedDocuments(group.documentName, group.ids)
         : await CONFIG[group.documentName].documentClass.deleteDocuments(group.ids, {
            ...(group.pack === null ? {} : { pack: group.pack }),
         });
      deleted += result.length;
   }
   if (deleted !== expected) {
      throw new ScriptError(
         'WRITE_NOT_APPLIED',
         `${deleted} of ${expected} documents were deleted; a hook or the system cancelled the rest.`,
      );
   }
   return rows;
}

/**
 * Delete documents through the Foundry document APIs: world and pack documents by their class, embedded documents by
 * their parent. A document named together with one of its ancestors goes with the ancestor. The deletion is
 * irreversible. Every uuid is resolved and guarded before the first deletion, and a dry run stops before it.
 * @param {DeleteParams} params - What to delete.
 * @returns {Promise<CreatedRow[] | DeletePreview>} The rows `{ uuid, name, type }` of the deleted documents, or the
 * preview of a dry run.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `GATE_DENIED`, `DELETE_REFUSED`, `ACT_AS_DENIED` or
 * `WRITE_NOT_APPLIED`.
 */
export async function deleteDocuments({ uuids, dryRun = false, actAs }) {
   /** @type {object[]} The documents to delete. */
   const documents = await prepareDeletes(uuids, resolveActAs(actAs), dryRun);
   if (dryRun) {
      return previewDeletion(documents);
   }
   return runDeletes(documents);
}
