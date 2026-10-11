import type { Socket } from 'socket.io';
import { BRIDGE_IDENTIFY, BRIDGE_INVOKE, ENDPOINT_LIMIT } from '../shared/protocol.js';
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

// Length in milliseconds of the window that bounds refused-identify log lines.
const REFUSAL_LOG_WINDOW_MS: number = 60_000;

// Maximum refused-identify log lines inside one window, across all sockets.
const REFUSAL_LOG_LIMIT: number = 10;

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
 * @returns {{ handleConnection: (socket: Socket) => void, invoke: Function }} The bridge with a per-socket connection
 *          handler and the router's `invoke(op, params, { endpoint? })`.
 */
export function createFoundryBridge(options: FoundryBridgeOptions = {}): {
   handleConnection: (socket: Socket) => void;
   invoke: (op: string, params: object, options?: InvokeOptions) => Promise<unknown>;
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
   // The registry of identified GM endpoints.
   const registry: EndpointRegistry = createEndpointRegistry();
   // The router that picks an endpoint and runs an invocation through the socket transport.
   const router: Router = createRouter(registry, {
      log,
      send: (socketId, payload) =>
         new Promise((resolve, reject) => {
            // The endpoint's socket, absent when it already disconnected.
            const socket: Socket | undefined = sockets.get(socketId);
            if (!socket) {
               reject(new EndpointGoneError('Endpoint socket is gone.'));
               return;
            }
            // This socket's pending-invocation rejectors.
            const waiting: Set<(reason: Error) => void> = pending.get(socketId) ?? new Set();
            pending.set(socketId, waiting);
            // Stops tracking this invocation once it settles.
            const settle = (): void => {
               waiting.delete(reject);
            };
            waiting.add(reject);
            try {
               socket.timeout(INVOKE_TIMEOUT_MS).emit(BRIDGE_INVOKE, payload, (err: unknown, ack: unknown) => {
                  settle();
                  if (err) {
                     // Socket.IO's timeout wrapper passes its timeout error as the first ack argument.
                     reject(new EndpointTimeoutError(err instanceof Error ? err.message : String(err)));
                  } else {
                     resolve(ack);
                  }
               });
            } catch (cause) {
               settle();
               reject(new EndpointGoneError(cause instanceof Error ? cause.message : String(cause)));
            }
         }),
   });

   return {
      /**
       * Register per-socket bridge handlers: validate and register an endpoint on identify (acking the result after
       * registration), and on disconnect drop the endpoint and fail its pending invocations with ENDPOINT_GONE.
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
               registry.remove(socket.id);
               logRefusal(`Wiretap sidecar | refused identify from ${socket.id}: ${result.error.code}`);
            }
            if (typeof ack === 'function') {
               ack(result.ok ? { ok: true } : { ok: false, error: result.error });
            }
         });
         socket.on('disconnect', () => {
            registry.remove(socket.id);
            sockets.delete(socket.id);
            for (const reject of pending.get(socket.id) ?? []) {
               reject(new EndpointGoneError(`socket ${socket.id} disconnected`));
            }
            pending.delete(socket.id);
         });
      },

      invoke: router.invoke,
   };
}
