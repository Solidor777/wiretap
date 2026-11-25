/**
 * The core operations scripts call through `ctx.core`. Each runs against the live world on this client; an operation
 * in a gated category calls `requireGate` first. Scripts call these operations, never the reverse.
 */

import { getBudget } from '$shared/budgets.js';
import { utf8Bytes } from '$shared/utf8.js';
import { exportDocument, resolveDocument } from '~/bridge/scripts/canonical.js';
import { describeSchema } from '~/bridge/scripts/schemaDescribe.js';
import { searchDocuments } from '~/bridge/scripts/search.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { batchDocuments } from '~/bridge/scripts/writeBatch.js';
import { replaceDocument } from '~/bridge/scripts/writeReplace.js';
import { createDocuments, deleteDocuments, updateDocuments } from '~/bridge/scripts/writes.js';

/**
 * The longest error text this client acks, in UTF-8 bytes; a core operation builds its messages to fit it whole.
 * @type {number}
 */
export const ERROR_MESSAGE_MAX_BYTES = 256;

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
 * @returns {Promise<{ data: Record<string, unknown>, documentName: string, partial: boolean }>} The plain export, the
 * document class, and whether the export left part of the document out at a redaction bound.
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
      partial: outcome.partial === true,
   };
}

/**
 * The frozen core operation table a script receives as `ctx.core`.
 * @type {Readonly<{ documentTypes: typeof documentTypes, readDocument: typeof readDocument,
 * searchDocuments: typeof searchDocuments, describeSchema: typeof describeSchema,
 * createDocuments: typeof createDocuments, updateDocuments: typeof updateDocuments,
 * deleteDocuments: typeof deleteDocuments }>}
 */
export const scriptCore = Object.freeze({
   documentTypes,
   readDocument,
   searchDocuments,
   describeSchema,
   createDocuments,
   updateDocuments,
   deleteDocuments,
   replaceDocument,
   batchDocuments,
});
