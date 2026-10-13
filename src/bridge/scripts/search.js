/**
 * The document search behind `search_documents`. Candidates come from the world collection, the embedded collection of
 * a parent, or a compendium index; a world or embedded document is judged readable and exported by the canonical
 * functions of `canonical.js`, so the exclusions hold here too: a Setting in the `wiretap.` namespace never appears in
 * a row, a total or a match, and a filter or field on a User password path is refused. Matches are ordered by name and
 * uuid, so a page is deterministic and an opaque cursor names a position, not an offset.
 *
 * Cost per call. Every readable document of the class gets an ordering key from its live name and the keys are sorted,
 * which is O(N log N) in the size of the collection on every call, with a yield every `SEARCH_BATCH_SIZE` documents;
 * no cap applies to that step. The scan that follows is bounded: name, subtype and folder tests read the live document
 * and cost no export, a document is exported only to test another filter or to build a row with `fields`, and a call
 * examines at most `SEARCH_SCAN_MAX` candidates after its cursor and exports at most `SEARCH_EXPORT_MAX` of them, then
 * reports `cut` and a cursor that resumes. The scan goes on past `limit` matches until a cap or the end, because
 * `total` counts the matches it examined.
 *
 * Abort: the loop checks its signal at each yield and stops with `SEARCH_ABORTED`. A compendium `getIndex` call is not
 * abortable, and one batch of candidates may finish after the call timed out.
 *
 * Compendium index: the paths asked of `getIndex` merge into the pack's shared index and stay in memory for the
 * session. Only a path of one segment can be refused as a whole subtree; whether `system.<name>` is an object is not
 * known from the path, so a two-segment path may add a whole sub-object to every index entry.
 */

import { getBudget } from '$shared/budgets.js';
import { cleanForLog } from '$shared/logText.js';
import { parsePath, resolvePath } from '$shared/docPath.js';
import { truncateUtf8, utf8Bytes } from '$shared/utf8.js';
import { SECRET_KEY, USER_EXCLUDED_FIELDS, exportDocument, unreadable } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * Longest name kept in a row and in the ordering key, in UTF-8 bytes.
 * @type {number}
 */
const NAME_MAX_BYTES = 40;

/**
 * Longest string value in a row's field map, in UTF-8 bytes.
 * @type {number}
 */
const VALUE_MAX_BYTES = 64;

/**
 * Longest caller text echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const ECHO_MAX_BYTES = 48;

/**
 * Most filters in one search.
 * @type {number}
 */
export const FILTERS_MAX = 5;

/**
 * Top-level filter paths a live document answers without an export.
 * @type {readonly string[]}
 */
const CHEAP_FIELDS = Object.freeze([
   'name',
   'type',
   'folder',
]);

/**
 * Top-level paths that name a whole subtree; a compendium index is never asked for one.
 * @type {readonly string[]}
 */
const WHOLE_SUBTREE_ROOTS = Object.freeze([
   'system',
   'items',
   'effects',
   'flags',
   'prototypeToken',
   'pages',
   'results',
   'ownership',
]);

/**
 * Document classes that are never searched in a compendium: their documents are not stored in packs and their
 * exclusions are enforced on live documents only.
 * @type {readonly string[]}
 */
const WORLD_ONLY = Object.freeze([
   'Setting',
   'User',
]);

/**
 * @typedef {object} SearchParams
 * @property {string} documentName - The document class.
 * @property {string} [type] - Only documents of this subtype.
 * @property {string} [query] - Only documents whose name contains this text, ignoring case.
 * @property {string[]} [filters] - Up to 5 `path=value` equality filters on scalar values.
 * @property {string} [pack] - The compendium to search.
 * @property {string} [parentUuid] - The parent whose embedded documents to search.
 * @property {string[]} [fields] - Dotted paths whose scalar values are added to each row.
 * @property {number} [limit] - Rows per page; defaults to `SEARCH_DEFAULT_LIMIT`, at most `SEARCH_MAX_LIMIT`.
 * @property {string} [cursor] - The `nextCursor` of the previous page.
 */

/**
 * @typedef {object} Candidate
 * @property {string} uuid - The document uuid.
 * @property {string} name - The document name (a Setting shows its key).
 * @property {string} type - The subtype, or an empty string.
 * @property {object} source - The live document or the index entry the candidate came from.
 * @property {boolean} live - Whether `source` is a live document (exported canonically) or an index entry.
 * @property {string} key - The ordering key.
 * @property {Record<string, unknown> | null} [data] - The canonical export, once a filter or a row has needed it.
 */

/**
 * @typedef {object} SearchResult
 * @property {unknown[][]} rows - The rows of the page.
 * @property {number} total - The matches among the candidates examined from the cursor onward.
 * @property {boolean} [cut] - True when the call stopped at its scan or export cap before the end of the candidates.
 * @property {number} [scanned] - The candidates examined, present with `cut`.
 * @property {string} [nextCursor] - Resumes after the last row, or after the last candidate examined when cut.
 * @property {boolean} [fieldsDropped] - True when a lone row lost its `fields` values to fit the page.
 */

/**
 * @typedef {{ segments: object[], path: string }} ParsedPath
 */

/**
 * Build a coded error.
 * @param {string} code - A stable error code such as `CURSOR_INVALID`.
 * @param {string} message - The refusal text, cut to 256 bytes.
 * @returns {ScriptError} The error.
 */
function fail(code, message) {
   return new ScriptError(code, truncateUtf8(message, 256));
}

/**
 * Parse a dotted path for a filter or a field, refusing wildcards, the password paths of a User and, for a field,
 * a path too long to echo as a row key.
 * @param {string} path - A dotted path from a filter or a field list.
 * @param {string} documentName - The searched class.
 * @param {boolean} [echoed] - Whether the path is echoed in rows (a field) and so is length-bounded.
 * @returns {ParsedPath} The parsed path.
 * @throws {ScriptError} A `PATH_*` code.
 */
function parseSearchPath(path, documentName, echoed = false) {
   /** @type {number} The longest echoed path, in bytes. */
   const echoMax = getBudget('SEARCH_FIELD_PATH_MAX_BYTES').value;
   if (echoed && utf8Bytes(path) > echoMax) {
      throw fail('PATH_INVALID', `A field path is at most ${echoMax} bytes.`);
   }
   /** @type {ReturnType<typeof parsePath>} The parse. */
   const parsed = parsePath(path);
   if (!parsed.ok) {
      throw fail(parsed.error.code, parsed.error.message);
   }
   if (parsed.segments.some((segment) => segment.type === 'wildcard')) {
      throw fail('PATH_INVALID', 'A search path has no wildcard.');
   }
   if (documentName === 'User' && USER_EXCLUDED_FIELDS.includes(parsed.segments[0].name)) {
      throw fail('PATH_EXCLUDED', 'This field is not searchable.');
   }
   return {
      segments: parsed.segments,
      path,
   };
}

/**
 * Split a `path=value` filter.
 * @param {string} filter - The filter text.
 * @param {string} documentName - The searched class.
 * @returns {{ parsed: ParsedPath, value: string }} The path and the text a value must equal.
 * @throws {ScriptError} `ARGS_INVALID` for a filter without a path or an equals sign, or a `PATH_*` code.
 */
function parseFilter(filter, documentName) {
   /** @type {number} Where the path ends. */
   const split = filter.indexOf('=');
   if (split <= 0) {
      throw fail('ARGS_INVALID', `The filter '${cleanForLog(filter, ECHO_MAX_BYTES)}' is not path=value.`);
   }
   return {
      parsed: parseSearchPath(filter.slice(0, split), documentName),
      value: filter.slice(split + 1),
   };
}

/**
 * Read a scalar at a parsed path of a data object.
 * @param {unknown} data - The export or index entry.
 * @param {ParsedPath} parsed - The path.
 * @returns {string | number | boolean | undefined} The scalar, or undefined when absent or not a scalar.
 */
function scalarAt(data, parsed) {
   /** @type {ReturnType<typeof resolvePath>} What the path resolves to. */
   const found = resolvePath(data, parsed.segments);
   if (!found.found) {
      return undefined;
   }
   /** @type {{ value: unknown }} The value found at the path. */
   const { value } = found;
   /** @type {boolean} Whether the value is a scalar a filter or a row can show. */
   const scalar =
      typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value));
   return scalar ? value : undefined;
}

/**
 * Build the ordering key of a candidate: the shortened name, then the uuid.
 * @param {string} name - The document name, cut to 40 bytes.
 * @param {string} uuid - The document uuid, which breaks ties between equal names.
 * @returns {string} The string that orders and positions a row.
 */
function keyOf(name, uuid) {
   return `${truncateUtf8(name.replaceAll('\u0000', ' '), NAME_MAX_BYTES)}\u0000${uuid}`;
}

/**
 * Encode the position after a candidate as an opaque cursor.
 * @param {string} key - The ordering key of the last row of the page.
 * @returns {string} A base64url cursor.
 */
function encodeCursor(key) {
   /** @type {Uint8Array} The key's bytes. */
   const bytes = new TextEncoder().encode(key);
   return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/**
 * Decode a cursor into an ordering key.
 * @param {string} cursor - A `nextCursor` value from an earlier page.
 * @returns {string} The key it names.
 * @throws {ScriptError} `CURSOR_INVALID` when the cursor is not one this search issued.
 */
function decodeCursor(cursor) {
   try {
      /** @type {string} The standard base64 text. */
      const text = cursor.replaceAll('-', '+').replaceAll('_', '/');
      /** @type {Uint8Array} The decoded bytes. */
      const bytes = Uint8Array.from(atob(text), (character) => character.charCodeAt(0));
      /** @type {string} The decoded key: the name, one NUL and the uuid. */
      const key = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (key.indexOf('\u0000') > 0) {
         return key;
      }
   } catch {
      // A malformed cursor is reported below.
   }
   throw fail('CURSOR_INVALID', 'The cursor is not valid; search again without it.');
}

/**
 * Choose the paths a compendium index is asked for. The pack index is shared state: `getIndex` merges the requested
 * fields into the pack's one index and keeps them for the session (`CompendiumCollection#getIndex`), so the request is
 * bounded to a few short scalar paths and never names a whole subtree.
 * @param {ParsedPath[]} paths - The parsed filter and field paths.
 * @returns {string[]} The distinct paths to request.
 * @throws {ScriptError} `ARGS_INVALID` when a path or the set of paths is outside the bounds.
 */
function indexPathsOf(paths) {
   /** @type {string[]} The distinct paths. */
   const distinct = Array.from(new Set(paths.map((entry) => entry.path)));
   /** @type {number} The most distinct paths. */
   const fieldsMax = getBudget('SEARCH_INDEX_FIELDS_MAX').value;
   /** @type {number} The most segments of a path. */
   const segmentsMax = getBudget('SEARCH_INDEX_SEGMENTS_MAX').value;
   if (distinct.length > fieldsMax) {
      throw fail('ARGS_INVALID', `A compendium search takes at most ${fieldsMax} distinct filter and field paths.`);
   }
   for (const entry of paths) {
      // A pack index entry is raw source data, not a redacted export: a secret-named segment is never asked for.
      if (entry.segments.some((segment) => typeof segment.name === 'string' && SECRET_KEY.test(segment.name))) {
         throw fail('PATH_EXCLUDED', 'This field is not searchable.');
      }
      if (
         entry.segments.length > segmentsMax ||
         (entry.segments.length === 1 && WHOLE_SUBTREE_ROOTS.includes(entry.segments[0].name))
      ) {
         throw fail(
            'ARGS_INVALID',
            `A compendium path has at most ${segmentsMax} segments and is not a whole subtree such as 'system'.`,
         );
      }
   }
   return distinct;
}

/**
 * Collect the live documents or index entries to search.
 * @param {SearchParams} params - The search.
 * @param {ParsedPath[]} paths - The parsed filter and field paths an index entry must carry.
 * @returns {Promise<{ items: object[], live: boolean }>} The items and whether they are live documents.
 * @throws {ScriptError} `ARGS_INVALID` or `DOC_NOT_FOUND`.
 */
async function sourceOf(params, paths) {
   /** @type {SearchParams} The scope fields of the search. */
   const { documentName, pack, parentUuid } = params;
   if (!CONST.ALL_DOCUMENT_TYPES.includes(documentName)) {
      throw fail('ARGS_INVALID', `Unknown documentName '${cleanForLog(documentName, ECHO_MAX_BYTES)}'.`);
   }
   if (pack !== undefined && parentUuid !== undefined) {
      throw fail('ARGS_INVALID', 'pack and parentUuid exclude each other.');
   }
   if (pack !== undefined) {
      if (WORLD_ONLY.includes(documentName)) {
         throw fail('ARGS_INVALID', `${documentName} documents are not searched in a compendium.`);
      }
      /** @type {{ documentName: string, collection?: string, getIndex: Function } | undefined} The pack found. */
      const compendium = game.packs.get(pack);
      if (compendium === undefined || compendium.documentName !== documentName) {
         throw fail('DOC_NOT_FOUND', `No ${documentName} compendium '${cleanForLog(pack, ECHO_MAX_BYTES)}'.`);
      }
      /** @type {Iterable<object>} The index entries, with only the fields the search needs. */
      const index = await compendium.getIndex({ fields: indexPathsOf(paths) });
      return {
         items: Array.from(index).map((entry) => ({
            ...entry,
            uuid: entry.uuid ?? `Compendium.${compendium.collection ?? pack}.${documentName}.${entry._id}`,
         })),
         live: false,
      };
   }
   if (parentUuid !== undefined) {
      try {
         /** @type {{ getEmbeddedCollection?: Function } | null} The document that holds the embedded collection. */
         const parent = await fromUuid(parentUuid);
         /** @type {Iterable<object> | undefined} The embedded documents. */
         const collection = parent?.getEmbeddedCollection?.(documentName);
         if (collection !== undefined) {
            return {
               items: Array.from(collection),
               live: true,
            };
         }
      } catch {
         // A parent without that collection is reported below.
      }
      throw fail('DOC_NOT_FOUND', `No ${documentName} documents under '${cleanForLog(parentUuid, ECHO_MAX_BYTES)}'.`);
   }
   /** @type {Iterable<object> | undefined} The world collection. */
   const collection = game.collections.get(documentName);
   if (collection === undefined) {
      throw fail('ARGS_INVALID', `${documentName} documents are searched with pack or parentUuid.`);
   }
   return {
      items: Array.from(collection),
      live: true,
   };
}

/**
 * Read the canonical export of a live candidate once and keep it on the candidate.
 * @param {Candidate} candidate - A live candidate.
 * @returns {Record<string, unknown> | null} The export, or null when the document is not exportable.
 */
function exportOf(candidate) {
   if (candidate.data === undefined) {
      /** @type {ReturnType<typeof exportDocument>} The export. */
      const exported = exportDocument(candidate.source, {});
      candidate.data = exported.ok ? exported.data : null;
   }
   return candidate.data;
}

/**
 * Add the requested fields of a candidate to a row as a flat map of scalars.
 * @param {Candidate} candidate - A match whose field values are wanted.
 * @param {ParsedPath[]} fields - The parsed field paths.
 * @returns {Record<string, string | number | boolean>} The scalars found; long strings are shortened.
 */
function fieldValues(candidate, fields) {
   /** @type {unknown} The data to read: the canonical export of a live document, or the index entry. */
   const data = candidate.live ? (exportOf(candidate) ?? {}) : candidate.source;
   /** @type {Record<string, string | number | boolean>} The values found. */
   const values = {};
   for (const field of fields) {
      /** @type {string | number | boolean | undefined} The scalar at the path. */
      const value = scalarAt(data, field);
      if (value !== undefined) {
         values[field.path] = typeof value === 'string' ? truncateUtf8(value, VALUE_MAX_BYTES) : value;
      }
   }
   return values;
}

/**
 * Read a top-level scalar of a live document without exporting it.
 * @param {object} item - The live document.
 * @param {string} name - `name`, `type` or `folder`.
 * @returns {string | undefined} The value, or undefined when the document does not show it as text.
 */
function liveValue(item, name) {
   /** @type {unknown} The raw property; a folder is a document, a stand-in may hold its id. */
   const raw = name === 'folder' ? (item.folder?.id ?? item.folder) : item[name];
   return typeof raw === 'string' ? raw : undefined;
}

/**
 * Yield to the event loop for one macrotask. A message event is used because timers are clamped to 4 ms once nested.
 * @returns {Promise<void>} Resolves after the event loop has run its other queued tasks.
 */
function yieldToEventLoop() {
   return new Promise((resolve) => {
      /** @type {MessageChannel} A one-shot channel. */
      const channel = new MessageChannel();
      channel.port1.onmessage = () => {
         channel.port1.close();
         resolve();
      };
      channel.port2.postMessage(null);
   });
}

/**
 * Judge a candidate against the filters, exporting its document only for a filter the live document cannot answer.
 * @param {Candidate} candidate - The document or index entry under test, with its ordering key.
 * @param {Array<{ parsed: ParsedPath, value: string }>} filters - The filters, each parsed with its expected text.
 * @param {{ exported: number, exportMax: number }} used - The exports used and allowed in this call.
 * @returns {boolean | null} Whether every filter holds, or null when the export cap stops the judgement.
 */
function passesFilters(candidate, filters, used) {
   /** @type {Array<{ parsed: ParsedPath, value: string }>} The filters the live document could not answer. */
   const open = [];
   for (const filter of filters) {
      /** @type {string} The top-level name of the filter path. */
      const head = filter.parsed.segments[0].name;
      /** @type {string | undefined} The cheap value, for a top-level name, type or folder filter. */
      const cheap =
         candidate.live && filter.parsed.segments.length === 1 && CHEAP_FIELDS.includes(head)
            ? liveValue(candidate.source, head)
            : undefined;
      if (cheap === undefined) {
         open.push(filter);
      } else if (cheap !== filter.value) {
         return false;
      }
   }
   if (open.length === 0) {
      return true;
   }
   if (candidate.live && candidate.data === undefined) {
      if (used.exported >= used.exportMax) {
         return null;
      }
      used.exported += 1;
   }
   /** @type {unknown} The data the open filters read. */
   const data = candidate.live ? exportOf(candidate) : candidate.source;
   if (data === null) {
      return false;
   }
   return open.every((filter) => {
      /** @type {string | number | boolean | undefined} The scalar at the filter's path. */
      const actual = scalarAt(data, filter.parsed);
      return actual !== undefined && String(actual) === filter.value;
   });
}

/**
 * Search documents and return one page.
 * @param {SearchParams} params - The validated search.
 * @param {AbortSignal} [signal] - Aborts when the call times out; the search stops at its next batch.
 * @returns {Promise<SearchResult>} The page, within `SEARCH_PAGE_MAX_BYTES`.
 * @throws {ScriptError} `ARGS_INVALID`, `DOC_NOT_FOUND`, `PATH_*`, `CURSOR_INVALID` or `SEARCH_ABORTED`.
 */
export async function searchDocuments(params, signal) {
   /** @type {SearchParams} The class, subtype and name query of the search. */
   const { documentName, type, query } = params;
   if ((params.filters ?? []).length > FILTERS_MAX) {
      throw fail('ARGS_INVALID', `A search takes at most ${FILTERS_MAX} filters.`);
   }
   /** @type {Array<{ parsed: ParsedPath, value: string }>} The parsed filters. */
   const filters = (params.filters ?? []).map((filter) => parseFilter(filter, documentName));
   /** @type {ParsedPath[]} The parsed field paths. */
   const fields = (params.fields ?? []).map((field) => parseSearchPath(field, documentName, true));
   /** @type {string} The key a page must start after, or an empty string. */
   const after = params.cursor === undefined ? '' : decodeCursor(params.cursor);
   /** @type {number} The rows per page. */
   const limit = Math.min(
      Math.max(Math.trunc(params.limit ?? getBudget('SEARCH_DEFAULT_LIMIT').value), 1),
      getBudget('SEARCH_MAX_LIMIT').value,
   );
   /** @type {string} The lower-cased query. */
   const needle = query === undefined ? '' : query.toLowerCase();
   /** @type {{ items: object[], live: boolean }} The candidates and whether they are live documents. */
   const { items, live } = await sourceOf(params, [
      ...filters.map((filter) => filter.parsed),
      ...fields,
   ]);
   /** @type {number} Candidates examined between yields. */
   const batchSize = getBudget('SEARCH_BATCH_SIZE').value;
   /** @type {number} Candidates one call examines. */
   const scanMax = getBudget('SEARCH_SCAN_MAX').value;
   /** @type {{ exported: number, exportMax: number }} Exports used and allowed. */
   const used = {
      exported: 0,
      exportMax: getBudget('SEARCH_EXPORT_MAX').value,
   };

   /**
    * Yield to the event loop and stop when the call was aborted.
    * @returns {Promise<void>} Resolves when the search may go on.
    * @throws {ScriptError} `SEARCH_ABORTED`.
    */
   const pause = async () => {
      await yieldToEventLoop();
      if (signal?.aborted === true) {
         throw fail('SEARCH_ABORTED', 'The search was aborted; search again with the cursor to continue.');
      }
   };

   /** @type {Candidate[]} Every readable document with its ordering key. */
   const ordered = [];
   for (const item of items) {
      if (live && unreadable(item) !== null) {
         continue;
      }
      /** @type {string} The name; a Setting has none and shows its key. */
      const name = typeof item.name === 'string' ? item.name : typeof item.key === 'string' ? item.key : '';
      ordered.push({
         uuid: item.uuid,
         name,
         type: typeof item.type === 'string' ? item.type : '',
         source: item,
         live,
         key: keyOf(name, item.uuid),
      });
      if (ordered.length % batchSize === 0) {
         await pause();
      }
   }
   ordered.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

   /** @type {Candidate[]} The matches among the candidates examined. */
   const matches = [];
   /** @type {number} The candidates examined. */
   let scanned = 0;
   /** @type {boolean} Whether a cap stopped the scan before the end. */
   let cut = false;
   /** @type {string} The key of the last candidate examined. */
   let lastKey = after;
   for (const candidate of ordered) {
      if (candidate.key <= after) {
         continue;
      }
      if (scanned >= scanMax) {
         cut = true;
         break;
      }
      /** @type {boolean | null} Whether the candidate matches; null when the export cap stops the call. */
      let passes = false;
      if (
         (type === undefined || candidate.type === type) &&
         (needle === '' || candidate.name.toLowerCase().includes(needle))
      ) {
         passes = passesFilters(candidate, filters, used);
      }
      if (passes === null) {
         cut = true;
         break;
      }
      scanned += 1;
      lastKey = candidate.key;
      if (passes) {
         matches.push(candidate);
      }
      if (scanned % batchSize === 0) {
         await pause();
      }
   }
   /** @type {Candidate[]} The candidates of this page. */
   const page = matches.slice(0, limit);
   /** @type {unknown[][]} The rows of this page, before the page budget cuts them. */
   const rows = page.map((candidate) => {
      /** @type {unknown[]} The row: uuid, name, type and, when fields were asked for, their values. */
      const row = [
         candidate.uuid,
         truncateUtf8(candidate.name, VALUE_MAX_BYTES),
         candidate.type,
      ];
      if (fields.length > 0) {
         row.push(fieldValues(candidate, fields));
      }
      return row;
   });
   /** @type {number} The largest page. */
   const pageMax = getBudget('SEARCH_PAGE_MAX_BYTES').value;
   /**
    * Build the result for the first `count` rows.
    * @param {number} count - How many rows to keep.
    * @returns {SearchResult} The result.
    */
   const build = (count) => {
      /** @type {SearchResult} The result without a cursor. */
      const result = {
         rows: rows.slice(0, count),
         total: matches.length,
      };
      if (cut) {
         result.cut = true;
         result.scanned = scanned;
      }
      if (count < matches.length) {
         result.nextCursor = encodeCursor(page[count - 1].key);
      } else if (cut) {
         result.nextCursor = encodeCursor(lastKey);
      }
      if (fieldsDropped) {
         result.fieldsDropped = true;
      }
      return result;
   };
   /** @type {boolean} Whether a row lost its field values to fit the page. */
   let fieldsDropped = false;
   /** @type {number} The rows kept. */
   let count = rows.length;
   while (count > 1 && utf8Bytes(JSON.stringify(build(count))) > pageMax) {
      count -= 1;
   }
   if (count === 1 && rows[0].length > 3 && utf8Bytes(JSON.stringify(build(1))) > pageMax) {
      // A lone row whose field values overflow the page degrades to its uuid, name and type.
      rows[0] = rows[0].slice(0, 3);
      fieldsDropped = true;
   }
   return build(count);
}
