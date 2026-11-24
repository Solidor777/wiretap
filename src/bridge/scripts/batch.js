/**
 * The shipped `batch` script: creates, updates and deletes in one Foundry batch through `ctx.core.batchDocuments`.
 * The batch is not atomic (see `writeBatch.js`). The definition is in `definitions.js`.
 */

import { ScriptError } from '~/bridge/scripts/registry.js';
import { BEST_PRACTICE, SizeNotes, totalBytes } from '~/bridge/scripts/sizeNotes.js';
import { parseDataObject } from '~/bridge/scripts/writeArgs.js';
import { ackBatch } from '~/bridge/scripts/writeAck.js';
import { groupPatches, notePatchesPerDocument } from '~/bridge/scripts/updateDocuments.js';

/**
 * @typedef {object} CreateGroup
 * @property {string} documentName - The class created.
 * @property {Record<string, unknown>[]} data - The data of each document, in entry order.
 * @property {string} [parentUuid] - The uuid of the parent of embedded documents.
 */

/**
 * Group the flat create entries (one document each) by class and parent, in first-use order, parsing each data text.
 * @param {Array<{ documentName?: string, data?: string, parentUuid?: string }>} entries - The validated entries.
 * @returns {{ groups: CreateGroup[], rowOrder: number[] }} One create per class and parent, and for each entry the
 * position of its row among the created rows, which come group by group, each group in data order.
 * @throws {ScriptError} `ARGS_INVALID` for an entry without `documentName` and `data`, or with data that is not a
 * JSON object.
 */
function groupCreates(entries) {
   /** @type {Map<string, CreateGroup>} The groups by class and parent. */
   const groups = new Map();
   /** @type {Array<{ group: CreateGroup, position: number }>} The group of each entry and its place in the group. */
   const places = [];
   for (const [index, entry] of entries.entries()) {
      if (typeof entry.documentName !== 'string' || typeof entry.data !== 'string') {
         throw new ScriptError('ARGS_INVALID', `creates[${index}] needs documentName and data.`);
      }
      /** @type {string} The group: class and parent. */
      const key = `${entry.documentName}|${entry.parentUuid ?? ''}`;
      if (!groups.has(key)) {
         groups.set(key, {
            documentName: entry.documentName,
            data: [],
            ...(entry.parentUuid === undefined ? {} : { parentUuid: entry.parentUuid }),
         });
      }
      /** @type {CreateGroup} The group of this entry. */
      const group = groups.get(key);
      places.push({
         group,
         position: group.data.length,
      });
      group.data.push(parseDataObject(entry.data, `creates[${index}].data`));
   }
   /** @type {Map<CreateGroup, number>} The position of each group's first row among the created rows. */
   const offsets = new Map();
   /** @type {number} The rows of the groups before the next one. */
   let offset = 0;
   for (const group of groups.values()) {
      offsets.set(group, offset);
      offset += group.data.length;
   }
   return {
      groups: [...groups.values()],
      rowOrder: places.map(({ group, position }) => offsets.get(group) + position),
   };
}

/**
 * Run the batch and acknowledge it. The entries are sent grouped (one create per class and parent), but the rows
 * follow the entries: created row i is create entry i, one updated row per uuid in the order of its first update
 * entry, and one deleted row per uuid in the order given. A dry run's rows follow the same order.
 * @param {Record<string, unknown>} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Promise<Record<string, unknown>>} `{ created, updated, deleted }` rows (`dryRun: true` on a dry run),
 * shaped to fit the batch acknowledgement budget.
 * @throws {import('~/bridge/scripts/registry.js').ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `GATE_DENIED`,
 * `VALIDATION_FAILED`, `DELETE_REFUSED`, `ACT_AS_DENIED` or `WRITE_NOT_APPLIED`.
 */
export async function batchHandler(args, ctx) {
   /** @type {Array<{ data?: string }>} The create entries. */
   const creates = args.creates ?? [];
   /** @type {Array<{ uuid: string, path: string, value?: string }>} The patch entries. */
   const updates = args.updates ?? [];
   /** @type {string[]} The uuids to delete. */
   const deletes = args.deletes ?? [];
   /** @type {SizeNotes} The best-practice sizes this call passes, written as one line before the batch runs. */
   const notes = new SizeNotes('batch');
   notes.note(updates.length, 'update entries in one call', BEST_PRACTICE.updateEntries);
   // One total for every text of the call: the creates and the updates share the data size.
   notes.note(
      totalBytes([
         ...creates.map((entry) => entry.data),
         ...updates.map((entry) => entry.value),
      ]),
      'bytes of data in one call',
      BEST_PRACTICE.dataBytes,
   );
   /** @type {ReturnType<typeof groupCreates>} The create groups and the entry order of their rows. */
   let grouped;
   /** @type {ReturnType<typeof groupPatches>} The updates, one per uuid. */
   let patched;
   try {
      grouped = groupCreates(creates);
      patched = groupPatches(updates);
      notes.note(creates.length + patched.length + deletes.length, 'documents in one call', BEST_PRACTICE.documents);
      notePatchesPerDocument(notes, patched);
   } finally {
      notes.write(ctx.log);
   }
   /** @type {Awaited<ReturnType<typeof ctx.core.batchDocuments>>} The rows by kind, created rows group by group. */
   const result = await ctx.core.batchDocuments({
      creates: grouped.groups,
      updates: patched,
      deletes,
      dryRun: args.dryRun === true,
      actAs: args.actAs,
   });
   return ackBatch({
      ...result,
      created: grouped.rowOrder.map((row) => result.created[row]),
   });
}
