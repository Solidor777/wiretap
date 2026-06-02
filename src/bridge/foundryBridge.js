import { BRIDGE_IDENTIFY, BRIDGE_INVOKE, OP_CREATE_ACTOR } from '$shared/protocol.js';

/**
 * Create an Actor in the live world. Resolves the actor subtype client-side so the tool stays
 * system-agnostic: an omitted type defaults to the world's first concrete subtype, and an unknown
 * type is rejected with the list of valid types.
 * @param {{ name: string, type?: string }} params - The actor name and optional subtype.
 * @returns {Promise<{ uuid: string, id: string, name: string, type: string }>} The created actor summary.
 */
export async function createActor({ name, type }) {
   // Concrete subtypes = all declared Actor types minus the abstract base type.
   const concreteTypes = game.documentTypes.Actor.filter((t) => t !== CONST.BASE_DOCUMENT_TYPE);
   if (concreteTypes.length === 0) {
      throw new Error('No concrete Actor subtypes are registered in this world.');
   }
   if (type !== undefined && !concreteTypes.includes(type)) {
      throw new Error(`Unknown actor type '${type}'. Valid types: ${concreteTypes.join(', ')}`);
   }
   const resolvedType = type ?? concreteTypes[0];
   const actor = await Actor.create({ name, type: resolvedType });
   return { uuid: actor.uuid, id: actor.id, name: actor.name, type: actor.type };
}

/** @type {Record<string, (params: object) => Promise<unknown>>} Op-name → handler registry; new tools add one entry. */
const OP_HANDLERS = {
   [OP_CREATE_ACTOR]: createActor,
};

/**
 * Wire the Foundry bridge onto the connection's socket: send identify on each connect and answer
 * BRIDGE_INVOKE requests by dispatching through the op registry. Reuses the single socket owned by
 * the TerminalConnection (no second connection is opened).
 * @param {import('~/bridge/TerminalConnection.svelte.js').TerminalConnection} connection - The shared connection.
 * @returns {void}
 */
export function initFoundryBridge(connection) {
   connection.onSocket((socket) => {
      // Answer operation requests (registered once per socket; persists across reconnects).
      socket.on(BRIDGE_INVOKE, async ({ op, params }, ack) => {
         const handler = OP_HANDLERS[op];
         if (!handler) {
            ack({ ok: false, error: `Unknown op '${op}'.` });
            return;
         }
         try {
            const result = await handler(params);
            ack({ ok: true, result });
         } catch (err) {
            ack({ ok: false, error: err?.message ?? String(err) });
         }
      });

      // Identify as a GM bridge endpoint on every (re)connect.
      const identify = () => {
         socket.emit(BRIDGE_IDENTIFY, { userId: game.user.id, userName: game.user.name, isGM: game.user.isGM });
      };
      socket.on('connect', identify);
      if (socket.connected) {
         identify();
      }
   });
}
