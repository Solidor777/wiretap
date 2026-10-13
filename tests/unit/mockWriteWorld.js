/**
 * A mocked Foundry world for the write-script tests: document classes whose create, update and delete calls are
 * spies, embedded collections, validation that fails on marked input, and the globals the write operations read
 * (`CONST`, `CONFIG`, `fromUuid`, `game`, `foundry`). Not a test file (vitest only collects `*.test.js`). Every name
 * is a `MOCK_` value.
 */

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
 * Stand-in for `DataModelValidationError` as measured on Foundry 14.365: `getAllFailures()` reports no failure (its
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
 * Clean data the way the database backend does before a creation: expand dotted keys, then prune the top-level keys
 * the class schema does not hold.
 * @param {string} documentName - The document class.
 * @param {Record<string, unknown>} data - The data to clean.
 * @returns {Record<string, unknown>} The cleaned copy.
 */
function cleanFor(documentName, data) {
   /** @type {Record<string, unknown>} The expanded copy; the test-only `invalid` table keeps its dotted keys. */
   const expanded = {
      ...expandKeys(structuredClone(data)),
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
 * Find the failures a change set marks: a value of `INVALID` (or an operator that wraps it) fails its key.
 * @param {Record<string, unknown>} changes - The change set Foundry would validate.
 * @returns {Record<string, string>} The failure message by key.
 */
function markedFailures(changes) {
   /** @type {Record<string, string>} The failures found. */
   const failures = {};
   for (const [key, value] of Object.entries(changes)) {
      /** @type {unknown} The value inside an operator. */
      const inner = value?.operatorValue ?? value;
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
   /** @type {{ cancelCreate: boolean, cancelUpdate: boolean, cancelDelete: boolean }} Hook-like cancellation. */
   const cancel = {
      cancelCreate: false,
      cancelUpdate: false,
      cancelDelete: false,
   };
   /** @type {string[]} The order in which write calls happened, as `<Class>.<call>`. */
   const calls = [];
   /** @type {Record<string, Function>} The document classes by name. */
   const classes = {};

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

         static metadata = { embedded: children };

         static hierarchy = Object.fromEntries(
            Object.entries(children).map(([name, collection]) => [
               collection,
               { model: { documentName: name } },
            ]),
         );

         static cleanData = fn((data) => cleanFor(documentName, data));

         static createDocuments = fn(async (data, operation = {}) => {
            calls.push(`${documentName}.createDocuments`);
            if (cancel.cancelCreate) {
               return [];
            }
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
            this._source = structuredClone({
               ...data,
               _id: this.id
            });
            this.items = new Map();
            this.effects = new Map();
            this.update = fn(async (changes) => {
               calls.push(`${documentName}.update`);
               return cancel.cancelUpdate ? undefined : this;
            });
            this.delete = fn(async () => {
               calls.push(`${documentName}.delete`);
               return cancel.cancelDelete ? undefined : this;
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
            this.traverseEmbeddedDocuments = function* traverse() {
               for (const collection of Object.values(children)) {
                  for (const child of this[collection].values()) {
                     yield [collection, child];
                     yield* child.traverseEmbeddedDocuments();
                  }
               }
            };
            byUuid.set(this.uuid, this);
         }

         /**
          * Add an embedded child document.
          * @param {string} name - The embedded document name.
          * @param {Record<string, unknown>} item - The child data.
          * @param {{ keepId?: boolean }} [operation] - The operation flags.
          * @returns {object} The child.
          */
         attach(name, item, operation = {}) {
            /** @type {object} The child document. */
            const child = new classes[name](
               {
                  ...cleanFor(name, item),
                  _id: operation.keepId ? item._id : nextId(),
               },
               { parent: this },
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
            return structuredClone(this._source);
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
   ];
   for (const documentName of names) {
      classes[documentName] = defineClass(
         documentName,
         documentName === 'Actor' ? embedded : documentName === 'Item' ? { ActiveEffect: 'effects' } : {},
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
      ],
      EMBEDDED_DOCUMENT_TYPES: ['ActiveEffect'],
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
         operators: {
            ForcedReplacement: {
               create: (value) => ({
                  operator: 'replace',
                  operatorValue: value
               }),
            },
            ForcedDeletion: class ForcedDeletion {
               constructor() {
                  this.operator = 'delete';
               }
            },
         },
      },
      utils: {
         ...globalThis.foundry?.utils,
         deepClone: (value) => structuredClone(value),
      },
   };
   globalThis.fromUuid = fn(async (uuid) => byUuid.get(uuid) ?? null);

   /** @type {Map<string, object>} World documents of the user class, by id (`game.users`). */
   const users = new Map();
   for (const user of options.users ?? []) {
      users.set(user.id, user);
   }
   globalThis.game = {
      user: { id: options.userId ?? 'MOCKUSER' },
      users: Object.assign([...users.values()], {
         get: (id) => users.get(id),
      }),
      settings: { get: () => false },
      collections: { get: () => undefined },
      packs: {
         get: (id) => options.packs?.[id],
      },
   };

   return {
      classes,
      byUuid,
      cancel,
      calls,
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
         return parent.attach(name, data);
      },
   };
}
