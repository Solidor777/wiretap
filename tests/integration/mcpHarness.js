/**
 * A harness for integration tests of the MCP server: a sidecar with the Foundry bridge, an MCP server under test, fake
 * GM clients and SDK clients, and the cleanup of all of them. Not a test file (vitest only collects `*.test.js`).
 */
import net from 'node:net';
import { io as ioClient } from 'socket.io-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWiretapServer } from '../../server/server.ts';
import { createHandleStore } from '../../server/handles.ts';
import { startMcpServer } from '../../server/mcp.ts';
import { freePort } from './mcpHttp.js';
import { registryPayload, script } from '../unit/scriptFixtures.js';
import {
   BRIDGE_GATE_STATE,
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   BRIDGE_REGISTRY,
   PROTOCOL_VERSION,
} from '../../shared/protocol.js';

/**
 * Build a valid script definition.
 * @param {string} name - The tool name.
 * @param {object} [overrides] - Fields replacing the defaults.
 * @returns {object} A script definition that passes every budget.
 */
export function entry(name, overrides = {}) {
   return script(name, {
      description: `The ${name} tool.`,
      ...overrides,
   });
}

/**
 * Open a TCP socket to a port, write raw text and collect what the server answers until the wait ends.
 * @param {number} port - The loopback port to connect to.
 * @param {string} text - The raw request text.
 * @param {number} waitMs - How long to wait before giving up on the server closing the connection.
 * @returns {Promise<{ answer: string, closed: boolean }>} The answer and whether the server closed the socket.
 */
export function rawSocket(port, text, waitMs) {
   return new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      /** @type {string} The bytes received. */
      let answer = '';
      /** @type {boolean} Whether the server closed the socket. */
      let closed = false;
      socket.on('data', (chunk) => {
         answer += chunk.toString('utf8');
      });
      socket.on('error', () => undefined);
      socket.on('close', () => {
         closed = true;
      });
      socket.on('connect', () => {
         if (text !== '') {
            socket.write(text);
         }
      });
      setTimeout(() => {
         // Read before the destroy below, whose own close event must not count as the server's.
         const serverClosed = closed;
         socket.destroy();
         resolve({
            answer,
            closed: serverClosed,
         });
      }, waitMs).unref();
   });
}

/**
 * Create a harness. Call `harness.cleanup()` after each test.
 * @returns {object} The harness: `start`, `connectGm`, `connectClient`, `toolNames`, `cleanup` and the live state
 * readers `server()`, `mcp()`, `store()` and `logs()`.
 */
export function createHarness() {
   /** @type {ReturnType<typeof createWiretapServer> | undefined} The sidecar providing the Socket.IO bridge. */
   let server;
   /** @type {ReturnType<typeof startMcpServer> | undefined} The MCP server under test. */
   let mcp;
   /** @type {Array<ReturnType<typeof ioClient>>} The fake GM clients. */
   let gms = [];
   /** @type {Client[]} The SDK clients. */
   let clients = [];
   /** @type {string[]} Sidecar log lines. */
   let logs = [];
   /** @type {ReturnType<typeof createHandleStore> | undefined} The handle store the MCP server uses. */
   let store;

   return {
      server: () => server,
      mcp: () => mcp,
      store: () => store,
      logs: () => logs,

      /**
       * Start the sidecar bridge and an MCP server.
       * @param {object} [options] - Settings.
       * @param {object} [options.sessions] - Session settings.
       * @param {object} [options.limits] - HTTP limits.
       * @param {object[]} [options.tools] - Extra test-local tools.
       * @param {object} [options.bridge] - A bridge replacing the sidecar's.
       * @returns {Promise<void>}
       */
      async start({ sessions = {}, limits, tools = [], bridge } = {}) {
         server = createWiretapServer(0, await freePort(), 'mcp-only');
         await server.ready;
         store = createHandleStore();
         mcp = startMcpServer(bridge ?? server.bridge, 0, {
            tools,
            limits,
            handleStore: store,
            sessions: {
               listChangedQuietMs: 20,
               listChangedMaxWaitMs: 100,
               log: (line) => logs.push(line),
               ...sessions,
            },
         });
         await mcp.ready;
      },

      /**
       * Connect a fake GM client and identify it.
       * @param {object} [options] - Settings.
       * @param {string} [options.kind] - The endpoint kind.
       * @param {(request: object) => object} [options.answer] - Builds the ack of an invocation.
       * @param {boolean} [options.dom] - Whether the endpoint identifies as DOM-capable.
       * @returns {Promise<{ socket: ReturnType<typeof ioClient>, invokes: object[], register: Function,
       * registerRaw: Function, pushGates: Function }>} The client, its received invocations and emit helpers:
       * `register(scripts)` sends the definitions in a registry payload, `registerRaw(payload)` sends exactly what it
       * is given.
       */
      async connectGm({ kind = 'human', dom = true, answer = () => ({ ok: true, result: 'done' }) } = {}) {
         const socket = ioClient(`http://127.0.0.1:${server.io.httpServer.address().port}`);
         gms.push(socket);
         /** @type {object[]} The invocations this client received. */
         const invokes = [];
         socket.on(BRIDGE_INVOKE, (request, ack) => {
            invokes.push(request);
            ack(answer(request));
         });
         await new Promise((resolve) => socket.on('connect', resolve));
         await socket.emitWithAck(BRIDGE_IDENTIFY, {
            protocolVersion: PROTOCOL_VERSION,
            userId: `u-${kind}`,
            userName: 'GM',
            isGM: true,
            kind,
            dom,
         });
         return {
            socket,
            invokes,
            register: (scripts) => socket.emitWithAck(BRIDGE_REGISTRY, registryPayload(scripts)),
            registerRaw: (payload) => socket.emitWithAck(BRIDGE_REGISTRY, payload),
            pushGates: (state) => socket.emitWithAck(BRIDGE_GATE_STATE, state),
         };
      },

      /**
       * Connect an SDK client.
       * @param {string} [query] - Query string appended to the MCP URL.
       * @returns {Promise<{ client: Client, transport: StreamableHTTPClientTransport }>} The client and its transport.
       */
      async connectClient(query = '') {
         const client = new Client({
            name: 'test',
            version: '0.0.0',
         });
         clients.push(client);
         const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.port()}/mcp${query}`));
         await client.connect(transport);
         return {
            client,
            transport,
         };
      },

      /**
       * List the names of the tools a client sees.
       * @param {Client} client - The SDK client.
       * @returns {Promise<string[]>} The sorted tool names.
       */
      async toolNames(client) {
         return (await client.listTools()).tools.map((tool) => tool.name).sort();
      },

      /**
       * Close every client, the MCP server and the sidecar.
       * @returns {Promise<void>}
       */
      async cleanup() {
         for (const client of clients) {
            await client.close().catch(() => undefined);
         }
         clients = [];
         for (const gm of gms) {
            gm.close();
         }
         gms = [];
         mcp?.close();
         mcp = undefined;
         server?.dispose();
         server = undefined;
         logs = [];
      },
   };
}
