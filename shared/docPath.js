/**
 * Document path grammar shared by the sidecar and the Foundry client. A path is dot-separated segments over a
 * canonical document export (ids kept): object keys, embedded documents, plain array elements by integer index, and
 * at most one `*` wildcard segment over an array. Plain JS with no dependencies because both sides import it. The
 * resolver reads plain data only; it never calls into Foundry.
 *
 * Limits: a path is at most `PATH_BYTES_MAX` UTF-8 bytes and `PATH_SEGMENTS_MAX` segments, checked before it is
 * split. A `.` always separates segments, so a key that contains a literal `.` cannot be addressed.
 *
 * Reads and writes are asymmetric on embedded collections. A read accepts, as the segment after the collection, an
 * element `_id` or an integer index into the array; when an in-range index and the `_id` of a different element
 * collide, the lookup is not found. A write addresses an embedded document by `_id` only: a purely numeric segment
 * there is refused, because an index would depend on array order at the time of the write.
 *
 * Error codes: `PATH_INVALID`, `PATH_UNSAFE_SEGMENT`, `PATH_WILDCARD_WRITE`, `PATH_LIMIT`, `PATH_INVALID_OP`,
 * `PATH_DUPLICATE`, `PATH_CONFLICT`, `PATH_UNSAFE_VALUE` and `PATH_AMBIGUOUS` (a wildcard whose result keys collide).
 */

import { getBudget } from './budgets.js';

/**
 * @typedef {{type: 'key', name: string} | {type: 'wildcard'}} PathSegment
 */

/**
 * @typedef {'PATH_INVALID' | 'PATH_UNSAFE_SEGMENT' | 'PATH_WILDCARD_WRITE' | 'PATH_LIMIT' | 'PATH_INVALID_OP'
 * | 'PATH_DUPLICATE' | 'PATH_CONFLICT' | 'PATH_UNSAFE_VALUE' | 'PATH_AMBIGUOUS'} PathErrorCode
 */

/**
 * @typedef {object} PathError
 * @property {PathErrorCode} code - Machine-readable reason.
 * @property {string} message - Reason within the `PATH_ERROR_MAX_BYTES` budget; the only caller text it can name is
 * a refused segment, which is `prototype` or a member of `Object.prototype`.
 */

/**
 * @typedef {{ok: true, segments: PathSegment[]} | {ok: false, error: PathError}} ParseResult
 */

/**
 * @typedef {'set' | 'replace' | 'delete'} WriteOp
 */

/**
 * @typedef {object} Patch
 * @property {string} path - The path to write.
 * @property {*} [value] - The value; required for `set` and `replace`, ignored for `delete`.
 * @property {WriteOp} [op] - Defaults to `set`.
 */

/**
 * @typedef {object} PathChange
 * @property {string} path - The path, relative to the document it is applied to.
 * @property {*} [value] - The value; absent for `delete`.
 * @property {WriteOp} op - How the client applies the value.
 */

/**
 * @typedef {object} EmbeddedGroup
 * @property {string} collection - The embedded collection name as it appears in the path, for example `items`; the
 * client maps it to the document name (`Item`) for the embedded update.
 * @property {Array<{_id: string, changes: PathChange[]}>} entries - One entry per embedded document id.
 */

/**
 * @typedef {{ok: true, document: PathChange[], embedded: EmbeddedGroup[]} | {ok: false, error: PathError}} GroupResult
 */

/**
 * @typedef {{found: true, value: *} | {found: false, code?: 'PATH_AMBIGUOUS'}} Resolution
 */

/**
 * @typedef {{ok: true, values: Record<string, *>, missing: string[]} | {ok: false, error: PathError}} ReadResult
 */

/**
 * Names that are prototype-pollution vectors: refused as path segments and as own keys of written values.
 * `parsePath` refuses these plus every member of `Object.prototype` as segments (`prototype` itself is not a member).
 * @type {readonly string[]}
 */
export const UNSAFE_SEGMENTS = Object.freeze([
   '__proto__',
   'constructor',
   'prototype',
]);

/**
 * The write operations a patch may carry. The client builds Foundry's `_replace` and `_del` update operators from
 * them, because operators cannot cross the JSON wire.
 * @type {readonly WriteOp[]}
 */
export const WRITE_OPS = Object.freeze([
   'set',
   'replace',
   'delete',
]);

/**
 * The wildcard segment text.
 * @type {string}
 */
const WILDCARD = '*';

/**
 * A canonical non-negative integer: `0` or digits with no leading zero.
 * @type {RegExp}
 */
const INDEX_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * A purely numeric segment, leading zeros allowed.
 * @type {RegExp}
 */
const NUMERIC_PATTERN = /^\d+$/;

/**
 * Deepest object nesting a written value may have, counting the value itself as level 1.
 * @type {number}
 */
const VALUE_DEPTH_MAX = 32;

/**
 * UTF-8 encoder that measures path sizes.
 * @type {TextEncoder}
 */
const ENCODER = new TextEncoder();

/**
 * Builds a failed result.
 * @param {PathErrorCode} code - Machine-readable reason.
 * @param {string} message - Human-readable reason.
 * @returns {{ok: false, error: PathError}} The failure.
 */
function fail(code, message) {
   return {
      ok: false,
      error: {
         code,
         message,
      },
   };
}

/**
 * Defines an own, enumerable data property, so a key such as `__proto__` is stored as data instead of changing the
 * target's prototype.
 * @param {Record<string, *>} target - The object to extend.
 * @param {string} key - The property name.
 * @param {*} value - The property value.
 * @returns {void}
 */
function setOwn(target, key, value) {
   Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
   });
}

/**
 * Tells whether a value is a non-null object (arrays included).
 * @param {*} value - The value to test.
 * @returns {boolean} True for an object or array.
 */
function isObject(value) {
   return typeof value === 'object' && value !== null;
}

/**
 * Parses a dot-separated path into segments. Refuses non-strings, over-long paths, empty segments, more than one
 * wildcard, `prototype` and every segment that is a member of `Object.prototype` (`__proto__`, `toString`, ...),
 * because Foundry's `setProperty` tests for `undefined` and so sees inherited members as existing values.
 * @param {*} path - The path text; anything that is not a non-empty string is refused.
 * @returns {ParseResult} The segments, or the refusal.
 */
export function parsePath(path) {
   if (typeof path !== 'string' || path === '') {
      return fail('PATH_INVALID', 'Path must be a non-empty string.');
   }
   /** @type {number} Largest accepted path size in UTF-8 bytes. */
   const bytesMax = getBudget('PATH_BYTES_MAX').value;
   // A character is at least one byte, so a longer string is over the limit without encoding it.
   if (path.length > bytesMax || ENCODER.encode(path).length > bytesMax) {
      return fail('PATH_LIMIT', `A path may be at most ${bytesMax} bytes.`);
   }
   /** @type {string[]} The path text split at every dot. */
   const names = path.split('.');
   /** @type {number} Largest accepted segment count. */
   const segmentsMax = getBudget('PATH_SEGMENTS_MAX').value;
   if (names.length > segmentsMax) {
      return fail('PATH_LIMIT', `A path may have at most ${segmentsMax} segments.`);
   }
   /** @type {PathSegment[]} The parsed segments. */
   const segments = [];
   for (const name of names) {
      if (name === '') {
         return fail('PATH_INVALID', 'Path must not contain an empty segment.');
      }
      if (UNSAFE_SEGMENTS.includes(name) || name in Object.prototype) {
         return fail('PATH_UNSAFE_SEGMENT', `Path segment "${name}" is refused.`);
      }
      if (name === WILDCARD) {
         if (segments.some((segment) => segment.type === 'wildcard')) {
            return fail('PATH_INVALID', 'A path may contain at most one wildcard segment.');
         }
         segments.push({ type: 'wildcard' });
      } else {
         segments.push({
            type: 'key',
            name,
         });
      }
   }
   return {
      ok: true,
      segments,
   };
}

/**
 * Steps from a node to one child by key name. On an array, a canonical integer is an index and any other name
 * is an element `_id`. A name that is both an in-range index and the `_id` of a different element is ambiguous and
 * is not resolved, so a read never lands on the wrong element. Only own properties count, on objects and for `_id`.
 * @param {*} node - The current value.
 * @param {string} name - The key segment.
 * @returns {Resolution} The child, or not found.
 */
function stepKey(node, name) {
   if (Array.isArray(node)) {
      /** @type {number} The index the name denotes, or -1 when it is not a canonical integer. */
      const index = INDEX_PATTERN.test(name) ? Number(name) : -1;
      /** @type {boolean} Whether the name is an index inside the array. */
      const indexInRange = index >= 0 && index < node.length;
      /** @type {number} Position of the element whose `_id` equals the name, or -1. */
      const idIndex = node.findIndex((element) => {
         return isObject(element) && Object.hasOwn(element, '_id') && element._id === name;
      });
      if (idIndex !== -1 && indexInRange && idIndex !== index) {
         return { found: false };
      }
      if (idIndex !== -1) {
         return {
            found: true,
            value: node[idIndex],
         };
      }
      if (indexInRange) {
         return {
            found: true,
            value: node[index],
         };
      }
      return { found: false };
   }
   if (isObject(node) && Object.hasOwn(node, name) && node[name] !== undefined) {
      return {
         found: true,
         value: node[name],
      };
   }
   return { found: false };
}

/**
 * Expands a wildcard over an array: each element is resolved against the remaining key segments and keyed by its own
 * `_id` string, or by its index when it has none. Elements the rest does not resolve for are omitted. An empty array
 * yields `{}`; a non-empty array where no element resolves, and a node that is not an array, are not found. When two
 * resolved elements would share a result key the whole lookup is not found with `PATH_AMBIGUOUS`.
 * @param {*} node - The value the wildcard applies to.
 * @param {PathSegment[]} segments - All segments of the path.
 * @param {number} from - Index of the first segment after the wildcard.
 * @returns {Resolution} The keyed result, or not found.
 */
function expandWildcard(node, segments, from) {
   if (!Array.isArray(node)) {
      return { found: false };
   }
   /** @type {Record<string, *>} The result keyed by element id or index. */
   const result = {};
   /** @type {Set<string>} Result keys already used. */
   const keys = new Set();
   for (let index = 0; index < node.length; index++) {
      /** @type {Resolution} What the rest of the path resolves to for this element. */
      const resolved = walk(node[index], segments, from, false);
      if (!resolved.found) {
         continue;
      }
      /** @type {*} The element being keyed. */
      const element = node[index];
      /** @type {string} The result key of the element. */
      const key = isObject(element) && Object.hasOwn(element, '_id') && typeof element._id === 'string'
         ? element._id
         : String(index);
      if (keys.has(key)) {
         return {
            found: false,
            code: 'PATH_AMBIGUOUS',
         };
      }
      keys.add(key);
      setOwn(result, key, resolved.value);
   }
   if (node.length > 0 && keys.size === 0) {
      return { found: false };
   }
   return {
      found: true,
      value: result,
   };
}

/**
 * Walks segments from a position with a loop. A wildcard is expanded at most once: it hands the rest of the path to
 * `expandWildcard`, which walks it with wildcards disallowed, so recursion depth never grows with the path.
 * @param {*} node - The value to start from.
 * @param {PathSegment[]} segments - The parsed segments.
 * @param {number} from - Index of the first segment to apply.
 * @param {boolean} allowWildcard - Whether a wildcard segment may be expanded; a second one is not found.
 * @returns {Resolution} The value, or not found.
 */
function walk(node, segments, from, allowWildcard) {
   /** @type {*} The value reached so far. */
   let current = node;
   for (let position = from; position < segments.length; position++) {
      /** @type {PathSegment} The segment being applied. */
      const segment = segments[position];
      if (segment.type === 'wildcard') {
         return allowWildcard ? expandWildcard(current, segments, position + 1) : { found: false };
      }
      /** @type {Resolution} The child the segment names. */
      const child = stepKey(current, segment.name);
      if (!child.found) {
         return child;
      }
      current = child.value;
   }
   return {
      found: true,
      value: current,
   };
}

/**
 * Resolves parsed segments against a document export. A wildcard over an array returns an object keyed by each
 * element's `_id` (its index when it has none) holding what the rest of the path resolves to for that element;
 * elements the rest does not resolve for are omitted. An empty array yields `{}`; a non-empty array where no
 * element resolves, and a wildcard over anything that is not an array, are not found. Two elements that would
 * produce the same key make the lookup not found with `code: 'PATH_AMBIGUOUS'`. Segments after a wildcard must be
 * keys; a second wildcard is not found. Values are returned by reference, not copied.
 * @param {*} node - The export, or a node inside it.
 * @param {PathSegment[]} segments - Parsed segments, as returned by `parsePath`.
 * @returns {Resolution} The value, or not found.
 */
export function resolvePath(node, segments) {
   return walk(node, segments, 0, true);
}

/**
 * Resolves up to `PATHS_PER_CALL_MAX` paths against a document export. A repeated path is read once (the first
 * occurrence stays). A path that resolves to nothing, or to an ambiguous wildcard, is listed in `missing` (request
 * order) and is not an error; a call whose every path is missing still succeeds. A malformed, over-long or unsafe
 * path refuses the whole call and returns no values; the paths echoed in `values` and `missing` are each within
 * `PATH_BYTES_MAX`.
 * @param {*} documentExport - The canonical export (ids kept).
 * @param {string[]} paths - The paths to read.
 * @returns {ReadResult} `{ok: true, values: {<path>: value}, missing}`, or the refusal.
 */
export function resolvePaths(documentExport, paths) {
   if (!Array.isArray(paths) || paths.length === 0) {
      return fail('PATH_INVALID', 'Paths must be a non-empty array of strings.');
   }
   /** @type {number} Most paths one call may carry. */
   const pathsMax = getBudget('PATHS_PER_CALL_MAX').value;
   if (paths.length > pathsMax) {
      return fail('PATH_LIMIT', `At most ${pathsMax} paths are allowed per call.`);
   }
   /** @type {Array<{path: string, segments: PathSegment[]}>} The distinct paths with their segments. */
   const parsed = [];
   for (const path of new Set(paths)) {
      /** @type {ParseResult} The parse of this path. */
      const result = parsePath(path);
      if (!result.ok) {
         return result;
      }
      parsed.push({
         path,
         segments: result.segments,
      });
   }
   /** @type {Record<string, *>} Resolved values keyed by path. */
   const values = {};
   /** @type {string[]} Paths that resolved to nothing. */
   const missing = [];
   for (const { path, segments } of parsed) {
      /** @type {Resolution} What the path resolved to. */
      const resolved = resolvePath(documentExport, segments);
      if (resolved.found) {
         setOwn(values, path, resolved.value);
      } else {
         missing.push(path);
      }
   }
   return {
      ok: true,
      values,
      missing,
   };
}

/**
 * Scans a written value, without recursion, for an own key named like an `UNSAFE_SEGMENTS` entry and for nesting
 * deeper than `VALUE_DEPTH_MAX`. Each object is scanned once, so a cyclic value terminates.
 * @param {*} value - The patch value.
 * @returns {'key' | 'depth' | null} What was found, or null when the value is acceptable.
 */
function findUnsafeValue(value) {
   if (!isObject(value)) {
      return null;
   }
   /** @type {Array<{node: object, depth: number}>} Objects still to scan. */
   const pending = [{
      node: value,
      depth: 1,
   }];
   /** @type {Set<object>} Objects already scanned. */
   const seen = new Set();
   while (pending.length > 0) {
      const { node, depth } = pending.pop();
      if (seen.has(node)) {
         continue;
      }
      seen.add(node);
      if (depth > VALUE_DEPTH_MAX) {
         return 'depth';
      }
      for (const key of Object.keys(node)) {
         if (UNSAFE_SEGMENTS.includes(key)) {
            return 'key';
         }
         if (isObject(node[key])) {
            pending.push({
               node: node[key],
               depth: depth + 1,
            });
         }
      }
   }
   return null;
}

/**
 * Tells whether one list of segment names starts with another.
 * @param {string[]} prefix - The candidate prefix.
 * @param {string[]} names - The names to test.
 * @returns {boolean} True when `names` begins with every name of `prefix` (equal lists count).
 */
function startsWith(prefix, names) {
   return prefix.length <= names.length && prefix.every((name, index) => name === names[index]);
}

/**
 * Groups path-scoped writes by the document they apply to. A path whose first segment names one of
 * `embeddedCollections` is `<collection>.<_id>.<field path>` and becomes a change relative to that embedded
 * document, grouped per collection and per id in first-use order, so the client issues one embedded update per
 * collection. The group's `collection` is the collection name as written (`items`); the client maps it to the
 * document name. Every other path is a change on the document itself. A `delete` change carries no value.
 * Refused: wildcard and unsafe paths, duplicate paths, a path that is a prefix of another patch path
 * (`PATH_CONFLICT`), unknown ops, an embedded path with no field after the id, a purely numeric embedded id segment
 * (embedded writes address documents by `_id`), a malformed `embeddedCollections`, and a set or replace value with an
 * own `__proto__`, `constructor` or `prototype` key or more than 32 levels of nesting (`PATH_UNSAFE_VALUE`). Only
 * embedded collections of the document itself are grouped; a deeper embedded path stays part of the relative path.
 * @param {Patch[]} patches - The writes, at most `PATHS_PER_CALL_MAX`.
 * @param {string[]} embeddedCollections - Names of the document's embedded collections, for example `['items']`.
 * @returns {GroupResult} The grouped changes, or the refusal.
 */
export function groupWrites(patches, embeddedCollections) {
   if (!Array.isArray(patches) || patches.length === 0) {
      return fail('PATH_INVALID', 'Patches must be a non-empty array.');
   }
   /** @type {number} Most patches one call may carry. */
   const pathsMax = getBudget('PATHS_PER_CALL_MAX').value;
   if (patches.length > pathsMax) {
      return fail('PATH_LIMIT', `At most ${pathsMax} paths are allowed per call.`);
   }
   if (!Array.isArray(embeddedCollections) || !embeddedCollections.every((name) => typeof name === 'string')) {
      return fail('PATH_INVALID', 'Embedded collections must be an array of strings.');
   }
   /** @type {PathChange[]} Changes on the document itself. */
   const document = [];
   /** @type {EmbeddedGroup[]} Changes grouped per embedded collection and id. */
   const embedded = [];
   /** @type {Set<string>} Path texts already seen. */
   const seen = new Set();
   /** @type {string[][]} Segment names of the patches accepted so far. */
   const accepted = [];
   for (const patch of patches) {
      if (!isObject(patch) || Array.isArray(patch)) {
         return fail('PATH_INVALID', 'Each patch must be an object with a path.');
      }
      /** @type {*} The requested op, `set` when absent. */
      const op = patch.op === undefined ? 'set' : patch.op;
      if (!WRITE_OPS.includes(op)) {
         return fail('PATH_INVALID_OP', `Op must be one of ${WRITE_OPS.join(', ')}.`);
      }
      /** @type {ParseResult} The parse of the patch path. */
      const parsed = parsePath(patch.path);
      if (!parsed.ok) {
         return parsed;
      }
      if (op !== 'delete' && patch.value === undefined) {
         return fail('PATH_INVALID', 'A set or replace patch requires a value.');
      }
      if (parsed.segments.some((segment) => segment.type === 'wildcard')) {
         return fail('PATH_WILDCARD_WRITE', 'Wildcard paths cannot be written; list explicit ids.');
      }
      if (op !== 'delete') {
         /** @type {'key' | 'depth' | null} What makes the value unsafe, if anything. */
         const unsafe = findUnsafeValue(patch.value);
         if (unsafe === 'key') {
            return fail('PATH_UNSAFE_VALUE', `A value may not contain the keys ${UNSAFE_SEGMENTS.join(', ')}.`);
         }
         if (unsafe === 'depth') {
            return fail('PATH_UNSAFE_VALUE', `A value may be nested at most ${VALUE_DEPTH_MAX} levels.`);
         }
      }
      if (seen.has(patch.path)) {
         return fail('PATH_DUPLICATE', 'Each path may appear only once.');
      }
      seen.add(patch.path);
      /** @type {string[]} The key names of the path. */
      const names = parsed.segments.map((segment) => segment.name);
      if (accepted.some((other) => startsWith(other, names) || startsWith(names, other))) {
         return fail('PATH_CONFLICT', 'A path may not be a prefix of another path in the same call.');
      }
      accepted.push(names);
      /** @type {PathChange} The change in document-relative or embedded-relative form. */
      const change = op === 'delete'
         ? {
            path: patch.path,
            op,
         }
         : {
            path: patch.path,
            value: patch.value,
            op,
         };
      if (!embeddedCollections.includes(names[0])) {
         document.push(change);
         continue;
      }
      if (names.length < 3) {
         return fail('PATH_INVALID', 'An embedded path must name a field inside the embedded document.');
      }
      if (NUMERIC_PATTERN.test(names[1])) {
         return fail('PATH_INVALID', 'Embedded writes address documents by _id, not by index.');
      }
      change.path = names.slice(2).join('.');
      /** @type {EmbeddedGroup | undefined} The group of this collection, once created. */
      let group = embedded.find((candidate) => candidate.collection === names[0]);
      if (group === undefined) {
         group = {
            collection: names[0],
            entries: [],
         };
         embedded.push(group);
      }
      /** @type {{_id: string, changes: PathChange[]} | undefined} The entry of this embedded id, once created. */
      let entry = group.entries.find((candidate) => candidate._id === names[1]);
      if (entry === undefined) {
         entry = {
            _id: names[1],
            changes: [],
         };
         group.entries.push(entry);
      }
      entry.changes.push(change);
   }
   return {
      ok: true,
      document,
      embedded,
   };
}
