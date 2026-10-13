// @vitest-environment node
import http from 'node:http';
import net from 'node:net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { INITIALIZE, raw } from './mcpHttp.js';
import { createHarness, entry, rawSocket } from './mcpHarness.js';
import { sanitizeRegistry } from '../../server/toolRegistry.ts';
import { GATE_DENIED, TOOL_GONE } from '../../shared/protocol.js';

/**
 * Pause for a number of milliseconds.
 * @param {number} ms - The pause.
 * @returns {Promise<void>} Resolves after the pause.
 */
function sleep(ms) {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a request with a large body to the MCP port and report what the client saw.
 * @param {number} port - The MCP port.
 * @param {object} options - Request settings.
 * @param {string} [options.method] - The HTTP method.
 * @param {string} [options.path] - The request path.
 * @param {Record<string, string>} [options.headers] - Extra headers.
 * @param {number} options.bytes - The body size.
 * @returns {Promise<{ status?: number, error?: string }>} The response status, or the error code of the connection.
 */
function sendLarge(port, { method = 'POST', path = '/mcp', headers = {}, bytes }) {
   return new Promise((resolve) => {
      const body = Buffer.alloc(bytes, 120);
      const req = http.request(
         {
            host: '127.0.0.1',
            port,
            path,
            method,
            headers: {
               'Content-Type': 'application/json',
               'Content-Length': body.length,
               Accept: 'application/json, text/event-stream',
               ...headers,
            },
         },
         (res) => {
            res.resume();
            res.on('end', () => resolve({ status: res.statusCode }));
         },
      );
      req.on('error', (error) => resolve({ error: error.code ?? error.message }));
      req.end(body);
   });
}

/**
 * Build the request text of a POST to the MCP endpoint.
 * @param {number} port - The MCP port.
 * @param {string[]} extraLines - Extra header lines, and the body after an empty line when the last entry is the body.
 * @returns {string} The raw request text.
 */
function requestText(port, extraLines) {
   return [
      'POST /mcp HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Content-Type: application/json',
      'Accept: application/json, text/event-stream',
      ...extraLines,
   ].join('\r\n');
}

describe('MCP HTTP hardening and session robustness', () => {
   const harness = createHarness();

   afterEach(async () => {
      vi.restoreAllMocks();
      await harness.cleanup();
   });

   describe('request bodies and connections', () => {
      it('refuses a body over the limit declared by Content-Length with 413 and keeps serving', async () => {
         await harness.start({ limits: { bodyMaxBytes: 1000 } });
         const big = await raw(harness.mcp().port(), { body: { filler: 'x'.repeat(2000) } });
         expect(big.status).toBe(413);
         expect(harness.mcp().sessions()).toBe(0);
         expect((await raw(harness.mcp().port(), { body: INITIALIZE })).status).toBe(200);
      });

      it('refuses a session-bound POST over the limit with 413 and keeps the session', async () => {
         await harness.start({ limits: { bodyMaxBytes: 1000 } });
         const { client, transport } = await harness.connectClient();
         const res = await raw(harness.mcp().port(), {
            body: { filler: 'x'.repeat(2000) },
            headers: { 'Mcp-Session-Id': transport.sessionId },
         });
         expect(res.status).toBe(413);
         expect(harness.mcp().sessions()).toBe(1);
         expect(await harness.toolNames(client)).toContain('create_actor');
      });

      it('refuses a chunked body that grows past the limit with 413', async () => {
         await harness.start({ limits: { bodyMaxBytes: 1000 } });
         const text = requestText(harness.mcp().port(), [
            'Transfer-Encoding: chunked',
            '',
            `${(2000).toString(16)}\r\n${'x'.repeat(2000)}\r\n0\r\n\r\n`,
         ]);
         const result = await rawSocket(harness.mcp().port(), text, 400);
         expect(result.answer.startsWith('HTTP/1.1 413')).toBe(true);
         // The body ended, so the refusal completes and the connection closes.
         expect(result.closed).toBe(true);
      });

      it('sends the 413 status at once for a declared body over the limit, before the body arrives', async () => {
         await harness.start({ limits: { bodyMaxBytes: 1000 } });
         const text = requestText(harness.mcp().port(), [
            'Content-Length: 5000',
            '',
            '{"jsonrpc"',
         ]);
         const result = await rawSocket(harness.mcp().port(), text, 400);
         expect(result.answer.startsWith('HTTP/1.1 413')).toBe(true);
      });

      it('accepts a body just under the limit', async () => {
         await harness.start({ limits: { bodyMaxBytes: 4000 } });
         expect((await raw(harness.mcp().port(), { body: INITIALIZE })).status).toBe(200);
      });

      it('answers an unknown session id with 404 before reading any body', async () => {
         await harness.start();
         // The headers promise a 500-byte body that never arrives: a server that read it first would not answer.
         const text = requestText(harness.mcp().port(), [
            'Mcp-Session-Id: 00000000-0000-0000-0000-000000000000',
            'Content-Length: 500',
            '',
            '',
         ]);
         const result = await rawSocket(harness.mcp().port(), text, 400);
         expect(result.answer.startsWith('HTTP/1.1 404')).toBe(true);
      });

      it('answers a hostile Origin with 403 before reading any body', async () => {
         await harness.start();
         const text = requestText(harness.mcp().port(), [
            'Origin: http://evil.example',
            'Content-Length: 1000000000',
            '',
            '',
         ]);
         const result = await rawSocket(harness.mcp().port(), text, 400);
         expect(result.answer.startsWith('HTTP/1.1 403')).toBe(true);
      });

      it.each([
         ['413 for a body over the limit', { bytes: 3_000_000 }, 413],
         ['404 for an unknown session', { bytes: 3_000_000, headers: { 'Mcp-Session-Id': 'unknown' } }, 404],
         ['403 for a hostile Origin', { bytes: 3_000_000, headers: { Origin: 'http://evil.example' } }, 403],
         ['404 for another path', { bytes: 3_000_000, path: '/other' }, 404],
         ['405 for another method', { bytes: 3_000_000, method: 'PUT' }, 405],
      ])('delivers %s to a client that is still sending a large body', async (_label, request, status) => {
         await harness.start({ limits: { bodyMaxBytes: 1000 } });
         const outcome = await sendLarge(harness.mcp().port(), request);
         expect(outcome).toEqual({ status });
      });

      it('closes a request whose body stalls after the request timeout', async () => {
         await harness.start({ limits: {
            requestTimeoutMs: 200,
            headersTimeoutMs: 200,
            timeoutCheckMs: 50,
         } });
         const text = requestText(harness.mcp().port(), [
            'Content-Length: 500',
            '',
            '{"jsonrpc"',
         ]);
         const result = await rawSocket(harness.mcp().port(), text, 900);
         expect(result.closed).toBe(true);
         expect(result.answer.startsWith('HTTP/1.1 408')).toBe(true);
         expect(harness.mcp().sessions()).toBe(0);
      });

      it('closes a connection whose request headers stall after the headers timeout', async () => {
         await harness.start({ limits: {
            requestTimeoutMs: 5_000,
            headersTimeoutMs: 200,
            timeoutCheckMs: 50,
         } });
         // The header block never ends.
         const text = [
            'POST /mcp HTTP/1.1',
            `Host: 127.0.0.1:${harness.mcp().port()}`,
            '',
         ].join('\r\n').slice(0, -2);
         const result = await rawSocket(harness.mcp().port(), text, 900);
         expect(result.closed).toBe(true);
      });

      it('closes a connection that never sends a request after the socket idle timeout', async () => {
         await harness.start({ limits: { socketIdleMs: 150 } });
         const result = await rawSocket(harness.mcp().port(), '', 700);
         expect(result.closed).toBe(true);
         expect(result.answer).toBe('');
      });

      it('keeps an open event stream and a slow tool call alive past every timeout', async () => {
         await harness.start({
            limits: {
               requestTimeoutMs: 200,
               headersTimeoutMs: 200,
               timeoutCheckMs: 50,
               socketIdleMs: 150,
            },
            tools: [{
               name: 'slow_text',
               description: 'Test-only tool that answers after a delay.',
               inputSchema: {},
               handler: async () => {
                  await sleep(600);
                  return { content: [{
                     type: 'text',
                     text: 'late answer',
                  }] };
               },
            }],
         });
         const gm = await harness.connectGm();
         const { client } = await harness.connectClient();
         /** @type {number} The tool list notifications received. */
         let notifications = 0;
         client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            notifications += 1;
         });
         const call = client.callTool({
            name: 'slow_text',
            arguments: {},
         });
         await sleep(650);
         expect(notifications).toBe(0);
         await gm.register([entry('after_wait')]);
         await expect.poll(() => notifications, { timeout: 1000 }).toBe(1);
         const result = await call;
         expect(result.content[0].text).toBe('late answer');
         expect(harness.mcp().sessions()).toBe(1);
      });

      it('closes a connection beyond the connection cap', async () => {
         await harness.start({ limits: { maxConnections: 2 } });
         /** @type {net.Socket[]} The sockets that hold the allowed connections. */
         const held = [];
         for (let index = 0; index < 2; index += 1) {
            const socket = net.connect(harness.mcp().port(), '127.0.0.1');
            socket.on('error', () => undefined);
            await new Promise((resolve) => socket.on('connect', resolve));
            held.push(socket);
         }
         const third = await rawSocket(harness.mcp().port(), 'GET /mcp HTTP/1.1\r\nHost: x\r\n\r\n', 400);
         expect(third.closed).toBe(true);
         expect(third.answer).toBe('');
         for (const socket of held) {
            socket.destroy();
         }
      });
   });

   describe('session cap', () => {
      it('counts initializes still being opened against the cap', async () => {
         await harness.start({ sessions: { maxSessions: 3 } });
         // Slow every session's connect so the initializes overlap.
         const original = McpServer.prototype.connect;
         vi.spyOn(McpServer.prototype, 'connect').mockImplementation(async function (...args) {
            await sleep(60);
            return original.apply(this, args);
         });
         const results = await Promise.all(
            Array.from({ length: 10 }, () => raw(harness.mcp().port(), { body: INITIALIZE })),
         );
         expect(results.filter((res) => res.status === 200)).toHaveLength(3);
         expect(results.filter((res) => res.status === 503)).toHaveLength(7);
         expect(harness.mcp().sessions()).toBe(3);
         expect(harness.logs().some((line) => line.includes('the session cap was reached'))).toBe(false);
      });

      it('stops counting a held session as a pending one while its response is still being written', async () => {
         await harness.start({ sessions: { maxSessions: 2 } });
         const original = StreamableHTTPServerTransport.prototype.handleRequest;
         // The session is held by the time the original resolves; the response then lingers for a while.
         vi.spyOn(StreamableHTTPServerTransport.prototype, 'handleRequest').mockImplementation(
            async function (...args) {
               await original.apply(this, args);
               await sleep(300);
            },
         );
         const first = raw(harness.mcp().port(), { body: INITIALIZE });
         await expect.poll(() => harness.mcp().sessions(), { timeout: 1000 }).toBe(1);
         const second = await raw(harness.mcp().port(), { body: INITIALIZE });
         expect(second.status).toBe(200);
         expect((await first).status).toBe(200);
         expect(harness.mcp().sessions()).toBe(2);
      });

      it('names the sweep period in Retry-After', async () => {
         await harness.start({ sessions: { maxSessions: 1 } });
         await harness.connectClient();
         const refused = await raw(harness.mcp().port(), { body: INITIALIZE });
         expect(refused.status).toBe(503);
         expect(refused.headers['retry-after']).toBe('60');
      });

      it('rounds a sweep period up to whole seconds in Retry-After', async () => {
         await harness.start({ sessions: {
            maxSessions: 1,
            sweepMs: 2500,
         } });
         await harness.connectClient();
         const refused = await raw(harness.mcp().port(), { body: INITIALIZE });
         expect(refused.headers['retry-after']).toBe('3');
      });
   });

   describe('guarded session callbacks', () => {
      it('ends only the session whose tool sync throws and logs bounded text', async () => {
         await harness.start();
         const gm = await harness.connectGm();
         const agent = await harness.connectClient('?endpoint=agent');
         const human = await harness.connectClient('?endpoint=human');
         const original = McpServer.prototype.registerTool;
         vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function (name, ...rest) {
            if (name === 'boom') {
               throw new Error(`broken\nregistration ${'y'.repeat(2000)}`);
            }
            return original.call(this, name, ...rest);
         });
         await gm.register([entry('boom')]);
         await expect.poll(() => harness.mcp().sessions(), { timeout: 1000 }).toBe(1);
         expect(await harness.toolNames(agent.client)).toEqual([
            'create_actor',
            'read_handle',
         ]);
         await expect(human.client.listTools()).rejects.toThrow();
         const line = harness.logs().find((text) => text.includes('tool sync failed, ending it'));
         expect(line).toBeDefined();
         expect(line).not.toContain('\n');
         expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(400);
      });

      it('fails an initialize with 500 and holds no session when the first tool sync throws', async () => {
         await harness.start();
         const gm = await harness.connectGm();
         await gm.register([entry('boom')]);
         const original = McpServer.prototype.registerTool;
         vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function (name, ...rest) {
            if (name === 'boom') {
               throw new Error('broken registration');
            }
            return original.call(this, name, ...rest);
         });
         const res = await raw(harness.mcp().port(), { body: INITIALIZE });
         expect(res.status).toBe(500);
         expect(harness.mcp().sessions()).toBe(0);
         expect(harness.logs().some((text) => text.includes('could not start'))).toBe(true);
         vi.restoreAllMocks();
         expect((await raw(harness.mcp().port(), { body: INITIALIZE })).status).toBe(200);
      });

      /**
       * Build a bridge whose registry answers with no tools to the first ask and with one tool afterwards.
       * @param {object} tool - The sanitized tool the registry reveals after the first ask.
       * @returns {object} A bridge for `startMcpServer`.
       */
      function lateBridge(tool) {
         /** @type {number} How many times the bridge was asked for tools. */
         let asked = 0;
         return {
            invoke: async () => 'unused',
            invokeTool: async () => ({
               result: 'unused',
               tool,
            }),
            // The first answer is read while the session is built; the registry changes before it is held.
            tools: () => {
               asked += 1;
               return asked === 1 ? [] : [tool];
            },
            subscribe: () => () => undefined,
         };
      }

      it('lists a tool registered between creating a session and holding it', async () => {
         const [tool] = sanitizeRegistry([entry('late_tool')], () => undefined).tools;
         await harness.start({ bridge: lateBridge(tool) });
         const { client } = await harness.connectClient();
         expect(await harness.toolNames(client)).toEqual([
            'create_actor',
            'late_tool',
            'read_handle',
         ]);
      });

      it('fails the initialize and ends the session when the sync right after holding it throws', async () => {
         const [tool] = sanitizeRegistry([entry('late_tool')], () => undefined).tools;
         await harness.start({ bridge: lateBridge(tool) });
         const original = McpServer.prototype.registerTool;
         vi.spyOn(McpServer.prototype, 'registerTool').mockImplementation(function (name, ...rest) {
            if (name === 'late_tool') {
               throw new Error('broken registration');
            }
            return original.call(this, name, ...rest);
         });
         const res = await raw(harness.mcp().port(), { body: INITIALIZE });
         expect(res.status).toBeGreaterThanOrEqual(400);
         expect(res.headers['mcp-session-id']).toBeUndefined();
         await expect.poll(() => harness.mcp().sessions(), { timeout: 1000 }).toBe(0);
         expect(harness.logs().some((text) => text.includes('tool sync failed, ending it'))).toBe(true);
      });

      it('releases the handles of a session exactly once when DELETE ends it', async () => {
         await harness.start();
         /** @type {string[]} The owners released, in order. */
         const releases = [];
         const store = harness.store();
         const real = store.releaseOwner;
         store.releaseOwner = (owner) => {
            releases.push(owner);
            return real(owner);
         };
         const { transport } = await harness.connectClient();
         const id = transport.sessionId;
         await transport.terminateSession();
         await expect.poll(() => harness.mcp().sessions(), { timeout: 1000 }).toBe(0);
         // Closing the transport re-enters the end path; let any second call land.
         await sleep(100);
         expect(releases).toEqual([id]);
      });

      it('stores no handle for a session that ended while its tool was running', async () => {
         /**
          * Lets the pending tool finish; replaced once the promise below is created.
          * @returns {void}
          */
         let release = () => undefined;
         const pending = new Promise((resolve) => {
            release = resolve;
         });
         await harness.start({ tools: [{
            name: 'slow_big',
            description: 'Test-only tool that returns a large text after a delay.',
            inputSchema: {},
            handler: async () => {
               await pending;
               return { content: [{
                  type: 'text',
                  text: 'z'.repeat(20_000),
               }] };
            },
         }] });
         const { client, transport } = await harness.connectClient();
         const call = client.callTool({
            name: 'slow_big',
            arguments: {},
         });
         call.catch(() => undefined);
         await sleep(50);
         const res = await raw(harness.mcp().port(), {
            method: 'DELETE',
            headers: { 'Mcp-Session-Id': transport.sessionId },
         });
         expect(res.status).toBe(200);
         await expect.poll(() => harness.mcp().sessions(), { timeout: 1000 }).toBe(0);
         release();
         await sleep(100);
         expect(harness.store().stats().entries).toBe(0);
      });
   });

   describe('tool calls bind to the endpoint that is reached', () => {
      /** @type {object} Session settings that keep a session's listed tools stale for the whole test. */
      const STALE = {
         listChangedQuietMs: 60_000,
         listChangedMaxWaitMs: 60_000,
      };

      it('denies a gated tool when another endpoint declares the same name without the gate', async () => {
         await harness.start({ sessions: STALE });
         const human = await harness.connectGm({ kind: 'human' });
         await human.pushGates({ allowUserWrites: true });
         await human.register([entry('writer', { gate: 'allowUserWrites' })]);
         const { client } = await harness.connectClient();
         expect(await harness.toolNames(client)).toContain('writer');
         const rogue = await harness.connectGm({ kind: 'agent' });
         await rogue.register([entry('writer')]);
         const result = await client.callTool({
            name: 'writer',
            arguments: { text: 'go' },
         });
         expect(result.isError).toBe(true);
         expect(result.content[0].text.startsWith(`${GATE_DENIED}: `)).toBe(true);
         expect(rogue.invokes).toEqual([]);
         expect(human.invokes).toEqual([]);
      });

      it('refuses a call when another endpoint declares other arguments for the same name', async () => {
         await harness.start({ sessions: STALE });
         const human = await harness.connectGm({ kind: 'human' });
         await human.register([entry('reader')]);
         const { client } = await harness.connectClient();
         expect(await harness.toolNames(client)).toContain('reader');
         const rogue = await harness.connectGm({ kind: 'agent' });
         await rogue.register([entry('reader', {
            inputSchema: {
               type: 'object',
               properties: { count: { type: 'integer' } },
            },
         })]);
         const result = await client.callTool({
            name: 'reader',
            arguments: { text: 'go' },
         });
         expect(result.isError).toBe(true);
         expect(result.content[0].text.startsWith(`${TOOL_GONE}: `)).toBe(true);
         expect(rogue.invokes).toEqual([]);
      });

      it('applies the budget the picked endpoint declares, not the listed one', async () => {
         await harness.start({ sessions: STALE });
         const human = await harness.connectGm({ kind: 'human' });
         await human.register([entry('reader', { budgetBytes: 16_000 })]);
         const { client } = await harness.connectClient();
         expect(await harness.toolNames(client)).toContain('reader');
         const agent = await harness.connectGm({
            kind: 'agent',
            answer: () => ({
               ok: true,
               result: 'q'.repeat(300),
            }),
         });
         await agent.register([entry('reader', { budgetBytes: 50 })]);
         const result = await client.callTool({
            name: 'reader',
            arguments: { text: 'go' },
         });
         expect(JSON.parse(result.content[0].text).handle).toBeTruthy();
         expect(agent.invokes).toHaveLength(1);
      });

      it('answers TOOL_GONE when the picked endpoint no longer registers the tool', async () => {
         await harness.start({ sessions: STALE });
         const human = await harness.connectGm({ kind: 'human' });
         await human.register([entry('fleeting')]);
         const { client } = await harness.connectClient();
         expect(await harness.toolNames(client)).toContain('fleeting');
         await human.register([]);
         const result = await client.callTool({
            name: 'fleeting',
            arguments: { text: 'go' },
         });
         expect(result.isError).toBe(true);
         expect(result.content[0].text.startsWith(`${TOOL_GONE}: `)).toBe(true);
         expect(human.invokes).toEqual([]);
      });

      it('answers NO_ENDPOINT for a pinned session whose endpoint dropped, without falling back', async () => {
         await harness.start({ sessions: STALE });
         const agent = await harness.connectGm({ kind: 'agent' });
         const human = await harness.connectGm({ kind: 'human' });
         await agent.register([entry('pinned_tool')]);
         await human.register([entry('pinned_tool')]);
         const { client } = await harness.connectClient('?endpoint=agent');
         expect(await harness.toolNames(client)).toContain('pinned_tool');
         agent.socket.close();
         await expect
            .poll(() => harness.server().bridge.tools({ endpoint: 'agent' }).length, { timeout: 1000 })
            .toBe(0);
         const result = await client.callTool({
            name: 'pinned_tool',
            arguments: { text: 'go' },
         });
         expect(result.isError).toBe(true);
         expect(result.content[0].text.startsWith('NO_ENDPOINT: ')).toBe(true);
         expect(human.invokes).toEqual([]);
      });
   });
});
