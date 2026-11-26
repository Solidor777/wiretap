import { GATES, gateDenial, isModuleId, sanitizeGateState } from '$shared/gates.js';
import { cleanForLog } from '$shared/logText.js';

/** @type {string} The settings namespace prefix of every gate setting key. */
const GATE_KEY_PREFIX = 'wiretap.';

/**
 * Longest stored module list entry named in a notice, in UTF-8 bytes.
 * @type {number}
 */
const ENTRY_LOG_MAX_BYTES = 64;

/**
 * The stored value of each `moduleList` gate last judged, so each dropped entry is logged once per stored value and
 * not on every gate read.
 * @type {Map<string, unknown>}
 */
const lastJudgedLists = new Map();

/**
 * Log, once per stored value, each entry of a `moduleList` gate that `sanitizeGateState` drops because it is not a
 * module id. The GM is the only one who can fix the setting, so the notice is a log line.
 * @param {string} name - The gate name.
 * @param {unknown} stored - The stored value of the gate setting.
 * @param {string[]} candidates - The entries split from it.
 * @returns {void}
 */
function noticeDroppedEntries(name, stored, candidates) {
   if (lastJudgedLists.has(name) && lastJudgedLists.get(name) === stored) {
      return;
   }
   lastJudgedLists.set(name, stored);
   for (const candidate of candidates) {
      if (!isModuleId(candidate)) {
         console.warn(
            `Wiretap | ${name} ignores "${cleanForLog(candidate, ENTRY_LOG_MAX_BYTES)}": a module id holds only `
               + 'letters, digits, _ and -.',
         );
      }
   }
}

/**
 * Split a stored comma-separated module id string into candidate ids. Validation (id shape and duplicates) is left to
 * `sanitizeGateState`; a non-string value gives an empty list.
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
 * stored value has the wrong type, is closed; the result is always a complete `GateState`. A module list entry that
 * is not a module id is dropped and logged (see `noticeDroppedEntries`).
 * @returns {import('$shared/gates.js').GateState} A fresh snapshot.
 */
export function readGateState() {
   /** @type {Record<string, unknown>} The raw values read from the settings. */
   const raw = {};
   for (const [name, gate] of Object.entries(GATES)) {
      try {
         /** @type {unknown} The stored value of this gate. */
         const stored = game.settings.get('wiretap', name);
         if (gate.type === 'moduleList') {
            /** @type {string[]} The entries of the stored list. */
            const candidates = splitModuleList(stored);
            noticeDroppedEntries(name, stored, candidates);
            raw[name] = candidates;
         } else {
            raw[name] = stored;
         }
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
