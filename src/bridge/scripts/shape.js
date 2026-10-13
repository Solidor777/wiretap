import { getBudget } from '$shared/budgets.js';
import { parsePath, resolvePath, resolvePaths } from '$shared/docPath.js';
import { truncateUtf8, utf8Bytes } from '$shared/utf8.js';

/**
 * @typedef {object} CompactOptions
 * @property {RegExp} [keyPattern] - Matches the key names of the `system` leaves that appear in the view; defaults to
 * `DEFAULT_KEY_PATTERN`.
 * @property {string[]} [embedded] - The names of the embedded collections to list as tuples; defaults to every
 * top-level array whose first element is an object with a string `_id`.
 */

/**
 * @typedef {{ ok: true, value: Record<string, unknown>, missing: string[] } | { ok: false, error: string }}
 * ProjectOutcome
 */

/**
 * @typedef {{ ok: true, values: Record<string, unknown>, missing: string[] } | { ok: false, error: string }}
 * PathsOutcome
 */

/**
 * The key names of the `system` leaves a compact view shows when the caller names no pattern.
 * @type {RegExp}
 */
export const DEFAULT_KEY_PATTERN = /^(value|max|min|level|rank|quantity|equipped|formula|damage|armor|cost)$/;

/**
 * Most `system` leaves in one compact view.
 * @type {number}
 */
export const COMPACT_LEAVES_MAX = 24;

/**
 * Deepest `system` nesting the leaf walk enters; the `system` object itself is level 1.
 * @type {number}
 */
const LEAF_DEPTH_MAX = 6;

/**
 * Most objects the leaf walk visits, so a huge or cyclic tree costs bounded work.
 * @type {number}
 */
const LEAF_NODES_MAX = 2000;

/**
 * Longest `system` leaf path kept in a compact view, in characters; a longer one is left out.
 * @type {number}
 */
const LEAF_PATH_MAX_CHARS = 96;

/**
 * Longest string value in a compact view or an ack, in UTF-8 bytes.
 * @type {number}
 */
const VALUE_MAX_BYTES = 64;

/**
 * Longest `uuid` in a compact view, in UTF-8 bytes.
 * @type {number}
 */
const UUID_MAX_BYTES = 96;

/**
 * Longest `type` in a compact view, in UTF-8 bytes.
 * @type {number}
 */
const TYPE_MAX_BYTES = 32;

/**
 * Most embedded collections one compact view lists; further collections are left out and the view is marked cut.
 * @type {number}
 */
const COLLECTIONS_MAX = 8;

/**
 * Longest embedded collection name in a compact view, in UTF-8 bytes; a longer name is shortened.
 * @type {number}
 */
const COLLECTION_NAME_MAX_BYTES = 32;

/**
 * Longest id of an embedded tuple, in UTF-8 bytes (a Foundry id is 16 characters).
 * @type {number}
 */
const TUPLE_ID_MAX_BYTES = 16;

/**
 * Longest name of an embedded tuple, in UTF-8 bytes.
 * @type {number}
 */
const TUPLE_NAME_MAX_BYTES = 24;

/**
 * Longest type of an embedded tuple, in UTF-8 bytes.
 * @type {number}
 */
const TUPLE_TYPE_MAX_BYTES = 16;

/**
 * Most fields in one ack.
 * @type {number}
 */
const ACK_KEYS_MAX = 16;

/**
 * Longest key in an ack, in UTF-8 bytes.
 * @type {number}
 */
const ACK_KEY_MAX_BYTES = 32;

/**
 * Longest ack string value to start from, in UTF-8 bytes; shortened until the whole ack fits.
 * @type {number}
 */
const ACK_VALUE_START_BYTES = 80;

/**
 * Check that a value is a plain object: not null, not an array.
 * @param {unknown} value - The candidate to check.
 * @returns {boolean} Whether it is.
 */
function isRecord(value) {
   return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an own property only.
 * @param {object} source - The object to read.
 * @param {string} key - The property name.
 * @returns {unknown} The own value, or undefined when absent or inherited.
 */
function own(source, key) {
   return Object.hasOwn(source, key) ? source[key] : undefined;
}

/**
 * Define an own, enumerable data property, so a key such as `__proto__` is stored as data.
 * @param {Record<string, unknown>} target - The object to extend.
 * @param {string} key - The property name.
 * @param {unknown} value - The property value.
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
 * Measure a value as the JSON text a tool returns.
 * @param {unknown} value - The value to measure.
 * @returns {number} The UTF-8 byte length of its JSON.
 */
function jsonBytes(value) {
   return utf8Bytes(JSON.stringify(value));
}

/**
 * Collect the scalar leaves of a `system` tree whose key matches the pattern. Depth-first in property order; arrays are
 * not entered and each object is entered once.
 * @param {unknown} system - The `system` value of the document.
 * @param {RegExp} pattern - Matches a leaf key; has no `g` or `y` flag.
 * @returns {Array<[string, string | number | boolean]>} At most `COMPACT_LEAVES_MAX` path and value pairs.
 */
function collectLeaves(system, pattern) {
   /** @type {Array<[string, string | number | boolean]>} The leaves found. */
   const leaves = [];
   /** @type {Set<object>} The objects already entered. */
   const seen = new Set();
   /** @type {{ nodes: number }} The visit counter. */
   const budget = { nodes: 0 };

   /**
    * Walk one object.
    * @param {Record<string, unknown>} node - The object.
    * @param {string} path - Its dotted path from the document.
    * @param {number} depth - Its nesting level.
    * @returns {void}
    */
   function walk(node, path, depth) {
      if (seen.has(node) || budget.nodes >= LEAF_NODES_MAX) {
         return;
      }
      seen.add(node);
      budget.nodes += 1;
      for (const key of Object.keys(node)) {
         if (leaves.length >= COMPACT_LEAVES_MAX) {
            return;
         }
         /** @type {unknown} The property value. */
         const value = node[key];
         /** @type {string} The property's dotted path. */
         const keyPath = `${path}.${key}`;
         if (
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))
         ) {
            if (pattern.test(key) && keyPath.length <= LEAF_PATH_MAX_CHARS) {
               leaves.push([
                  keyPath,
                  typeof value === 'string' ? truncateUtf8(value, VALUE_MAX_BYTES) : value,
               ]);
            }
         } else if (isRecord(value) && depth < LEAF_DEPTH_MAX) {
            walk(value, keyPath, depth + 1);
         }
      }
   }

   if (isRecord(system)) {
      walk(system, 'system', 1);
   }
   return leaves;
}

/**
 * Pick the embedded collections to list: the named ones, else every top-level array whose first element is an object
 * with a string `_id`.
 * @param {Record<string, unknown>} doc - The document export.
 * @param {string[] | undefined} named - The caller's collection names.
 * @returns {string[]} The collection names in property order.
 */
function embeddedNames(doc, named) {
   if (Array.isArray(named)) {
      return named.filter((name) => typeof name === 'string' && Array.isArray(own(doc, name)));
   }
   return Object.keys(doc).filter((key) => {
      const value = doc[key];
      return Array.isArray(value) && isRecord(value[0]) && typeof own(value[0], '_id') === 'string';
   });
}

/**
 * Build the compact tuple of one embedded document.
 * @param {unknown} element - The embedded document.
 * @returns {[string, string, string]} Its id, name and type, each bounded.
 */
function tupleOf(element) {
   /** @type {Record<string, unknown>} The document, or an empty object for a non-object element. */
   const doc = isRecord(element) ? element : {};
   /**
    * Read one string field, bounded.
    * @param {string} key - The field name.
    * @param {number} max - The byte bound.
    * @returns {string} The bounded text, or an empty string when the field is not a string.
    */
   const text = (key, max) => {
      const value = own(doc, key);
      return typeof value === 'string' ? truncateUtf8(value, max) : '';
   };
   return [
      text('_id', TUPLE_ID_MAX_BYTES),
      text('name', TUPLE_NAME_MAX_BYTES),
      text('type', TUPLE_TYPE_MAX_BYTES),
   ];
}

/**
 * Build the compact view of a document export: `uuid`, `name`, `type`, the `system` leaves whose key matches a pattern
 * (`fields`, at most 24), and the embedded documents as `[id, name, type]` tuples (`embedded`: at most 8 collections,
 * their names shortened to 32 bytes, at most 40 tuples in all, with the true `total` of each collection). Every string
 * is bounded. While the serialized view exceeds `COMPACT_VIEW_MAX_BYTES` it loses entries and `cut` is set: the larger
 * of the leaves and the tuples loses its last entry, then any remaining leaf, then a collection with no tuples left,
 * then the header fields, so the size bound holds for any data. Reads own properties only and never throws.
 * @param {unknown} doc - The canonical document export (plain data).
 * @param {CompactOptions} [options] - The leaf key pattern and the embedded collection names.
 * @returns {Record<string, unknown>} The compact view; `{}` when the input is not an object.
 */
function compact(doc, options = {}) {
   if (!isRecord(doc)) {
      return {};
   }
   try {
      /** @type {number} The view budget. */
      const budget = getBudget('COMPACT_VIEW_MAX_BYTES').value;
      /** @type {number} The tuple cap. */
      const tuplesMax = getBudget('COMPACT_EMBEDDED_TUPLES_MAX').value;
      /** @type {RegExp} The caller's key pattern, or the default. */
      const requested = options.keyPattern ?? DEFAULT_KEY_PATTERN;
      /** @type {RegExp} The key pattern without stateful flags, so repeated tests do not depend on `lastIndex`. */
      const pattern = new RegExp(requested.source, requested.flags.replace(/[gy]/g, ''));
      /** @type {Record<string, unknown>} The view header. */
      const header = {};
      for (const [key, max] of [
         ['uuid', UUID_MAX_BYTES],
         ['name', VALUE_MAX_BYTES],
         ['type', TYPE_MAX_BYTES],
      ]) {
         const value = own(doc, key);
         if (typeof value === 'string') {
            header[key] = truncateUtf8(value, max);
         }
      }
      /** @type {Array<[string, string | number | boolean]>} The leaves, trimmed to fit. */
      const leaves = collectLeaves(own(doc, 'system'), pattern);
      /**
       * The embedded collections and their tuples.
       * @type {Array<{ name: string, total: number, rows: Array<[string, string, string]> }>}
       */
      const collections = [];
      /** @type {number} Embedded tuples the view may still list. */
      let remaining = tuplesMax;
      /** @type {boolean} Whether a collection was left out of the view. */
      let skipped = false;
      /** @type {Set<string>} The collection names already listed, as shortened. */
      const listedNames = new Set();
      for (const full of embeddedNames(doc, options.embedded)) {
         /** @type {string} The collection name as shown. */
         const name = truncateUtf8(full, COLLECTION_NAME_MAX_BYTES);
         if (collections.length >= COLLECTIONS_MAX || listedNames.has(name)) {
            skipped = true;
            continue;
         }
         listedNames.add(name);
         /** @type {unknown[]} The collection's elements. */
         const elements = doc[full];
         /** @type {Array<[string, string, string]>} The tuples of this collection. */
         const rows = [];
         for (let index = 0; index < elements.length && remaining > 0; index += 1) {
            rows.push(tupleOf(elements[index]));
            remaining -= 1;
         }
         collections.push({
            name,
            total: elements.length,
            rows,
         });
      }

      /**
       * Assemble the view from the current leaves and tuples.
       * @param {boolean} cut - Whether to mark the view as cut.
       * @returns {Record<string, unknown>} The view.
       */
      const assemble = (cut) => {
         /** @type {Record<string, unknown>} The view under construction. */
         const view = { ...header };
         if (leaves.length > 0) {
            view.fields = Object.fromEntries(leaves);
         }
         if (collections.length > 0) {
            view.embedded = {};
            for (const collection of collections) {
               setOwn(view.embedded, collection.name, {
                  total: collection.total,
                  rows: collection.rows,
               });
            }
         }
         if (cut) {
            view.cut = true;
         }
         return view;
      };

      /** @type {boolean} Whether an entry was dropped to fit the budget or a collection was left out. */
      let cut = skipped;
      /** @type {string[]} The header fields in the order they are dropped when nothing else is left to drop. */
      const headerDrop = ['type', 'name', 'uuid'];
      while (jsonBytes(assemble(cut)) > budget) {
         cut = true;
         /** @type {number} The bytes the leaves take. */
         const leafBytes = jsonBytes(leaves);
         /** @type {number} The bytes the tuples take. */
         const tupleBytes = jsonBytes(collections.map((collection) => collection.rows));
         /** @type {typeof collections[number] | undefined} The last collection that still has a tuple. */
         const last = collections.findLast((collection) => collection.rows.length > 0);
         if (leaves.length > 0 && (leafBytes >= tupleBytes || last === undefined)) {
            leaves.pop();
         } else if (last !== undefined) {
            last.rows.pop();
         } else if (collections.length > 0) {
            collections.pop();
         } else {
            /** @type {string | undefined} The next header field to drop. */
            const field = headerDrop.shift();
            if (field === undefined) {
               break;
            }
            delete header[field];
         }
      }
      return assemble(cut);
   } catch {
      return {};
   }
}

/**
 * Turn a path-grammar refusal into the error text of a shape result. `shared/docPath.js` bounds its messages to
 * `PATH_ERROR_MAX_BYTES` (256) and the code adds under 30 bytes.
 * @param {{ code: string, message: string }} error - The refusal from `shared/docPath.js`.
 * @returns {string} `<code>: <message>`.
 */
function pathErrorText(error) {
   return `${error.code}: ${error.message}`;
}

/**
 * Whether one list of names starts with another.
 * @param {string[]} prefix - The candidate prefix.
 * @param {string[]} names - The names to test.
 * @returns {boolean} True when `names` begins with every name of `prefix` (equal lists count).
 */
function startsWith(prefix, names) {
   return prefix.length <= names.length && prefix.every((name, index) => name === names[index]);
}

/**
 * Project a document export onto up to 20 field paths: the result holds only those fields, nested as in the export, so
 * `system.attributes.hp.value` returns `{ system: { attributes: { hp: { value } } } }`. An embedded element addressed
 * by `_id` keeps that id as an object key. A field that resolves to nothing is listed in `missing`. A field that lies
 * inside an earlier one is skipped and a field that contains earlier ones replaces them. A wildcard is refused (use
 * `paths`), as is any path `shared/docPath.js` refuses.
 * @param {unknown} doc - The canonical document export (plain data).
 * @param {unknown} fields - The field paths.
 * @returns {ProjectOutcome} The projection and the missing fields, or the refusal.
 */
function project(doc, fields) {
   try {
      /** @type {number} The most fields per call. */
      const fieldsMax = getBudget('PATHS_PER_CALL_MAX').value;
      if (!Array.isArray(fields) || fields.length === 0 || fields.length > fieldsMax) {
         return {
            ok: false,
            error: `PATH_LIMIT: fields must be a list of 1 to ${fieldsMax} paths.`,
         };
      }
      /** @type {Array<{ field: string, names: string[], found: boolean, value: unknown }>} The resolved fields. */
      const resolved = [];
      for (const field of new Set(fields)) {
         /** @type {ReturnType<typeof parsePath>} The parse of the field. */
         const parsed = parsePath(field);
         if (!parsed.ok) {
            return {
               ok: false,
               error: pathErrorText(parsed.error),
            };
         }
         if (parsed.segments.some((segment) => segment.type === 'wildcard')) {
            return {
               ok: false,
               error: 'PATH_INVALID: fields do not accept a wildcard; use paths.',
            };
         }
         /** @type {ReturnType<typeof resolvePath>} What the field resolves to. */
         const found = resolvePath(doc, parsed.segments);
         resolved.push({
            field,
            names: parsed.segments.map((segment) => segment.name),
            found: found.found,
            value: found.found ? found.value : undefined,
         });
      }
      /** @type {Record<string, unknown>} The projection. */
      const value = {};
      /** @type {string[]} The fields that resolved to nothing. */
      const missing = [];
      /** @type {string[][]} The name lists assigned so far. */
      const assigned = [];
      for (const entry of resolved) {
         if (!entry.found) {
            missing.push(entry.field);
            continue;
         }
         if (assigned.some((earlier) => startsWith(earlier, entry.names))) {
            continue;
         }
         assigned.push(entry.names);
         /** @type {Record<string, unknown>} The object being filled. */
         let target = value;
         for (const name of entry.names.slice(0, -1)) {
            // A parent is either built here or absent: a field inside an earlier whole field was skipped above, so no
            // object of the document is ever written to.
            /** @type {Record<string, unknown>} The parent for the next segment. */
            const next = isRecord(target[name]) ? target[name] : {};
            setOwn(target, name, next);
            target = next;
         }
         setOwn(target, entry.names.at(-1), entry.value);
      }
      return {
         ok: true,
         value,
         missing,
      };
   } catch {
      return {
         ok: false,
         error: 'PATH_INVALID: the document could not be read.',
      };
   }
}

/**
 * Read up to 20 paths from a document export with the shared path grammar, wildcards included: the result is
 * `{ values: { <path>: value }, missing: [<path>] }`.
 * @param {unknown} doc - The canonical document export (plain data).
 * @param {unknown} list - The path strings to read.
 * @returns {PathsOutcome} The values and missing paths, or the refusal.
 */
function paths(doc, list) {
   try {
      /** @type {ReturnType<typeof resolvePaths>} The shared resolver's verdict. */
      const result = resolvePaths(doc, list);
      if (!result.ok) {
         return {
            ok: false,
            error: pathErrorText(result.error),
         };
      }
      return {
         ok: true,
         values: result.values,
         missing: result.missing,
      };
   } catch {
      return {
         ok: false,
         error: 'PATH_INVALID: the document could not be read.',
      };
   }
}

/**
 * Build an acknowledgement of a write that fits the 256-byte ack budget: the scalar fields of the input (strings,
 * finite numbers, booleans, null), at most 16, with string values shortened until the whole ack fits and then fields
 * dropped from the end if they still do not. Keys that are members of `Object.prototype` are left out.
 * @param {unknown} fields - The fields to acknowledge.
 * @returns {Record<string, string | number | boolean | null>} A fresh object within `ACK_MAX_BYTES`.
 */
function ack(fields) {
   if (!isRecord(fields)) {
      return {};
   }
   try {
      /** @type {number} The ack budget. */
      const budget = getBudget('ACK_MAX_BYTES').value;
      /** @type {Array<[string, string | number | boolean | null]>} The scalar entries. */
      const entries = [];
      for (const key of Object.keys(fields)) {
         if (entries.length >= ACK_KEYS_MAX) {
            break;
         }
         /** @type {unknown} The field value. */
         const value = fields[key];
         if (key in Object.prototype) {
            continue;
         }
         if (
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            value === null ||
            (typeof value === 'number' && Number.isFinite(value))
         ) {
            entries.push([
               truncateUtf8(key, ACK_KEY_MAX_BYTES),
               value,
            ]);
         }
      }
      /**
       * Build the ack from the kept entries with strings cut to a byte bound.
       * @param {number} stringBytes - The bound of each string value.
       * @returns {Record<string, string | number | boolean | null>} The candidate ack.
       */
      const build = (stringBytes) => {
         /** @type {Record<string, string | number | boolean | null>} The candidate under construction. */
         const candidate = {};
         for (const [key, value] of entries) {
            setOwn(candidate, key, typeof value === 'string' ? truncateUtf8(value, stringBytes) : value);
         }
         return candidate;
      };
      /** @type {number} The current string bound. */
      let cap = ACK_VALUE_START_BYTES;
      /** @type {Record<string, string | number | boolean | null>} The candidate ack. */
      let candidate = build(cap);
      // Shorten the strings first; once they cannot shrink further, drop fields from the end. An empty ack always fits.
      while (jsonBytes(candidate) > budget) {
         if (cap > 4) {
            cap = Math.floor(cap / 2);
         } else {
            entries.pop();
         }
         candidate = build(cap);
      }
      return candidate;
   } catch {
      return {};
   }
}

/**
 * The result shaping helpers a script receives as `ctx.shape`. All are pure functions of plain data.
 * @type {Readonly<{ compact: typeof compact, project: typeof project, paths: typeof paths, ack: typeof ack }>}
 */
export const shape = Object.freeze({
   compact,
   project,
   paths,
   ack,
});
