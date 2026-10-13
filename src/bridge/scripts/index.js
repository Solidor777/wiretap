import { createActorDefinition, createActorHandler } from '~/bridge/scripts/createActor.js';
import { scriptRegistry } from '~/bridge/scripts/registry.js';

/**
 * The scripts that ship in the bundle, each with its handler. Static imports only: nothing is loaded at run time.
 * @type {ReadonlyArray<{ definition: import('$shared/scripts.js').ScriptDefinition, handler: Function }>}
 */
export const SHIPPED_SCRIPTS = Object.freeze([
   {
      definition: createActorDefinition,
      handler: createActorHandler,
   },
]);

/**
 * Register every shipped script on a registry. A refusal is logged by the registry and does not stop the others.
 * @param {import('~/bridge/scripts/registry.js').ScriptRegistry} [registry] - The registry; defaults to the client's.
 * @returns {import('~/bridge/scripts/registry.js').RegistrationOutcome[]} The outcome of each registration.
 */
export function registerShippedScripts(registry = scriptRegistry) {
   return SHIPPED_SCRIPTS.map(({ definition, handler }) => registry.register(definition, handler));
}
