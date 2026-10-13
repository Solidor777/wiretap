// @vitest-environment node
import http from 'node:http';
import net from 'node:net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { INITIALIZE, freePort, raw } from './mcpHttp.js';
import { createWiretapServer } from '../../server/server.ts';
import { createHandleStore } from '../../server/handles.ts';
import { RESERVED_TOOL_NAMES } from '../../server/toolRegistry.ts';
import { WIRETAP_INSTRUCTIONS, startMcpServer } from '../../server/mcp.ts';
import { getBudget } from '../../shared/budgets.js';
import {
   BRIDGE_GATE_STATE,
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   BRIDGE_REGISTRY,
   GATE_DENIED,
   OP_CALL_TOOL,
   PROTOCOL_VERSION,
} from '../../shared/protocol.js';

/** @type {string[]} The timer functions the tests fake once everything is connected. */
const FAKED = [
   'setTimeout',
   'clearTimeout',
   'setInterval',
   'clearInterval',
   'performance',
];

/**
 * Build a valid registry entry.
 * @param {string} name - The tool name.
 * @param {object} [overrides] - Fields replacing the defaults.
 * @returns {object} A registry entry that passes every budget.
 */
function entry(name, overrides = {}) {
   return {
      name,
      description: `The ${name} tool.`,
      inputSchema: {
         type: 'object',
         properties: { text: { type: 'string' } },
         required: ['text'],
      },
      ...overrides,
   };
}

describe('stateful MCP sessions', () => {
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

   afterEach(async () => {
      vi.useRealTimers();
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
   });

   /**
    * Start the sidecar bridge and an MCP server with injectable session settings.
    * @param {object} [options] - Settings.
    * @param {object} [options.sessions] - Session settings forwarded to `startMcpServer`.
    * @param {object[]} [options.tools] - Extra test-local tools.
    * @returns {Promise<void>}
    */
   async function start({ sessions = {}, tools = [] } = {}) {
      server = createWiretapServer(0, await freePort(), 'mcp-only');
      await server.ready;
      store = createHandleStore();
      mcp = startMcpServer(server.bridge, 0, {
         tools,
         handleStore: store,
         sessions: {
            listChangedQuietMs: 20,
            listChangedMaxWaitMs: 100,
            log: (line) => logs.push(line),
            ...sessions,
         },
      });
      await mcp.ready;
   }

   /**
    * Connect a fake GM client, identify it, and answer invocations.
    * @param {object} [options] - Settings.
    * @param {string} [options.kind] - The endpoint kind.
    * @param {(request: object) => object} [options.answer] - Builds the ack of an invocation.
    * @returns {Promise<{ socket: ReturnType<typeof ioClient>, invokes: object[], register: Function,
    * pushGates: Function }>} The fake client, the invocations it received, and helpers that emit a registry and a
    * gate state.
    */
   async function connectGm({ kind = 'human', answer = () => ({ ok: true, result: 'done' }) } = {}) {
      /** @type {ReturnType<typeof ioClient>} The fake GM client. */
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
         dom: true,
      });
      return {
         socket,
         invokes,
         register: (payload) => socket.emitWithAck(BRIDGE_REGISTRY, payload),
         pushGates: (state) => socket.emitWithAck(BRIDGE_GATE_STATE, state),
      };
   }

   /**
    * Connect an SDK client and count its tools/list_changed notifications.
    * @param {string} [query] - Query string appended to the MCP URL.
    * @returns {Promise<{ client: Client, transport: StreamableHTTPClientTransport, notifications: () => number }>} The
    * client, its transport and the notification count reader.
    */
   async function connectClient(query = '') {
      /** @type {Client} The SDK client. */
      const client = new Client({
         name: 'test',
         version: '0.0.0',
      });
      clients.push(client);
      /** @type {number} Notifications received. */
      let count = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
         count += 1;
      });
      /** @type {StreamableHTTPClientTransport} The client transport. */
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.port()}/mcp${query}`));
      await client.connect(transport);
      return {
         client,
         transport,
         notifications: () => count,
      };
   }

   /**
    * List the names of the tools a client sees.
    * @param {Client} client - The SDK client.
    * @returns {Promise<string[]>} The sorted tool names.
    */
   async function toolNames(client) {
      return (await client.listTools()).tools.map((tool) => tool.name).sort();
   }

   describe('session lifecycle', () => {
      it('creates a session with an id and returns the server instructions in the initialize result', async () => {
         await start();
         await connectGm();
         const { client, transport } = await connectClient();
         expect(transport.sessionId).toMatch(/^[0-9a-f-]{36}$/);
         expect(mcp.sessions()).toBe(1);
         expect(client.getInstructions()).toBe(WIRETAP_INSTRUCTIONS);
         expect(WIRETAP_INSTRUCTIONS.length).toBeLessThanOrEqual(getBudget('INSTRUCTIONS_MAX_CHARS').value);
         expect(await toolNames(client)).toEqual([...RESERVED_TOOL_NAMES].sort());
      });

      it('gives every session its own id', async () => {
         await start();
         const first = await connectClient();
         const second = await connectClient();
         expect(first.transport.sessionId).not.toBe(second.transport.sessionId);
         expect(mcp.sessions()).toBe(2);
      });

      it('ends the session when the client sends DELETE and answers 404 afterwards', async () => {
         await start();
         const { transport } = await connectClient();
         const id = transport.sessionId;
         await transport.terminateSession();
         await expect.poll(() => mcp.sessions(), { timeout: 1000 }).toBe(0);
         const after = await raw(mcp.port(), {
            body: {
               jsonrpc: '2.0',
               id: 2,
               method: 'tools/list',
            },
            headers: { 'Mcp-Session-Id': id },
         });
         expect(after.status).toBe(404);
      });

      it('releases the handles of a session when it ends', async () => {
         await start();
         const gm = await connectGm({ answer: () => ({
            ok: true,
            result: 'x'.repeat(20_000),
         }) });
         await gm.register([entry('big_text')]);
         const { client, transport } = await connectClient();
         await expect
            .poll(() => toolNames(client).then((names) => names.includes('big_text')), { timeout: 1000 })
            .toBe(true);
         const result = await client.callTool({
            name: 'big_text',
            arguments: { text: 'go' },
         });
         expect(JSON.parse(result.content[0].text).handle).toBeTruthy();
         expect(store.stats().entries).toBe(1);
         await transport.terminateSession();
         await expect.poll(() => store.stats().entries, { timeout: 1000 }).toBe(0);
      });
   });

   describe('Streamable HTTP methods', () => {
      it('serves a standalone event stream on GET, accepts POST and ends on DELETE', async () => {
         await start();
         const init = await raw(mcp.port(), { body: INITIALIZE });
         expect(init.status).toBe(200);
         /** @type {string} The session id the server assigned. */
         const id = init.headers['mcp-session-id'];
         expect(id).toBeTruthy();
         // The stream opens and stays open until the session ends.
         const stream = await new Promise((resolve, reject) => {
            const req = http.request(
               {
                  host: '127.0.0.1',
                  port: mcp.port(),
                  path: '/mcp',
                  method: 'GET',
                  headers: {
                     Accept: 'text/event-stream',
                     'Mcp-Session-Id': id,
                  },
               },
               (res) => resolve({ res, req }),
            );
            req.on('error', reject);
            req.end();
         });
         expect(stream.res.statusCode).toBe(200);
         expect(stream.res.headers['content-type']).toContain('text/event-stream');
         /** @type {Promise<void>} Resolves when the stream response ends. */
         const ended = new Promise((resolve) => {
            stream.res.on('end', resolve);
            stream.res.on('close', resolve);
            stream.res.resume();
         });
         const del = await raw(mcp.port(), {
            method: 'DELETE',
            headers: { 'Mcp-Session-Id': id },
         });
         expect(del.status).toBe(200);
         await ended;
         expect(mcp.sessions()).toBe(0);
      });

      it('answers 400 to a non-initialize POST, GET and DELETE that carry no session id', async () => {
         await start();
         const post = await raw(mcp.port(), { body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
         } });
         expect(post.status).toBe(400);
         expect((await raw(mcp.port(), {
            method: 'GET',
            headers: { Accept: 'text/event-stream' },
         })).status).toBe(400);
         expect((await raw(mcp.port(), { method: 'DELETE' })).status).toBe(400);
      });

      it('answers 404 to a POST, GET and DELETE that carry an unknown session id', async () => {
         await start();
         const headers = { 'Mcp-Session-Id': '00000000-0000-4000-8000-000000000000' };
         const post = await raw(mcp.port(), {
            body: {
               jsonrpc: '2.0',
               id: 1,
               method: 'tools/list',
            },
            headers,
         });
         expect(post.status).toBe(404);
         expect(JSON.parse(post.text).error.message).toBe('Session not found');
         expect(
            (await raw(mcp.port(), {
               method: 'GET',
               headers: {
                  ...headers,
                  Accept: 'text/event-stream',
               },
            })).status,
         ).toBe(404);
         expect((await raw(mcp.port(), {
            method: 'DELETE',
            headers,
         })).status).toBe(404);
      });

      it('does not create a session for a request that is not an initialize', async () => {
         await start();
         const post = await raw(mcp.port(), { body: {
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {},
         } });
         expect(post.status).toBe(400);
         expect(mcp.sessions()).toBe(0);
      });

      it('holds no session for an initialize the transport refused', async () => {
         await start();
         // Without an Accept header naming both media types the transport answers 406 and never assigns the id.
         const res = await raw(mcp.port(), {
            body: INITIALIZE,
            headers: { Accept: 'application/json' },
         });
         expect(res.status).toBe(406);
         expect(res.headers['mcp-session-id']).toBeUndefined();
         expect(mcp.sessions()).toBe(0);
      });

      it('answers 405 to another method and 404 to another path', async () => {
         await start();
         const put = await raw(mcp.port(), { method: 'PUT' });
         expect(put.status).toBe(405);
         expect(put.headers.allow).toBe('GET, POST, DELETE');
         expect((await raw(mcp.port(), {
            path: '/other',
            body: INITIALIZE,
         })).status).toBe(404);
      });

      it('answers 400 to a malformed JSON body without creating a session', async () => {
         await start();
         const res = await new Promise((resolve, reject) => {
            const req = http.request(
               {
                  host: '127.0.0.1',
                  port: mcp.port(),
                  path: '/mcp',
                  method: 'POST',
                  headers: {
                     'Content-Type': 'application/json',
                     Accept: 'application/json, text/event-stream',
                  },
               },
               (response) => {
                  response.resume();
                  response.on('end', () => resolve(response.statusCode));
               },
            );
            req.on('error', reject);
            req.end('{not json');
         });
         expect(res).toBe(400);
         expect(mcp.sessions()).toBe(0);
      });

      it('refuses a hostile Origin and a hostile Host on POST, GET and DELETE alike', async () => {
         await start();
         const init = await raw(mcp.port(), { body: INITIALIZE });
         const id = init.headers['mcp-session-id'];
         for (const headers of [
            { Origin: 'http://evil.example' },
            { Host: 'evil.example' },
         ]) {
            const post = await raw(mcp.port(), {
               body: INITIALIZE,
               headers,
            });
            const get = await raw(mcp.port(), {
               method: 'GET',
               headers: {
                  ...headers,
                  'Mcp-Session-Id': id,
                  Accept: 'text/event-stream',
               },
            });
            const del = await raw(mcp.port(), {
               method: 'DELETE',
               headers: {
                  ...headers,
                  'Mcp-Session-Id': id,
               },
            });
            expect([
               post.status,
               get.status,
               del.status,
            ]).toEqual([
               403,
               403,
               403,
            ]);
         }
         // The refused DELETE did not end the session.
         expect(mcp.sessions()).toBe(1);
      });
   });

   describe('late tools and list_changed', () => {
      it('lists a tool registered later after list_changed and calls it in the same session', async () => {
         await start();
         const gm = await connectGm({ answer: (request) => ({
            ok: true,
            result: `echo:${request.params.arguments.text}`,
         }) });
         const { client, notifications } = await connectClient();
         expect(await toolNames(client)).toEqual([
            'create_actor',
            'read_handle',
         ]);
         expect(await gm.register([entry('late_tool')])).toEqual({
            ok: true,
            accepted: 1,
            refused: 0,
         });
         await expect.poll(notifications, { timeout: 1000 }).toBe(1);
         expect(await toolNames(client)).toEqual([
            'create_actor',
            'late_tool',
            'read_handle',
         ]);
         const result = await client.callTool({
            name: 'late_tool',
            arguments: { text: 'hi' },
         });
         expect(result.isError).toBeFalsy();
         expect(result.content[0].text).toBe('echo:hi');
         expect(gm.invokes).toEqual([
            expect.objectContaining({
               op: OP_CALL_TOOL,
               params: {
                  name: 'late_tool',
                  arguments: { text: 'hi' },
               },
            }),
         ]);
      });

      it('lists the registered tools at once to a session that starts after the registry was sent', async () => {
         await start();
         const gm = await connectGm();
         await gm.register([entry('early_tool')]);
         const { client, notifications } = await connectClient();
         expect(await toolNames(client)).toEqual([
            'create_actor',
            'early_tool',
            'read_handle',
         ]);
         await new Promise((resolve) => setTimeout(resolve, 100));
         expect(notifications()).toBe(0);
      });

      it('sends list_changed to every open session', async () => {
         await start();
         const gm = await connectGm();
         const first = await connectClient();
         const second = await connectClient();
         await gm.register([entry('shared_tool')]);
         await expect.poll(first.notifications, { timeout: 1000 }).toBe(1);
         await expect.poll(second.notifications, { timeout: 1000 }).toBe(1);
         expect(await toolNames(first.client)).toContain('shared_tool');
         expect(await toolNames(second.client)).toContain('shared_tool');
      });

      it('removes a tool and notifies when the registry shrinks; the removed tool cannot be called', async () => {
         await start();
         const gm = await connectGm();
         await gm.register([
            entry('first_tool'),
            entry('second_tool'),
         ]);
         const { client, notifications } = await connectClient();
         await gm.register([entry('second_tool')]);
         await expect.poll(notifications, { timeout: 1000 }).toBe(1);
         expect(await toolNames(client)).toEqual([
            'create_actor',
            'read_handle',
            'second_tool',
         ]);
         await expect(client.callTool({ name: 'first_tool', arguments: { text: 'x' } })).resolves.toMatchObject({
            isError: true,
         });
      });

      it('replaces a changed tool definition and notifies once', async () => {
         await start();
         const gm = await connectGm();
         await gm.register([entry('tool_a')]);
         const { client, notifications } = await connectClient();
         await gm.register([entry('tool_a', { description: 'Changed description.' })]);
         await expect.poll(notifications, { timeout: 1000 }).toBe(1);
         const listed = (await client.listTools()).tools.find((tool) => tool.name === 'tool_a');
         expect(listed.description).toBe('Changed description.');
      });

      it('does not notify for an identify, a repeated identical registry or a gate state change', async () => {
         await start();
         const gm = await connectGm();
         await gm.register([entry('stable_tool')]);
         const { notifications } = await connectClient();
         await gm.register([entry('stable_tool')]);
         await gm.pushGates({ allowUserWrites: true });
         await gm.socket.emitWithAck(BRIDGE_IDENTIFY, {
            protocolVersion: PROTOCOL_VERSION,
            userId: 'u-human',
            userName: 'GM',
            isGM: true,
            kind: 'human',
            dom: true,
         });
         await new Promise((resolve) => setTimeout(resolve, 150));
         expect(notifications()).toBe(0);
      });

      it('notifies when the endpoint that carries the tools disconnects', async () => {
         await start();
         const gm = await connectGm();
         await gm.register([entry('gone_tool')]);
         const { client, notifications } = await connectClient();
         gm.socket.close();
         await expect.poll(notifications, { timeout: 1000 }).toBe(1);
         expect(await toolNames(client)).toEqual([
            'create_actor',
            'read_handle',
         ]);
      });

      it('sends one notification for a burst of registry changes', async () => {
         await start({ sessions: {
            listChangedQuietMs: 200,
            listChangedMaxWaitMs: 1000,
         } });
         const gm = await connectGm();
         const { client, notifications } = await connectClient();
         vi.useFakeTimers({ toFake: FAKED });
         for (let index = 0; index < 8; index += 1) {
            await gm.register([entry(`burst_${index}`)]);
            await vi.advanceTimersByTimeAsync(50);
         }
         expect(notifications()).toBe(0);
         await vi.advanceTimersByTimeAsync(250);
         await expect.poll(notifications, { timeout: 1000 }).toBe(1);
         await vi.advanceTimersByTimeAsync(5000);
         expect(notifications()).toBe(1);
         vi.useRealTimers();
         expect(await toolNames(client)).toEqual([
            'burst_7',
            'create_actor',
            'read_handle',
         ]);
      });

      it('sends a second notification for a second burst', async () => {
         await start({ sessions: {
            listChangedQuietMs: 200,
            listChangedMaxWaitMs: 1000,
         } });
         const gm = await connectGm();
         const { notifications } = await connectClient();
         vi.useFakeTimers({ toFake: FAKED });
         await gm.register([entry('one')]);
         await vi.advanceTimersByTimeAsync(300);
         await expect.poll(notifications, { timeout: 1000 }).toBe(1);
         await gm.register([entry('two')]);
         await vi.advanceTimersByTimeAsync(300);
         await expect.poll(notifications, { timeout: 1000 }).toBe(2);
      });
   });

   describe('hostile registry payloads', () => {
      it('keeps the session and its tools working when the endpoint sends hostile registries', async () => {
         await start();
         const gm = await connectGm();
         const { client } = await connectClient();
         const hostile = [
            [entry('__proto__')],
            [entry('constructor')],
            [entry('create_actor')],
            [entry('BAD NAME')],
            [entry('x'.repeat(200))],
            [{
               name: 'ok_name',
               description: 'd'.repeat(5000),
               inputSchema: { type: 'object' },
            }],
            [{
               name: 'ok_name',
               description: 'd',
               inputSchema: {
                  type: 'object',
                  properties: { a: { $ref: '#/x' } },
               },
            }],
            [{
               name: 'ok_name',
               description: 'd',
               inputSchema: {
                  type: 'object',
                  properties: { a: { pattern: '(a+)+$' } },
               },
            }],
            JSON.parse(
               '[{"name":"ok_name","description":"d","inputSchema":{"type":"object",' +
                  '"properties":{"__proto__":{"type":"string"}}}}]',
            ),
            Array.from({ length: 5000 }, (_, index) => entry(`bulk_${index}`)),
            [
               null,
               5,
               'x',
               [],
            ],
            'not an array',
            { tools: [entry('wrapped')] },
         ];
         for (const payload of hostile) {
            await gm.register(payload).catch(() => undefined);
         }
         await new Promise((resolve) => setTimeout(resolve, 150));
         const names = await toolNames(client);
         expect(names).not.toContain('__proto__');
         expect(names).not.toContain('constructor');
         expect(names).not.toContain('ok_name');
         expect(names).not.toContain('wrapped');
         expect(names.filter((name) => name === 'create_actor')).toHaveLength(1);
         expect(names.length).toBeLessThanOrEqual(getBudget('ALWAYS_LISTED_TOOLS_MAX').value);
         expect({}.polluted).toBeUndefined();
         // A valid registry still works afterwards.
         expect(await gm.register([entry('fine_tool')])).toEqual({
            ok: true,
            accepted: 1,
            refused: 0,
         });
         await expect
            .poll(() => toolNames(client).then((list) => list.includes('fine_tool')), { timeout: 1000 })
            .toBe(true);
      });

      it('refuses a registry from a socket that never identified', async () => {
         await start();
         const stranger = ioClient(`http://127.0.0.1:${server.io.httpServer.address().port}`);
         gms.push(stranger);
         await new Promise((resolve) => stranger.on('connect', resolve));
         const ack = await stranger.emitWithAck(BRIDGE_REGISTRY, [entry('sneaky')]);
         expect(ack.ok).toBe(false);
         const { client } = await connectClient();
         expect(await toolNames(client)).toEqual([
            'create_actor',
            'read_handle',
         ]);
      });

      it('never lists more than the always-listed tool budget', async () => {
         await start();
         const gm = await connectGm();
         const ack = await gm.register(Array.from({ length: 40 }, (_, index) => entry(`many_${index}`)));
         expect(ack.accepted).toBe(getBudget('ALWAYS_LISTED_TOOLS_MAX').value - 2);
         expect(ack.refused).toBe(12);
         const { client } = await connectClient();
         expect((await toolNames(client)).length).toBe(getBudget('ALWAYS_LISTED_TOOLS_MAX').value);
      });
   });

   describe('tool routing', () => {
      it('sends a registry tool call to the endpoint kind the session was opened for', async () => {
         await start();
         const human = await connectGm({ kind: 'human', answer: () => ({
            ok: true,
            result: 'from-human',
         }) });
         const agent = await connectGm({ kind: 'agent', answer: () => ({
            ok: true,
            result: 'from-agent',
         }) });
         await human.register([entry('human_only')]);
         await agent.register([entry('agent_only')]);
         const humanSession = await connectClient('?endpoint=human');
         const defaultSession = await connectClient();
         expect(await toolNames(humanSession.client)).toEqual([
            'create_actor',
            'human_only',
            'read_handle',
         ]);
         expect(await toolNames(defaultSession.client)).toEqual([
            'agent_only',
            'create_actor',
            'read_handle',
         ]);
         const fromHuman = await humanSession.client.callTool({
            name: 'human_only',
            arguments: { text: 'a' },
         });
         const fromDefault = await defaultSession.client.callTool({
            name: 'agent_only',
            arguments: { text: 'a' },
         });
         expect(fromHuman.content[0].text).toBe('from-human');
         expect(fromDefault.content[0].text).toBe('from-agent');
         expect(human.invokes).toHaveLength(1);
         expect(agent.invokes).toHaveLength(1);
      });

      it('refuses an endpoint choice that is not human or agent', async () => {
         await start();
         const res = await raw(mcp.port(), {
            path: '/mcp?endpoint=robot',
            body: INITIALIZE,
         });
         expect(res.status).toBe(400);
         expect(mcp.sessions()).toBe(0);
      });

      it('answers a gated tool with GATE_DENIED and sends nothing until its gate opens', async () => {
         await start();
         const gm = await connectGm();
         await gm.register([entry('gated_tool', { gate: 'allowUserWrites' })]);
         const { client } = await connectClient();
         const denied = await client.callTool({
            name: 'gated_tool',
            arguments: { text: 'x' },
         });
         expect(denied.isError).toBe(true);
         expect(denied.content[0].text.startsWith(`${GATE_DENIED}: `)).toBe(true);
         expect(gm.invokes).toEqual([]);
         await gm.pushGates({ allowUserWrites: true });
         const allowed = await client.callTool({
            name: 'gated_tool',
            arguments: { text: 'x' },
         });
         expect(allowed.isError).toBeFalsy();
         expect(gm.invokes).toHaveLength(1);
      });

      it('shows a client failure of a registry tool as an error result', async () => {
         await start();
         const gm = await connectGm({ answer: () => ({
            ok: false,
            error: {
               code: 'BAD_INPUT',
               message: 'No such actor.',
            },
         }) });
         await gm.register([entry('failing_tool')]);
         const { client } = await connectClient();
         const result = await client.callTool({
            name: 'failing_tool',
            arguments: { text: 'x' },
         });
         expect(result.isError).toBe(true);
         expect(result.content[0].text).toBe('BAD_INPUT: No such actor.');
      });

      it('turns a registry tool result over the cap into a handle the same session can read', async () => {
         await start();
         const gm = await connectGm({ answer: () => ({
            ok: true,
            result: { rows: 'r'.repeat(20_000) },
         }) });
         await gm.register([entry('big_tool')]);
         const { client } = await connectClient();
         const result = await client.callTool({
            name: 'big_tool',
            arguments: { text: 'x' },
         });
         const { handle } = JSON.parse(result.content[0].text);
         const page = await client.callTool({
            name: 'read_handle',
            arguments: {
               handle,
               offset: 0,
               length: 20,
            },
         });
         expect(page.isError).toBeFalsy();
         expect(page.content[0].text).toBe('{"rows":"rrrrrrrrrrr');
      });
   });

   describe('session isolation', () => {
      it('does not let one session read a handle that another session stored', async () => {
         const big = {
            name: 'test_big',
            description: 'Test-only tool returning a large text.',
            inputSchema: { unused: z.string().optional() },
            handler: async () => ({ content: [{
               type: 'text',
               text: 'z'.repeat(20_000),
            }] }),
         };
         await start({ tools: [big] });
         const owner = await connectClient();
         const other = await connectClient();
         const minted = await owner.client.callTool({
            name: 'test_big',
            arguments: {},
         });
         const { handle } = JSON.parse(minted.content[0].text);
         const stolen = await other.client.callTool({
            name: 'read_handle',
            arguments: { handle },
         });
         expect(stolen.isError).toBe(true);
         expect(stolen.content[0].text).toBe('HANDLE_NOT_FOUND: Handle not found or expired.');
         const own = await owner.client.callTool({
            name: 'read_handle',
            arguments: {
               handle,
               length: 5,
            },
         });
         expect(own.isError).toBeFalsy();
         expect(own.content[0].text).toBe('zzzzz');
      });

      it('keeps the handles of the session that did not end when another session ends', async () => {
         const big = {
            name: 'test_big',
            description: 'Test-only tool returning a large text.',
            inputSchema: { unused: z.string().optional() },
            handler: async () => ({ content: [{
               type: 'text',
               text: 'z'.repeat(20_000),
            }] }),
         };
         await start({ tools: [big] });
         const keeper = await connectClient();
         const leaver = await connectClient();
         const minted = await keeper.client.callTool({
            name: 'test_big',
            arguments: {},
         });
         await leaver.client.callTool({
            name: 'test_big',
            arguments: {},
         });
         expect(store.stats().entries).toBe(2);
         await leaver.transport.terminateSession();
         await expect.poll(() => store.stats().entries, { timeout: 1000 }).toBe(1);
         const { handle } = JSON.parse(minted.content[0].text);
         const read = await keeper.client.callTool({
            name: 'read_handle',
            arguments: {
               handle,
               length: 3,
            },
         });
         expect(read.content[0].text).toBe('zzz');
      });
   });

   describe('idle expiry, session cap and disposal', () => {
      it('expires an idle session, releases its handles and answers 404 afterwards', async () => {
         const big = {
            name: 'test_big',
            description: 'Test-only tool returning a large text.',
            inputSchema: { unused: z.string().optional() },
            handler: async () => ({ content: [{
               type: 'text',
               text: 'z'.repeat(20_000),
            }] }),
         };
         await start({
            tools: [big],
            sessions: {
               idleMs: 10_000,
               sweepMs: 1000,
            },
         });
         // The timers are faked before the session exists, because its sweep interval is created with the session.
         vi.useFakeTimers({ toFake: FAKED });
         const { client, transport } = await connectClient();
         await client.callTool({
            name: 'test_big',
            arguments: {},
         });
         expect(store.stats().entries).toBe(1);
         const id = transport.sessionId;
         await vi.advanceTimersByTimeAsync(9_000);
         expect(mcp.sessions()).toBe(1);
         await vi.advanceTimersByTimeAsync(2_000);
         expect(mcp.sessions()).toBe(0);
         expect(store.stats().entries).toBe(0);
         const after = await raw(mcp.port(), {
            body: {
               jsonrpc: '2.0',
               id: 3,
               method: 'tools/list',
            },
            headers: { 'Mcp-Session-Id': id },
         });
         expect(after.status).toBe(404);
      });

      it('keeps a session that keeps making requests', async () => {
         await start({ sessions: {
            idleMs: 10_000,
            sweepMs: 1000,
         } });
         vi.useFakeTimers({ toFake: FAKED });
         const { client } = await connectClient();
         for (let step = 0; step < 5; step += 1) {
            await vi.advanceTimersByTimeAsync(6_000);
            await client.listTools();
         }
         expect(mcp.sessions()).toBe(1);
         await vi.advanceTimersByTimeAsync(11_000);
         expect(mcp.sessions()).toBe(0);
      });

      it('refuses an initialize at the cap with 503 and Retry-After, and ends no session', async () => {
         await start({ sessions: { maxSessions: 2 } });
         const first = await connectClient();
         const second = await connectClient();
         const refused = await raw(mcp.port(), { body: INITIALIZE });
         expect(refused.status).toBe(503);
         expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
         expect(refused.headers['mcp-session-id']).toBeUndefined();
         expect(mcp.sessions()).toBe(2);
         expect(await toolNames(first.client)).toEqual([
            'create_actor',
            'read_handle',
         ]);
         expect(await toolNames(second.client)).toEqual([
            'create_actor',
            'read_handle',
         ]);
         expect(logs.some((line) => line.includes('cap of 2 reached: initialize refused'))).toBe(true);
      });

      it('lets a flood of initialize requests neither end another session nor drop its handles', async () => {
         await start({ sessions: { maxSessions: 2 } });
         const gm = await connectGm({ answer: () => ({
            ok: true,
            result: 'x'.repeat(20_000),
         }) });
         await gm.register([entry('big_text')]);
         const victim = await connectClient();
         await expect
            .poll(() => toolNames(victim.client).then((names) => names.includes('big_text')), { timeout: 1000 })
            .toBe(true);
         const stored = await victim.client.callTool({
            name: 'big_text',
            arguments: { text: 'go' },
         });
         const handle = JSON.parse(stored.content[0].text).handle;
         await connectClient();
         for (let index = 0; index < 20; index += 1) {
            const res = await raw(mcp.port(), { body: INITIALIZE });
            expect(res.status).toBe(503);
         }
         expect(mcp.sessions()).toBe(2);
         expect(store.stats().entries).toBe(1);
         const read = await victim.client.callTool({
            name: 'read_handle',
            arguments: { handle },
         });
         expect(read.isError).toBeFalsy();
         expect(read.content[0].text.length).toBeGreaterThan(0);
      });

      it('accepts a new session once the idle sweep has freed a slot', async () => {
         await start({ sessions: {
            maxSessions: 1,
            idleMs: 5_000,
            sweepMs: 500,
         } });
         vi.useFakeTimers({ toFake: FAKED });
         await connectClient();
         expect((await raw(mcp.port(), { body: INITIALIZE })).status).toBe(503);
         await vi.advanceTimersByTimeAsync(6_000);
         expect(mcp.sessions()).toBe(0);
         expect((await raw(mcp.port(), { body: INITIALIZE })).status).toBe(200);
         expect(mcp.sessions()).toBe(1);
      });

      it('holds at most the budgeted number of sessions by default', async () => {
         await start();
         const limit = getBudget('MCP_SESSIONS_MAX').value;
         for (let index = 0; index < limit + 3; index += 1) {
            const res = await raw(mcp.port(), { body: INITIALIZE });
            expect(res.status).toBe(index < limit ? 200 : 503);
         }
         expect(mcp.sessions()).toBe(limit);
      });

      it('counts concurrent initializes against the cap', async () => {
         await start({ sessions: { maxSessions: 3 } });
         const results = await Promise.all(
            Array.from({ length: 10 }, () => raw(mcp.port(), { body: INITIALIZE })),
         );
         expect(results.filter((res) => res.status === 200)).toHaveLength(3);
         expect(results.filter((res) => res.status === 503)).toHaveLength(7);
         expect(mcp.sessions()).toBe(3);
      });

      it('ends every session and leaves no timer on close', async () => {
         await start();
         const gm = await connectGm();
         // The socket client cannot connect under faked timers, the MCP client can; the sweep interval is created with
         // the first session, so the timers are faked between the two.
         vi.useFakeTimers({ toFake: FAKED });
         await connectClient();
         await connectClient();
         await gm.register([entry('tool_two')]);
         // One sweep interval for the sessions and one pending notification.
         expect(vi.getTimerCount()).toBeGreaterThanOrEqual(2);
         const sidecarTimers = vi.getTimerCount();
         mcp.close();
         expect(mcp.sessions()).toBe(0);
         // Only the timers that belong to the socket layer remain.
         expect(vi.getTimerCount()).toBeLessThan(sidecarTimers);
         mcp = undefined;
      });

      it('releases the port on close even with a session event stream open', async () => {
         await start();
         const { client } = await connectClient();
         await client.listTools();
         const port = mcp.port();
         mcp.close();
         mcp = undefined;
         await expect
            .poll(
               () =>
                  new Promise((resolve) => {
                     const probe = net.createServer();
                     probe.once('error', () => resolve(false));
                     probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
                  }),
               { timeout: 1000 },
            )
            .toBe(true);
      });
   });
});
