/**
 * The one reader of Foundry's update operators in written keys and values. Foundry spells an operator three ways, and
 * every spelling reaches the same effect (MEASURED on 14.364):
 *
 * 1. A key prefix on a path segment, `==name` (replace) and `-=name` (delete). `isDeletionKey` in
 * `common/utils/helpers.mjs` decides it, per segment, after a dotted key is expanded.
 * 2. An operator object, `ForcedReplacement` or `ForcedDeletion` (`common/data/operators.mjs`).
 * 3. A serialized wrapper, an object with the key `__$OPERATOR$__` that `SchemaField.reconstructOperator` rebuilds
 * into an operator object.
 *
 * Wiretap lets an operator exist only through the explicit `op` field of a patch. Every other spelling in a written
 * key, path or value is refused, and every caller finds it through this module, so no caller keeps its own pattern.
 */

/**
 * The key that marks a serialized operator object, as in `common/data/operators.mjs`.
 * @type {string}
 */
export const OPERATOR_IDENTIFIER = '__$OPERATOR$__';

/**
 * The data key and path segment under which flag scopes live.
 * @type {string}
 */
export const FLAGS_KEY = 'flags';

/**
 * The module flag scope Wiretap keeps for its own records (the idempotency record). A write cannot touch it, so a
 * caller can neither forge nor erase a record.
 * @type {string}
 */
export const FLAG_SCOPE = 'wiretap';

/**
 * Tell whether a path segment carries an operator prefix. The same test as Foundry's `isDeletionKey`
 * (`common/utils/helpers.mjs`): the second character is `=` and the first is `=` or `-`.
 * @param {unknown} segment - One segment of a key.
 * @returns {boolean} True when the segment starts with `==` or `-=`.
 */
export function isOperatorKey(segment) {
   return typeof segment === 'string' && segment[1] === '=' && (segment[0] === '=' || segment[0] === '-');
}

/**
 * @typedef {object} SplitKey
 * @property {string[]} names - The segments without their operator prefixes.
 * @property {Array<'replace' | 'delete' | null>} operators - The operator each segment carried, `null` for none.
 */

/**
 * Split a data key or a dotted path into the names Foundry reads from it and the operator each segment carries.
 * Foundry expands a dotted key into nested objects before it cleans the data (`expandObjectInPlace` in
 * `common/utils/helpers.mjs`), so `flags.-=scope` names `flags` and `scope`, the second one deleted.
 * @param {string} key - A data key or a dotted path.
 * @returns {SplitKey} The names and the operators, one entry per segment.
 */
export function splitKey(key) {
   /** @type {string[]} The segments the key expands to. */
   const segments = String(key).split('.');
   return {
      names: segments.map((segment) => (isOperatorKey(segment) ? segment.slice(2) : segment)),
      operators: segments.map((segment) => {
         if (!isOperatorKey(segment)) {
            return null;
         }
         return segment[0] === '=' ? 'replace' : 'delete';
      }),
   };
}

/**
 * The names of a key or path, operator prefixes removed.
 * @param {string} key - A data key or a dotted path.
 * @returns {string[]} The segments without their operator prefixes.
 */
export function keyNames(key) {
   return splitKey(key).names;
}

/**
 * The canonical form of a key: its names joined by dots, so `system.hp` and `system.==hp` have one canonical key.
 * @param {string} key - A data key or a dotted path.
 * @returns {string} The key without operator prefixes.
 */
export function canonicalKey(key) {
   return keyNames(key).join('.');
}

/**
 * Tell whether a key or path spells an operator in any segment: a `==` / `-=` prefix, or the serialized-operator
 * identifier itself as a segment. Foundry expands a dotted key into nested objects before it reconstructs operators,
 * so `flags.__$OPERATOR$__` with a sibling `flags.value` is the wrapper `flags: { __$OPERATOR$__, value }`.
 * @param {string} key - A data key or a dotted path.
 * @returns {boolean} True when a segment starts with `==` or `-=` or equals `__$OPERATOR$__`.
 */
export function hasOperatorSegment(key) {
   return String(key).split('.').some((segment) => isOperatorKey(segment) || segment === OPERATOR_IDENTIFIER);
}

/**
 * Tell whether a value is a serialized operator: an object that carries the operator identifier key. Foundry tests
 * with `in` (`SchemaField.reconstructOperator`), so this does too.
 * @param {unknown} value - The value to test.
 * @returns {boolean} True for an object that has the key `__$OPERATOR$__`.
 */
export function isOperatorWrapper(value) {
   return typeof value === 'object' && value !== null && !Array.isArray(value) && OPERATOR_IDENTIFIER in value;
}
