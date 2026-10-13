/**
 * The script definition shared by the Foundry client (which registers scripts) and the sidecar (which validates them
 * and lists each as an MCP tool). Plain JS with no dependencies beyond the other shared modules. One validator judges
 * every definition on both sides, so a client can check what it is about to send with the function the sidecar
 * enforces.
 *
 * A script definition is the wire form of a registered routine; its handler never travels:
 *
 * Fields:
 *
 * `name`: the MCP tool name. Shipped scripts: 1 to 32 characters (`CORE_TOOL_NAME_MAX_CHARS`) of `a-z`, `0-9`, `_`
 * and `-`, starting with a letter. Plugin scripts: `<moduleId>__<skill>`, at most 64 characters
 * (`PLUGIN_TOOL_NAME_MAX_CHARS`). Agent-saved scripts: `agent__<name>`, at most 64 characters. The names in
 * `RESERVED_SCRIPT_NAMES` and the names of `Object.prototype` members are refused.
 *
 * `version`: a semver-like string (`MAJOR.MINOR.PATCH`, optional `-prerelease` and `+build`), at most 32 characters
 * (`SCRIPT_VERSION_MAX_CHARS`).
 *
 * `description`: one line, 1 to 240 characters (`DESCRIPTION_MAX_CHARS`); over 160 (`DESCRIPTION_TARGET_CHARS`) is
 * accepted with a warning.
 *
 * `inputSchema`: a JSON Schema object. The sidecar further restricts it to a documented subset when it converts it
 * (see `server/toolRegistry.ts`).
 *
 * `result.budgetBytes`: the script's own result budget, an integer from 1 to `RESULT_HARD_CAP_MAX_BYTES`.
 *
 * `requires`: where the script can run. `'api'`: any client endpoint. `'dom'`: only an endpoint that renders and
 * measures (`dom: true`), the agent endpoint by default. `'none'`: the sidecar itself; a client cannot register it.
 * Required, never defaulted.
 *
 * `mutates`: whether the script changes the world. Required, never defaulted: a definition without a boolean is
 * refused.
 *
 * `gate`: optional risk gate (a name in `GATES`) that must be open on the executing endpoint.
 * `allowedPluginModules` is not a script gate.
 *
 * `moduleId`: the owning module id of a plugin script (required for that source, refused for the others).
 *
 * The total of `{name, description, inputSchema}` serialized is held to `DEFINITION_MAX_BYTES`.
 *
 * The `source` of a script ('shipped', 'plugin' or 'agent') is not a field of the definition: it is implied by the
 * route the definition registered through, and the caller passes it to the validator.
 */
import { getBudget } from './budgets.js';
import { GATES, isModuleId } from './gates.js';
import { CONTROL_PATTERN } from './logText.js';

/**
 * @typedef {'shipped' | 'plugin' | 'agent'} ScriptSource
 * Where a script's code comes from; implied by the registering route, never a field of the definition.
 */

/**
 * @typedef {'none' | 'api' | 'dom'} ScriptRequires
 * Where a script runs: on the sidecar, on any client endpoint, or on a DOM-capable endpoint.
 */

/**
 * @typedef {object} ScriptDefinition
 * @property {string} name - The MCP tool name.
 * @property {string} version - A semver-like version string, at most 32 characters.
 * @property {string} description - One line, at most 240 characters.
 * @property {object} inputSchema - A JSON Schema object describing the arguments.
 * @property {{ budgetBytes: number }} result - The result limits; `budgetBytes` is the script's own result budget.
 * @property {ScriptRequires} requires - Where the script runs.
 * @property {boolean} mutates - Whether the script changes the world.
 * @property {string} [gate] - A risk gate (a name in `GATES`) that must be open on the executing endpoint.
 * @property {string} [moduleId] - The owning module id of a plugin script.
 */

/**
 * @typedef {object} ScriptRegistryPayload
 * @property {number} apiVersion - Must equal `SCRIPT_API_VERSION`.
 * @property {ScriptDefinition[]} scripts - The endpoint's complete script list.
 */

/**
 * @typedef {{ ok: true, definition: ScriptDefinition, warnings: string[] }
 * | { ok: false, reason: string }} ScriptOutcome
 * The validator's result: a fresh normalized definition and any warnings, or the reason for the refusal.
 */

/**
 * The version of the registry payload and script definition contract; a payload with another value is refused.
 * @type {number}
 */
export const SCRIPT_API_VERSION = 1;

/**
 * The sources a script can come from, in trust order.
 * @type {readonly ScriptSource[]}
 */
export const SCRIPT_SOURCES = Object.freeze([
   'shipped',
   'plugin',
   'agent',
]);

/**
 * The values of a definition's `requires`.
 * @type {readonly ScriptRequires[]}
 */
export const SCRIPT_REQUIRES = Object.freeze([
   'none',
   'api',
   'dom',
]);

/**
 * Names the sidecar registers itself; no script may use them.
 * @type {readonly string[]}
 */
export const RESERVED_SCRIPT_NAMES = Object.freeze(['read_handle']);

/**
 * A shipped or agent tool name: lowercase letters, digits, `_` and `-`, starting with a letter.
 * @type {RegExp}
 */
const CORE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * A plugin tool name: as a core name, but it may start with a digit because a module id can.
 * @type {RegExp}
 */
const PLUGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * The separator between the owner and the skill in plugin and agent tool names.
 * @type {string}
 */
const NAME_SEPARATOR = '__';

/**
 * The name prefix of an agent-saved script.
 * @type {string}
 */
const AGENT_PREFIX = `agent${NAME_SEPARATOR}`;

/**
 * A semver-like version: three numeric parts, optional prerelease and build identifiers.
 * @type {RegExp}
 */
const VERSION_PATTERN = /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Encodes text to UTF-8 to count bytes.
 * @type {TextEncoder}
 */
const ENCODER = new TextEncoder();

/**
 * Read an own property only, so an inherited or polluted field is never taken for client data.
 * @param {object} source - The object to read.
 * @param {string} key - The property name.
 * @returns {unknown} The own value, or undefined when the property is absent or inherited.
 */
function ownValue(source, key) {
   return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Check that a value is a plain object: not null, not an array.
 * @param {unknown} value - The candidate to check.
 * @returns {boolean} Whether it is.
 */
function isRecord(value) {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a refusal.
 * @param {string} reason - The short reason, starting with the field it concerns.
 * @returns {{ ok: false, reason: string }} The refusal.
 */
function refuse(reason) {
   return {
      ok: false,
      reason,
   };
}

/**
 * Check a script name against the rules of its source.
 * @param {unknown} name - The candidate.
 * @param {ScriptSource} source - The source the script registers as.
 * @param {unknown} moduleId - The definition's module id, already checked for a plugin script.
 * @returns {string | null} The reason the name is refused, or null when it is acceptable.
 */
function nameProblem(name, source, moduleId) {
   /** @type {number} The longest name this source may have. */
   const max = getBudget(source === 'shipped' ? 'CORE_TOOL_NAME_MAX_CHARS' : 'PLUGIN_TOOL_NAME_MAX_CHARS').value;
   /** @type {RegExp} The charset this source's names follow. */
   const pattern = source === 'plugin' ? PLUGIN_NAME_PATTERN : CORE_NAME_PATTERN;
   if (typeof name !== 'string' || name.length > max || !pattern.test(name)) {
      return `name must be 1 to ${max} characters of a-z, 0-9, _ or -, starting with a ${
         source === 'plugin' ? 'letter or digit' : 'letter'
      }`;
   }
   if (RESERVED_SCRIPT_NAMES.includes(name) || name in Object.prototype) {
      return 'name is reserved';
   }
   /** @type {string} The prefix a plugin name starts with. */
   const pluginPrefix = `${moduleId}${NAME_SEPARATOR}`;
   if (source === 'plugin' && !(name.startsWith(pluginPrefix) && name.length > pluginPrefix.length)) {
      return `name must be <moduleId>${NAME_SEPARATOR}<skill>`;
   }
   if (source === 'agent' && !(name.startsWith(AGENT_PREFIX) && name.length > AGENT_PREFIX.length)) {
      return `name must be ${AGENT_PREFIX}<name>`;
   }
   return null;
}

/**
 * Measure a tool definition as it is listed: UTF-8 bytes of `{name, description, inputSchema}`.
 * @param {string} name - The tool name.
 * @param {string} description - The one-line text the client lists.
 * @param {unknown} inputSchema - The JSON Schema.
 * @returns {number} The byte length.
 * @throws {TypeError} When the schema cannot be serialized (a cycle or a BigInt).
 */
export function definitionBytes(name, description, inputSchema) {
   return ENCODER.encode(
      JSON.stringify({
         name,
         description,
         inputSchema,
      }),
   ).length;
}

/**
 * Validate one script definition. Reads own properties only and copies the known fields, so nothing of the received
 * object is kept and a getter that throws or a field that cannot be serialized is a refusal, never an exception. Every
 * field is checked for every source; a valid plugin or agent definition is then refused because no route accepts those
 * sources yet.
 * @param {unknown} input - The untrusted definition.
 * @param {ScriptSource} source - The source implied by the route the definition registered through.
 * @returns {ScriptOutcome} A fresh definition (and warnings) or the reason for the refusal.
 */
export function validateScriptDefinition(input, source) {
   try {
      if (typeof source !== 'string' || !SCRIPT_SOURCES.includes(source)) {
         return refuse(`source must be one of ${SCRIPT_SOURCES.join(', ')}`);
      }
      if (!isRecord(input)) {
         return refuse('the definition is not an object');
      }
      /** @type {unknown} The untrusted name. */
      const name = ownValue(input, 'name');
      /** @type {unknown} The untrusted version. */
      const version = ownValue(input, 'version');
      /** @type {unknown} The untrusted description. */
      const description = ownValue(input, 'description');
      /** @type {unknown} The untrusted argument schema. */
      const inputSchema = ownValue(input, 'inputSchema');
      /** @type {unknown} The untrusted result limits. */
      const result = ownValue(input, 'result');
      /** @type {unknown} The untrusted `requires`. */
      const requires = ownValue(input, 'requires');
      /** @type {unknown} The untrusted `mutates`. */
      const mutates = ownValue(input, 'mutates');
      /** @type {unknown} The untrusted gate name. */
      const gate = ownValue(input, 'gate');
      /** @type {unknown} The untrusted module id. */
      const moduleId = ownValue(input, 'moduleId');
      if (source === 'plugin' && !isModuleId(moduleId)) {
         return refuse('moduleId must be a module id for a plugin script');
      }
      if (source !== 'plugin' && moduleId !== undefined) {
         return refuse('moduleId is only allowed on a plugin script');
      }
      /** @type {string | null} The reason the name is refused, if it is. */
      const badName = nameProblem(name, source, moduleId);
      if (badName !== null) {
         return refuse(badName);
      }
      if (
         typeof version !== 'string' ||
         version.length > getBudget('SCRIPT_VERSION_MAX_CHARS').value ||
         !VERSION_PATTERN.test(version)
      ) {
         return refuse(
            `version must be a semver-like string (for example 1.0.0) of at most ${
               getBudget('SCRIPT_VERSION_MAX_CHARS').value
            } characters`,
         );
      }
      /** @type {number} The longest accepted description. */
      const descriptionMax = getBudget('DESCRIPTION_MAX_CHARS').value;
      if (
         typeof description !== 'string' ||
         description.length === 0 ||
         description.length > descriptionMax ||
         CONTROL_PATTERN.test(description)
      ) {
         return refuse(`description must be 1 to ${descriptionMax} characters on one line`);
      }
      if (!isRecord(inputSchema)) {
         return refuse('inputSchema must be an object');
      }
      if (!isRecord(result)) {
         return refuse('result must be an object with budgetBytes');
      }
      /** @type {unknown} The untrusted result budget. */
      const budgetBytes = ownValue(result, 'budgetBytes');
      /** @type {number} The largest result budget a script may declare. */
      const budgetMax = getBudget('RESULT_HARD_CAP_MAX_BYTES').value;
      if (
         typeof budgetBytes !== 'number' ||
         !Number.isInteger(budgetBytes) ||
         budgetBytes < 1 ||
         budgetBytes > budgetMax
      ) {
         return refuse(`result.budgetBytes must be an integer from 1 to ${budgetMax}`);
      }
      if (typeof requires !== 'string' || !SCRIPT_REQUIRES.includes(requires)) {
         return refuse(`requires must be one of ${SCRIPT_REQUIRES.join(', ')}`);
      }
      if (typeof mutates !== 'boolean') {
         return refuse('mutates must be declared as true or false');
      }
      if (
         gate !== undefined &&
         (typeof gate !== 'string' || !Object.hasOwn(GATES, gate) || gate === 'allowedPluginModules')
      ) {
         return refuse('gate must be a registered risk gate other than allowedPluginModules');
      }
      /** @type {number} The listed definition size. */
      let bytes;
      try {
         bytes = definitionBytes(name, description, inputSchema);
      } catch {
         return refuse('inputSchema cannot be serialized');
      }
      /** @type {number} The most bytes a definition may list. */
      const maxDefinition = getBudget('DEFINITION_MAX_BYTES').value;
      if (bytes > maxDefinition) {
         return refuse(`definition is ${bytes} bytes, at most ${maxDefinition} bytes`);
      }
      if (source !== 'shipped') {
         return refuse(`${source} scripts are not supported by this version of Wiretap`);
      }
      /** @type {string[]} Non-fatal findings. */
      const warnings = [];
      /** @type {number} The description length that draws a warning. */
      const target = getBudget('DESCRIPTION_TARGET_CHARS').value;
      if (description.length > target) {
         warnings.push(`description is ${description.length} characters, over the ${target}-character target`);
      }
      /** @type {ScriptDefinition} The normalized copy. */
      const definition = {
         name,
         version,
         description,
         inputSchema,
         result: { budgetBytes },
         requires,
         mutates,
         ...(gate === undefined ? {} : { gate }),
      };
      return {
         ok: true,
         definition,
         warnings,
      };
   } catch {
      return refuse('the definition is unreadable');
   }
}

/**
 * Open a `bridge:registry` payload: an object with the current `apiVersion` and a `scripts` array. Entries are not
 * judged here; callers validate each with `validateScriptDefinition`.
 * @param {unknown} payload - The untrusted payload.
 * @returns {{ ok: true, scripts: unknown[] } | { ok: false, reason: string }} The raw entries or the refusal reason.
 */
export function parseRegistryPayload(payload) {
   try {
      if (!isRecord(payload)) {
         return refuse(`the registry payload must be an object { apiVersion: ${SCRIPT_API_VERSION}, scripts: [...] }`);
      }
      if (ownValue(payload, 'apiVersion') !== SCRIPT_API_VERSION) {
         return refuse(`apiVersion must be ${SCRIPT_API_VERSION}`);
      }
      const scripts = ownValue(payload, 'scripts');
      if (!Array.isArray(scripts)) {
         return refuse('scripts must be an array of script definitions');
      }
      return {
         ok: true,
         scripts,
      };
   } catch {
      return refuse('the registry payload is unreadable');
   }
}
