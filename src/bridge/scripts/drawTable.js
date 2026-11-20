/**
 * The shipped `draw_table` script: draws from a RollTable with Foundry's own `RollTable#draw`, which marks drawn
 * results when the table has no replacement and is not in a compendium. Nothing is posted to chat unless `toChat` is
 * true. The definition is in `diceDefinitions.js`.
 */

import { getBudget } from '$shared/budgets.js';
import { cleanForLog } from '$shared/logText.js';
import { truncateUtf8, utf8Bytes } from '$shared/utf8.js';
import { resolveDocument } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * @typedef {{ name: string, text?: string, uuid?: string }} DrawRow
 * One drawn result: its bounded name, the bounded plain text of its description when non-empty, and the uuid of the
 * document it names when it names one.
 */

/**
 * @typedef {{ total: number | null, results: DrawRow[], count: number, cut?: true }} DrawResult
 * The `draw_table` result: the roll total (null when the draw had no roll), the rows, the number of drawn results,
 * and `cut` when rows were dropped to stay within the result budget.
 */

/**
 * The largest serialized result, in UTF-8 bytes.
 * @type {number}
 */
const DRAW_RESULT_MAX_BYTES = getBudget('DRAW_RESULT_MAX_BYTES').value;

/**
 * The longest result name in a row, in UTF-8 bytes.
 * @type {number}
 */
const NAME_MAX_BYTES = 64;

/**
 * The longest description text in a row, in UTF-8 bytes.
 * @type {number}
 */
const TEXT_MAX_BYTES = 200;

/**
 * The longest document class name echoed in a refusal, in UTF-8 bytes.
 * @type {number}
 */
const CLASS_ECHO_MAX_BYTES = 32;

/**
 * Reduce HTML to plain text: each tag becomes a space, then runs of whitespace collapse to one space and the ends are
 * trimmed, so text in adjacent block elements stays separated.
 * @param {string} markup - The HTML description of one drawn result.
 * @returns {string} The words of the description, without markup.
 */
function plainText(markup) {
   return markup
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
}

/**
 * Shape one drawn result into a row.
 * @param {{ name: string, description: string, documentUuid?: string | null }} result - One TableResult the draw
 * produced.
 * @returns {DrawRow} The bounded entry for the agent.
 */
function shapeRow(result) {
   /** @type {DrawRow} The bounded entry for the agent. */
   const row = { name: truncateUtf8(result.name, NAME_MAX_BYTES) };
   /** @type {string} The plain text of the description. */
   const text = plainText(result.description);
   if (text !== '') {
      row.text = truncateUtf8(text, TEXT_MAX_BYTES);
   }
   if (result.documentUuid) {
      row.uuid = result.documentUuid;
   }
   return row;
}

/**
 * Draw from the RollTable and shape the result.
 * @param {{ uuid: string, toChat?: boolean }} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context (unused).
 * @returns {Promise<DrawResult>} The total, the rows and the drawn count.
 * @throws {ScriptError} `DOC_NOT_FOUND` for an unknown uuid, `ARGS_INVALID` when it is not a RollTable,
 * `TABLE_EMPTY` when nothing could be drawn.
 */
export async function drawTableHandler(args, ctx) {
   /** @type {{ documentName: string, draw: Function }} The resolved document. */
   const table = await resolveDocument({ uuid: args.uuid });
   if (table.documentName !== 'RollTable') {
      throw new ScriptError(
         'ARGS_INVALID',
         `uuid names a ${cleanForLog(table.documentName, CLASS_ECHO_MAX_BYTES)}, not a RollTable.`,
      );
   }
   /** @type {{ roll?: { total: number }, results: object[] }} The roll and the drawn results. */
   const { roll, results } = await table.draw({ displayChat: args.toChat === true });
   // Foundry only warns when every result is drawn or none is in range; an empty success would hide that.
   if (results.length === 0) {
      throw new ScriptError(
         'TABLE_EMPTY',
         "Nothing could be drawn: every result is drawn (reset the table) or none is in the formula's range.",
      );
   }
   /** @type {DrawResult} The result with every row. */
   const result = {
      total: roll?.total ?? null,
      results: results.map(shapeRow),
      count: results.length,
   };
   while (utf8Bytes(JSON.stringify(result)) > DRAW_RESULT_MAX_BYTES) {
      result.results.pop();
      result.cut = true;
   }
   return result;
}
