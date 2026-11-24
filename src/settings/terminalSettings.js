import { connection } from '~/bridge/TerminalConnection.svelte.js';
import { TERMINAL_SCROLLBACK_DEFAULT } from '$shared/protocol.js';

/**
 * Register the GM-only world setting for the terminal scrollback size, in characters, and apply it to the shared
 * terminal connection now and on every change. World scope because the sidecar runs one terminal for every GM client:
 * a per-client value would let each client that launches set a different replay size for the same terminal. The
 * client buffer follows a change at once; the sidecar's replay buffer takes the value at the next launch. Must run
 * during `init`.
 * @returns {void}
 */
export function registerTerminalSettings() {
   game.settings.register('wiretap', 'terminalScrollback', {
      name: 'WIRETAP.Settings.TerminalScrollback.Name',
      hint: 'WIRETAP.Settings.TerminalScrollback.Hint',
      scope: 'world',
      restricted: true,
      config: true,
      type: Number,
      default: TERMINAL_SCROLLBACK_DEFAULT,
      onChange: (value) => {
         connection.setScrollback(value);
      },
   });

   // Seed the connection from the stored value (covers a non-default saved size on load).
   connection.setScrollback(game.settings.get('wiretap', 'terminalScrollback'));
}
