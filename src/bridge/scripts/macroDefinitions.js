/**
 * The definition of the `execute_macro` script. It imports only through relative paths so a script run by `tsx` (the
 * manual context measurement, through the test fixtures) can load it without the build aliases.
 */

import { getBudget } from '../../../shared/budgets.js';

/**
 * The `execute_macro` definition. A macro is arbitrary code, so the script declares the `allowMacroExecution` gate,
 * which the sidecar judges on the endpoint snapshot and the `callTool` dispatcher judges again on this client before
 * validation and before the handler. The result is the macro's value, so it takes the hard cap and the sidecar turns
 * anything larger into a handle.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const executeMacroDefinition = {
   name: 'execute_macro',
   version: '1.0.0',
   description:
      'Run a Macro by uuid on this GM client and return its value; actorUuid and tokenUuid set its actor and token. ' +
      'Arbitrary code: needs allowMacroExecution.',
   inputSchema: {
      type: 'object',
      properties: {
         uuid: { type: 'string' },
         actorUuid: { type: 'string' },
         tokenUuid: { type: 'string' },
      },
      required: ['uuid'],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('RESULT_HARD_CAP_MAX_BYTES').value },
   requires: 'api',
   mutates: true,
   gate: 'allowMacroExecution',
};
