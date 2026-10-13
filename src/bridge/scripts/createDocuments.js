/**
 * The shipped `create_documents` script: creates documents of one class through `ctx.core.createDocuments`, which
 * guards and validates the whole call before it writes. The definition is in `definitions.js`.
 */

import { checkReadbackPaths, parseDataObjects, shapeRefusal } from '~/bridge/scripts/writeArgs.js';
import { ackDocuments, attachReadback } from '~/bridge/scripts/writeAck.js';

/**
 * Create the documents and acknowledge them.
 * @param {Record<string, unknown>} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Promise<Record<string, unknown>[]>} One row `{ uuid, name, type }` per document (`dryRun: true` and a null
 * uuid on a dry run), with `values` and `missing` when `paths` was given.
 * @throws {import('~/bridge/scripts/registry.js').ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `GATE_DENIED`,
 * `VALIDATION_FAILED`, `WRITE_NOT_APPLIED` or a `PATH_*` code.
 */
export async function createDocumentsHandler(args, ctx) {
   /** @type {Record<string, unknown>[]} The data of each document. */
   const data = parseDataObjects(args.data);
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
