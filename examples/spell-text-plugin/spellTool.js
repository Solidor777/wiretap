/**
 * The `create_spell` plugin tool: the agent reads spell text and passes the fields it finds; the handler maps them to
 * Item data with one fixed table, previews the create with `dryRun`, and creates the Item only if the preview passes.
 * The module imports nothing from Wiretap: Wiretap hands it the API through the `wiretap.registerTools` hook.
 */

/**
 * @typedef {object} SpellArgs
 * @property {string} name - The spell's name.
 * @property {string} itemType - The game system's Item type for spells, for example `spell`.
 * @property {number} [level] - The spell level, 0 to 9.
 * @property {string} [school] - The school of magic.
 * @property {string} [castingTime] - The casting time as written.
 * @property {string} [range] - The range as written.
 * @property {string} [duration] - The duration as written.
 * @property {string[]} [components] - Any of `V`, `S` and `M`.
 * @property {string} text - The spell's rules text.
 */

/**
 * @typedef {object} SpellItemData
 * @property {string} name - The Item name.
 * @property {string} type - The Item type.
 * @property {Record<string, unknown>} system - The system data the field table fills.
 */

/**
 * @typedef {object} SpellCore
 * @property {Function} createDocuments - Wiretap's guarded create: `({ documentName, data, dryRun? })` resolves to one
 * row per document.
 */

/**
 * The one table an author edits for their game system: each parsed argument and the dotted Item data path it is
 * written to. An argument the agent leaves out writes nothing.
 * @type {Readonly<Record<string, string>>}
 */
export const SPELL_FIELD_PATHS = Object.freeze({
   level: 'system.level',
   school: 'system.school',
   castingTime: 'system.castingTime',
   range: 'system.range',
   duration: 'system.duration',
   components: 'system.components',
   text: 'system.description',
});

/**
 * The tool definition the module passes to `api.registerTool`, without `moduleId` and `handler`. Wiretap lists it as
 * `wiretap-example-spells__create_spell`. The description and the argument names are all the agent needs; the guide
 * skill is optional. The listed form is 797 of the 800-byte guideline: a longer description or an argument description
 * draws a warning.
 * @type {Readonly<Record<string, unknown>>}
 */
export const createSpellTool = Object.freeze({
   name: 'create_spell',
   version: '1.0.0',
   description: 'Create a spell Item from parsed spell text. Required: name, itemType (the spell Item type), text.',
   inputSchema: {
      type: 'object',
      properties: {
         name: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
         },
         itemType: {
            type: 'string',
            minLength: 1,
            maxLength: 32,
         },
         level: {
            type: 'integer',
            minimum: 0,
            maximum: 9,
         },
         school: {
            type: 'string',
            maxLength: 64,
         },
         castingTime: {
            type: 'string',
            maxLength: 64,
         },
         range: {
            type: 'string',
            maxLength: 64,
         },
         duration: {
            type: 'string',
            maxLength: 64,
         },
         components: {
            type: 'array',
            items: {
               type: 'string',
               enum: [
                  'V',
                  'S',
                  'M',
               ],
            },
            maxItems: 3,
         },
         text: {
            type: 'string',
            maxLength: 4000,
         },
      },
      required: [
         'name',
         'itemType',
         'text',
      ],
      additionalProperties: false,
   },
   mutates: true,
   requires: 'api',
});

/**
 * Write a value at a dotted path, creating the plain objects on the way.
 * @param {Record<string, unknown>} target - The object to write into.
 * @param {string} path - The dotted path, for example `system.level`.
 * @param {unknown} value - The value to write.
 * @returns {void}
 */
function writePath(target, path, value) {
   /** @type {string[]} The path segments. */
   const keys = path.split('.');
   /** @type {Record<string, unknown>} The object the next segment is written into. */
   let node = target;
   for (const key of keys.slice(0, -1)) {
      if (typeof node[key] !== 'object' || node[key] === null) {
         node[key] = {};
      }
      node = /** @type {Record<string, unknown>} */ (node[key]);
   }
   node[keys[keys.length - 1]] = value;
}

/**
 * Map parsed spell fields to Item data. The same arguments always give the same data: each field in
 * `SPELL_FIELD_PATHS` that the arguments carry is written at its path, in the table's order.
 * @param {SpellArgs} args - The validated arguments.
 * @returns {SpellItemData} The Item data to create.
 */
export function mapSpell(args) {
   /** @type {SpellItemData} The Item data. */
   const data = {
      name: args.name,
      type: args.itemType,
      system: {},
   };
   for (const [field, path] of Object.entries(SPELL_FIELD_PATHS)) {
      if (args[field] !== undefined) {
         writePath(data, path, args[field]);
      }
   }
   return data;
}

/**
 * Create the spell Item. A dry run goes first, so a refusal (a gate, an unknown Item type, data the system rejects)
 * stops the call before anything is written; its error reaches the agent unchanged.
 * @param {SpellArgs} args - The validated arguments.
 * @param {{ core: SpellCore }} ctx - The call context Wiretap passes to the handler.
 * @returns {Promise<unknown>} The created rows, one `{ uuid, name, type }` per Item.
 */
export async function createSpellHandler(args, ctx) {
   await ctx.core.createDocuments({
      documentName: 'Item',
      data: [mapSpell(args)],
      dryRun: true,
   });
   return ctx.core.createDocuments({
      documentName: 'Item',
      data: [mapSpell(args)],
   });
}
