/**
 * The shipped `search_documents` script. The definition is in `definitions.js`; the search, with the canonical
 * exclusions, is `ctx.core.searchDocuments`.
 */

import { utf8Bytes } from '$shared/utf8.js';
import { BEST_PRACTICE, SizeNotes, longest } from '~/bridge/scripts/sizeNotes.js';

/**
 * Search documents and return one page.
 * @param {import('~/bridge/scripts/search.js').SearchParams} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Promise<import('~/bridge/scripts/search.js').SearchResult>} The page, within `SEARCH_PAGE_MAX_BYTES`.
 */
export function searchDocumentsHandler(args, ctx) {
   /** @type {SizeNotes} The best-practice sizes this call passes, written as one line before the search runs. */
   const notes = new SizeNotes('search_documents');
   /** @type {string[]} The filters of the call. */
   const filters = args.filters ?? [];
   /** @type {string[]} The field paths of the call. */
   const fields = args.fields ?? [];
   notes.note(args.limit ?? 0, 'results per page', BEST_PRACTICE.searchLimit);
   notes.note(filters.length, 'filters in one call', BEST_PRACTICE.filters);
   notes.note(longest(filters), 'characters in one filter', BEST_PRACTICE.filterChars);
   notes.note(fields.length, 'fields in one call', BEST_PRACTICE.paths);
   notes.note(longest(fields, utf8Bytes), 'bytes in one field path', BEST_PRACTICE.fieldPathBytes);
   notes.note(args.query?.length ?? 0, 'characters in the query', BEST_PRACTICE.queryChars);
   notes.note(args.cursor?.length ?? 0, 'characters in the cursor', BEST_PRACTICE.cursorChars);
   notes.write(ctx.log);
   return ctx.core.searchDocuments(args, ctx.signal);
}
