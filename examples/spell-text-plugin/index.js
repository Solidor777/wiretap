/**
 * The example module's entry: registers `create_spell` when Wiretap fires `wiretap.registerTools`. Wiretap fires the
 * hook once from its `ready` hook on every client, after its own tools are registered, so a module that loads before
 * or after Wiretap registers the same way.
 */

import { createSpellHandler, createSpellTool } from './spellTool.js';

/** @type {string} This module's id, as `module.json` declares it. */
const MODULE_ID = 'wiretap-example-spells';

/** @type {number} The Wiretap plugin API version this module is written for. */
const SUPPORTED_API_VERSION = 1;

/**
 * Register the spell tool on a Wiretap API this module supports, and report a version it does not support or a
 * refused registration on the console (an outside module has no Wiretap logger).
 * @param {{ apiVersion: number, registerTool: Function }} api - The API object Wiretap passes to the hook.
 * @returns {void}
 */
function registerSpellTool(api) {
   if (api.apiVersion !== SUPPORTED_API_VERSION) {
      console.warn(
         `${MODULE_ID} | Wiretap plugin API version ${api.apiVersion} is not supported; this module supports version `
            + `${SUPPORTED_API_VERSION}`,
      );
      return;
   }
   /** @type {{ ok: boolean, name?: string, reason?: string }} The registration outcome. */
   const outcome = api.registerTool({
      ...createSpellTool,
      moduleId: MODULE_ID,
      handler: createSpellHandler,
   });
   if (!outcome.ok) {
      console.warn(`${MODULE_ID} | Wiretap refused create_spell: ${outcome.reason}`);
   }
}

Hooks.once('wiretap.registerTools', registerSpellTool);
