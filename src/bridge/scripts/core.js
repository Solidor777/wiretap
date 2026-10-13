/**
 * The core operations scripts call through `ctx.core`. Each runs against the live world on this client; an operation
 * in a gated category calls `requireGate` first. Scripts call these operations, never the reverse.
 */

import { getBudget } from '$shared/budgets.js';
import { cleanForLog } from '$shared/logText.js';
import { utf8Bytes } from '$shared/utf8.js';
import { exportDocument, resolveDocument } from '~/bridge/scripts/canonical.js';
import { describeSchema } from '~/bridge/scripts/schemaDescribe.js';
import { searchDocuments } from '~/bridge/scripts/search.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * The longest error text this client acks, in UTF-8 bytes; a core operation builds its messages to fit it whole.
 * @type {number}
 */
export const ERROR_MESSAGE_MAX_BYTES = 256;

/**
 * Longest caller-supplied actor type echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const TYPE_ECHO_MAX_BYTES = 40;

/**
 * Build the unknown-type message so that it fits `ERROR_MESSAGE_MAX_BYTES` whole: the valid types are listed in order
 * while they fit and the rest are counted as `(+N more)`, so the text is never cut inside the list.
 * @param {string} type - The unknown type the caller sent.
 * @param {string[]} concreteTypes - The valid types, in the world's declared order.
 * @returns {string} The error text, within `ERROR_MESSAGE_MAX_BYTES`.
 */
function unknownTypeMessage(type, concreteTypes) {
   /** @type {string} The text before the list. */
   const prefix = `Unknown actor type '${cleanForLog(type, TYPE_ECHO_MAX_BYTES)}'. Valid types: `;
   /** @type {string} The longest possible count suffix, reserved so a shorter list never overflows with it. */
   const reserve = ` (+${concreteTypes.length} more)`;
   /** @type {string[]} The types listed whole. */
   const listed = [];
   /** @type {number} The bytes the message would take with the types listed so far. */
   let bytes = utf8Bytes(prefix);
   for (const candidate of concreteTypes) {
      /** @type {string} The candidate as listed. */
      const entry = cleanForLog(candidate, TYPE_ECHO_MAX_BYTES);
      /** @type {number} The bytes after adding this entry and its separator. */
      const next = bytes + utf8Bytes(entry) + (listed.length > 0 ? 2 : 0);
      /** @type {boolean} Whether this is the last type, which needs no count suffix. */
      const last = listed.length + 1 === concreteTypes.length;
      if (next + (last ? 0 : utf8Bytes(reserve)) > ERROR_MESSAGE_MAX_BYTES) {
         break;
      }
      listed.push(entry);
      bytes = next;
   }
   /** @type {number} The valid types left out of the list. */
   const more = concreteTypes.length - listed.length;
   return `${prefix}${listed.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
}

/**
 * Create an Actor in the live world. Resolves the actor subtype client-side so the tool stays system-agnostic: an
 * omitted type defaults to the world's first concrete subtype, and an unknown type is rejected with a bounded list of
 * valid types. A creation that a hook cancels (`Actor.create` resolves undefined) is an error.
 * @param {{ name: string, type?: string }} params - The actor name and optional subtype.
 * @returns {Promise<{ uuid: string, id: string, name: string, type: string }>} The created actor summary.
 */
async function createActor({ name, type }) {
   // Concrete subtypes = all declared Actor types minus the abstract base type.
   const concreteTypes = game.documentTypes.Actor.filter((candidate) => candidate !== CONST.BASE_DOCUMENT_TYPE);
   if (concreteTypes.length === 0) {
      throw new Error('No concrete Actor subtypes are registered in this world.');
   }
   if (type !== undefined && !concreteTypes.includes(type)) {
      throw new Error(unknownTypeMessage(type, concreteTypes));
   }
   const resolvedType = type ?? concreteTypes[0];
   const actor = await Actor.create({
      name,
      type: resolvedType,
   });
   if (actor === undefined) {
      throw new Error('Actor creation was cancelled');
   }
   return {
      uuid: actor.uuid,
      id: actor.id,
      name: actor.name,
      type: actor.type,
   };
}

/**
 * Describe the document classes of this world: the game system, the world, embedded and compendium-only document
 * names, and the subtypes of each class (the abstract base type left out). While the serialized result exceeds
 * `DOCUMENT_TYPES_MAX_BYTES` the longest subtype list is left out and its class named in `omitted`, so the size bound
 * holds for any world.
 * @returns {{ system: string, world: string[], embedded: string[], packOnly?: string[],
 * subtypes: Record<string, string[]>, omitted?: string[] }} The description.
 */
function documentTypes() {
   /** @type {Record<string, string[]>} The subtypes of every class that has any. */
   const subtypes = {};
   for (const name of CONST.ALL_DOCUMENT_TYPES) {
      /** @type {string[]} The class's concrete subtypes. */
      const types = (game.documentTypes?.[name] ?? []).filter((type) => type !== CONST.BASE_DOCUMENT_TYPE);
      if (types.length > 0) {
         subtypes[name] = types;
      }
   }
   /** @type {string[]} Primary types that live only in compendium packs. */
   const packOnly = CONST.ALL_DOCUMENT_TYPES.filter(
      (name) => !CONST.WORLD_DOCUMENT_TYPES.includes(name) && !CONST.EMBEDDED_DOCUMENT_TYPES.includes(name),
   );
   /** @type {string[]} The classes whose subtype lists were left out to fit. */
   const omitted = [];
   /**
    * Assemble the description from the subtype lists kept so far.
    * @returns {Record<string, unknown>} The description.
    */
   const assemble = () => ({
      system: game.system.id,
      world: [...CONST.WORLD_DOCUMENT_TYPES],
      embedded: [...CONST.EMBEDDED_DOCUMENT_TYPES],
      ...(packOnly.length > 0 ? { packOnly } : {}),
      subtypes,
      ...(omitted.length > 0 ? { omitted } : {}),
   });
   /** @type {number} The largest serialized result. */
   const limit = getBudget('DOCUMENT_TYPES_MAX_BYTES').value;
   while (utf8Bytes(JSON.stringify(assemble())) > limit && Object.keys(subtypes).length > 0) {
      /** @type {string} The class with the longest subtype list. */
      const longest = Object.keys(subtypes).reduce((best, name) =>
         subtypes[name].length > subtypes[best].length ? name : best,
      );
      delete subtypes[longest];
      omitted.push(longest);
   }
   return assemble();
}

/**
 * Read a document through the canonical export: resolve the reference, refuse an unreadable document and apply the
 * export exclusions, so nothing excluded ever leaves this function.
 * @param {import('~/bridge/scripts/canonical.js').DocumentReference} reference - A uuid, or a class name and id.
 * @param {import('~/bridge/scripts/canonical.js').ExportOptions} options - The export options.
 * @returns {Promise<{ data: Record<string, unknown>, documentName: string }>} The plain export and the document class.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `DOC_EXCLUDED` or `DOC_UNREADABLE`.
 */
async function readDocument(reference, options) {
   /** @type {{ documentName: string }} The live document. */
   const document = await resolveDocument(reference);
   /** @type {import('~/bridge/scripts/canonical.js').ExportOutcome} The export, or its refusal. */
   const outcome = exportDocument(document, options);
   if (!outcome.ok) {
      throw new ScriptError(outcome.code, outcome.message);
   }
   return {
      data: outcome.data,
      documentName: document.documentName,
   };
}

/**
 * The frozen core operation table a script receives as `ctx.core`.
 * @type {Readonly<{ createActor: typeof createActor, documentTypes: typeof documentTypes,
 * readDocument: typeof readDocument, searchDocuments: typeof searchDocuments,
 * describeSchema: typeof describeSchema }>}
 */
export const scriptCore = Object.freeze({
   createActor,
   documentTypes,
   readDocument,
   searchDocuments,
   describeSchema,
});
