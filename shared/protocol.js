/**
 * Shared wire contract between the Wiretap browser module and the Node sidecar. Imported by both sides,
 * so it is plain JS (no TypeScript) and is the single source of truth for socket event names and payload
 * shapes.
 */

// Socket.IO event (client to server) carrying a user message; the server replies via the ack callback.
export const WIRETAP_MESSAGE = 'wiretap:message';

/**
 * @typedef {object} WiretapMessage
 * @property {string} text - The message text sent from the tab to the sidecar.
 */

/**
 * @typedef {object} WiretapEcho
 * @property {string} text - The echoed message text.
 * @property {string} receivedAt - ISO-8601 timestamp stamped by the sidecar on receipt.
 */
