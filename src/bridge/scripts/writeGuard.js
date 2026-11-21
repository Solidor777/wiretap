/**
 * The write guard: the one place that judges whether a write may go ahead. Every create, update and delete of the
 * core write operations (`writes.js`) calls `guardWrite` for the whole call before any Foundry write API runs, so a
 * refusal leaves the world untouched. The guard applies, in this order:
 *
 * 1. The operator rule: a key or value in the written data that spells an update operator (a `==` or `-=` key prefix, a
 * `__$OPERATOR$__` object, an operator object) is refused. Operators exist only through the `op` field of a patch,
 * and the guard sees them in the CLEANED changes (`targets`), where every spelling has become an operator object.
 * 2. The flag rule: the `flags.wiretap` scope is never written, and `flags` is never rewritten as a whole.
 * 3. The User password rule: password-named fields of a `User` are refused, whatever the gates.
 * 4. The Wiretap setting rule: a `Setting` whose key lies in the `wiretap.` namespace is refused, whatever the gates
 * (`denyWiretapSettingWrite`); a `Setting` write with no resolvable key is refused.
 * 5. The category gates, judged from THIS client's world settings at call time (`requireGate`): User documents,
 * Setting documents, the module configuration setting, base64 data URIs, ownership changes, macro code
 * (`allowMacroExecution`: a Macro `command`, a Macro `type` changed to `script`, an Adventure's stored `macros`, a
 * region behavior of type `executeScript` at any nesting, all code that later runs), compendium writes and, for a call
 * that is not a `dryRun`, deleting (`allowDelete`) and replacing
 * (`allowReplace`) documents. The risky operations come from the `operations` the caller names and from the operators
 * of the cleaned `targets`, judged by the schema field they land on (`writeFields.js`).
 *
 * The first refusal is thrown as a `GATE_DENIED` script error whose text names the rule or the gate.
 */

import {
   FLAG_SCOPE,
   FLAGS_KEY,
   OPERATOR_IDENTIFIER,
   hasOperatorSegment,
   isOperatorWrapper,
   keyNames,
} from '$shared/writeKeys.js';
import { GATE_DENIED } from '$shared/protocol.js';
import { denyWiretapSettingWrite, normalizeSettingKey, resolveSettingKey } from '$shared/gates.js';
import { requireGate } from '~/bridge/gates.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { analyzeChanges, isOperatorObject, isPlainObject, walkEmbedded } from '~/bridge/scripts/writeFields.js';

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
 * The Macro type whose `command` runs as code; a `chat` Macro sends its command as a chat message.
 * @type {string}
 */
const SCRIPT_MACRO_TYPE = 'script';

/**
 * The document class of a region behavior.
 * @type {string}
 */
const REGION_BEHAVIOR = 'RegionBehavior';

/**
 * The RegionBehavior type whose `system.source` runs as code when the region's events fire.
 * @type {string}
 */
const SCRIPT_BEHAVIOR_TYPE = 'executeScript';

/**
 * Tell whether any of some objects holds a top-level key whose first segment, read by `keyNames`, is a name. A dotted
 * key counts by its first segment because Foundry expands it into that field.
 * @param {Record<string, unknown>[]} objects - Data objects, patch objects or cleaned changes.
 * @param {string} name - The top-level field a key must write, such as `command`.
 * @returns {boolean} True when a key writes the field.
 */
function writesField(objects, name) {
   return objects.some((object) => Object.keys(object).some((key) => keyNames(key)[0] === name));
}

/**
 * Tell whether a write sets macro code, which runs when a user executes the macro: a Macro `command` (any value and
 * any op), a Macro `type` changed to `script` in the cleaned changes from another stored type (stored text becomes
 * code; a deleted `type` resets to `chat`), or an Adventure's stored `macros` (importing the adventure creates those
 * Macros).
 * @param {WriteIntent} intent - What the call is about to write.
 * @returns {boolean} True when the write needs `allowMacroExecution`.
 */
function writesMacroCode(intent) {
   /** @type {Record<string, unknown>[]} The raw values and the cleaned changes of every target. */
   const objects = [
      ...(intent.values ?? []),
      ...(intent.targets ?? []).map((target) => target.changes),
   ];
   if (intent.documentName === 'Adventure') {
      return writesField(objects, 'macros');
   }
   if (intent.documentName !== 'Macro') {
      return false;
   }
   return (
      writesField(objects, 'command') ||
      (intent.targets ?? []).some(
         (target) =>
            target.document._source?.type !== SCRIPT_MACRO_TYPE &&
            Object.entries(target.changes).some(
               ([key, value]) =>
                  keyNames(key)[0] === 'type' &&
                  foundry.data.operators.DataFieldOperator.get(value) === SCRIPT_MACRO_TYPE,
            ),
      )
   );
}

/**
 * Copy written data with every update operator replaced by what it writes: a `ForcedReplacement` by its value and a
 * `ForcedDeletion` by null, so the key it deletes still counts as written. An empty element of an array becomes an
 * empty object, because `walkEmbedded` reads the `_id` of every element of an embedded collection.
 * @param {unknown} value - Create data, replace data or cleaned changes.
 * @returns {unknown} The copy, free of operator objects.
 */
function writtenData(value) {
   if (value instanceof foundry.data.operators.ForcedDeletion) {
      return null;
   }
   if (isOperatorObject(value)) {
      return writtenData(foundry.data.operators.DataFieldOperator.get(value));
   }
   if (Array.isArray(value)) {
      return value.map((member) => (member === null || member === undefined ? {} : writtenData(member)));
   }
   if (isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([key, member]) => [key, writtenData(member)]));
   }
   return value;
}

/**
 * Tell whether the data written to one RegionBehavior stores script code: the behavior becomes of type
 * `executeScript` (created so, or changed to it from another stored type), or a behavior of that type has its
 * `system.source` written. This follows the rule Foundry applies with its `MACRO_SCRIPT` permission
 * (`common/documents/region-behavior.mjs`, `region.mjs`) with one difference: without that permission Foundry also
 * refuses a write that re-states the `executeScript` type of a behavior already of that type, while this rule allows
 * it, the same change-only type rule as for Macros.
 * @param {Record<string, unknown>} data - The data written to the behavior, operators replaced by `writtenData`.
 * @param {Record<string, unknown> | undefined} stored - The stored source of the behavior, none for a new one.
 * @returns {boolean} True when the write stores script code.
 */
function storesBehaviorScript(data, stored) {
   /** @type {unknown} The type the behavior has after the write. */
   const type = 'type' in data ? data.type : stored?.type;
   if (type !== SCRIPT_BEHAVIOR_TYPE) {
      return false;
   }
   return stored?.type !== SCRIPT_BEHAVIOR_TYPE || (isPlainObject(data.system) && 'source' in data.system);
}

/**
 * Tell whether a write stores the code of a script region behavior anywhere in the data it writes: a RegionBehavior
 * itself, the behaviors of a Region, the regions of a Scene, or the stored scenes of an Adventure. Each written
 * behavior is paired with its stored source through the schema (`walkEmbedded`). An update is read from its cleaned
 * changes, which hold every patch expanded against the live document; a create or replace is read from its data.
 * @param {WriteIntent} intent - What the call is about to write.
 * @returns {boolean} True when the write needs `allowMacroExecution`.
 */
function writesRegionScript(intent) {
   /** @type {Array<{ model: object, data: unknown, stored: Record<string, unknown> | undefined }>} Each data tree. */
   const trees =
      intent.targets === undefined
         ? (intent.values ?? []).map((value) => ({
            model: CONFIG[intent.documentName].documentClass,
            data: writtenData(value),
            stored: undefined,
         }))
         : intent.targets.map((target) => ({
            model: target.document.constructor,
            data: writtenData(target.changes),
            stored: target.document._source,
         }));
   /** @type {boolean} Whether a written behavior stores script code. */
   let found = false;
   for (const tree of trees) {
      walkEmbedded(tree.model, tree.data, tree.stored, (model, data, stored) => {
         found ||= model.documentName === REGION_BEHAVIOR && storesBehaviorScript(data, stored);
      });
   }
   return found;
}

/**
 * Tell whether the names of a key or path hold the reserved flag scope: `flags` followed by `wiretap`.
 * @param {string[]} names - The segments from `keyNames`.
 * @returns {boolean} True when `flags.wiretap` appears in the names.
 */
function namesReserveFlagScope(names) {
   return names.some((name, index) => name === FLAGS_KEY && names[index + 1] === FLAG_SCOPE);
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
 * @property {boolean} wiretapFlag - Whether any key reaches the reserved `flags.wiretap` scope, dotted or nested, or
 * blanks the whole `flags` object, which would erase the scope with it.
 * @property {boolean} operator - Whether any key or value spells an update operator: a key prefix, a serialized
 * operator or an operator object. Always false when the scan reads cleaned changes (`operators` other than
 * `'refuse'`).
 */

/**
 * @typedef {object} WriteIntent
 * @property {string} documentName - The class of the documents written.
 * @property {unknown[]} [values] - The data objects of a create, or the values of the patches of an update.
 * @property {Array<{ document: object, changes: Record<string, unknown> }>} [targets] - For an update: each live
 * document written and its changes after `cleanChanges`, which carry the operators of the patches as operator objects.
 * @property {unknown[]} [settingTargets] - For a `Setting` write: every key the write would touch, each the key text
 * alone (a value that is not text is refused).
 * @property {boolean} [inPack] - Whether the write lands in a compendium pack.
 * @property {Array<'delete' | 'replace'>} [operations] - The risky operations the call performs; each needs its own
 * gate (`allowDelete`, `allowReplace`).
 * @property {boolean} [dryRun] - Whether the call only previews; a preview needs none of the `operations` gates.
 */

/**
 * Walk the values written by a call, without recursion, and report what they contain. Visits at most
 * `WRITE_SCAN_NODES_MAX` values; past that the result reports everything, so a huge value cannot hide a field.
 * @param {unknown[]} values - The data objects or patch values.
 * @param {object} [options] - How to read operators.
 * @param {'refuse' | 'descend' | 'skip'} [options.operators] - How an operator object is read. `refuse` (raw values)
 * reports it. For cleaned changes: `descend` looks through it, `skip` does not enter it, because cleaning fills the
 * defaults of the field inside an operator value.
 * @returns {WriteScan} What the values contain.
 */
export function scanWriteValues(values, { operators = 'refuse' } = {}) {
   /** @type {WriteScan} The findings. */
   const found = {
      password: false,
      ownership: false,
      dataUri: false,
      wiretapFlag: false,
      operator: false,
   };
   /**
    * Values still to visit, each with whether it sits directly under a `flags` key.
    * @type {Array<{ node: unknown, underFlags: boolean }>}
    */
   const pending = values.map((node) => ({
      node,
      underFlags: false,
   }));
   /** @type {number} Count of values scanned so far, bounded by the scan limit. */
   let visited = 0;
   while (pending.length > 0) {
      /** @type {{ node: unknown, underFlags: boolean }} The entry to visit. */
      const entry = pending.pop();
      /** @type {unknown} The value to visit. */
      const node = entry.node;
      visited += 1;
      if (visited > WRITE_SCAN_NODES_MAX) {
         return {
            password: true,
            ownership: true,
            dataUri: true,
            wiretapFlag: true,
            operator: true,
         };
      }
      if (isOperatorObject(node)) {
         if (operators === 'descend') {
            pending.push({
               node: foundry.data.operators.DataFieldOperator.get(node),
               underFlags: entry.underFlags,
            });
         } else if (operators === 'refuse') {
            found.operator = true;
         }
      } else if (typeof node === 'string') {
         if (DATA_URI.test(node)) {
            found.dataUri = true;
         }
      } else if (Array.isArray(node)) {
         for (const member of node) {
            pending.push({
               node: member,
               underFlags: false,
            });
         }
      } else if (typeof node === 'object' && node !== null) {
         if (isOperatorWrapper(node)) {
            found.operator = true;
         }
         for (const key of Object.keys(node)) {
            /** @type {string[]} The segments the key expands to. */
            const names = keyNames(key);
            if (PASSWORD_KEY.test(key)) {
               found.password = true;
            }
            if (names.includes(OWNERSHIP_KEY)) {
               found.ownership = true;
            }
            if (hasOperatorSegment(key)) {
               found.operator = true;
            }
            if (
               namesReserveFlagScope(names) ||
               (entry.underFlags && names[0] === FLAG_SCOPE) ||
               (names.at(-1) === FLAGS_KEY && !isPlainObject(node[key]) && !isOperatorObject(node[key]))
            ) {
               found.wiretapFlag = true;
            }
            pending.push({
               node: node[key],
               underFlags: names.at(-1) === FLAGS_KEY,
            });
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
 * @throws {ScriptError} `GATE_DENIED`: an operator spelling, a password field, the reserved flag scope, a Wiretap
 * setting, or a closed gate (a category gate, `allowMacroExecution` for macro or region script code, `allowDelete` or
 * `allowReplace`).
 */
export function guardWrite(intent) {
   /** @type {string} The class written. */
   const documentName = intent.documentName;
   /** @type {WriteScan} What the written values contain. */
   const scan = scanWriteValues(intent.values ?? []);
   /** @type {Set<string>} The risky operations the call performs. */
   const risky = new Set(intent.operations ?? []);
   /** @type {boolean} Whether the cleaned changes rewrite `flags` or the reserved scope. */
   let reservedFlags = false;
   for (const target of intent.targets ?? []) {
      /** @type {ReturnType<typeof analyzeChanges>} What the operators of the cleaned changes do. */
      const analysis = analyzeChanges(target.document, target.changes);
      for (const operation of analysis.operations) {
         risky.add(operation);
      }
      reservedFlags ||= analysis.reservedFlags;
      // The cleaned changes are read twice. The flag scope is read through operator values, where it can hide. The
      // other keys are read outside them, because cleaning fills the defaults of a field inside an operator value.
      scan.wiretapFlag ||= scanWriteValues([target.changes], { operators: 'descend' }).wiretapFlag;
      /** @type {WriteScan} What the cleaned changes hold outside operator values. */
      const cleaned = scanWriteValues([target.changes], { operators: 'skip' });
      scan.password ||= cleaned.password;
      scan.ownership ||= cleaned.ownership;
      scan.dataUri ||= cleaned.dataUri;
   }
   if (scan.operator) {
      throw refuse(`Written data may not spell an update operator (== or -= keys, ${OPERATOR_IDENTIFIER}); use op.`);
   }
   if (scan.wiretapFlag || reservedFlags) {
      throw refuse('The flag scope flags.wiretap is reserved for Wiretap records and cannot be written.');
   }
   if (documentName === 'User' && scan.password) {
      throw refuse('User password fields cannot be written through the bridge, whatever the gate state.');
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
   /** @type {Set<string>} The risky operations that need a gate now: none for a preview. */
   const operations = intent.dryRun === true ? new Set() : risky;
   if (operations.has('delete')) {
      requireOpen('allowDelete');
   }
   if (operations.has('replace')) {
      requireOpen('allowReplace');
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
   if (scan.ownership) {
      requireOpen('allowOwnershipWrites');
   }
   if (writesMacroCode(intent) || writesRegionScript(intent)) {
      requireOpen('allowMacroExecution');
   }
   if (intent.inPack === true) {
      requireOpen('allowCompendiumWrites');
   }
}
