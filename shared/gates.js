/**
 * Risk-gate registry and pure gate logic shared by the Foundry client and the Node sidecar. A gate is a world-scope
 * GM setting that unlocks a class of dangerous operation; the client reports its gate values to the sidecar as a
 * `GateState` snapshot. Plain JS with no dependencies.
 */

import { GATE_DENIED } from './protocol.js';

/**
 * @typedef {object} GateEntry
 * @property {'boolean' | 'moduleList'} type - `boolean` is open when true; `moduleList` is open when non-empty.
 * @property {boolean | readonly string[]} default - The closed value.
 * @property {string} unlocks - One line naming what the gate unlocks.
 */

/**
 * @typedef {object} GateState
 * @property {boolean} allowMacroExecution - Macro execution (arbitrary code).
 * @property {boolean} allowUserWrites - Create/update/delete of User documents.
 * @property {boolean} allowSettingWrites - Setting documents and world/user settings.
 * @property {boolean} allowFileUpload - Base64 data in file-path fields and the file upload tool.
 * @property {boolean} allowOwnershipWrites - Writes to the ownership of documents.
 * @property {boolean} allowCompendiumWrites - Writes to compendium packs and their documents.
 * @property {boolean} allowModuleConfigWrites - Writes to the module configuration setting.
 * @property {boolean} allowAgentScripts - Saving and running agent-saved scripts (arbitrary code).
 * @property {string[]} allowedPluginModules - Ids of the modules whose plugin skills and scripts are enabled.
 */

/**
 * @typedef {object} GateDenial
 * @property {'GATE_DENIED'} code - Always the GATE_DENIED protocol code.
 * @property {string} message - Names the gate (or the refused write), at most 256 bytes.
 */

// Maximum number of module ids in a snapshot's `allowedPluginModules`; a longer list is treated as empty.
export const GATE_MODULES_MAX = 64;

// Maximum length in characters of one module id in `allowedPluginModules`; a longer id is dropped.
export const GATE_MODULE_ID_MAX_CHARS = 64;

// The shape of a Foundry module id: lowercase letters, digits, underscore and hyphen, starting with a letter or digit.
// Any other string is not a module id and is dropped from `allowedPluginModules`.
const MODULE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

// The Foundry setting namespace that holds the gates; no write path may touch a setting in it.
const WIRETAP_NAMESPACE = 'wiretap';

// Format and control characters (zero-width joiners, byte-order marks, NUL and the like) removed before a setting key
// is compared, so an invisible character cannot hide the namespace.
const INVISIBLE_CHARACTERS = /[\p{Cc}\p{Cf}]/gu;

// Whitespace removed before a setting key is compared.
const WHITESPACE = /\s/gu;

/**
 * Build one frozen registry entry.
 * @param {GateEntry['type']} type - The gate type.
 * @param {GateEntry['default']} defaultValue - The closed value.
 * @param {string} unlocks - One line naming what the gate unlocks.
 * @returns {Readonly<GateEntry>} The frozen entry.
 */
function entry(type, defaultValue, unlocks) {
   return Object.freeze({ type, default: defaultValue, unlocks });
}

/**
 * The gate registry: the one definition of every gate name, type, default and unlock description. Every gate defaults
 * closed. There is deliberately no delete gate and no undo gate.
 * @type {Readonly<Record<string, GateEntry>>}
 */
export const GATES = Object.freeze({
   allowMacroExecution: entry('boolean', false, 'Running macros through execute_macro (arbitrary code).'),
   allowUserWrites: entry('boolean', false, 'Creating, updating and deleting User documents, roles included.'),
   allowSettingWrites: entry('boolean', false, 'Writing Setting documents and world or user settings.'),
   allowFileUpload: entry('boolean', false, 'Base64 data in file-path fields and the file upload tool.'),
   allowOwnershipWrites: entry('boolean', false, 'Changing the ownership of documents.'),
   allowCompendiumWrites: entry('boolean', false, 'Writing compendium packs and the documents inside them.'),
   allowModuleConfigWrites: entry('boolean', false, 'Writing the module configuration (enables and disables modules).'),
   allowAgentScripts: entry('boolean', false, 'Saving, disabling and running agent-saved scripts (arbitrary code).'),
   allowedPluginModules: entry(
      'moduleList',
      Object.freeze([]),
      'Plugin skills and scripts of the listed module ids; none by default.',
   ),
});

/**
 * Build a snapshot with every gate closed.
 * @returns {GateState} A fresh all-closed snapshot; its list is not shared.
 */
export function closedGateState() {
   /** @type {Record<string, boolean | string[]>} The snapshot under construction. */
   const state = {};
   for (const [name, gate] of Object.entries(GATES)) {
      state[name] = gate.type === 'moduleList' ? [] : gate.default;
   }
   return /** @type {GateState} */ (state);
}

/**
 * Reduce an untrusted value to a valid module id list: an array of at most `GATE_MODULES_MAX` entries, keeping the
 * module ids (MODULE_ID_PATTERN, 1 to `GATE_MODULE_ID_MAX_CHARS` characters) without duplicates. A longer array is
 * treated as empty without being walked.
 * @param {unknown} value - The untrusted value.
 * @returns {string[]} A fresh, valid list.
 */
function sanitizeModuleList(value) {
   if (!Array.isArray(value) || value.length > GATE_MODULES_MAX) {
      return [];
   }
   /** @type {Set<string>} The accepted ids in first-seen order. */
   const ids = new Set();
   for (const id of value) {
      if (typeof id === 'string' && id.length <= GATE_MODULE_ID_MAX_CHARS && MODULE_ID_PATTERN.test(id)) {
         ids.add(id);
      }
   }
   return [...ids];
}

/**
 * Reduce an untrusted snapshot to a valid `GateState`. Only registry gate names are read, each only as an own
 * property and only when it has the registry type; every other key and every wrong-typed value is dropped, and a gate
 * with no valid value is closed. The result is always a new object holding every gate; an input whose reads throw
 * gives the all-closed snapshot.
 * @param {unknown} input - The untrusted snapshot.
 * @returns {GateState} The sanitized snapshot.
 */
export function sanitizeGateState(input) {
   const state = closedGateState();
   if (typeof input !== 'object' || input === null) {
      return state;
   }
   try {
      for (const [name, gate] of Object.entries(GATES)) {
         if (!Object.hasOwn(input, name)) {
            continue;
         }
         /** @type {unknown} The untrusted value of this gate. */
         const value = input[name];
         if (gate.type === 'moduleList') {
            state[name] = sanitizeModuleList(value);
         } else if (typeof value === 'boolean') {
            state[name] = value;
         }
      }
   } catch {
      // A hostile object whose reads throw is never partially trusted: every gate stays closed.
      return closedGateState();
   }
   return state;
}

/**
 * Build the denial for a gate that is not open.
 * @param {string} name - A gate name that exists in the registry.
 * @param {string} detail - What was missing: `is closed` or `does not list this module`.
 * @returns {GateDenial} A GATE_DENIED denial that names the gate.
 */
function closedDenial(name, detail) {
   return {
      code: GATE_DENIED,
      message: `Gate ${name} ${detail}: only a GM can enable it in the Wiretap module settings.`,
   };
}

/**
 * Decide whether a gate is open in a snapshot. The snapshot is always sanitized first, so a missing or non-object
 * snapshot, a wrong-typed value, an invalid or oversized module list and an unknown gate name all deny. The
 * `allowedPluginModules` gate is open only for a module id that the sanitized list contains; without a module id it is
 * closed. `moduleId` is ignored for every other gate.
 * @param {unknown} gateState - The snapshot to judge (not required to be sanitized).
 * @param {string} name - The registry name of the gate to judge.
 * @param {string} [moduleId] - The module whose plugin skills or scripts are being run.
 * @returns {GateDenial | null} Null when open, else a denial under 256 bytes: only a GM can enable the gate.
 */
export function gateDenial(gateState, name, moduleId) {
   if (typeof name !== 'string' || !Object.hasOwn(GATES, name)) {
      return {
         code: GATE_DENIED,
         message: 'Unknown gate is denied: only a GM can enable gates in the Wiretap module settings.',
      };
   }
   /** @type {Record<string, unknown>} The snapshot reduced to registry names and types. */
   const clean = sanitizeGateState(gateState);
   if (GATES[name].type === 'moduleList') {
      /** @type {boolean} Whether the sanitized list names the module. */
      const listed = typeof moduleId === 'string' && clean[name].includes(moduleId);
      return listed ? null : closedDenial(name, 'does not list this module');
   }
   return clean[name] === true ? null : closedDenial(name, 'is closed');
}

/**
 * Decide whether a gate is open in a snapshot.
 * @param {unknown} gateState - The snapshot to judge.
 * @param {string} name - The registry name of the gate to judge.
 * @param {string} [moduleId] - The module id, required for `allowedPluginModules`.
 * @returns {boolean} True when `gateDenial` would return null.
 */
export function isGateOpen(gateState, name, moduleId) {
   return gateDenial(gateState, name, moduleId) === null;
}

/**
 * Decide whether a plugin module is enabled in a snapshot.
 * @param {unknown} gateState - The snapshot to judge.
 * @param {unknown} moduleId - The id of the plugin module to look up.
 * @returns {boolean} True when the sanitized `allowedPluginModules` list contains the id.
 */
export function isModuleAllowed(gateState, moduleId) {
   return isGateOpen(gateState, 'allowedPluginModules', /** @type {string} */ (moduleId));
}

/**
 * Decide whether a Setting key is in the Wiretap namespace. The key is normalized before comparing: NFKC, then
 * whitespace, control and format characters removed, then lowercased, so case, padding, zero-width characters and
 * compatibility forms (full-width letters, full-width dot) cannot hide it. Both the bare namespace and any
 * `wiretap.`-prefixed key match.
 * @param {unknown} key - The Setting key; a non-string never matches.
 * @returns {boolean} True when the key is the namespace or lies inside it.
 */
export function isWiretapSettingKey(key) {
   if (typeof key !== 'string') {
      return false;
   }
   /** @type {string} The key reduced to its comparable form. */
   const normal = key.normalize('NFKC').replace(INVISIBLE_CHARACTERS, '').replace(WHITESPACE, '').toLowerCase();
   return normal === WIRETAP_NAMESPACE || normal.startsWith(`${WIRETAP_NAMESPACE}.`);
}

/**
 * Resolve the Setting key a write targets, reading each property of the input exactly once and never throwing. A string
 * is the key. An object supplies `key`; when it also supplies `namespace` (it must be a string) the key is
 * `${namespace}.${key}`. Anything else, a non-string part, or a read that throws gives null.
 * Contract for write paths: write the returned string and nothing re-read from the input; resolve a by-id update to its
 * key first (a payload with only `_id` resolves to null and is denied); pass a namespaced setting as
 * `{ namespace, key }`.
 * @param {unknown} documentOrKey - A Setting key, or a Setting document or data object.
 * @returns {string | null} The key that is checked and must be written, or null when none can be read.
 */
export function resolveSettingKey(documentOrKey) {
   try {
      if (typeof documentOrKey === 'string') {
         return documentOrKey;
      }
      if (typeof documentOrKey !== 'object' || documentOrKey === null) {
         return null;
      }
      /** @type {unknown} The key, read once. */
      const key = documentOrKey.key;
      /** @type {unknown} The namespace, read once. */
      const namespace = documentOrKey.namespace;
      if (typeof key !== 'string') {
         return null;
      }
      if (namespace === undefined) {
         return key;
      }
      return typeof namespace === 'string' ? `${namespace}.${key}` : null;
   } catch {
      return null;
   }
}

/**
 * The rule every write path applies to Setting writes, whatever the gate state: a Wiretap setting cannot be written,
 * so no skill can change a gate. Fails closed and never throws: input whose key cannot be resolved by
 * `resolveSettingKey` is refused. The key is resolved once; callers must write the string `resolveSettingKey` returns.
 * @param {unknown} documentOrKey - A Setting key, or a Setting document or data object (see `resolveSettingKey`).
 * @returns {GateDenial | null} Null when the write goes on to the other checks, else a denial under 256 bytes.
 */
export function denyWiretapSettingWrite(documentOrKey) {
   /** @type {string | null} The key that would be written. */
   const key = resolveSettingKey(documentOrKey);
   if (key !== null && !isWiretapSettingKey(key)) {
      return null;
   }
   return {
      code: GATE_DENIED,
      message: 'Wiretap settings cannot be written through the bridge: only a GM can change them in the settings UI.',
   };
}
