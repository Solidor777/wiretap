import { connection } from '~/bridge/TerminalConnection.svelte.js';

/**
 * Foundry `ready` handler. Logs readiness and connects the persistent sidecar socket using the
 * configured server URL.
 * @returns {void}
 */
export default function onceReady() {
   console.log('Wiretap | Module ready.');
   // GM-only: the sidecar exposes a terminal on the host, so non-GM clients never connect.
   if (game.user.isGM) {
      connection.connect(game.settings.get('wiretap', 'serverUrl'));
   }
}
