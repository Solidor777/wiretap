import { randomUUID } from 'node:crypto';
import http from 'node:http';
import type net from 'node:net';
import type { AddressInfo } from 'node:net';
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z, type ZodRawShape } from 'zod';
import { getBudget } from '../shared/budgets.js';
import { ENDPOINT_KINDS, OP_CALL_TOOL, OP_CREATE_ACTOR, OP_FAILED } from '../shared/protocol.js';
import {
   BridgeError,
   formatBridgeError,
   type EndpointKind,
   type InvokeOptions,
   type Router,
} from './endpoints.ts';
import { createHandleStore, type HandleStore, type SliceResult } from './handles.ts';
import {
   LIST_CHANGED_MAX_WAIT_MS,
   LIST_CHANGED_QUIET_MS,
   MCP_SESSION_SWEEP_MS,
   createDebouncer,
   createSessionManager,
   type Debouncer,
   type ManagedSession,
   type SessionManager,
   type SessionTimers,
} from './mcpSessions.ts';
import { describeCause } from './logText.ts';
import { isMcpHostAllowed, isOriginAllowed } from './origins.ts';
import { failureResult, withResultBudget, type ResultBudgetOptions, type ToolHandler } from './resultBudget.ts';
import { RESERVED_TOOL_NAMES, type RegistryTool } from './toolRegistry.ts';
import { truncateUtf8 } from './utf8.ts';

/** The slice of the Foundry bridge the MCP layer needs. */
interface FoundryBridge {
   invoke: (op: string, params: object, options?: InvokeOptions) => Promise<unknown>;
   // Runs a registry tool on the picked endpoint, resolving it by name there (see `Router.invokeTool`).
   invokeTool: Router['invokeTool'];
   // The tools the endpoint a call with the same `endpoint` option would reach has registered.
   tools: (options?: InvokeOptions) => RegistryTool[];
   // Calls the listener after each endpoint-set, health or tool change; returns the unsubscribe function.
   subscribe: (listener: () => void) => () => void;
}

// The server `instructions` every session receives at initialize: a short orientation, not documentation. Constraint:
// at most `INSTRUCTIONS_MAX_CHARS` characters, and every `mcp__wiretap__<tool>` it names must be a tool the server
// lists (the context-budget test checks both). It names no skill: none ships yet.
export const WIRETAP_INSTRUCTIONS: string =
   'Wiretap connects this session to the live Foundry VTT world through a GM browser. ' +
   'mcp__wiretap__create_actor creates an actor. A result over the size cap comes back as a handle: page it with ' +
   'mcp__wiretap__read_handle (offset and length, or paths into the stored JSON). Tools can appear or vanish while ' +
   'the session runs (the server sends tools/list_changed); they are the scripts the GM client registers.';

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

/** Injectable settings of the MCP sessions. */
export interface McpSessionSettings {
   /** Most sessions held at once (default: the `MCP_SESSIONS_MAX` budget). */
   maxSessions?: number;
   /** Idle milliseconds before a session expires (default 30 minutes). */
   idleMs?: number;
   /** Milliseconds between idle-expiry sweeps (default one minute). */
   sweepMs?: number;
   /** Quiet milliseconds before sessions are told the tool list changed (default 200). */
   listChangedQuietMs?: number;
   /** Longest milliseconds from the first change of a burst to that notification (default 1000). */
   listChangedMaxWaitMs?: number;
   /** Monotonic clock in milliseconds (default `performance.now()`). */
   now?: () => number;
   /** Timer functions (default: the global timers, looked up at call time). */
   timers?: SessionTimers;
   /** Receives one sidecar log line (default: `console.log`). */
   log?: (line: string) => void;
}

/** Injectable limits of the MCP HTTP server. */
export interface McpHttpLimits {
   /** Milliseconds a client has to send a complete request; a slower one gets 408 and is closed. */
   requestTimeoutMs?: number;
   /** Milliseconds a client has to send the request headers; must not exceed `requestTimeoutMs`. */
   headersTimeoutMs?: number;
   /** Milliseconds between the server's checks for requests past those timeouts. */
   timeoutCheckMs?: number;
   /** Most simultaneous connections; one beyond it is closed at once. */
   maxConnections?: number;
   /** Milliseconds a connection may wait without sending any request before it is closed. */
   socketIdleMs?: number;
   /** Most request body bytes read; a larger body is refused with 413 (default: the `MCP_BODY_MAX_BYTES` budget). */
   bodyMaxBytes?: number;
}

/** Settings of the MCP server. */
export interface McpServerOptions {
   /** Tools registered after the built-in ones in every session; each is wrapped by the result enforcer. */
   tools?: ToolRegistration[];
   /** The server `instructions` text each session receives at initialize (default `WIRETAP_INSTRUCTIONS`). */
   instructions?: string;
   /** The store that holds the sessions' large results (default: a new store). */
   handleStore?: HandleStore;
   /** Session limits, clock, timers and logger. */
   sessions?: McpSessionSettings;
   /** Limits of the HTTP server (defaults: the `MCP_*` constants and the `MCP_BODY_MAX_BYTES` budget). */
   limits?: McpHttpLimits;
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

// Largest `maxBytes` a `read_handle` call may declare, in bytes.
const READ_HANDLE_MAX_BYTES: number = getBudget('RESULT_HARD_CAP_MAX_BYTES').value;

// Smallest `maxBytes` a `read_handle` call may declare: the footer reserve plus a window that holds any character, so
// the result is always a window and a footer and never itself over the limit.
const READ_HANDLE_MIN_BYTES: number = 128;

// Bytes reserved in a `read_handle` result for the footer item that follows the window text.
const READ_HANDLE_FOOTER_BYTES: number = 64;

// Milliseconds a client has to send a complete request (headers and body), so a stalled body cannot hold a socket.
const MCP_REQUEST_TIMEOUT_MS: number = 15_000;

// Milliseconds a client has to send the request headers.
const MCP_HEADERS_TIMEOUT_MS: number = 10_000;

// Milliseconds between the HTTP server's checks for requests past the timeouts (Node's own default is 30 s).
const MCP_TIMEOUT_CHECK_MS: number = 1_000;

// Most simultaneous connections: the session cap of event streams plus room for in-flight requests.
const MCP_CONNECTIONS_MAX: number = 128;

// Milliseconds a connection may go without sending a request before it is closed. Node's own timeouts only start with
// the first byte of a request, so a socket that never sends one would otherwise hold a `maxConnections` slot. It does
// not apply while a request is in flight, so an open event stream is never closed by it.
const MCP_SOCKET_IDLE_MS: number = 30_000;

// Most bytes read and discarded from a refused request's body before its connection is closed. Reading the rest lets
// the client receive the refusal; closing with unread data would reset the connection and hide it.
const MCP_DRAIN_MAX_BYTES: number = 8 * 1024 * 1024;

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
         const result: CreateActorResult = parseCreateActorResult(
            await bridge.invoke(OP_CREATE_ACTOR, {
               name,
               type,
            }),
         );
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
 * Build the `read_handle` tool handler: a window of a stored result, optionally after resolving document paths over
 * it.
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

/** An MCP server whose own `list_changed` notification is withheld so the sidecar can debounce it. */
class SessionMcpServer extends McpServer {
   /**
    * Withheld: `registerTool`, `update` and `remove` call this on every change, which would notify once per tool.
    * The sidecar sends one notification per burst through `notifyToolListChanged`.
    * @returns {void}
    */
   override sendToolListChanged(): void {}

   /**
    * Tell the connected client that its tool list changed. A notification with no open event stream is dropped by the
    * transport; a send failure on a closing transport is ignored.
    * @returns {void}
    */
   notifyToolListChanged(): void {
      if (this.isConnected()) {
         this.server.sendToolListChanged().catch(() => undefined);
      }
   }
}

/**
 * Build the router options that restrict a call to a session's endpoint kind.
 * @param {EndpointKind | undefined} endpoint - The session's endpoint kind; none means the default route order.
 * @returns {InvokeOptions} The options: the kind, or nothing.
 */
function routeOptions(endpoint: EndpointKind | undefined): InvokeOptions {
   return endpoint === undefined ? {} : { endpoint };
}

/** A registry tool currently registered on a session's server. */
interface RegisteredRegistryTool {
   /** The tool's change signature when it was registered. */
   signature: string;
   /** The SDK handle used to remove it. */
   handle: RegisteredTool;
}

/** One MCP session: its server, its transport and the registry tools it lists. */
interface McpSession extends ManagedSession {
   server: SessionMcpServer;
   transport: StreamableHTTPServerTransport;
   /** The endpoint kind this session routes to; the router's default order when absent. */
   endpoint: EndpointKind | undefined;
   /** The registry tools registered on the server, keyed by name. */
   registered: Map<string, RegisteredRegistryTool>;
}

/**
 * Build the handler of a tool a Foundry client registered: it runs `callTool` through the bridge, which resolves the
 * tool by name on the endpoint it actually picks, so the gate and the result budget come from that endpoint's own
 * declaration and never from the definition that was listed. The result shown to the caller is text only and passes
 * the result enforcer with that budget.
 * @param {FoundryBridge} bridge - The Foundry bridge.
 * @param {RegistryTool} tool - The tool as listed to the session.
 * @param {EndpointKind | undefined} endpoint - The endpoint kind the session routes to.
 * @param {ResultBudgetOptions} enforcer - The store, owner and liveness check of the session's result enforcer; its
 *        `budgetBytes` is replaced by the picked endpoint's.
 * @returns {ToolHandler<Record<string, unknown>>} The enforcing handler; a BridgeError becomes an error result.
 */
function makeRegistryToolHandler(
   bridge: FoundryBridge,
   tool: RegistryTool,
   endpoint: EndpointKind | undefined,
   enforcer: ResultBudgetOptions,
): ToolHandler<Record<string, unknown>> {
   return async (args, extra) => {
      // The result and the picked endpoint's declaration of the tool.
      let outcome: Awaited<ReturnType<FoundryBridge['invokeTool']>>;
      try {
         outcome = await bridge.invokeTool(tool.name, args, {
            ...routeOptions(endpoint),
            listed: tool,
         });
      } catch (cause) {
         return failureResult(cause);
      }
      return withResultBudget(
         async () => ({
            content: [
               {
                  type: 'text',
                  text: typeof outcome.result === 'string' ? outcome.result : JSON.stringify(outcome.result ?? null),
               },
            ],
         }),
         {
            ...enforcer,
            budgetBytes: outcome.tool.budgetBytes,
         },
      )(args, extra);
   };
}

/**
 * Construct an MCP server for one session with the built-in tools and the given extra tools registered, each behind
 * the result enforcer. The enforcer and `read_handle` use the session id as the handle owner, so a session reads
 * only the handles its own calls stored.
 * @param {FoundryBridge} bridge - The Foundry bridge passed to the tool handler.
 * @param {HandleStore} store - The store receiving results over the limit.
 * @param {ToolRegistration[]} extraTools - Tools registered after the built-in ones.
 * @param {string} instructions - The server instructions text.
 * @param {string} ownerKey - The session id, the owner of the session's handles.
 * @param {() => boolean} ownerLive - Whether that session is still held; a result is not stored for an ended one.
 * @returns {SessionMcpServer} A configured server, not yet connected.
 */
function buildServer(
   bridge: FoundryBridge,
   store: HandleStore,
   extraTools: ToolRegistration[],
   instructions: string,
   ownerKey: string,
   ownerLive: () => boolean,
): SessionMcpServer {
   // The per-session MCP server.
   const server: SessionMcpServer = new SessionMcpServer(
      {
         name: 'wiretap',
         version: '0.0.1',
      },
      { instructions },
   );
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
            ownerLive,
            budgetBytes: tool.budgetBytes,
         }),
      );
   }
   return server;
}

/**
 * Run a callback once the rest of a request body has been read and discarded, so a refusal can be answered before the
 * connection closes without resetting it. More than `MCP_DRAIN_MAX_BYTES` is not read: the request is destroyed.
 * @param {http.IncomingMessage} req - The request.
 * @param {() => void} done - Called once, when the body ended, the stream failed or the request was destroyed.
 * @returns {void}
 */
function drainThen(req: http.IncomingMessage, done: () => void): void {
   if (req.readableEnded) {
      done();
      return;
   }
   // Bytes discarded so far.
   let total: number = 0;
   // Whether the callback ran.
   let finished: boolean = false;
   const finish = (): void => {
      if (!finished) {
         finished = true;
         done();
      }
   };
   req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MCP_DRAIN_MAX_BYTES) {
         req.destroy();
      }
   });
   req.once('end', finish);
   req.once('close', finish);
   req.once('error', finish);
   req.resume();
}

/**
 * Refuse a request: send the status with `Connection: close` at once and end the response once the rest of the request
 * body has been read and discarded, so the client sees the status instead of a reset connection. Nothing is sent when
 * the response already started.
 * @param {http.IncomingMessage} req - The request.
 * @param {http.ServerResponse} res - The response.
 * @param {number} status - The HTTP status.
 * @param {Record<string, string>} [headers] - Extra response headers.
 * @param {string} [payload] - The response body.
 * @returns {void}
 */
function rejectRequest(
   req: http.IncomingMessage,
   res: http.ServerResponse,
   status: number,
   headers: Record<string, string> = {},
   payload?: string,
): void {
   if (res.headersSent) {
      return;
   }
   res.setHeader('Connection', 'close');
   res.writeHead(status, {
      'Content-Length': String(Buffer.byteLength(payload ?? '')),
      ...headers,
   });
   // The status goes out at once; the body follows after the request body has been drained.
   res.flushHeaders();
   drainThen(req, () => res.end(payload));
}

/**
 * Refuse a request with a JSON-RPC error body.
 * @param {http.IncomingMessage} req - The request.
 * @param {http.ServerResponse} res - The response.
 * @param {number} status - The HTTP status.
 * @param {number} code - The JSON-RPC error code.
 * @param {string} message - The error message.
 * @param {Record<string, string>} [headers] - Extra response headers.
 * @returns {void}
 */
function sendError(
   req: http.IncomingMessage,
   res: http.ServerResponse,
   status: number,
   code: number,
   message: string,
   headers: Record<string, string> = {},
): void {
   rejectRequest(
      req,
      res,
      status,
      {
         'Content-Type': 'application/json',
         ...headers,
      },
      JSON.stringify({
         jsonrpc: '2.0',
         error: {
            code,
            message,
         },
         id: null,
      }),
   );
}

/** A JSON request body read successfully (`undefined` when empty). */
interface BodyRead {
   ok: true;
   body: unknown;
}

/** A request body that was not read. */
interface BodyFailure {
   ok: false;
   /** True when the body exceeded the byte limit; false for a malformed body or a stream error. */
   tooLarge: boolean;
}

/** The outcome of reading a request body. */
type BodyResult = BodyRead | BodyFailure;

/**
 * Read and parse a JSON request body, reading at most `maxBytes`. A declared `Content-Length` over the limit fails
 * without reading anything; otherwise reading stops (the stream is paused, nothing more is buffered) at the first
 * chunk that takes the total past the limit.
 * @param {http.IncomingMessage} req - The request.
 * @param {number} maxBytes - The most body bytes to read.
 * @returns {Promise<BodyResult>} The parsed body (undefined when empty), or a failure: too large, or malformed or a
 *          stream error mid-read (client abort or reset).
 */
function readJsonBody(req: http.IncomingMessage, maxBytes: number): Promise<BodyResult> {
   // The length the client declared; NaN when absent or malformed.
   const declared: number = Number(req.headers['content-length']);
   if (declared > maxBytes) {
      return Promise.resolve({
         ok: false,
         tooLarge: true,
      });
   }
   return new Promise((resolve) => {
      // The body chunks received so far.
      const chunks: Buffer[] = [];
      // Bytes received so far.
      let total: number = 0;
      // Whether the promise has settled; later events are ignored.
      let settled: boolean = false;
      // Settles the promise once; later events are ignored.
      const settle = (result: BodyResult): void => {
         if (!settled) {
            settled = true;
            resolve(result);
         }
      };
      req.on('data', (chunk: Buffer) => {
         if (settled) {
            return;
         }
         total += chunk.length;
         if (total > maxBytes) {
            req.pause();
            settle({
               ok: false,
               tooLarge: true,
            });
            return;
         }
         chunks.push(chunk);
      });
      req.on('end', () => {
         try {
            settle({
               ok: true,
               body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined,
            });
         } catch {
            settle({
               ok: false,
               tooLarge: false,
            });
         }
      });
      req.on('error', () => {
         settle({
            ok: false,
            tooLarge: false,
         });
      });
      req.on('close', () => {
         settle({
            ok: false,
            tooLarge: false,
         });
      });
   });
}

/**
 * Read the session id header of a request.
 * @param {http.IncomingMessage} req - The request.
 * @returns {string | undefined} The id; undefined when the header is absent or empty.
 */
function sessionIdOf(req: http.IncomingMessage): string | undefined {
   // The raw header: Node joins repeated headers with commas, so a hostile value is just an unknown id.
   const raw: string | string[] | undefined = req.headers['mcp-session-id'];
   if (raw === undefined || raw === '') {
      return undefined;
   }
   return Array.isArray(raw) ? raw.join(',') : raw;
}

/**
 * Start the MCP HTTP server (stateful Streamable HTTP) bound to localhost only. Each `initialize` POST opens a session
 * with its own server, transport, tool set and result-handle owner; GET opens the session's event stream, POST carries
 * requests and DELETE ends the session. The tool set of a session is the built-in tools, the caller's tools and the
 * tools registered by the Foundry endpoint it routes to; when those change, the session is sent one debounced
 * `notifications/tools/list_changed`. Sessions expire after an idle period and are capped in number.
 * @param {FoundryBridge} bridge - The Foundry bridge the tools execute against.
 * @param {number} port - The TCP port to listen on.
 * @param {McpServerOptions} [options] - Extra tools, the server instructions, a handle store and session settings.
 * @returns {{ close: () => void; ready: Promise<void>; port: () => number; sessions: () => number }} A handle with a
 *          `close` method that ends every session and stops the HTTP server, a promise that resolves once the port is
 *          bound or rejects (for example EADDRINUSE) when binding fails, `port()`, the port actually bound (the
 *          requested port until `ready` resolves), and `sessions()`, the number of open sessions.
 */
export function startMcpServer(
   bridge: FoundryBridge,
   port: number,
   options: McpServerOptions = {},
): { close: () => void; ready: Promise<void>; port: () => number; sessions: () => number } {
   // The settings of the sessions.
   const settings: McpSessionSettings = options.sessions ?? {};
   // The store behind every session's `read_handle`; it outlives the sessions, which own disjoint handles.
   const store: HandleStore = options.handleStore ?? createHandleStore();
   // The caller's tools, registered on every session.
   const extraTools: ToolRegistration[] = options.tools ?? [];
   // The instructions text every session receives.
   const instructions: string = options.instructions ?? WIRETAP_INSTRUCTIONS;
   // The sidecar log sink.
   const log: (line: string) => void = settings.log ?? ((line) => console.log(line));
   // The names of the tools every session has, which a registered tool may not reuse.
   const fixedNames: Set<string> = new Set([
      ...RESERVED_TOOL_NAMES,
      ...extraTools.map((tool) => tool.name),
   ]);
   // Registry tools a session can list beside the fixed ones without exceeding the always-listed budget.
   const registryRoom: number = Math.max(getBudget('ALWAYS_LISTED_TOOLS_MAX').value - fixedNames.size, 0);
   // The limits of the HTTP server.
   const limits: McpHttpLimits = options.limits ?? {};
   // The most request body bytes read.
   const bodyMaxBytes: number = limits.bodyMaxBytes ?? getBudget('MCP_BODY_MAX_BYTES').value;
   // Seconds a refused initialize should wait before retrying: the idle sweep is what frees a slot.
   const retryAfterSeconds: number = Math.max(1, Math.ceil((settings.sweepMs ?? MCP_SESSION_SWEEP_MS) / 1000));
   // The session cap.
   const maxSessions: number = settings.maxSessions ?? getBudget('MCP_SESSIONS_MAX').value;
   // Slots reserved by initialize requests the manager does not hold yet; they count against the session cap until the
   // manager holds (or refuses) their session.
   let opening: number = 0;
   // The port the server is bound to; differs from `port` when 0 requested an ephemeral port. The Host check reads it.
   let boundPort: number = port;

   // The open sessions; ending one releases the result handles it owns.
   const manager: SessionManager = createSessionManager({
      maxSessions,
      idleMs: settings.idleMs,
      sweepMs: settings.sweepMs,
      now: settings.now,
      timers: settings.timers,
      log,
      onEnd: (id) => {
         store.releaseOwner(id);
      },
   });

   /**
    * Make a session's registry tools equal to the wanted tools: remove the ones that are gone, replace the ones whose
    * definition changed and register the new ones. A tool named like a fixed tool, or beyond the always-listed budget,
    * is skipped. The server's own change notifications are withheld; the caller notifies once.
    * @param {McpSession} session - The session.
    * @param {RegistryTool[]} wanted - The tools of the endpoint the session routes to.
    * @returns {boolean} Whether the session's tool list changed.
    */
   function syncRegistryTools(session: McpSession, wanted: RegistryTool[]): boolean {
      // The wanted tools that may be listed.
      const listed: RegistryTool[] = wanted.filter((tool) => !fixedNames.has(tool.name)).slice(0, registryRoom);
      // Whether anything was added, replaced or removed.
      let changed: boolean = false;
      for (const [name, current] of [...session.registered]) {
         const next: RegistryTool | undefined = listed.find((tool) => tool.name === name);
         if (next === undefined || next.signature !== current.signature) {
            current.handle.remove();
            session.registered.delete(name);
            changed = true;
         }
      }
      for (const tool of listed) {
         if (session.registered.has(tool.name)) {
            continue;
         }
         session.registered.set(tool.name, {
            signature: tool.signature,
            handle: session.server.registerTool(
               tool.name,
               {
                  description: tool.description,
                  inputSchema: tool.shape,
               },
               makeRegistryToolHandler(bridge, tool, session.endpoint, {
                  store,
                  ownerKey: session.id,
                  ownerLive: () => manager.get(session.id) !== undefined,
                  budgetBytes: tool.budgetBytes,
               }),
            ),
         });
         changed = true;
      }
      return changed;
   }

   /**
    * Bring a held session's registry tools in line with its endpoint's and, when asked, tell its client. A failure
    * ends only this session (its tool set is then unknown) and is logged; nothing is thrown, because the callers are
    * timer and transport callbacks.
    * @param {McpSession} session - The session.
    * @param {boolean} notify - Whether to send `tools/list_changed` when the tool list changed.
    * @returns {void}
    */
   function syncOrEnd(session: McpSession, notify: boolean): void {
      try {
         // The tools of the endpoint this session routes to now.
         const wanted: RegistryTool[] = bridge.tools(routeOptions(session.endpoint));
         if (syncRegistryTools(session, wanted) && notify) {
            session.server.notifyToolListChanged();
         }
      } catch (cause) {
         log(`Wiretap sidecar | MCP session ${session.id} tool sync failed, ending it: ${describeCause(cause)}`);
         void manager.end(session.id);
      }
   }

   // Tells every session whose tool list changed, once per burst of registry or endpoint changes.
   const debouncer: Debouncer = createDebouncer({
      quietMs: settings.listChangedQuietMs ?? LIST_CHANGED_QUIET_MS,
      maxWaitMs: settings.listChangedMaxWaitMs ?? LIST_CHANGED_MAX_WAIT_MS,
      now: settings.now,
      timers: settings.timers,
      run: () => {
         try {
            for (const held of manager.list()) {
               syncOrEnd(held as McpSession, true);
            }
         } catch (cause) {
            // The timer callback must never throw: that would be an uncaught exception.
            log(`Wiretap sidecar | MCP tool list refresh failed: ${describeCause(cause)}`);
         }
      },
   });
   // Stops listening to registry and endpoint changes.
   const unsubscribe: () => void = bridge.subscribe(() => {
      if (manager.size() > 0) {
         debouncer.trigger();
      }
   });

   /**
    * Create a session's server and transport. The session is not held by the manager until its initialize succeeds.
    * @param {string} id - The new session id.
    * @param {EndpointKind | undefined} endpoint - The endpoint kind the session routes to.
    * @param {() => void} onInitialized - Called once the transport has accepted the initialize request.
    * @returns {McpSession} The session.
    */
   function createSession(id: string, endpoint: EndpointKind | undefined, onInitialized: () => void): McpSession {
      // Set while the session closes, so a transport close that the close itself causes does not close it again.
      let closing: boolean = false;
      const server: SessionMcpServer = buildServer(
         bridge,
         store,
         extraTools,
         instructions,
         id,
         () => manager.get(id) !== undefined,
      );
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
         sessionIdGenerator: () => id,
         onsessioninitialized: onInitialized,
      });
      const session: McpSession = {
         id,
         server,
         transport,
         endpoint,
         registered: new Map(),
         close: async () => {
            if (closing) {
               return;
            }
            closing = true;
            await server.close();
         },
      };
      // A transport closed from outside (the client's DELETE, a dropped connection) ends the session.
      server.server.onclose = () => {
         void manager.end(id);
      };
      try {
         syncRegistryTools(session, bridge.tools(routeOptions(endpoint)));
      } catch (cause) {
         // A half-built session is never held: the initialize fails and the session is dropped unreferenced.
         log(`Wiretap sidecar | MCP session ${id} could not start: ${describeCause(cause)}`);
         throw cause;
      }
      return session;
   }

   /**
    * Open a session for an initialize request and let its transport answer.
    * @param {http.IncomingMessage} req - The request.
    * @param {http.ServerResponse} res - The response.
    * @param {unknown} body - The parsed initialize body.
    * @param {EndpointKind | undefined} endpoint - The endpoint kind the session routes to.
    * @param {() => void} release - Gives back the session slot reserved for this initialize; called as soon as the
    *        manager holds the session (or refused it), so the slot is never counted twice.
    * @returns {Promise<void>} Resolves when the transport answered; rejects when the session could not be held, which
    *          makes the transport answer with an error status and no session id.
    */
   async function openSession(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      body: unknown,
      endpoint: EndpointKind | undefined,
      release: () => void,
   ): Promise<void> {
      // Whether the transport accepted the initialize and assigned the id.
      let initialized: boolean = false;
      const session: McpSession = createSession(randomUUID(), endpoint, () => {
         initialized = true;
         const held: boolean = manager.add(session);
         release();
         if (!held) {
            log(`Wiretap sidecar | MCP session ${session.id} refused: the session cap was reached`);
            throw new Error('the session cap was reached');
         }
         // The registry may have changed between creating the session and holding it, when no change reached it. A
         // failure ends the session and fails the initialize, so the client never keeps an id the server dropped.
         try {
            syncRegistryTools(session, bridge.tools(routeOptions(endpoint)));
         } catch (cause) {
            log(`Wiretap sidecar | MCP session ${session.id} tool sync failed, ending it: ${describeCause(cause)}`);
            void manager.end(session.id);
            throw cause;
         }
      });
      try {
         await session.server.connect(session.transport);
         await session.transport.handleRequest(req, res, body);
      } finally {
         if (!initialized) {
            await session.close();
         }
      }
   }

   /**
    * Route one request on `/mcp`.
    * @param {http.IncomingMessage} req - The request.
    * @param {http.ServerResponse} res - The response.
    * @param {URL} url - The parsed request URL.
    * @returns {Promise<void>} Resolves when the response was started or finished.
    */
   async function route(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
      // The session id the request names, if any.
      const id: string | undefined = sessionIdOf(req);
      if (id !== undefined) {
         // The session the id names; an unknown id is answered before any body is read.
         const session: McpSession | undefined = manager.get(id) as McpSession | undefined;
         if (session === undefined) {
            sendError(req, res, 404, -32001, 'Session not found');
            return;
         }
         manager.touch(id);
         // The parsed body of a POST.
         let body: unknown;
         if (req.method === 'POST') {
            const read: BodyResult = await readJsonBody(req, bodyMaxBytes);
            if (!read.ok) {
               refuseBody(req, res, read);
               return;
            }
            body = read.body;
         }
         await session.transport.handleRequest(req, res, body);
         return;
      }
      if (req.method !== 'POST') {
         sendError(req, res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
         return;
      }
      // The endpoint kind the new session routes to, from the `endpoint` query parameter.
      const choice: string | null = url.searchParams.get('endpoint');
      if (choice !== null && !ENDPOINT_KINDS.includes(choice)) {
         sendError(req, res, 400, -32000, `Bad Request: endpoint must be one of ${ENDPOINT_KINDS.join(', ')}`);
         return;
      }
      // Without a session id only an initialize may follow, so its (bounded) body is read to tell.
      const read: BodyResult = await readJsonBody(req, bodyMaxBytes);
      if (!read.ok) {
         refuseBody(req, res, read);
         return;
      }
      if (!isInitializeRequest(read.body)) {
         sendError(req, res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
         return;
      }
      if (manager.isFull(opening)) {
         // No held session is ended to make room: a flood of initialize requests must not end other clients' sessions.
         log(`Wiretap sidecar | MCP session cap of ${maxSessions} reached: initialize refused`);
         sendError(req, res, 503, -32000, 'Service Unavailable: too many MCP sessions', {
            'Retry-After': String(retryAfterSeconds),
         });
         return;
      }
      opening += 1;
      // Whether this initialize still holds its reserved slot.
      let reserved: boolean = true;
      const release = (): void => {
         if (reserved) {
            reserved = false;
            opening -= 1;
         }
      };
      try {
         await openSession(req, res, read.body, (choice ?? undefined) as EndpointKind | undefined, release);
      } finally {
         release();
      }
   }

   /**
    * Answer a request whose body could not be read: 413 for one over the limit (the rest of the body is read and
    * discarded, up to a bound, before the connection closes), 400 for one that does not parse.
    * @param {http.IncomingMessage} req - The request.
    * @param {http.ServerResponse} res - The response.
    * @param {BodyFailure} failure - The failed read.
    * @returns {void}
    */
   function refuseBody(req: http.IncomingMessage, res: http.ServerResponse, failure: BodyFailure): void {
      if (failure.tooLarge) {
         sendError(req, res, 413, -32600, 'Payload Too Large');
         return;
      }
      // A malformed body or a stream error mid-read becomes a clean 400.
      sendError(req, res, 400, -32700, 'Parse error');
   }

   // The number of requests in flight on each connection.
   const inFlight: WeakMap<net.Socket, number> = new WeakMap();
   // The loopback HTTP server that receives MCP requests.
   const httpServer: http.Server = http.createServer(
      {
         requestTimeout: limits.requestTimeoutMs ?? MCP_REQUEST_TIMEOUT_MS,
         headersTimeout: limits.headersTimeoutMs ?? MCP_HEADERS_TIMEOUT_MS,
         connectionsCheckingInterval: limits.timeoutCheckMs ?? MCP_TIMEOUT_CHECK_MS,
      },
      async (req, res) => {
         // This request is in flight until its response closes; the socket idle timeout ignores such a socket.
         inFlight.set(req.socket, (inFlight.get(req.socket) ?? 0) + 1);
         res.once('close', () => {
            inFlight.set(req.socket, (inFlight.get(req.socket) ?? 1) - 1);
         });
         // Origin and Host are checked before the method and path so no response differs for a hostile caller: a
         // browser page of another origin, or a DNS-rebinding page addressing this port under another name, gets 403.
         if (!isOriginAllowed(req.headers.origin) || !isMcpHostAllowed(req.headers.host, boundPort)) {
            rejectRequest(req, res, 403);
            return;
         }
         // The request URL; a path other than `/mcp` is not served.
         let url: URL;
         try {
            url = new URL(req.url ?? '/', 'http://127.0.0.1');
         } catch {
            rejectRequest(req, res, 400);
            return;
         }
         if (url.pathname !== '/mcp') {
            rejectRequest(req, res, 404);
            return;
         }
         if (req.method !== 'GET' && req.method !== 'POST' && req.method !== 'DELETE') {
            rejectRequest(req, res, 405, { Allow: 'GET, POST, DELETE' });
            return;
         }
         try {
            await route(req, res, url);
         } catch {
            // Surface an unexpected dispatch failure as a JSON-RPC internal error rather than hanging the client.
            sendError(req, res, 500, -32603, 'Internal error');
         }
      },
   );
   // Connections beyond the cap are closed at once, so idle sockets cannot exhaust file descriptors.
   httpServer.maxConnections = limits.maxConnections ?? MCP_CONNECTIONS_MAX;
   // A connection that sends no request within the idle limit is closed; one with a request in flight is left alone.
   // Node destroys a timed-out socket unless the server has a `timeout` listener, so this listener decides.
   httpServer.on('connection', (socket) => {
      socket.setTimeout(limits.socketIdleMs ?? MCP_SOCKET_IDLE_MS);
   });
   httpServer.on('timeout', (socket: net.Socket) => {
      if ((inFlight.get(socket) ?? 0) === 0) {
         socket.destroy();
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
      close: () => {
         debouncer.cancel();
         unsubscribe();
         manager.dispose();
         httpServer.close();
         // Open event streams and idle keep-alive connections would hold the port after the sessions are gone.
         httpServer.closeAllConnections();
      },
      ready,
      port: () => boundPort,
      sessions: () => manager.size(),
   };
}
