import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import { getBudget } from '../shared/budgets.js';
import { OP_CREATE_ACTOR, OP_FAILED } from '../shared/protocol.js';
import { BridgeError, formatBridgeError, type InvokeOptions } from './endpoints.ts';
import { createHandleStore, type HandleStore, type SliceResult } from './handles.ts';
import { isMcpHostAllowed, isOriginAllowed } from './origins.ts';
import { withResultBudget, type ToolHandler } from './resultBudget.ts';
import { truncateUtf8 } from './utf8.ts';

/** The slice of the Foundry bridge the MCP tools need. */
interface FoundryBridge {
   invoke: (op: string, params: object, options?: InvokeOptions) => Promise<unknown>;
}

/** A tool the server registers behind the result enforcer. */
export interface ToolRegistration {
   /** The MCP tool name. */
   name: string;
   /** The one-line description the client lists. */
   description: string;
   /**
    * The zod shape of the arguments. The SDK strips arguments the shape does not declare, so a tool opts in to the
    * per-call `maxBytes` result limit by declaring `maxBytes` here (which adds to the tool's definition size).
    */
   inputSchema: ZodRawShape;
   /** The callback that runs the tool; it receives the validated arguments. */
   handler: ToolHandler<never>;
   /** The tool's own result budget in bytes; the hard cap applies when it is larger or absent. */
   budgetBytes?: number;
}

/** Settings of the MCP server. */
export interface McpServerOptions {
   /** Tools registered after the built-in ones; each is wrapped by the result enforcer. */
   tools?: ToolRegistration[];
   /** The server `instructions` text the client receives at session start; none when absent. */
   instructions?: string;
}

/** The arguments of `read_handle`. */
interface ReadHandleArgs {
   /** The handle from an earlier large result. */
   handle: string;
   /** Document paths to resolve over the stored JSON. */
   paths?: string[];
   /** First UTF-16 unit of the viewed text to return. */
   offset?: number;
   /** Most UTF-16 units to return. */
   length?: number;
   /** Size limit in bytes for this call's whole result (window and footer), 1 to 16,000; default 8,000. */
   maxBytes?: number;
}

/** The validated, bounded description of a created actor. */
interface CreateActorResult {
   uuid: string;
   name: string;
   type: string;
}

// The owner key under which every result handle is stored. MCP sessions are stateless, so every caller shares one
// owner. TODO: key handles by the MCP session id once sessions are stateful, so one session cannot read another's.
const PROCESS_OWNER_KEY: string = 'mcp';

// Largest `maxBytes` a `read_handle` call may declare, in bytes.
const READ_HANDLE_MAX_BYTES: number = getBudget('RESULT_HARD_CAP_MAX_BYTES').value;

// Smallest `maxBytes` a `read_handle` call may declare: the footer reserve plus a window that holds any character, so
// the result is always a window and a footer and never itself over the limit.
const READ_HANDLE_MIN_BYTES: number = 128;

// Bytes reserved in a `read_handle` result for the footer item that follows the window text.
const READ_HANDLE_FOOTER_BYTES: number = 64;

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
            content: [
               {
                  type: 'text',
                  text: `Created actor "${result.name}" (${result.type}) — ${result.uuid}`,
               },
            ],
         };
      } catch (err) {
         if (!(err instanceof BridgeError)) {
            // Only a BridgeError carries text meant for the caller; the result enforcer answers anything else with a
            // fixed message and logs the cause.
            throw err;
         }
         return {
            content: [
               {
                  type: 'text',
                  text: describeError(err),
               },
            ],
            isError: true,
         };
      }
   };
}

/**
 * Build the `read_handle` tool handler: a window of a stored result, optionally after resolving document paths over it.
 * The window text is the first content item and a footer `{offset, length, total}` (plus `truncated: true` when a
 * paths result was cut at the window size) the second; together they stay within the call's `maxBytes` (default: the
 * result hard cap).
 * @param {HandleStore} store - The store holding the results.
 * @param {string} ownerKey - The owner key whose handles may be read.
 * @returns {ToolHandler<ReadHandleArgs>} An async handler mapping tool args to an MCP tool result.
 */
export function makeReadHandleHandler(store: HandleStore, ownerKey: string): ToolHandler<ReadHandleArgs> {
   // The result size limit when the call gives no `maxBytes`.
   const defaultBytes: number = getBudget('RESULT_HARD_CAP_DEFAULT_BYTES').value;
   return async ({ handle, paths, offset, length, maxBytes }) => {
      if (maxBytes !== undefined && maxBytes < READ_HANDLE_MIN_BYTES) {
         return {
            content: [
               {
                  type: 'text',
                  text: `HANDLE_WINDOW_TOO_SMALL: maxBytes must be at least ${READ_HANDLE_MIN_BYTES}.`,
               },
            ],
            isError: true,
         };
      }
      // The outcome of reading the window, bounded to the call's size limit less the footer.
      const slice: SliceResult = store.slice(ownerKey, handle, {
         paths,
         offset,
         length,
         maxBytes: (maxBytes ?? defaultBytes) - READ_HANDLE_FOOTER_BYTES,
      });
      if (!slice.ok) {
         return {
            content: [
               {
                  type: 'text',
                  text: `${slice.error.code}: ${slice.error.message}`,
               },
            ],
            isError: true,
         };
      }
      return {
         content: [
            {
               type: 'text',
               text: slice.text,
            },
            {
               type: 'text',
               text: JSON.stringify({
                  offset: slice.offset,
                  length: slice.length,
                  total: slice.total,
                  ...(slice.truncated ? { truncated: true } : {}),
               }),
            },
         ],
      };
   };
}

/**
 * Construct a fresh MCP server with the built-in tools and the given extra tools registered, each behind the result
 * enforcer. A new instance is created per request in stateless mode.
 * @param {FoundryBridge} bridge - The Foundry bridge passed to the tool handler.
 * @param {HandleStore} store - The store receiving results over the limit.
 * @param {ToolRegistration[]} extraTools - Tools registered after the built-in ones.
 * @param {string} [instructions] - The server instructions text, when there is one.
 * @returns {McpServer} A configured McpServer.
 */
function buildServer(
   bridge: FoundryBridge,
   store: HandleStore,
   extraTools: ToolRegistration[],
   instructions?: string,
): McpServer {
   // The per-request MCP server.
   const server: McpServer = new McpServer(
      {
         name: 'wiretap',
         version: '0.0.1',
      },
      instructions === undefined ? undefined : { instructions },
   );
   // The owner key shared by the `read_handle` reader and every tool's enforcer, so a handle stored by one is readable
   // by the other.
   const ownerKey: string = PROCESS_OWNER_KEY;
   // The tools to register: the built-in ones, then the caller's.
   const tools: ToolRegistration[] = [
      {
         name: 'create_actor',
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
         handler: makeCreateActorHandler(bridge),
         // A write answers with an acknowledgement; anything larger becomes a handle.
         budgetBytes: getBudget('ACK_MAX_BYTES').value,
      },
      {
         name: 'read_handle',
         description: 'Read a slice of a stored large result: optional document paths, then offset and length.',
         inputSchema: {
            handle: z.string().max(64).describe('Handle from an earlier large result.'),
            paths: z
               .array(z.string())
               .max(getBudget('PATHS_PER_CALL_MAX').value)
               .optional()
               .describe('Document paths to read.'),
            offset: z.number().int().min(0).optional().describe('First UTF-16 unit to return.'),
            length: z.number().int().min(1).optional().describe('Most UTF-16 units to return.'),
            maxBytes: z
               .number()
               .int()
               .min(READ_HANDLE_MIN_BYTES)
               .max(READ_HANDLE_MAX_BYTES)
               .optional()
               .describe('Result size limit.'),
         },
         handler: makeReadHandleHandler(store, ownerKey),
      },
      ...extraTools,
   ];
   for (const tool of tools) {
      server.registerTool(
         tool.name,
         {
            description: tool.description,
            inputSchema: tool.inputSchema,
         },
         // The registry erases each handler's argument type; the zod shape above has validated the arguments.
         withResultBudget(tool.handler as ToolHandler<Record<string, unknown>>, {
            store,
            ownerKey,
            budgetBytes: tool.budgetBytes,
         }),
      );
   }
   return server;
}

/**
 * Start the MCP HTTP server (Streamable HTTP, stateless) bound to localhost only.
 * @param {FoundryBridge} bridge - The Foundry bridge the tools execute against.
 * @param {number} port - The TCP port to listen on.
 * @param {McpServerOptions} [options] - Extra tools and the server instructions.
 * @returns {{ close: () => void; ready: Promise<void>; port: () => number }} A handle with a `close` method to stop the
 *          HTTP server, a promise that resolves once the port is bound or rejects (for example EADDRINUSE) when
 *          binding fails, and `port()`, the port actually bound (the requested port until `ready` resolves).
 */
export function startMcpServer(
   bridge: FoundryBridge,
   port: number,
   options: McpServerOptions = {},
): { close: () => void; ready: Promise<void>; port: () => number } {
   // The store behind every request's `read_handle`; it outlives the per-request servers.
   const store: HandleStore = createHandleStore();
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
         const server: McpServer = buildServer(bridge, store, options.tools ?? [], options.instructions);
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
                  JSON.stringify({
                     jsonrpc: '2.0',
                     error: {
                        code: -32603,
                        message: 'Internal error',
                     },
                     id: null,
                  }),
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
   return {
      close: () => httpServer.close(),
      ready,
      port: () => boundPort,
   };
}
