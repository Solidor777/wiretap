/**
 * Helpers shared by the `create_pack` and `delete_pack` handlers: the gate check of a real run and the bound on the
 * ack row.
 */

import { getBudget } from '$shared/budgets.js';
import { GATE_DENIED } from '$shared/protocol.js';
import { truncateUtf8, utf8Bytes } from '$shared/utf8.js';
import { requireGate } from '~/bridge/gates.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * Judge a gate from this client's world settings and refuse the call while it is closed. The pack handlers call it on
 * a real run only, before any pack is looked up, so a closed gate reveals nothing about the world's packs.
 * @param {string} name - A gate name from the GATES registry.
 * @returns {void}
 * @throws {ScriptError} `GATE_DENIED`, with the denial text that names the gate, while the gate is closed.
 */
export function requireOpenGate(name) {
   /** @type {ReturnType<typeof requireGate>} The denial, or null when open; an unreadable gate is closed. */
   const denial = requireGate(name);
   if (denial !== null) {
      throw new ScriptError(GATE_DENIED, denial.message);
   }
}

/**
 * Hold a pack ack row to the `ACK_MAX_BYTES` budget. Only the `label` string is cut (a pack title set in Foundry has no
 * length limit), while `id`, `type` and `documents` must reach the agent whole. The cut keeps the largest prefix whose
 * row JSON fits, counting the JSON escapes of the label. The `id` has no length limit either: when the id alone takes
 * the row past the budget, the label is emptied and the row is returned over the budget, and the sidecar's result
 * enforcer hands it to the agent as a handle to the stored row, so the ack still reaches the agent whole.
 * @param {Record<string, unknown>} row - The ack row with a string `label`.
 * @returns {Record<string, unknown>} A copy of the row, its label cut with `truncateUtf8` when the row is too long.
 */
export function fitPackAck(row) {
   /** @type {number} The most bytes the row's JSON may hold. */
   const maxBytes = getBudget('ACK_MAX_BYTES').value;
   /** @type {number} The bytes of the row's JSON. */
   const rowBytes = utf8Bytes(JSON.stringify(row));
   if (rowBytes <= maxBytes) {
      return { ...row };
   }
   /** @type {string} The label to cut. */
   const label = /** @type {string} */ (row.label);
   /** @type {number} The bytes the label's JSON (quotes and escapes included) may take. */
   const labelBudget = maxBytes - (rowBytes - utf8Bytes(JSON.stringify(label)));
   /** @type {Record<string, unknown>} The candidate row; an empty label when the other fields leave it no room. */
   let fitted = {
      ...row,
      label: '',
   };
   // The raw text of a label is at least two bytes shorter than its JSON, so no limit above `labelBudget - 2` gives a
   // longer fitting prefix; lower limits are tried only while escapes push the JSON over the budget.
   for (let limit = Math.min(utf8Bytes(label) - 1, labelBudget - 2); limit >= 0; limit -= 1) {
      fitted = {
         ...row,
         label: truncateUtf8(label, limit),
      };
      if (utf8Bytes(JSON.stringify(fitted)) <= maxBytes) {
         return fitted;
      }
   }
   return fitted;
}
