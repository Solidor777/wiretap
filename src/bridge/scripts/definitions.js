/**
 * The definitions of the shipped scripts. They import only through relative paths so a script run by `tsx` (the
 * manual context measurement, through the test fixtures) can load them without the build aliases.
 */

import { getBudget } from '../../../shared/budgets.js';
import { SCHEMA_BOUND_MAX } from '../../../shared/schemaValidate.js';

/**
 * Most patch entries one `update_documents` call carries: up to 50 documents with 4 patches each on average. The
 * write operation separately bounds the documents (50) and the patches of one document (20).
 * @type {number}
 */
const UPDATE_ENTRIES_MAX = 200;

/**
 * The script definition.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const listDocumentTypesDefinition = {
   name: 'list_document_types',
   version: '1.0.0',
   description: 'List the document classes of this Foundry world and the subtypes of each (Actor and Item types).',
   inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('DOCUMENT_TYPES_MAX_BYTES').value },
   requires: 'api',
   mutates: false,
};

/**
 * The script definition. The argument descriptions are left to the user-facing skill: the definition is paid for on
 * every load and is held to `DEFINITION_MAX_BYTES`.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const getDocumentDefinition = {
   name: 'get_document',
   version: '1.0.0',
   description: 'Read a Foundry document by uuid, or documentName and id. Compact by default; fields, paths or full.',
   inputSchema: {
      type: 'object',
      properties: {
         uuid: { type: 'string' },
         documentName: { type: 'string' },
         id: { type: 'string' },
         parentUuid: { type: 'string' },
         pack: { type: 'string' },
         mode: {
            type: 'string',
            enum: [
               'compact',
               'full',
            ],
         },
         fields: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string' },
         },
         paths: {
            type: 'array',
            maxItems: 20,
            items: { type: 'string' },
         },
         derived: { type: 'boolean' },
         ifChanged: {
            type: 'string',
            maxLength: 32,
         },
         maxBytes: {
            type: 'integer',
            minimum: 128,
            maximum: 16000,
         },
      },
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('RESULT_HARD_CAP_MAX_BYTES').value },
   requires: 'api',
   mutates: false,
};

/**
 * The `search_documents` definition.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const searchDocumentsDefinition = {
   name: 'search_documents',
   version: '1.0.0',
   description:
      'Search Foundry documents of one class by name, type or field values. Pages of [uuid, name, type] rows.',
   inputSchema: {
      type: 'object',
      properties: {
         documentName: { type: 'string' },
         type: { type: 'string' },
         query: {
            type: 'string',
            maxLength: 64,
         },
         filters: {
            type: 'array',
            maxItems: 5,
            items: {
               type: 'string',
               maxLength: 256,
            },
         },
         pack: { type: 'string' },
         parentUuid: { type: 'string' },
         fields: {
            type: 'array',
            maxItems: 20,
            items: {
               type: 'string',
               maxLength: getBudget('SEARCH_FIELD_PATH_MAX_BYTES').value,
            },
         },
         limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
         },
         cursor: {
            type: 'string',
            maxLength: 512,
         },
      },
      required: ['documentName'],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('SEARCH_PAGE_MAX_BYTES').value },
   requires: 'api',
   mutates: false,
};

/**
 * The `describe_schema` definition.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const describeSchemaDefinition = {
   name: 'describe_schema',
   version: '1.0.0',
   description:
      'Describe a Foundry document class and subtype: a blank example and schema outline, or a path with ' +
      'constraints.',
   inputSchema: {
      type: 'object',
      properties: {
         documentName: { type: 'string' },
         subtype: { type: 'string' },
         path: {
            type: 'string',
            maxLength: 512,
         },
      },
      required: ['documentName'],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('DESCRIBE_SCHEMA_MAX_BYTES').value },
   requires: 'api',
   mutates: false,
};

/**
 * The `create_documents` definition. `data` carries one JSON object text per document because the argument-schema
 * subset has no free-form object. Gates are judged per category inside the write operation, so the script declares
 * none.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const createDocumentsDefinition = {
   name: 'create_documents',
   version: '1.0.0',
   description:
      'Create Foundry documents. data: one JSON object text each. parentUuid or pack for embedded or pack. ' +
      'idempotencyKey: a repeat returns the first call.',
   inputSchema: {
      type: 'object',
      properties: {
         documentName: { type: 'string' },
         data: {
            type: 'array',
            maxItems: getBudget('WRITE_DOCUMENTS_MAX').value,
            items: {
               type: 'string',
               maxLength: SCHEMA_BOUND_MAX,
            },
         },
         parentUuid: { type: 'string' },
         pack: { type: 'string' },
         keepId: { type: 'boolean' },
         dryRun: { type: 'boolean' },
         idempotencyKey: {
            type: 'string',
            maxLength: 64,
         },
         actAs: { type: 'string' },
         paths: {
            type: 'array',
            maxItems: getBudget('PATHS_PER_CALL_MAX').value,
            items: {
               type: 'string',
               maxLength: getBudget('PATH_BYTES_MAX').value,
            },
         },
      },
      required: [
         'documentName',
         'data',
      ],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('ACK_BATCH_MAX_BYTES').value },
   requires: 'api',
   mutates: true,
   handleArgs: ['data'],
};

/**
 * The `update_documents` definition. Each `updates` entry is one patch; entries with the same uuid form one update.
 * `value` is JSON text because the argument-schema subset has no free-form value.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const updateDocumentsDefinition = {
   name: 'update_documents',
   version: '1.0.0',
   description:
      'Update Foundry documents by path. One patch per entry: uuid, path, value as JSON text, op set|replace|delete. ' +
      'Embedded: items.<id>.x. dryRun only validates.',
   inputSchema: {
      type: 'object',
      properties: {
         updates: {
            type: 'array',
            maxItems: UPDATE_ENTRIES_MAX,
            items: {
               type: 'object',
               properties: {
                  uuid: { type: 'string' },
                  path: {
                     type: 'string',
                     maxLength: getBudget('PATH_BYTES_MAX').value,
                  },
                  value: {
                     type: 'string',
                     maxLength: SCHEMA_BOUND_MAX,
                  },
                  op: {
                     type: 'string',
                     enum: [
                        'set',
                        'replace',
                        'delete',
                     ],
                  },
               },
               required: [
                  'uuid',
                  'path',
               ],
               additionalProperties: false,
            },
         },
         dryRun: { type: 'boolean' },
         actAs: { type: 'string' },
         paths: {
            type: 'array',
            maxItems: getBudget('PATHS_PER_CALL_MAX').value,
            items: {
               type: 'string',
               maxLength: getBudget('PATH_BYTES_MAX').value,
            },
         },
      },
      required: ['updates'],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('ACK_BATCH_MAX_BYTES').value },
   requires: 'api',
   mutates: true,
};

/**
 * The `delete_documents` definition.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const deleteDocumentsDefinition = {
   name: 'delete_documents',
   version: '1.0.0',
   description:
      'Delete Foundry documents by uuid. Irreversible; embedded documents go with their parent. dryRun lists what ' +
      'would be deleted.',
   inputSchema: {
      type: 'object',
      properties: {
         uuids: {
            type: 'array',
            maxItems: getBudget('WRITE_DOCUMENTS_MAX').value,
            items: { type: 'string' },
         },
         dryRun: { type: 'boolean' },
         actAs: { type: 'string' },
      },
      required: ['uuids'],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('RESULT_HARD_CAP_DEFAULT_BYTES').value },
   requires: 'api',
   mutates: true,
};

/**
 * The `replace_document` definition. `data` is JSON text because the argument-schema subset has no free-form object.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const replaceDocumentDefinition = {
   name: 'replace_document',
   version: '1.0.0',
   description:
      'Replace a document with data (JSON text) like a JSON import: top-level fields replace, hooks fire, _id, sort, ' +
      'ownership and folder stay. dryRun only validates.',
   inputSchema: {
      type: 'object',
      properties: {
         uuid: { type: 'string' },
         data: {
            type: 'string',
            maxLength: SCHEMA_BOUND_MAX,
         },
         dryRun: { type: 'boolean' },
         actAs: { type: 'string' },
         paths: {
            type: 'array',
            maxItems: getBudget('PATHS_PER_CALL_MAX').value,
            items: {
               type: 'string',
               maxLength: getBudget('PATH_BYTES_MAX').value,
            },
         },
      },
      required: [
         'uuid',
         'data',
      ],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('ACK_MAX_BYTES').value },
   requires: 'api',
   mutates: true,
   handleArgs: ['data'],
};

/**
 * The `batch` definition: creates, updates and deletes in one Foundry batch. The updates are flat patches like
 * `update_documents`, so the schema stays within the argument-schema depth.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const batchDefinition = {
   name: 'batch',
   version: '1.0.0',
   description:
      'Batch create, update, delete in that order. NOT atomic: Foundry validates all, stops at the first failure; ' +
      'earlier ones stay applied.',
   inputSchema: {
      type: 'object',
      properties: {
         creates: {
            type: 'array',
            maxItems: getBudget('WRITE_DOCUMENTS_MAX').value,
            items: {
               type: 'object',
               properties: {
                  documentName: { type: 'string' },
                  data: { type: 'string' },
                  parentUuid: { type: 'string' },
               },
            },
         },
         updates: {
            type: 'array',
            maxItems: UPDATE_ENTRIES_MAX,
            items: {
               type: 'object',
               properties: {
                  uuid: { type: 'string' },
                  path: { type: 'string' },
                  value: { type: 'string' },
                  op: { type: 'string' },
               },
               required: [
                  'uuid',
                  'path',
               ],
            },
         },
         deletes: {
            type: 'array',
            maxItems: getBudget('WRITE_DOCUMENTS_MAX').value,
            items: { type: 'string' },
         },
         dryRun: { type: 'boolean' },
         actAs: { type: 'string' },
      },
      additionalProperties: false,
   },
   strictNested: true,
   result: { budgetBytes: getBudget('ACK_BATCH_MAX_BYTES').value },
   requires: 'api',
   mutates: true,
};
