/**
 * The definitions of the compendium pack scripts `create_pack` and `delete_pack`. They import only through relative
 * paths so a script run by `tsx` (the manual context measurement, through the test fixtures) can load them without the
 * build aliases.
 */

import { getBudget } from '../../../shared/budgets.js';

/**
 * The `create_pack` definition. It declares no `gate`: the dispatcher would judge a definition gate before the
 * handler, which would block the dry run, so the handler checks `allowCompendiumWrites` itself on a real run only.
 * `name` has no length bound: the handler holds it to Foundry's package-id rules, which set none. `type` is checked
 * against Foundry's compendium document types in the handler, which costs fewer listed bytes than an enum.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const createPackDefinition = {
   name: 'create_pack',
   version: '1.0.0',
   description:
      'Create a world compendium pack for one document type; name defaults to the slug of label. dryRun previews ' +
      'the id. Needs allowCompendiumWrites.',
   inputSchema: {
      type: 'object',
      properties: {
         label: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
         },
         type: { type: 'string' },
         name: {
            type: 'string',
            minLength: 1,
         },
         dryRun: { type: 'boolean' },
      },
      required: [
         'label',
         'type',
      ],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('ACK_MAX_BYTES').value },
   requires: 'api',
   mutates: true,
};

/**
 * The `delete_pack` definition. Like `create_pack` it declares no `gate`, so a dry run works while
 * `allowPackDeletion` is closed; the handler checks the gate on a real run. `requiresUserInteraction` makes the sidecar
 * list the tool with the MCP metadata that asks the client to prompt the human before every call.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const deletePackDefinition = {
   name: 'delete_pack',
   version: '1.0.0',
   description:
      'Delete an unlocked world compendium pack by id with every document in it. Irreversible. dryRun previews the ' +
      'pack. Needs allowPackDeletion.',
   inputSchema: {
      type: 'object',
      properties: {
         id: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
         },
         dryRun: { type: 'boolean' },
      },
      required: ['id'],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('ACK_MAX_BYTES').value },
   requires: 'api',
   mutates: true,
   requiresUserInteraction: true,
};
