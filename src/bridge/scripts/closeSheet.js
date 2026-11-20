/**
 * The shipped `close_sheet` script: closes a document's sheet, when it is open, on the client of a chosen connected
 * user, through the `wiretap.closeSheet` user query, or on the client that runs the call. It never broadcasts. The
 * receiving client checks that the sender is a GM (`sheetQuery.js`). The definition is in `sheetDefinitions.js`.
 */

import { resolveDocument, unreadable } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { askUser, closeSheet, remoteUser } from '~/bridge/scripts/sheets.js';
import { CLOSE_SHEET_QUERY } from '~/bridge/sheetQuery.js';

/**
 * Whether a target client's reply is the close query's success shape.
 * @param {unknown} reply - What the target client answered.
 * @returns {boolean} True for `{ ok: true, closed: boolean }`.
 */
function isClosed(reply) {
   return reply?.ok === true && typeof reply.closed === 'boolean';
}

/**
 * Close the sheet and report whether one was open.
 * @param {{ uuid: string, userId?: string }} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context (unused).
 * @returns {Promise<{ ok: true, closed: boolean }>} Whether a rendered sheet was closed.
 * @throws {ScriptError} `DOC_NOT_FOUND`, `DOC_EXCLUDED`, `ARGS_INVALID`, `USER_OFFLINE`, `SHEET_QUERY_FAILED`, or the
 * target client's refusal code.
 */
export async function closeSheetHandler(args, ctx) {
   /** @type {object} The live document. */
   const document = await resolveDocument({ uuid: args.uuid });
   /** @type {{ code: string, message: string } | null} Why the document may not be read, if it may not. */
   const refusal = unreadable(document);
   if (refusal !== null) {
      throw new ScriptError(refusal.code, refusal.message);
   }
   /** @type {object | null} The connected user whose client closes the sheet, or null for this client. */
   const user = remoteUser(args.userId);
   if (user === null) {
      return closeSheet(document);
   }
   /** @type {{ ok: true, closed: boolean }} The target client's success reply. */
   const reply = await askUser(user, CLOSE_SHEET_QUERY, document.uuid, isClosed);
   return {
      ok: true,
      closed: reply.closed,
   };
}
