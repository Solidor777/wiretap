import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { OP_CREATE_ACTOR, OP_FAILED } from '../shared/protocol.js';
import { BridgeError, formatBridgeError, truncateUtf8, type InvokeOptions } from './endpoints.ts';
import { isMcpHostAllowed, isOriginAllowed } from './origins.ts';

/** The slice of the Foundry bridge the MCP tools need. */
interface FoundryBridge {
   invoke: (op: string, params: object, options?: InvokeOptions) => Promise<unknown>;
}

/** The validated, bounded description of a created actor. */
interface CreateActorResult {
   uuid: string;
   name: string;
   type: string;
}

// Maximum UTF-8 byte length of each string of a `create_actor` result returned to the caller.
const MAX_RESULT_STRING_BYTES: number = 256;

/**
 * Validate the result an endpoint acked for `create_actor`: an object whose `uuid`, `name` and `type` are strings.
 * Each string is bounded to 256 bytes so a hostile endpoint cannot flood the tool text.
 * @param {unknown} result - The raw ack result.
 * @returns {CreateActorResult} The bounded result.
 * @throws {BridgeError} OP_FAILED with a short message when the result has any other shape.
 */
function parseCreateActorResult(result: unknown): CreateActorResult {
   if (typeof result !== 'object' || result === null || Array.isArray(result)) {
      throw new BridgeError(OP_FAILED, 'Foundry returned an invalid actor result.');
   }
   // The untrusted result viewed as a field map; each field is type-checked before use.
   const fields: Record<string, unknown> = result as Record<string, unknown>;
   if (typeof fields.uuid !== 'string' || typeof fields.name !== 'string' || typeof fields.type !== 'string') {
      throw new BridgeError(OP_FAILED, 'Foundry returned an invalid actor result.');
   }
   return {
      uuid: truncateUtf8(fields.uuid, MAX_RESULT_STRING_BYTES),
      name: truncateUtf8(fields.name, MAX_RESULT_STRING_BYTES),
      type: truncateUtf8(fields.type, MAX_RESULT_STRING_BYTES),
   };
}

/**
 * Render a thrown value as tool-result text: a BridgeError as `<code>: <message>` (plus a truncated-failures suffix),
 * any other value as its message.
 * @param {unknown} err - The thrown value.
 * @returns {string} The text.
 */
function describeError(err: unknown): string {
   if (err instanceof BridgeError) {
      return formatBridgeError(err);
   }
   return err instanceof Error ? err.message : String(err);
}

/**
 * Build the `create_actor` tool handler bound to a Foundry bridge. Pure of any HTTP/transport concern,
 * so it is unit-testable in isolation.
 * @param {FoundryBridge} bridge - The Foundry bridge whose router executes the operation on a GM endpoint.
 * @returns {Function} An async handler mapping tool args to an MCP tool result.
 */
export function makeCreateActorHandler(
   bridge: FoundryBridge,
): (args: { name: string; type?: string }) => Promise<CallToolResult> {
   return async ({ name, type }) => {
      try {
         const result: CreateActorResult = parseCreateActorResult(await bridge.invoke(OP_CREATE_ACTOR, { name, type }));
         return {
            content: [{ type: 'text', text: `Created actor "${result.name}" (${result.type}) — ${result.uuid}` }],
         };
      } catch (err) {
         return {
            content: [{ type: 'text', text: describeError(err) }],
            isError: true,
         };
      }
   };
}

/**
 * Construct a fresh MCP server with the create_actor tool registered. A new instance is created per
 * request in stateless mode.
 * @param {FoundryBridge} bridge - The Foundry bridge passed to the tool handler.
 * @returns {McpServer} A configured McpServer.
 */
function buildServer(bridge: FoundryBridge): McpServer {
   // The per-request MCP server.
   const server: McpServer = new McpServer({ name: 'wiretap', version: '0.0.1' });
   // The create_actor tool handler.
   const handler: ReturnType<typeof makeCreateActorHandler> = makeCreateActorHandler(bridge);
   server.registerTool(
      'create_actor',
      {
         description:
            'Create an Actor in the live Foundry world. Returns the created actor uuid. ' +
            "If 'type' is omitted it defaults to the world's first concrete actor subtype.",
         inputSchema: {
            name: z.string().describe('The actor name.'),
            type: z
               .string()
               .optional()
               .describe(
                  "The actor subtype, e.g. 'character' or 'npc'. Defaults to the world's first concrete subtype.",
               ),
         },
      },
      handler,
   );
   return server;
}

/**
 * Start the MCP HTTP server (Streamable HTTP, stateless) bound to localhost only.
 * @param {FoundryBridge} bridge - The Foundry bridge the tools execute against.
 * @param {number} port - The TCP port to listen on.
 * @returns {{ close: () => void; ready: Promise<void>; port: () => number }} A handle with a `close` method to stop the
 *          HTTP server, a promise that resolves once the port is bound or rejects (for example EADDRINUSE) when
 *          binding fails, and `port()`, the port actually bound (the requested port until `ready` resolves).
 */
export function startMcpServer(
   bridge: FoundryBridge,
   port: number,
): { close: () => void; ready: Promise<void>; port: () => number } {
   // The port the server is bound to; differs from `port` when 0 requested an ephemeral port. The Host check reads it.
   let boundPort: number = port;
   // The loopback HTTP server that receives MCP requests.
   const httpServer: http.Server = http.createServer(async (req, res) => {
      // Origin and Host are checked before the method and path so no response differs for a hostile caller: a browser
      // page of another origin, or a DNS-rebinding page addressing this port under another name, gets 403.
      if (!isOriginAllowed(req.headers.origin) || !isMcpHostAllowed(req.headers.host, boundPort)) {
         res.writeHead(403).end();
         return;
      }
      if (req.method === 'POST' && req.url === '/mcp') {
         let body: unknown;
         try {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
               chunks.push(chunk as Buffer);
            }
            body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
         } catch {
            // A malformed body or a stream error mid-read (client abort or reset) becomes a clean 400
            // rather than an unhandled promise rejection in the request handler.
            if (!res.headersSent) {
               res.writeHead(400).end();
            }
            return;
         }
         // The per-request MCP server and its stateless transport.
         const server: McpServer = buildServer(bridge);
         const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
         });
         res.on('close', () => {
            transport.close();
            server.close();
         });
         try {
            await server.connect(transport);
            await transport.handleRequest(req, res, body);
         } catch {
            // Surface an unexpected dispatch failure as a JSON-RPC internal error rather than hanging the client.
            if (!res.headersSent) {
               res.writeHead(500, { 'Content-Type': 'application/json' }).end(
                  JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null }),
               );
            }
         }
      } else {
         res.writeHead(405).end();
      }
   });
   // Bind to loopback only: this endpoint executes game mutations and must not be reachable off-host.
   // Resolves once the port is bound; rejects on a bind failure so it is not an uncaught 'error' event.
   const ready: Promise<void> = new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(port, '127.0.0.1', () => {
         httpServer.off('error', reject);
         boundPort = (httpServer.address() as AddressInfo).port;
         resolve();
      });
   });
   return { close: () => httpServer.close(), ready, port: () => boundPort };
}
