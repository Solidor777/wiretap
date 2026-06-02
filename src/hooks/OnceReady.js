import { connection } from '~/bridge/TerminalConnection.svelte.js';
import { initFoundryBridge } from '~/bridge/foundryBridge.js';

/**
 * Foundry `ready` handler. Logs readiness, connects the persistent sidecar socket using the configured
 * server URL, and wires the Foundry bridge so the user's `claude` can execute tools against this world.
 * @returns {void}
 */
export default function onceReady() {
   console.log('Wiretap | Module ready.');
   // GM-only: the sidecar exposes a terminal on the host, so non-GM clients never connect.
   if (game.user.isGM) {
      connection.connect(game.settings.get('wiretap', 'serverUrl'));
      initFoundryBridge(connection);
   }
}
