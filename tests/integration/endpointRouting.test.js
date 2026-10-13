// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { createWiretapServer } from '../../server/server.ts';
import { callCreateActor, mcpCall } from './mcpHttp.js';
import { createActorScript, registryPayload } from '../unit/scriptFixtures.js';
import {
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   BRIDGE_REGISTRY,
   ENDPOINT_GONE,
   NOT_GM,
   NO_ENDPOINT,
   OP_CALL_TOOL,
   OP_FAILED,
   PROTOCOL_MISMATCH,
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
 * Retry an async check every 20 ms until it returns a truthy value, failing after 1000 ms.
 * @param {() => Promise<unknown> | unknown} check - The condition to evaluate.
 * @param {string} what - A description used in the timeout error.
 * @returns {Promise<unknown>} The first truthy value the check returned.
 */
async function poll(check, what) {
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

/**
 * Identify a fake client as a GM endpoint and register the create_actor script on it.
 * @param {import('socket.io-client').Socket} client - The fake client.
 * @param {object} [overrides] - Identify fields replacing the defaults.
 * @returns {Promise<void>}
 */
async function identifyWithCreateActor(client, overrides = {}) {
   expect(await client.emitWithAck(BRIDGE_IDENTIFY, identify(overrides))).toEqual({ ok: true });
   expect(await client.emitWithAck(BRIDGE_REGISTRY, registryPayload([createActorScript()]))).toMatchObject({
      ok: true,
   });
}

describe('endpoint routing over Socket.IO', () => {
   /** @type {ReturnType<typeof createWiretapServer> | undefined} The server under test. */
   let server;
   /** @type {object[]} The fake clients opened by the test. */
   let clients = [];
   /** @type {number} The MCP port of the server under test. */
   let mcpPort;

   afterEach(() => {
      clients.forEach((client) => client.close());
      clients = [];
      server?.dispose();
      server = undefined;
   });

   /**
    * Start a server in mcp-only mode and wait until both ports are bound.
    * @returns {Promise<number>} The Socket.IO port.
    */
   async function start() {
      mcpPort = await freePort();
      server = createWiretapServer(0, mcpPort, 'mcp-only');
      await server.ready;
      return server.io.httpServer.address().port;
   }

   /**
    * Connect a fake Foundry client that answers every invoke with a result naming it.
    * @param {number} port - The Socket.IO port.
    * @param {string} label - The label returned in results.
    * @param {object[]} received - Receives each invoke payload this client gets.
    * @returns {Promise<object>} The connected client.
    */
   async function connectFake(port, label, received) {
      /** @type {import('socket.io-client').Socket} The fake client. */
      const client = ioClient(`http://127.0.0.1:${port}`);
      clients.push(client);
      client.on(BRIDGE_INVOKE, (request, ack) => {
         received.push(request);
         ack({ ok: true, result: { uuid: `Actor.${label}`, id: label, name: label, type: 'npc' } });
      });
      await new Promise((resolve) => client.on('connect', resolve));
      return client;
   }

   it('routes to the agent endpoint when both kinds are connected', async () => {
      const port = await start();
      const humanSeen = [];
      const agentSeen = [];
      const human = await connectFake(port, 'human', humanSeen);
      const agent = await connectFake(port, 'agent', agentSeen);
      await identifyWithCreateActor(human, { kind: 'human' });
      await identifyWithCreateActor(agent, { kind: 'agent', userId: 'u2' });
      const result = await callCreateActor(mcpPort);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Actor.agent');
      expect(humanSeen).toEqual([]);
      expect(agentSeen).toHaveLength(1);
      expect(agentSeen[0]).toMatchObject({
         op: OP_CALL_TOOL,
         params: { name: 'create_actor', arguments: { name: 'Bob', type: 'npc' } },
      });
      expect(agentSeen[0].requestId).toMatch(/^[0-9a-f-]{36}$/);
   });

   it('falls back to the human endpoint when the agent disconnects', async () => {
      const port = await start();
      const humanSeen = [];
      const human = await connectFake(port, 'human', humanSeen);
      const agent = await connectFake(port, 'agent', []);
      await identifyWithCreateActor(human, { kind: 'human' });
      await identifyWithCreateActor(agent, { kind: 'agent', userId: 'u2' });
      agent.close();
      // The server processes the disconnect asynchronously; poll until the call reaches the human endpoint.
      const result = await poll(async () => {
         const attempt = await callCreateActor(mcpPort);
         return attempt.content[0].text.includes('Actor.human') ? attempt : undefined;
      }, 'the agent disconnect to be processed');
      expect(result.isError).toBeFalsy();
      expect(humanSeen.length).toBeGreaterThan(0);
   });

   it('honours the endpoint override with no fallback', async () => {
      const port = await start();
      const humanSeen = [];
      const human = await connectFake(port, 'human', humanSeen);
      await human.emitWithAck(BRIDGE_IDENTIFY, identify({ kind: 'human' }));
      await expect(server.bridge.invoke(OP_CALL_TOOL, {}, { endpoint: 'agent' })).rejects.toMatchObject({
         code: NO_ENDPOINT,
      });
      expect(humanSeen).toEqual([]);
      await expect(server.bridge.invoke(OP_CALL_TOOL, {}, { endpoint: 'human' })).resolves.toMatchObject({
         uuid: 'Actor.human',
      });
   });

   it('returns the structured NO_ENDPOINT text from create_actor when its endpoint is gone', async () => {
      const port = await start();
      const gm = await connectFake(port, 'human', []);
      await identifyWithCreateActor(gm);
      // Open the session while the endpoint is there, so create_actor is listed to it.
      await mcpCall(mcpPort, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      gm.close();
      // The session drops the tool one debounce after the disconnect; until then the call reaches the router.
      const result = await poll(async () => {
         const attempt = await callCreateActor(mcpPort);
         return attempt.content[0].text.startsWith(`${NO_ENDPOINT}: `) ? attempt : undefined;
      }, 'the call to find no endpoint');
      expect(result.isError).toBe(true);
      /** @type {string} The tool result text. */
      const text = result.content[0].text;
      expect(text.startsWith(`${NO_ENDPOINT}: `)).toBe(true);
      expect(text).toMatch(/GM tab/);
      expect(Buffer.byteLength(text.slice(NO_ENDPOINT.length + 2), 'utf8')).toBeLessThanOrEqual(256);
   });

   it('refuses a v1 identify with PROTOCOL_MISMATCH and does not register it', async () => {
      const port = await start();
      const seen = [];
      const client = await connectFake(port, 'v1', seen);
      const ack = await client.emitWithAck(BRIDGE_IDENTIFY, { userId: 'u1', userName: 'GM', isGM: true });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe(PROTOCOL_MISMATCH);
      await expect(server.bridge.invoke(OP_CALL_TOOL, {})).rejects.toMatchObject({ code: NO_ENDPOINT });
      expect(seen).toEqual([]);
   });

   it('refuses a non-GM identify with NOT_GM', async () => {
      const port = await start();
      const client = await connectFake(port, 'player', []);
      const ack = await client.emitWithAck(BRIDGE_IDENTIFY, identify({ isGM: false }));
      expect(ack).toMatchObject({ ok: false, error: { code: NOT_GM } });
   });

   it('bounds a failing client ack: 512 byte message, 10 failures, true count, (+N more) text', async () => {
      const port = await start();
      /** @type {import('socket.io-client').Socket} A client that always fails with oversized details. */
      const client = ioClient(`http://127.0.0.1:${port}`);
      clients.push(client);
      client.on(BRIDGE_INVOKE, (request, ack) => {
         ack({
            ok: false,
            error: {
               message: 'x'.repeat(5000),
               failures: Array.from({ length: 50 }, (_, i) => ({ path: `system.f${i}`, message: 'm'.repeat(2000) })),
            },
         });
      });
      await new Promise((resolve) => client.on('connect', resolve));
      await identifyWithCreateActor(client);
      const error = await server.bridge.invoke(OP_CALL_TOOL, {}).catch((e) => e);
      expect(error.code).toBe(OP_FAILED);
      expect(Buffer.byteLength(error.message, 'utf8')).toBeLessThanOrEqual(512);
      expect(error.failures).toHaveLength(10);
      expect(error.failureCount).toBe(50);
      error.failures.forEach((failure) => {
         expect(Buffer.byteLength(failure.message, 'utf8')).toBeLessThanOrEqual(512);
      });
      const result = await callCreateActor(mcpPort);
      expect(result.isError).toBe(true);
      expect(result.content[0].text.endsWith('(+50 more)')).toBe(true);
      expect(Buffer.byteLength(result.content[0].text, 'utf8')).toBeLessThanOrEqual(512);
   });

   it('rejects a pending invocation with ENDPOINT_GONE when its client disconnects before acking', async () => {
      const port = await start();
      /** @type {import('socket.io-client').Socket} A client that never acks. */
      const client = ioClient(`http://127.0.0.1:${port}`);
      clients.push(client);
      /** @type {Promise<void>} Resolves when the client has received the invocation. */
      const received = new Promise((resolve) => client.on(BRIDGE_INVOKE, () => resolve()));
      await new Promise((resolve) => client.on('connect', resolve));
      await client.emitWithAck(BRIDGE_IDENTIFY, identify());
      const pending = server.bridge.invoke(OP_CALL_TOOL, {}).catch((e) => e);
      await received;
      client.close();
      expect(await pending).toMatchObject({ code: ENDPOINT_GONE });
   });

   it('shows an ok:true ack without a result as the text null, not as an error', async () => {
      const port = await start();
      /** @type {import('socket.io-client').Socket} A client that acks ok:true with no result. */
      const client = ioClient(`http://127.0.0.1:${port}`);
      clients.push(client);
      client.on(BRIDGE_INVOKE, (request, ack) => ack({ ok: true }));
      await new Promise((resolve) => client.on('connect', resolve));
      await identifyWithCreateActor(client);
      const result = await callCreateActor(mcpPort);
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('null');
   });

   it('refuses a client-supplied reserved code by reporting OP_FAILED', async () => {
      const port = await start();
      /** @type {import('socket.io-client').Socket} A client that acks a failure claiming a reserved code. */
      const client = ioClient(`http://127.0.0.1:${port}`);
      clients.push(client);
      client.on(BRIDGE_INVOKE, (request, ack) => ack({ ok: false, error: { code: NO_ENDPOINT, message: 'spoof' } }));
      await new Promise((resolve) => client.on('connect', resolve));
      await client.emitWithAck(BRIDGE_IDENTIFY, identify());
      const error = await server.bridge.invoke(OP_CALL_TOOL, {}).catch((e) => e);
      expect(error.code).toBe(OP_FAILED);
   });
});
