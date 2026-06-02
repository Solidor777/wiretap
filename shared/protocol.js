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

// Client → server, once per (re)connect: register this socket as a live Foundry-GM bridge endpoint.
export const BRIDGE_IDENTIFY = 'bridge:identify';

// Server → client, with an ack callback: run a Foundry operation and return its result.
export const BRIDGE_INVOKE = 'bridge:invoke';

// Operation names dispatched over BRIDGE_INVOKE (shared so both sides agree).
export const OP_CREATE_ACTOR = 'createActor';

/**
 * @typedef {object} BridgeIdentify
 * @property {string} userId - The Foundry user id.
 * @property {string} userName - The Foundry user display name.
 * @property {boolean} isGM - Whether the identifying user is a GM.
 */

/**
 * @typedef {object} BridgeInvoke
 * @property {string} op - The operation name (one of the OP_* constants).
 * @property {object} params - Operation parameters.
 */

/**
 * @typedef {object} BridgeAck
 * @property {boolean} ok - Whether the operation succeeded.
 * @property {*} [result] - The operation result when ok is true.
 * @property {string} [error] - A human-readable error when ok is false.
 */
