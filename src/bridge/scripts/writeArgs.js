/**
 * Argument helpers shared by the write scripts: parsing the JSON text the argument-schema subset carries (it has no
 * free-form object or any-typed value), bounding the total data, and checking read-back paths before anything is
 * written.
 */

import { getBudget } from '$shared/budgets.js';
import { utf8Bytes } from '$shared/utf8.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * Turn a shape refusal, `<code>: <message>`, into a script error that acks that code.
 * @param {string} text - The refusal text of `ctx.shape`.
 * @returns {ScriptError} The error; `PATH_INVALID` when the text carries no code.
 */
export function shapeRefusal(text) {
   /** @type {number} Where the code ends. */
   const split = text.indexOf(': ');
   if (split > 0) {
      return new ScriptError(text.slice(0, split), text.slice(split + 2));
   }
   return new ScriptError('PATH_INVALID', text);
}

/**
 * Refuse a call whose JSON text is larger in all than the data bound.
 * @param {string[]} texts - Every JSON text the call carries.
 * @returns {void}
 * @throws {ScriptError} `ARGS_INVALID`.
 */
export function checkDataBytes(texts) {
   /** @type {number} The most bytes one call may carry. */
   const max = getBudget('WRITE_DATA_MAX_BYTES').value;
   /** @type {number} The bytes counted so far. */
   let total = 0;
   for (const text of texts) {
      total += utf8Bytes(text);
      if (total > max) {
         throw new ScriptError('ARGS_INVALID', `The data is over ${max} bytes in all; split the call.`);
      }
   }
}

/**
 * Parse JSON text.
 * @param {string} text - The JSON text of one data object.
 * @param {string} label - What the text is called in an error, for example `data[1]`.
 * @returns {unknown} The parsed value.
 * @throws {ScriptError} `ARGS_INVALID`.
 */
export function parseJson(text, label) {
   try {
      return JSON.parse(text);
   } catch {
      throw new ScriptError('ARGS_INVALID', `${label} is not valid JSON text.`);
   }
}

/**
 * Parse the JSON object text of each document of a create call.
 * @param {string[]} texts - One JSON object text per document.
 * @returns {Record<string, unknown>[]} The parsed data objects, in argument order.
 * @throws {ScriptError} `ARGS_INVALID` naming the entry that is not a JSON object.
 */
export function parseDataObjects(texts) {
   checkDataBytes(texts);
   return texts.map((text, index) => {
      /** @type {unknown} The parsed entry. */
      const value = parseJson(text, `data[${index}]`);
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
         throw new ScriptError('ARGS_INVALID', `data[${index}] must be a JSON object.`);
      }
      return value;
   });
}

/**
 * Check read-back paths with the path grammar before any write, so a bad path cannot fail a call that already wrote.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @param {string[] | undefined} paths - The read-back paths, if any.
 * @returns {void}
 * @throws {ScriptError} A `PATH_*` code.
 */
export function checkReadbackPaths(ctx, paths) {
   if (paths === undefined) {
      return;
   }
   /** @type {ReturnType<typeof ctx.shape.paths>} The grammar's verdict on an empty document. */
   const checked = ctx.shape.paths({}, paths);
   if (!checked.ok) {
      throw shapeRefusal(checked.error);
   }
}
