/**
 * The definitions of the sheet scripts `open_sheet` and `close_sheet`. They import only through relative paths so a
 * script run by `tsx` (the manual context measurement, through the test fixtures) can load them without the build
 * aliases.
 */

import { getBudget } from '../../../shared/budgets.js';

/**
 * The arguments both sheet scripts take: the document, and optionally the connected user whose client acts. A
 * Foundry user id is 16 characters.
 * @type {object}
 */
const SHEET_INPUT_SCHEMA = {
   type: 'object',
   properties: {
      uuid: { type: 'string' },
      userId: {
         type: 'string',
         maxLength: 16,
      },
   },
   required: ['uuid'],
   additionalProperties: false,
};

/**
 * The script definition.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const openSheetDefinition = {
   name: 'open_sheet',
   version: '1.0.0',
   description: 'Open a document\'s sheet: on the client of the connected user named by userId (needs OBSERVER), else '
      + 'on this endpoint.',
   inputSchema: SHEET_INPUT_SCHEMA,
   result: { budgetBytes: getBudget('SHEET_RESULT_MAX_BYTES').value },
   requires: 'api',
   mutates: false,
};

/**
 * The script definition.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const closeSheetDefinition = {
   name: 'close_sheet',
   version: '1.0.0',
   description: 'Close a document\'s sheet if open: on the client of the connected user named by userId, else on this '
      + 'endpoint.',
   inputSchema: SHEET_INPUT_SCHEMA,
   result: { budgetBytes: getBudget('SHEET_RESULT_MAX_BYTES').value },
   requires: 'api',
   mutates: false,
};
