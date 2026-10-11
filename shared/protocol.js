/**
 * Shared wire contract between the Wiretap browser module and the Node sidecar. Imported by both sides,
 * so it is plain JS (no TypeScript) and is the single source of truth for socket event names and payload
 * shapes.
 */

// --- Terminal relay events ---

// Client → server: spawn the PTY with a command at an initial size.
export const TERMINAL_LAUNCH = 'terminal:launch';

// Client → server: forward user keystrokes to the PTY stdin.
export const TERMINAL_INPUT = 'terminal:input';

// Client → server: resize the PTY to match the terminal viewport.
export const TERMINAL_RESIZE = 'terminal:resize';

// Client → server: kill the PTY.
export const TERMINAL_CLOSE = 'terminal:close';

// Server → client: a chunk of PTY output (live or replayed scrollback).
export const TERMINAL_DATA = 'terminal:data';

// Server → client: current terminal state (broadcast on change + on connect).
export const TERMINAL_STATE = 'terminal:state';

// Server → client: the PTY process exited.
export const TERMINAL_EXIT = 'terminal:exit';

/**
 * @typedef {object} TerminalLaunch
 * @property {string} [command] - Command line to run in the PTY (default 'claude').
 * @property {number} cols - Initial column count.
 * @property {number} rows - Initial row count.
 */

/**
 * @typedef {object} TerminalResize
 * @property {number} cols - New column count.
 * @property {number} rows - New row count.
 */

/**
 * @typedef {object} TerminalInput
 * @property {string} data - Raw input bytes to write to the PTY stdin.
 */

/**
 * @typedef {object} TerminalData
 * @property {string} chunk - A chunk of PTY output.
 */

/**
 * @typedef {object} TerminalState
 * @property {boolean} running - Whether a PTY is currently active.
 * @property {number} [cols] - Current column count, when running.
 * @property {number} [rows] - Current row count, when running.
 */

/**
 * @typedef {object} TerminalExit
 * @property {number|null} code - Process exit code.
 * @property {string} [signal] - Terminating signal, if any.
 */

// --- Foundry bridge events (MCP tool execution) ---

// Bridge protocol version carried by every identify; the sidecar refuses any other value (no translation of older
// payloads).
export const PROTOCOL_VERSION = 2;

// Client → server, once per (re)connect, with an ack callback: register this socket as a live Foundry-GM bridge
// endpoint. The sidecar acks after registration (or refusal).
export const BRIDGE_IDENTIFY = 'bridge:identify';

// Server → client, with an ack callback: run a Foundry operation and return its result.
export const BRIDGE_INVOKE = 'bridge:invoke';

// Server → client, with an ack callback: liveness probe. The client acks `{ ok: true }` at once and does nothing
// else.
export const BRIDGE_PING = 'bridge:ping';

// Operation names dispatched over BRIDGE_INVOKE (shared so both sides agree).
export const OP_CREATE_ACTOR = 'createActor';

// Endpoint kinds a client may identify as: a person's browser tab ('human') or an agent-runner browser ('agent').
export const ENDPOINT_KINDS = ['human', 'agent'];

// Error code: no registered endpoint is eligible for the invocation.
export const NO_ENDPOINT = 'NO_ENDPOINT';

// Error code: the chosen endpoint did not ack the invocation in time.
export const ENDPOINT_TIMEOUT = 'ENDPOINT_TIMEOUT';

// Error code: endpoints of the eligible kind are connected but none answered its liveness probe, so the call was
// refused without being sent.
export const ENDPOINT_UNAVAILABLE = 'ENDPOINT_UNAVAILABLE';

// Error code: the endpoint acked the invocation with a failure that carried no code of its own.
export const OP_FAILED = 'OP_FAILED';

// Error code: the chosen endpoint disconnected, or could not be written to, before it acked the invocation.
export const ENDPOINT_GONE = 'ENDPOINT_GONE';

// Error code: an identify was refused because the registry already holds the maximum number of endpoints.
export const ENDPOINT_LIMIT = 'ENDPOINT_LIMIT';

// Error code: an identify payload is not protocol version 2 (or is malformed).
export const PROTOCOL_MISMATCH = 'PROTOCOL_MISMATCH';

// Error code: an identify came from a user that is not a GM.
export const NOT_GM = 'NOT_GM';

/**
 * @typedef {'human' | 'agent'} EndpointKind
 */

/**
 * @typedef {object} BridgeIdentify
 * @property {number} protocolVersion - Must equal PROTOCOL_VERSION.
 * @property {string} userId - The Foundry user id, at most 64 bytes of UTF-8.
 * @property {string} userName - The Foundry user display name, at most 128 bytes of UTF-8.
 * @property {boolean} isGM - Whether the identifying user is a GM.
 * @property {EndpointKind} kind - Whether this client is a person's tab or an agent runner.
 * @property {boolean} dom - Whether this endpoint is a browser client able to run DOM operations.
 */

/**
 * @typedef {object} BridgeError
 * @property {string} code - A protocol error constant, or an unreserved client code (/^[A-Z][A-Z0-9_]{0,63}$/).
 * @property {string} message - Human-readable text, at most 512 bytes of UTF-8.
 * @property {{ path: string, message: string }[]} [failures] - Up to 10 validation failures.
 * @property {number} [failureCount] - The true number of failures when `failures` is present.
 */

/**
 * @typedef {object} BridgeIdentifyAck
 * @property {boolean} ok - True when the endpoint was registered.
 * @property {{ code: string, message: string }} [error] - The refusal (PROTOCOL_MISMATCH, NOT_GM, ENDPOINT_LIMIT).
 */

/**
 * @typedef {object} BridgeInvoke
 * @property {string} op - The operation name (one of the OP_* constants).
 * @property {object} params - Operation parameters.
 * @property {string} requestId - A sidecar-generated UUID identifying this invocation in sidecar logs.
 */

/**
 * @typedef {object} BridgeAck
 * @property {boolean} ok - Whether the operation succeeded.
 * @property {*} [result] - The operation result when ok is true.
 * @property {BridgeAckError} [error] - The failure when ok is false; the sidecar normalizes it into a BridgeError.
 */

/**
 * @typedef {object} BridgeAckError
 * @property {string} [code] - The client's error code; OP_FAILED when absent.
 * @property {string} message - The failure text.
 * @property {{ path: string, message: string }[]} [failures] - Validation failures reported by the client.
 * @property {number} [failureCount] - The client's true failure total when `failures` was truncated.
 */
