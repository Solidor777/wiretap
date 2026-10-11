// The ports the e2e sidecars use. The Socket.IO port is fixed because the module's default `serverUrl` setting points
// at it; the e2e gate sidecar uses its own MCP and observer ports, so it never binds the MCP port of a developer's
// live sidecar.

/** @type {number} The Socket.IO sidecar port (the default `serverUrl` setting). */
export const SIDECAR_PORT = 31416;

/** @type {number} The MCP port of the e2e gate sidecar; differs from the sidecar default 31417. */
export const E2E_MCP_PORT = 31419;

/** @type {number} The loopback port of the e2e gate observer served by `gateSidecar.mjs`. */
export const GATE_OBSERVER_PORT = 31418;
