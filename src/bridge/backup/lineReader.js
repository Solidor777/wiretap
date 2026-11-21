/**
 * Split a stream of backup pieces into lines. A piece edge may fall anywhere, inside a line or inside a multi-byte
 * character, so lines are split on the byte 0x0A (a newline, which never occurs inside a UTF-8 multi-byte sequence)
 * and decoded only once complete.
 */

// The byte that ends a line.
const NEWLINE = 0x0a;

/**
 * @typedef {object} LineReader
 * @property {(bytes: Uint8Array) => Uint8Array[]} push - Add the bytes of a piece; returns the complete lines they
 * finish, in order, without their newline, and keeps the rest.
 * @property {() => number} pending - The number of bytes kept: a line not finished yet.
 */

/**
 * Join byte arrays into one.
 * @param {Uint8Array[]} parts - The arrays, in order.
 * @param {number} length - Their total length.
 * @returns {Uint8Array} The joined bytes.
 */
function join(parts, length) {
   /** @type {Uint8Array} The joined bytes. */
   const joined = new Uint8Array(length);
   /** @type {number} Where the next part goes. */
   let offset = 0;
   for (const part of parts) {
      joined.set(part, offset);
      offset += part.byteLength;
   }
   return joined;
}

/**
 * Build a line reader.
 * @returns {LineReader} A reader with nothing pending.
 */
export function createLineReader() {
   /** @type {Uint8Array[]} The bytes of the unfinished line, as they arrived. */
   let tail = [];
   /** @type {number} The byte count of `tail`. */
   let tailLength = 0;
   return {
      push(bytes) {
         /** @type {Uint8Array[]} The lines this piece finishes. */
         const lines = [];
         /** @type {number} Where the current line starts in `bytes`. */
         let start = 0;
         /** @type {number} The next newline in `bytes`, or -1. */
         let end = bytes.indexOf(NEWLINE, start);
         while (end !== -1) {
            /** @type {Uint8Array} The part of the line inside this piece. */
            const part = bytes.subarray(start, end);
            lines.push(tailLength === 0 ? part.slice() : join([
               ...tail,
               part,
            ], tailLength + part.byteLength));
            tail = [];
            tailLength = 0;
            start = end + 1;
            end = bytes.indexOf(NEWLINE, start);
         }
         if (start < bytes.byteLength) {
            /** @type {Uint8Array} A copy of the unfinished rest, so the caller may reuse its buffer. */
            const rest = bytes.slice(start);
            tail.push(rest);
            tailLength += rest.byteLength;
         }
         return lines;
      },
      pending() {
         return tailLength;
      },
   };
}
