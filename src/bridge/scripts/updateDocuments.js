/**
 * The shipped `update_documents` script: path-scoped updates through `ctx.core.updateDocuments`, which guards and
 * validates the whole call before it writes. Each `updates` entry is one patch; the entries of one uuid form that
 * document's update. The definition is in `definitions.js`.
 */

import { ScriptError } from '~/bridge/scripts/registry.js';
import { BEST_PRACTICE, SizeNotes, longest, totalBytes } from '~/bridge/scripts/sizeNotes.js';
import { checkReadbackPaths, parseJson, shapeRefusal } from '~/bridge/scripts/writeArgs.js';
import { ackUpdates, attachReadback } from '~/bridge/scripts/writeAck.js';

/**
 * Group the patch entries by uuid, in first-use order, parsing each value as JSON.
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
 * Note the best-practice sizes of a list of patch entries: the entries, the bytes and the longest of their values.
 * @param {SizeNotes} notes - The size notes of the call.
 * @param {Array<{ value?: string }>} entries - The validated entries.
 * @returns {void}
 */
export function notePatchEntries(notes, entries) {
   /** @type {unknown[]} The value texts of the entries. */
   const values = entries.map((entry) => entry.value);
   notes.note(entries.length, 'update entries in one call', BEST_PRACTICE.updateEntries);
   notes.note(totalBytes(values), 'bytes of data in one call', BEST_PRACTICE.dataBytes);
   notes.note(longest(values), 'characters in one update value', BEST_PRACTICE.textChars);
}

/**
 * Note the most patches the grouped updates give one document.
 * @param {SizeNotes} notes - The size notes of the call.
 * @param {ReturnType<typeof groupPatches>} updates - The updates, one per uuid.
 * @returns {void}
 */
export function notePatchesPerDocument(notes, updates) {
   notes.note(
      updates.reduce((most, update) => Math.max(most, update.patches.length), 0),
      'patches on one document',
      BEST_PRACTICE.paths,
   );
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
   /** @type {SizeNotes} The best-practice sizes this call passes, written as one line before the updates run. */
   const notes = new SizeNotes('update_documents');
   notePatchEntries(notes, args.updates);
   notes.note(args.paths?.length ?? 0, 'paths in one call', BEST_PRACTICE.paths);
   /** @type {ReturnType<typeof groupPatches>} The updates, one per uuid. */
   let updates;
   try {
      updates = groupPatches(args.updates);
      notes.note(updates.length, 'documents in one call', BEST_PRACTICE.documents);
      notePatchesPerDocument(notes, updates);
   } finally {
      notes.write(ctx.log);
   }
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
