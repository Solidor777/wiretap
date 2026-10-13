/**
 * The shipped `search_documents` script. The definition is in `definitions.js`; the search, with the canonical
 * exclusions, is `ctx.core.searchDocuments`.
 */

/**
 * Search documents and return one page.
 * @param {import('~/bridge/scripts/search.js').SearchParams} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Promise<import('~/bridge/scripts/search.js').SearchResult>} The page, within `SEARCH_PAGE_MAX_BYTES`.
 */
export function searchDocumentsHandler(args, ctx) {
   return ctx.core.searchDocuments(args, ctx.signal);
}
