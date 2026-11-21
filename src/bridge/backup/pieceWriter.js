/**
 * Cuts a stream of text into fixed-size pieces of UTF-8 bytes for the backup stream. A piece boundary falls on a byte,
 * not a line or a character: the receiver joins the pieces before it decodes them.
 */

import { BACKUP_PIECE_MAX_BYTES } from '$shared/backup.js';

/**
 * Encodes the written text to UTF-8.
 * @type {TextEncoder}
 */
const ENCODER = new TextEncoder();

/**
 * @typedef {object} PieceWriter
 * @property {(text: string) => Promise<void>} write - Append text; sends every piece it fills, one at a time.
 * @property {() => Promise<{ pieces: number, bytes: number }>} finish - Send the partly filled last piece, if any,
 * and report how many pieces and bytes were sent.
 */

/**
 * Create a writer that buffers UTF-8 bytes and sends each full `maxBytes` slice as one piece, numbered from 0. A piece
 * always carries at least one byte: the receiver refuses an empty data piece, so an empty stream sends none. Each
 * send is awaited before the next, so a rejected send stops the writer and rejects the `write` or `finish` that made
 * it.
 * @param {(seq: number, bytes: Uint8Array) => Promise<void>} send - Sends one piece; the bytes are not reused after.
 * @param {number} [maxBytes] - The size of a full piece (default `BACKUP_PIECE_MAX_BYTES`).
 * @returns {PieceWriter} The `write` and `finish` functions.
 */
export function createPieceWriter(send, maxBytes = BACKUP_PIECE_MAX_BYTES) {
   /** @type {Uint8Array} The piece being filled. */
   let pending = new Uint8Array(maxBytes);
   /** @type {number} How many bytes of `pending` are filled. */
   let filled = 0;
   /** @type {number} The sequence number of the next piece, which is also the count of pieces sent. */
   let seq = 0;
   /** @type {number} Every byte sent so far. */
   let sent = 0;

   /**
    * Send a piece and advance the counters.
    * @param {Uint8Array} bytes - The bytes of one piece.
    * @returns {Promise<void>} Resolves when the send resolves.
    */
   async function sendPiece(bytes) {
      await send(seq, bytes);
      seq += 1;
      sent += bytes.length;
   }

   return {
      write: async (text) => {
         /** @type {Uint8Array} The text as UTF-8. */
         const bytes = ENCODER.encode(text);
         /** @type {number} How many bytes of the text are buffered. */
         let offset = 0;
         while (offset < bytes.length) {
            /** @type {number} How many bytes fit in the current piece. */
            const count = Math.min(maxBytes - filled, bytes.length - offset);
            pending.set(bytes.subarray(offset, offset + count), filled);
            filled += count;
            offset += count;
            if (filled === maxBytes) {
               /** @type {Uint8Array} The full piece, handed over whole. */
               const full = pending;
               pending = new Uint8Array(maxBytes);
               filled = 0;
               await sendPiece(full);
            }
         }
      },
      finish: async () => {
         if (filled > 0) {
            /** @type {Uint8Array} The filled part of the last piece. */
            const last = pending.slice(0, filled);
            filled = 0;
            await sendPiece(last);
         }
         return {
            pieces: seq,
            bytes: sent,
         };
      },
   };
}
