/**
 * The `wiretap.openSheet` and `wiretap.closeSheet` user queries: a GM's client asks another connected user's client
 * to open or close a document's sheet. They are registered in `CONFIG.queries` on every client, players included,
 * because the receiving client, not the sender, judges the request. Foundry lets players query users by default
 * (`QUERY_USER`), so each handler first refuses a sender who is not a GM; the open handler also requires OBSERVER for
 * this client's user, stricter than Foundry's own LIMITED sheet threshold. The handlers never throw: Foundry would
 * pass a thrown error to the sender as text only, losing the code, so each answers `{ ok: false, code, message }`.
 */

import { resolveDocument } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { closeSheet, renderSheet } from '~/bridge/scripts/sheets.js';
import { describeCause } from '$shared/logText.js';

/**
 * The query that opens a document's sheet on the receiving client.
 * @type {string}
 */
export const OPEN_SHEET_QUERY = 'wiretap.openSheet';

/**
 * The query that closes a document's sheet on the receiving client.
 * @type {string}
 */
export const CLOSE_SHEET_QUERY = 'wiretap.closeSheet';

/**
 * Most bytes of an unexpected error's text an answer carries.
 * @type {number}
 */
const CAUSE_MAX_BYTES = 200;

/**
 * @typedef {import('~/bridge/scripts/sheets.js').SheetOutcome} SheetOutcome
 */

/**
 * @typedef {{ ok: true, closed: boolean } | { ok: false, code: string, message: string }} CloseOutcome
 * The outcome of closing a sheet: whether one was closed, or the refusal.
 */

/**
 * @typedef {{ ok: false, code: string, message: string }} QueryRefusal
 * A refusal answered to the sender.
 */

/**
 * @typedef {object} QueryContext
 * @property {{ isGM?: boolean }} [user] - The sending user, set by the server from the authenticated socket.
 * @property {number} [timeout] - The timeout the sender set, in milliseconds.
 */

/**
 * Build a refusal answer.
 * @param {string} code - The error code.
 * @param {string} message - The short failure text.
 * @returns {QueryRefusal} The refusal.
 */
function refuse(code, message) {
   return {
      ok: false,
      code,
      message,
   };
}

/**
 * Resolve the document a query names.
 * @param {unknown} data - The query data the sender sent.
 * @returns {Promise<{ document: object } | { refusal: QueryRefusal }>} The live document, or the refusal:
 * `ARGS_INVALID` when the uuid is not text, else the code and message of the resolution failure.
 */
async function resolveQueried(data) {
   if (typeof data?.uuid !== 'string') {
      return { refusal: refuse('ARGS_INVALID', 'The query needs a uuid.') };
   }
   try {
      return { document: await resolveDocument({ uuid: data.uuid }) };
   } catch (error) {
      if (error instanceof ScriptError) {
         return { refusal: refuse(error.code, error.message) };
      }
      return { refusal: refuse('SHEET_UNAVAILABLE', describeCause(error, CAUSE_MAX_BYTES)) };
   }
}

/**
 * Handle `wiretap.openSheet`: render the named document's sheet on this client for a GM sender, when this client's
 * user has OBSERVER on the document.
 * @param {unknown} data - The query data, `{ uuid }`.
 * @param {QueryContext} context - The query context Foundry passes.
 * @returns {Promise<SheetOutcome>} The sheet id, or the refusal; never rejects.
 */
export async function handleOpenSheetQuery(data, context) {
   try {
      if (context.user?.isGM !== true) {
         return refuse('SHEET_DENIED', 'Only a GM may open a sheet on another user\'s client.');
      }
      /** @type {{ document: object } | { refusal: QueryRefusal }} The document, or why it is not available. */
      const resolved = await resolveQueried(data);
      if ('refusal' in resolved) {
         return resolved.refusal;
      }
      if (!resolved.document.testUserPermission(game.user, 'OBSERVER')) {
         return refuse('SHEET_DENIED', 'This user needs OBSERVER on the document to see its sheet.');
      }
      return await renderSheet(resolved.document);
   } catch (error) {
      return refuse('SHEET_UNAVAILABLE', describeCause(error, CAUSE_MAX_BYTES));
   }
}

/**
 * Handle `wiretap.closeSheet`: close the named document's sheet on this client for a GM sender, when it is open.
 * @param {unknown} data - The query data, `{ uuid }`.
 * @param {QueryContext} context - The query context Foundry passes.
 * @returns {Promise<CloseOutcome>} Whether a sheet was closed, or the refusal; never rejects.
 */
export async function handleCloseSheetQuery(data, context) {
   try {
      if (context.user?.isGM !== true) {
         return refuse('SHEET_DENIED', 'Only a GM may close a sheet on another user\'s client.');
      }
      /** @type {{ document: object } | { refusal: QueryRefusal }} The document, or why it is not available. */
      const resolved = await resolveQueried(data);
      if ('refusal' in resolved) {
         return resolved.refusal;
      }
      return await closeSheet(resolved.document);
   } catch (error) {
      return refuse('SHEET_UNAVAILABLE', describeCause(error, CAUSE_MAX_BYTES));
   }
}

/**
 * Register both sheet queries in `CONFIG.queries`. Runs at `init` on every client, so a player's client can receive
 * them.
 * @returns {void}
 */
export function registerSheetQueries() {
   CONFIG.queries[OPEN_SHEET_QUERY] = handleOpenSheetQuery;
   CONFIG.queries[CLOSE_SHEET_QUERY] = handleCloseSheetQuery;
}
