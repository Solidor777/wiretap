/**
 * The shipped `create_actor` script: creates an Actor in the live world through the core operation and returns a
 * 256-byte acknowledgement `{ uuid, name, type }`.
 */

/**
 * The script definition.
 * @type {import('$shared/scripts.js').ScriptDefinition}
 */
export const createActorDefinition = {
   name: 'create_actor',
   version: '1.0.0',
   description: 'Create an Actor in the live Foundry world. Returns its uuid, name and type.',
   inputSchema: {
      type: 'object',
      properties: {
         name: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
            description: 'The actor name.',
         },
         type: {
            type: 'string',
            minLength: 1,
            maxLength: 64,
            description: 'The actor subtype; defaults to the first concrete subtype of the world.',
         },
      },
      required: ['name'],
      additionalProperties: false,
   },
   result: { budgetBytes: 256 },
   requires: 'api',
   mutates: true,
};

/**
 * Create the actor and acknowledge it.
 * @param {{ name: string, type?: string }} args - The validated arguments.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context.
 * @returns {Promise<Record<string, string | number | boolean | null>>} The ack: the actor's uuid, name and type.
 */
export async function createActorHandler(args, ctx) {
   const actor = await ctx.core.createActor({
      name: args.name,
      type: args.type,
   });
   return ctx.shape.ack({
      uuid: actor.uuid,
      name: actor.name,
      type: actor.type,
   });
}
