/**
 * The shipped `replace_document` script: replaces a document through `ctx.core.replaceDocument`, which guards and
 * validates the call before it writes. The data travels as JSON text. The definition is in `definitions.js`.
 */

import { ScriptError } from '~/bridge/scripts/registry.js';
import { checkDataBytes, checkReadbackPaths, parseJson, shapeRefusal } from '~/bridge/scripts/writeArgs.js';
import { ackReplaced, attachReadback } from '~/bridge/scripts/writeAck.js';

/**
 * Replace the document and acknowledge it.
 * @param {Record<string, unknown>} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Promise<Record<string, unknown>>} The row `{ uuid, changed }` (`dryRun: true` on a dry run, `more` when
 * the list of fields was cut), with `values` and `missing` when `paths` was given.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `PATH_UNSAFE_VALUE`, `GATE_DENIED`, `VALIDATION_FAILED`,
 * `ACT_AS_DENIED`, `WRITE_NOT_APPLIED` or a `PATH_*` code.
 */
export async function replaceDocumentHandler(args, ctx) {
   checkDataBytes([args.data]);
   /** @type {unknown} The parsed data. */
   const data = parseJson(args.data, 'data');
   if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw new ScriptError('ARGS_INVALID', 'data must be a JSON object.');
   }
   checkReadbackPaths(ctx, args.paths);
   /** @type {Awaited<ReturnType<typeof ctx.core.replaceDocument>>} The replaced document. */
   const replaced = await ctx.core.replaceDocument({
      uuid: args.uuid,
      data,
      dryRun: args.dryRun === true,
      readback: args.paths !== undefined && args.dryRun !== true,
      actAs: args.actAs,
   });
   /** @type {Record<string, unknown>[]} The one acknowledgement row. */
   const rows = ackReplaced(replaced);
   if (replaced.exported === undefined) {
      return rows[0];
   }
   /** @type {ReturnType<typeof ctx.shape.paths>} The slices of the replaced document. */
   const sliced = ctx.shape.paths(replaced.exported, args.paths);
   if (!sliced.ok) {
      throw shapeRefusal(sliced.error);
   }
   return attachReadback(rows, [sliced])[0];
}
