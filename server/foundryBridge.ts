import type { Socket } from 'socket.io';
import {
   BRIDGE_BACKUP_PIECE,
   BRIDGE_GATE_STATE,
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   BRIDGE_PING,
   BRIDGE_REGISTRY,
   BRIDGE_RESTORE_PIECE,
   ENDPOINT_LIMIT,
   NOT_GM,
   OP_FAILED,
   PIECE_REFUSED,
} from '../shared/protocol.js';
import { getBudget } from '../shared/budgets.js';
import { BACKUP_PIECE_MAX_BYTES } from '../shared/backup.js';
import { defaultBridgeSettings, sanitizeBridgeSettings, type BridgeSettings } from '../shared/bridgeSettings.js';
import { closedGateState, sanitizeGateState, type GateState } from '../shared/gates.js';
import {
   BridgeError,
   CLIENT_CODE_PATTERN,
   EndpointGoneError,
   EndpointTimeoutError,
   createEndpointRegistry,
   createRouter,
   validateIdentify,
   type EndpointRegistry,
   type IdentifyResult,
   type InvokeOptions,
   type Router,
} from './endpoints.ts';
import { createLogThrottle } from './logThrottle.ts';
import { describeCause } from './logText.ts';
import { sanitizeRegistry, type RegistryOutcome, type RegistryTool } from './toolRegistry.ts';

// Milliseconds to wait for a Foundry client to ack a liveness ping before the endpoint counts as unresponsive: a 1 s
// ping on loopback is far above normal event-loop latency yet keeps a timed-out caller's wait to at most the call's
// reply wait (chosen by the router: 10 s, the call's `timeoutMs` + 2 s, or its `replyWaitMs`) + 1 s.
const PING_TIMEOUT_MS: number = 1_000;

// Length in milliseconds of the window that bounds refused-identify log lines.
const REFUSAL_LOG_WINDOW_MS: number = 60_000;

// Maximum refused-identify log lines inside one window, across all sockets.
const REFUSAL_LOG_LIMIT: number = 10;

// Length in milliseconds of the window that bounds refused-gate-state log lines.
const GATE_REFUSAL_LOG_WINDOW_MS: number = 60_000;

// Maximum refused-gate-state log lines inside one window, across all sockets.
const GATE_REFUSAL_LOG_LIMIT: number = 10;

// Length in milliseconds of the window that bounds refused-registry-socket log lines.
const REGISTRY_REFUSAL_LOG_WINDOW_MS: number = 60_000;

// Maximum refused-registry-socket log lines inside one window, across all sockets.
const REGISTRY_REFUSAL_LOG_LIMIT: number = 10;

// Length in milliseconds of the window that bounds registry tool-refusal log lines.
const REGISTRY_LINE_LOG_WINDOW_MS: number = 60_000;

// Maximum registry tool-refusal log lines inside one window, across all endpoints.
const REGISTRY_LINE_LOG_LIMIT: number = 10;

// Length in milliseconds of the window that bounds endpoint-health log lines.
const HEALTH_LOG_WINDOW_MS: number = 60_000;

// Maximum endpoint-health log lines inside one window, across all endpoints.
const HEALTH_LOG_LIMIT: number = 10;

// Length in milliseconds of the window that bounds backup-piece refusal log lines.
const PIECE_REFUSAL_LOG_WINDOW_MS: number = 60_000;

// Maximum backup-piece refusal log lines inside one window, across all sockets.
const PIECE_REFUSAL_LOG_LIMIT: number = 10;

// Longest piece `requestId`, in UTF-8 bytes; the router's requestIds are 36-character UUIDs.
const PIECE_REQUEST_ID_MAX_BYTES: number = 64;

// Largest piece `seq`, the largest 32-bit signed integer.
const PIECE_SEQ_MAX: number = 2 ** 31 - 1;

// Length of the window in which one socket may push at most `REGISTRY_PUSHES_PER_SECOND_MAX` registries, in ms.
const REGISTRY_PUSH_WINDOW_MS: number = 1000;

/** A validated backup piece handed to a sink: a data piece or the end marker of the stream. */
export interface IncomingPiece {
   seq: number;
   // The piece's bytes; present on a data piece only.
   data?: Buffer;
   // Present on the end marker only.
   end?: true;
   // The sender's piece count; present on the end marker only.
   pieces?: number;
   // The sender's byte total; present on the end marker only.
   bytes?: number;
}

/** The receiver of one invocation's backup pieces. */
export interface PieceSink {
   // Handles one piece; the bridge acks the piece when this settles, and a BridgeError it throws reaches the sender.
   piece(piece: IncomingPiece): void | Promise<void>;
   // Called once when the sending socket disconnects; the sink is then removed.
   gone(): void;
}

/** One restore piece sent to a GM client: a data piece or the end marker. */
export type OutgoingPiece =
   | { requestId: string; seq: number; data: Buffer }
   | { requestId: string; seq: number; end: true; pieces: number; bytes: number };

/** A registered sink and whether it is handling a piece. */
interface SinkEntry {
   sink: PieceSink;
   // True while `sink.piece` has not settled; a piece arriving then is refused.
   busy: boolean;
}

/**
 * Validate an untrusted `bridge:backupPiece` payload.
 * @param {unknown} payload - The payload received from the socket.
 * @returns {{ requestId: string, piece: IncomingPiece } | undefined} The requestId and the piece, or undefined when
 *          the payload is not a well-formed data piece or end marker.
 */
function readPiece(payload: unknown): { requestId: string; piece: IncomingPiece } | undefined {
   if (typeof payload !== 'object' || payload === null) {
      return undefined;
   }
   // The untrusted payload viewed as a field map; each field is type-checked before use.
   const fields: Record<string, unknown> = payload as Record<string, unknown>;
   // The fields of a piece, each still untrusted.
   const { requestId, seq, data, end, pieces, bytes }: Record<string, unknown> = fields;
   if (
      typeof requestId !== 'string' ||
      requestId.length === 0 ||
      Buffer.byteLength(requestId, 'utf8') > PIECE_REQUEST_ID_MAX_BYTES ||
      typeof seq !== 'number' ||
      !Number.isInteger(seq) ||
      seq < 0 ||
      seq > PIECE_SEQ_MAX
   ) {
      return undefined;
   }
   if (end === undefined) {
      if (!(data instanceof Uint8Array) || data.byteLength === 0 || data.byteLength > BACKUP_PIECE_MAX_BYTES) {
         return undefined;
      }
      return {
         requestId,
         piece: {
            seq,
            data: Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength),
         },
      };
   }
   if (
      end !== true ||
      data !== undefined ||
      typeof pieces !== 'number' ||
      !Number.isInteger(pieces) ||
      pieces < 0 ||
      typeof bytes !== 'number' ||
      !Number.isInteger(bytes) ||
      bytes < 0
   ) {
      return undefined;
   }
   return {
      requestId,
      piece: {
         seq,
         end: true,
         pieces,
         bytes,
      },
   };
}

/** The push-rate state of one socket's `bridge:registry` events. */
interface RegistryPushState {
   // When the current window began, in the bridge clock's milliseconds.
   windowStart: number;
   // Registries applied in the current window.
   applied: number;
   // The latest registry received past the limit, applied when the window ends.
   deferred?: { payload: unknown; ack: unknown };
   // The timer that applies the deferred registry.
   timer?: ReturnType<typeof setTimeout>;
}

/** The injectable collaborators of the bridge. */
export interface FoundryBridgeOptions {
   // Receives one sidecar log line (default: `console.log`).
   log?: (line: string) => void;
   // The clock the refusal-log throttle reads, in epoch milliseconds (default: `Date.now`).
   now?: () => number;
}

/**
 * Create the Foundry bridge: the endpoint registry fed by `bridge:identify`, and the router that forwards an
 * operation to the chosen endpoint and awaits its ack. Knows nothing about which operations exist — callers pass an
 * op name and params.
 * @param {FoundryBridgeOptions} [options] - Injectable logger and clock.
 * @returns {{ handleConnection: (socket: Socket) => void, invoke: Function, invokeTool: Function,
 *          gateState: Function, snapshot: Function, tools: Function, subscribe: Function, expectPieces: Function,
 *          sendPiece: Function, dispose: () => void }} The bridge with a per-socket connection handler, the router's
 *          `invoke(op, params, options?)`, the router's `invokeTool(name, args, { endpoint?, listed })` (a registry
 *          tool call that resolves the tool by name on the picked endpoint), the router's `gateState({ endpoint? })`
 *          (a copy of the risk-gate snapshot of the endpoint such a call would reach, every gate closed when none is
 *          eligible; never part of a tool result), the router's `snapshot({ endpoint? })` (copies of that endpoint's
 *          socket id, gate snapshot and settings, or undefined), the router's `tools({ endpoint? })` (the registered
 *          tools of that endpoint), `subscribe` (listener for endpoint-set, health and tool changes; returns its
 *          unsubscribe function), `expectPieces` (routes one socket's backup pieces of one requestId to a sink),
 *          `sendPiece` (sends one restore piece and awaits its ack), and `dispose`, which stops every endpoint health
 *          probe.
 */
export function createFoundryBridge(options: FoundryBridgeOptions = {}): {
   handleConnection: (socket: Socket) => void;
   invoke: (op: string, params: object, options?: InvokeOptions) => Promise<unknown>;
   invokeTool: Router['invokeTool'];
   gateState: (options?: InvokeOptions) => GateState;
   snapshot: Router['snapshot'];
   tools: (options?: InvokeOptions) => RegistryTool[];
   subscribe: (listener: () => void) => () => void;
   expectPieces: (socketId: string, requestId: string, sink: PieceSink) => () => void;
   sendPiece: (socketId: string, piece: OutgoingPiece, timeoutMs: number) => Promise<void>;
   dispose: () => void;
} {
   // The sidecar log sink.
   const log: (line: string) => void = options.log ?? ((line) => console.log(line));
   // The clock read by the refusal-log throttle.
   const now: () => number = options.now ?? Date.now;
   // Connected sockets keyed by socket id, so the router can emit to a registered endpoint.
   const sockets: Map<string, Socket> = new Map();
   // Rejectors of the invocations awaiting an ack, keyed by socket id, so a disconnect fails them at once.
   const pending: Map<string, Set<(reason: Error) => void>> = new Map();
   // Writes a refused-identify log line subject to the per-window limit, with one summary line per window.
   const logRefusal: (line: string) => void = createLogThrottle({
      log,
      now,
      limit: REFUSAL_LOG_LIMIT,
      windowMs: REFUSAL_LOG_WINDOW_MS,
      noun: 'identify refusals',
   });
   // Writes a refused-gate-state log line subject to the per-window limit, with one summary line per window.
   const logGateRefusal: (line: string) => void = createLogThrottle({
      log,
      now,
      limit: GATE_REFUSAL_LOG_LIMIT,
      windowMs: GATE_REFUSAL_LOG_WINDOW_MS,
      noun: 'gate state refusals',
   });
   // Writes a refused-registry-socket log line subject to the per-window limit, with one summary line per window.
   const logRegistryRefusal: (line: string) => void = createLogThrottle({
      log,
      now,
      limit: REGISTRY_REFUSAL_LOG_LIMIT,
      windowMs: REGISTRY_REFUSAL_LOG_WINDOW_MS,
      noun: 'registry socket refusals',
   });
   // Writes a registry tool-refusal log line subject to the per-window limit; a hostile endpoint can send entries
   // without bound, each refused with its own reason.
   const logRegistryLine: (line: string) => void = createLogThrottle({
      log,
      now,
      limit: REGISTRY_LINE_LOG_LIMIT,
      windowMs: REGISTRY_LINE_LOG_WINDOW_MS,
      noun: 'registry refusal lines',
   });
   // Writes an endpoint-health log line subject to the per-window limit; a never-acking endpoint is probed every 5 s
   // and would otherwise log without bound.
   const logHealth: (line: string) => void = createLogThrottle({
      log,
      now,
      limit: HEALTH_LOG_LIMIT,
      windowMs: HEALTH_LOG_WINDOW_MS,
      noun: 'endpoint health lines',
   });
   // Writes a backup-piece refusal log line subject to the per-window limit; any connected socket can send pieces
   // without bound.
   const logPieceRefusal: (line: string) => void = createLogThrottle({
      log,
      now,
      limit: PIECE_REFUSAL_LOG_LIMIT,
      windowMs: PIECE_REFUSAL_LOG_WINDOW_MS,
      noun: 'backup piece refusals',
   });
   // The registry of identified GM endpoints.
   const registry: EndpointRegistry = createEndpointRegistry();
   // The sinks waiting for backup pieces, keyed by socket id and then by requestId.
   const sinks: Map<string, Map<string, SinkEntry>> = new Map();

   /**
    * Emit an event to a registered socket and resolve with its ack. Rejects with an EndpointGoneError when the socket
    * is missing or the write throws, and with an EndpointTimeoutError when no ack arrives within the window. When
    * `track` is set, a disconnect of the socket also rejects the call (through `pending`).
    * @param {string} socketId - The endpoint's socket id.
    * @param {string} event - The event name.
    * @param {number} timeoutMs - The ack window in milliseconds.
    * @param {object | undefined} payload - The event payload, or undefined for an event with none.
    * @param {boolean} track - Whether a disconnect of the socket fails the call at once.
    * @returns {Promise<unknown>} The ack value.
    */
   function emitWithAck(
      socketId: string,
      event: string,
      timeoutMs: number,
      payload: object | undefined,
      track: boolean,
   ): Promise<unknown> {
      return new Promise((resolve, reject) => {
         // The endpoint's socket, absent when it already disconnected.
         const socket: Socket | undefined = sockets.get(socketId);
         if (!socket) {
            reject(new EndpointGoneError('Endpoint socket is gone.'));
            return;
         }
         // This socket's pending-invocation rejectors; tracked calls register theirs so a disconnect can fail them.
         const waiting: Set<(reason: Error) => void> = pending.get(socketId) ?? new Set();
         if (track) {
            pending.set(socketId, waiting);
            waiting.add(reject);
         }
         // The emit arguments: the optional payload followed by the ack callback.
         const args: unknown[] = payload === undefined ? [] : [payload];
         try {
            socket.timeout(timeoutMs).emit(event, ...args, (err: unknown, ack: unknown) => {
               waiting.delete(reject);
               if (err) {
                  // Socket.IO's timeout wrapper passes its timeout error as the first ack argument.
                  reject(new EndpointTimeoutError(err instanceof Error ? err.message : String(err)));
               } else {
                  resolve(ack);
               }
            });
         } catch (cause) {
            waiting.delete(reject);
            reject(new EndpointGoneError(cause instanceof Error ? cause.message : String(cause)));
         }
      });
   }

   // The router that picks an endpoint and runs an invocation through the socket transport.
   const router: Router = createRouter(registry, {
      log,
      logHealth,
      ping: async (socketId) => {
         await emitWithAck(socketId, BRIDGE_PING, PING_TIMEOUT_MS, undefined, false);
      },
      send: (socketId, payload, timeoutMs) => emitWithAck(socketId, BRIDGE_INVOKE, timeoutMs, payload, true),
   });

   /**
    * Answer an ack callback when there is one; a callback that throws is ignored, since the endpoint's state is
    * already decided.
    * @param {unknown} ack - The callback the client passed, if any.
    * @param {object} value - The ack value.
    * @returns {void}
    */
   function reply(ack: unknown, value: object): void {
      try {
         if (typeof ack === 'function') {
            ack(value);
         }
      } catch {
         // The sender's ack callback failed; nothing more can be done for it.
      }
   }

   /**
    * Apply a `bridge:registry` payload (`{ apiVersion, scripts }`) to a registered endpoint and ack the outcome. A
    * payload that is not a registry object of the current api version, or one whose processing throws, clears the
    * endpoint's tools (fail closed) and acks OP_FAILED.
    * @param {Socket} socket - The sending socket.
    * @param {unknown} payload - The untrusted payload.
    * @param {unknown} ack - The ack callback, if any.
    * @returns {void}
    */
   function applyRegistry(socket: Socket, payload: unknown, ack: unknown): void {
      if (registry.get(socket.id) === undefined) {
         logRegistryRefusal(`Wiretap sidecar | refused registry from ${socket.id}: ${NOT_GM}`);
         reply(ack, {
            ok: false,
            error: {
               code: NOT_GM,
               message: 'Only a registered GM endpoint may push a registry.',
            },
         });
         return;
      }
      try {
         const outcome: RegistryOutcome = sanitizeRegistry(payload, logRegistryLine);
         if (!outcome.ok) {
            registry.setTools(socket.id, []);
            logRegistryLine(`Wiretap sidecar | registry payload from ${socket.id} refused: ${outcome.reason}`);
            reply(ack, {
               ok: false,
               error: {
                  code: OP_FAILED,
                  message: outcome.reason,
               },
            });
            return;
         }
         registry.setTools(socket.id, outcome.tools);
         reply(ack, {
            ok: true,
            accepted: outcome.tools.length,
            refused: outcome.refused,
         });
      } catch (cause) {
         registry.setTools(socket.id, []);
         logRegistryLine(`Wiretap sidecar | registry from ${socket.id} failed: ${describeCause(cause)}`);
         reply(ack, {
            ok: false,
            error: {
               code: OP_FAILED,
               message: 'The registry could not be applied; the endpoint has no tools.',
            },
         });
      }
   }

   // The push-rate state of each socket that has pushed a registry, keyed by socket id.
   const pushStates: Map<string, RegistryPushState> = new Map();

   /**
    * Cancel a socket's deferred registry and forget its push-rate state.
    * @param {string} socketId - The socket id.
    * @returns {void}
    */
   function forgetPushState(socketId: string): void {
      const state: RegistryPushState | undefined = pushStates.get(socketId);
      if (state?.timer !== undefined) {
         clearTimeout(state.timer);
      }
      pushStates.delete(socketId);
   }

   /**
    * Apply a `bridge:registry` push subject to the per-socket rate limit. Up to `REGISTRY_PUSHES_PER_SECOND_MAX`
    * pushes per window apply at once; a later push replaces the deferred one (the replaced push is acked
    * `{ ok: true, coalesced: true }`) and the latest is applied when the window ends. A push from a socket that is not
    * a registered endpoint is refused by `applyRegistry` at once and never deferred. The limit bounds the conversion
    * work a hostile endpoint can cause, since each applied push re-validates the whole registry.
    * @param {Socket} socket - The sending socket.
    * @param {unknown} payload - The untrusted payload.
    * @param {unknown} ack - The ack callback, if any.
    * @returns {void}
    */
   function pushRegistry(socket: Socket, payload: unknown, ack: unknown): void {
      if (registry.get(socket.id) === undefined) {
         applyRegistry(socket, payload, ack);
         return;
      }
      // The current time on the bridge clock.
      const at: number = now();
      let state: RegistryPushState | undefined = pushStates.get(socket.id);
      if (state === undefined) {
         state = {
            windowStart: at,
            applied: 0,
         };
         pushStates.set(socket.id, state);
      }
      if (at - state.windowStart >= REGISTRY_PUSH_WINDOW_MS && state.deferred === undefined) {
         state.windowStart = at;
         state.applied = 0;
      }
      if (state.applied < getBudget('REGISTRY_PUSHES_PER_SECOND_MAX').value && state.deferred === undefined) {
         state.applied += 1;
         applyRegistry(socket, payload, ack);
         return;
      }
      if (state.deferred !== undefined) {
         reply(state.deferred.ack, {
            ok: true,
            coalesced: true,
         });
      }
      state.deferred = {
         payload,
         ack,
      };
      if (state.timer === undefined) {
         // The state object this timer applies; the timer is cleared before the state is dropped.
         const owner: RegistryPushState = state;
         state.timer = setTimeout(
            () => {
               owner.timer = undefined;
               // The registry that waited out the window.
               const waiting: { payload: unknown; ack: unknown } | undefined = owner.deferred;
               owner.deferred = undefined;
               owner.windowStart = now();
               owner.applied = 1;
               if (waiting !== undefined && sockets.has(socket.id)) {
                  applyRegistry(socket, waiting.payload, waiting.ack);
               }
            },
            Math.max(0, state.windowStart + REGISTRY_PUSH_WINDOW_MS - at),
         );
         state.timer.unref?.();
      }
   }

   /**
    * Refuse a backup piece: log the reason through the throttle and ack PIECE_REFUSED.
    * @param {Socket} socket - The sending socket.
    * @param {unknown} ack - The ack callback, if any.
    * @param {string} message - The refusal message sent to the client.
    * @returns {void}
    */
   function refusePiece(socket: Socket, ack: unknown, message: string): void {
      logPieceRefusal(`Wiretap sidecar | refused backup piece from ${socket.id}: ${message}`);
      reply(ack, {
         ok: false,
         error: {
            code: PIECE_REFUSED,
            message,
         },
      });
   }

   /**
    * Hand a `bridge:backupPiece` payload to the sink of its socket and requestId and ack the outcome: ok once the sink
    * has handled it, the sink's BridgeError as is, and PIECE_REFUSED for a malformed piece, a piece nobody expects, a
    * piece that arrives while the sink still handles the previous one, and any other sink failure (logged).
    * @param {Socket} socket - The sending socket.
    * @param {unknown} payload - The untrusted payload.
    * @param {unknown} ack - The ack callback, if any.
    * @returns {Promise<void>} Resolves once the piece is acked; never rejects.
    */
   async function receivePiece(socket: Socket, payload: unknown, ack: unknown): Promise<void> {
      // The validated piece, or undefined for a malformed payload.
      const read: { requestId: string; piece: IncomingPiece } | undefined = readPiece(payload);
      if (read === undefined) {
         refusePiece(socket, ack, 'Malformed backup piece.');
         return;
      }
      // The sink waiting for this socket's pieces of this requestId.
      const entry: SinkEntry | undefined = sinks.get(socket.id)?.get(read.requestId);
      if (entry === undefined) {
         refusePiece(socket, ack, 'No backup is waiting for this piece.');
         return;
      }
      if (entry.busy) {
         refusePiece(socket, ack, 'A backup piece is already being written.');
         return;
      }
      entry.busy = true;
      try {
         await entry.sink.piece(read.piece);
         reply(ack, { ok: true });
      } catch (cause) {
         if (cause instanceof BridgeError) {
            logPieceRefusal(`Wiretap sidecar | backup piece from ${socket.id} refused by its sink: ${cause.code}`);
            reply(ack, {
               ok: false,
               error: {
                  code: cause.code,
                  message: cause.message,
               },
            });
         } else {
            logPieceRefusal(`Wiretap sidecar | backup piece from ${socket.id} failed: ${describeCause(cause)}`);
            reply(ack, {
               ok: false,
               error: {
                  code: PIECE_REFUSED,
                  message: 'The backup piece could not be written.',
               },
            });
         }
      } finally {
         entry.busy = false;
      }
   }

   /**
    * Tell every sink of a socket that it is gone and remove them.
    * @param {string} socketId - The disconnected socket's id.
    * @returns {void}
    */
   function dropSinks(socketId: string): void {
      // The socket's sinks, removed before they are told so a sink cannot see itself still registered.
      const entries: Map<string, SinkEntry> | undefined = sinks.get(socketId);
      sinks.delete(socketId);
      for (const entry of entries?.values() ?? []) {
         entry.sink.gone();
      }
   }

   /**
    * Drop a socket's endpoint and stop its health probe.
    * @param {string} socketId - The socket id.
    * @returns {void}
    */
   function dropEndpoint(socketId: string): void {
      registry.remove(socketId);
      router.forget(socketId);
      forgetPushState(socketId);
   }

   return {
      /**
       * Register per-socket bridge handlers: validate and register an endpoint on identify (acking the result after
       * registration), apply a registered endpoint's `bridge:gateState` push `{ gateState, settings }` (both
       * sanitized; a push without `gateState` closes every gate; a non-registered socket is refused with NOT_GM,
       * logged through a throttle, and changes nothing), hand `bridge:backupPiece` pieces to their sinks, and on
       * disconnect drop the endpoint, stop its health probe, tell its sinks they are gone and fail its pending
       * invocations with ENDPOINT_GONE. Also applies a registered endpoint's `bridge:registry` script list (validated
       * and bounded; any other socket is refused with NOT_GM).
       * @param {Socket} socket - The connected Socket.IO socket.
       * @returns {void}
       */
      handleConnection(socket: Socket): void {
         sockets.set(socket.id, socket);
         socket.on(BRIDGE_IDENTIFY, (payload: unknown, ack?: unknown) => {
            // The validation outcome, replaced by an ENDPOINT_LIMIT refusal when the registry is full.
            let result: IdentifyResult = validateIdentify(payload);
            if (result.ok && !registry.register(socket.id, result.identity)) {
               result = {
                  ok: false,
                  error: {
                     code: ENDPOINT_LIMIT,
                     message: 'Too many Foundry endpoints are registered.',
                  },
               };
            }
            if (!result.ok) {
               // A refused identify also drops any earlier registration of this socket, so a stale GM entry cannot
               // outlive an identify that no longer qualifies.
               dropEndpoint(socket.id);
               logRefusal(`Wiretap sidecar | refused identify from ${socket.id}: ${result.error.code}`);
            }
            if (typeof ack === 'function') {
               ack(
                  result.ok
                     ? { ok: true }
                     : {
                          ok: false,
                          error: result.error,
                       },
               );
            }
         });
         socket.on(BRIDGE_GATE_STATE, (payload: unknown, ack?: unknown) => {
            try {
               // Only a socket that holds a live GM registration may set a snapshot; it is stored per endpoint.
               const registered: boolean = registry.get(socket.id) !== undefined;
               if (registered) {
                  // The push viewed as its two fields; a bare snapshot has no `gateState` and closes every gate.
                  const push: { gateState?: unknown; settings?: unknown } | undefined | null = payload as
                     | { gateState?: unknown; settings?: unknown }
                     | undefined
                     | null;
                  // The pushed snapshot; both values are read before either is stored, so a failing read stores
                  // neither.
                  const gateState: GateState = sanitizeGateState(push?.gateState);
                  // The pushed settings.
                  const settings: BridgeSettings = sanitizeBridgeSettings(push?.settings);
                  registry.setGateState(socket.id, gateState);
                  registry.setSettings(socket.id, settings);
               } else {
                  logGateRefusal(`Wiretap sidecar | refused gate state from ${socket.id}: ${NOT_GM}`);
               }
               if (typeof ack === 'function') {
                  ack(
                     registered
                        ? { ok: true }
                        : {
                             ok: false,
                             error: {
                                code: NOT_GM,
                                message: 'Only a registered GM endpoint may push a gate state.',
                             },
                          },
                  );
               }
            } catch (cause) {
               // Fail closed: whatever threw, this endpoint's gates are all closed, its settings are the defaults and
               // the sender is told.
               registry.setGateState(socket.id, closedGateState());
               registry.setSettings(socket.id, defaultBridgeSettings());
               log(`Wiretap sidecar | gate state from ${socket.id} failed: ${describeCause(cause)}`);
               try {
                  if (typeof ack === 'function') {
                     ack({
                        ok: false,
                        error: {
                           code: OP_FAILED,
                           message: 'Gate state could not be applied; every gate is closed.',
                        },
                     });
                  }
               } catch {
                  // The sender's ack callback failed twice; the endpoint is already closed, so nothing more is done.
               }
            }
         });
         socket.on(BRIDGE_REGISTRY, (payload: unknown, ack?: unknown) => {
            pushRegistry(socket, payload, ack);
         });
         socket.on(BRIDGE_BACKUP_PIECE, (payload: unknown, ack?: unknown) => {
            void receivePiece(socket, payload, ack);
         });
         socket.on('disconnect', () => {
            dropEndpoint(socket.id);
            dropSinks(socket.id);
            sockets.delete(socket.id);
            for (const reject of pending.get(socket.id) ?? []) {
               reject(new EndpointGoneError(`socket ${socket.id} disconnected`));
            }
            pending.delete(socket.id);
         });
      },

      invoke: router.invoke,

      invokeTool: router.invokeTool,

      gateState: router.gateState,

      snapshot: router.snapshot,

      tools: router.tools,

      subscribe: registry.subscribe,

      /**
       * Route the backup pieces one socket sends for one requestId to a sink, until the returned function is called
       * or the socket disconnects (the sink is then told with `gone()`). A later call for the same socket and
       * requestId replaces the sink.
       * @param {string} socketId - The socket the pieces come from.
       * @param {string} requestId - The requestId of the invocation that produces them.
       * @param {PieceSink} sink - The receiver of the pieces.
       * @returns {() => void} Removes this sink; calling it again, or after a replacement, changes nothing.
       */
      expectPieces(socketId: string, requestId: string, sink: PieceSink): () => void {
         // This socket's sinks by requestId.
         const bySocket: Map<string, SinkEntry> = sinks.get(socketId) ?? new Map();
         sinks.set(socketId, bySocket);
         // The entry this call registers; the remover deletes only this entry.
         const entry: SinkEntry = {
            sink,
            busy: false,
         };
         bySocket.set(requestId, entry);
         return () => {
            // The socket's current sinks; a disconnect may already have removed them.
            const current: Map<string, SinkEntry> | undefined = sinks.get(socketId);
            if (current?.get(requestId) === entry) {
               current.delete(requestId);
               if (current.size === 0) {
                  sinks.delete(socketId);
               }
            }
         };
      },

      /**
       * Send one restore piece to a GM client and wait for its ack.
       * @param {string} socketId - The endpoint's socket id.
       * @param {OutgoingPiece} piece - The piece.
       * @param {number} timeoutMs - The ack window in milliseconds.
       * @returns {Promise<void>} Resolves on an ok ack; rejects with a PIECE_REFUSED BridgeError naming the client's
       *          code (OP_FAILED when it gave no valid one) on a refusal, with an EndpointGoneError when the socket is
       *          gone or disconnects first, and with an EndpointTimeoutError when no ack arrives in time.
       */
      async sendPiece(socketId: string, piece: OutgoingPiece, timeoutMs: number): Promise<void> {
         // The client's answer to the piece.
         const ack: unknown = await emitWithAck(socketId, BRIDGE_RESTORE_PIECE, timeoutMs, piece, true);
         if ((ack as { ok?: unknown } | undefined)?.ok === true) {
            return;
         }
         // The code the client gave, trusted only within the client code pattern.
         const claimed: unknown = (ack as { error?: { code?: unknown } } | undefined)?.error?.code;
         const code: string = typeof claimed === 'string' && CLIENT_CODE_PATTERN.test(claimed) ? claimed : OP_FAILED;
         throw new BridgeError(PIECE_REFUSED, `The Foundry client refused a restore piece: ${code}.`);
      },

      /**
       * Stop every endpoint health probe so no timer outlives the bridge.
       * @returns {void}
       */
      dispose(): void {
         for (const socketId of [...pushStates.keys()]) {
            forgetPushState(socketId);
         }
         router.dispose();
      },
   };
}
