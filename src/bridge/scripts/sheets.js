/**
 * The sheet operations `open_sheet`, `close_sheet` and the `wiretap.openSheet` / `wiretap.closeSheet` user queries
 * share: rendering and closing a document's sheet on this client, and the cross-user path that asks another
 * connected user's client to do it. Foundry's `User#query` refuses an offline target and a sender without
 * `QUERY_USER`, and rejects with the receiving handler's error text, which carries no code; so the receiving handlers
 * answer `{ ok: false, code, message }` instead of throwing, and `askUser` turns that answer back into a
 * `ScriptError`.
 */

import { ScriptError } from '~/bridge/scripts/registry.js';
import { cleanForLog, describeCause } from '$shared/logText.js';
import { truncateUtf8 } from '$shared/utf8.js';

/**
 * Most bytes of the sheet id a result carries. A sheet id is `<SheetClassName>-<uuid with dots as dashes>`; the
 * bound keeps `{ ok: true, appId }` within the 128-byte `SHEET_RESULT_MAX_BYTES` whatever the class name.
 * @type {number}
 */
export const APP_ID_MAX_BYTES = 100;

/**
 * How long a user query waits for the target client's answer, in milliseconds. It stays under the 8000 ms script
 * timeout, so a silent client ends as `SHEET_QUERY_FAILED`, not `SCRIPT_TIMEOUT`.
 * @type {number}
 */
export const SHEET_QUERY_TIMEOUT_MS = 5000;

/**
 * Most bytes of text a refusal copies from a thrown error or from the target client's reply.
 * @type {number}
 */
const CAUSE_MAX_BYTES = 200;

/**
 * The form an error code must have to pass through from the target client: the script error code form.
 * @type {RegExp}
 */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * @typedef {{ ok: true, appId: string } | { ok: false, code: string, message: string }} SheetOutcome
 * The outcome of rendering a sheet: the sheet id, or the refusal.
 */

/**
 * Render a document's sheet on this client, bringing it to the front when it is already open.
 * @param {{ sheet: object | null }} document - The live document.
 * @returns {Promise<SheetOutcome>} The bounded sheet id, or `SHEET_UNAVAILABLE` when the document has no sheet or
 * Foundry declined to render it (Foundry shows its own notification then).
 */
export async function renderSheet(document) {
   /** @type {{ render: Function, rendered: boolean, id: string } | null} The document's sheet, built on first use. */
   const sheet = document.sheet;
   if (sheet === null || sheet === undefined) {
      return {
         ok: false,
         code: 'SHEET_UNAVAILABLE',
         message: 'This document has no sheet.',
      };
   }
   await sheet.render({ force: true });
   // `render` resolves without rendering when the sheet's own permission check fails; only the RENDERED state counts.
   if (sheet.rendered !== true) {
      return {
         ok: false,
         code: 'SHEET_UNAVAILABLE',
         message: 'Foundry did not render the sheet.',
      };
   }
   return {
      ok: true,
      appId: truncateUtf8(sheet.id, APP_ID_MAX_BYTES),
   };
}

/**
 * Close a document's sheet on this client when it is open.
 * @param {{ sheet: object | null }} document - The live document.
 * @returns {Promise<{ ok: true, closed: boolean }>} Whether a rendered sheet was closed.
 */
export async function closeSheet(document) {
   /** @type {{ close: Function, rendered: boolean } | null | undefined} The document's sheet. */
   const sheet = document.sheet;
   if (sheet?.rendered === true) {
      await sheet.close();
      return {
         ok: true,
         closed: true,
      };
   }
   return {
      ok: true,
      closed: false,
   };
}

/**
 * Find the connected user a sheet call targets.
 * @param {string} [userId] - The target user's id, when the caller named one.
 * @returns {object | null} The target user, or null when the call runs on this client (no id, or this client's own
 * user, which is never queried).
 * @throws {ScriptError} `ARGS_INVALID` for an unknown user, `USER_OFFLINE` for a user with no connected client.
 */
export function remoteUser(userId) {
   if (userId === undefined || userId === game.user.id) {
      return null;
   }
   /** @type {{ name: string, active: boolean } | undefined} The named user. */
   const user = game.users.get(userId);
   if (user === undefined) {
      throw new ScriptError('ARGS_INVALID', `No user '${cleanForLog(userId, 32)}'.`);
   }
   if (user.active !== true) {
      throw new ScriptError(
         'USER_OFFLINE',
         `User '${cleanForLog(user.name, 64)}' is not connected; a sheet opens or closes only on a connected user's `
            + 'client.',
      );
   }
   return user;
}

/**
 * Send a sheet query to another user's client and check its answer.
 * @param {{ query: Function }} user - The connected target user.
 * @param {string} queryName - The registered query name.
 * @param {string} uuid - The canonical uuid of the document.
 * @param {(reply: unknown) => boolean} isSuccess - Whether a reply is the query's success shape.
 * @returns {Promise<object>} The success reply.
 * @throws {ScriptError} The target client's refusal code and bounded message; `SHEET_QUERY_FAILED` when the query
 * rejects (no answer in time, the target disconnected) or the reply has neither shape.
 */
export async function askUser(user, queryName, uuid, isSuccess) {
   /** @type {unknown} The target client's answer. */
   let reply;
   try {
      reply = await user.query(queryName, { uuid }, { timeout: SHEET_QUERY_TIMEOUT_MS });
   } catch (error) {
      throw new ScriptError('SHEET_QUERY_FAILED', describeCause(error, CAUSE_MAX_BYTES));
   }
   if (reply?.ok === false && typeof reply.code === 'string' && ERROR_CODE.test(reply.code)) {
      throw new ScriptError(reply.code, cleanForLog(reply.message, CAUSE_MAX_BYTES));
   }
   if (!isSuccess(reply)) {
      throw new ScriptError('SHEET_QUERY_FAILED', 'The user\'s client sent an unexpected reply.');
   }
   return reply;
}
