/**
 * Raw JSON-RPC access to the MCP endpoint for integration tests that check wire-level answers. Not a test file (vitest
 * only collects `*.test.js`). The server is stateful, so the first call to a port opens a session and every later call
 * to that port carries its id.
 */

import http from 'node:http';
import net from 'node:net';

/** @type {Map<number, string>} The session id opened for each MCP port. */
const SESSIONS = new Map();

/**
 * Parse a JSON or event-stream MCP response body.
 * @param {string} text - The raw response body.
 * @returns {any} The parsed JSON-RPC message.
 */
function parseBody(text) {
   /** @type {string | undefined} The first SSE data line, if the response is an event stream. */
   const dataLine = text.split('\n').find((line) => line.startsWith('data:'));
   return JSON.parse(dataLine ? dataLine.slice(5) : text);
}

/**
 * Open a session on an MCP port: initialize, then acknowledge it with `notifications/initialized`.
 * @param {number} mcpPort - The loopback port of the MCP server under test.
 * @returns {Promise<string>} The session id.
 */
async function openSession(mcpPort) {
   /** @type {Response} The initialize response. */
   const init = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: {
         'Content-Type': 'application/json',
         Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
         jsonrpc: '2.0',
         id: 0,
         method: 'initialize',
         params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
               name: 'raw',
               version: '0.0.0',
            },
         },
      }),
   });
   await init.text();
   /** @type {string | null} The session id the server assigned. */
   const id = init.headers.get('mcp-session-id');
   if (!id) {
      throw new Error(`initialize answered ${init.status} without a session id`);
   }
   const ack = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: {
         'Content-Type': 'application/json',
         Accept: 'application/json, text/event-stream',
         'Mcp-Session-Id': id,
      },
      body: JSON.stringify({
         jsonrpc: '2.0',
         method: 'notifications/initialized',
      }),
   });
   await ack.text();
   return id;
}

/**
 * POST a JSON-RPC request to the MCP endpoint inside the port's session and parse the (JSON or SSE) response.
 * @param {number} mcpPort - The loopback port of the MCP server under test.
 * @param {object} body - The JSON-RPC request.
 * @returns {Promise<any>} The parsed JSON-RPC response.
 */
export async function mcpCall(mcpPort, body) {
   /** @type {string} The session this port's calls belong to. */
   const id = SESSIONS.get(mcpPort) ?? (await openSession(mcpPort));
   SESSIONS.set(mcpPort, id);
   /** @type {Response} The HTTP response from the MCP endpoint. */
   const res = await fetch(`http://127.0.0.1:${mcpPort}/mcp`, {
      method: 'POST',
      headers: {
         'Content-Type': 'application/json',
         Accept: 'application/json, text/event-stream',
         'Mcp-Session-Id': id,
      },
      body: JSON.stringify(body),
   });
   return parseBody(await res.text());
}

/**
 * Call the `create_actor` MCP tool inside the port's session.
 * @param {number} mcpPort - The loopback port of the MCP server under test.
 * @returns {Promise<{ isError?: boolean, content: { text: string }[] }>} The tool result.
 */
export async function callCreateActor(mcpPort) {
   /** @type {{ result: any }} The JSON-RPC response. */
   const response = await mcpCall(mcpPort, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
         name: 'create_actor',
         arguments: {
            name: 'Bob',
            type: 'npc',
         },
      },
   });
   return response.result;
}

/**
 * Reserve a free loopback TCP port by listening on port 0 and releasing it.
 * @returns {Promise<number>} A port that was free at probe time.
 */
export function freePort() {
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
 * Send one raw HTTP request to the MCP port and collect the whole response.
 * @param {number} port - The MCP port.
 * @param {object} options - Request settings.
 * @param {string} [options.method] - The HTTP method.
 * @param {string} [options.path] - The request path.
 * @param {Record<string, string>} [options.headers] - Extra headers.
 * @param {unknown} [options.body] - A JSON body.
 * @returns {Promise<{ status: number, headers: Record<string, string>, text: string }>} The response.
 */
export function raw(port, { method = 'POST', path = '/mcp', headers = {}, body } = {}) {
   return new Promise((resolve, reject) => {
      /** @type {string | undefined} The serialized body. */
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = http.request(
         {
            host: '127.0.0.1',
            port,
            path,
            method,
            headers: {
               Accept: 'application/json, text/event-stream',
               ...(payload === undefined
                  ? {}
                  : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
               ...headers,
            },
         },
         (res) => {
            /** @type {Buffer[]} The response body parts received so far. */
            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () =>
               resolve({
                  status: res.statusCode,
                  headers: res.headers,
                  text: Buffer.concat(chunks).toString('utf8'),
               }),
            );
         },
      );
      req.on('error', reject);
      req.end(payload);
   });
}

/** @type {object} A JSON-RPC initialize request. */
export const INITIALIZE = {
   jsonrpc: '2.0',
   id: 1,
   method: 'initialize',
   params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: {
         name: 'raw',
         version: '0.0.0',
      },
   },
};

