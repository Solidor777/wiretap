/**
 * The per-subtype key-field lists of the compact view. A list names the `system` leaves, as dotted paths below
 * `system`, that identify a document of that subtype at a glance. The data file `keyFields.json` holds the reviewed
 * lists, keyed by system id and then by `<documentName>.<type>`. A system or subtype without a list is shown by the
 * default key-name pattern.
 */

import KEY_FIELDS from '~/bridge/scripts/keyFields.json';

/**
 * Look up the key-field list of a document subtype.
 * @param {unknown} systemId - The id of the game system (`game.system.id`).
 * @param {unknown} documentName - The document class name, for example `Actor`.
 * @param {unknown} type - The document subtype.
 * @returns {readonly string[] | undefined} The dotted paths below `system`, or undefined when no list exists.
 */
export function keyPathsFor(systemId, documentName, type) {
   if (typeof systemId !== 'string' || typeof documentName !== 'string' || typeof type !== 'string') {
      return undefined;
   }
   /** @type {Record<string, readonly string[]> | undefined} The lists of this system. */
   const lists = Object.hasOwn(KEY_FIELDS, systemId) ? KEY_FIELDS[systemId] : undefined;
   /** @type {string} The list key of the subtype. */
   const key = `${documentName}.${type}`;
   return lists !== undefined && Object.hasOwn(lists, key) ? lists[key] : undefined;
}
