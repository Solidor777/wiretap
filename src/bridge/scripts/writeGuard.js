/**
 * The write guard: the one place that judges whether a write may go ahead. Every create, update and delete of the
 * core write operations (`writes.js`) calls `guardWrite` for the whole call before any Foundry write API runs, so a
 * refusal leaves the world untouched. The guard applies, in this order:
 *
 * 1. The User password rule: password-named fields of a `User` are refused in data and in paths, whatever the gates.
 * 2. The Wiretap setting rule: a `Setting` whose key lies in the `wiretap.` namespace is refused, whatever the gates
 * (`denyWiretapSettingWrite`); a `Setting` write with no resolvable key is refused.
 * 3. The category gates, judged from THIS client's world settings at call time (`requireGate`): User documents,
 * Setting documents, the module configuration setting, base64 data URIs, ownership changes and compendium writes.
 *
 * The first refusal is thrown as a `GATE_DENIED` script error whose text names the rule or the gate.
 */

import { GATE_DENIED } from '$shared/protocol.js';
import { denyWiretapSettingWrite, normalizeSettingKey, resolveSettingKey } from '$shared/gates.js';
import { requireGate } from '~/bridge/gates.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * Matches a key or path segment that names a password: `password`, `passwordSalt`, `hashedPassword` and the like.
 * @type {RegExp}
 */
const PASSWORD_KEY = /password/i;

/**
 * Matches text that is a base64 data URI, the form the server turns into an uploaded file when it sits in a file-path
 * field.
 * @type {RegExp}
 */
const DATA_URI = /^\s*data:[^,\s]*;base64,/i;

/**
 * The normalized key of the setting that holds the module configuration.
 * @type {string}
 */
const MODULE_CONFIGURATION_KEY = 'core.moduleconfiguration';

/**
 * The path segment and data key that carry document ownership.
 * @type {string}
 */
const OWNERSHIP_KEY = 'ownership';

/**
 * Matches the Foundry operator prefix a data key or path segment may carry (`-=key` deletes, `==key` replaces).
 * @type {RegExp}
 */
const KEY_OPERATOR_PREFIX = /^(?:-=|==)/;

/**
 * Split a data key or a path into the names Foundry reads from it. Foundry expands a dotted key into nested objects
 * before cleaning (`common/utils/helpers.mjs` `expandObjectInPlace`), so `ownership.default` writes `ownership`.
 * @param {string} key - A data key or a dotted path.
 * @returns {string[]} The segments without their operator prefixes.
 */
function namesOf(key) {
   return key.split('.').map((segment) => segment.replace(KEY_OPERATOR_PREFIX, ''));
}

/**
 * Most values the scan visits; a larger tree is treated as holding everything the scan looks for, so it fails closed.
 * @type {number}
 */
export const WRITE_SCAN_NODES_MAX = 200_000;

/**
 * @typedef {object} WriteScan
 * @property {boolean} password - Whether any key names a password.
 * @property {boolean} ownership - Whether any dot-separated segment of a key is `ownership`.
 * @property {boolean} dataUri - Whether any string is a base64 data URI.
 */

/**
 * @typedef {object} WriteIntent
 * @property {string} documentName - The class of the documents written.
 * @property {unknown[]} [values] - The data objects of a create, or the values of the patches of an update.
 * @property {string[]} [paths] - The paths of the patches of an update.
 * @property {unknown[]} [settingTargets] - For a `Setting` write: every key the write would touch, each the key text
 * alone (a value that is not text is refused).
 * @property {boolean} [inPack] - Whether the write lands in a compendium pack.
 */

/**
 * Walk the values written by a call, without recursion, and report what they contain. Visits at most
 * `WRITE_SCAN_NODES_MAX` values; past that the result reports everything, so a huge value cannot hide a field.
 * @param {unknown[]} values - The data objects or patch values.
 * @returns {WriteScan} What the values contain.
 */
export function scanWriteValues(values) {
   /** @type {WriteScan} The findings. */
   const found = {
      password: false,
      ownership: false,
      dataUri: false,
   };
   /** @type {unknown[]} Values still to visit. */
   const pending = [...values];
   /** @type {number} Count of values scanned so far, bounded by the scan limit. */
   let visited = 0;
   while (pending.length > 0) {
      /** @type {unknown} The value to visit. */
      const node = pending.pop();
      visited += 1;
      if (visited > WRITE_SCAN_NODES_MAX) {
         return {
            password: true,
            ownership: true,
            dataUri: true,
         };
      }
      if (typeof node === 'string') {
         if (DATA_URI.test(node)) {
            found.dataUri = true;
         }
      } else if (Array.isArray(node)) {
         for (const member of node) {
            pending.push(member);
         }
      } else if (typeof node === 'object' && node !== null) {
         for (const key of Object.keys(node)) {
            if (PASSWORD_KEY.test(key)) {
               found.password = true;
            }
            if (namesOf(key).includes(OWNERSHIP_KEY)) {
               found.ownership = true;
            }
            pending.push(node[key]);
         }
      }
   }
   return found;
}

/**
 * Build the refusal of a rule that holds whatever the gates say.
 * @param {string} message - The text, at most 256 bytes.
 * @returns {ScriptError} A `GATE_DENIED` error.
 */
function refuse(message) {
   return new ScriptError(GATE_DENIED, message);
}

/**
 * Throw the denial of a gate that is closed.
 * @param {string} name - A gate name from the gate registry.
 * @returns {void}
 * @throws {ScriptError} `GATE_DENIED` naming the gate, when it is closed on this client.
 */
function requireOpen(name) {
   /** @type {ReturnType<typeof requireGate>} The denial, or null when the gate is open. */
   const denial = requireGate(name);
   if (denial !== null) {
      throw refuse(denial.message);
   }
}

/**
 * Judge a write. Returns when the write may go ahead and throws the first refusal otherwise; it never writes.
 * @param {WriteIntent} intent - What the call is about to write.
 * @returns {void}
 * @throws {ScriptError} `GATE_DENIED`: a password field, a Wiretap setting, or a closed gate.
 */
export function guardWrite(intent) {
   /** @type {string} The class written. */
   const documentName = intent.documentName;
   /** @type {string[]} The patch paths of an update. */
   const paths = intent.paths ?? [];
   /** @type {WriteScan} What the written values contain. */
   const scan = scanWriteValues(intent.values ?? []);
   /** @type {string[][]} The segments of every path. */
   const segments = paths.map((path) => namesOf(String(path)));
   if (documentName === 'User') {
      if (scan.password || segments.some((names) => names.some((name) => PASSWORD_KEY.test(name)))) {
         throw refuse('User password fields cannot be written through the bridge, whatever the gate state.');
      }
   }
   /** @type {boolean} Whether a target is the module configuration setting. */
   let moduleConfiguration = false;
   if (documentName === 'Setting') {
      /** @type {unknown[]} The keys the write touches; none is itself a refusal. */
      const targets = intent.settingTargets ?? [];
      if (targets.length === 0) {
         throw refuse(denyWiretapSettingWrite(undefined).message);
      }
      for (const target of targets) {
         /** @type {ReturnType<typeof denyWiretapSettingWrite>} The denial, or null when the key is outside. */
         const denial = denyWiretapSettingWrite(target);
         if (denial !== null) {
            throw refuse(denial.message);
         }
         /** @type {string | null} The key, resolved once more for the module configuration test. */
         const key = resolveSettingKey(target);
         if (key !== null && normalizeSettingKey(key) === MODULE_CONFIGURATION_KEY) {
            moduleConfiguration = true;
         }
      }
   }
   if (documentName === 'User') {
      requireOpen('allowUserWrites');
   }
   if (documentName === 'Setting') {
      requireOpen('allowSettingWrites');
   }
   if (moduleConfiguration) {
      requireOpen('allowModuleConfigWrites');
   }
   if (scan.dataUri) {
      requireOpen('allowFileUpload');
   }
   if (scan.ownership || segments.some((names) => names.includes(OWNERSHIP_KEY))) {
      requireOpen('allowOwnershipWrites');
   }
   if (intent.inPack === true) {
      requireOpen('allowCompendiumWrites');
   }
}
