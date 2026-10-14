/**
 * The shipped `update_documents` script: path-scoped updates through `ctx.core.updateDocuments`, which guards and
 * validates the whole call before it writes. Each `updates` entry is one patch; the entries of one uuid form that
 * document's update. The definition is in `definitions.js`.
 */

import { ScriptError } from '~/bridge/scripts/registry.js';
import { checkDataBytes, checkReadbackPaths, parseJson, shapeRefusal } from '~/bridge/scripts/writeArgs.js';
import { ackUpdates, attachReadback } from '~/bridge/scripts/writeAck.js';

/**
 * Group the patch entries by uuid, in first-use order, parsing each value as JSON. The caller bounds the size of the
 * values (`checkDataBytes`), alone or together with other texts of the same call.
 * @param {Array<{ uuid: string, path: string, value?: string, op?: string }>} entries - The validated entries.
 * @returns {Array<{ uuid: string, patches: Array<{ path: string, value?: unknown, op?: string }> }>} The updates.
 * @throws {ScriptError} `ARGS_INVALID` for a value that is not JSON, or a value given with `op: 'delete'`.
 */
export function groupPatches(entries) {
   /** @type {Map<string, { uuid: string, patches: object[] }>} The updates by uuid. */
   const updates = new Map();
   for (const [index, entry] of entries.entries()) {
      if (entry.op === 'delete' && entry.value !== undefined) {
         throw new ScriptError('ARGS_INVALID', `updates[${index}] gives a value with op delete.`);
      }
      if (!updates.has(entry.uuid)) {
         updates.set(entry.uuid, {
            uuid: entry.uuid,
            patches: [],
         });
      }
      updates.get(entry.uuid).patches.push({
         path: entry.path,
         ...(entry.value === undefined ? {} : { value: parseJson(entry.value, `updates[${index}].value`) }),
         ...(entry.op === undefined ? {} : { op: entry.op }),
      });
   }
   return [...updates.values()];
}

/**
 * Bound the values of the patch entries as one total, then group them by uuid.
 * @param {Array<{ uuid: string, path: string, value?: string, op?: string }>} entries - The validated entries.
 * @returns {ReturnType<typeof groupPatches>} The updates.
 * @throws {ScriptError} `ARGS_INVALID` for values over the data bound, a value that is not JSON, or a value given
 * with `op: 'delete'`.
 */
export function groupEntries(entries) {
   checkDataBytes(entries.map((entry) => entry.value ?? ''));
   return groupPatches(entries);
}

/**
 * Update the documents and acknowledge them.
 * @param {Record<string, unknown>} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Promise<Record<string, unknown>[]>} One row `{ uuid, changed }` per document (`dryRun: true` on a dry
 * run), with `values` and `missing` when `paths` was given.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `GATE_DENIED`, `VALIDATION_FAILED` or a `PATH_*` code.
 */
export async function updateDocumentsHandler(args, ctx) {
   /** @type {ReturnType<typeof groupEntries>} The updates, one per uuid. */
   const updates = groupEntries(args.updates);
   checkReadbackPaths(ctx, args.paths);
   /** @type {Awaited<ReturnType<typeof ctx.core.updateDocuments>>} The updated documents. */
   const updated = await ctx.core.updateDocuments({
      updates,
      dryRun: args.dryRun === true,
      readback: args.paths !== undefined && args.dryRun !== true,
      actAs: args.actAs,
   });
   /** @type {Record<string, unknown>[]} The acknowledgement rows. */
   const rows = ackUpdates(updated);
   if (args.paths === undefined || args.dryRun === true) {
      return rows;
   }
   return attachReadback(
      rows,
      updated.map((document) => {
         if (document.exported === undefined) {
            return null;
         }
         /** @type {ReturnType<typeof ctx.shape.paths>} The slices of the updated document. */
         const sliced = ctx.shape.paths(document.exported, args.paths);
         if (!sliced.ok) {
            throw shapeRefusal(sliced.error);
         }
         return sliced;
      }),
   );
}
