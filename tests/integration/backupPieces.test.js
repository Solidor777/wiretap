// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import { createWiretapServer } from '../../server/server.ts';
import { closedGateState } from '../../shared/gates.js';
import { BACKUP_PIECE_MAX_BYTES } from '../../shared/backup.js';
import {
   BRIDGE_BACKUP_PIECE,
   BRIDGE_GATE_STATE,
   BRIDGE_IDENTIFY,
   BRIDGE_RESTORE_PIECE,
   PROTOCOL_VERSION,
} from '../../shared/protocol.js';
import { reservePort } from '../portPool.js';

/**
 * Build an identify payload.
 * @param {object} [overrides] - Fields replacing the defaults.
 * @returns {object} The payload.
 */
function identify(overrides = {}) {
   return {
      protocolVersion: PROTOCOL_VERSION,
      userId: 'u1',
      userName: 'GM',
      isGM: true,
      kind: 'human',
      dom: true,
      ...overrides,
   };
}

describe('backup pieces over Socket.IO', () => {
   /** @type {ReturnType<typeof createWiretapServer> | undefined} The server under test. */
   let server;
   /** @type {import('socket.io-client').Socket[]} The fake clients opened by the test. */
   let clients = [];

   afterEach(() => {
      clients.forEach((client) => client.close());
      clients = [];
      server?.dispose();
      server = undefined;
   });

   /**
    * Start a server in mcp-only mode and connect one fake Foundry client to it.
    * @returns {Promise<import('socket.io-client').Socket>} The connected client.
    */
   async function connect() {
      server = createWiretapServer(0, await reservePort(), 'mcp-only');
      await server.ready;
      /** @type {import('socket.io-client').Socket} The fake client. */
      const client = ioClient(`http://127.0.0.1:${server.io.httpServer.address().port}`);
      clients.push(client);
      await new Promise((resolve) => client.on('connect', resolve));
      return client;
   }

   it('carries a 512000-byte binary piece each way over a real socket', async () => {
      const client = await connect();
      await client.emitWithAck(BRIDGE_IDENTIFY, identify());
      const socketId = server.bridge.snapshot().socketId;
      /** @type {object[]} The pieces the sidecar sink received. */
      const received = [];
      server.bridge.expectPieces(socketId, 'req-1', {
         piece: (piece) => {
            received.push(piece);
         },
         gone: () => undefined,
      });
      const ack = await client.emitWithAck(BRIDGE_BACKUP_PIECE, {
         requestId: 'req-1',
         seq: 0,
         data: Buffer.alloc(BACKUP_PIECE_MAX_BYTES, 7),
      });
      expect(ack).toEqual({ ok: true });
      expect(received).toHaveLength(1);
      expect(received[0].seq).toBe(0);
      expect(received[0].data.length).toBe(BACKUP_PIECE_MAX_BYTES);
      expect(received[0].data.every((byte) => byte === 7)).toBe(true);

      /** @type {object[]} The restore pieces the fake client received. */
      const restored = [];
      client.on(BRIDGE_RESTORE_PIECE, (piece, reply) => {
         restored.push(piece);
         reply({ ok: true });
      });
      await expect(
         server.bridge.sendPiece(
            socketId,
            {
               requestId: 'req-2',
               seq: 0,
               data: Buffer.alloc(BACKUP_PIECE_MAX_BYTES, 9),
            },
            1000,
         ),
      ).resolves.toBeUndefined();
      expect(restored).toHaveLength(1);
      expect(restored[0].requestId).toBe('req-2');
      expect(restored[0].data.length).toBe(BACKUP_PIECE_MAX_BYTES);
      expect(Buffer.from(restored[0].data).every((byte) => byte === 9)).toBe(true);
   });

   it('carries settings from identify and from a gate-state push to snapshot()', async () => {
      const client = await connect();
      await client.emitWithAck(
         BRIDGE_IDENTIFY,
         identify({
            gateState: { allowDelete: true },
            settings: { backupFolder: 'C:/from-identify' },
         }),
      );
      expect(server.bridge.snapshot()).toMatchObject({
         gateState: {
            ...closedGateState(),
            allowDelete: true,
         },
         settings: { backupFolder: 'C:/from-identify' },
      });
      const ack = await client.emitWithAck(BRIDGE_GATE_STATE, {
         gateState: {},
         settings: { backupFolder: 'D:/from-push' },
      });
      expect(ack).toEqual({ ok: true });
      expect(server.bridge.snapshot()).toMatchObject({
         gateState: closedGateState(),
         settings: { backupFolder: 'D:/from-push' },
      });
   });
});
