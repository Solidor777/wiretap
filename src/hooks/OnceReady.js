import { connection } from '~/bridge/WiretapConnection.svelte.js';

/**
 * Foundry `ready` handler. Logs readiness and connects the persistent sidecar socket using the
 * configured server URL.
 * @returns {void}
 */
export default function onceReady() {
   console.log('Wiretap | Module ready.');
   connection.connect(game.settings.get('wiretap', 'serverUrl'));
}
