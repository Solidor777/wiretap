/**
 * The shipped `get_document` script: reads one document from the live world, an embedded document or a compendium.
 * The default result is the compact view; `fields` returns a projection, `paths` path slices (optionally of the
 * prepared data) and `mode: 'full'` the canonical export. The result enforcer of the sidecar turns anything over the
 * call's cap into a handle. The definition is in `definitions.js`. The exclusions (credential settings, secret-named
 * keys, User password fields) apply in `ctx.core.readDocument`.
 */

import { ScriptError } from '~/bridge/scripts/registry.js';
import { keyPathsFor } from '~/bridge/scripts/keyFields.js';

/**
 * Turn a shape refusal, `<code>: <message>`, into a script error that acks that code.
 * @param {string} text - The refusal text of `ctx.shape`.
 * @returns {ScriptError} The error.
 */
function refusal(text) {
   /** @type {number} Where the code ends. */
   const split = text.indexOf(': ');
   if (split > 0) {
      return new ScriptError(text.slice(0, split), text.slice(split + 2));
   }
   return new ScriptError('PATH_INVALID', text);
}

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
   /** @type {{ data: Record<string, unknown>, documentName: string }} The plain export and its class. */
   const { data, documentName } = await ctx.core.readDocument(
      {
         uuid: args.uuid,
         documentName: args.documentName,
         id: args.id,
         parentUuid: args.parentUuid,
         pack: args.pack,
      },
      { derived: args.derived === true },
   );
   if (args.ifModifiedSince !== undefined) {
      /** @type {unknown} The document's last modification time in milliseconds. */
      const modified = data._stats?.modifiedTime;
      if (typeof modified === 'number' && Number.isFinite(modified) && modified <= args.ifModifiedSince) {
         return ctx.shape.ack({ unchanged: true });
      }
   }
   if (args.paths !== undefined) {
      /** @type {ReturnType<typeof ctx.shape.paths>} The slices, or the refusal. */
      const sliced = ctx.shape.paths(data, args.paths);
      if (!sliced.ok) {
         throw refusal(sliced.error);
      }
      return {
         values: sliced.values,
         missing: sliced.missing,
      };
   }
   if (args.fields !== undefined) {
      /** @type {ReturnType<typeof ctx.shape.project>} The projection, or the refusal. */
      const projected = ctx.shape.project(data, args.fields);
      if (!projected.ok) {
         throw refusal(projected.error);
      }
      return {
         fields: projected.value,
         missing: projected.missing,
      };
   }
   if (args.mode === 'full') {
      return data;
   }
   /** @type {readonly string[] | undefined} The key leaves of this subtype, when the system has a list for it. */
   const keyPaths = keyPathsFor(game.system?.id, documentName, data.type);
   return ctx.shape.compact(data, keyPaths === undefined ? {} : { keyPaths: [...keyPaths] });
}
