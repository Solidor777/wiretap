import { BACKUP_PIECE_MAX_BYTES } from '$shared/backup.js';
import { cleanForLog } from '$shared/logText.js';
import { BRIDGE_BACKUP_PIECE, BRIDGE_RESTORE_PIECE, PIECE_REFUSED } from '$shared/protocol.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * One piece of a restore stream as a receiver sees it. `ack()` confirms the piece to the sidecar, which then sends the
 * next; `ack(refusal)` refuses it, which stops the stream. Only the first call has an effect.
 * @typedef {object} ReceivedPiece
 * @property {number} seq - The piece's position in the stream, from 0.
 * @property {Uint8Array} [data] - The piece's bytes; absent on the end marker.
 * @property {true} [end] - Present on the end marker.
 * @property {number} [pieces] - The end marker's count of data pieces.
 * @property {number} [bytes] - The end marker's total of data bytes.
 * @property {(refusal?: { code: string, message: string }) => void} ack - Answers the piece.
 */

/**
 * The open receiver of one restore stream.
 * @typedef {object} PieceReceiver
 * @property {(waitMs: number) => Promise<ReceivedPiece>} next - Resolves with the held piece, or the next to arrive;
 * rejects `SCRIPT_TIMEOUT` when none arrives within `waitMs`.
 * @property {() => void} close - Removes the receiver and refuses a held, unacked piece.
 */

/**
 * The piece streams of one socket, in both directions.
 * @typedef {object} PieceChannel
 * @property {(requestId: string, seq: number, data: Uint8Array, waitMs: number) => Promise<void>} send - Sends one data
 * piece of a backup stream and waits for the sidecar's ack.
 * @property {(requestId: string, seq: number, pieces: number, bytes: number, waitMs: number) => Promise<void>} end -
 * Sends the end marker of a backup stream and waits for the sidecar's ack.
 * @property {(requestId: string) => PieceReceiver} receive - Opens the receiver of a restore stream.
 */

/**
 * What an op handler gets beside its params.
 * @typedef {object} OpInvocation
 * @property {string} requestId - The invocation's id, which ties its pieces to it.
 * @property {PieceChannel} pieces - The piece channel of the socket the invocation arrived on.
 */

/**
 * The state of one open receiver.
 * @typedef {object} ReceiverState
 * @property {ReceivedPiece | null} held - The piece received and not yet acked.
 * @property {boolean} delivered - Whether `held` has been handed to a `next` caller.
 * @property {((piece: ReceivedPiece) => void) | null} waiter - Resolves the pending `next` call, if one waits.
 * @property {ReturnType<typeof setTimeout> | undefined} timer - The pending `next` call's timeout.
 */

/**
 * A restore piece that passed the shape check.
 * @typedef {object} ParsedPiece
 * @property {string} requestId - The invocation the piece belongs to.
 * @property {Omit<ReceivedPiece, 'ack'>} fields - The piece as the receiver sees it, without its ack.
 */

/**
 * Longest refusal code named in a send failure, in UTF-8 bytes.
 * @type {number}
 */
const REFUSAL_CODE_MAX_BYTES = 64;

/**
 * Check that a value is a non-negative safe integer.
 * @param {unknown} value - The value to check.
 * @returns {boolean} True for an integer from 0 to `Number.MAX_SAFE_INTEGER`.
 */
function isCount(value) {
   return Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
}

/**
 * Check the shape of a restore piece: a string `requestId`, a count `seq`, and either `data` (an `ArrayBuffer`, as
 * Socket.IO delivers binary in the browser, or a `Uint8Array`) of at most `BACKUP_PIECE_MAX_BYTES` bytes, or
 * `end: true` with count `pieces` and `bytes`; never both.
 * @param {unknown} piece - The received payload.
 * @returns {ParsedPiece | null} The piece with its data as a `Uint8Array`, or null when malformed.
 */
function parsePiece(piece) {
   if (piece === null || typeof piece !== 'object') {
      return null;
   }
   /** @type {Record<string, unknown>} The payload's fields. */
   const fields = /** @type {Record<string, unknown>} */ (piece);
   if (typeof fields.requestId !== 'string' || !isCount(fields.seq)) {
      return null;
   }
   /** @type {string} The invocation id. */
   const requestId = fields.requestId;
   /** @type {number} The position. */
   const seq = /** @type {number} */ (fields.seq);
   if (fields.data !== undefined) {
      if (fields.end !== undefined) {
         return null;
      }
      /** @type {Uint8Array | null} The bytes, wrapped when they arrived as an ArrayBuffer. */
      const data = fields.data instanceof ArrayBuffer
         ? new Uint8Array(fields.data)
         : fields.data instanceof Uint8Array ? fields.data : null;
      if (data === null || data.byteLength > BACKUP_PIECE_MAX_BYTES) {
         return null;
      }
      return {
         requestId,
         fields: {
            seq,
            data,
         },
      };
   }
   if (fields.end !== true || !isCount(fields.pieces) || !isCount(fields.bytes)) {
      return null;
   }
   return {
      requestId,
      fields: {
         seq,
         end: true,
         pieces: /** @type {number} */ (fields.pieces),
         bytes: /** @type {number} */ (fields.bytes),
      },
   };
}

/**
 * Build a `PIECE_REFUSED` ack.
 * @param {string} message - Why the piece is refused.
 * @returns {{ ok: false, error: { code: string, message: string } }} The refusal ack.
 */
function refusal(message) {
   return {
      ok: false,
      error: {
         code: PIECE_REFUSED,
         message,
      },
   };
}

/**
 * Build the piece channel of one socket and register its single `BRIDGE_RESTORE_PIECE` listener, which hands each
 * restore piece to the receiver open for its `requestId`. Each stream has at most one unacked piece: a piece that
 * arrives while one is held, a piece with no open receiver, and a malformed piece are refused at once.
 * @param {import('socket.io-client').Socket} socket - The socket shared with the TerminalConnection.
 * @returns {PieceChannel} The send, end and receive functions bound to the socket.
 */
export function createPieceChannel(socket) {
   /** @type {Map<string, ReceiverState>} The open receivers keyed by requestId. */
   const receivers = new Map();

   socket.on(BRIDGE_RESTORE_PIECE, (piece, ack) => {
      /** @type {ParsedPiece | null} The checked piece. */
      const parsed = parsePiece(piece);
      if (parsed === null) {
         ack(refusal('The restore piece is malformed.'));
         return;
      }
      /** @type {ReceiverState | undefined} The receiver of this stream. */
      const state = receivers.get(parsed.requestId);
      if (state === undefined) {
         ack(refusal('No restore is waiting for this piece.'));
         return;
      }
      if (state.held !== null) {
         ack(refusal('The previous restore piece is not acknowledged yet.'));
         return;
      }
      /** @type {boolean} Whether the piece has been answered. */
      let answered = false;
      /** @type {ReceivedPiece} The piece handed to the receiver. */
      const received = {
         ...parsed.fields,
         ack: (refused) => {
            if (answered) {
               return;
            }
            answered = true;
            if (state.held === received) {
               state.held = null;
            }
            ack(refused === undefined
               ? { ok: true }
               : {
                  ok: false,
                  error: refused,
               });
         },
      };
      state.held = received;
      state.delivered = false;
      if (state.waiter !== null) {
         /** @type {(piece: ReceivedPiece) => void} The waiting `next` call. */
         const resolve = state.waiter;
         clearTimeout(state.timer);
         state.waiter = null;
         state.delivered = true;
         resolve(received);
      }
   });

   /**
    * Emit one backup piece and wait for the sidecar's ack.
    * @param {import('$shared/protocol.js').BackupPiece} piece - The data piece or end marker.
    * @param {number} waitMs - How long to wait for the ack.
    * @returns {Promise<void>} Resolves on an ok ack.
    * @throws {ScriptError} `PIECE_REFUSED` on a refusal; `SCRIPT_TIMEOUT` on a timeout or disconnect.
    */
   const emitPiece = async (piece, waitMs) => {
      // Socket.IO buffers an emit made while disconnected and keeps its ack timer running, so the wait would last the
      // whole `waitMs`, and the buffered piece would go to the next connection, which expects no pieces
      // (`emit` and `_registerAckCallback` in socket.io-client `build/esm/socket.js`).
      if (!socket.connected) {
         throw new ScriptError('SCRIPT_TIMEOUT', 'The sidecar is disconnected; the backup piece was not sent.');
      }
      /** @type {unknown} The sidecar's ack. */
      let answer;
      try {
         answer = await socket.timeout(waitMs).emitWithAck(BRIDGE_BACKUP_PIECE, piece);
      } catch {
         throw new ScriptError('SCRIPT_TIMEOUT', 'The sidecar did not confirm a backup piece in time.');
      }
      if (answer?.ok === true) {
         return;
      }
      /** @type {string} The refusal code, bounded and safe to show. */
      const code = cleanForLog(answer?.error?.code, REFUSAL_CODE_MAX_BYTES);
      throw new ScriptError(PIECE_REFUSED, `The sidecar refused a backup piece (${code}).`);
   };

   return {
      send: (requestId, seq, data, waitMs) => emitPiece(
         {
            requestId,
            seq,
            data,
         },
         waitMs,
      ),
      end: (requestId, seq, pieces, bytes, waitMs) => emitPiece(
         {
            requestId,
            seq,
            end: true,
            pieces,
            bytes,
         },
         waitMs,
      ),
      receive: (requestId) => {
         /** @type {ReceiverState} The new receiver's state. */
         const state = {
            held: null,
            delivered: false,
            waiter: null,
            timer: undefined,
         };
         receivers.set(requestId, state);
         return {
            next: (waitMs) => {
               if (state.held !== null && !state.delivered) {
                  state.delivered = true;
                  return Promise.resolve(state.held);
               }
               return new Promise((resolve, reject) => {
                  state.waiter = resolve;
                  state.timer = setTimeout(() => {
                     state.waiter = null;
                     reject(new ScriptError('SCRIPT_TIMEOUT', 'The restore waited too long for the next piece.'));
                  }, waitMs);
               });
            },
            close: () => {
               if (receivers.get(requestId) === state) {
                  receivers.delete(requestId);
               }
               state.held?.ack({
                  code: PIECE_REFUSED,
                  message: 'The restore stopped before this piece was applied.',
               });
            },
         };
      },
   };
}
