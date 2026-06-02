import {
   TERMINAL_LAUNCH,
   TERMINAL_INPUT,
   TERMINAL_RESIZE,
   TERMINAL_CLOSE,
   TERMINAL_DATA,
   TERMINAL_STATE,
   TERMINAL_EXIT,
} from '$shared/protocol.js';

// Maximum bytes of received output retained client-side for replay to a (re)attached terminal sink.
const OUTPUT_LIMIT = 64 * 1024;

/**
 * @typedef {'disconnected' | 'connecting' | 'connected'} SocketStatus
 */

/**
 * Reactive wrapper around the Socket.IO connection to the Wiretap sidecar terminal. Tracks socket status
 * and PTY running-state as Svelte 5 runes, buffers PTY output for reattach, and exposes terminal controls.
 * Exported as a shared singleton; the class is exported for tests (which inject a fake io factory).
 */
export class TerminalConnection {

   /**
    * Socket connection status.
    * @type {SocketStatus}
    */
   status = $state('disconnected');

   /**
    * Whether a PTY is currently running on the sidecar.
    * @type {boolean}
    */
   running = $state(false);

   /**
    * The active Socket.IO socket, or null when not connected.
    * @type {object | null}
    */
   #socket = null;

   /**
    * Ring buffer of received PTY output, replayed when a terminal sink attaches.
    * @type {string}
    */
   #output = '';

   /**
    * The most recent terminal size reported by a view, used when launching a new PTY.
    * @type {number}
    */
   #cols = 80;

   /**
    * The most recent terminal row count reported by a view.
    * @type {number}
    */
   #rows = 24;

   /**
    * A command to launch once the current PTY exits, set by restart() while a PTY is still running.
    * @type {string | null}
    */
   #pendingRelaunch = null;

   /**
    * Active terminal output sinks — one per mounted terminal view (the docked tab and any pop-out).
    * @type {Set<(chunk: string) => void>}
    */
   #sinks = new Set();

   /**
    * Connect to the sidecar and wire terminal events. Idempotent while a socket exists.
    * @param {string} url - The sidecar URL.
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
         this.#output = '';
      });
      socket.on('disconnect', () => {
         this.status = 'disconnected';
      });
      socket.on('connect_error', () => {
         this.status = 'disconnected';
      });
      socket.on(TERMINAL_STATE, (state) => {
         this.running = state.running;
         if (!state.running) {
            this.#output = '';
         }
      });
      socket.on(TERMINAL_DATA, ({ chunk }) => {
         this.#output += chunk;
         if (this.#output.length > OUTPUT_LIMIT) {
            this.#output = this.#output.slice(this.#output.length - OUTPUT_LIMIT);
         }
         for (const sink of this.#sinks) {
            sink(chunk);
         }
      });
      socket.on(TERMINAL_EXIT, () => {
         this.running = false;
         if (this.#pendingRelaunch !== null) {
            const command = this.#pendingRelaunch;
            this.#pendingRelaunch = null;
            this.launch(command);
         }
      });
   }

   /**
    * Attach a terminal output sink (an xterm writer). Multiple sinks may be attached at once (the docked
    * tab and its pop-out each attach one). Immediately replays the buffered output to the new sink.
    * @param {(chunk: string) => void} sink - Receives output chunks.
    * @returns {() => void} A detach function.
    */
   attach(sink) {
      this.#sinks.add(sink);
      if (this.#output) {
         sink(this.#output);
      }
      return () => {
         this.#sinks.delete(sink);
      };
   }

   /**
    * Request the sidecar spawn a PTY at the most recently reported size.
    * @param {string} command - The command line to run.
    * @returns {void}
    */
   launch(command) {
      this.#socket?.emit(TERMINAL_LAUNCH, { command, cols: this.#cols, rows: this.#rows });
   }

   /**
    * Restart the terminal: relaunch the command, closing any running PTY first. While a PTY is running the
    * relaunch is deferred until the PTY's exit is observed, so only one PTY exists at a time.
    * @param {string} command - The command line to run.
    * @returns {void}
    */
   restart(command) {
      if (this.running) {
         this.#pendingRelaunch = command;
         this.close();
      } else {
         this.launch(command);
      }
   }

   /**
    * Send input to the PTY.
    * @param {string} data - Raw input bytes.
    * @returns {void}
    */
   sendInput(data) {
      this.#socket?.emit(TERMINAL_INPUT, { data });
   }

   /**
    * Resize the PTY and remember the size for the next launch.
    * @param {number} cols - New columns.
    * @param {number} rows - New rows.
    * @returns {void}
    */
   resize(cols, rows) {
      this.#cols = cols;
      this.#rows = rows;
      this.#socket?.emit(TERMINAL_RESIZE, { cols, rows });
   }

   /**
    * Kill the PTY.
    * @returns {void}
    */
   close() {
      this.#socket?.emit(TERMINAL_CLOSE, {});
   }
}

// Shared singleton used by the tab component and the ready hook.
export const connection = new TerminalConnection();
