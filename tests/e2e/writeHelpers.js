/**
 * Helpers shared by the e2e specs that create documents through the `create_documents` tool.
 */

/**
 * The first concrete subtype of a document class in the live world, or `base` when the class has none.
 * @param {import('@playwright/test').Page} page - The Foundry page.
 * @param {string} documentName - The document class, for example `Actor`.
 * @returns {Promise<string>} The subtype name.
 */
export async function firstSubtype(page, documentName) {
   return page.evaluate(
      (name) => (game.documentTypes[name] ?? []).find((type) => type !== CONST.BASE_DOCUMENT_TYPE) ?? 'base',
      documentName,
   );
}

/**
 * Build the arguments of a `create_documents` call: each data object travels as JSON text.
 * @param {string} documentName - The document class.
 * @param {object[]} data - The data objects.
 * @param {object} [extra] - More arguments such as `parentUuid`, `pack`, `keepId`, `dryRun` or `paths`.
 * @returns {object} The tool arguments.
 */
export function createArguments(documentName, data, extra = {}) {
   return {
      documentName,
      data: data.map((entry) => JSON.stringify(entry)),
      ...extra,
   };
}

/**
 * Build one `update_documents` patch entry: the value travels as JSON text.
 * @param {string} uuid - The document to update.
 * @param {string} path - The dotted field path to write.
 * @param {unknown} [value] - The new value; omitted for `op: 'delete'`.
 * @param {'set' | 'replace' | 'delete'} [op] - The write operation.
 * @returns {{ uuid: string, path: string, value?: string, op?: string }} The entry.
 */
export function patch(uuid, path, value, op) {
   return {
      uuid,
      path,
      ...(value === undefined ? {} : { value: JSON.stringify(value) }),
      ...(op === undefined ? {} : { op }),
   };
}

/**
 * The id at the end of a uuid.
 * @param {string} uuid - A document uuid.
 * @returns {string} The 16-character document id.
 */
export function idOf(uuid) {
   return uuid.split('.').pop();
}
