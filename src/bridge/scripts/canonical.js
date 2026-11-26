/**
 * The canonical document representation and document resolution used by the read scripts. One function produces the
 * stable export of a document (primary, embedded or compendium); the exclusions apply here, at the source, so every
 * read path (compact view, projection, path slices, full export) sees data without the excluded fields:
 *
 * - A `Setting` document is unreadable when its key is in the `wiretap.` namespace (the gates live there), is a core
 * setting that holds credentials (`SECRET_CORE_SETTINGS`) or names a secret (`SECRET_SETTING_KEY`).
 * - The password fields of a `User` (`password`, `passwordSalt`) are removed from the export. A path that names one
 * therefore resolves to nothing and is reported in `missing`, never as a value.
 * - Every key whose name matches `SECRET_KEY` is dropped from the free-form data of the export: the `value` of a
 * `Setting` (stored as JSON text) and every `flags` object of the export, so a User's flags and the module flags of
 * any document are covered. Core schema fields and system data are not redacted: core names such as `prototypeToken`
 * match the pattern. The walk is bounded and drops what it cannot finish walking; the export then carries
 * `partial: true`, which every read and read-back path passes on in its reply.
 *
 * The backup export (`exportForBackup`) applies the same exclusions and also reports the paths they changed. It
 * refuses a document the walk cut at a bound, because a backup must hold every document whole.
 */

import { cleanForLog } from '$shared/logText.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * Longest caller-supplied text echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const ECHO_MAX_BYTES = 48;

/**
 * The namespace prefix of this module's settings, compared in lower case.
 * @type {string}
 */
export const WIRETAP_SETTING_PREFIX = 'wiretap.';

/**
 * Core setting keys (`core.<name>`) whose value holds credentials, compared in lower case. Evidence:
 * `client/av/settings.mjs` defines the `world.turn` schema with `username` and `password` (lines 97-102) and registers
 * it as the world setting `core.rtcWorldSettings` (lines 162-167). The other core settings registered in the Foundry
 * client hold interface, canvas, sheet and keybinding preferences.
 * @type {readonly string[]}
 */
export const SECRET_CORE_SETTINGS = Object.freeze(['core.rtcworldsettings']);

/**
 * Key names dropped from free-form data. Limitations: it matches by name only, so a secret under another name stays
 * readable, and it also matches ordinary names that contain a fragment (`bypass`, `passive`, `tokenId`).
 * @type {RegExp}
 */
export const SECRET_KEY = /pass(word|phrase)?|secret|token|api[-_]?key|credential|private[-_]?key/i;

/**
 * Setting keys that name a secret. Narrower than `SECRET_KEY` because a bare `token` would refuse ordinary core
 * settings such as `core.tokenAutoRotate`.
 * @type {RegExp}
 */
export const SECRET_SETTING_KEY =
   /pass(word|phrase)|secret|api[-_]?key|credential|private[-_]?key|(auth|access|api|bearer|refresh)[-_]?token/i;

/**
 * Deepest level the redaction walk enters; a deeper subtree is dropped and the export is marked partial.
 * @type {number}
 */
export const REDACT_MAX_DEPTH = 24;

/**
 * Deepest nesting of JSON held in strings the redaction walk opens; deeper text is dropped and the export is marked
 * partial. Each level of nesting doubles the escaping, so real data never nests far.
 * @type {number}
 */
export const REDACT_MAX_STRING_NESTING = 4;

/**
 * Most nodes the redaction walk visits per export; the remainder is dropped and the export is marked partial.
 * @type {number}
 */
export const REDACT_MAX_NODES = 50000;

/**
 * The `User` fields that hold or derive from a password; removed from every export.
 * @type {readonly string[]}
 */
export const USER_EXCLUDED_FIELDS = Object.freeze([
   'password',
   'passwordSalt',
]);

/**
 * @typedef {object} ExportOptions
 * @property {boolean} [derived] - Export the prepared data (`toObject(false)`) instead of the stored data.
 */

/**
 * @typedef {{ ok: true, data: Record<string, unknown>, partial?: true } | { ok: false, code: string, message: string }}
 * ExportOutcome
 * `partial` is set when the redaction walk dropped part of the document at a bound, so the data does not hold it whole.
 */

/**
 * @typedef {object} RedactBudget
 * @property {number} nodes - The objects and lists the walk may still visit.
 * @property {number} nesting - How many JSON texts the walk has opened around the current one.
 * @property {boolean} cut - Set when the walk dropped something at a bound (nodes, depth or text nesting); a key
 * dropped because it names a secret does not set it.
 */

/**
 * Create a fresh budget for one redaction walk.
 * @returns {RedactBudget} The full budget, with nothing cut.
 */
function newBudget() {
   return {
      nodes: REDACT_MAX_NODES,
      nesting: 0,
      cut: false,
   };
}

/**
 * @typedef {object} DocumentReference
 * @property {string} [uuid] - A full document uuid; excludes the other fields.
 * @property {string} [documentName] - The document class name, with `id`.
 * @property {string} [id] - The document id, with `documentName`.
 * @property {string} [parentUuid] - The uuid of the parent of an embedded document.
 * @property {string} [pack] - The id of the compendium pack holding the document.
 */

/**
 * Convert a value to plain JSON data: a `Set` becomes an array and anything that is not JSON data is dropped, the way
 * `JSON.stringify` drops it.
 * @param {unknown} value - The value to convert.
 * @returns {Record<string, unknown>} A deep plain copy.
 * @throws {Error} When the value cannot be serialized (a cycle or a BigInt).
 */
function toPlain(value) {
   return JSON.parse(JSON.stringify(value, (key, member) => (member instanceof Set ? Array.from(member) : member)));
}

/**
 * Judge whether a document may be read at all.
 * @param {{ documentName?: unknown, key?: unknown }} document - A document or a stand-in for one.
 * @returns {{ code: string, message: string } | null} The refusal, or null when the document is readable.
 */
export function unreadable(document) {
   if (document.documentName !== 'Setting') {
      return null;
   }
   // A key that is not text cannot be shown to be outside the namespace, so it is refused.
   if (typeof document.key !== 'string' || document.key.toLowerCase().startsWith(WIRETAP_SETTING_PREFIX)) {
      return {
         code: 'DOC_EXCLUDED',
         message: 'Settings in the wiretap namespace are not readable.',
      };
   }
   if (SECRET_CORE_SETTINGS.includes(document.key.toLowerCase()) || SECRET_SETTING_KEY.test(document.key)) {
      return {
         code: 'DOC_EXCLUDED',
         message: 'This setting holds credentials and is not readable.',
      };
   }
   return null;
}

/**
 * Matches the start of text that may be JSON holding an object, a list or a nested JSON string.
 * @type {RegExp}
 */
const JSON_START = /^\s*[{["]/;

/**
 * Redact text that holds JSON: parse it, drop the secret-named keys and serialize it again. Text that is not JSON, or
 * is JSON without an object, a list or a nested JSON string, is returned as it is.
 * @param {string} text - The text to redact.
 * @param {RedactBudget} budget - The remaining budget of the walk.
 * @param {number} depth - How many levels deep the text sits.
 * @returns {string | null} The redacted text, or null when it lies beyond a bound.
 */
function redactText(text, budget, depth) {
   if (depth > REDACT_MAX_DEPTH || budget.nesting >= REDACT_MAX_STRING_NESTING) {
      budget.cut = true;
      return null;
   }
   if (!JSON_START.test(text)) {
      return text;
   }
   /** @type {unknown} The parsed text. */
   let parsed;
   try {
      parsed = JSON.parse(text);
   } catch {
      return text;
   }
   budget.nesting += 1;
   try {
      if (typeof parsed === 'string') {
         /** @type {string | null} The nested text, redacted. */
         const inner = redactText(parsed, budget, depth + 1);
         return inner === null ? null : JSON.stringify(inner);
      }
      if (parsed === null || typeof parsed !== 'object') {
         return text;
      }
      return redactNode(parsed, budget, depth, true) ? JSON.stringify(parsed) : null;
   } finally {
      budget.nesting -= 1;
   }
}

/**
 * The outcome for a member that is removed.
 * @type {Readonly<{ keep: boolean, value: unknown }>}
 */
const DROPPED = Object.freeze({
   keep: false,
   value: null,
});

/**
 * Redact one member of an object or list.
 * @param {unknown} member - The value of one key of an object, or one entry of a list.
 * @param {RedactBudget} budget - The remaining budget of the walk.
 * @param {number} depth - How many levels below the export root the member sits.
 * @param {boolean} redacting - True inside free-form data.
 * @returns {{ keep: boolean, value: unknown }} Whether the member stays, and what it becomes.
 */
function redactMember(member, budget, depth, redacting) {
   if (redacting && typeof member === 'string') {
      /** @type {string | null} The text, redacted when it holds JSON. */
      const text = redactText(member, budget, depth);
      return {
         keep: text !== null,
         value: text,
      };
   }
   return {
      keep: redactNode(member, budget, depth, redacting),
      value: member,
   };
}

/**
 * Drop the secret-named keys of a value, in place, and drop what lies beyond the walk bounds. A list is walked in
 * order and cut at the first member beyond a bound, so the indexes of the members kept never move.
 * @param {unknown} node - The value to walk.
 * @param {RedactBudget} budget - The remaining budget of the walk.
 * @param {number} depth - How many levels below the export root the node sits.
 * @param {boolean} redacting - True inside free-form data, where a key named like a secret is dropped.
 * @returns {boolean} Whether the node may stay in its parent; false when it lies beyond a bound.
 */
function redactNode(node, budget, depth, redacting) {
   if (node === null || typeof node !== 'object') {
      return true;
   }
   budget.nodes -= 1;
   if (depth > REDACT_MAX_DEPTH || budget.nodes < 0) {
      budget.cut = true;
      return false;
   }
   if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
         /** @type {{ keep: boolean, value: unknown }} The member after redaction. */
         const member = redactMember(node[index], budget, depth + 1, redacting);
         if (!member.keep) {
            node.length = index;
            break;
         }
         node[index] = member.value;
      }
      return true;
   }
   for (const key of Object.keys(node)) {
      /** @type {boolean} Whether the child lies in free-form data where secret-named keys are dropped. */
      const childRedacting = redacting || key === 'flags';
      /** @type {boolean} Whether the key is named like a secret. */
      const dropped = redacting && SECRET_KEY.test(key);
      /** @type {{ keep: boolean, value: unknown }} The child after redaction. */
      const child = dropped
         ? DROPPED
         : redactMember(node[key], budget, depth + 1, childRedacting);
      if (child.keep) {
         node[key] = child.value;
      } else {
         delete node[key];
      }
   }
   return true;
}

/**
 * Redact the `value` of a Setting export, which Foundry stores as JSON text. Text that is not JSON is left as it is.
 * @param {Record<string, unknown>} data - The plain export (a copy owned by the caller).
 * @returns {boolean} True when the walk cut the value at a bound.
 */
function redactSettingValue(data) {
   if (typeof data.value !== 'string') {
      return false;
   }
   /** @type {RedactBudget} The budget of the value's walk. */
   const budget = newBudget();
   data.value = redactText(data.value, budget, 0) ?? 'null';
   return budget.cut;
}

/**
 * Remove the excluded fields of a document class from a plain export, in place.
 * @param {string} documentName - The document class name.
 * @param {Record<string, unknown>} data - The plain export (a copy owned by the caller).
 * @returns {boolean} True when a walk bound cut part of the export, so it no longer holds the whole document.
 */
function stripExcluded(documentName, data) {
   if (documentName === 'User') {
      for (const field of USER_EXCLUDED_FIELDS) {
         delete data[field];
      }
   }
   /** @type {boolean} Whether the walk of a Setting value cut it. */
   const valueCut = documentName === 'Setting' && redactSettingValue(data);
   // The root walk has its own budget, so a large Setting value cannot leave the flags of the export unwalked.
   /** @type {RedactBudget} The budget of the root walk. */
   const budget = newBudget();
   redactNode(data, budget, 0, false);
   return valueCut || budget.cut;
}

/**
 * The plain stored data of a document in the canonical form, before the exclusions.
 * @param {{ toCompendium: Function }} document - The Foundry document, or a stand-in with `toCompendium`.
 * @returns {Record<string, unknown>} A deep plain copy of `toCompendium` with the canonical options.
 * @throws {Error} When the document cannot be exported or its data cannot be serialized.
 */
function storedExport(document) {
   return toPlain(document.toCompendium(null, {
      clearSource: false,
      keepId: true,
      clearSort: false,
      clearOwnership: false,
   }));
}

/**
 * Collect the paths where the redacted copy of a value differs from the unredacted one: a key or list member that the
 * redaction removed, or a string it changed. Objects and lists present in both are walked; the walk follows the key
 * order of the unredacted value.
 * @param {unknown} original - The unredacted value.
 * @param {unknown} redacted - The same value after the exclusions.
 * @param {Array<string | number>} path - The path of both values below the export root.
 * @param {Array<Array<string | number>>} found - Receives the paths, in walk order.
 * @returns {void}
 */
function collectChangedPaths(original, redacted, path, found) {
   if (typeof original === 'string') {
      if (original !== redacted) {
         found.push(path);
      }
      return;
   }
   if (original === null || typeof original !== 'object' || redacted === null || typeof redacted !== 'object') {
      return;
   }
   /** @type {Array<string | number>} The keys of the unredacted value; a list is addressed by index. */
   const keys = Array.isArray(original) ? original.map((member, index) => index) : Object.keys(original);
   for (const key of keys) {
      /** @type {Array<string | number>} The path of this member. */
      const memberPath = [
         ...path,
         key,
      ];
      if (!Object.hasOwn(redacted, key)) {
         found.push(memberPath);
      } else {
         collectChangedPaths(original[key], redacted[key], memberPath, found);
      }
   }
}

/**
 * Produce the export of a document for a backup file: the canonical stored export of `exportDocument(document, {})`
 * without `uuid`, plus the path of every key the exclusions removed and every string the redaction changed, so a
 * restore knows which values the file leaves out. A document the redaction walk cut at a bound (`REDACT_MAX_NODES`,
 * `REDACT_MAX_DEPTH` or `REDACT_MAX_STRING_NESTING`) is refused, since its export no longer holds it whole. Never
 * throws.
 * @param {object} document - The Foundry document, or a stand-in with `documentName` and `toCompendium`.
 * @returns {{ ok: true, data: Record<string, unknown>, secretPaths: Array<Array<string | number>> } | { ok: false,
 * code: string, message: string }} The plain export with its secret paths, or the refusal.
 */
export function exportForBackup(document) {
   try {
      /** @type {ReturnType<typeof unreadable>} Why the document may not be read, if so. */
      const refusal = unreadable(document);
      if (refusal !== null) {
         return {
            ok: false,
            ...refusal,
         };
      }
      /** @type {Record<string, unknown>} The plain export before the exclusions. */
      const original = storedExport(document);
      /** @type {Record<string, unknown>} The plain export after them. */
      const data = toPlain(original);
      if (stripExcluded(document.documentName, data)) {
         return {
            ok: false,
            code: 'DOC_UNREADABLE',
            message: 'The document is too large or too deeply nested to export whole.',
         };
      }
      /** @type {Array<Array<string | number>>} The paths the exclusions changed. */
      const secretPaths = [];
      collectChangedPaths(original, data, [], secretPaths);
      return {
         ok: true,
         data,
         secretPaths,
      };
   } catch {
      return {
         ok: false,
         code: 'DOC_UNREADABLE',
         message: 'The document could not be exported.',
      };
   }
}

/**
 * Produce the canonical export of a document: `toCompendium(null, { clearSource: false, keepId: true, clearSort:
 * false, clearOwnership: false })` (Foundry's defaults would drop `_id`, `sort`, `ownership` and `author`) plus
 * `uuid`; or, when `derived`, the prepared data `toObject(false)` with the same fields added. The exclusions apply
 * before the data leaves this function; an export the redaction walk cut at a bound carries `partial: true` beside
 * `data`. Never throws.
 * @param {object} document - The Foundry document, or a stand-in with `documentName`, `uuid`, `toCompendium` and
 * `toObject`.
 * @param {ExportOptions} options - Whether to export the stored or the prepared data.
 * @returns {ExportOutcome} The plain export, or the refusal.
 */
export function exportDocument(document, options) {
   try {
      /** @type {ReturnType<typeof unreadable>} Why the document may not be read, if so. */
      const refusal = unreadable(document);
      if (refusal !== null) {
         return {
            ok: false,
            ...refusal,
         };
      }
      /** @type {Record<string, unknown>} The plain export. */
      const data = options?.derived === true ? toPlain(document.toObject(false)) : storedExport(document);
      /** @type {boolean} Whether the redaction walk dropped part of the document at a bound. */
      const partial = stripExcluded(document.documentName, data);
      data.uuid = document.uuid;
      return {
         ok: true,
         data,
         ...(partial ? { partial: true } : {}),
      };
   } catch {
      return {
         ok: false,
         code: 'DOC_UNREADABLE',
         message: 'The document could not be exported.',
      };
   }
}

/**
 * Read an embedded document through its parent.
 * @param {string} documentName - The embedded document class name.
 * @param {string} id - The document id.
 * @param {string} parentUuid - The uuid of the document that holds the embedded one.
 * @returns {Promise<object | null>} The document, or null when the parent or the document does not exist.
 */
async function resolveEmbedded(documentName, id, parentUuid) {
   try {
      /** @type {{ getEmbeddedCollection?: Function } | null} The parent document. */
      const parent = await fromUuid(parentUuid);
      return parent?.getEmbeddedCollection?.(documentName)?.get(id) ?? null;
   } catch {
      return null;
   }
}

/**
 * Read a compendium document.
 * @param {string} documentName - The expected document class name.
 * @param {string} id - The document id.
 * @param {string} packId - The compendium collection id, for example `world.items`.
 * @returns {Promise<object | null>} The document, or null when the pack or the document does not exist or the pack
 * holds another document class.
 */
async function resolvePacked(documentName, id, packId) {
   try {
      /** @type {{ documentName: string, getDocument: Function } | undefined} The compendium, when it exists. */
      const pack = game.packs.get(packId);
      if (pack === undefined || pack.documentName !== documentName) {
         return null;
      }
      return (await pack.getDocument(id)) ?? null;
   } catch {
      return null;
   }
}

/**
 * Resolve a document reference to the live document: by `uuid`, or by `documentName` and `id` in the world, in a
 * compendium (`pack`) or inside a parent (`parentUuid`).
 * @param {DocumentReference} reference - What to read: a uuid, or a class name and id with an optional scope.
 * @returns {Promise<object>} The live Foundry document.
 * @throws {ScriptError} `ARGS_INVALID` for an unclear reference, `DOC_NOT_FOUND` when nothing matches.
 */
export async function resolveDocument(reference) {
   /** @type {DocumentReference} The fields of the reference. */
   const { uuid, documentName, id, parentUuid, pack } = reference;
   /** @type {string} The reference as shown in a not-found error, bounded. */
   const shown = cleanForLog(uuid ?? `${documentName}.${id}`, ECHO_MAX_BYTES);
   if (uuid !== undefined) {
      if (documentName !== undefined || id !== undefined || parentUuid !== undefined || pack !== undefined) {
         throw new ScriptError('ARGS_INVALID', 'uuid excludes documentName, id, parentUuid and pack.');
      }
      try {
         /** @type {object | null} The document. */
         const found = await fromUuid(uuid);
         if (found !== null && found !== undefined) {
            return found;
         }
      } catch {
         // A malformed uuid is reported as not found below.
      }
      throw new ScriptError('DOC_NOT_FOUND', `No document '${shown}'.`);
   }
   if (documentName === undefined || id === undefined) {
      throw new ScriptError('ARGS_INVALID', 'Give uuid, or documentName and id.');
   }
   if (!CONST.ALL_DOCUMENT_TYPES.includes(documentName)) {
      throw new ScriptError('ARGS_INVALID', `Unknown documentName '${cleanForLog(documentName, ECHO_MAX_BYTES)}'.`);
   }
   if (pack !== undefined && parentUuid !== undefined) {
      throw new ScriptError('ARGS_INVALID', 'pack and parentUuid exclude each other.');
   }
   /** @type {object | null | undefined} The document. */
   let found;
   if (pack !== undefined) {
      found = await resolvePacked(documentName, id, pack);
   } else if (parentUuid !== undefined) {
      found = await resolveEmbedded(documentName, id, parentUuid);
   } else {
      found = game.collections.get(documentName)?.get(id);
   }
   if (found === null || found === undefined) {
      throw new ScriptError('DOC_NOT_FOUND', `No ${documentName} '${cleanForLog(id, ECHO_MAX_BYTES)}'.`);
   }
   return found;
}
