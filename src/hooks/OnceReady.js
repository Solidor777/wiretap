import { connection } from '~/bridge/TerminalConnection.svelte.js';
import { initFoundryBridge } from '~/bridge/foundryBridge.js';
import { PLUGIN_HOOK, pluginApi } from '~/bridge/pluginApi.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';

/**
 * Foundry `ready` handler. On a GM client it connects the persistent sidecar socket using the configured server URL,
 * registers the shipped scripts, and wires the Foundry bridge so the user's `claude` can execute tools against this
 * world; the scripts register before the bridge wires the socket, so the first registry push holds them. On every
 * client it then fires `wiretap.registerTools` once with the plugin API. The hook fires after every module's code has
 * run, because Foundry calls `ready` after `setup` (read: `client/game.mjs:740, 777-779`), and on a GM client after
 * the shipped scripts are registered; a non-GM client registers no shipped scripts.
 * @returns {void}
 */
export default function onceReady() {
   // GM-only: the sidecar exposes a terminal on the host, so non-GM clients never connect.
   if (game.user.isGM) {
      connection.connect(game.settings.get('wiretap', 'serverUrl'));
      registerShippedScripts();
      initFoundryBridge(connection);
   }
   Hooks.callAll(PLUGIN_HOOK, pluginApi);
}
