/**
 * The shipped `create_documents` script: creates documents of one class through `ctx.core.createDocuments`, which
 * guards and validates the whole call before it writes. The data comes from `data` (JSON text per document) or from
 * `fromUuids` (copies built by `copyDataFromUuids`), never both; a copy meets every check the same data given as `data`
 * meets. The definition is in `definitions.js`.
 */

import { ScriptError } from '~/bridge/scripts/registry.js';
import { checkReadbackPaths, parseDataObjects, shapeRefusal } from '~/bridge/scripts/writeArgs.js';
import { ackDocuments, attachReadback } from '~/bridge/scripts/writeAck.js';
import { copyDataFromUuids } from '~/bridge/scripts/writeCopy.js';

/**
 * Create the documents and acknowledge them.
 * @param {Record<string, unknown>} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Promise<Record<string, unknown>[]>} One row `{ uuid, name, type }` per document (`dryRun: true` and a null
 * uuid on a dry run), with `values` and `missing` when `paths` was given.
 * @throws {ScriptError} `ARGS_INVALID` (also for both or neither of `data` and `fromUuids`), `DOC_NOT_FOUND`,
 * `DOC_EXCLUDED`, `GATE_DENIED`, `VALIDATION_FAILED`, `WRITE_NOT_APPLIED` or a `PATH_*` code.
 */
export async function createDocumentsHandler(args, ctx) {
   if ((args.data === undefined) === (args.fromUuids === undefined)) {
      throw new ScriptError('ARGS_INVALID', 'Give data or fromUuids, not both and not neither.');
   }
   /** @type {Record<string, unknown>[]} The data of each document. */
   const data =
      args.data === undefined
         ? await copyDataFromUuids({
            documentName: args.documentName,
            fromUuids: args.fromUuids,
            keepId: args.keepId === true,
         })
         : parseDataObjects(args.data);
   checkReadbackPaths(ctx, args.paths);
   /** @type {Awaited<ReturnType<typeof ctx.core.createDocuments>>} The created documents. */
   const created = await ctx.core.createDocuments({
      documentName: args.documentName,
      data,
      parentUuid: args.parentUuid,
      pack: args.pack,
      keepId: args.keepId === true,
      dryRun: args.dryRun === true,
      readback: args.paths !== undefined && args.dryRun !== true,
      idempotencyKey: args.idempotencyKey,
      actAs: args.actAs,
      // A copy's idempotency hash reads the uuids, not the copied bodies: a source edited between a call and its
      // retry would otherwise turn the retry into a conflict.
      ...(args.fromUuids === undefined ? {} : { requestData: { fromUuids: args.fromUuids } }),
   });
   /** @type {Record<string, unknown>[]} The acknowledgement rows. */
   const rows = ackDocuments(created);
   if (args.paths === undefined || args.dryRun === true) {
      return rows;
   }
   return attachReadback(
      rows,
      created.map((document) => {
         if (document.exported === undefined) {
            return null;
         }
         /** @type {ReturnType<typeof ctx.shape.paths>} The slices of the created document. */
         const sliced = ctx.shape.paths(document.exported, args.paths);
         if (!sliced.ok) {
            throw shapeRefusal(sliced.error);
         }
         return sliced;
      }),
   );
}
