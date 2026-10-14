/**
 * The shipped `batch` script: creates, updates and deletes in one Foundry batch through `ctx.core.batchDocuments`.
 * The batch is not atomic (see `writeBatch.js`). The definition is in `definitions.js`.
 */

import { ScriptError } from '~/bridge/scripts/registry.js';
import { checkDataBytes, parseDataObject } from '~/bridge/scripts/writeArgs.js';
import { ackBatch } from '~/bridge/scripts/writeAck.js';
import { groupPatches } from '~/bridge/scripts/updateDocuments.js';

/**
 * Group the flat create entries (one document each) by class and parent, in first-use order, parsing each data text.
 * The caller bounds the size of the texts.
 * @param {Array<{ documentName?: string, data?: string, parentUuid?: string }>} entries - The validated entries.
 * @returns {Array<{ documentName: string, data: Record<string, unknown>[], parentUuid?: string }>} One create per
 * class and parent.
 * @throws {ScriptError} `ARGS_INVALID` for an entry without `documentName` and `data`, or with data that is not a
 * JSON object.
 */
function groupCreates(entries) {
   /** @type {Map<string, { documentName: string, data: Record<string, unknown>[], parentUuid?: string }>} Groups. */
   const groups = new Map();
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
      groups.get(key).data.push(parseDataObject(entry.data, `creates[${index}].data`));
   }
   return [...groups.values()];
}

/**
 * Run the batch and acknowledge it.
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
   /** @type {Array<{ value?: string }>} The patch entries. */
   const updates = args.updates ?? [];
   // One total for every text of the call, so the creates and the updates share the data bound.
   checkDataBytes([
      ...creates.map((entry) => entry.data ?? ''),
      ...updates.map((entry) => entry.value ?? ''),
   ]);
   /** @type {Awaited<ReturnType<typeof ctx.core.batchDocuments>>} The rows by kind. */
   const result = await ctx.core.batchDocuments({
      creates: groupCreates(creates),
      updates: groupPatches(updates),
      deletes: args.deletes ?? [],
      dryRun: args.dryRun === true,
      actAs: args.actAs,
   });
   return ackBatch(result);
}
