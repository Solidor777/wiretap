/**
 * Idempotency of `create_documents`. A caller that repeats a call after a lost reply passes the same
 * `idempotencyKey`; the call then returns the rows of the documents the first call created instead of creating them
 * again.
 *
 * The record is a module flag on every created document, `flags.wiretap.idem = { k, i, n, h, u, d }`: the key, the
 * index of the document in its call, the number of documents in the call, a hash of the request, the id of the user
 * whose client wrote it and the id of the document that carries it. The documents are created with ids this module
 * chooses (`keepId`), so `d` is known before the write. A repeated call looks the key up among the documents of the
 * same collection (the world collection of the class, or the embedded collection of the parent).
 *
 * - Trust: a record counts only when `u` is the user of this client and `d` is the id of the document that carries
 * it. A copy of a document (a duplicate, an export and import) carries a record whose `d` is another document's id
 * and is ignored; a record another user planted is ignored. Anyone who can edit flags and knows the game master's
 * user id can still plant a record, so the stamp keeps honest mistakes out and is not an authorization boundary.
 * - Replay: the trusted records of the key are complete (`n` documents, every index once) and carry the hash of this
 * request. A replay checks the `actAs` user like a create, answers a dry run with the existing documents marked
 * `dryRun` and `replay`, and adds read-back when asked.
 * - Conflict (`IDEMPOTENCY_CONFLICT`): the key has trusted records that are incomplete (a hook cancelled a document,
 * or one was deleted since) or carry another hash (a different request), so the call neither replays nor creates. The
 * message names which case it is and the remedy (a new key).
 * - Retention: a record older than `IDEMPOTENCY_RETENTION_MS` (by `_stats.createdTime`) is ignored, so a key can be
 * reused after a day. The flag itself stays on the document.
 * - Bound: the lookup reads at most `IDEMPOTENCY_SCAN_MAX` documents of the collection. A larger collection is refused
 * with `IDEMPOTENCY_UNAVAILABLE` rather than searched in part, because a record beyond the bound would be missed and
 * the documents created twice.
 * - Concurrency: calls with one key (per class, parent and key) run one after another in this client, so the second
 * call finds the first call's records. Two clients calling at once are not coordinated.
 * - Safety: the `flags.wiretap` scope is refused by the write guard in every create, update and replace, so a caller
 * cannot forge, move or erase a record; only this module writes it, after the guard has run.
 */

import { hashText } from '~/bridge/scripts/contentHash.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { createId } from '~/bridge/scripts/writeArgs.js';

/**
 * The accepted form of an idempotency key.
 * @type {RegExp}
 */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/**
 * How long a record counts, in milliseconds: one day.
 * @type {number}
 */
export const IDEMPOTENCY_RETENTION_MS = 86_400_000;

/**
 * The most documents of one collection the key lookup reads. One document costs one property read, so the bound is
 * far above the search scan bound; a collection past it is refused.
 * @type {number}
 */
export const IDEMPOTENCY_SCAN_MAX = 20_000;

/**
 * @typedef {object} IdempotencyRecord
 * @property {string} k - The idempotency key.
 * @property {number} i - The index of the document in its call.
 * @property {number} n - How many documents the call created.
 * @property {string} h - The hash of the request.
 * @property {string} u - The id of the user whose client wrote the record.
 * @property {string} d - The id of the document that carries the record.
 */

/**
 * Hash a request to a short hex text: `hashText` of its JSON text.
 * @param {unknown} request - A JSON-serializable description of the request.
 * @returns {string} The hash as 14 hex digits.
 */
export function requestHash(request) {
   return hashText(JSON.stringify(request));
}

/**
 * Tails of the calls running under a key, so the next call with that key waits for them.
 * @type {Map<string, Promise<void>>}
 */
const inFlight = new Map();

/**
 * Run a task after every earlier task of the same scope has finished, whether it succeeded or failed.
 * @template T
 * @param {string} scope - What the tasks share, for example class, parent and key.
 * @param {() => Promise<T>} task - The work to run.
 * @returns {Promise<T>} What the task returns or throws.
 */
export async function withKeyLock(scope, task) {
   /** @type {Promise<void>} The tail of the earlier tasks. */
   const previous = inFlight.get(scope) ?? Promise.resolve();
   /**
    * Lets the next task start once this one has finished.
    * @type {() => void}
    */
   let release = () => undefined;
   /** @type {Promise<void>} Settles when this task has finished. */
   const finished = new Promise((resolve) => {
      release = resolve;
   });
   /** @type {Promise<void>} The new tail of the scope. */
   const tail = previous.then(() => finished);
   inFlight.set(scope, tail);
   await previous;
   try {
      return await task();
   } finally {
      release();
      if (inFlight.get(scope) === tail) {
         inFlight.delete(scope);
      }
   }
}

/**
 * Add the idempotency record to the data of one document and give the document the id the record names.
 * @param {Record<string, unknown>} item - The data of the document.
 * @param {Omit<IdempotencyRecord, 'd'>} record - The record without the document id.
 * @param {boolean} keepId - Whether the caller asked to keep the `_id` of the data.
 * @returns {Record<string, unknown>} A copy that carries the record and its `_id`. `guardWrite` has already refused a
 * `flags` value that is not an object, so `flags` is absent or a plain object here.
 */
function withRecord(item, record, keepId) {
   /** @type {string} The id the document is created with. */
   const id = createId(item, keepId);
   return {
      ...item,
      _id: id,
      flags: {
         ...item.flags,
         wiretap: {
            idem: {
               ...record,
               d: id,
            },
         },
      },
   };
}

/**
 * Collect the live documents that carry a trusted record of the key.
 * @param {Iterable<object>} documents - The documents of the collection.
 * @param {string} key - The idempotency key.
 * @returns {Array<{ document: object, record: IdempotencyRecord }>} The documents with their records.
 */
function recordsOf(documents, key) {
   /** @type {number} The current time. */
   const now = Date.now();
   /** @type {Array<{ document: object, record: IdempotencyRecord }>} The matches. */
   const found = [];
   for (const document of documents) {
      /** @type {unknown} The record on the document, if any. */
      const record = document.flags?.wiretap?.idem;
      if (typeof record !== 'object' || record === null || record.k !== key) {
         continue;
      }
      if (record.u !== game.user.id || record.d !== document.id) {
         continue;
      }
      /** @type {unknown} When the document was created. */
      const created = document._stats?.createdTime;
      if (typeof created === 'number' && now - created > IDEMPOTENCY_RETENTION_MS) {
         continue;
      }
      found.push({
         document,
         record,
      });
   }
   return found;
}

/**
 * Apply an idempotency key to a create call: find the earlier call's documents, or prepare the records to write.
 * @param {object} params - The call.
 * @param {string} params.key - The key the caller passed.
 * @param {string} params.documentName - The class created.
 * @param {object | null} params.parent - The parent of embedded documents, or null for world documents.
 * @param {unknown} params.request - Everything that identifies the request, hashed to tell requests apart.
 * @param {Record<string, unknown>[]} params.data - The data of each document.
 * @param {boolean} params.keepId - Whether the caller asked to keep the `_id` of the data.
 * @returns {{ replay: object[] | null, records: Record<string, unknown>[] }} The documents of the earlier call in
 * data order, or null and the data with the records and ids added.
 * @throws {ScriptError} `ARGS_INVALID` for a malformed key or a class with no collection, `IDEMPOTENCY_UNAVAILABLE`
 * for a collection past the lookup bound, `IDEMPOTENCY_CONFLICT`.
 */
export function applyIdempotency({ key, documentName, parent, request, data, keepId }) {
   if (typeof key !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
      throw new ScriptError('ARGS_INVALID', 'An idempotencyKey is 1 to 64 letters, digits, dots, colons, dashes or _.');
   }
   /** @type {{ size: number, values: () => Iterable<object> } | undefined} The collection the records live in. */
   const collection = parent ? parent.getEmbeddedCollection(documentName) : game.collections.get(documentName);
   if (collection === undefined) {
      throw new ScriptError('ARGS_INVALID', `${documentName} has no collection to hold an idempotency record.`);
   }
   if (collection.size > IDEMPOTENCY_SCAN_MAX) {
      throw new ScriptError(
         'IDEMPOTENCY_UNAVAILABLE',
         `This collection holds ${collection.size} documents; the idempotencyKey lookup covers at most ` +
            `${IDEMPOTENCY_SCAN_MAX}. Create without a key.`,
      );
   }
   /** @type {string} The hash of this request. */
   const hash = requestHash(request);
   /** @type {ReturnType<typeof recordsOf>} The documents the key already marks. */
   const earlier = recordsOf(collection.values(), key);
   if (earlier.length === 0) {
      return {
         replay: null,
         records: data.map((item, index) =>
            withRecord(
               item,
               {
                  k: key,
                  i: index,
                  n: data.length,
                  h: hash,
                  u: game.user.id,
               },
               keepId,
            ),
         ),
      };
   }
   if (earlier.some(({ record }) => record.h !== hash || record.n !== data.length)) {
      throw new ScriptError(
         'IDEMPOTENCY_CONFLICT',
         'This idempotencyKey was used by a different request; use a new idempotencyKey.',
      );
   }
   /** @type {Array<object | undefined>} The earlier documents by their index in that call. */
   const byIndex = Array.from({ length: data.length });
   for (const { document, record } of earlier) {
      if (Number.isInteger(record.i) && record.i >= 0 && record.i < data.length && byIndex[record.i] === undefined) {
         byIndex[record.i] = document;
      }
   }
   /** @type {number} How many documents of the earlier call are still present. */
   const present = byIndex.filter((document) => document !== undefined).length;
   if (present !== data.length) {
      throw new ScriptError(
         'IDEMPOTENCY_CONFLICT',
         `This idempotencyKey created ${present} of ${data.length} documents (a hook cancelled some, or some were ` +
            'deleted since). They are not created again; use a new idempotencyKey to create all of them.',
      );
   }
   return {
      replay: byIndex,
      records: data,
   };
}
