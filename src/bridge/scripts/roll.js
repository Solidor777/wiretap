/**
 * The shipped `roll` script: evaluates a dice formula on this client and returns the total and each die. Nothing is
 * posted to chat unless `toChat` is true. The definition is in `diceDefinitions.js`.
 */

import { getBudget } from '$shared/budgets.js';
import { cleanForLog, describeCause } from '$shared/logText.js';
import { truncateUtf8, utf8Bytes } from '$shared/utf8.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * @typedef {[number, number[]] | [number, number[], number[]]} DieEntry
 * One die term: its faces, its active results and, when there are any, its inactive (dropped, rerolled or discarded)
 * results.
 */

/**
 * @typedef {{ total: number, formula: string, dice: DieEntry[], cut?: true }} RollResult
 * The `roll` result; `cut` is set when results were left out to stay within the result budget.
 */

/**
 * The largest serialized result, in UTF-8 bytes.
 * @type {number}
 */
const ROLL_RESULT_MAX_BYTES = getBudget('ROLL_RESULT_MAX_BYTES').value;

/**
 * The longest formula echoed in a result, in UTF-8 bytes.
 * @type {number}
 */
const FORMULA_MAX_BYTES = 128;

/**
 * The longest formula echoed in a refusal, in UTF-8 bytes.
 * @type {number}
 */
const FORMULA_ECHO_MAX_BYTES = 64;

/**
 * The longest evaluation error text carried in a refusal, in UTF-8 bytes.
 * @type {number}
 */
const CAUSE_MAX_BYTES = 200;

/**
 * Split each die term's results into active and inactive face values, in order.
 * @param {Array<{ faces: number, results: Array<{ result: number, active: boolean }> }>} dice - The evaluated die
 * terms of the roll.
 * @returns {Array<{ faces: number, active: number[], inactive: number[] }>} The values of each term.
 */
function termValues(dice) {
   return dice.map((term) => ({
      faces: term.faces,
      active: term.results.filter((result) => result.active).map((result) => result.result),
      inactive: term.results.filter((result) => !result.active).map((result) => result.result),
   }));
}

/**
 * Whether a result serializes within the budget.
 * @param {object} result - The result to measure.
 * @returns {boolean} Whether its JSON is at most `ROLL_RESULT_MAX_BYTES`.
 */
function fits(result) {
   return utf8Bytes(JSON.stringify(result)) <= ROLL_RESULT_MAX_BYTES;
}

/**
 * Append values to a list one at a time while the result still fits; the value that would not fit is left out.
 * @param {RollResult} result - The result being built, measured after each append.
 * @param {number[]} list - The list inside `result` that receives the values.
 * @param {number[]} values - The values to append, in order.
 * @returns {boolean} Whether every value was appended.
 */
function appendWhileFits(result, list, values) {
   for (const value of values) {
      list.push(value);
      if (!fits(result)) {
         list.pop();
         return false;
      }
   }
   return true;
}

/**
 * Shape the evaluated dice into the result: every term in full when it fits, otherwise results listed in order
 * until one more would push the result over the budget, with `cut: true`. A term is listed only once its entry fits
 * (with its first value, when it has any); an inactive list only once its first value fits.
 * @param {number} total - The roll total.
 * @param {string} formula - The bounded formula.
 * @param {Array<{ faces: number, active: number[], inactive: number[] }>} terms - The values of each term.
 * @returns {RollResult} The result within `ROLL_RESULT_MAX_BYTES`.
 */
function shapeResult(total, formula, terms) {
   /** @type {RollResult} Every term in full. */
   const full = {
      total,
      formula,
      dice: terms.map((term) => {
         /** @type {DieEntry} The faces and active results of this term. */
         const entry = [
            term.faces,
            term.active,
         ];
         if (term.inactive.length > 0) {
            entry.push(term.inactive);
         }
         return entry;
      }),
   };
   if (fits(full)) {
      return full;
   }
   /** @type {RollResult} The cut result, measured with its `cut` flag so the flag's bytes are counted. */
   const result = {
      total,
      formula,
      dice: [],
      cut: true,
   };
   for (const term of terms) {
      /** @type {DieEntry} The entry of this term. */
      const entry = [
         term.faces,
         [],
      ];
      result.dice.push(entry);
      // A term that rolls no dice (`0d6`) has no values to append, so its empty entry is measured on its own.
      if (!fits(result)) {
         result.dice.pop();
         return result;
      }
      if (!appendWhileFits(result, entry[1], term.active)) {
         if (entry[1].length === 0) {
            result.dice.pop();
         }
         return result;
      }
      if (term.inactive.length > 0) {
         /** @type {number[]} The inactive list of this term. */
         const inactive = [];
         entry.push(inactive);
         if (!appendWhileFits(result, inactive, term.inactive)) {
            if (inactive.length === 0) {
               entry.pop();
            }
            return result;
         }
      }
   }
   return result;
}

/**
 * Evaluate a dice formula and shape the result.
 * @param {{ formula: string, toChat?: boolean }} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context (unused).
 * @returns {Promise<RollResult>} The total, the bounded formula and each die term.
 * @throws {ScriptError} `ARGS_INVALID` for a formula with data references, one that does not parse, or one Foundry
 * refuses to evaluate.
 */
export async function rollHandler(args, ctx) {
   /** @type {string} The formula as the agent sent it. */
   const { formula } = args;
   // A roll here has no actor data, so a reference would be replaced silently by another value.
   if (formula.includes('@')) {
      throw new ScriptError('ARGS_INVALID', 'roll has no data source: write numbers instead of @references.');
   }
   /** @type {typeof foundry.dice.Roll} The core roll class. */
   const Roll = foundry.dice.Roll;
   if (!Roll.validate(formula)) {
      throw new ScriptError('ARGS_INVALID', `Invalid dice formula '${cleanForLog(formula, FORMULA_ECHO_MAX_BYTES)}'.`);
   }
   /** @type {foundry.dice.Roll} The dice expression, unevaluated until `evaluate` runs. */
   const roll = new Roll(formula);
   try {
      // Without interactive prompts a roll never waits for manually entered dice.
      await roll.evaluate({ allowInteractive: false });
   } catch (error) {
      throw new ScriptError(
         'ARGS_INVALID',
         `The roll could not be evaluated: ${describeCause(error, CAUSE_MAX_BYTES)}`,
      );
   }
   if (args.toChat === true) {
      await roll.toMessage();
   }
   return shapeResult(roll.total, truncateUtf8(roll.formula, FORMULA_MAX_BYTES), termValues(roll.dice));
}
