import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPieceChannel } from '~/bridge/pieces.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { BRIDGE_BACKUP_PIECE, BRIDGE_RESTORE_PIECE, PIECE_REFUSED } from '$shared/protocol.js';
import { BACKUP_PIECE_MAX_BYTES } from '$shared/backup.js';

/**
 * @typedef {object} RecordedEmit
 * @property {string} event - The event name.
 * @property {object} payload - The emitted payload.
 * @property {number} waitMs - The timeout the emit was given.
 * @property {(value: unknown) => void} resolve - Settles the emit with an ack value.
 * @property {(reason: unknown) => void} reject - Fails the emit as Socket.IO does on a timeout or disconnect.
 */

/**
 * Build a fake Socket.IO socket that records `timeout(ms).emitWithAck` calls and exposes its listeners.
 * @returns {{ emitted: RecordedEmit[], listeners: Record<string, Function[]>, on: Function, timeout: Function,
 * fire: (event: string, ...args: unknown[]) => void }} A socket whose emits wait until the test settles them.
 */
function makeFakeSocket() {
   /** @type {RecordedEmit[]} Every emit, in order. */
   const emitted = [];
   /** @type {Record<string, Function[]>} Listeners keyed by event. */
   const listeners = {};
   return {
      emitted,
      listeners,
      on(event, fn) {
         (listeners[event] ??= []).push(fn);
      },
      timeout(waitMs) {
         return {
            emitWithAck: (event, payload) => new Promise((resolve, reject) => {
               emitted.push({
                  event,
                  payload,
                  waitMs,
                  resolve,
                  reject,
               });
            }),
         };
      },
      fire(event, ...args) {
         for (const fn of listeners[event] ?? []) {
            fn(...args);
         }
      },
   };
}

/**
 * Deliver one restore piece to the channel's listener and capture its ack.
 * @param {ReturnType<typeof makeFakeSocket>} socket - The fake socket.
 * @param {object} piece - The piece payload.
 * @returns {import('vitest').Mock} The ack callback the listener was given.
 */
function deliver(socket, piece) {
   /** @type {import('vitest').Mock} The ack callback. */
   const ack = vi.fn();
   socket.fire(BRIDGE_RESTORE_PIECE, piece, ack);
   return ack;
}

/**
 * Capture the error a promise rejects with.
 * @param {Promise<unknown>} promise - The promise expected to reject.
 * @returns {Promise<unknown>} The rejection reason.
 */
async function rejection(promise) {
   try {
      await promise;
   } catch (err) {
      return err;
   }
   throw new Error('expected a rejection');
}

afterEach(() => {
   vi.useRealTimers();
});

describe('piece channel send', () => {
   it('send emits the piece with its binary data and resolves on an ok ack', async () => {
      const socket = makeFakeSocket();
      const channel = createPieceChannel(socket);
      const data = new Uint8Array([
         1,
         2,
         3,
      ]);
      const sent = channel.send('r1', 0, data, 5000);
      expect(socket.emitted).toHaveLength(1);
      expect(socket.emitted[0].event).toBe(BRIDGE_BACKUP_PIECE);
      expect(socket.emitted[0].waitMs).toBe(5000);
      expect(socket.emitted[0].payload).toEqual({
         requestId: 'r1',
         seq: 0,
         data,
      });
      expect(socket.emitted[0].payload.data).toBe(data);
      socket.emitted[0].resolve({ ok: true });
      await expect(sent).resolves.toBeUndefined();
   });

   it('send throws PIECE_REFUSED naming the code on a refusal, and SCRIPT_TIMEOUT on a timeout', async () => {
      const socket = makeFakeSocket();
      const channel = createPieceChannel(socket);
      const refused = channel.send('r1', 0, new Uint8Array(1), 1000);
      socket.emitted[0].resolve({
         ok: false,
         error: {
            code: 'BACKUP_TOO_LARGE\nforged',
            message: 'too big',
         },
      });
      const refusal = await rejection(refused);
      expect(refusal).toBeInstanceOf(ScriptError);
      expect(refusal.code).toBe(PIECE_REFUSED);
      expect(refusal.message).toBe('The sidecar refused a backup piece (BACKUP_TOO_LARGE forged).');
      const timed = channel.send('r1', 1, new Uint8Array(1), 1000);
      socket.emitted[1].reject(new Error('operation has timed out'));
      const timeout = await rejection(timed);
      expect(timeout).toBeInstanceOf(ScriptError);
      expect(timeout.code).toBe('SCRIPT_TIMEOUT');
      expect(timeout.message).toBe('The sidecar did not confirm a backup piece in time.');
   });

   it('end emits the end marker with pieces and bytes', async () => {
      const socket = makeFakeSocket();
      const channel = createPieceChannel(socket);
      const ended = channel.end('r1', 3, 3, 1200, 2000);
      expect(socket.emitted[0].event).toBe(BRIDGE_BACKUP_PIECE);
      expect(socket.emitted[0].waitMs).toBe(2000);
      expect(socket.emitted[0].payload).toEqual({
         requestId: 'r1',
         seq: 3,
         end: true,
         pieces: 3,
         bytes: 1200,
      });
      socket.emitted[0].resolve({ ok: true });
      await expect(ended).resolves.toBeUndefined();
   });
});

describe('piece channel receive', () => {
   it('receive delivers a piece and acks it only when ack() is called', async () => {
      const socket = makeFakeSocket();
      const channel = createPieceChannel(socket);
      const receiver = channel.receive('r1');
      const data = new Uint8Array([7]);
      const ack = deliver(socket, {
         requestId: 'r1',
         seq: 0,
         data,
      });
      const piece = await receiver.next(1000);
      expect(piece.seq).toBe(0);
      expect(piece.data).toEqual(data);
      expect(piece.end).toBeUndefined();
      expect(ack).not.toHaveBeenCalled();
      piece.ack();
      expect(ack).toHaveBeenCalledWith({ ok: true });
      // A wait that starts before the piece arrives resolves with it.
      const waiting = receiver.next(1000);
      const endAck = deliver(socket, {
         requestId: 'r1',
         seq: 1,
         end: true,
         pieces: 1,
         bytes: 1,
      });
      const end = await waiting;
      expect(end).toMatchObject({
         seq: 1,
         end: true,
         pieces: 1,
         bytes: 1,
      });
      end.ack({
         code: 'BACKUP_INVALID',
         message: 'counts differ',
      });
      expect(endAck).toHaveBeenCalledWith({
         ok: false,
         error: {
            code: 'BACKUP_INVALID',
            message: 'counts differ',
         },
      });
   });

   it('wraps an ArrayBuffer piece in a Uint8Array', async () => {
      const socket = makeFakeSocket();
      const channel = createPieceChannel(socket);
      const receiver = channel.receive('r1');
      const buffer = new Uint8Array([
         4,
         5,
      ]).buffer;
      deliver(socket, {
         requestId: 'r1',
         seq: 0,
         data: buffer,
      });
      const piece = await receiver.next(1000);
      expect(piece.data).toBeInstanceOf(Uint8Array);
      expect([...piece.data]).toEqual([
         4,
         5,
      ]);
   });

   it('refuses a piece nobody receives, a malformed piece and a second unacked piece', async () => {
      const socket = makeFakeSocket();
      const channel = createPieceChannel(socket);
      /**
       * Expect an ack to be a PIECE_REFUSED refusal.
       * @param {import('vitest').Mock} ack - The ack callback.
       * @returns {void}
       */
      const expectRefused = (ack) => {
         expect(ack).toHaveBeenCalledTimes(1);
         expect(ack.mock.calls[0][0].ok).toBe(false);
         expect(ack.mock.calls[0][0].error.code).toBe(PIECE_REFUSED);
         expect(typeof ack.mock.calls[0][0].error.message).toBe('string');
      };
      expectRefused(deliver(socket, {
         requestId: 'nobody',
         seq: 0,
         data: new Uint8Array(1),
      }));
      const receiver = channel.receive('r1');
      for (const malformed of [
         null,
         'piece',
         {
            seq: 0,
            data: new Uint8Array(1),
         },
         {
            requestId: 'r1',
            seq: -1,
            data: new Uint8Array(1),
         },
         {
            requestId: 'r1',
            seq: 1.5,
            data: new Uint8Array(1),
         },
         {
            requestId: 'r1',
            seq: 0,
            data: 'text',
         },
         {
            requestId: 'r1',
            seq: 0,
            data: new Uint8Array(BACKUP_PIECE_MAX_BYTES + 1),
         },
         {
            requestId: 'r1',
            seq: 0,
            data: new Uint8Array(1),
            end: true,
            pieces: 1,
            bytes: 1,
         },
         {
            requestId: 'r1',
            seq: 0,
            end: 'yes',
            pieces: 1,
            bytes: 1,
         },
         {
            requestId: 'r1',
            seq: 0,
            end: true,
            pieces: -1,
            bytes: 1,
         },
         {
            requestId: 'r1',
            seq: 0,
            end: true,
            pieces: 1,
         },
      ]) {
         expectRefused(deliver(socket, malformed));
      }
      const firstAck = deliver(socket, {
         requestId: 'r1',
         seq: 0,
         data: new Uint8Array(1),
      });
      expectRefused(deliver(socket, {
         requestId: 'r1',
         seq: 1,
         data: new Uint8Array(1),
      }));
      const first = await receiver.next(1000);
      expect(first.seq).toBe(0);
      expectRefused(deliver(socket, {
         requestId: 'r1',
         seq: 1,
         data: new Uint8Array(1),
      }));
      expect(firstAck).not.toHaveBeenCalled();
      first.ack();
      expect(firstAck).toHaveBeenCalledWith({ ok: true });
   });

   it('next rejects SCRIPT_TIMEOUT after waitMs with no piece', async () => {
      vi.useFakeTimers();
      const socket = makeFakeSocket();
      const channel = createPieceChannel(socket);
      const receiver = channel.receive('r1');
      const waiting = rejection(receiver.next(1000));
      await vi.advanceTimersByTimeAsync(999);
      /** @type {boolean} Whether the wait settled early. */
      let settled = false;
      waiting.then(() => {
         settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const err = await waiting;
      expect(err).toBeInstanceOf(ScriptError);
      expect(err.code).toBe('SCRIPT_TIMEOUT');
      expect(err.message).toBe('The restore waited too long for the next piece.');
   });

   it('close refuses a held piece and removes the receiver', () => {
      const socket = makeFakeSocket();
      const channel = createPieceChannel(socket);
      const receiver = channel.receive('r1');
      const heldAck = deliver(socket, {
         requestId: 'r1',
         seq: 0,
         data: new Uint8Array(1),
      });
      receiver.close();
      expect(heldAck).toHaveBeenCalledTimes(1);
      expect(heldAck.mock.calls[0][0].error.code).toBe(PIECE_REFUSED);
      const lateAck = deliver(socket, {
         requestId: 'r1',
         seq: 1,
         data: new Uint8Array(1),
      });
      expect(lateAck.mock.calls[0][0].error.code).toBe(PIECE_REFUSED);
   });

   it('delivers a piece emitted in the same tick as the receive call', async () => {
      const socket = makeFakeSocket();
      const channel = createPieceChannel(socket);
      const receiver = channel.receive('r1');
      const ack = deliver(socket, {
         requestId: 'r1',
         seq: 0,
         data: new Uint8Array(1),
      });
      expect(ack).not.toHaveBeenCalled();
      const piece = await receiver.next(1000);
      expect(piece.seq).toBe(0);
      piece.ack();
      expect(ack).toHaveBeenCalledWith({ ok: true });
   });

   it('registers one restore listener per socket', () => {
      const socket = makeFakeSocket();
      createPieceChannel(socket);
      expect(socket.listeners[BRIDGE_RESTORE_PIECE]).toHaveLength(1);
   });
});
