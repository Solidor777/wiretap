/**
 * The shipped `list_document_types` script: the document classes and subtypes of the live world, so an agent learns
 * which `documentName` and `type` values exist before it reads or searches.
 */

/**
 * Describe the world's document classes and subtypes.
 * @param {Record<string, never>} args - The validated arguments (none).
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {ReturnType<typeof import('~/bridge/scripts/core.js').scriptCore.documentTypes>} The description, within
 * `DOCUMENT_TYPES_MAX_BYTES`.
 */
export function listDocumentTypesHandler(args, ctx) {
   return ctx.core.documentTypes();
}
