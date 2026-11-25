/**
 * The shipped `get_document` script: reads one document from the live world, an embedded document or a compendium.
 * The default result is the compact view; `fields` returns a projection, `paths` path slices (optionally of the
 * prepared data) and `mode: 'full'` the canonical export. The compact view and the `fields` and `paths` results carry
 * `version`, the content hash of the export the read returned (`contentHash.js`), so it changes when anything the
 * agent can read changes, embedded documents and `_stats` included, and not when only an excluded value changes.
 * `ifChanged` equal to the current version answers `{ unchanged: true }` in every mode; a `derived` read hashes the
 * prepared export, so its version matches only another derived read. The result enforcer of the sidecar turns
 * anything over the call's cap into a handle. The definition is in `definitions.js`. The exclusions (credential
 * settings, secret-named keys, User password fields) apply in `ctx.core.readDocument`; when its export left part of
 * the document out at a redaction bound, every mode but the unchanged ack carries `partial: true`.
 */

import { contentVersion } from '~/bridge/scripts/contentHash.js';
import { ScriptError } from '~/bridge/scripts/registry.js';
import { keyPathsFor } from '~/bridge/scripts/keyFields.js';
import { BEST_PRACTICE, SizeNotes } from '~/bridge/scripts/sizeNotes.js';
import { shapeRefusal } from '~/bridge/scripts/writeArgs.js';

/**
 * Refuse argument combinations that have no single meaning.
 * @param {Record<string, unknown>} args - The validated arguments.
 * @returns {void}
 * @throws {ScriptError} `ARGS_INVALID` naming the conflict.
 */
function checkCombination(args) {
   /** @type {boolean} Whether a path list is given. */
   const hasPaths = args.paths !== undefined;
   /** @type {boolean} Whether a field list is given. */
   const hasFields = args.fields !== undefined;
   if (hasPaths && hasFields) {
      throw new ScriptError('ARGS_INVALID', 'Give paths or fields, not both.');
   }
   if (args.mode === 'full' && (hasPaths || hasFields)) {
      throw new ScriptError('ARGS_INVALID', 'Mode full excludes paths and fields.');
   }
   if (args.derived === true && !hasPaths && !hasFields) {
      throw new ScriptError('ARGS_INVALID', 'derived applies to paths or fields only.');
   }
}

/**
 * Read the document and shape the result.
 * @param {Record<string, unknown>} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Promise<unknown>} The compact view, projection, path slices, full export or unchanged ack.
 */
export async function getDocumentHandler(args, ctx) {
   checkCombination(args);
   /** @type {SizeNotes} The best-practice sizes this call passes, written as one line before the read. */
   const notes = new SizeNotes('get_document');
   notes.note(args.fields?.length ?? 0, 'fields in one call', BEST_PRACTICE.paths);
   notes.note(args.paths?.length ?? 0, 'paths in one call', BEST_PRACTICE.paths);
   notes.note(args.ifChanged?.length ?? 0, 'characters in ifChanged', BEST_PRACTICE.ifChangedChars);
   notes.write(ctx.log);
   /**
    * The plain export, its class, and whether the export left part of the document out.
    * @type {{ data: Record<string, unknown>, documentName: string, partial: boolean }}
    */
   const { data, documentName, partial } = await ctx.core.readDocument(
      {
         uuid: args.uuid,
         documentName: args.documentName,
         id: args.id,
         parentUuid: args.parentUuid,
         pack: args.pack,
      },
      { derived: args.derived === true },
   );
   /**
    * The content version of the export the read returned: the stored export, or the prepared one when `derived` is
    * true. It is computed only when the call returns it or compares it.
    * @type {string | undefined}
    */
   const version = args.ifChanged !== undefined || args.mode !== 'full' ? contentVersion(data) : undefined;
   if (args.ifChanged !== undefined && args.ifChanged === version) {
      return ctx.shape.ack({ unchanged: true });
   }
   if (args.paths !== undefined) {
      /** @type {ReturnType<typeof ctx.shape.paths>} The slices, or the refusal. */
      const sliced = ctx.shape.paths(data, args.paths);
      if (!sliced.ok) {
         throw shapeRefusal(sliced.error);
      }
      return {
         values: sliced.values,
         missing: sliced.missing,
         version,
         ...(partial ? { partial: true } : {}),
      };
   }
   if (args.fields !== undefined) {
      /** @type {ReturnType<typeof ctx.shape.project>} The projection, or the refusal. */
      const projected = ctx.shape.project(data, args.fields);
      if (!projected.ok) {
         throw shapeRefusal(projected.error);
      }
      return {
         fields: projected.value,
         missing: projected.missing,
         version,
         ...(partial ? { partial: true } : {}),
      };
   }
   if (args.mode === 'full') {
      return partial
         ? {
            ...data,
            partial: true,
         }
         : data;
   }
   /** @type {readonly string[] | undefined} The key leaves of this subtype, when the system has a list for it. */
   const keyPaths = keyPathsFor(game.system?.id, documentName, data.type);
   return ctx.shape.compact(
      data,
      keyPaths === undefined
         ? {
            version,
            partial,
         }
         : {
            keyPaths: [...keyPaths],
            version,
            partial,
         },
   );
}
