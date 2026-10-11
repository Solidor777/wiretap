import type { Socket } from 'socket.io';
import { BRIDGE_IDENTIFY, BRIDGE_INVOKE, BRIDGE_PING, ENDPOINT_LIMIT } from '../shared/protocol.js';
import {
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

// Milliseconds to wait for a Foundry client to ack a bridge invocation before failing.
const INVOKE_TIMEOUT_MS: number = 10_000;

// Milliseconds to wait for a Foundry client to ack a liveness ping before the endpoint counts as unresponsive: a 1 s
// ping on loopback is far above normal event-loop latency yet keeps a timed-out caller's wait to at most 10 s + 1 s.
const PING_TIMEOUT_MS: number = 1_000;

// Length in milliseconds of the window that bounds refused-identify log lines.
const REFUSAL_LOG_WINDOW_MS: number = 60_000;

// Maximum refused-identify log lines inside one window, across all sockets.
const REFUSAL_LOG_LIMIT: number = 10;

// Length in milliseconds of the window that bounds endpoint-health log lines.
const HEALTH_LOG_WINDOW_MS: number = 60_000;

// Maximum endpoint-health log lines inside one window, across all endpoints.
const HEALTH_LOG_LIMIT: number = 10;

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
 * @returns {{ handleConnection: (socket: Socket) => void, invoke: Function, dispose: () => void }} The bridge with a
 *          per-socket connection handler, the router's `invoke(op, params, { endpoint? })`, and `dispose`, which stops
 *          every endpoint health probe.
 */
export function createFoundryBridge(options: FoundryBridgeOptions = {}): {
   handleConnection: (socket: Socket) => void;
   invoke: (op: string, params: object, options?: InvokeOptions) => Promise<unknown>;
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
   // Writes an endpoint-health log line subject to the per-window limit; a never-acking endpoint is probed every 5 s
   // and would otherwise log without bound.
   const logHealth: (line: string) => void = createLogThrottle({
      log,
      now,
      limit: HEALTH_LOG_LIMIT,
      windowMs: HEALTH_LOG_WINDOW_MS,
      noun: 'endpoint health lines',
   });
   // The registry of identified GM endpoints.
   const registry: EndpointRegistry = createEndpointRegistry();

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
      send: (socketId, payload) => emitWithAck(socketId, BRIDGE_INVOKE, INVOKE_TIMEOUT_MS, payload, true),
   });

   /**
    * Drop a socket's endpoint and stop its health probe.
    * @param {string} socketId - The socket id.
    * @returns {void}
    */
   function dropEndpoint(socketId: string): void {
      registry.remove(socketId);
      router.forget(socketId);
   }

   return {
      /**
       * Register per-socket bridge handlers: validate and register an endpoint on identify (acking the result after
       * registration), and on disconnect drop the endpoint, stop its health probe and fail its pending invocations
       * with ENDPOINT_GONE.
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
                  error: { code: ENDPOINT_LIMIT, message: 'Too many Foundry endpoints are registered.' },
               };
            }
            if (!result.ok) {
               // A refused identify also drops any earlier registration of this socket, so a stale GM entry cannot
               // outlive an identify that no longer qualifies.
               dropEndpoint(socket.id);
               logRefusal(`Wiretap sidecar | refused identify from ${socket.id}: ${result.error.code}`);
            }
            if (typeof ack === 'function') {
               ack(result.ok ? { ok: true } : { ok: false, error: result.error });
            }
         });
         socket.on('disconnect', () => {
            dropEndpoint(socket.id);
            sockets.delete(socket.id);
            for (const reject of pending.get(socket.id) ?? []) {
               reject(new EndpointGoneError(`socket ${socket.id} disconnected`));
            }
            pending.delete(socket.id);
         });
      },

      invoke: router.invoke,

      /**
       * Stop every endpoint health probe so no timer outlives the bridge.
       * @returns {void}
       */
      dispose(): void {
         router.dispose();
      },
   };
}
