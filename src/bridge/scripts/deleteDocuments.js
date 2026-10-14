/**
 * The shipped `delete_documents` script: deletes documents through `ctx.core.deleteDocuments`, which guards the whole
 * call before it deletes anything. A dry run lists what would be deleted, embedded cascades included. The deletion is
 * irreversible. The definition is in `definitions.js`.
 */

import { ackDocuments, fitPreview } from '~/bridge/scripts/writeAck.js';

/**
 * Delete the documents, or preview the deletion.
 * @param {Record<string, unknown>} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Promise<Record<string, unknown> | Record<string, unknown>[]>} The rows `{ uuid, name, type }` of the
 * deleted documents, or on a dry run `{ dryRun, rows: [uuid, name, type][], total, cut? }` within the default cap.
 * @throws {import('~/bridge/scripts/registry.js').ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `GATE_DENIED`,
 * `DELETE_REFUSED` or `WRITE_NOT_APPLIED`.
 */
export async function deleteDocumentsHandler(args, ctx) {
   /** @type {Awaited<ReturnType<typeof ctx.core.deleteDocuments>>} The deleted documents, or the preview. */
   const result = await ctx.core.deleteDocuments({
      uuids: args.uuids,
      dryRun: args.dryRun === true,
      actAs: args.actAs,
   });
   return Array.isArray(result) ? ackDocuments(result) : fitPreview(result);
}
