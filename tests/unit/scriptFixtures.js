/**
 * Shared builders for tests of the script registry: a valid script definition and a registry payload. Not a test file
 * (vitest only collects `*.test.js`).
 */
import { compileSchema } from '../../shared/schemaValidate.js';
import { SCRIPT_API_VERSION, definitionBytes } from '../../shared/scripts.js';
import { createActorDefinition } from '../../src/bridge/scripts/createActor.js';

/**
 * Build a valid shipped script definition; fields in `overrides` replace the defaults.
 * @param {string} name - The tool name the script registers as.
 * @param {object} [overrides] - Fields replacing the defaults.
 * @returns {object} A script definition that passes every budget.
 */
export function script(name, overrides = {}) {
   return {
      name,
      version: '1.0.0',
      description: `The ${name} script.`,
      inputSchema: {
         type: 'object',
         properties: { text: { type: 'string' } },
         required: ['text'],
      },
      result: { budgetBytes: 2000 },
      requires: 'api',
      mutates: false,
      ...overrides,
   };
}

/**
 * Wrap script definitions in the `bridge:registry` payload.
 * @param {object[]} scripts - The script definitions to send.
 * @param {object} [overrides] - Payload fields replacing the defaults.
 * @returns {{ apiVersion: number, scripts: object[] }} The payload as the client emits it.
 */
export function registryPayload(scripts, overrides = {}) {
   return {
      apiVersion: SCRIPT_API_VERSION,
      scripts,
      ...overrides,
   };
}

/**
 * Build the `create_actor` script exactly as the Foundry client ships it: a mutating api script whose result is an
 * acknowledgement within the 256-byte budget. A copy of the shipped definition, so the budget tests judge the real one.
 * @returns {object} The definition.
 */
export function createActorScript() {
   return structuredClone(createActorDefinition);
}

/**
 * Build a valid argument schema whose listed form (as the sidecar lists it) in a definition named `padded_script` with
 * a 20-character description is as close to, and never over, the given size.
 * @param {number} targetBytes - The wanted listed definition size in bytes.
 * @returns {object} The schema: string properties whose descriptions carry the padding.
 */
export function paddedSchema(targetBytes) {
   /** @type {{ type: string, properties: Record<string, object> }} The schema under construction. */
   const schema = {
      type: 'object',
      properties: {},
   };
   /**
    * Measure a schema as listed.
    * @param {object} candidate - The schema.
    * @returns {number} The listed definition bytes.
    */
   const measure = (candidate) => definitionBytes('padded_script', 'd'.repeat(20), compileSchema(candidate).listed);
   for (let index = 0; index < 64; index += 1) {
      /** @type {number} The longest description of the next property that keeps the listed size within the target. */
      let fit = 0;
      for (let length = 1; length <= 240; length += 1) {
         const trial = structuredClone(schema);
         trial.properties[`p${index}`] = {
            type: 'string',
            description: 'd'.repeat(length),
         };
         if (measure(trial) <= targetBytes) {
            fit = length;
         }
      }
      if (fit === 0) {
         break;
      }
      schema.properties[`p${index}`] = {
         type: 'string',
         description: 'd'.repeat(fit),
      };
   }
   return schema;
}
