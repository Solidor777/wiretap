/**
 * Short content hashes. `hashText` hashes a text; `contentVersion` hashes a JSON value with its object keys sorted, so
 * two exports that hold the same values give the same version whatever order their keys were written in. Used by the
 * `create_documents` request hash and the `get_document` version.
 */

/**
 * Hash a text to a short hex text. Algorithm: cyrb53, a non-cryptographic 53-bit string hash by bryc (public
 * domain). It tells an honest retry from a reuse of the key for other data; it is not collision resistant and not a
 * security boundary. A caller who finds two requests with one hash only makes a replay answer the other request of
 * the same key, within the collection that already holds the caller's own documents. For a document version, two
 * different exports with one hash make one read answer "unchanged" although the document changed.
 * @param {string} text - The text to hash.
 * @returns {string} The hash as 14 lowercase hex digits.
 */
export function hashText(text) {
   /** @type {number} First hash lane. */
   let h1 = 0xdeadbeef;
   /** @type {number} Second hash lane. */
   let h2 = 0x41c6ce57;
   for (let index = 0; index < text.length; index += 1) {
      /** @type {number} The code unit mixed in. */
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
   }
   h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
   h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
   return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * Whether a value is a plain object: its prototype is `Object.prototype` or null.
 * @param {unknown} value - The value to test.
 * @returns {boolean} True for a plain object.
 */
function isPlainObject(value) {
   if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return false;
   }
   /** @type {object | null} The prototype of the value. */
   const prototype = Object.getPrototypeOf(value);
   return prototype === Object.prototype || prototype === null;
}

/**
 * Serialize a value as `JSON.stringify` does, with the keys of every plain object sorted in code-unit order. Arrays
 * keep their order. The replacer rebuilds each plain object with `Object.fromEntries`, which creates own properties,
 * so an own `__proto__` key stays in the text instead of setting the prototype.
 * @param {unknown} value - A JSON-serializable value.
 * @returns {string} The JSON text with sorted keys.
 */
export function stableStringify(value) {
   return JSON.stringify(value, (key, member) => {
      if (!isPlainObject(member)) {
         return member;
      }
      // The keys of one object are distinct, so the comparator never meets two equal keys.
      return Object.fromEntries(Object.entries(member).sort(([a], [b]) => (a < b ? -1 : 1)));
   });
}

/**
 * The content version of a JSON value: the hash of its sorted-key JSON text.
 * @param {unknown} value - A JSON-serializable value, for example a canonical document export.
 * @returns {string} The version as 14 lowercase hex digits.
 */
export function contentVersion(value) {
   return hashText(stableStringify(value));
}
