// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { createWiretapServer } from '../../server/server.ts';
import { ALLOWED_ORIGINS } from '../../server/origins.ts';

/**
 * Reserve a free loopback TCP port by listening on port 0 and releasing it.
 * @returns {Promise<number>} A port that was free at probe time.
 */
function freePort() {
   return new Promise((resolve, reject) => {
      /** @type {import('node:net').Server} A throwaway server used to reserve a port. */
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
         /** @type {number} The port the OS assigned. */
         const { port } = probe.address();
         probe.close(() => resolve(port));
      });
   });
}

describe('origin validation', () => {
   /** @type {ReturnType<typeof createWiretapServer> | undefined} The server under test. */
   let server;
   /** @type {object[]} The clients opened by the test. */
   let clients = [];
   /** @type {number} The MCP port of the server under test. */
   let mcpPort;
   /** @type {number} The Socket.IO port of the server under test. */
   let socketPort;

   afterEach(() => {
      clients.forEach((client) => client.close());
      clients = [];
      server?.dispose();
      server = undefined;
   });

   /**
    * Start a server in mcp-only mode and record both ports.
    * @returns {Promise<void>} Resolves once both ports are bound.
    */
   async function start() {
      mcpPort = await freePort();
      server = createWiretapServer(0, mcpPort, 'mcp-only');
      await server.ready;
      socketPort = server.io.httpServer.address().port;
   }

   /**
    * Try to connect a Socket.IO client over the WebSocket transport with an optional Origin header.
    * @param {string | undefined} origin - The Origin header to send; undefined sends none.
    * @returns {Promise<{ connected: boolean, error?: string }>} Whether the handshake was accepted.
    */
   function tryConnect(origin) {
      return new Promise((resolve) => {
         /** @type {import('socket.io-client').Socket} The client under test. */
         const client = ioClient(`http://127.0.0.1:${socketPort}`, {
            transports: ['websocket'],
            reconnection: false,
            extraHeaders: origin === undefined ? {} : { Origin: origin },
         });
         clients.push(client);
         client.on('connect', () => resolve({ connected: true }));
         client.on('connect_error', (error) => resolve({ connected: false, error: error.message }));
      });
   }

   /**
    * Send a raw JSON-RPC POST to the MCP endpoint with explicit headers.
    * @param {Record<string, string>} headers - Request headers; `Host` and `Origin` are taken verbatim.
    * @returns {Promise<number>} The HTTP status code.
    */
   function mcpPost(headers) {
      return new Promise((resolve, reject) => {
         /** @type {string} The JSON-RPC body. */
         const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
         const req = http.request(
            {
               host: '127.0.0.1',
               port: mcpPort,
               path: '/mcp',
               method: 'POST',
               headers: {
                  'Content-Type': 'application/json',
                  Accept: 'application/json, text/event-stream',
                  'Content-Length': Buffer.byteLength(body),
                  ...headers,
               },
            },
            (res) => {
               res.resume();
               res.on('end', () => resolve(res.statusCode));
            },
         );
         req.on('error', reject);
         req.end(body);
      });
   }

   it('exports the Foundry page origins as the one allowed-origin list', () => {
      expect(ALLOWED_ORIGINS).toEqual([
         'http://localhost:30000',
         'http://127.0.0.1:30000',
         'http://localhost:30001',
         'http://127.0.0.1:30001',
      ]);
   });

   it('refuses a Socket.IO handshake carrying a hostile Origin', async () => {
      await start();
      expect((await tryConnect('http://evil.example')).connected).toBe(false);
   });

   it('answers a hostile-Origin polling handshake with 403 and the message "Origin not allowed"', async () => {
      await start();
      /** @type {{ status: number | undefined, body: string }} The raw HTTP response. */
      const response = await new Promise((resolve, reject) => {
         http
            .get(
               {
                  host: '127.0.0.1',
                  port: socketPort,
                  path: '/socket.io/?EIO=4&transport=polling',
                  headers: { Origin: 'http://evil.example' },
               },
               (res) => {
                  /** @type {string} The accumulated response body. */
                  let body = '';
                  res.on('data', (chunk) => (body += chunk));
                  res.on('end', () => resolve({ status: res.statusCode, body }));
               },
            )
            .on('error', reject);
      });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ code: 4, message: 'Origin not allowed' });
   });

   it('logs refused handshakes under a throttle of 10 per window, truncating the origin to 64 bytes', async () => {
      await start();
      /** @type {import('vitest').MockInstance} The console sink spy. */
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      try {
         const long = `http://${'a'.repeat(200)}.example`;
         for (let i = 0; i < 12; i++) {
            await tryConnect(i === 0 ? long : `http://evil${i}.example`);
         }
         const refusals = spy.mock.calls.map((call) => String(call[0])).filter((l) => l.includes('refused origin'));
         expect(refusals).toHaveLength(10);
         expect(Buffer.byteLength(refusals[0].split('refused origin ')[1], 'utf8')).toBeLessThanOrEqual(66);
         expect(refusals[0]).not.toContain('a'.repeat(100));
      } finally {
         spy.mockRestore();
      }
   });

   it('accepts a Socket.IO handshake with no Origin header', async () => {
      await start();
      expect((await tryConnect(undefined)).connected).toBe(true);
   });

   it('answers 403 to an /mcp request carrying a hostile Origin', async () => {
      await start();
      expect(await mcpPost({ Origin: 'http://evil.example' })).toBe(403);
   });

   it('answers 403 to an /mcp request whose Host is not loopback with the MCP port', async () => {
      await start();
      expect(await mcpPost({ Host: 'evil.example' })).toBe(403);
      expect(await mcpPost({ Host: '127.0.0.1:1' })).toBe(403);
   });

   it.each(['127.0.0.1', 'localhost'])('does not refuse an /mcp request with Host %s:<mcpPort>', async (host) => {
      await start();
      expect(await mcpPost({ Host: `${host}:${mcpPort}` })).not.toBe(403);
   });

   it('does not refuse an /mcp request with an allowed Origin', async () => {
      await start();
      expect(await mcpPost({ Origin: ALLOWED_ORIGINS[0] })).not.toBe(403);
   });
});
