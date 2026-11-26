/**
 * The Wiretap e2e fixture module: a separate Foundry module that registers one plugin tool,
 * `wiretap-e2e-plugin__echo`, through Wiretap's `wiretap.registerTools` hook. The e2e run installs it into the
 * Foundry data folder and enables it only for the spec that uses it. Plain browser module, no imports.
 */

/**
 * @typedef {object} FixtureState
 * @property {boolean} setupSeenAtHook - Whether Foundry's `setup` hook had fired when the Wiretap hook fired.
 * @property {number} hookCalls - How many times the Wiretap hook fired on this client.
 * @property {number | null} apiVersion - The `apiVersion` the Wiretap hook passed; null before the hook fires.
 * @property {{ ok: boolean, name?: string, reason?: string } | null} outcome - What `registerTool` returned; null
 * before the hook fires.
 */

/** @type {string} This module's id from its module.json. */
const MODULE_ID = 'wiretap-e2e-plugin';

/** @type {boolean} Whether Foundry's `setup` hook has fired on this client. */
let setupSeen = false;

/** @type {FixtureState} What the spec reads back; the object `init` puts on the module's `api`. */
const state = {
   setupSeenAtHook: false,
   hookCalls: 0,
   apiVersion: null,
   outcome: null,
};

/**
 * Create one Actor named by the call's text through Wiretap's guarded create, and echo the text.
 * @param {{ text: string }} args - The validated arguments.
 * @param {{ core: { createDocuments: Function } }} ctx - The Wiretap call context.
 * @returns {Promise<{ echo: string, created: object[] }>} The text and the acknowledgement rows of the created Actor.
 */
async function handler(args, ctx) {
   /** @type {string} The first concrete Actor subtype of the world's system, or `base` when it has none. */
   const type = (game.documentTypes.Actor ?? []).find((entry) => entry !== CONST.BASE_DOCUMENT_TYPE) ?? 'base';
   /** @type {object[]} The acknowledgement rows of the created Actor. */
   const rows = await ctx.core.createDocuments({
      documentName: 'Actor',
      data: [
         {
            name: args.text,
            type,
         },
      ],
   });
   return {
      echo: args.text,
      created: rows,
   };
}

Hooks.once('init', () => {
   game.modules.get(MODULE_ID).api = { state };
});

Hooks.once('setup', () => {
   setupSeen = true;
});

Hooks.on('wiretap.registerTools', (api) => {
   state.hookCalls += 1;
   state.setupSeenAtHook = setupSeen;
   state.apiVersion = api.apiVersion;
   state.outcome = api.registerTool({
      moduleId: MODULE_ID,
      name: 'echo',
      version: '1.0.0',
      description: 'E2E fixture: creates an Actor named by text and echoes the text.',
      inputSchema: {
         type: 'object',
         properties: {
            text: {
               type: 'string',
               minLength: 1,
               maxLength: 64,
            },
         },
         required: ['text'],
         additionalProperties: false,
      },
      mutates: true,
      requires: 'api',
      handler,
   });
});
