// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { createFoundryBridge } from '../../server/foundryBridge.ts';
import { BridgeError, EndpointGoneError } from '../../server/endpoints.ts';
import { BACKUP_INCOMPLETE, BACKUP_PIECE_MAX_BYTES } from '../../shared/backup.js';
import {
   BRIDGE_BACKUP_PIECE,
   BRIDGE_IDENTIFY,
   BRIDGE_RESTORE_PIECE,
   OP_FAILED,
   PIECE_REFUSED,
   PROTOCOL_VERSION,
} from '../../shared/protocol.js';

/**
 * Build a fake Socket.IO server socket that records its handlers and its emits. An emit's ack is answered by
 * `respond`, or held in `held` when `respond` returns undefined.
 * @param {string} id - The id the fake socket reports.
 * @param {(event: string, payload: unknown) => unknown} [respond] - The ack value of an emit, or undefined to hold it.
 * @returns {{ socket: object, fire: Function, emitted: object[], held: Function[] }} The fake parts.
 */
function makeSocket(id, respond = () => ({ ok: true })) {
   /** @type {Record<string, Function>} Handlers registered through `socket.on`. */
   const handlers = {};
   /** @type {object[]} Events emitted to this socket. */
   const emitted = [];
   /** @type {Function[]} Ack callbacks of emits that were not answered. */
   const held = [];
   return {
      socket: {
         id,
         on: (event, fn) => {
            handlers[event] = fn;
         },
         timeout: () => ({
            emit: (event, payload, ack) => {
               emitted.push({
                  event,
                  payload,
               });
               /** @type {unknown} The answer, or undefined to hold the ack. */
               const answer = respond(event, payload);
               if (answer === undefined) {
                  held.push(ack);
               } else {
                  ack(null, answer);
               }
            },
         }),
      },
      fire: (event, ...args) => handlers[event]?.(...args),
      emitted,
      held,
   };
}

/**
 * Create a bridge with a recording logger and connect one identified GM socket to it.
 * @param {(event: string, payload: unknown) => unknown} [respond] - The fake socket's ack values.
 * @returns {{ bridge: object, fake: ReturnType<typeof makeSocket>, lines: string[] }} The bridge, socket and log.
 */
function setup(respond) {
   /** @type {string[]} Recorded log lines. */
   const lines = [];
   const bridge = createFoundryBridge({ log: (line) => lines.push(line) });
   const fake = makeSocket('gm', respond);
   bridge.handleConnection(fake.socket);
   fake.fire(
      BRIDGE_IDENTIFY,
      {
         protocolVersion: PROTOCOL_VERSION,
         userId: 'u',
         userName: 'GM',
         isGM: true,
         kind: 'human',
         dom: true,
      },
      () => undefined,
   );
   return {
      bridge,
      fake,
      lines,
   };
}

/**
 * Build a sink that records every piece it receives and whether it was told the socket is gone.
 * @param {(piece: object) => unknown} [handle] - What `piece` does with each piece (default: nothing).
 * @returns {{ sink: object, pieces: object[], gone: () => number }} The sink, its pieces and its gone count.
 */
function recordingSink(handle = () => undefined) {
   /** @type {object[]} The pieces handed to the sink. */
   const pieces = [];
   /** @type {number} How many times the bridge told the sink its socket disconnected. */
   let goneCalls = 0;
   return {
      sink: {
         piece: (piece) => {
            pieces.push(piece);
            return handle(piece);
         },
         gone: () => {
            goneCalls++;
         },
      },
      pieces,
      gone: () => goneCalls,
   };
}

/**
 * Fire a backup piece at the bridge and wait for its ack.
 * @param {ReturnType<typeof makeSocket>} fake - The sending socket.
 * @param {unknown} payload - The untrusted piece payload as a client would emit it.
 * @returns {Promise<object>} The ack value.
 */
function sendBackupPiece(fake, payload) {
   return new Promise((resolve) => {
      fake.fire(BRIDGE_BACKUP_PIECE, payload, resolve);
   });
}

// The ack of a malformed piece.
const MALFORMED = {
   ok: false,
   error: {
      code: PIECE_REFUSED,
      message: 'Malformed backup piece.',
   },
};

describe('createFoundryBridge backup pieces', () => {
   it('hands a valid data piece to the sink of its socket and requestId and acks ok', async () => {
      const { bridge, fake } = setup();
      const recorder = recordingSink();
      bridge.expectPieces('gm', 'r1', recorder.sink);
      const data = Buffer.from([
         1,
         2,
         3,
      ]);
      await expect(sendBackupPiece(fake, { requestId: 'r1', seq: 0, data })).resolves.toEqual({ ok: true });
      await expect(
         sendBackupPiece(fake, {
            requestId: 'r1',
            seq: 1,
            end: true,
            pieces: 1,
            bytes: 3,
         }),
      ).resolves.toEqual({ ok: true });
      expect(recorder.pieces).toEqual([
         {
            seq: 0,
            data,
         },
         {
            seq: 1,
            end: true,
            pieces: 1,
            bytes: 3,
         },
      ]);
   });

   it('wraps a Uint8Array piece as a Buffer', async () => {
      const { bridge, fake } = setup();
      const recorder = recordingSink();
      bridge.expectPieces('gm', 'r1', recorder.sink);
      await sendBackupPiece(fake, {
         requestId: 'r1',
         seq: 0,
         data: new Uint8Array([
            4,
            5,
         ]),
      });
      expect(Buffer.isBuffer(recorder.pieces[0].data)).toBe(true);
      expect([...recorder.pieces[0].data]).toEqual([
         4,
         5,
      ]);
   });

   it.each([
      ['no requestId', { seq: 0, data: Buffer.alloc(1) }],
      ['a requestId of 65 bytes', { requestId: 'r'.repeat(65), seq: 0, data: Buffer.alloc(1) }],
      ['an empty requestId', { requestId: '', seq: 0, data: Buffer.alloc(1) }],
      ['seq -1', { requestId: 'r1', seq: -1, data: Buffer.alloc(1) }],
      ['seq 1.5', { requestId: 'r1', seq: 1.5, data: Buffer.alloc(1) }],
      ['seq 2^31', { requestId: 'r1', seq: 2 ** 31, data: Buffer.alloc(1) }],
      ['empty data', { requestId: 'r1', seq: 0, data: Buffer.alloc(0) }],
      ['data of 512001 bytes', { requestId: 'r1', seq: 0, data: Buffer.alloc(BACKUP_PIECE_MAX_BYTES + 1) }],
      ['data and end', { requestId: 'r1', seq: 0, data: Buffer.alloc(1), end: true, pieces: 1, bytes: 1 }],
      ['end with pieces -1', { requestId: 'r1', seq: 0, end: true, pieces: -1, bytes: 0 }],
      ['end with fractional bytes', { requestId: 'r1', seq: 0, end: true, pieces: 0, bytes: 0.5 }],
      ['end that is not true', { requestId: 'r1', seq: 0, end: 1, pieces: 0, bytes: 0 }],
      ['a string as data', { requestId: 'r1', seq: 0, data: 'abc' }],
      ['neither data nor end', { requestId: 'r1', seq: 0 }],
      ['a non-object payload', 'piece'],
      ['null', null],
   ])('refuses a malformed piece with PIECE_REFUSED: %s', async (_label, payload) => {
      const { bridge, fake } = setup();
      const recorder = recordingSink();
      bridge.expectPieces('gm', 'r1', recorder.sink);
      await expect(sendBackupPiece(fake, payload)).resolves.toEqual(MALFORMED);
      expect(recorder.pieces).toEqual([]);
   });

   it('accepts a data piece of exactly the maximum size and the largest seq', async () => {
      const { bridge, fake } = setup();
      const recorder = recordingSink();
      bridge.expectPieces('gm', 'r1', recorder.sink);
      await expect(
         sendBackupPiece(fake, {
            requestId: 'r1',
            seq: 2 ** 31 - 1,
            data: Buffer.alloc(BACKUP_PIECE_MAX_BYTES),
         }),
      ).resolves.toEqual({ ok: true });
      expect(recorder.pieces[0].data.length).toBe(BACKUP_PIECE_MAX_BYTES);
   });

   it('refuses a piece for another socket\'s requestId and a piece nobody expects', async () => {
      const { bridge, fake } = setup();
      const recorder = recordingSink();
      bridge.expectPieces('other', 'r1', recorder.sink);
      const refusal = {
         ok: false,
         error: {
            code: PIECE_REFUSED,
            message: 'No backup is waiting for this piece.',
         },
      };
      await expect(sendBackupPiece(fake, { requestId: 'r1', seq: 0, data: Buffer.alloc(1) })).resolves.toEqual(
         refusal,
      );
      await expect(sendBackupPiece(fake, { requestId: 'r2', seq: 0, data: Buffer.alloc(1) })).resolves.toEqual(
         refusal,
      );
      expect(recorder.pieces).toEqual([]);
   });

   it('refuses a second piece while the first is still being written', async () => {
      /** @type {(() => void) | undefined} Finishes the write of the first piece, once the sink holds it. */
      let finish;
      const { bridge, fake } = setup();
      // Only the first piece is held; later pieces are handled at once.
      const recorder = recordingSink((piece) =>
         piece.seq === 0
            ? new Promise((resolve) => {
                 finish = resolve;
              })
            : undefined,
      );
      bridge.expectPieces('gm', 'r1', recorder.sink);
      const first = sendBackupPiece(fake, { requestId: 'r1', seq: 0, data: Buffer.alloc(1) });
      await expect(sendBackupPiece(fake, { requestId: 'r1', seq: 1, data: Buffer.alloc(1) })).resolves.toEqual({
         ok: false,
         error: {
            code: PIECE_REFUSED,
            message: 'A backup piece is already being written.',
         },
      });
      finish?.();
      await expect(first).resolves.toEqual({ ok: true });
      await expect(sendBackupPiece(fake, { requestId: 'r1', seq: 1, data: Buffer.alloc(1) })).resolves.toEqual({
         ok: true,
      });
      expect(recorder.pieces.map((piece) => piece.seq)).toEqual([
         0,
         1,
      ]);
   });

   it('passes a BridgeError of the sink back in the ack', async () => {
      const { bridge, fake } = setup();
      const recorder = recordingSink(() => {
         throw new BridgeError(BACKUP_INCOMPLETE, 'x');
      });
      bridge.expectPieces('gm', 'r1', recorder.sink);
      await expect(sendBackupPiece(fake, { requestId: 'r1', seq: 0, data: Buffer.alloc(1) })).resolves.toEqual({
         ok: false,
         error: {
            code: BACKUP_INCOMPLETE,
            message: 'x',
         },
      });
   });

   it('acks PIECE_REFUSED and logs the cause when the sink fails otherwise', async () => {
      const { bridge, fake, lines } = setup();
      const recorder = recordingSink(async () => {
         throw new Error('disk full');
      });
      bridge.expectPieces('gm', 'r1', recorder.sink);
      await expect(sendBackupPiece(fake, { requestId: 'r1', seq: 0, data: Buffer.alloc(1) })).resolves.toEqual({
         ok: false,
         error: {
            code: PIECE_REFUSED,
            message: 'The backup piece could not be written.',
         },
      });
      expect(lines.some((line) => line.includes('disk full'))).toBe(true);
   });

   it('throttles the piece refusal log to 10 lines a window', async () => {
      const { fake, lines } = setup();
      for (let i = 0; i < 25; i++) {
         await sendBackupPiece(fake, 'piece');
      }
      expect(lines.filter((line) => line.includes('backup piece'))).toHaveLength(10);
   });

   it('calls gone() on disconnect and forgets the sink', async () => {
      const { bridge, fake } = setup();
      const recorder = recordingSink();
      bridge.expectPieces('gm', 'r1', recorder.sink);
      fake.fire('disconnect');
      expect(recorder.gone()).toBe(1);
      await expect(sendBackupPiece(fake, { requestId: 'r1', seq: 0, data: Buffer.alloc(1) })).resolves.toMatchObject({
         ok: false,
         error: { message: 'No backup is waiting for this piece.' },
      });
      expect(recorder.pieces).toEqual([]);
   });

   it('stops delivering once the returned function is called', async () => {
      const { bridge, fake } = setup();
      const recorder = recordingSink();
      const stop = bridge.expectPieces('gm', 'r1', recorder.sink);
      stop();
      stop();
      await expect(sendBackupPiece(fake, { requestId: 'r1', seq: 0, data: Buffer.alloc(1) })).resolves.toMatchObject({
         ok: false,
         error: { code: PIECE_REFUSED },
      });
      const later = recordingSink();
      bridge.expectPieces('gm', 'r1', later.sink);
      stop();
      await expect(sendBackupPiece(fake, { requestId: 'r1', seq: 0, data: Buffer.alloc(1) })).resolves.toEqual({
         ok: true,
      });
      fake.fire('disconnect');
      expect(recorder.gone()).toBe(0);
      expect(later.gone()).toBe(1);
   });
});

describe('createFoundryBridge sendPiece', () => {
   it('sendPiece resolves on an ok ack and rejects PIECE_REFUSED on a refusal', async () => {
      /** @type {unknown} The ack the fake client answers with. */
      let answer = { ok: true };
      const { bridge, fake } = setup(() => answer);
      const piece = {
         requestId: 'r1',
         seq: 0,
         data: Buffer.alloc(2, 9),
      };
      await expect(bridge.sendPiece('gm', piece, 1000)).resolves.toBeUndefined();
      expect(fake.emitted).toEqual([
         {
            event: BRIDGE_RESTORE_PIECE,
            payload: piece,
         },
      ]);
      answer = {
         ok: false,
         error: {
            code: 'RESTORE_FAILED',
            message: 'ignored',
         },
      };
      await expect(bridge.sendPiece('gm', piece, 1000)).rejects.toMatchObject({
         code: PIECE_REFUSED,
         message: 'The Foundry client refused a restore piece: RESTORE_FAILED.',
      });
      answer = {
         ok: false,
         error: { code: 'x'.repeat(100) },
      };
      await expect(bridge.sendPiece('gm', piece, 1000)).rejects.toMatchObject({
         code: PIECE_REFUSED,
         message: `The Foundry client refused a restore piece: ${OP_FAILED}.`,
      });
      answer = 'nonsense';
      await expect(bridge.sendPiece('gm', piece, 1000)).rejects.toBeInstanceOf(BridgeError);
   });

   it('sendPiece rejects EndpointGoneError when the socket disconnects before the ack', async () => {
      const { bridge, fake } = setup(() => undefined);
      const sending = bridge.sendPiece(
         'gm',
         {
            requestId: 'r1',
            seq: 0,
            end: true,
            pieces: 0,
            bytes: 0,
         },
         1000,
      );
      expect(fake.held).toHaveLength(1);
      fake.fire('disconnect');
      await expect(sending).rejects.toBeInstanceOf(EndpointGoneError);
   });
});
