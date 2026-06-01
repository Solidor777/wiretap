// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import { createWiretapServer } from '../../server/server.ts';
import { WIRETAP_MESSAGE } from '../../shared/protocol.js';

describe('Wiretap sidecar echo', () => {
   /** @type {import('socket.io').Server | undefined} */
   let server;

   afterEach(async () => {
      if (server) {
         await new Promise((resolve) => server.close(resolve));
         server = undefined;
      }
   });

   it('echoes a message with a timestamp via the ack callback', async () => {
      server = createWiretapServer(0);
      const port = server.httpServer.address().port;
      const client = ioClient(`http://localhost:${port}`);

      const reply = await new Promise((resolve, reject) => {
         client.emit(WIRETAP_MESSAGE, { text: 'ping' }, resolve);
         setTimeout(() => reject(new Error('no ack within 2s')), 2000);
      });

      client.close();
      expect(reply.text).toBe('ping');
      expect(typeof reply.receivedAt).toBe('string');
      expect(Number.isNaN(Date.parse(reply.receivedAt))).toBe(false);
   });
});
