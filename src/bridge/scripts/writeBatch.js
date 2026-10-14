/**
 * `batch`: creates, updates and deletes in one `foundry.documents.modifyBatch` call (`foundry.documents.modifyBatch`
 * and `ClientDatabaseBackend#modifyDocumentBatch`, read in Foundry 14.364).
 *
 * What Foundry does with a batch (read in `client/data/client-backend.mjs` and in the socket handler of the
 * `modifyDocumentBatch` event in `dist/database/backend/server-backend.mjs`; the handler's private name differs
 * between builds, so the behaviour is cited, not the name): the client runs every operation through its own pre-write
 * workflow, then the server validates every request first (a dry run of each) and writes nothing when one fails, and
 * otherwise applies the requests one by one and stops at the first failure. There is no rollback, so the batch is NOT
 * atomic although the doc comment of `modifyBatch` says it is: the requests before a failing one stay applied. The
 * client swallows the errors of both passes (a notification) and returns only the documents of the requests that were
 * answered without an error. `writeBatchSettle.js` reads the outcome from those documents, checks it against the
 * server after a failure and repairs the client view.
 *
 * Every sub-operation is planned by the same planners as `create_documents`, `update_documents` and
 * `delete_documents`, so each one passes the write guard, Foundry's validation and the `actAs` check before the first
 * write, and a dry run stops there. The operations are sent in a fixed order: creates, updates, deletes. An operation
 * cannot refer to a document an earlier operation creates.
 */

import { getBudget } from '$shared/budgets.js';
import { cleanForLog } from '$shared/logText.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { resolveActAs } from '~/bridge/scripts/writeActAs.js';
import { confirmAfterFailure, incomplete, isComplete, settle } from '~/bridge/scripts/writeBatchSettle.js';
import {
   deletionRows,
   groupDeletions,
   prepareCreate,
   prepareDeletes,
   prepareUpdates,
   rowOf,
} from '~/bridge/scripts/writes.js';

/**
 * @typedef {object} BatchParams
 * @property {object[]} [creates] - Create entries `{ documentName, data[], parentUuid?, pack?, keepId? }`.
 * @property {object[]} [updates] - Update entries `{ uuid, patches[] }`, one per document.
 * @property {string[]} [deletes] - The uuids to delete.
 * @property {boolean} [dryRun] - Validate and report; write nothing.
 * @property {string} [actAs] - The id of a user whose permission is checked in advance (advisory).
 */

/**
 * @typedef {object} BatchOperation
 * @property {'create' | 'update' | 'delete'} kind - What the operation does.
 * @property {number} expected - How many documents Foundry should report for the operation.
 * @property {object | null} parent - The parent document of an embedded operation, or null. Foundry deletes it from
 * the operation while sending.
 * @property {object} operation - The operation object handed to `modifyBatch`.
 * @property {import('~/bridge/scripts/writes.js').UpdatePlan} [plan] - The update plan, for an update operation.
 * @property {string} [collection] - The embedded collection name of an embedded update, if it is one.
 */

/**
 * Collect the documents an update plan writes: the document itself when it has own paths, and embedded children.
 * @param {import('~/bridge/scripts/writes.js').UpdatePlan} plan - An update plan.
 * @returns {object[]} The documents the plan writes.
 */
function updatedDocuments(plan) {
   return [
      ...(plan.paths.length > 0 ? [plan.document] : []),
      ...plan.embedded.flatMap((group) => group.entries.map((item) => item.document)),
   ];
}

/**
 * Refuse a batch that touches more documents than one call may.
 * @param {number} touched - How many documents the batch creates, updates and deletes.
 * @returns {void}
 * @throws {ScriptError} `ARGS_INVALID`.
 */
function checkTouched(touched) {
   /** @type {number} The most documents one batch may touch. */
   const max = getBudget('WRITE_DOCUMENTS_MAX').value;
   if (touched > max) {
      throw new ScriptError('ARGS_INVALID', `A batch may touch at most ${max} documents.`);
   }
}

/**
 * Refuse a batch that deletes a document it also updates, or deletes the parent of an updated child.
 * @param {import('~/bridge/scripts/writes.js').UpdatePlan[]} plans - The update plans.
 * @param {object[]} deleted - The documents to delete.
 * @returns {void}
 * @throws {ScriptError} `ARGS_INVALID`.
 */
function checkConflicts(plans, deleted) {
   /** @type {Set<string>} The canonical uuids to delete. */
   const doomed = new Set(deleted.map((document) => document.uuid));
   for (const plan of plans) {
      for (const document of updatedDocuments(plan)) {
         for (let ancestor = document; ancestor; ancestor = ancestor.parent) {
            if (doomed.has(ancestor.uuid)) {
               throw new ScriptError('ARGS_INVALID', 'A batch may not update a document it also deletes.');
            }
         }
      }
   }
}

/**
 * Build the operations of a prepared batch, in the order creates, updates, deletes.
 * @param {import('~/bridge/scripts/writes.js').CreatePlan[]} creates - The create plans.
 * @param {import('~/bridge/scripts/writes.js').UpdatePlan[]} updates - The update plans.
 * @param {object[]} deleted - The documents to delete.
 * @returns {BatchOperation[]} The operations with what each should report.
 */
export function buildOperations(creates, updates, deleted) {
   /** @type {BatchOperation[]} The operations built so far, in send order. */
   const operations = [];
   for (const plan of creates) {
      operations.push({
         kind: 'create',
         expected: plan.payload.length,
         parent: plan.target.parent ?? null,
         operation: {
            action: 'create',
            documentName: plan.documentName,
            data: plan.payload,
            keepId: plan.keepId,
            ...(plan.target.parent ? { parent: plan.target.parent } : {}),
            ...(plan.target.pack === null ? {} : { pack: plan.target.pack }),
         },
      });
   }
   for (const plan of updates) {
      if (plan.paths.length > 0) {
         operations.push({
            kind: 'update',
            expected: 1,
            parent: plan.document.parent ?? null,
            plan,
            operation: {
               action: 'update',
               documentName: plan.document.documentName,
               updates: [
                  {
                     ...plan.changes,
                     _id: plan.document.id,
                  },
               ],
               ...(plan.document.parent ? { parent: plan.document.parent } : {}),
               ...(plan.document.pack ? { pack: plan.document.pack } : {}),
            },
         });
      }
      for (const group of plan.embedded) {
         operations.push({
            kind: 'update',
            expected: group.entries.length,
            parent: plan.document,
            plan,
            collection: group.collection,
            operation: {
               action: 'update',
               documentName: group.documentName,
               updates: group.entries.map((item) => ({
                  ...item.changes,
                  _id: item._id,
               })),
               parent: plan.document,
            },
         });
      }
   }
   for (const group of groupDeletions(deleted)) {
      operations.push({
         kind: 'delete',
         expected: group.ids.length,
         parent: group.parent ?? null,
         operation: {
            action: 'delete',
            documentName: group.documentName,
            ids: group.ids,
            ...(group.parent ? { parent: group.parent } : {}),
            ...(group.pack === null ? {} : { pack: group.pack }),
         },
      });
   }
   return operations;
}

/**
 * Build the acknowledgement of an applied batch from what Foundry reported.
 * @param {BatchOperation[]} operations - The operations that were sent.
 * @param {import('~/bridge/scripts/writeBatchSettle.js').OperationResult[]} states - What became of each operation.
 * @param {object[]} deleted - The documents deleted.
 * @returns {{ created: object[], updated: object[], deleted: object[] }} The rows by kind.
 */
function acknowledge(operations, states, deleted) {
   /** @type {object[]} The created rows. */
   const created = [];
   /** @type {Map<object, Set<string>>} The paths applied per update plan. */
   const applied = new Map();
   for (const [index, entry] of operations.entries()) {
      if (entry.kind === 'create') {
         created.push(...states[index].documents.map((document) => rowOf(document, false)));
      } else if (entry.kind === 'update') {
         if (!applied.has(entry.plan)) {
            applied.set(entry.plan, new Set());
         }
         /** @type {Set<string>} The ids Foundry reported updated. */
         const ids = new Set(states[index].documents.map((document) => document.id));
         if (entry.collection === undefined) {
            if (ids.has(entry.plan.document.id)) {
               for (const path of entry.plan.paths) {
                  applied.get(entry.plan).add(path);
               }
            }
         } else {
            for (const group of entry.plan.embedded.filter((candidate) => candidate.collection === entry.collection)) {
               for (const item of group.entries.filter((candidate) => ids.has(candidate._id))) {
                  for (const path of item.paths) {
                     applied.get(entry.plan).add(path);
                  }
               }
            }
         }
      }
   }
   return {
      created,
      updated: [...applied.entries()].map(([plan, paths]) => ({
         uuid: plan.document.uuid,
         changed: plan.patches.map((patch) => patch.path).filter((path) => paths.has(path)),
      })),
      deleted: deletionRows(deleted),
   };
}

/**
 * Run creates, updates and deletes as one batch. See the file header for what Foundry guarantees.
 * @param {BatchParams} params - The operations.
 * @returns {Promise<{ created: object[], updated: object[], deleted: object[], dryRun?: true }>} The rows by kind.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `GATE_DENIED`, `VALIDATION_FAILED`, `DELETE_REFUSED`,
 * `ACT_AS_DENIED` or `WRITE_NOT_APPLIED`.
 */
export async function batchDocuments({ creates = [], updates = [], deletes = [], dryRun = false, actAs }) {
   if (!Array.isArray(creates) || !Array.isArray(updates) || !Array.isArray(deletes)) {
      throw new ScriptError('ARGS_INVALID', 'creates, updates and deletes must be lists.');
   }
   if (creates.length + updates.length + deletes.length === 0) {
      throw new ScriptError('ARGS_INVALID', 'Give at least one create, update or delete.');
   }
   /** @type {number} The documents the creates and deletes name. */
   const named =
      creates.reduce((sum, entry) => sum + (Array.isArray(entry?.data) ? entry.data.length : 0), 0) + deletes.length;
   checkTouched(named + updates.length);
   /** @type {{ id: string, name?: string } | null} The advisory user, if any. */
   const actAsUser = resolveActAs(actAs);
   /** @type {import('~/bridge/scripts/writes.js').CreatePlan[]} The checked plan of each create entry. */
   const createPlans = [];
   for (const [index, entry] of creates.entries()) {
      createPlans.push(
         await prepareCreate({
            ...entry,
            actAsUser,
            prefix: `creates[${index}]`,
         }),
      );
   }
   /** @type {import('~/bridge/scripts/writes.js').UpdatePlan[]} The checked plan of each updated document. */
   const updatePlans =
      updates.length === 0
         ? []
         : await prepareUpdates(updates, {
            actAsUser,
            prefix: 'updates',
            dryRun,
         });
   /** @type {object[]} The documents to delete. */
   const deleted = deletes.length === 0 ? [] : await prepareDeletes(deletes, actAsUser, dryRun);
   checkConflicts(updatePlans, deleted);
   checkTouched(named + updatePlans.reduce((sum, plan) => sum + updatedDocuments(plan).length, 0));
   /** @type {BatchOperation[]} The operations to send. */
   const operations = buildOperations(createPlans, updatePlans, deleted);
   if (dryRun) {
      return {
         dryRun: true,
         created: createPlans.flatMap((plan) => plan.built.map((document) => rowOf(document, true))),
         updated: updatePlans.map((plan) => ({
            uuid: plan.document.uuid,
            changed: plan.patches.map((patch) => patch.path),
            dryRun: true,
         })),
         deleted: deletionRows(deleted),
      };
   }
   /** @type {object[][]} The documents Foundry reported per answered request. */
   const results = await foundry.documents.modifyBatch(operations.map((entry) => entry.operation));
   /** @type {ReturnType<typeof settle>} What became of each operation. */
   const states = settle(operations, results);
   if (states.some((result) => result.state === 'failed')) {
      await confirmAfterFailure(operations, states);
   }
   if (!isComplete(states)) {
      throw incomplete(states);
   }
   return acknowledge(operations, states, deleted);
}
