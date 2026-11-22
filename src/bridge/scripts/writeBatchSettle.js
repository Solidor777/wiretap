/**
 * What became of the operations of a `foundry.documents.modifyBatch` call. Foundry reports the outcome in a way that
 * cannot be read by position, so this module reads it from the documents (Foundry 14.364,
 * `client/data/client-backend.mjs` `modifyDocumentBatch` and `#handleModifyDocumentBatch`):
 *
 * - The client runs each operation through its own pre-write workflow first and rewrites the operation in place: the
 * entries a hook cancelled and the updates that change nothing are removed. An operation with nothing left is not
 * sent and keeps `dryRun: true`; the others lose it. So `operation.dryRun === true` after the call means "not sent",
 * and the surviving entries are what remained in `data`, `updates` and `ids`.
 * - The results hold one list of documents per request the server answered without an error, in order. A request that
 * failed has no list and the client only shows a notification, so a missing request cannot be told from a skipped one
 * by position. Each list is matched to the next sent operation it fits (same class, the ids of the surviving entries or
 * the count of created documents).
 * - The server validates every request first (a dry run of each) and writes nothing when one fails, but it answers the
 * dry-run results of the requests that passed, and the client handles them as if they were real: it adds the created
 * documents to its collection and removes the deleted ones, though the server wrote nothing. After any failure the
 * results of creates and deletes are therefore checked against the server (`documentClass.database.get`), and the
 * client is repaired: a created document the server does not hold is removed from the client collection, a deleted
 * document the server still holds is put back. An update is confirmed by comparing its changes with the server copy.
 * The server then applies the requests one by one and stops at the first failure, so the earlier requests stay applied
 * (the batch is not atomic).
 */

import { cleanForLog } from '$shared/logText.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * @typedef {'applied' | 'unchanged' | 'partial' | 'cancelled' | 'failed' | 'echo'} OperationState
 * `applied`: written in full. `unchanged`: an update with nothing to change or cancelled by a hook. `partial`: a create
 * or delete a hook cancelled in part, the rest written. `cancelled`: a create or delete a hook cancelled in whole.
 * `failed`: sent, and the server answered with an error. `echo`: answered, but only by the dry-run pass of a failed
 * batch, so the server wrote nothing.
 */

/**
 * @typedef {object} OperationResult
 * @property {OperationState} state - What became of the operation.
 * @property {object[]} documents - The documents Foundry reported for it; empty when it reported none.
 */

/**
 * @typedef {object} SettleEntry
 * @property {'create' | 'update' | 'delete'} kind - What the operation does.
 * @property {number} expected - How many documents the operation was planned to touch.
 * @property {object | null} parent - The parent document of an embedded operation, null for a world or pack operation.
 * Foundry deletes `operation.parent` while it sends the request, so it is kept here.
 * @property {object} operation - The operation object handed to `modifyBatch`, rewritten by Foundry in place.
 */

/**
 * Tell whether Foundry sent an operation: the client leaves `dryRun: true` on an operation it had nothing to send for.
 * @param {SettleEntry} entry - The operation.
 * @returns {boolean} True when a request went to the server.
 */
function wasSent(entry) {
   return entry.operation.dryRun !== true;
}

/**
 * The ids of the entries that survived the client's pre-write workflow, or a count for a create: a create carries
 * client ids (`createId`), but its answer is matched by count.
 * @param {SettleEntry} entry - The operation.
 * @returns {string[] | number} The surviving ids of an update or delete; the number of surviving data of a create.
 */
function survivors(entry) {
   if (entry.kind === 'create') {
      return entry.operation.data.length;
   }
   return entry.kind === 'update' ? entry.operation.updates.map((update) => update._id) : entry.operation.ids;
}

/**
 * Tell whether a list of reported documents answers an operation. A result is the dry-run echo of another operation
 * when its parent differs from the operation's, or, for a create (sent with client ids but matched by count here), when
 * a document of it carries an id another sent operation updates or deletes.
 * @param {SettleEntry} entry - The sent operation.
 * @param {object[]} documents - One result list.
 * @param {SettleEntry[]} entries - Every operation of the call, in send order.
 * @returns {boolean} True when the list has the class, the parent and the ids (or the count, for a create) the
 * operation sent.
 */
function fits(entry, documents, entries) {
   if (documents.some((document) => document.documentName !== entry.operation.documentName)) {
      return false;
   }
   if (documents.some((document) => (document.parent?.uuid ?? null) !== (entry.parent?.uuid ?? null))) {
      return false;
   }
   /** @type {string[] | number} What the operation sent. */
   const sent = survivors(entry);
   if (typeof sent === 'number') {
      /** @type {Set<string>} The ids the other sent operations touch. */
      const foreign = new Set(
         entries
            .filter((other) => other !== entry && wasSent(other) && other.kind !== 'create')
            .flatMap((other) => survivors(other)),
      );
      return documents.length === sent && !documents.some((document) => foreign.has(document.id));
   }
   return documents.length === sent.length && sent.every((id) => documents.some((document) => document.id === id));
}

/**
 * Match the results of `modifyBatch` to the operations that were sent.
 * @param {SettleEntry[]} entries - The operations, in send order.
 * @param {object[][]} results - The result lists Foundry returned.
 * @returns {OperationResult[]} What became of each operation, in the same order.
 */
export function settle(entries, results) {
   /** @type {number} The first result list not yet matched. */
   let cursor = 0;
   return entries.map((entry) => {
      if (!wasSent(entry)) {
         return {
            state: entry.kind === 'update' ? 'unchanged' : 'cancelled',
            documents: [],
         };
      }
      for (let index = cursor; index < results.length; index += 1) {
         if (fits(entry, results[index], entries)) {
            cursor = index + 1;
            /** @type {string[] | number} What was sent. */
            const sent = survivors(entry);
            /** @type {number} How many entries the client sent. */
            const count = typeof sent === 'number' ? sent : sent.length;
            // An update is never 'partial': an entry Foundry dropped (it changed nothing, or a hook cancelled it) is
            // told apart by id when the batch is acknowledged, and gets no paths, exactly like a single update that
            // reports `changed: []`. Only creates and deletes, which have nothing to compare, count a shortfall.
            return {
               state: entry.kind !== 'update' && count < entry.expected ? 'partial' : 'applied',
               documents: results[index],
            };
         }
      }
      return {
         state: 'failed',
         documents: [],
      };
   });
}

/**
 * Ask the server which of the given documents it holds.
 * @param {object} operation - The operation whose documents are asked for.
 * @param {object | null} parent - The parent of an embedded operation, or null.
 * @param {string[]} ids - The ids to look for.
 * @returns {Promise<Map<string, object>>} The server's documents by id.
 */
async function serverDocuments(operation, parent, ids) {
   /** @type {{ database: { get: Function } }} The configured document class. */
   const documentClass = CONFIG[operation.documentName].documentClass;
   // The server matches `_id` by equality only (MEASURED on Foundry 14.364: `{ $in: [...] }` finds nothing), so a
   // world document is asked for one by one; the children of a parent come back whole whatever the query.
   /** @type {object[][]} The answers: one list per id, or one list for the parent. */
   const answers = await Promise.all(
      (parent ? [ids[0]] : ids).map((id) =>
         documentClass.database.get(documentClass, {
            query: { _id: id },
            ...(parent ? { parent } : {}),
         }),
      ),
   );
   return new Map(
      answers
         .flat()
         .filter((document) => ids.includes(document.id))
         .map((document) => [document.id, document]),
   );
}

/**
 * The collection of the client that holds an operation's documents.
 * @param {SettleEntry} entry - The operation whose documents the collection holds.
 * @returns {{ get: Function, set: Function, delete: Function }} The embedded collection of the parent, or the world
 * collection of the class.
 */
function clientCollection(entry) {
   return entry.parent
      ? entry.parent.getEmbeddedCollection(entry.operation.documentName)
      : game.collections.get(entry.operation.documentName);
}

/**
 * Check one answered operation against the server and repair the client where the answer was only the dry-run echo.
 * @param {SettleEntry} entry - The answered operation.
 * @param {object[]} documents - The documents Foundry reported for it.
 * @returns {Promise<boolean | null>} True when the server holds the change, false when it does not (the client is
 * repaired), null when this cannot be told (a compendium pack, an unreadable answer).
 */
async function confirm(entry, documents) {
   /** @type {object} The operation object that was handed to Foundry. */
   const operation = entry.operation;
   if (operation.pack) {
      return null;
   }
   try {
      /** @type {string[]} The ids the answer names. */
      const ids = documents.map((document) => document.id);
      /** @type {Map<string, object>} The documents the server holds among them. */
      const held = await serverDocuments(operation, entry.parent, ids);
      if (entry.kind === 'create') {
         for (const document of documents.filter((candidate) => !held.has(candidate.id))) {
            clientCollection(entry).delete(document.id);
         }
         entry.parent?.reset?.();
         return documents.every((document) => held.has(document.id));
      }
      if (entry.kind === 'delete') {
         /** @type {{ get: Function, set: Function }} The client collection. */
         const collection = clientCollection(entry);
         /** @type {Function} The configured document class. */
         const documentClass = CONFIG[operation.documentName].documentClass;
         for (const [id, document] of held) {
            if (collection.get(id) === undefined) {
               collection.set(
                  id,
                  documentClass.fromSource(document.toObject(), {
                     parent: entry.parent,
                     pack: null,
                  }),
               );
            }
         }
         entry.parent?.reset?.();
         return held.size === 0;
      }
      return operation.updates.every((update) => {
         /** @type {object | undefined} The server copy. */
         const document = held.get(update._id);
         /** @type {Record<string, unknown>} The changes of the update, without the id. */
         const changes = foundry.utils.expandObject(
            Object.fromEntries(Object.entries(update).filter(([key]) => key !== '_id')),
         );
         return document !== undefined && foundry.utils.isEmpty(foundry.utils.diffObject(document.toObject(), changes));
      });
   } catch {
      return null;
   }
}

/**
 * After a failure, decide which answered operations the server really wrote, and repair the client for the others.
 * @param {SettleEntry[]} entries - The operations.
 * @param {OperationResult[]} states - What `settle` made of them; changed in place.
 * @returns {Promise<void>} Resolves once every answered operation is confirmed or marked `echo`.
 */
export async function confirmAfterFailure(entries, states) {
   /** @type {number} The position of the first failed operation. */
   const firstFailed = states.findIndex((result) => result.state === 'failed');
   for (const [index, result] of states.entries()) {
      if (result.state !== 'applied' && result.state !== 'partial') {
         continue;
      }
      /** @type {boolean | null} Whether the server holds the change. */
      const confirmed = await confirm(entries[index], result.documents);
      // An answer that cannot be checked counts as written only when it came before the first failure, which is the
      // order of the server's sequential pass; after a failed operation it can only be a dry-run echo.
      if (confirmed === false || (confirmed === null && index > firstFailed)) {
         result.state = 'echo';
      }
   }
}

/**
 * Tell whether every operation was written or had nothing to write.
 * @param {OperationResult[]} states - What became of the operations.
 * @returns {boolean} True when the batch is complete.
 */
export function isComplete(states) {
   return states.every((result) => result.state === 'applied' || result.state === 'unchanged');
}

/**
 * Build the error for a batch that was not written in full: how many operations were applied and why the others were
 * not, then the first applied documents.
 * @param {OperationResult[]} states - What became of the operations.
 * @returns {ScriptError} A `WRITE_NOT_APPLIED` error, at most 256 bytes.
 */
export function incomplete(states) {
   /**
    * Count the operations in a state.
    * @param {OperationState} state - The state to count.
    * @returns {number} How many operations are in that state.
    */
   const count = (state) => states.filter((result) => result.state === state).length;
   /** @type {string[]} The parts after the applied count, for the states that occurred. */
   const parts = [
      [
         'unchanged',
         'unchanged',
      ],
      [
         'partial',
         'partly cancelled by a hook',
      ],
      [
         'cancelled',
         'cancelled by a hook',
      ],
      [
         'failed',
         'failed',
      ],
      [
         'echo',
         'not written',
      ],
   ]
      .filter(([state]) => count(state) > 0)
      .map(([state, label]) => `${count(state)} ${label}`);
   /** @type {string} The uuids of the applied documents, as many as fit. */
   const uuids = states
      .filter((result) => result.state === 'applied' || result.state === 'partial')
      .flatMap((result) => result.documents)
      .map((document) => document.uuid)
      .slice(0, 3)
      .join(', ');
   return new ScriptError(
      'WRITE_NOT_APPLIED',
      cleanForLog(
         `${count('applied')} of ${states.length} operations applied` +
            `${parts.length === 0 ? '' : `, ${parts.join(', ')}`}; the batch is not atomic` +
            `${uuids === '' ? '.' : `: ${uuids}.`}`,
         256,
      ),
   );
}
