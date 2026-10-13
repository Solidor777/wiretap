import { connection } from '~/bridge/TerminalConnection.svelte.js';
import { initFoundryBridge } from '~/bridge/foundryBridge.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';

/**
 * Foundry `ready` handler. Connects the persistent sidecar socket using the configured server URL, registers the
 * shipped scripts, and wires the Foundry bridge so the user's `claude` can execute tools against this world.
 * The scripts register before the bridge wires the socket, so the first registry push holds them.
 * @returns {void}
 */
export default function onceReady() {
   // GM-only: the sidecar exposes a terminal on the host, so non-GM clients never connect.
   if (game.user.isGM) {
      connection.connect(game.settings.get('wiretap', 'serverUrl'));
      registerShippedScripts();
      initFoundryBridge(connection);
   }
}
