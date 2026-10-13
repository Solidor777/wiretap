// @vitest-environment node
import { describe, it, expect, afterEach, vi } from 'vitest';
import net from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { createWiretapServer } from '../../server/server.ts';
import { callCreateActor } from './mcpHttp.js';
import { createActorScript, registryPayload } from '../unit/scriptFixtures.js';
import {
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   BRIDGE_PING,
   BRIDGE_REGISTRY,
   ENDPOINT_TIMEOUT,
   ENDPOINT_UNAVAILABLE,
   OP_CALL_TOOL,
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
 * Yield to the real event loop until a condition holds, failing after 1000 ms of wall-clock time. Uses `setImmediate`
 * and `Date.now`, which the fake timers of these tests leave alone.
 * @param {() => boolean} check - The condition to evaluate.
 * @param {string} what - A description used in the timeout error.
 * @returns {Promise<void>} Resolves once the condition holds.
 */
async function until(check, what) {
   /** @type {number} The epoch-millisecond time after which the wait fails. */
   const deadline = Date.now() + 1000;
   while (!check()) {
      if (Date.now() > deadline) {
         throw new Error(`Timed out after 1000 ms waiting for ${what}`);
      }
      await new Promise((resolve) => setImmediate(resolve));
   }
}

/**
 * Build an identify payload.
 * @param {object} overrides - Fields replacing the defaults.
 * @returns {object} The payload.
 */
function identify(overrides) {
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
 * @typedef {object} FakeClient
 * @property {{ invokes: boolean, pings: boolean }} answer - Whether the fake acks invocations and pings.
 * @property {object[]} invokes - The invocation payloads the fake received.
 * @property {number[]} pings - One entry per ping the fake received.
 */

describe('endpoint health over Socket.IO', () => {
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
      vi.useRealTimers();
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
    * Connect and identify a fake Foundry client whose answers to invocations and pings are switchable.
    * @param {number} port - The Socket.IO port.
    * @param {string} kind - The endpoint kind to identify as.
    * @returns {Promise<FakeClient>} The connected fake.
    */
   async function connectFake(port, kind) {
      /** @type {import('socket.io-client').Socket} The fake client. */
      const client = ioClient(`http://127.0.0.1:${port}`);
      clients.push(client);
      /** @type {FakeClient} Switches and the payloads received by this fake client. */
      const fake = { answer: { invokes: true, pings: true }, invokes: [], pings: [] };
      client.on(BRIDGE_INVOKE, (request, ack) => {
         fake.invokes.push(request);
         if (fake.answer.invokes) {
            ack({ ok: true, result: { uuid: `Actor.${kind}`, name: kind, type: 'npc' } });
         }
      });
      client.on(BRIDGE_PING, (ack) => {
         fake.pings.push(fake.pings.length + 1);
         if (fake.answer.pings) {
            ack({ ok: true });
         }
      });
      await new Promise((resolve) => client.on('connect', resolve));
      await client.emitWithAck(BRIDGE_IDENTIFY, identify({ kind, userId: kind }));
      await client.emitWithAck(BRIDGE_REGISTRY, registryPayload([createActorScript()]));
      return fake;
   }

   /**
    * Replace the timer functions with fake ones; sockets and `setImmediate` keep running on the real loop.
    * @returns {void}
    */
   function fakeTimers() {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
   }

   it('keeps routing to an agent that acks pings but never answers an invocation', async () => {
      const port = await start();
      const human = await connectFake(port, 'human');
      const agent = await connectFake(port, 'agent');
      fakeTimers();
      agent.answer.invokes = false;
      const first = server.bridge.invoke(OP_CALL_TOOL, {}).catch((error) => error);
      await until(() => agent.invokes.length === 1, 'the agent to receive the invocation');
      await vi.advanceTimersByTimeAsync(10_000);
      await until(() => agent.pings.length === 1, 'the agent to receive the ping');
      expect(await first).toMatchObject({ code: ENDPOINT_TIMEOUT });
      agent.answer.invokes = true;
      await expect(server.bridge.invoke(OP_CALL_TOOL, {})).resolves.toMatchObject({ uuid: 'Actor.agent' });
      expect(agent.invokes).toHaveLength(2);
      expect(human.invokes).toEqual([]);
   });

   it('routes to the human at once when the agent acks neither invocation nor ping, then restores it', async () => {
      const port = await start();
      const human = await connectFake(port, 'human');
      const agent = await connectFake(port, 'agent');
      fakeTimers();
      agent.answer.invokes = false;
      agent.answer.pings = false;
      const first = server.bridge.invoke(OP_CALL_TOOL, {}).catch((error) => error);
      await until(() => agent.invokes.length === 1, 'the agent to receive the invocation');
      await vi.advanceTimersByTimeAsync(10_000);
      await until(() => agent.pings.length === 1, 'the agent to receive the ping');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await first).toMatchObject({ code: ENDPOINT_TIMEOUT });
      await expect(server.bridge.invoke(OP_CALL_TOOL, {})).resolves.toMatchObject({ uuid: 'Actor.human' });
      expect(agent.invokes).toHaveLength(1);
      expect(human.invokes).toHaveLength(1);
      agent.answer.invokes = true;
      agent.answer.pings = true;
      await vi.advanceTimersByTimeAsync(5_000);
      await until(() => agent.pings.length === 2, 'the agent to receive the probe');
      // The probe ack reaches the sidecar over a real socket; keep calling (each is answered at once) until one
      // reaches the agent again.
      /** @type {number} The epoch-millisecond time after which the wait fails. */
      const deadline = Date.now() + 1000;
      /** @type {string | undefined} The uuid of the most recent routed result. */
      let routedTo;
      while (routedTo !== 'Actor.agent') {
         expect(Date.now()).toBeLessThan(deadline);
         routedTo = (await server.bridge.invoke(OP_CALL_TOOL, {})).uuid;
      }
      expect(routedTo).toBe('Actor.agent');
   });

   it('reports the possibly-applied timeout text and then ENDPOINT_UNAVAILABLE over MCP', async () => {
      const port = await start();
      const agent = await connectFake(port, 'agent');
      fakeTimers();
      agent.answer.invokes = false;
      agent.answer.pings = false;
      const first = callCreateActor(mcpPort);
      await until(() => agent.invokes.length === 1, 'the agent to receive the invocation');
      await vi.advanceTimersByTimeAsync(10_000);
      await until(() => agent.pings.length === 1, 'the agent to receive the ping');
      await vi.advanceTimersByTimeAsync(1_000);
      const timedOut = await first;
      expect(timedOut.isError).toBe(true);
      expect(timedOut.content[0].text.startsWith(`${ENDPOINT_TIMEOUT}: `)).toBe(true);
      expect(timedOut.content[0].text).toContain('may still have applied');
      const unavailable = await callCreateActor(mcpPort);
      expect(unavailable.isError).toBe(true);
      expect(unavailable.content[0].text.startsWith(`${ENDPOINT_UNAVAILABLE}: `)).toBe(true);
      expect(agent.invokes).toHaveLength(1);
   });

   it('leaves no timer running after dispose while an endpoint is being probed', async () => {
      const port = await start();
      const agent = await connectFake(port, 'agent');
      fakeTimers();
      agent.answer.invokes = false;
      agent.answer.pings = false;
      const first = server.bridge.invoke(OP_CALL_TOOL, {}).catch((error) => error);
      await until(() => agent.invokes.length === 1, 'the agent to receive the invocation');
      await vi.advanceTimersByTimeAsync(10_000);
      await until(() => agent.pings.length === 1, 'the agent to receive the ping');
      await vi.advanceTimersByTimeAsync(1_000);
      await first;
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      server.dispose();
      server = undefined;
      expect(vi.getTimerCount()).toBe(0);
   });
});
