// @vitest-environment node
import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { createWiretapServer } from '../../server/server.ts';
import { GATES, closedGateState } from '../../shared/gates.js';
import {
   BRIDGE_GATE_STATE,
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   NOT_GM,
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
 * POST a JSON-RPC request to the MCP endpoint and parse the (JSON or SSE) response.
 * @param {number} mcpPort - The loopback port of the MCP server under test.
 * @param {object} body - The JSON-RPC request.
 * @returns {Promise<object>} The parsed JSON-RPC response.
 */
async function mcpCall(mcpPort, body) {
   /** @type {Response} The HTTP response from the MCP endpoint. */
   const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
   });
   /** @type {string} The raw response body. */
   const text = await res.text();
   /** @type {string | undefined} The first SSE data line, if the response is an event stream. */
   const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
   return JSON.parse(dataLine ? dataLine.slice(5) : text);
}

/**
 * Build a v3 identify payload.
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

describe('gate state over Socket.IO', () => {
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
    * Connect a fake Foundry client that answers every invoke with an actor result.
    * @param {number} port - The Socket.IO port.
    * @returns {Promise<import('socket.io-client').Socket>} The connected client.
    */
   async function connectFake(port) {
      /** @type {import('socket.io-client').Socket} The fake client. */
      const client = ioClient(`http://127.0.0.1:${port}`);
      clients.push(client);
      client.on(BRIDGE_INVOKE, (request, ack) => {
         ack({ ok: true, result: { uuid: 'Actor.x', id: 'x', name: 'x', type: 'npc' } });
      });
      await new Promise((resolve) => client.on('connect', resolve));
      return client;
   }

   it('reflects the gateState carried by the identify', async () => {
      const port = await start();
      const client = await connectFake(port);
      expect(server.bridge.gateState()).toEqual(closedGateState());
      const ack = await client.emitWithAck(BRIDGE_IDENTIFY, identify({ gateState: { allowMacroExecution: true } }));
      expect(ack).toEqual({ ok: true });
      expect(server.bridge.gateState()).toEqual({ ...closedGateState(), allowMacroExecution: true });
   });

   it('keeps every gate closed when the identify carries no gateState', async () => {
      const port = await start();
      const client = await connectFake(port);
      await client.emitWithAck(BRIDGE_IDENTIFY, identify());
      expect(server.bridge.gateState()).toEqual(closedGateState());
   });

   it('reflects a snapshot pushed through BRIDGE_GATE_STATE and acks ok', async () => {
      const port = await start();
      const client = await connectFake(port);
      await client.emitWithAck(BRIDGE_IDENTIFY, identify());
      const ack = await client.emitWithAck(BRIDGE_GATE_STATE, { allowFileUpload: true, allowedPluginModules: ['m'] });
      expect(ack).toEqual({ ok: true });
      expect(server.bridge.gateState()).toEqual({
         ...closedGateState(),
         allowFileUpload: true,
         allowedPluginModules: ['m'],
      });
      await client.emitWithAck(BRIDGE_GATE_STATE, { allowFileUpload: false });
      expect(server.bridge.gateState()).toEqual(closedGateState());
   });

   it('sanitizes a hostile snapshot sent in the identify', async () => {
      const port = await start();
      const client = await connectFake(port);
      const hostile = JSON.parse(
         '{"__proto__":{"allowMacroExecution":true},"constructor":{"prototype":{"polluted":true}},' +
            '"allowUserWrites":"true","allowFileUpload":1,"allowSettingWrites":true,"allowDelete":true,' +
            '"nested":{"deep":[1,2,3]},"allowedPluginModules":["ok",1,null,{},"' +
            'x'.repeat(65) +
            '"]}',
      );
      await client.emitWithAck(BRIDGE_IDENTIFY, identify({ gateState: hostile }));
      expect(server.bridge.gateState()).toEqual({
         ...closedGateState(),
         allowSettingWrites: true,
         allowedPluginModules: ['ok'],
      });
      expect(Object.keys(server.bridge.gateState()).sort()).toEqual(Object.keys(GATES).sort());
      expect({}.allowMacroExecution).toBeUndefined();
      expect({}.polluted).toBeUndefined();
   });

   it('sanitizes a hostile snapshot sent through BRIDGE_GATE_STATE', async () => {
      const port = await start();
      const client = await connectFake(port);
      await client.emitWithAck(BRIDGE_IDENTIFY, identify());
      await client.emitWithAck(
         BRIDGE_GATE_STATE,
         JSON.parse('{"__proto__":{"allowMacroExecution":true},"allowUserWrites":"yes","extra":{"a":1}}'),
      );
      expect(server.bridge.gateState()).toEqual(closedGateState());
   });

   it('treats a module list over 64 entries as empty', async () => {
      const port = await start();
      const client = await connectFake(port);
      await client.emitWithAck(BRIDGE_IDENTIFY, identify());
      await client.emitWithAck(BRIDGE_GATE_STATE, {
         allowMacroExecution: true,
         allowedPluginModules: Array.from({ length: 5000 }, (_, index) => `m${index}`),
      });
      expect(server.bridge.gateState()).toEqual({ ...closedGateState(), allowMacroExecution: true });
   });

   it('keeps a separate snapshot for each GM endpoint', async () => {
      const port = await start();
      const human = await connectFake(port);
      const agent = await connectFake(port);
      await human.emitWithAck(BRIDGE_IDENTIFY, identify({ gateState: { allowUserWrites: true } }));
      await agent.emitWithAck(
         BRIDGE_IDENTIFY,
         identify({ kind: 'agent', userId: 'u2', gateState: { allowFileUpload: true } }),
      );
      expect(server.bridge.gateState({ endpoint: 'human' })).toEqual({ ...closedGateState(), allowUserWrites: true });
      expect(server.bridge.gateState({ endpoint: 'agent' })).toEqual({ ...closedGateState(), allowFileUpload: true });
      await agent.emitWithAck(BRIDGE_GATE_STATE, { allowAgentScripts: true });
      expect(server.bridge.gateState({ endpoint: 'agent' })).toEqual({ ...closedGateState(), allowAgentScripts: true });
      expect(server.bridge.gateState({ endpoint: 'human' })).toEqual({ ...closedGateState(), allowUserWrites: true });
      expect(server.bridge.gateState()).toEqual({ ...closedGateState(), allowAgentScripts: true });
   });

   it('does not let a socket that never identified change any snapshot', async () => {
      const port = await start();
      const gm = await connectFake(port);
      const stranger = await connectFake(port);
      await gm.emitWithAck(BRIDGE_IDENTIFY, identify({ gateState: { allowFileUpload: true } }));
      const ack = await stranger.emitWithAck(BRIDGE_GATE_STATE, { allowMacroExecution: true });
      expect(ack).toMatchObject({ ok: false, error: { code: NOT_GM } });
      expect(server.bridge.gateState()).toEqual({ ...closedGateState(), allowFileUpload: true });
   });

   it('does not let a non-GM socket change any snapshot', async () => {
      const port = await start();
      const player = await connectFake(port);
      const refused = await player.emitWithAck(
         BRIDGE_IDENTIFY,
         identify({ isGM: false, gateState: { allowMacroExecution: true } }),
      );
      expect(refused).toMatchObject({ ok: false, error: { code: NOT_GM } });
      const ack = await player.emitWithAck(BRIDGE_GATE_STATE, { allowMacroExecution: true });
      expect(ack).toMatchObject({ ok: false, error: { code: NOT_GM } });
      expect(server.bridge.gateState()).toEqual(closedGateState());
   });

   it('never includes the gate state in a tool result or in the tool list', async () => {
      const port = await start();
      const client = await connectFake(port);
      await client.emitWithAck(
         BRIDGE_IDENTIFY,
         identify({ gateState: { allowMacroExecution: true, allowedPluginModules: ['secret-module-id'] } }),
      );
      const call = await mcpCall(mcpPort, {
         jsonrpc: '2.0',
         id: 1,
         method: 'tools/call',
         params: { name: 'create_actor', arguments: { name: 'Bob', type: 'npc' } },
      });
      const list = await mcpCall(mcpPort, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      for (const text of [JSON.stringify(call), JSON.stringify(list)]) {
         expect(text).not.toMatch(/gateState|secret-module-id|allowMacroExecution|allowedPluginModules/);
      }
      expect(call.result.isError).toBeFalsy();
   });
});
