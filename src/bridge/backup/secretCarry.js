/**
 * Put secret values back into backed-up data before a restore replaces a live document. A backup is redacted like
 * every read, so its file never holds a secret; the backup line lists where each left-out value was, and the restore
 * copies the live value at each such path into the data, so restoring a document does not erase its secrets.
 */

/**
 * Tell whether a path can enter a value.
 * @param {unknown} value - The value to test.
 * @returns {value is object} True when the value is an object or an array that a path can enter.
 */
function isContainer(value) {
   return typeof value === 'object' && value !== null;
}

/**
 * Find the live node a path segment leads to, beside the data node it leads to. A numeric segment in an array follows
 * the live member whose `_id` equals the data member's `_id`, since embedded documents may have been reordered since
 * the backup; a data member without an `_id` follows the live member at the same index.
 * @param {unknown} liveNode - The live node the segment applies to.
 * @param {unknown} dataChild - The data node the segment leads to.
 * @param {string | number} segment - The path segment.
 * @returns {unknown} The live node, or undefined when the live data has none.
 */
function liveChildOf(liveNode, dataChild, segment) {
   if (!isContainer(liveNode)) {
      return undefined;
   }
   if (typeof segment === 'number' && Array.isArray(liveNode)) {
      /** @type {unknown} The `_id` of the data member, when it has one. */
      const id = isContainer(dataChild) ? /** @type {Record<string, unknown>} */ (dataChild)._id : undefined;
      if (typeof id === 'string') {
         return liveNode.find((member) => isContainer(member) && member._id === id);
      }
   }
   // Only an own key is followed, so a name such as `__proto__` never reaches a prototype.
   return Object.hasOwn(liveNode, segment) ? liveNode[segment] : undefined;
}

/**
 * Copy the live value at each path into the data, as a deep clone, in place.
 * @param {Record<string, unknown>} data - The backed-up data, changed in place.
 * @param {Record<string, unknown>} live - `toObject()` of the live document.
 * @param {Array<Array<string | number>>} paths - The paths of the values the backup left out.
 * @returns {number} How many paths had no live value; the data is unchanged at those.
 */
export function carrySecrets(data, live, paths) {
   /** @type {number} The paths with no live value. */
   let missing = 0;
   for (const path of paths) {
      /** @type {unknown} The data node the walk is at. */
      let dataNode = data;
      /** @type {unknown} The live node beside it. */
      let liveNode = live;
      for (const segment of path.slice(0, -1)) {
         /** @type {unknown} The next data node. */
         const dataChild = isContainer(dataNode) && Object.hasOwn(dataNode, segment) ? dataNode[segment] : undefined;
         liveNode = liveChildOf(liveNode, dataChild, segment);
         dataNode = dataChild;
      }
      /** @type {string | number | undefined} The key of the left-out value. */
      const last = path.at(-1);
      /** @type {unknown} The live value at the path. */
      const value = last === undefined ? undefined : liveChildOf(liveNode, undefined, last);
      if (value === undefined || !isContainer(dataNode)) {
         missing += 1;
         continue;
      }
      dataNode[last] = structuredClone(value);
   }
   return missing;
}
