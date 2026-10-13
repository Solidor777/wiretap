/**
 * The definitions of the shipped read scripts. They import only through relative paths so a script run by `tsx` (the
 * manual context measurement, through the test fixtures) can load them without the build aliases.
 */

import { getBudget } from '../../../shared/budgets.js';

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
         ifModifiedSince: { type: 'number' },
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
