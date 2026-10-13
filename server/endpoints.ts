import { randomUUID } from 'node:crypto';
import {
   ENDPOINT_GONE,
   ENDPOINT_KINDS,
   ENDPOINT_LIMIT,
   ENDPOINT_TIMEOUT,
   ENDPOINT_UNAVAILABLE,
   NOT_GM,
   NO_ENDPOINT,
   GATE_DENIED,
   OP_FAILED,
   PROTOCOL_MISMATCH,
   OP_CALL_TOOL,
   PROTOCOL_VERSION,
   TOOL_GONE,
} from '../shared/protocol.js';
import { closedGateState, gateDenial, sanitizeGateState, type GateState } from '../shared/gates.js';
import type { RegistryTool } from './toolRegistry.ts';
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
   // The sanitized risk-gate snapshot; every gate closed when the identify carried none or an invalid one.
   gateState: GateState;
}

/** A registered bridge endpoint. */
export interface Endpoint extends EndpointIdentity {
   socketId: string;
   health: EndpointHealth;
   registeredAt: number;
   // The tools the endpoint registered with `bridge:registry` (sanitized); empty until it registers any.
   tools: RegistryTool[];
}

/** The result of validating an identify payload. */
export type IdentifyResult =
   | { ok: true; identity: EndpointIdentity }
   | { ok: false; error: { code: string; message: string } };

/** A risk gate an invocation requires, judged against the snapshot of the endpoint that will run it. */
export interface RequiredGate {
   // The registry name of the gate (see `shared/gates.js`).
   gate: string;
   // The plugin module id, required for the `allowedPluginModules` gate.
   moduleId?: string;
}

/** Options of a single routed invocation. */
export interface InvokeOptions {
   endpoint?: EndpointKind;
   // When set, the picked endpoint's own gate snapshot must open this gate, else the call fails with GATE_DENIED
   // before anything is sent. Pick, gate check and send are one atomic step on one endpoint.
   requireGate?: RequiredGate;
}

/** Options of a routed call to a registry tool. */
export interface ToolInvokeOptions {
   // Restricts the choice to one endpoint kind, with no fallback.
   endpoint?: EndpointKind;
   // The definition the caller listed to its client; the picked endpoint's own declaration must match its gate.
   listed: RegistryTool;
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
   // Replaces a registered socket's gate snapshot (already sanitized); ignored for an unregistered socket.
   setGateState: (socketId: string, gateState: GateState) => void;
   // Finds the earliest-registered healthy endpoint of a kind; with `dom: true` only endpoints that identified as able
   // to run DOM scripts qualify.
   firstOfKind: (kind: EndpointKind, options?: { dom?: boolean }) => Endpoint | undefined;
   // Replaces a registered socket's tools (already sanitized); ignored for an unregistered socket.
   setTools: (socketId: string, tools: RegistryTool[]) => void;
   // Calls the listener after every change that can alter which endpoint a call reaches or which tools it lists:
   // a register, a remove, a health change and a tool replacement. A gate state change does not notify. The listener
   // runs synchronously inside the change and must not throw. Returns the function that unsubscribes it.
   subscribe: (listener: () => void) => () => void;
}

/** The router that picks an endpoint for an invocation and runs it, and probes endpoints that stop answering. */
export interface Router {
   invoke: (op: string, params: object, options?: InvokeOptions) => Promise<unknown>;
   // Runs the `callTool` operation for a registry tool on the picked endpoint. The tool is resolved by name on that
   // endpoint: its own declaration (not the listed one) supplies the gate that is judged against that endpoint's
   // snapshot and is returned with the result. Fails with TOOL_GONE when the endpoint no longer registers the name or
   // declares other arguments for it, and with GATE_DENIED when its declared gate differs from the listed one. A
   // different description or result budget does not fail the call; the picked endpoint's budget applies.
   invokeTool: (
      name: string,
      args: Record<string, unknown>,
      options: ToolInvokeOptions,
   ) => Promise<{ result: unknown; tool: RegistryTool }>;
   // Display and diagnostic accessor only: copies the gate snapshot of the endpoint a call with the same `endpoint`
   // option would reach now, every gate closed when none is eligible. It is not a gate check, because a later `invoke`
   // may pick a different endpoint; enforcement uses the `requireGate` option of `invoke`.
   gateState: (options?: InvokeOptions) => GateState;
   // Copies the tool list of the endpoint a call with the same `endpoint` option would reach now; empty when none is
   // eligible. Like `gateState` it is a listing aid, not a guarantee that a later `invoke` reaches the same endpoint.
   tools: (options?: InvokeOptions) => RegistryTool[];
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

// The endpoint kinds a script that `requires` the DOM routes to by default: only the agent endpoint, because a person's
// tab is where they are working and a DOM script (opening sheets, measuring layout) would disturb it. A session that
// restricts its endpoint kind (`?endpoint=human`) overrides this and is then routed to that kind alone.
export const DOM_ROUTE_ORDER: readonly EndpointKind[] = ['agent'];

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

// Maximum UTF-8 byte length of a GATE_DENIED message.
const MAX_GATE_DENIAL_BYTES: number = 256;

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
   TOOL_GONE,
]);

/**
 * Compare two optional gate declarations.
 * @param {RequiredGate | undefined} a - The first declaration.
 * @param {RequiredGate | undefined} b - The second declaration.
 * @returns {boolean} Whether both declare no gate, or both declare the same gate and module id.
 */
function sameGate(a: RequiredGate | undefined, b: RequiredGate | undefined): boolean {
   if (a === undefined || b === undefined) {
      return a === b;
   }
   return a.gate === b.gate && a.moduleId === b.moduleId;
}

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
   // Listeners told about changes, in subscription order.
   const listeners: Set<() => void> = new Set();

   /**
    * Tell every listener that the endpoint set, an endpoint's health or its tools changed.
    * @returns {void}
    */
   function notify(): void {
      for (const listener of [...listeners]) {
         listener();
      }
   }

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
            tools: existing?.tools ?? [],
            health: existing?.health ?? 'healthy',
            registeredAt: existing?.registeredAt ?? now(),
         });
         notify();
         return true;
      },

      /**
       * Remove a socket's endpoint, if any.
       * @param {string} socketId - The socket id.
       * @returns {void}
       */
      remove(socketId: string): void {
         if (endpoints.delete(socketId)) {
            notify();
         }
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
         if (existing && existing.health !== health) {
            existing.health = health;
            notify();
         }
      },

      /**
       * Replace a registered endpoint's gate snapshot.
       * @param {string} socketId - The socket id; an unregistered socket is ignored.
       * @param {GateState} gateState - The new snapshot, already sanitized.
       * @returns {void}
       */
      setGateState(socketId: string, gateState: GateState): void {
         const existing: Endpoint | undefined = endpoints.get(socketId);
         if (existing) {
            existing.gateState = gateState;
         }
      },

      /**
       * Find the earliest-registered healthy endpoint of a kind.
       * @param {EndpointKind} kind - The endpoint kind.
       * @param {{ dom?: boolean }} [options] - `dom: true` skips endpoints that cannot run DOM scripts.
       * @returns {Endpoint | undefined} The endpoint, or undefined when no healthy matching endpoint is registered.
       */
      firstOfKind(kind: EndpointKind, options: { dom?: boolean } = {}): Endpoint | undefined {
         return [...endpoints.values()].find(
            (endpoint) =>
               endpoint.kind === kind && endpoint.health === 'healthy' && (options.dom !== true || endpoint.dom),
         );
      },

      /**
       * Replace a registered endpoint's tools.
       * @param {string} socketId - The socket id; an unregistered socket is ignored.
       * @param {RegistryTool[]} tools - The new tools, already sanitized.
       * @returns {void}
       */
      setTools(socketId: string, tools: RegistryTool[]): void {
         const existing: Endpoint | undefined = endpoints.get(socketId);
         if (existing) {
            existing.tools = tools;
            notify();
         }
      },

      /**
       * Subscribe to endpoint-set, health and tool changes.
       * @param {() => void} listener - Called synchronously after each change; must not throw.
       * @returns {() => void} The function that removes the listener.
       */
      subscribe(listener: () => void): () => void {
         listeners.add(listener);
         return () => {
            listeners.delete(listener);
         };
      },
   };
}

/**
 * Validate a `bridge:identify` payload: the current protocol version, well-formed fields within the size limits
 * (`userId` at most 64 bytes, `userName` at most 128 bytes), and a GM user. The optional `gateState` is sanitized,
 * never refused: an absent or invalid value yields the all-closed snapshot.
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
            message:
               `Identify userId is limited to ${MAX_USER_ID_BYTES} bytes ` +
               `and userName to ${MAX_USER_NAME_BYTES}.`,
         },
      };
   }
   if (!fields.isGM) {
      return {
         ok: false,
         error: {
            code: NOT_GM,
            message: 'Only a GM client may register as a bridge endpoint.',
         },
      };
   }
   return {
      ok: true,
      identity: {
         userId: fields.userId,
         userName: fields.userName,
         kind: fields.kind as EndpointKind,
         dom: fields.dom,
         gateState: sanitizeGateState(fields.gateState),
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
 * @param {boolean} [dom] - Whether the call needs a DOM-capable endpoint; the message then names the DOM requirement
 *        and the kind that was looked for (the agent kind unless the session restricted it).
 * @returns {BridgeError} The error, its message bounded to 256 bytes.
 */
function noEndpoint(kind?: EndpointKind, dom: boolean = false): BridgeError {
   if (dom) {
      // The kind the DOM script was routed to.
      const wanted: EndpointKind = kind ?? 'agent';
      return new BridgeError(
         NO_ENDPOINT,
         truncateUtf8(
            `No DOM-capable '${wanted}' GM endpoint is connected: ${
               wanted === 'agent'
                  ? 'enable an agent, or restrict this session to a human tab with ?endpoint=human'
                  : 'open a GM tab in Foundry with Wiretap enabled'
            }.`,
            MAX_NO_ENDPOINT_BYTES,
         ),
      );
   }
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

   // Single-pick design: `invoke` picks exactly one endpoint here and uses that same object for the gate check and the
   // send, with no await in between, so no endpoint change can split the check from the send. `gateState` reuses the
   // pick for display only.
   /**
    * Choose the endpoint a call with these options would reach: the first healthy endpoint of the first eligible
    * kind. A call that needs the DOM considers the agent kind only (unless restricted) and only DOM-capable endpoints.
    * @param {InvokeOptions} options - `endpoint` restricts the choice to one kind with no fallback.
    * @param {boolean} [dom] - Whether the call needs a DOM-capable endpoint.
    * @returns {{ endpoint: Endpoint | undefined, kinds: readonly EndpointKind[] }} The endpoint (undefined when none
    *          is healthy) and the eligible kinds.
    */
   function pick(
      options: InvokeOptions,
      dom: boolean = false,
   ): { endpoint: Endpoint | undefined; kinds: readonly EndpointKind[] } {
      // The kinds to try: the restricted kind alone, else the route order of this kind of call.
      const kinds: readonly EndpointKind[] =
         options.endpoint === undefined ? (dom ? DOM_ROUTE_ORDER : ROUTE_ORDER) : [options.endpoint];
      let endpoint: Endpoint | undefined;
      for (const kind of kinds) {
         endpoint = registry.firstOfKind(kind, { dom });
         if (endpoint) {
            break;
         }
      }
      return { endpoint, kinds };
   }

   /**
    * Pick one endpoint, judge the gate on it and run an operation there. With `listed`, the operation is a registry
    * tool call: the tool is looked up by `listed.name` on the picked endpoint and that endpoint's own declaration
    * supplies the gate, so a tool listed from one endpoint never borrows the declaration of another.
    * @param {string} op - The operation name.
    * @param {object} params - The operation parameters.
    * @param {InvokeOptions} options - `endpoint` restricts the kind; `requireGate` is the gate of a plain call.
    * @param {RegistryTool} [listed] - The listed tool of a registry tool call.
    * @returns {Promise<{ result: unknown, tool?: RegistryTool }>} The result, and the picked endpoint's declaration of
    *          the tool for a registry tool call.
    */
   async function dispatch(
      op: string,
      params: object,
      options: InvokeOptions,
      listed?: RegistryTool,
   ): Promise<{ result: unknown; tool?: RegistryTool }> {
      // Whether the call is a registry tool call for a script that needs the DOM.
      const dom: boolean = listed?.requires === 'dom';
      const { endpoint, kinds } = pick(options, dom);
      if (!endpoint) {
         // No healthy matching endpoint of an eligible kind: unresponsive ones that are still connected and could have
         // served the call make it UNAVAILABLE.
         const stuck: boolean = registry
            .list()
            .some((candidate) => kinds.includes(candidate.kind) && (!dom || candidate.dom));
         throw stuck ? endpointUnavailable(options.endpoint) : noEndpoint(options.endpoint, dom);
      }
      // The gate to judge: the picked endpoint's own declaration of the tool for a registry tool call.
      let requireGate: RequiredGate | undefined = options.requireGate;
      // The picked endpoint's declaration of the listed tool.
      let declared: RegistryTool | undefined;
      if (listed) {
         declared = endpoint.tools.find((tool) => tool.name === listed.name);
         if (!declared) {
            throw new BridgeError(TOOL_GONE, 'The Foundry endpoint no longer registers this tool.');
         }
         if (!sameGate(declared.gate, listed.gate)) {
            deps.log(`Wiretap sidecar | invoke ${op} denied: the endpoint declares a different gate for the tool`);
            throw new BridgeError(
               GATE_DENIED,
               'The endpoint declares a different gate for this tool than the one listed; list the tools again.',
            );
         }
         if (declared.requires !== listed.requires || declared.mutates !== listed.mutates) {
            // The caller routed on the listed requirements and told the client the listed read-only hint.
            throw new BridgeError(
               TOOL_GONE,
               'The endpoint now declares different requirements for this tool; list the tools again.',
            );
         }
         if (declared.schemaSignature !== listed.schemaSignature) {
            // The caller validated the arguments against the listed schema, which this endpoint no longer declares.
            throw new BridgeError(
               TOOL_GONE,
               'The endpoint now declares different arguments for this tool; list the tools again.',
            );
         }
         requireGate = declared.gate;
      }
      if (requireGate) {
         // The gate is judged on the snapshot of the endpoint picked above; a denial is thrown before any send.
         // The denial of the gate on the picked endpoint's snapshot, or null when it is open.
         const denial: ReturnType<typeof gateDenial> = gateDenial(
            endpoint.gateState,
            requireGate.gate,
            requireGate.moduleId,
         );
         if (denial) {
            deps.log(`Wiretap sidecar | invoke ${op} denied by gate ${denial.code}`);
            throw new BridgeError(GATE_DENIED, truncateUtf8(denial.message, MAX_GATE_DENIAL_BYTES));
         }
      }
      const requestId: string = newRequestId();
      deps.log(
         `Wiretap sidecar | invoke ${op} requestId=${requestId} -> ${endpoint.kind} endpoint ${endpoint.socketId}`,
      );
      let ack: unknown;
      try {
         ack = await deps.send(endpoint.socketId, {
            op,
            params,
            requestId,
         });
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
         return {
            result: (ack as { result?: unknown }).result,
            tool: declared,
         };
      }
      const error: BridgeError = normalizeAckError(ack);
      deps.log(`Wiretap sidecar | invoke ${op} requestId=${requestId} failed: ${error.code}`);
      throw error;
   }

   return {
      /**
       * Copy the gate snapshot of the endpoint a call with the same options would reach now. For display and
       * diagnostics only: it is not an enforcement point, since a later `invoke` picks its endpoint again. Use
       * `requireGate`.
       * @param {InvokeOptions} [options] - `endpoint` restricts the choice to one kind with no fallback.
       * @returns {GateState} A fresh copy of the snapshot; every gate closed when no healthy endpoint is eligible.
       */
      gateState(options: InvokeOptions = {}): GateState {
         const { endpoint } = pick(options);
         return endpoint ? sanitizeGateState(endpoint.gateState) : closedGateState();
      },

      /**
       * Copy the tool list of the endpoint a call with the same options would reach now. A listing aid only: a later
       * `invoke` picks its endpoint again.
       * @param {InvokeOptions} [options] - `endpoint` restricts the choice to one kind with no fallback.
       * @returns {RegistryTool[]} A copy of the endpoint's tools; empty when no healthy endpoint is eligible.
       */
      tools(options: InvokeOptions = {}): RegistryTool[] {
         const { endpoint } = pick(options);
         return endpoint ? [...endpoint.tools] : [];
      },

      /**
       * Run an operation on a chosen endpoint.
       * @param {string} op - The operation name.
       * @param {object} params - The operation parameters.
       * @param {InvokeOptions} [options] - `endpoint` restricts the choice to one kind with no fallback; `requireGate`
       *        makes the picked endpoint's own snapshot decide whether the call is sent at all.
       * @returns {Promise<unknown>} The operation result; rejects with a BridgeError (NO_ENDPOINT,
       *          ENDPOINT_UNAVAILABLE, GATE_DENIED, ENDPOINT_GONE, ENDPOINT_TIMEOUT, or the normalized client
       *          failure).
       */
      async invoke(op: string, params: object, options: InvokeOptions = {}): Promise<unknown> {
         return (await dispatch(op, params, options)).result;
      },

      /**
       * Run a registry tool on the picked endpoint, resolving the tool by name on that endpoint.
       * @param {string} name - The tool name.
       * @param {Record<string, unknown>} args - The validated tool arguments.
       * @param {ToolInvokeOptions} options - `endpoint` restricts the kind; `listed` is the listed definition.
       * @returns {Promise<{ result: unknown, tool: RegistryTool }>} The result and the picked endpoint's declaration
       *          of the tool; rejects as `invoke` does, plus TOOL_GONE and the GATE_DENIED of a changed declaration.
       */
      async invokeTool(
         name: string,
         args: Record<string, unknown>,
         options: ToolInvokeOptions,
      ): Promise<{ result: unknown; tool: RegistryTool }> {
         // The result, and the declaration of the tool on the endpoint that ran it.
         const outcome: Awaited<ReturnType<typeof dispatch>> = await dispatch(
            OP_CALL_TOOL,
            {
               name,
               arguments: args,
            },
            { endpoint: options.endpoint },
            options.listed,
         );
         return {
            result: outcome.result,
            tool: outcome.tool as RegistryTool,
         };
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
