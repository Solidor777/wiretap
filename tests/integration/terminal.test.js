// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import { createWiretapServer } from '../../server/server.ts';
import {
   TERMINAL_LAUNCH,
   TERMINAL_INPUT,
   TERMINAL_CLOSE,
   TERMINAL_DATA,
   TERMINAL_EXIT,
} from '../../shared/protocol.js';

/**
 * Resolve once accumulated TERMINAL_DATA satisfies a predicate, or reject on timeout.
 * @param {object} client - The socket.io client.
 * @param {(acc: string) => boolean} predicate - Resolves when true.
 * @param {number} [ms] - Timeout ms.
 * @returns {Promise<string>} Accumulated output.
 */
function waitForData(client, predicate, ms = 8000) {
   return new Promise((resolve, reject) => {
      let acc = '';
      const timer = setTimeout(() => reject(new Error(`timeout; got: ${JSON.stringify(acc)}`)), ms);
      client.on(TERMINAL_DATA, ({ chunk }) => {
         acc += chunk;
         if (predicate(acc)) {
            clearTimeout(timer);
            resolve(acc);
         }
      });
   });
}

describe('Wiretap sidecar terminal manager', () => {
   /** @type {{ io: import('socket.io').Server, dispose: () => void } | undefined} */
   let server;

   afterEach(async () => {
      if (server) {
         await new Promise((resolve) => server.io.close(resolve));
         server = undefined;
      }
   });

   it('launches a command and streams output, then exits', async () => {
      server = createWiretapServer(0, 0);
      const port = server.io.httpServer.address().port;
      const client = ioClient(`http://localhost:${port}`);
      await new Promise((r) => client.on('connect', r));

      const exited = new Promise((resolve) => client.on(TERMINAL_EXIT, resolve));
      const dataP = waitForData(client, (acc) => /v\d+\.\d+\.\d+/.test(acc));
      client.emit(TERMINAL_LAUNCH, { command: 'node --version', cols: 80, rows: 24 });

      const out = await dataP;
      const exit = await exited;
      client.close();
      expect(out).toMatch(/v\d+\.\d+\.\d+/);
      expect(exit.code).toBe(0);
   });

   it('forwards input to the PTY and closes on demand', async () => {
      server = createWiretapServer(0, 0);
      const port = server.io.httpServer.address().port;
      const client = ioClient(`http://localhost:${port}`);
      await new Promise((r) => client.on('connect', r));

      client.emit(TERMINAL_LAUNCH, { command: 'node', cols: 80, rows: 24 });
      await waitForData(client, (acc) => acc.includes('>'));
      const pong = waitForData(client, (acc) => acc.includes('PONG'));
      client.emit(TERMINAL_INPUT, { data: 'console.log("PONG")\r' });
      await pong;

      const exited = new Promise((resolve) => client.on(TERMINAL_EXIT, resolve));
      client.emit(TERMINAL_CLOSE, {});
      const exit = await exited;
      client.close();
      expect(exit).toBeTruthy();
   });
});
