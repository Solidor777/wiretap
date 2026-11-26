/**
 * Best-practice sizes of the core read and write scripts, and the one warning line a call past them writes. No size
 * here refuses a call: the GM decides how much one call carries. The protections still bound every call and refuse
 * with their own messages: path bytes and segments, value depth and nodes, the script time limit, the result wire
 * bound, the MCP request body bound for inline arguments and, for arguments given as handles, the sidecar's
 * handle-input total (`HANDLE_STORE_MAX_BYTES` in `server/handles.ts`, 64 MB).
 */

import { getBudget } from '$shared/budgets.js';
import { utf8Bytes } from '$shared/utf8.js';

/**
 * The best-practice sizes: a call past one runs and notes it in its one warning line. The budget entries are shared
 * with the sidecar; the rest are known only to these scripts.
 * @type {Readonly<{ documents: number, updateEntries: number, dataBytes: number, textChars: number, paths: number,
 * searchLimit: number, filters: number, fieldPathBytes: number, queryChars: number, filterChars: number,
 * cursorChars: number, ifChangedChars: number, uuidChars: number, idempotencyLookup: number }>}
 */
export const BEST_PRACTICE = Object.freeze({
   documents: getBudget('WRITE_DOCUMENTS_MAX').value,
   updateEntries: 200,
   dataBytes: getBudget('WRITE_DATA_MAX_BYTES').value,
   textChars: 100_000,
   paths: getBudget('PATHS_PER_CALL_MAX').value,
   searchLimit: getBudget('SEARCH_MAX_LIMIT').value,
   filters: 5,
   fieldPathBytes: getBudget('SEARCH_FIELD_PATH_MAX_BYTES').value,
   queryChars: 64,
   filterChars: 256,
   cursorChars: 512,
   ifChangedChars: 32,
   uuidChars: 256,
   idempotencyLookup: 20_000,
});

/**
 * Collects the best-practice sizes one call passes and writes them as one log line, so a call logs at most one line
 * however many sizes or items pass.
 */
export class SizeNotes {
   /**
    * The tool the line names.
    * @type {string}
    */
   #tool;

   /**
    * One `<measured> <measure>, over the <size> best-practice size` part per size passed, in the order noted.
    * @type {string[]}
    */
   #parts = [];

   /**
    * Start the notes of one call.
    * @param {string} tool - The tool name the line starts with, for example `create_documents`.
    */
   constructor(tool) {
      this.#tool = tool;
   }

   /**
    * Note a measure of the call; it is kept only when it is over its best-practice size.
    * @param {number} measured - What the call carries, for example 120.
    * @param {string} measure - What is counted, for example `documents in one call`.
    * @param {number} size - The best-practice size, for example 50.
    * @returns {void}
    */
   note(measured, measure, size) {
      if (measured > size) {
         this.#parts.push(`${measured} ${measure}, over the ${size} best-practice size`);
      }
   }

   /**
    * Write the line when any size was passed, then forget the parts.
    * @param {(line: string) => void} log - The script log sink (`ctx.log`); it never throws.
    * @returns {void}
    */
   write(log) {
      if (this.#parts.length > 0) {
         log(`Wiretap | ${this.#tool}: ${this.#parts.join('; ')}`);
      }
      this.#parts = [];
   }
}

/**
 * The longest entry of a list of texts.
 * @param {readonly unknown[]} texts - The texts; an entry that is not a string counts as empty.
 * @param {(text: string) => number} [measure] - How one text is measured; string length (UTF-16 units) by default.
 * @returns {number} The largest measure, 0 for an empty list.
 */
export function longest(texts, measure = (text) => text.length) {
   return texts.reduce((most, text) => Math.max(most, typeof text === 'string' ? measure(text) : 0), 0);
}

/**
 * The UTF-8 bytes of a list of texts in all.
 * @param {readonly unknown[]} texts - The texts; an entry that is not a string counts as empty.
 * @returns {number} The sum of the UTF-8 lengths of every text.
 */
export function totalBytes(texts) {
   return texts.reduce((sum, text) => sum + (typeof text === 'string' ? utf8Bytes(text) : 0), 0);
}
