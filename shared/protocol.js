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

// Terminal scrollback kept for replay when no usable size is set: 64 KB, counted in characters (UTF-16 code units, the
// unit of a JavaScript string's length), so 65,536 characters. Both the sidecar's reattach replay and the client's
// output buffer keep this many.
export const TERMINAL_SCROLLBACK_DEFAULT = 64 * 1024;

// Scrollback size in characters past which the sidecar writes one warning line at launch. A reattach sends the whole
// replay as one Socket.IO message and the terminal parses it at once; 1,048,576 characters (16 times the default) is
// up to 2 MB of string memory in each buffer and at least 1 MB on the wire. Inferred: past it a reattach is visibly slow.
export const TERMINAL_SCROLLBACK_WARN = 1024 * 1024;

/**
 * Turn a scrollback setting into the number of characters a buffer keeps: a positive integer is used as given, any
 * other value (zero, negative, a fraction, not a number, absent) gives `TERMINAL_SCROLLBACK_DEFAULT`.
 * @param {unknown} value - The setting value or the launch payload's `scrollback`.
 * @returns {number} The number of characters to keep.
 */
export function scrollbackChars(value) {
   if (Number.isInteger(value) && value > 0) {
      return value;
   }
   return TERMINAL_SCROLLBACK_DEFAULT;
}

/**
 * @typedef {object} TerminalLaunch
 * @property {string} [command] - Command line to run in the PTY (default 'claude').
 * @property {number} cols - Initial column count.
 * @property {number} rows - Initial row count.
 * @property {number} [scrollback] - Characters of output the sidecar keeps for the reattach replay; a value that is
 * not a positive integer gives `TERMINAL_SCROLLBACK_DEFAULT`.
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
export const PROTOCOL_VERSION = 5;

// Client → server, once per (re)connect, with an ack callback: register this socket as a live Foundry-GM bridge
// endpoint. The sidecar acks after registration (or refusal).
export const BRIDGE_IDENTIFY = 'bridge:identify';

// Client → server, with an optional ack callback: the registered GM endpoint's current risk-gate snapshot and bridge
// settings, a `BridgeStatePush`. Sent when a gate or bridge setting changes; the identify carries the first snapshot. A
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

// Client → server, with an ack callback: one `BackupPiece` of the backup stream a running `OP_BACKUP_EXPORT`
// produces, or its end marker. The sidecar acks each piece with a `PieceAck` before the client sends the next.
export const BRIDGE_BACKUP_PIECE = 'bridge:backupPiece';

// Server → client, with an ack callback: one `BackupPiece` of the backup file a running `OP_BACKUP_RESTORE` reads, or
// its end marker. The client acks each piece with a `PieceAck` before the sidecar sends the next.
export const BRIDGE_RESTORE_PIECE = 'bridge:restorePiece';

// Operation name dispatched over BRIDGE_INVOKE: export the named documents and stream them to the sidecar as
// BRIDGE_BACKUP_PIECE events.
export const OP_BACKUP_EXPORT = 'backupExport';

// Operation name dispatched over BRIDGE_INVOKE: receive a backup file as BRIDGE_RESTORE_PIECE events and write its
// documents back through the write code.
export const OP_BACKUP_RESTORE = 'backupRestore';

// Error code of a `PieceAck`: the receiver refused the piece, and the stream stops.
export const PIECE_REFUSED = 'PIECE_REFUSED';

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
 * @property {import('./bridgeSettings.js').BridgeSettings} [settings] - Bridge settings; an absent or invalid value
 * leaves that setting unset.
 */

/**
 * A data piece of a backup or restore stream, at most `BACKUP_PIECE_MAX_BYTES` bytes, tied to the invocation's
 * `requestId`.
 * @typedef {{ requestId: string, seq: number, data: Uint8Array }} BackupDataPiece
 */

/**
 * The end marker of a backup or restore stream, carrying the piece count and the byte total.
 * @typedef {{ requestId: string, seq: number, end: true, pieces: number, bytes: number }} BackupEndPiece
 */

/**
 * One piece of a backup or restore stream: a data piece or the end marker.
 * @typedef {BackupDataPiece | BackupEndPiece} BackupPiece
 */

/**
 * The receiver's answer to one `BackupPiece`.
 * @typedef {{ ok: true } | { ok: false, error: { code: string, message: string } }} PieceAck
 */

/**
 * The payload of BRIDGE_GATE_STATE.
 * @typedef {object} BridgeStatePush
 * @property {import('./gates.js').GateState} gateState - The endpoint's risk-gate snapshot.
 * @property {import('./bridgeSettings.js').BridgeSettings} settings - The endpoint's bridge settings.
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
 * @property {{ code: string, message: string }} [error] - The refusal (PROTOCOL_MISMATCH, NOT_GM).
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
