/**
 * The definition of the `execute_macro` script. It imports only through relative paths so a script run by `tsx` (the
 * manual context measurement, through the test fixtures) can load it without the build aliases.
 */

import { getBudget } from '../../../shared/budgets.js';

/**
 * The largest `timeoutMs`: the sidecar waits `timeoutMs` + 2 s for the reply (`server/endpoints.ts`), and that delay
 * must fit a timer, which Node and browsers store as a signed 32-bit integer of milliseconds; a longer one fires at
 * once (Node `setTimeout` docs; MDN, "setTimeout(): Maximum delay value"). The smallest is 1 ms: a time limit of 0 or
 * less has passed before the macro starts.
 * @type {number}
 */
const MACRO_TIMEOUT_MAX_MS = 2 ** 31 - 1 - 2000;

/**
 * The `timeoutMs` past which a call logs one warning line.
 * @type {number}
 */
export const MACRO_TIMEOUT_GUIDELINE_MS = 300_000;

/**
 * The `execute_macro` definition. A macro is arbitrary code, so the script declares the `allowMacroExecution` gate,
 * which the sidecar judges on the endpoint snapshot and the `callTool` dispatcher judges again on this client before
 * validation and before the handler. The result is the macro's value, so it takes the hard cap and the sidecar turns
 * anything larger into a handle. `timeoutMs` is the shared time-limit argument the `callTool` dispatcher and the
 * sidecar both read; absent, the limit is 8 s. The handler logs one warning line past `MACRO_TIMEOUT_GUIDELINE_MS`.
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
         timeoutMs: {
            type: 'integer',
            minimum: 1,
            maximum: MACRO_TIMEOUT_MAX_MS,
         },
      },
      required: ['uuid'],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('RESULT_HARD_CAP_MAX_BYTES').value },
   requires: 'api',
   mutates: true,
   gate: 'allowMacroExecution',
};
