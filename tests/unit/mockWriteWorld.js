/**
 * A mocked Foundry world for the write-script tests: document classes whose create, update and delete calls are
 * spies, embedded collections, validation that fails on marked input, and the globals the write operations read
 * (`CONST`, `CONFIG`, `fromUuid`, `game`, `foundry`). Not a test file (vitest only collects `*.test.js`). Every name
 * is a `MOCK_` value.
 */

import {
   DataFieldOperator,
   FIELD_CLASSES,
   ForcedDeletion,
   ForcedReplacement,
   buildSchema,
   cloneData,
   convertOperators,
} from './mockFoundryData.js';

/** @type {number} The counter that makes generated document ids unique. */
let idCounter = 0;

/**
 * Build a 16-character document id.
 * @returns {string} A unique id.
 */
function nextId() {
   idCounter += 1;
   return `MOCKID${String(idCounter).padStart(10, '0')}`;
}

/**
 * Build the nested failure tree Foundry keeps for a flat table of failures: `a.b` becomes a failure `a` that holds the
 * field failure `b`.
 * @param {Record<string, string>} table - The failure message by field path.
 * @returns {{ message: string, fields: Record<string, object>, elements: object[] }} The root failure.
 */
function failureTree(table) {
   /** @type {{ message: string, fields: Record<string, object>, elements: object[] }} The root failure. */
   const root = {
      message: 'SchemaField#_validateRecursive',
      fields: {},
      elements: [],
   };
   for (const [path, message] of Object.entries(table)) {
      /** @type {typeof root} The failure being extended. */
      let node = root;
      const parts = path.split('.');
      for (const [index, part] of parts.entries()) {
         node.fields[part] ??= {
            message: 'SchemaField#_validateRecursive',
            fields: {},
            elements: [],
         };
         node = node.fields[part];
         if (index === parts.length - 1) {
            node.message = message;
         }
      }
   }
   return root;
}

/**
 * Stand-in for `DataModelValidationError` as measured on Foundry 14.364: `getAllFailures()` reports no failure (its
 * aggregation drops every leaf), while the public `getFailure()` returns the root failure tree.
 */
export class MockValidationError extends Error {
   /**
    * Build the error.
    * @param {Record<string, string>} failures - The failure message by field path.
    * @param {boolean} [aggregates] - Whether `getAllFailures` reports the failures, as the documented behaviour does.
    */
   constructor(failures, aggregates = false) {
      super('validation failed');
      this.failures = failures;
      this.aggregates = aggregates;
   }

   /**
    * Report the failures the way Foundry's `getAllFailures` is documented to, or none as measured.
    * @returns {Record<string, { message: string }>} The failures by path.
    */
   getAllFailures() {
      if (!this.aggregates) {
         return {};
      }
      return Object.fromEntries(Object.entries(this.failures).map(([path, message]) => [path, { message }]));
   }

   /**
    * Return the root failure for no key, as Foundry's does.
    * @param {string} [key] - A field path; unsupported by this stand-in.
    * @returns {object | null} The root failure tree, or null for a key.
    */
   getFailure(key) {
      return key ? null : failureTree(this.failures);
   }
}

/**
 * Expand dotted keys into nested objects at every level, as Foundry's `expandObject` does before a document is
 * cleaned (`common/utils/helpers.mjs` `expandObjectInPlace`).
 * @param {unknown} value - The data.
 * @returns {unknown} The data with every dotted key expanded.
 */
export function expandKeys(value) {
   if (Array.isArray(value)) {
      return value.map((member) => expandKeys(member));
   }
   if (typeof value !== 'object' || value === null) {
      return value;
   }
   if (Object.getPrototypeOf(value) !== Object.prototype) {
      // An operator instance or another advanced object is returned as is, as Foundry's expandObject does.
      return value;
   }
   /** @type {Record<string, unknown>} The expanded copy. */
   const result = {};
   for (const [key, member] of Object.entries(value)) {
      /** @type {string[]} The path the key names. */
      const parts = key.split('.');
      /** @type {Record<string, unknown>} The object being filled. */
      let target = result;
      for (const part of parts.slice(0, -1)) {
         if (typeof target[part] !== 'object' || target[part] === null) {
            target[part] = {};
         }
         target = target[part];
      }
      target[parts.at(-1)] = expandKeys(member);
   }
   return result;
}

/**
 * The top-level keys a class keeps when it is cleaned; a class not listed here keeps every key. `Setting` has only
 * `key` and `value`, so a `namespace` is pruned as Foundry's schema cleaning prunes it
 * (`common/documents/setting.mjs`).
 * @type {Record<string, string[]>}
 */
export const SCHEMA_KEYS = {
   Setting: [
      '_id',
      'key',
      'value',
      'invalid',
      '_stats',
   ],
};

/**
 * The initial values an import gives the fields its data omits, per class, as the schema's `initial` options do. A
 * Macro's `type` starts as `chat` and its `command` as empty text (`common/documents/macro.mjs`), so a replacement
 * always holds a command.
 * @type {Record<string, Record<string, unknown>>}
 */
export const IMPORT_INITIALS = {
   Macro: {
      type: 'chat',
      command: '',
   },
};

/**
 * Clean data the way the database backend does before a creation: expand dotted keys, then prune the top-level keys
 * the class schema does not hold.
 * @param {string} documentName - The document class.
 * @param {Record<string, unknown>} data - The data to clean.
 * @returns {Record<string, unknown>} The cleaned copy.
 */
function cleanFor(documentName, data) {
   /** @type {Record<string, unknown>} The expanded copy; the test-only `invalid` table keeps its dotted keys. */
   const expanded = {
      ...convertOperators(expandKeys(cloneData(data))),
      ...(data.invalid === undefined ? {} : { invalid: structuredClone(data.invalid) }),
   };
   /** @type {string[] | undefined} The keys the class keeps. */
   const keep = SCHEMA_KEYS[documentName];
   if (keep === undefined) {
      return expanded;
   }
   return Object.fromEntries(Object.entries(expanded).filter(([key]) => keep.includes(key)));
}

/**
 * Apply expanded changes to a source object the way a Foundry update does: a plain object merges, a forced
 * replacement assigns its value as a whole and a forced deletion removes the key.
 * @param {Record<string, unknown>} target - The source object, changed in place.
 * @param {Record<string, unknown>} changes - The expanded changes.
 * @param {boolean} [recursive] - Whether a plain object merges into the stored one; false assigns it as a whole.
 * @returns {void}
 */
function applyChanges(target, changes, recursive = true) {
   for (const [key, value] of Object.entries(changes)) {
      if (value instanceof ForcedDeletion) {
         delete target[key];
      } else if (value instanceof DataFieldOperator) {
         target[key] = cloneData(DataFieldOperator.get(value));
      } else if (
         recursive &&
         typeof value === 'object' &&
         value !== null &&
         !Array.isArray(value) &&
         typeof target[key] === 'object' &&
         target[key] !== null &&
         !Array.isArray(target[key])
      ) {
         applyChanges(target[key], value, recursive);
      } else {
         target[key] = cloneData(value);
      }
   }
}

/**
 * Find the failures a change set marks: a value of `INVALID` (or an operator that wraps it) fails its key.
 * @param {Record<string, unknown>} changes - The change set Foundry would validate.
 * @returns {Record<string, string>} The failure message by key.
 */
function markedFailures(changes) {
   /** @type {Record<string, string>} The failures found. */
   const failures = {};
   for (const [key, value] of Object.entries(changes)) {
      /** @type {unknown} The value inside an operator. */
      const inner = DataFieldOperator.get(value);
      if (inner === 'INVALID') {
         failures[key] = 'is invalid';
      }
   }
   return failures;
}

/**
 * Build the mock world and install it on `globalThis`.
 * @param {(implementation?: Function) => Function} fn - The mock-function factory (`vi.fn`).
 * @param {object} [options] - What the mock world holds: document classes and fixtures.
 * @param {Record<string, string>} [options.embedded] - Embedded collections of every parent class, document name to
 * collection name.
 * @param {object[]} [options.users] - The users `{ id, role, name }` of `game.users`.
 * @param {string} [options.userId] - The signed-in user id.
 * @param {Record<string, { documentName: string, locked?: boolean }>} [options.packs] - The packs by id.
 * @returns {object} The world: `classes`, `byUuid`, `add`, `calls` and `cancel`.
 */
export function installWriteWorld(fn, options = {}) {
   /** @type {Record<string, string>} Embedded collections: document name to collection name. */
   const embedded = options.embedded ?? {
      Item: 'items',
      ActiveEffect: 'effects',
   };
   /** @type {Map<string, object>} Every live document by uuid. */
   const byUuid = new Map();
   /**
    * Hook-like cancellation: whole-call switches, and the ids or names a hook cancels one by one.
    * @type {{ cancelCreate: boolean, cancelUpdate: boolean, cancelDelete: boolean, updateIds: Set<string>,
    * deleteIds: Set<string>, createNames: Set<string> }}
    */
   const cancel = {
      cancelCreate: false,
      cancelUpdate: false,
      cancelDelete: false,
      updateIds: new Set(),
      deleteIds: new Set(),
      createNames: new Set(),
   };
   /** @type {Map<string, object>} The documents the server holds, by uuid; a client-only ghost is not among them. */
   const server = new Map();
   /** @type {string[]} The order in which write calls happened, as `<Class>.<call>`. */
   const calls = [];
   /** @type {Record<string, Function>} The document classes by name. */
   const classes = {};
   /** @type {Record<string, unknown>} Fields every import fills in when the data omits them, like schema defaults. */
   const importDefaults = {};

   /**
    * Define the mock class of one document name.
    * @param {string} documentName - The Foundry document name, for example Actor.
    * @param {Record<string, string>} children - The embedded collections of this class.
    * @returns {Function} The mock document class.
    */
   function defineClass(documentName, children) {
      /** The mock document class. */
      class MockDoc {
         static documentName = documentName;

         static metadata = {
            embedded: children,
            preserveOnImport: [
               '_id',
               'sort',
               'ownership',
               'folder',
            ],
         };

         static #schema;

         static get schema() {
            MockDoc.#schema ??= buildSchema(documentName, classes, children);
            return MockDoc.#schema;
         }

         static cleanData = fn((data) => cleanFor(documentName, data));

         static _clearFieldsRecursively(data, fields) {
            for (const field of fields) {
               delete data[field];
            }
            for (const value of Object.values(data)) {
               if (Array.isArray(value)) {
                  for (const member of value) {
                     if (typeof member === 'object' && member !== null) {
                        MockDoc._clearFieldsRecursively(member, fields);
                     }
                  }
               }
            }
         }

         static fromImport = fn(
            async (source, context) =>
               new MockDoc(
                  cleanFor(documentName, {
                     ...importDefaults,
                     ...IMPORT_INITIALS[documentName],
                     ...source,
                  }),
                  context,
               ),
         );

         static fromSource = fn((data, context) => new MockDoc(data, {
            ...context,
            restoring: true,
         }));

         static database = {
            get: fn(async (documentClass, operation) => {
               calls.push(`${documentName}.get`);
               // The server matches `_id` by equality only; an operator finds nothing (MEASURED on Foundry 14.364).
               /** @type {string[]} The ids asked for. */
               const ids = typeof operation.query?._id === 'string' ? [operation.query._id] : [];
               /** @type {object[]} The documents the server holds in that scope. */
               const held = operation.parent
                  ? [...operation.parent.getEmbeddedCollection(documentName).values()].filter((child) =>
                     server.has(child.uuid),
                  )
                  : [...server.values()].filter(
                     (document) => document.documentName === documentName && !document.parent,
                  );
               return held.filter((document) => ids.includes(document.id)).map((document) => new MockDoc(
                  document.toObject(),
                  {
                     parent: operation.parent,
                     restoring: true,
                  },
               ));
            }),
         };

         static createDocuments = fn(async (data, operation = {}) => {
            calls.push(`${documentName}.createDocuments`);
            if (cancel.cancelCreate) {
               return [];
            }
            data = data.filter((item) => !cancel.createNames.has(item.name));
            if (operation.parent) {
               return data.map((item) => operation.parent.attach(documentName, item, operation));
            }
            return data.map((item) => {
               /** @type {Record<string, unknown>} The data as the backend cleans it. */
               const cleaned = cleanFor(documentName, item);
               return new MockDoc({
                  ...cleaned,
                  _id: operation.keepId ? item._id : nextId()
               }, operation);
            });
         });

         static deleteDocuments = fn(async (ids, operation = {}) => {
            calls.push(`${documentName}.deleteDocuments`);
            if (cancel.cancelDelete) {
               return [];
            }
            return ids.map((id) => byUuid.get(`${documentName}.${id}`)).filter((document) => document !== undefined);
         });

         /**
          * Build a document; fails like Foundry's strict constructor on data that marks failures.
          * @param {Record<string, unknown>} data - The source data.
          * @param {object} [context] - The parent and pack.
          */
         constructor(data, context = {}) {
            if (data.invalid !== undefined) {
               throw new MockValidationError(data.invalid);
            }
            this.documentName = documentName;
            this.id = data._id ?? nextId();
            this.parent = context.parent ?? null;
            this._pack = context.pack ?? null;
            this.name = data.name;
            this.type = data.type;
            this.key = data.key;
            this.role = data.role;
            this.flags = structuredClone(data.flags ?? {});
            this._stats = data._stats;
            this._source = structuredClone({
               ...data,
               _id: this.id
            });
            for (const collection of Object.values(children)) {
               this[collection] = new Map();
            }
            this.update = fn(async (changes, options = {}) => {
               calls.push(`${documentName}.update`);
               if (cancel.cancelUpdate) {
                  return undefined;
               }
               // A merge by default; `recursive: false` replaces every top-level field it names as a whole.
               applyChanges(this._source, expandKeys(changes), options.recursive !== false);
               return this;
            });
            this.delete = fn(async () => {
               calls.push(`${documentName}.delete`);
               return cancel.cancelDelete ? undefined : this;
            });
            this.canUserModify = fn((user) => {
               if (user.role >= 4) {
                  return true;
               }
               /** @type {Record<string, number>} The ownership that applies to the document. */
               const ownership = this._source.ownership ?? this.parent?._source.ownership ?? {};
               return (ownership[user.id] ?? ownership.default ?? 0) >= 3;
            });
            this.validate = fn(({ changes } = {}) => {
               /** @type {Record<string, string>} The marked failures. */
               const failures = markedFailures(changes ?? {});
               if (Object.keys(failures).length > 0) {
                  throw new MockValidationError(failures);
               }
               return true;
            });
            this.getEmbeddedCollection = (name) => {
               if (children[name] === undefined) {
                  throw new Error(`${name} is not embedded`);
               }
               return this[children[name]];
            };
            this.createEmbeddedDocuments = fn(async (name, data, operation = {}) => {
               calls.push(`${documentName}.createEmbeddedDocuments`);
               if (cancel.cancelCreate) {
                  return [];
               }
               return data.map((item) => this.attach(name, item, operation));
            });
            this.updateEmbeddedDocuments = fn(async (name, updates) => {
               calls.push(`${documentName}.updateEmbeddedDocuments`);
               if (cancel.cancelUpdate) {
                  return [];
               }
               return updates.map((update) => this[children[name]].get(update._id));
            });
            this.deleteEmbeddedDocuments = fn(async (name, ids) => {
               calls.push(`${documentName}.deleteEmbeddedDocuments`);
               if (cancel.cancelDelete) {
                  return [];
               }
               return ids.map((id) => this[children[name]].get(id));
            });
            this.reset = () => undefined;
            this.traverseEmbeddedDocuments = function* traverse() {
               for (const collection of Object.values(children)) {
                  for (const child of this[collection].values()) {
                     yield [collection, child];
                     yield* child.traverseEmbeddedDocuments();
                  }
               }
            };
            if (context.creation !== true && context.restoring !== true) {
               byUuid.set(this.uuid, this);
               if (context.ghost !== true) {
                  server.set(this.uuid, this);
               }
            }
         }

         /**
          * Add an embedded child document.
          * @param {string} name - The embedded document name.
          * @param {Record<string, unknown>} item - The child data.
          * @param {{ keepId?: boolean }} [operation] - The operation flags.
          * @param {boolean} [ghost] - Whether the child exists only in the client, as a dry-run echo makes it.
          * @returns {object} The child.
          */
         attach(name, item, operation = {}, ghost = false) {
            /** @type {object} The child document. */
            const child = new classes[name](
               {
                  ...cleanFor(name, item),
                  _id: operation.keepId ? item._id : nextId(),
               },
               {
                  parent: this,
                  ghost,
               },
            );
            this[children[name]].set(child.id, child);
            return child;
         }

         get pack() {
            return this._pack ?? this.parent?.pack ?? null;
         }

         get uuid() {
            return this.parent === null || this.parent === undefined
               ? `${documentName}.${this.id}`
               : `${this.parent.uuid}.${documentName}.${this.id}`;
         }

         toObject() {
            /** @type {Record<string, unknown>} The source with the embedded collections as arrays. */
            const source = structuredClone(this._source);
            for (const collection of Object.values(children)) {
               if (this[collection].size > 0) {
                  source[collection] = [...this[collection].values()].map((child) => child.toObject());
               }
            }
            return source;
         }

         toCompendium() {
            return structuredClone(this._source);
         }
      }
      return MockDoc;
   }

   const names = [
      'Actor',
      'Item',
      'ActiveEffect',
      'Scene',
      'Setting',
      'User',
      'JournalEntry',
      'Token',
      'ActorDelta',
      'Macro',
      'Adventure',
      'Region',
      'RegionBehavior',
   ];
   /** @type {Record<string, Record<string, string>>} The embedded collections of every class but the Actor. */
   const childrenOf = {
      Item: { ActiveEffect: 'effects' },
      Scene: {
         Token: 'tokens',
         Region: 'regions',
      },
      Region: { RegionBehavior: 'behaviors' },
      ActorDelta: {
         Item: 'items',
         ActiveEffect: 'effects',
      },
   };
   for (const documentName of names) {
      classes[documentName] = defineClass(
         documentName,
         documentName === 'Actor' ? embedded : (childrenOf[documentName] ?? {}),
      );
   }
   classes.Actor.metadata.embedded = embedded;
   globalThis.CONST = {
      BASE_DOCUMENT_TYPE: 'base',
      ALL_DOCUMENT_TYPES: [...names],
      WORLD_DOCUMENT_TYPES: [
         'Actor',
         'Item',
         'Scene',
         'Setting',
         'User',
         'JournalEntry',
         'Macro',
      ],
      EMBEDDED_DOCUMENT_TYPES: [
         'ActiveEffect',
         'Token',
         'ActorDelta',
         'Region',
         'RegionBehavior',
      ],
      PRIMARY_DOCUMENT_TYPES: [
         'Actor',
         'Item',
         'ActiveEffect',
         'Setting',
         'User',
         'JournalEntry',
         'Scene',
         'Macro',
         'Adventure',
      ],
      USER_ROLES: {
         NONE: 0,
         PLAYER: 1,
         TRUSTED: 2,
         ASSISTANT: 3,
         GAMEMASTER: 4,
      },
   };
   globalThis.CONFIG = Object.fromEntries(names.map((name) => [name, { documentClass: classes[name] }]));
   globalThis.foundry = {
      ...globalThis.foundry,
      data: {
         validation: { DataModelValidationError: MockValidationError },
         operators: {
            DataFieldOperator,
            ForcedReplacement,
            ForcedDeletion,
         },
         fields: FIELD_CLASSES,
      },
      utils: {
         ...globalThis.foundry?.utils,
         deepClone: (value) => cloneData(value),
         expandObject: (value) => expandKeys(value),
         isEmpty: (value) => Object.keys(value).length === 0,
         diffObject: (original, other) =>
            Object.fromEntries(
               Object.entries(other).filter(([key, value]) => JSON.stringify(original[key]) !== JSON.stringify(value)),
            ),
         randomID: () => nextId().slice(-16).padStart(16, 'M'),
      },
   };
   globalThis.fromUuid = fn(async (uuid) => byUuid.get(uuid) ?? null);

   /**
    * The knobs and the log of `modifyBatch`. `failure` makes the server fail the operation at `index` of the batch:
    * phase 2 applies the operations before it and stops (the sequential write), phase 1 applies nothing and answers
    * every other operation with the dry-run echo the client handles as if it were real (Foundry 14.364).
    * @type {{ failAt: number, rejectAll: boolean, ops: object[][], failure: { index: number, phase: 1 | 2 } | null }}
    */
   const batch = {
      failAt: Number.POSITIVE_INFINITY,
      rejectAll: false,
      ops: [],
      failure: null,
   };

   /**
    * Tell whether an update changes nothing: every plain value equals the stored one.
    * @param {object} document - The live document.
    * @param {Record<string, unknown>} update - The update entry, with its `_id`.
    * @returns {boolean} True when Foundry would drop the entry as a no-op.
    */
   function isNoop(document, update) {
      return Object.entries(expandKeys(update))
         .filter(([key]) => key !== '_id')
         .every(([key, value]) => JSON.stringify(document._source[key]) === JSON.stringify(value));
   }

   /**
    * Find a live document an operation addresses.
    * @param {object} operation - The operation that names the parent.
    * @param {string} id - The document id.
    * @returns {object | undefined} The document.
    */
   function findTarget(operation, id) {
      return operation.parent
         ? operation.parent.getEmbeddedCollection(operation.documentName).get(id)
         : byUuid.get(`${operation.documentName}.${id}`);
   }

   /**
    * Do what the client does to an operation before it sends it: drop the entries a hook cancelled and the updates
    * that change nothing, in place, and mark an operation with no entry left as not sent (`dryRun` stays true).
    * @param {object} operation - The operation, changed in place.
    * @returns {boolean} Whether anything is left to send.
    */
   function preprocess(operation) {
      if (operation.action === 'create') {
         operation.data = operation.data.filter((item) => !cancel.cancelCreate && !cancel.createNames.has(item.name));
      } else if (operation.action === 'update') {
         operation.updates = operation.updates.filter((update) => {
            const document = findTarget(operation, update._id);
            return (
               document !== undefined &&
               !cancel.cancelUpdate &&
               !cancel.updateIds.has(update._id) &&
               !isNoop(document, update)
            );
         });
      } else {
         operation.ids = operation.ids.filter((id) => !cancel.cancelDelete && !cancel.deleteIds.has(id));
      }
      const left = (operation.data ?? operation.updates ?? operation.ids).length;
      if (left === 0) {
         operation.dryRun = true;
      }
      return left > 0;
   }

   /**
    * Apply (or echo) one sent operation and return the documents it reports.
    * @param {object} operation - The operation to perform.
    * @param {boolean} real - True when the server writes it; false for the dry-run echo of a failed validation pass.
    * @returns {object[]} The documents of the result.
    */
   function perform(operation, real) {
      if (operation.action === 'create') {
         return operation.data.map((item) => {
            const data = {
               ...cleanFor(operation.documentName, item),
               _id: operation.keepId && item._id ? item._id : nextId(),
            };
            return operation.parent
               ? operation.parent.attach(operation.documentName, item, operation, !real)
               : new classes[operation.documentName](data, {
                  pack: operation.pack,
                  ghost: !real,
               });
         });
      }
      if (operation.action === 'update') {
         return operation.updates.map((update) => {
            const document = findTarget(operation, update._id);
            if (real) {
               applyChanges(document._source, expandKeys(update));
               document._source._id = document.id;
               document.name = document._source.name;
            }
            return document;
         });
      }
      return operation.ids.map((id) => {
         const document = findTarget(operation, id);
         if (operation.parent) {
            operation.parent.getEmbeddedCollection(operation.documentName).delete(id);
         } else {
            byUuid.delete(document.uuid);
         }
         if (real) {
            server.delete(document.uuid);
         }
         return document;
      });
   }

   globalThis.foundry.documents = {
      modifyBatch: fn(async (operations) => {
         calls.push('modifyBatch');
         batch.ops.push(
            operations.map((operation) => ({
               action: operation.action,
               documentName: operation.documentName,
               count: (operation.data ?? operation.updates ?? operation.ids).length,
               parent: operation.parent?.uuid ?? null,
               pack: operation.pack ?? null,
            })),
         );
         /** @type {boolean[]} Whether each operation still has an entry to send. */
         const sent = operations.map((operation) => preprocess(operation));
         if (batch.rejectAll) {
            return [];
         }
         /** @type {{ index: number, phase: 1 | 2 } | null} Where and how the server fails. */
         const failure = batch.failure ?? (Number.isFinite(batch.failAt) ? { index: batch.failAt, phase: 2 } : null);
         /** @type {object[][]} The documents of each operation that reports a result. */
         const results = [];
         for (const [index, operation] of operations.entries()) {
            if (!sent[index]) {
               continue;
            }
            if (failure !== null && failure.phase === 2 && index >= failure.index) {
               break;
            }
            if (failure !== null && failure.phase === 1 && index === failure.index) {
               continue;
            }
            results.push(perform(operation, failure === null || failure.phase === 2));
         }
         // Foundry deletes `operation.parent` while it builds the request of a sent operation (client-backend.mjs,
         // `#buildRequest`), so a caller cannot read it after the call.
         for (const [index, operation] of operations.entries()) {
            if (sent[index] && operation.parent) {
               operation.parentUuid = operation.parent.uuid;
               delete operation.parent;
            }
         }
         return results;
      }),
   };

   /** @type {Map<string, object>} World documents of the user class, by id (`game.users`). */
   const users = new Map();
   for (const user of options.users ?? []) {
      users.set(user.id, user);
   }
   globalThis.game = {
      version: '14.364',
      user: { id: options.userId ?? 'MOCKUSER' },
      users: Object.assign([...users.values()], {
         get: (id) => users.get(id),
      }),
      settings: { get: () => false },
      collections: {
         get: (name) =>
            CONST.WORLD_DOCUMENT_TYPES.includes(name)
               ? {
                  get size() {
                     return this.values().length;
                  },
                  values: () =>
                     [...byUuid.values()].filter((document) => document.documentName === name && !document.parent),
                  set: (id, document) => byUuid.set(`${name}.${id}`, document),
                  delete: (id) => byUuid.delete(`${name}.${id}`),
                  get: (id) => byUuid.get(`${name}.${id}`),
               }
               : undefined,
      },
      packs: {
         get: (id) => options.packs?.[id],
      },
   };

   return {
      classes,
      byUuid,
      cancel,
      calls,
      batch,
      server,
      importDefaults,
      /**
       * Create a live world document directly, without a write call.
       * @param {string} documentName - The class name.
       * @param {Record<string, unknown>} data - The source data.
       * @param {object} [context] - The parent and pack.
       * @returns {object} The document.
       */
      add(documentName, data, context = {}) {
         return new classes[documentName](data, context);
      },
      /**
       * Add an embedded child to a live parent.
       * @param {object} parent - The parent document.
       * @param {string} name - The embedded document name.
       * @param {Record<string, unknown>} data - The source data of the embedded document.
       * @returns {object} The embedded mock document.
       */
      addChild(parent, name, data) {
         return parent.attach(name, data, { keepId: data._id !== undefined });
      },
   };
}
