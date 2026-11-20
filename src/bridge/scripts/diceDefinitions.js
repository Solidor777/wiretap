/**
 * The definitions of the dice scripts, `roll` and `draw_table`. They import only through relative paths so a script
 * run by `tsx` (the manual context measurement, through the test fixtures) can load them without the build aliases.
 * Both are mutating: `roll` can create a ChatMessage and `draw_table` marks results drawn.
 */

import { getBudget } from '../../../shared/budgets.js';

/**
 * What the agent is shown of `roll`: one formula and the chat switch.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const rollDefinition = {
   name: 'roll',
   version: '1.0.0',
   description:
      'Roll a dice formula such as 2d6+3. Returns the total and each die; ' +
      'toChat posts the roll to chat (default false).',
   inputSchema: {
      type: 'object',
      properties: {
         formula: {
            type: 'string',
            maxLength: 256,
         },
         toChat: { type: 'boolean' },
      },
      required: ['formula'],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('ROLL_RESULT_MAX_BYTES').value },
   requires: 'api',
   mutates: true,
};

/**
 * What the agent is shown of `draw_table`: one table uuid and the chat switch.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const drawTableDefinition = {
   name: 'draw_table',
   version: '1.0.0',
   description:
      'Draw from a RollTable by uuid; drawn results are marked as Foundry does. ' +
      'toChat posts the draw to chat (default false).',
   inputSchema: {
      type: 'object',
      properties: {
         uuid: { type: 'string' },
         toChat: { type: 'boolean' },
      },
      required: ['uuid'],
      additionalProperties: false,
   },
   result: { budgetBytes: getBudget('DRAW_RESULT_MAX_BYTES').value },
   requires: 'api',
   mutates: true,
};
