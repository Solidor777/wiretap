import { randomUUID } from 'node:crypto';
import {
   ENDPOINT_GONE,
   ENDPOINT_KINDS,
   ENDPOINT_LIMIT,
   ENDPOINT_TIMEOUT,
   ENDPOINT_UNAVAILABLE,
   NOT_GM,
   NO_ENDPOINT,
   OP_FAILED,
   PROTOCOL_MISMATCH,
   PROTOCOL_VERSION,
} from '../shared/protocol.js';
import { truncateUtf8 } from './utf8.ts';

/** The kind of a bridge endpoint: a person's browser tab or an agent-runner browser. */
export type EndpointKind = 'human' | 'agent';

/** A single validation failure reported by a Foundry client. */
export interface BridgeFailure {
   path: string;
   message: string;
}

/** Whether an endpoint answered its latest liveness probe; unresponsive endpoints are skipped by routing. */
export type EndpointHealth = 'healthy' | 'unresponsive';

/** The identity an endpoint announced in a valid identify. */
export interface EndpointIdentity {
   userId: string;
   userName: string;
   kind: EndpointKind;
   dom: boolean;
}

/** A registered bridge endpoint. */
export interface Endpoint extends EndpointIdentity {
   socketId: string;
   health: EndpointHealth;
   registeredAt: number;
}

/** The result of validating an identify payload. */
export type IdentifyResult =
   | { ok: true; identity: EndpointIdentity }
   | { ok: false; error: { code: string; message: string } };

/** Options of a single routed invocation. */
export interface InvokeOptions {
   endpoint?: EndpointKind;
}

/** The registry of identified GM endpoints. */
export interface EndpointRegistry {
   // Adds a new socket's endpoint as healthy, or updates an already-registered socket's identity while keeping its
   // health; returns false (registering nothing) when a new socket exceeds the limit.
   register: (socketId: string, identity: EndpointIdentity) => boolean;
   remove: (socketId: string) => void;
   // Lists every endpoint, unresponsive ones included, in registration order.
   list: () => Endpoint[];
   // Finds a socket's endpoint, or undefined when it is not registered.
   get: (socketId: string) => Endpoint | undefined;
   // Sets a registered socket's health; ignored for an unregistered socket.
   setHealth: (socketId: string, health: EndpointHealth) => void;
   // Finds the earliest-registered healthy endpoint of a kind.
   firstOfKind: (kind: EndpointKind) => Endpoint | undefined;
}

/** The router that picks an endpoint for an invocation and runs it, and probes endpoints that stop answering. */
export interface Router {
   invoke: (op: string, params: object, options?: InvokeOptions) => Promise<unknown>;
   // Stops probing a socket's endpoint; called when the socket disconnects.
   forget: (socketId: string) => void;
   // Stops every probe; the router starts no new one afterwards.
   dispose: () => void;
}

/** The interval timer functions the router uses to schedule probes. */
export interface RouterTimers {
   setInterval: (callback: () => void, ms: number) => unknown;
   clearInterval: (handle: unknown) => void;
}

/** The injectable collaborators of a router. */
export interface RouterDeps {
   // Emits the invoke payload to a socket and resolves with the raw ack. Rejects with an EndpointTimeoutError when no
   // ack arrives in time; any other rejection (EndpointGoneError included) means the endpoint is gone.
   send: (socketId: string, payload: { op: string; params: object; requestId: string }) => Promise<unknown>;
   // Sends a liveness probe to a socket and resolves when it acks; rejects when the ack does not arrive in time or the
   // socket cannot be written to.
   ping: (socketId: string) => Promise<void>;
   // Schedules the periodic probes of unresponsive endpoints (default: the global interval timers).
   timers?: RouterTimers;
   // Receives one sidecar log line.
   log: (line: string) => void;
   // Receives the endpoint-health log lines (failed pings, unresponsive and recovery transitions), which an endpoint
   // that never acks produces without bound; callers throttle it (default: `log`).
   logHealth?: (line: string) => void;
   // Produces the requestId of an invocation (default: a random UUID).
   newRequestId?: () => string;
}

// The default endpoint-kind preference: the first registered endpoint of the first kind that has one is chosen.
// An agent runner's own browser serves agent calls ahead of a person's tab, so an agent session never competes with
// the person for the tab they are using. This is the only place the order is defined; README.md documents it.
export const ROUTE_ORDER: readonly EndpointKind[] = ['agent', 'human'];

// Milliseconds between probes of an unresponsive endpoint: restores a recovered tab within seconds while a stuck tab
// receives at most 12 pings a minute.
const PROBE_INTERVAL_MS: number = 5_000;

// The ENDPOINT_TIMEOUT message. Hidden coupling: "10 s" is the ack window INVOKE_TIMEOUT_MS in foundryBridge.ts.
const TIMEOUT_MESSAGE: string =
   'Foundry did not respond in 10 s; the operation may still have applied. Check before retrying.';

// Maximum UTF-8 byte length of the ENDPOINT_UNAVAILABLE message.
const MAX_UNAVAILABLE_BYTES: number = 256;

// The global interval timers; looked up at call time so test fake timers installed later are honoured.
const DEFAULT_TIMERS: RouterTimers = {
   setInterval: (callback, ms) => setInterval(callback, ms),
   clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

// Maximum number of registered endpoints; an identify from a new socket beyond it is refused with ENDPOINT_LIMIT.
export const MAX_ENDPOINTS: number = 64;

// Maximum UTF-8 byte length of an identify `userId`.
const MAX_USER_ID_BYTES: number = 64;

// Maximum UTF-8 byte length of an identify `userName`.
const MAX_USER_NAME_BYTES: number = 128;

// Maximum UTF-8 byte length of an error message (and of each failure path and message).
const MAX_MESSAGE_BYTES: number = 512;

// Maximum UTF-8 byte length of the whole error text returned to an MCP caller.
const MAX_ERROR_TEXT_BYTES: number = 512;

// Maximum UTF-8 byte length of the NO_ENDPOINT message.
const MAX_NO_ENDPOINT_BYTES: number = 256;

// Maximum number of failures carried by a BridgeError.
const MAX_FAILURES: number = 10;

// Accepted shape of a client-supplied error code; bounds the code's size and charset.
const CLIENT_CODE_PATTERN: RegExp = /^[A-Z][A-Z0-9_]{0,63}$/;

// Protocol codes only the sidecar may produce; a client claiming one is reported as OP_FAILED so a client cannot
// impersonate a routing or registration outcome.
const RESERVED_CODES: ReadonlySet<string> = new Set([
   NO_ENDPOINT,
   ENDPOINT_TIMEOUT,
   ENDPOINT_GONE,
   ENDPOINT_LIMIT,
   ENDPOINT_UNAVAILABLE,
   PROTOCOL_MISMATCH,
   NOT_GM,
]);

/** The structured error every bridge failure is thrown as. */
export class BridgeError extends Error {
   code: string;
   failures?: BridgeFailure[];
   failureCount?: number;

   /**
    * Create a bridge error.
    * @param {string} code - The error code (one of the protocol error constants or a client code).
    * @param {string} message - The message, already within the byte limit.
    * @param {BridgeFailure[]} [failures] - Up to 10 validation failures.
    * @param {number} [failureCount] - The true failure total when `failures` is given.
    */
   constructor(code: string, message: string, failures?: BridgeFailure[], failureCount?: number) {
      super(message);
      this.name = 'BridgeError';
      this.code = code;
      if (failures !== undefined) {
         this.failures = failures;
         this.failureCount = failureCount ?? failures.length;
      }
   }
}

/** Thrown by a transport when the chosen endpoint disconnected or could not be written to before it acked. */
export class EndpointGoneError extends Error {
   /**
    * Create the error.
    * @param {string} cause - Why the endpoint is gone; written to the sidecar log, never returned to a caller.
    */
   constructor(cause: string) {
      super(cause);
      this.name = 'EndpointGoneError';
   }
}

/** Thrown by a transport when the chosen endpoint did not ack within the ack window. */
export class EndpointTimeoutError extends Error {
   /**
    * Create the error.
    * @param {string} cause - The transport's timeout description; written to the sidecar log, never returned.
    */
   constructor(cause: string) {
      super(cause);
      this.name = 'EndpointTimeoutError';
   }
}

/**
 * Create the endpoint registry. Entries keep insertion order, which is the tiebreak between endpoints of one kind.
 * @param {() => number} [now] - The clock used for `registeredAt` (default: `Date.now`).
 * @returns {EndpointRegistry} An empty registry.
 */
export function createEndpointRegistry(now: () => number = Date.now): EndpointRegistry {
   // Endpoints keyed by socket id; Map iteration order is insertion order and re-setting a key keeps its position.
   const endpoints: Map<string, Endpoint> = new Map();
   return {
      /**
       * Add an endpoint, or update the identity of the socket's existing entry (its registration time, position and
       * health are kept, so a client cannot clear an unresponsive state by identifying again; only a ping ack, through
       * `setHealth`, restores it). A new socket starts healthy and is refused when the registry already holds
       * `MAX_ENDPOINTS` endpoints.
       * @param {string} socketId - The socket id.
       * @param {EndpointIdentity} identity - The validated identity.
       * @returns {boolean} True when the endpoint is registered, false when the limit refused it.
       */
      register(socketId: string, identity: EndpointIdentity): boolean {
         const existing: Endpoint | undefined = endpoints.get(socketId);
         if (!existing && endpoints.size >= MAX_ENDPOINTS) {
            return false;
         }
         endpoints.set(socketId, {
            ...identity,
            socketId,
            health: existing?.health ?? 'healthy',
            registeredAt: existing?.registeredAt ?? now(),
         });
         return true;
      },

      /**
       * Remove a socket's endpoint, if any.
       * @param {string} socketId - The socket id.
       * @returns {void}
       */
      remove(socketId: string): void {
         endpoints.delete(socketId);
      },

      /**
       * List the endpoints in registration order.
       * @returns {Endpoint[]} A copy of the registered endpoints.
       */
      list(): Endpoint[] {
         return [...endpoints.values()];
      },

      /**
       * Find a socket's endpoint.
       * @param {string} socketId - The socket id.
       * @returns {Endpoint | undefined} The endpoint, or undefined when the socket is not registered.
       */
      get(socketId: string): Endpoint | undefined {
         return endpoints.get(socketId);
      },

      /**
       * Set a registered endpoint's health.
       * @param {string} socketId - The socket id; an unregistered socket is ignored.
       * @param {EndpointHealth} health - The new health.
       * @returns {void}
       */
      setHealth(socketId: string, health: EndpointHealth): void {
         const existing: Endpoint | undefined = endpoints.get(socketId);
         if (existing) {
            existing.health = health;
         }
      },

      /**
       * Find the earliest-registered healthy endpoint of a kind.
       * @param {EndpointKind} kind - The endpoint kind.
       * @returns {Endpoint | undefined} The endpoint, or undefined when no healthy endpoint of that kind is registered.
       */
      firstOfKind(kind: EndpointKind): Endpoint | undefined {
         return [...endpoints.values()].find((endpoint) => endpoint.kind === kind && endpoint.health === 'healthy');
      },
   };
}

/**
 * Validate a `bridge:identify` payload: protocol version 2, well-formed fields within the size limits (`userId` at most
 * 64 bytes, `userName` at most 128 bytes), and a GM user.
 * @param {unknown} payload - The payload received from the socket.
 * @returns {IdentifyResult} The identity to register, or the refusal (PROTOCOL_MISMATCH for a wrong version, a
 *          malformed field or an over-long field, NOT_GM for a non-GM user).
 */
export function validateIdentify(payload: unknown): IdentifyResult {
   const mismatch: IdentifyResult = {
      ok: false,
      error: {
         code: PROTOCOL_MISMATCH,
         message:
            `Wiretap bridge protocol ${PROTOCOL_VERSION} required: ` +
            'reload Foundry to load the current Wiretap client.',
      },
   };
   if (typeof payload !== 'object' || payload === null) {
      return mismatch;
   }
   // The untrusted payload viewed as a field map; each field is type-checked before use.
   const fields: Record<string, unknown> = payload as Record<string, unknown>;
   if (
      fields.protocolVersion !== PROTOCOL_VERSION ||
      typeof fields.userId !== 'string' ||
      typeof fields.userName !== 'string' ||
      typeof fields.isGM !== 'boolean' ||
      typeof fields.kind !== 'string' ||
      !ENDPOINT_KINDS.includes(fields.kind) ||
      typeof fields.dom !== 'boolean'
   ) {
      return mismatch;
   }
   if (
      Buffer.byteLength(fields.userId, 'utf8') > MAX_USER_ID_BYTES ||
      Buffer.byteLength(fields.userName, 'utf8') > MAX_USER_NAME_BYTES
   ) {
      return {
         ok: false,
         error: {
            code: PROTOCOL_MISMATCH,
            message: `Identify userId is limited to ${MAX_USER_ID_BYTES} bytes and userName to ${MAX_USER_NAME_BYTES}.`,
         },
      };
   }
   if (!fields.isGM) {
      return { ok: false, error: { code: NOT_GM, message: 'Only a GM client may register as a bridge endpoint.' } };
   }
   return {
      ok: true,
      identity: {
         userId: fields.userId,
         userName: fields.userName,
         kind: fields.kind as EndpointKind,
         dom: fields.dom,
      },
   };
}

/**
 * Normalize a client op ack that did not succeed into a BridgeError: `OP_FAILED` when the client gave no valid code or
 * a reserved protocol code, the message bounded to 512 bytes, at most 10 failures (each path and message bounded), and
 * `failureCount` carrying the true total.
 * @param {unknown} ack - The raw ack from the client.
 * @returns {BridgeError} The normalized error.
 */
export function normalizeAckError(ack: unknown): BridgeError {
   const raw: unknown = (ack as { error?: unknown } | undefined)?.error;
   const error: Record<string, unknown> =
      typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : { message: raw };
   const code: string =
      typeof error.code === 'string' && CLIENT_CODE_PATTERN.test(error.code) && !RESERVED_CODES.has(error.code)
         ? error.code
         : OP_FAILED;
   const text: string =
      typeof error.message === 'string' && error.message.length > 0 ? error.message : 'Foundry operation failed.';
   const message: string = truncateUtf8(text, MAX_MESSAGE_BYTES);
   if (!Array.isArray(error.failures)) {
      return new BridgeError(code, message);
   }
   const sent: unknown[] = error.failures;
   const failures: BridgeFailure[] = sent
      .filter(
         (entry): entry is BridgeFailure =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as BridgeFailure).path === 'string' &&
            typeof (entry as BridgeFailure).message === 'string',
      )
      .slice(0, MAX_FAILURES)
      .map((entry) => ({
         path: truncateUtf8(entry.path, MAX_MESSAGE_BYTES),
         message: truncateUtf8(entry.message, MAX_MESSAGE_BYTES),
      }));
   const reported: unknown = error.failureCount;
   const failureCount: number =
      typeof reported === 'number' && Number.isInteger(reported) && reported > sent.length ? reported : sent.length;
   return new BridgeError(code, message, failures, failureCount);
}

/**
 * Format a BridgeError as MCP tool-result text within 512 bytes: `<code>: <message>`, then as many `path: message`
 * failure lines (one per line) as fit, then ` (+N more)` counting every failure not shown.
 * @param {BridgeError} error - The error.
 * @returns {string} The text, at most 512 bytes of UTF-8.
 */
export function formatBridgeError(error: BridgeError): string {
   const failures: BridgeFailure[] = error.failures ?? [];
   // The true failure total, including failures the client reported but the error does not carry.
   const total: number = Math.max(error.failureCount ?? 0, failures.length);
   // Builds the ` (+N more)` suffix for `hidden` failures that are not shown (empty when none).
   const suffixFor = (hidden: number): string => (hidden > 0 ? ` (+${hidden} more)` : '');
   // The mandatory first line.
   const base: string = `${error.code}: ${error.message}`;
   // The text built so far.
   let text: string = base;
   // The number of failure lines already added.
   let shown: number = 0;
   for (const failure of failures) {
      const candidate: string = `${text}\n${failure.path}: ${failure.message}`;
      if (Buffer.byteLength(candidate + suffixFor(total - shown - 1), 'utf8') > MAX_ERROR_TEXT_BYTES) {
         break;
      }
      text = candidate;
      shown++;
   }
   const suffix: string = suffixFor(total - shown);
   if (Buffer.byteLength(text + suffix, 'utf8') > MAX_ERROR_TEXT_BYTES) {
      // Only reachable when no failure line was added and the message itself overflows the budget.
      return truncateUtf8(base, MAX_ERROR_TEXT_BYTES - Buffer.byteLength(suffix, 'utf8')) + suffix;
   }
   return text + suffix;
}

/**
 * Build the NO_ENDPOINT error for a request.
 * @param {EndpointKind} [kind] - The restricted kind when the call carried an `endpoint` override.
 * @returns {BridgeError} The error, its message bounded to 256 bytes.
 */
function noEndpoint(kind?: EndpointKind): BridgeError {
   const message: string =
      kind === undefined
         ? 'No Foundry GM endpoint is connected: open a GM tab in Foundry with Wiretap enabled, or enable an agent.'
         : `No '${kind}' GM endpoint is connected: ${
              kind === 'agent' ? 'enable an agent' : 'open a GM tab in Foundry with Wiretap enabled'
           }.`;
   return new BridgeError(NO_ENDPOINT, truncateUtf8(message, MAX_NO_ENDPOINT_BYTES));
}

/**
 * Build the ENDPOINT_UNAVAILABLE error for a request whose eligible endpoints are all unresponsive.
 * @param {EndpointKind} [kind] - The restricted kind when the call carried an `endpoint` override.
 * @returns {BridgeError} The error, its message bounded to 256 bytes.
 */
function endpointUnavailable(kind?: EndpointKind): BridgeError {
   const message: string = `Every ${
      kind === undefined ? 'connected' : `'${kind}'`
   } Foundry endpoint is unresponsive: reload the stuck Foundry tab or connect another endpoint.`;
   return new BridgeError(ENDPOINT_UNAVAILABLE, truncateUtf8(message, MAX_UNAVAILABLE_BYTES));
}

/**
 * Create the router over a registry. It picks the endpoint (default: `ROUTE_ORDER`; an `endpoint` option restricts
 * the choice to that kind with no fallback), sends the invocation through the injected transport and converts the
 * outcome into a result or a BridgeError. An ack timeout makes the router ping that endpoint: an acked ping leaves it
 * healthy (the operation was slow); a failed ping marks it unresponsive, so routing skips it, and probes it every
 * `PROBE_INTERVAL_MS` until a ping is acked. A call is sent once and never retried on another endpoint.
 * @param {EndpointRegistry} registry - The endpoint registry.
 * @param {RouterDeps} deps - The transport, ping, timers, logger and request-id source.
 * @returns {Router} The router.
 */
export function createRouter(registry: EndpointRegistry, deps: RouterDeps): Router {
   const newRequestId: () => string = deps.newRequestId ?? randomUUID;
   // The timers that schedule probes.
   const timers: RouterTimers = deps.timers ?? DEFAULT_TIMERS;
   // The sink of endpoint-health log lines.
   const logHealth: (line: string) => void = deps.logHealth ?? deps.log;
   // Interval handles of the running probes, keyed by socket id (at most one per endpoint).
   const probes: Map<string, unknown> = new Map();
   // Timeout checks in flight, keyed by socket id, so concurrent timeouts on one endpoint share one ping.
   const checks: Map<string, Promise<void>> = new Map();
   // Socket ids with a probe ping in flight; a tick skips an endpoint that is in this set.
   const probing: Set<string> = new Set();
   // Set by `dispose`; no probe starts afterwards.
   let disposed: boolean = false;

   /**
    * Ping an endpoint.
    * @param {string} socketId - The endpoint's socket id.
    * @returns {Promise<boolean>} True when the ping was acked, false on any ping failure (logged).
    */
   async function ping(socketId: string): Promise<boolean> {
      try {
         await deps.ping(socketId);
         return true;
      } catch (cause) {
         logHealth(
            `Wiretap sidecar | ping to ${socketId} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
         );
         return false;
      }
   }

   /**
    * Stop an endpoint's probe, if it has one.
    * @param {string} socketId - The endpoint's socket id.
    * @returns {void}
    */
   function stopProbe(socketId: string): void {
      if (probes.has(socketId)) {
         timers.clearInterval(probes.get(socketId));
         probes.delete(socketId);
      }
   }

   /**
    * Run one probe tick: ping an unresponsive endpoint and restore it when the ping is acked. A tick for an endpoint
    * that is gone or healthy again stops the probe; a tick while the previous ping is in flight does nothing.
    * @param {string} socketId - The endpoint's socket id.
    * @returns {Promise<void>} Resolves when the tick finished.
    */
   async function tick(socketId: string): Promise<void> {
      if (probing.has(socketId)) {
         return;
      }
      if (registry.get(socketId)?.health !== 'unresponsive') {
         stopProbe(socketId);
         return;
      }
      probing.add(socketId);
      try {
         if ((await ping(socketId)) && registry.get(socketId)) {
            registry.setHealth(socketId, 'healthy');
            stopProbe(socketId);
            logHealth(`Wiretap sidecar | endpoint ${socketId} responded to a probe and is healthy again`);
         }
      } finally {
         probing.delete(socketId);
      }
   }

   /**
    * Ping an endpoint whose invocation timed out: mark it unresponsive and start its probe when the ping fails.
    * @param {string} socketId - The endpoint's socket id.
    * @returns {Promise<void>} Resolves when the check finished; never rejects.
    */
   async function checkAfterTimeout(socketId: string): Promise<void> {
      if (disposed || registry.get(socketId)?.health !== 'healthy') {
         return;
      }
      if (await ping(socketId)) {
         logHealth(`Wiretap sidecar | endpoint ${socketId} answered a ping after a timeout: the operation was slow`);
         return;
      }
      if (disposed || !registry.get(socketId)) {
         return;
      }
      registry.setHealth(socketId, 'unresponsive');
      if (!probes.has(socketId)) {
         probes.set(
            socketId,
            timers.setInterval(() => {
               void tick(socketId);
            }, PROBE_INTERVAL_MS),
         );
      }
      logHealth(`Wiretap sidecar | endpoint ${socketId} is unresponsive; probing every ${PROBE_INTERVAL_MS} ms`);
   }

   /**
    * Run the timeout check of an endpoint, sharing one in-flight check between concurrent timeouts.
    * @param {string} socketId - The endpoint's socket id.
    * @returns {Promise<void>} Resolves when the check finished.
    */
   function check(socketId: string): Promise<void> {
      let running: Promise<void> | undefined = checks.get(socketId);
      if (!running) {
         running = checkAfterTimeout(socketId).finally(() => {
            checks.delete(socketId);
         });
         checks.set(socketId, running);
      }
      return running;
   }

   return {
      /**
       * Run an operation on a chosen endpoint.
       * @param {string} op - The operation name.
       * @param {object} params - The operation parameters.
       * @param {InvokeOptions} [options] - `endpoint` restricts the choice to one kind with no fallback.
       * @returns {Promise<unknown>} The operation result; rejects with a BridgeError (NO_ENDPOINT,
       *          ENDPOINT_UNAVAILABLE, ENDPOINT_GONE, ENDPOINT_TIMEOUT, or the normalized client failure).
       */
      async invoke(op: string, params: object, options: InvokeOptions = {}): Promise<unknown> {
         const kinds: readonly EndpointKind[] = options.endpoint === undefined ? ROUTE_ORDER : [options.endpoint];
         let endpoint: Endpoint | undefined;
         for (const kind of kinds) {
            endpoint = registry.firstOfKind(kind);
            if (endpoint) {
               break;
            }
         }
         if (!endpoint) {
            // No healthy endpoint of an eligible kind: unresponsive ones that are still connected make it UNAVAILABLE.
            const stuck: boolean = registry.list().some((candidate) => kinds.includes(candidate.kind));
            throw stuck ? endpointUnavailable(options.endpoint) : noEndpoint(options.endpoint);
         }
         const requestId: string = newRequestId();
         deps.log(
            `Wiretap sidecar | invoke ${op} requestId=${requestId} -> ${endpoint.kind} endpoint ${endpoint.socketId}`,
         );
         let ack: unknown;
         try {
            ack = await deps.send(endpoint.socketId, { op, params, requestId });
         } catch (cause) {
            if (cause instanceof EndpointTimeoutError) {
               deps.log(`Wiretap sidecar | invoke ${op} requestId=${requestId} timed out`);
               // The health check finishes before the error is thrown, so the next call already sees its outcome.
               await check(endpoint.socketId);
               throw new BridgeError(ENDPOINT_TIMEOUT, TIMEOUT_MESSAGE);
            }
            // Every non-timeout transport failure (a disconnect, a missing socket, a failed write) is a gone endpoint.
            deps.log(
               `Wiretap sidecar | invoke ${op} requestId=${requestId} endpoint gone: ${
                  cause instanceof Error ? cause.message : String(cause)
               }`,
            );
            throw new BridgeError(ENDPOINT_GONE, 'The Foundry endpoint disconnected before it answered.');
         }
         if ((ack as { ok?: unknown } | undefined)?.ok === true) {
            return (ack as { result?: unknown }).result;
         }
         const error: BridgeError = normalizeAckError(ack);
         deps.log(`Wiretap sidecar | invoke ${op} requestId=${requestId} failed: ${error.code}`);
         throw error;
      },

      /**
       * Stop probing a socket's endpoint (its socket disconnected).
       * @param {string} socketId - The socket id.
       * @returns {void}
       */
      forget(socketId: string): void {
         stopProbe(socketId);
      },

      /**
       * Stop every probe; no probe starts afterwards.
       * @returns {void}
       */
      dispose(): void {
         disposed = true;
         for (const socketId of [...probes.keys()]) {
            stopProbe(socketId);
         }
      },
   };
}
