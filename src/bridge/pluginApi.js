import { getBudget } from '$shared/budgets.js';
import { isModuleId } from '$shared/gates.js';
import { cleanForLog } from '$shared/logText.js';
import { PLUGIN_NAME_PATTERN, SCRIPT_API_VERSION } from '$shared/scripts.js';
import { scriptRegistry } from '~/bridge/scripts/registry.js';

/**
 * @typedef {import('~/bridge/scripts/registry.js').ScriptRegistry} ScriptRegistry
 */

/**
 * @typedef {import('~/bridge/scripts/registry.js').RegistrationOutcome} RegistrationOutcome
 */

/**
 * @typedef {object} PluginToolInput
 * @property {string} moduleId - The registering module's id from its `module.json`; the module must be active.
 * @property {string} name - The short tool name, one or more of `A-Z`, `a-z`, `0-9`, `_` and `-`, without the
 * `<moduleId>__` prefix; Wiretap registers `<moduleId>__<name>`.
 * @property {string} version - A semver-like version of at most 32 characters.
 * @property {string} description - One line that tells the agent what the tool does.
 * @property {Record<string, unknown>} inputSchema - The argument schema (the subset the sidecar converts).
 * @property {import('~/bridge/scripts/registry.js').ScriptHandler} handler - The code that runs a call.
 * @property {boolean} mutates - Whether a call can change the world.
 * @property {'api' | 'dom'} requires - What the handler needs on the client.
 * @property {{ budgetBytes: number }} [result] - The result limits; defaults to `COMPACT_VIEW_MAX_BYTES` (2000).
 * @property {string} [gate] - A risk gate every call also requires.
 * @property {string[]} [handleArgs] - The arguments that may carry a handle.
 * @property {boolean} [strictNested] - Whether nested objects refuse undeclared properties.
 * @property {boolean} [requiresUserInteraction] - Whether a call needs a user's interaction in the browser.
 */

/**
 * @typedef {object} PluginApi
 * @property {number} apiVersion - The plugin API version, `SCRIPT_API_VERSION`.
 * @property {(input: unknown) => RegistrationOutcome} registerTool - Register one plugin tool; never throws.
 */

/**
 * The hook Wiretap fires once from its `ready` hook on every client, with the plugin API as its argument.
 * @type {string}
 */
export const PLUGIN_HOOK = 'wiretap.registerTools';

/**
 * The optional input fields copied to the definition only when the input has them as own properties.
 * @type {readonly string[]}
 */
const OPTIONAL_FIELDS = Object.freeze([
   'gate',
   'handleArgs',
   'strictNested',
   'requiresUserInteraction',
]);

/**
 * Longest tool label written to a log line, in UTF-8 bytes; the same bound the registry's log lines use.
 * @type {number}
 */
const LOG_LABEL_BYTES = 48;

/**
 * Longest module id echoed in the inactive-module reason, in UTF-8 bytes. The short-name reasons echo the whole id:
 * it names an active module, and the author needs the exact prefix.
 * @type {number}
 */
const ID_ECHO_BYTES = 64;

/**
 * The refusal reason for an input that is not one object.
 * @type {string}
 */
const NOT_AN_OBJECT = 'registerTool takes one object: { moduleId, name, version, description, inputSchema, handler, ' +
   'mutates, requires }';

/**
 * The refusal reason for an input that could not be read, for example a getter that throws.
 * @type {string}
 */
const UNREADABLE = 'the registration could not be processed';

/**
 * Read an own property only, so an inherited or polluted field is never taken for the author's data.
 * @param {object} source - The object to read.
 * @param {string} key - The property name.
 * @returns {unknown} The own value, or undefined when the property is absent or inherited.
 */
function ownValue(source, key) {
   return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Create the public plugin API on a registry. The object is frozen, so a module cannot replace `registerTool` for the
 * modules that run after it.
 * @param {object} options - The API's collaborators.
 * @param {ScriptRegistry} options.registry - The registry plugin tools register on.
 * @param {(id: string) => boolean} options.isModuleActive - Whether a module id names a module active in this world.
 * @returns {Readonly<PluginApi>} The frozen API.
 */
export function createPluginApi({ registry, isModuleActive }) {
   /**
    * Refuse a registration before it reaches the registry: log the reason and build the outcome.
    * @param {string} label - The tool's label for the log line.
    * @param {string} reason - The reason given to the author.
    * @returns {{ ok: false, reason: string }} The refusal.
    */
   function refuse(label, reason) {
      registry.log(`Wiretap | plugin tool refused ${JSON.stringify(label)}: ${reason}`);
      return {
         ok: false,
         reason,
      };
   }

   /**
    * Register one plugin tool from another module. The author passes the short `name` and Wiretap registers
    * `<moduleId>__<name>` as a plugin script: best practices only warn, and a rule the tool needs to work refuses it
    * with a reason that says what to change. `result` defaults to `{ budgetBytes: 2000 }` (`COMPACT_VIEW_MAX_BYTES`).
    * Any module can claim any active module's id: Wiretap does not prove which module is calling, so the module gate
    * (`allowedPluginModules`) trusts the id. Every client registers its tools, but only GM clients connect to the
    * sidecar, so only a GM client's plugin tools reach the agent.
    * @param {unknown} input - The untrusted `PluginToolInput`.
    * @returns {RegistrationOutcome} `{ ok: true, name }` with the registered name, or `{ ok: false, reason }`; never
    * throws.
    */
   function registerTool(input) {
      /** @type {string} The label used in log lines. */
      let label = '<unnamed>';
      try {
         if (typeof input !== 'object' || input === null || Array.isArray(input)) {
            return refuse(label, NOT_AN_OBJECT);
         }
         /** @type {unknown} The untrusted module id. */
         const moduleId = ownValue(input, 'moduleId');
         /** @type {unknown} The untrusted short tool name. */
         const name = ownValue(input, 'name');
         /** @type {boolean} Whether the module id is well formed; a malformed one is refused by the validator. */
         const wellFormed = isModuleId(moduleId);
         /** @type {unknown} The name to register: the built name when both parts are strings, else the raw name. */
         const fullName = wellFormed && typeof name === 'string' ? `${moduleId}__${name}` : name;
         if (typeof fullName === 'string') {
            label = cleanForLog(fullName, LOG_LABEL_BYTES);
         }
         if (wellFormed && !isModuleActive(/** @type {string} */ (moduleId))) {
            return refuse(
               label,
               `moduleId "${cleanForLog(moduleId, ID_ECHO_BYTES)}" is not an active module in this world: pass your ` +
                  'own module\'s id and enable the module',
            );
         }
         if (wellFormed) {
            /** @type {string} The prefix Wiretap puts before the short name. */
            const prefix = `${moduleId}__`;
            // The short name is judged here, not by the validator, whose reason describes the built name.
            if (typeof name === 'string' && name.startsWith(prefix)) {
               return refuse(
                  label,
                  `name already starts with "${prefix}"; pass only the short name, Wiretap adds the prefix`,
               );
            }
            if (typeof name !== 'string' || !PLUGIN_NAME_PATTERN.test(name)) {
               return refuse(
                  label,
                  `name is your tool's short name: one or more of A-Z, a-z, 0-9, _ and -; Wiretap adds "${prefix}" ` +
                     'itself',
               );
            }
         }
         /** @type {unknown} The declared result limits, or undefined. */
         const result = ownValue(input, 'result');
         /** @type {Record<string, unknown>} The definition handed to the registry, which copies what it keeps. */
         const definition = {
            moduleId,
            name: fullName,
            version: ownValue(input, 'version'),
            description: ownValue(input, 'description'),
            inputSchema: ownValue(input, 'inputSchema'),
            result: result === undefined ? { budgetBytes: getBudget('COMPACT_VIEW_MAX_BYTES').value } : result,
            requires: ownValue(input, 'requires'),
            mutates: ownValue(input, 'mutates'),
         };
         for (const field of OPTIONAL_FIELDS) {
            if (Object.hasOwn(input, field)) {
               definition[field] = input[field];
            }
         }
         return registry.register(definition, ownValue(input, 'handler'), 'plugin');
      } catch {
         return refuse(label, UNREADABLE);
      }
   }

   return Object.freeze({
      apiVersion: SCRIPT_API_VERSION,
      registerTool,
   });
}

/**
 * The plugin API of this client, passed to the `wiretap.registerTools` hook. A module is active when Foundry's
 * `Module#active` is true (read: `client/packages/module.mjs:13-21`, a non-writable boolean fixed when the module's
 * package data is constructed).
 * @type {Readonly<PluginApi>}
 */
export const pluginApi = createPluginApi({
   registry: scriptRegistry,
   isModuleActive: (id) => game.modules?.get(id)?.active === true,
});
