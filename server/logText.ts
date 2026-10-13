import { truncateUtf8 } from './utf8.ts';

// The Unicode line and paragraph separators, built from code points so the source holds no raw line terminator.
const LINE_SEPARATORS: string = String.fromCharCode(0x2028, 0x2029);

// C0 and C1 control characters (newlines included) and the Unicode line separators: text that can forge or split a
// log line.
export const CONTROL_PATTERN: RegExp = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${LINE_SEPARATORS}]`);

// The same set, global, for replacement.
const CONTROL_PATTERN_GLOBAL: RegExp = new RegExp(CONTROL_PATTERN.source, 'g');

// Default bound of a thrown value's text in a log line, in UTF-8 bytes.
export const LOG_CAUSE_BYTES: number = 200;

/**
 * Make untrusted text safe for one log line: control characters replaced by spaces, cut to a byte bound.
 * @param {string} text - The untrusted text.
 * @param {number} maxBytes - The byte bound.
 * @returns {string} The cleaned text.
 */
export function cleanForLog(text: string, maxBytes: number): string {
   return truncateUtf8(text.replace(CONTROL_PATTERN_GLOBAL, ' '), maxBytes);
}

/**
 * Describe a thrown value for one log line without ever throwing: its message (an Error) or string form, cleaned and
 * bounded. A value that cannot be read becomes a fixed text.
 * @param {unknown} cause - The thrown value.
 * @param {number} [maxBytes] - The byte bound (default `LOG_CAUSE_BYTES`).
 * @returns {string} The safe text.
 */
export function describeCause(cause: unknown, maxBytes: number = LOG_CAUSE_BYTES): string {
   try {
      return cleanForLog(cause instanceof Error ? cause.message : String(cause), maxBytes);
   } catch {
      return 'unprintable value';
   }
}
