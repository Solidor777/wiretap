// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import os from 'node:os';
import { io as ioClient } from 'socket.io-client';
import { createWiretapServer } from '../../server/server.ts';
import { mcpCall } from './mcpHttp.js';
import {
   TERMINAL_LAUNCH,
   TERMINAL_DATA,
   TERMINAL_STATE,
   TERMINAL_EXIT,
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   PROTOCOL_VERSION,
} from '../../shared/protocol.js';

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

/**
 * Connect a socket.io client to the sidecar and wait for the connection.
 * @param {number} port - The sidecar port.
 * @param {Record<string, Function>} [early] - Listeners registered before connecting, to catch connect-time events.
 * @returns {Promise<object>} The connected client.
 */
async function connect(port, early = {}) {
   /** @type {import('socket.io-client').Socket} The socket.io client under test. */
   const client = ioClient(`http://127.0.0.1:${port}`);
   for (const [event, listener] of Object.entries(early)) {
      client.on(event, listener);
   }
   await new Promise((resolve) => client.on('connect', resolve));
   return client;
}

/**
 * Retry an async check every 20 ms until it returns a truthy value, failing after 1000 ms.
 * @param {() => Promise<unknown> | unknown} check - The condition to evaluate.
 * @param {string} [what] - A description used in the timeout error.
 * @returns {Promise<unknown>} The first truthy value the check returned.
 */
async function poll(check, what = 'condition') {
   /** @type {number} The epoch-millisecond time after which the poll fails. */
   const deadline = Date.now() + 1000;
   while (Date.now() < deadline) {
      /** @type {unknown} The latest check result. */
      const value = await check();
      if (value) {
         return value;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
   }
   throw new Error(`Timed out after 1000 ms waiting for ${what}`);
}

/**
 * Report whether something accepts TCP connections on a loopback port.
 * @param {number} port - The loopback port to probe.
 * @returns {Promise<boolean>} True when a connection was accepted.
 */
function isListening(port) {
   return new Promise((resolve) => {
      /** @type {import('node:net').Socket} The probing connection. */
      const probe = net.connect({ port, host: '127.0.0.1' });
      probe.once('connect', () => {
         probe.destroy();
         resolve(true);
      });
      probe.once('error', () => resolve(false));
   });
}

/**
 * Build a valid identify payload for a human GM endpoint in the fake clients below.
 * @returns {object} An identify payload with kind human and isGM true.
 */
function identifyPayload() {
   return { protocolVersion: PROTOCOL_VERSION, userId: 'u1', userName: 'GM', isGM: true, kind: 'human', dom: true };
}

/**
 * Poll the MCP endpoint until `create_actor` is routed to an identified GM and succeeds.
 * @param {number} mcpPort - The loopback port of the MCP server under test.
 * @returns {Promise<object>} The successful JSON-RPC response.
 */
function createActorWhenGmKnown(mcpPort) {
   return poll(async () => {
      /** @type {object | undefined} The JSON-RPC response, or undefined while the endpoint is not accepting yet. */
      let response;
      try {
         response = await mcpCall(mcpPort, {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'create_actor', arguments: { name: 'Bob', type: 'npc' } },
         });
      } catch {
         // The MCP listener may not be accepting connections yet; the poll retries.
         return undefined;
      }
      return response.result?.isError ? undefined : response;
   }, 'the GM identify to be processed');
}

describe('createWiretapServer loopback binding', () => {
   /** @type {{ io: import('socket.io').Server, ready: Promise<void>, dispose: () => void } | undefined} */
   let server;
   /** @type {object | undefined} */
   let client;

   afterEach(() => {
      client?.close();
      client = undefined;
      server?.dispose();
      server = undefined;
   });

   it('binds the Socket.IO server to 127.0.0.1 only', async () => {
      server = createWiretapServer(0, await freePort(), 'mcp-only');
      await server.ready;
      expect(server.io.httpServer.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4' });
   });

   it('accepts a loopback connection and a socket.io client connects', async () => {
      server = createWiretapServer(0, await freePort(), 'mcp-only');
      await server.ready;
      /** @type {number} The Socket.IO port assigned to the server. */
      const port = server.io.httpServer.address().port;
      expect(await isListening(port)).toBe(true);
      client = await connect(port);
      expect(client.connected).toBe(true);
   });

   it('dispose closes the underlying HTTP server', async () => {
      server = createWiretapServer(0, await freePort(), 'mcp-only');
      await server.ready;
      /** @type {import('node:http').Server} The HTTP server Socket.IO is attached to. */
      const httpServer = server.io.httpServer;
      expect(httpServer.listening).toBe(true);
      server.dispose();
      server = undefined;
      await poll(() => !httpServer.listening, 'the HTTP server to stop listening');
   });

   it('refuses a connection to a non-loopback address of this machine', async (context) => {
      /** @type {string | undefined} A non-internal IPv4 address of this machine, if any. */
      const external = Object.values(os.networkInterfaces())
         .flat()
         .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address;
      if (external === undefined) {
         context.skip();
         return;
      }
      server = createWiretapServer(0, await freePort(), 'mcp-only');
      await server.ready;
      /** @type {number} The Socket.IO port assigned to the server. */
      const port = server.io.httpServer.address().port;
      /** @type {boolean} Whether the external address accepted a TCP connection. */
      const accepted = await new Promise((resolve) => {
         /** @type {import('node:net').Socket} The probing connection. */
         const probe = net.connect({ port, host: external });
         probe.once('connect', () => {
            probe.destroy();
            resolve(true);
         });
         probe.once('error', () => resolve(false));
      });
      expect(accepted).toBe(false);
   });
});

describe('createWiretapServer modes', () => {
   /** @type {{ io: import('socket.io').Server, ready: Promise<void>, dispose: () => void } | undefined} */
   let server;
   /** @type {object | undefined} */
   let client;

   afterEach(() => {
      client?.close();
      client = undefined;
      server?.dispose();
      server = undefined;
   });

   it('full mode handles terminal launch and streams a command to exit', async () => {
      server = createWiretapServer(0, await freePort(), 'full');
      await server.ready;
      client = await connect(server.io.httpServer.address().port);
      /** @type {Promise<{ code: number }>} Resolves with the terminal exit payload. */
      const exited = new Promise((resolve) => client.on(TERMINAL_EXIT, resolve));
      client.emit(TERMINAL_LAUNCH, { command: 'node --version', cols: 80, rows: 24 });
      expect((await exited).code).toBe(0);
   });

   it('defaults to full mode', async () => {
      server = createWiretapServer(0, await freePort());
      await server.ready;
      /** @type {object[]} Terminal state payloads received. */
      const states = [];
      client = await connect(server.io.httpServer.address().port, { [TERMINAL_STATE]: (s) => states.push(s) });
      await poll(() => states.length > 0, 'the connect-time terminal state');
      expect(states[0]).toMatchObject({ running: false });
   });

   it('mcp-only mode ignores terminal events and never reports terminal state', async () => {
      /** @type {number} The MCP port under test. */
      const mcpPort = await freePort();
      server = createWiretapServer(0, mcpPort, 'mcp-only');
      await server.ready;
      /** @type {string[]} Terminal events that reached the client. */
      const seen = [];
      client = await connect(server.io.httpServer.address().port, {
         [TERMINAL_STATE]: () => seen.push(TERMINAL_STATE),
      });
      client.on(TERMINAL_DATA, () => seen.push(TERMINAL_DATA));
      client.on(TERMINAL_EXIT, () => seen.push(TERMINAL_EXIT));
      client.on(BRIDGE_INVOKE, (request, ack) => {
         ack({ ok: true, result: { uuid: 'Actor.abc', id: 'abc', name: request.params.name, type: 'npc' } });
      });
      client.emit(TERMINAL_LAUNCH, { command: 'node --version', cols: 80, rows: 24 });
      // Socket events are handled in order, so once the later identify has taken effect the launch was handled too.
      client.emit(BRIDGE_IDENTIFY, identifyPayload(), () => undefined);
      await createActorWhenGmKnown(mcpPort);
      expect(seen).toEqual([]);
   });

   it('mcp-only mode still routes an MCP tool call through the bridge to an identified GM', async () => {
      /** @type {number} The MCP port under test. */
      const mcpPort = await freePort();
      server = createWiretapServer(0, mcpPort, 'mcp-only');
      await server.ready;
      client = await connect(server.io.httpServer.address().port);
      client.on(BRIDGE_INVOKE, (request, ack) => {
         ack({ ok: true, result: { uuid: 'Actor.abc', id: 'abc', name: request.params.name, type: 'npc' } });
      });
      expect(await client.emitWithAck(BRIDGE_IDENTIFY, identifyPayload())).toEqual({ ok: true });
      /** @type {object} The successful create_actor response. */
      const response = await createActorWhenGmKnown(mcpPort);
      expect(response.result.isError).toBeFalsy();
      expect(response.result.content[0].text).toContain('Actor.abc');
   });

   it('mcp-only dispose releases the MCP port and the socket port', async () => {
      /** @type {number} The MCP port under test. */
      const mcpPort = await freePort();
      server = createWiretapServer(0, mcpPort, 'mcp-only');
      await server.ready;
      /** @type {number} The Socket.IO port assigned to the server. */
      const socketPort = server.io.httpServer.address().port;
      await poll(() => isListening(mcpPort), 'the MCP port to accept connections');
      expect(await isListening(socketPort)).toBe(true);

      expect(() => server.dispose()).not.toThrow();
      server = undefined;
      await poll(async () => !(await isListening(mcpPort)), 'the MCP port to be released');
      await poll(async () => !(await isListening(socketPort)), 'the socket port to be released');
   });
});
