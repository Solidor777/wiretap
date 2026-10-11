import { GATES, gateDenial, sanitizeGateState } from '$shared/gates.js';

/** @type {string} The settings namespace prefix of every gate setting key. */
const GATE_KEY_PREFIX = 'wiretap.';

/**
 * Split a stored comma-separated module id string into candidate ids. Validation (id shape, length, duplicates, count)
 * is left to `sanitizeGateState`; a non-string value gives an empty list.
 * @param {unknown} stored - The stored value of a `moduleList` gate setting.
 * @returns {string[]} The trimmed, non-empty candidates in stored order.
 */
function splitModuleList(stored) {
   if (typeof stored !== 'string') {
      return [];
   }
   return stored
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
}

/**
 * Read every gate from this client's world settings into a sanitized snapshot. A gate whose read throws, or whose
 * stored value has the wrong type, is closed; the result is always a complete `GateState`.
 * @returns {import('$shared/gates.js').GateState} A fresh snapshot.
 */
export function readGateState() {
   /** @type {Record<string, unknown>} The raw values read from the settings. */
   const raw = {};
   for (const [name, gate] of Object.entries(GATES)) {
      try {
         /** @type {unknown} The stored value of this gate. */
         const stored = game.settings.get('wiretap', name);
         raw[name] = gate.type === 'moduleList' ? splitModuleList(stored) : stored;
      } catch {
         // An unreadable gate is left out of the raw snapshot, so the sanitizer closes it.
      }
   }
   return sanitizeGateState(raw);
}

/**
 * Judge a gate from the world settings of THIS client at call time. The gate value never comes from request params:
 * this is the executing client's own enforcement point, independent of the sidecar's snapshot.
 * @param {string} name - A gate name from the GATES registry.
 * @param {string} [moduleId] - The plugin module id, required for `allowedPluginModules`.
 * @returns {import('$shared/gates.js').GateDenial | null} Null when open, else a denial of at most 256 bytes.
 */
export function requireGate(name, moduleId) {
   return gateDenial(readGateState(), name, moduleId);
}

/**
 * Map a Setting key to the gate it holds.
 * @param {unknown} key - A Setting document key such as `wiretap.allowUserWrites`.
 * @returns {string | null} The gate name, or null when the key is not a Wiretap gate setting.
 */
export function gateNameFromSettingKey(key) {
   if (typeof key !== 'string' || !key.startsWith(GATE_KEY_PREFIX)) {
      return null;
   }
   /** @type {string} The part after the namespace. */
   const name = key.slice(GATE_KEY_PREFIX.length);
   return Object.hasOwn(GATES, name) ? name : null;
}
