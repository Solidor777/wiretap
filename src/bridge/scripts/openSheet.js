/**
 * The shipped `open_sheet` script: renders a document's sheet on the client of a chosen connected user, through the
 * `wiretap.openSheet` user query, or on the client that runs the call. It never broadcasts. The receiving client
 * checks that the sender is a GM and that its own user has OBSERVER (`sheetQuery.js`). The definition is in
 * `sheetDefinitions.js`.
 */

import { resolveDocument, unreadable } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { APP_ID_MAX_BYTES, askUser, remoteUser, renderSheet } from '~/bridge/scripts/sheets.js';
import { OPEN_SHEET_QUERY } from '~/bridge/sheetQuery.js';
import { truncateUtf8 } from '$shared/utf8.js';

/**
 * Whether a target client's reply is the open query's success shape.
 * @param {unknown} reply - What the target client answered.
 * @returns {boolean} True for `{ ok: true, appId: string }`.
 */
function isOpened(reply) {
   return reply?.ok === true && typeof reply.appId === 'string';
}

/**
 * Open the sheet and report its application id.
 * @param {{ uuid: string, userId?: string }} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context (unused).
 * @returns {Promise<{ ok: true, appId: string }>} The bounded id of the rendered sheet.
 * @throws {ScriptError} `DOC_NOT_FOUND`, `DOC_EXCLUDED`, `ARGS_INVALID`, `USER_OFFLINE`, `SHEET_UNAVAILABLE`,
 * `SHEET_QUERY_FAILED`, or the target client's refusal code.
 */
export async function openSheetHandler(args, ctx) {
   /** @type {object} The live document. */
   const document = await resolveDocument({ uuid: args.uuid });
   /** @type {{ code: string, message: string } | null} Why the document may not be read, if it may not. */
   const refusal = unreadable(document);
   if (refusal !== null) {
      throw new ScriptError(refusal.code, refusal.message);
   }
   /** @type {object | null} The connected user whose client renders the sheet, or null for this client. */
   const user = remoteUser(args.userId);
   if (user === null) {
      /** @type {import('~/bridge/scripts/sheets.js').SheetOutcome} The local outcome. */
      const outcome = await renderSheet(document);
      if (!outcome.ok) {
         throw new ScriptError(outcome.code, outcome.message);
      }
      return outcome;
   }
   /** @type {{ ok: true, appId: string }} The target client's success reply. */
   const reply = await askUser(user, OPEN_SHEET_QUERY, document.uuid, isOpened);
   return {
      ok: true,
      appId: truncateUtf8(reply.appId, APP_ID_MAX_BYTES),
   };
}
