/**
 * Builders for mocked Foundry documents and a mocked world, shared by the read-tool tests. Not a test file (vitest
 * only collects `*.test.js`). Every name is a `MOCK_` value.
 */

/**
 * @typedef {object} MockDocumentOptions
 * @property {string} documentName - The document class name, for example `Actor`.
 * @property {string} id - The 16-character document id.
 * @property {string} [name] - The document name.
 * @property {string} [type] - The subtype.
 * @property {Record<string, unknown>} [source] - Extra fields of the stored (source) data.
 * @property {Record<string, unknown>} [prepared] - Fields replacing the source data in the prepared (derived) data.
 * @property {number | null} [modifiedTime] - The `_stats.modifiedTime` value.
 * @property {string} [uuid] - The uuid; defaults to `<documentName>.<id>`.
 */

/**
 * @typedef {object} MockDocument
 * @property {string} documentName - The class name.
 * @property {string} id - The 16-character document id.
 * @property {string} uuid - The document uuid.
 * @property {string} name - The document name, a `MOCK_` value.
 * @property {string | undefined} type - The subtype.
 * @property {{ modifiedTime: number | null }} _stats - The stats.
 * @property {import('vitest').Mock} toCompendium - Returns a clone of the source data; records its arguments.
 * @property {import('vitest').Mock} toObject - Returns a clone of the source (`true`) or prepared (`false`) data.
 */

/**
 * Build a mocked document. `toCompendium` honours `keepId` the way Foundry's does, so a test that forgets the option
 * sees the missing `_id`.
 * @param {MockDocumentOptions} options - The document fields.
 * @param {(implementation: Function) => Function} fn - The mock-function factory (`vi.fn`).
 * @returns {MockDocument} The mocked document.
 */
export function mockDocument(options, fn) {
   /** @type {string} The document uuid, built from the class name and id unless given. */
   const uuid = options.uuid ?? `${options.documentName}.${options.id}`;
   /** @type {Record<string, unknown>} The stored data. */
   const source = {
      _id: options.id,
      name: options.name ?? `MOCK_${options.documentName}`,
      ...(options.type === undefined ? {} : { type: options.type }),
      ...options.source,
      _stats: { modifiedTime: options.modifiedTime ?? null },
   };
   /** @type {Record<string, unknown>} The prepared data. */
   const prepared = {
      ...source,
      ...options.prepared,
   };
   return {
      documentName: options.documentName,
      id: options.id,
      uuid,
      name: source.name,
      type: options.type,
      _stats: source._stats,
      toCompendium: fn((pack, compendiumOptions = {}) => {
         /** @type {Record<string, unknown>} The clone handed out. */
         const data = structuredClone(source);
         if (compendiumOptions.keepId !== true) {
            delete data._id;
         }
         return data;
      }),
      toObject: fn((fromSource = true) => structuredClone(fromSource ? source : prepared)),
   };
}

/**
 * Install a mocked world on `globalThis`: `game`, `CONST`, `fromUuid` and the document classes' collections.
 * @param {object} options - The documents, subtypes, embedded children and packs of the world.
 * @param {MockDocument[]} [options.documents] - The world documents, found by `documentName` and `id`.
 * @param {Record<string, string[]>} [options.documentTypes] - `game.documentTypes`.
 * @param {Record<string, MockDocument[]>} [options.embedded] - Embedded documents by parent uuid then by name.
 * @param {Record<string, MockDocument[]>} [options.packs] - Pack documents by pack id.
 * @param {(implementation: Function) => Function} fn - The mock-function factory (`vi.fn`).
 * @returns {void}
 */
export function installWorld({ documents = [], documentTypes = {}, embedded = {}, packs = {} }, fn) {
   /** @type {Map<string, MockDocument>} Every document by uuid. */
   const byUuid = new Map();
   for (const document of documents) {
      byUuid.set(document.uuid, document);
   }
   globalThis.CONST = {
      BASE_DOCUMENT_TYPE: 'base',
      ALL_DOCUMENT_TYPES: [
         'ActiveEffect',
         'Actor',
         'Item',
         'Scene',
         'Setting',
         'User',
      ],
      WORLD_DOCUMENT_TYPES: [
         'Actor',
         'Item',
         'Scene',
         'Setting',
         'User',
      ],
      EMBEDDED_DOCUMENT_TYPES: ['ActiveEffect'],
   };
   globalThis.fromUuid = fn(async (uuid) => byUuid.get(uuid) ?? null);
   globalThis.game = {
      documentTypes,
      system: { id: 'mock-system' },
      settings: { get: () => false },
      collections: {
         get: (documentName) => {
            if (!CONST.WORLD_DOCUMENT_TYPES.includes(documentName)) {
               return undefined;
            }
            /** @type {MockDocument[]} The world documents of this class. */
            const list = documents.filter((document) => document.documentName === documentName);
            return {
               get: (id) => list.find((document) => document.id === id),
               size: list.length,
               [Symbol.iterator]: () => list[Symbol.iterator](),
            };
         },
      },
      packs: {
         get: (id) =>
            packs[id] === undefined
               ? undefined
               : {
                    documentName: packs[id][0]?.documentName,
                    getDocument: async (documentId) =>
                       packs[id].find((document) => document.id === documentId) ?? null,
                    collection: id,
                    getIndex: fn(async ({ fields = [] } = {}) => {
                       globalThis.lastIndexFields = fields;
                       return packs[id].map((document) => {
                          /** @type {Record<string, unknown>} The index entry: ids, names and the requested fields. */
                          const entry = {
                             _id: document.id,
                             uuid: document.uuid,
                             name: document.name,
                             type: document.type,
                          };
                          const stored = document.toObject(true);
                          for (const field of fields) {
                             let node = stored;
                             const names = field.split('.');
                             for (const name of names.slice(0, -1)) {
                                node = node?.[name];
                                if (node === undefined) {
                                   break;
                                }
                             }
                             if (node?.[names.at(-1)] !== undefined) {
                                let target = entry;
                                for (const name of names.slice(0, -1)) {
                                   target[name] ??= {};
                                   target = target[name];
                                }
                                target[names.at(-1)] = node[names.at(-1)];
                             }
                          }
                          return entry;
                       });
                    }),
                 },
      },
   };
   for (const [parentUuid, children] of Object.entries(embedded)) {
      /** @type {MockDocument | undefined} The document that holds the children. */
      const parent = byUuid.get(parentUuid);
      if (parent !== undefined) {
         parent.getEmbeddedCollection = (name) => {
            /** @type {MockDocument[]} The children of this class. */
            const list = children.filter((child) => child.documentName === name);
            if (list.length === 0 && !children.some((child) => child.documentName === name)) {
               throw new Error(`${parent.documentName} has no embedded ${name}`);
            }
            return {
               get: (id) => list.find((child) => child.id === id),
               [Symbol.iterator]: () => list[Symbol.iterator](),
            };
         };
      }
   }
}

/**
 * Remove the mocked world from `globalThis`.
 * @returns {void}
 */
export function removeWorld() {
   delete globalThis.CONST;
   delete globalThis.fromUuid;
   delete globalThis.game;
}
