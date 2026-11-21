import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initFoundryBridge } from '~/bridge/foundryBridge.js';
import { exportBackup } from '~/bridge/backup/exportBackup.js';
import { restoreBackup } from '~/bridge/backup/restoreBackup.js';
import { ScriptError, createScriptRegistry } from '~/bridge/scripts/registry.js';
import { BACKUP_EMPTY } from '$shared/backup.js';
import {
   BRIDGE_INVOKE,
   BRIDGE_RESTORE_PIECE,
   OP_BACKUP_EXPORT,
   OP_BACKUP_RESTORE,
} from '$shared/protocol.js';

vi.mock('~/bridge/backup/exportBackup.js', () => ({ exportBackup: vi.fn() }));
vi.mock('~/bridge/backup/restoreBackup.js', () => ({ restoreBackup: vi.fn() }));

/**
 * Build a fake Socket.IO socket whose handlers can be fired.
 * @returns {{ connected: boolean, on: Function, emit: Function, fire: (event: string, ...args: unknown[]) =>
 * Promise<unknown[]> }} The fake socket with `fire`.
 */
function makeFakeSocket() {
   /** @type {Record<string, Function[]>} The registered handlers keyed by event. */
   const handlers = {};
   return {
      connected: false,
      on(event, fn) {
         (handlers[event] ??= []).push(fn);
      },
      emit() {},
      fire: (event, ...args) => Promise.all((handlers[event] ?? []).map((fn) => fn(...args))),
   };
}

/**
 * Wire a bridge onto a fresh fake socket with an empty script registry.
 * @returns {ReturnType<typeof makeFakeSocket>} The wired socket.
 */
function wireBridge() {
   /** @type {ReturnType<typeof makeFakeSocket>} The socket the bridge is wired onto. */
   const socket = makeFakeSocket();
   initFoundryBridge(
      { onSocket: (listener) => listener(socket) },
      { scripts: createScriptRegistry({ log: () => {} }) },
   );
   return socket;
}

beforeEach(() => {
   vi.mocked(exportBackup).mockReset();
   vi.mocked(restoreBackup).mockReset();
});

describe('the backup ops through the client bridge', () => {
   it('routes backupExport to exportBackup with params and { requestId, pieces }', async () => {
      /** @type {{ documents: number, bytes: number, unreadable: number, parents: number }} The mocked result. */
      const result = {
         documents: 1,
         bytes: 200,
         unreadable: 0,
         parents: 0,
      };
      vi.mocked(exportBackup).mockResolvedValue(result);
      /** @type {ReturnType<typeof makeFakeSocket>} The wired socket. */
      const socket = wireBridge();
      /** @type {{ uuids: string[], timeoutMs: number }} The op params. */
      const params = {
         uuids: ['Actor.MOCKACTOR0000001'],
         timeoutMs: 1000,
      };
      /** @type {import('vitest').Mock} The ack callback. */
      const ack = vi.fn();
      await socket.fire(
         BRIDGE_INVOKE,
         {
            op: OP_BACKUP_EXPORT,
            params,
            requestId: 'r1',
         },
         ack,
      );
      expect(exportBackup).toHaveBeenCalledTimes(1);
      const [
         passedParams,
         invocation,
      ] = vi.mocked(exportBackup).mock.calls[0];
      expect(passedParams).toBe(params);
      expect(invocation.requestId).toBe('r1');
      expect(Object.keys(invocation).sort()).toEqual([
         'pieces',
         'requestId',
      ]);
      expect(typeof invocation.pieces.send).toBe('function');
      expect(typeof invocation.pieces.end).toBe('function');
      expect(ack).toHaveBeenCalledWith({
         ok: true,
         result,
      });
   });

   it('routes backupRestore to restoreBackup', async () => {
      /** @type {{ replaced: number }} The mocked result. */
      const result = { replaced: 1 };
      vi.mocked(restoreBackup).mockResolvedValue(result);
      /** @type {ReturnType<typeof makeFakeSocket>} The wired socket. */
      const socket = wireBridge();
      /** @type {{ timeoutMs: number }} The op params. */
      const params = { timeoutMs: 1000 };
      /** @type {import('vitest').Mock} The ack callback. */
      const ack = vi.fn();
      await socket.fire(
         BRIDGE_INVOKE,
         {
            op: OP_BACKUP_RESTORE,
            params,
            requestId: 'r2',
         },
         ack,
      );
      expect(restoreBackup).toHaveBeenCalledTimes(1);
      expect(vi.mocked(restoreBackup).mock.calls[0][0]).toBe(params);
      expect(vi.mocked(restoreBackup).mock.calls[0][1].requestId).toBe('r2');
      expect(exportBackup).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith({
         ok: true,
         result,
      });
   });

   it('a restore piece emitted right after the invoke, in the same tick, reaches the restore', async () => {
      /** @type {import('~/bridge/pieces.js').ReceivedPiece[]} The pieces the mocked restore received. */
      const received = [];
      vi.mocked(restoreBackup).mockImplementation(async (params, invocation) => {
         /** @type {import('~/bridge/pieces.js').PieceReceiver} The receiver, opened before any await. */
         const receiver = invocation.pieces.receive(invocation.requestId);
         try {
            /** @type {import('~/bridge/pieces.js').ReceivedPiece} The first piece. */
            const piece = await receiver.next(1000);
            received.push(piece);
            piece.ack();
            return { pieces: received.length };
         } finally {
            receiver.close();
         }
      });
      /** @type {ReturnType<typeof makeFakeSocket>} The wired socket. */
      const socket = wireBridge();
      /** @type {import('vitest').Mock} The invoke ack callback. */
      const invokeAck = vi.fn();
      /** @type {import('vitest').Mock} The piece ack callback. */
      const pieceAck = vi.fn();
      // No await between the two: the piece arrives in the same tick as the invoke.
      /** @type {Promise<unknown[]>} The invoke listener's completion. */
      const invoked = socket.fire(
         BRIDGE_INVOKE,
         {
            op: OP_BACKUP_RESTORE,
            params: { timeoutMs: 1000 },
            requestId: 'r3',
         },
         invokeAck,
      );
      socket.fire(
         BRIDGE_RESTORE_PIECE,
         {
            requestId: 'r3',
            seq: 0,
            data: new Uint8Array([
               123,
               125,
            ]),
         },
         pieceAck,
      );
      await invoked;
      expect(received).toHaveLength(1);
      expect(received[0].seq).toBe(0);
      expect(pieceAck).toHaveBeenCalledTimes(1);
      expect(pieceAck).toHaveBeenCalledWith({ ok: true });
      expect(invokeAck).toHaveBeenCalledWith({
         ok: true,
         result: { pieces: 1 },
      });
   });

   it('acks a ScriptError of a backup op with its code', async () => {
      vi.mocked(exportBackup).mockRejectedValue(new ScriptError(BACKUP_EMPTY, 'Nothing to back up.'));
      /** @type {ReturnType<typeof makeFakeSocket>} The wired socket. */
      const socket = wireBridge();
      /** @type {import('vitest').Mock} The ack callback. */
      const ack = vi.fn();
      await socket.fire(
         BRIDGE_INVOKE,
         {
            op: OP_BACKUP_EXPORT,
            params: { timeoutMs: 1000 },
            requestId: 'r4',
         },
         ack,
      );
      expect(ack).toHaveBeenCalledWith({
         ok: false,
         error: {
            code: BACKUP_EMPTY,
            message: 'Nothing to back up.',
         },
      });
   });
});
