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
export const PROTOCOL_VERSION = 4;

// Client → server, once per (re)connect, with an ack callback: register this socket as a live Foundry-GM bridge
// endpoint. The sidecar acks after registration (or refusal).
export const BRIDGE_IDENTIFY = 'bridge:identify';

// Client → server, with an optional ack callback: the registered GM endpoint's current risk-gate snapshot (a
// GateState). Sent when a gate setting changes; the identify carries the first snapshot. A
// socket that is not a registered endpoint is refused and its snapshot is not applied.
export const BRIDGE_GATE_STATE = 'bridge:gateState';

// Client → server, with an optional ack callback: the registered GM endpoint's complete script list, a
// `ScriptRegistryPayload` `{ apiVersion, scripts }` (see `shared/scripts.js`). Each event replaces the endpoint's
// previous list; an empty `scripts` array clears it. A socket that is not a registered endpoint is refused and nothing
// is applied. The sidecar validates every definition with the shared script validator and bounds the list, then tells
// the open MCP sessions routed to that endpoint with `notifications/tools/list_changed`.
export const BRIDGE_REGISTRY = 'bridge:registry';

// Server → client, with an ack callback: run a Foundry operation and return its result.
export const BRIDGE_INVOKE = 'bridge:invoke';

// Server → client, with an ack callback: liveness probe. The client acks `{ ok: true }` at once and does nothing
// else.
export const BRIDGE_PING = 'bridge:ping';

// Operation name dispatched over BRIDGE_INVOKE (shared so both sides agree): runs a script the endpoint registered
// with BRIDGE_REGISTRY. Params are `{ name, arguments }`; the result is shown to the MCP caller as text (a string as
// is, anything else as JSON).
export const OP_CALL_TOOL = 'callTool';

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

// Error code: the endpoint a registry tool call reached no longer registers that tool.
export const TOOL_GONE = 'TOOL_GONE';

// Error code: an identify payload is not the current protocol version (or is malformed).
export const PROTOCOL_MISMATCH = 'PROTOCOL_MISMATCH';

// Error code: an identify came from a user that is not a GM.
export const NOT_GM = 'NOT_GM';

// Error code: an operation was refused by a risk gate (a closed gate, or a write to a Wiretap setting). Both sides
// may produce it: the sidecar pre-checks the endpoint's snapshot, and the executing client re-enforces every gate from
// its own settings, so a client ack may carry it. It is therefore not reserved, and a received GATE_DENIED is never
// proof that a sidecar check ran.
export const GATE_DENIED = 'GATE_DENIED';

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
 * @property {import('./gates.js').GateState} [gateState] - Risk-gate snapshot; absent or invalid closes every gate.
 */

/**
 * @typedef {object} BridgeGateStateAck
 * @property {boolean} ok - True when the snapshot was applied to the sender's endpoint.
 * @property {{ code: string, message: string }} [error] - NOT_GM when the socket is not a registered endpoint.
 */

/**
 * @typedef {object} BridgeRegistryAck
 * @property {boolean} ok - True when the endpoint's list was replaced.
 * @property {number} [accepted] - Scripts accepted, when ok is true.
 * @property {number} [refused] - Entries refused or never examined, when ok is true.
 * @property {{ code: string, message: string }} [error] - NOT_GM for a socket that is not a registered endpoint;
 * OP_FAILED when the payload is not `{ apiVersion, scripts }` of the current api version or could not be processed (the
 * endpoint's list is then cleared).
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
