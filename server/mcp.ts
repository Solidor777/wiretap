import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { OP_CREATE_ACTOR } from '../shared/protocol.js';

interface FoundryBridge {
   invokeOnGM: (op: string, params: object) => Promise<unknown>;
}

interface CreateActorResult {
   uuid: string;
   id?: string;
   name: string;
   type: string;
}

/**
 * Build the `create_actor` tool handler bound to a Foundry bridge. Pure of any HTTP/transport concern,
 * so it is unit-testable in isolation.
 * @param {FoundryBridge} bridge - The Foundry bridge used to execute the operation on a GM client.
 * @returns {Function} An async handler mapping tool args to an MCP tool result.
 */
export function makeCreateActorHandler(
   bridge: FoundryBridge,
): (args: { name: string; type?: string }) => Promise<CallToolResult> {
   return async ({ name, type }) => {
      try {
         const result = (await bridge.invokeOnGM(OP_CREATE_ACTOR, { name, type })) as CreateActorResult;
         return {
            content: [{ type: 'text', text: `Created actor "${result.name}" (${result.type}) — ${result.uuid}` }],
         };
      } catch (err) {
         return {
            content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
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
   const server = new McpServer({ name: 'wiretap', version: '0.0.1' });
   const handler = makeCreateActorHandler(bridge);
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
               .describe("The actor subtype, e.g. 'character' or 'npc'. Defaults to the world's first concrete subtype."),
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
 * @returns {{ close: () => void }} A handle with a `close` method to stop the HTTP server.
 */
export function startMcpServer(bridge: FoundryBridge, port: number): { close: () => void } {
   const httpServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/mcp') {
         const chunks: Buffer[] = [];
         for await (const chunk of req) {
            chunks.push(chunk as Buffer);
         }
         let body: unknown;
         try {
            body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
         } catch {
            res.writeHead(400).end();
            return;
         }
         const server = buildServer(bridge);
         const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
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
   httpServer.listen(port, '127.0.0.1');
   return { close: () => httpServer.close() };
}
