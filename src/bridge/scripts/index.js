import { createDocumentsHandler } from '~/bridge/scripts/createDocuments.js';
import { batchHandler } from '~/bridge/scripts/batch.js';
import {
   batchDefinition,
   createDocumentsDefinition,
   deleteDocumentsDefinition,
   describeSchemaDefinition,
   getDocumentDefinition,
   listDocumentTypesDefinition,
   replaceDocumentDefinition,
   searchDocumentsDefinition,
   updateDocumentsDefinition,
} from '~/bridge/scripts/definitions.js';
import { deleteDocumentsHandler } from '~/bridge/scripts/deleteDocuments.js';
import { describeSchemaHandler } from '~/bridge/scripts/describeSchema.js';
import { getDocumentHandler } from '~/bridge/scripts/getDocument.js';
import { listDocumentTypesHandler } from '~/bridge/scripts/listDocumentTypes.js';
import { replaceDocumentHandler } from '~/bridge/scripts/replaceDocument.js';
import { searchDocumentsHandler } from '~/bridge/scripts/searchDocuments.js';
import { scriptRegistry } from '~/bridge/scripts/registry.js';
import { updateDocumentsHandler } from '~/bridge/scripts/updateDocuments.js';

/**
 * The scripts that ship in the bundle, each with its handler. Static imports only: nothing is loaded at run time.
 * @type {ReadonlyArray<{ definition: import('$shared/scripts.js').ScriptDefinition, handler: Function }>}
 */
export const SHIPPED_SCRIPTS = Object.freeze([
   {
      definition: listDocumentTypesDefinition,
      handler: listDocumentTypesHandler,
   },
   {
      definition: getDocumentDefinition,
      handler: getDocumentHandler,
   },
   {
      definition: searchDocumentsDefinition,
      handler: searchDocumentsHandler,
   },
   {
      definition: describeSchemaDefinition,
      handler: describeSchemaHandler,
   },
   {
      definition: createDocumentsDefinition,
      handler: createDocumentsHandler,
   },
   {
      definition: updateDocumentsDefinition,
      handler: updateDocumentsHandler,
   },
   {
      definition: deleteDocumentsDefinition,
      handler: deleteDocumentsHandler,
   },
   {
      definition: replaceDocumentDefinition,
      handler: replaceDocumentHandler,
   },
   {
      definition: batchDefinition,
      handler: batchHandler,
   },
]);

/**
 * Register every shipped script on a registry. A refusal is logged by the registry and does not stop the others.
 * @param {import('~/bridge/scripts/registry.js').ScriptRegistry} [registry] - The registry; defaults to the client's.
 * @returns {import('~/bridge/scripts/registry.js').RegistrationOutcome[]} The outcome of each registration.
 */
export function registerShippedScripts(registry = scriptRegistry) {
   return SHIPPED_SCRIPTS.map(({ definition, handler }) => registry.register(definition, handler));
}
