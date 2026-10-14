/**
 * The advisory `actAs` check of the write operations. A write always runs as the user of the executing GM client; this
 * check only asks Foundry whether another user would be allowed to make the same change, and refuses when that user
 * would not. It runs after the write guard has judged the gates, so it can only add a refusal and never grants
 * anything: the gates of the executing client stay the upper bound of every call.
 *
 * The check is best-effort advisory: it judges the changes as the call states them (dotted keys expanded to nested
 * objects, as the server reads them). Whatever a hook or a system adds later is outside it, and the permission
 * answers come from this client's copy of the world. It is not an authorization boundary.
 */

import { cleanForLog } from '$shared/logText.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * Longest caller-supplied text echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const ECHO_MAX_BYTES = 48;

/**
 * Resolve the user an `actAs` argument names.
 * @param {unknown} userId - The `actAs` argument, a user id, or undefined for no check.
 * @returns {{ id: string, name?: string } | null} The user, or null when no `actAs` was given.
 * @throws {ScriptError} `ARGS_INVALID` when no such user exists.
 */
export function resolveActAs(userId) {
   if (userId === undefined) {
      return null;
   }
   /** @type {{ id: string, name?: string } | undefined} The user, if the id names one. */
   const user = typeof userId === 'string' ? game.users.get(userId) : undefined;
   if (user === undefined) {
      throw new ScriptError('ARGS_INVALID', `No user '${cleanForLog(String(userId), ECHO_MAX_BYTES)}' for actAs.`);
   }
   return user;
}

/**
 * Ask Foundry whether the `actAs` user may perform an action on each document, as the server asks it
 * (`Document#canUserModify`, `common/abstract/document.mjs:426`).
 * @param {{ id: string, name?: string } | null} user - The user from `resolveActAs`; null skips the check.
 * @param {'create' | 'update' | 'delete'} action - The action about to be performed.
 * @param {Array<{ document: object, data: Record<string, unknown> }>} targets - The documents with the data the
 * action carries.
 * @returns {void}
 * @throws {ScriptError} `ACT_AS_DENIED` naming the user, the action and the first document the user may not change.
 */
export function checkActAs(user, action, targets) {
   if (user === null) {
      return;
   }
   for (const { document, data } of targets) {
      if (!document.canUserModify(user, action, foundry.utils.expandObject(data))) {
         throw new ScriptError(
            'ACT_AS_DENIED',
            cleanForLog(
               `${cleanForLog(String(user.name ?? user.id), ECHO_MAX_BYTES)} may not ${action} ` +
                  `'${cleanForLog(String(document.name ?? document.documentName), ECHO_MAX_BYTES)}'; ` +
                  'nothing was written (advisory actAs check).',
               256,
            ),
         );
      }
   }
}
