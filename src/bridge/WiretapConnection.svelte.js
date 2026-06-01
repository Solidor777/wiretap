import { WIRETAP_MESSAGE } from '$shared/protocol.js';

/**
 * @typedef {'disconnected' | 'connecting' | 'connected'} WiretapStatus
 */

/**
 * @typedef {object} WiretapLogEntry
 * @property {'out' | 'in'} direction - Whether the user sent the entry or the sidecar returned it.
 * @property {string} text - The entry text.
 * @property {string} at - ISO-8601 timestamp recorded when the entry was logged.
 */

/**
 * Reactive wrapper around the Socket.IO connection to the Wiretap sidecar. Connection status and the
 * message log are Svelte 5 runes so the tab re-renders on change. Exported as a shared singleton; the
 * class is also exported so tests can inject a fake io factory.
 */
export class WiretapConnection {

   /**
    * The current connection status.
    * @type {WiretapStatus}
    */
   status = $state('disconnected');

   /**
    * The running message log (sent and echoed).
    * @type {WiretapLogEntry[]}
    */
   messages = $state([]);

   /**
    * The active Socket.IO socket, or null when not connected.
    * @type {object | null}
    */
   #socket = null;

   /**
    * Connect to the sidecar. Idempotent: a second call while a socket exists is a no-op.
    * @param {string} url - The sidecar URL (e.g. 'http://localhost:31416').
    * @param {Function} [ioFactory] - Socket.IO client factory; defaults to Foundry's global `io`.
    * @returns {void}
    */
   connect(url, ioFactory = globalThis.io) {
      if (this.#socket) {
         return;
      }
      if (typeof ioFactory !== 'function') {
         console.warn('Wiretap | Socket.IO client (io) unavailable; cannot connect.');
         return;
      }

      this.status = 'connecting';
      const socket = ioFactory(url, { reconnection: true });
      this.#socket = socket;

      socket.on('connect', () => {
         this.status = 'connected';
      });
      socket.on('disconnect', () => {
         this.status = 'disconnected';
      });
      socket.on('connect_error', () => {
         this.status = 'disconnected';
      });
   }

   /**
    * Send a message to the sidecar and record the echoed reply on ack.
    * @param {string} text - The message text.
    * @returns {void}
    */
   send(text) {
      if (!this.#socket || this.status !== 'connected') {
         return;
      }
      this.messages.push({ direction: 'out', text, at: new Date().toISOString() });
      this.#socket.emit(WIRETAP_MESSAGE, { text }, (reply) => {
         this.messages.push({ direction: 'in', text: reply.text, at: reply.receivedAt });
      });
   }
}

// Shared singleton used by the tab component and the ready hook.
export const connection = new WiretapConnection();
