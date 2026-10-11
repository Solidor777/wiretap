import {
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   BRIDGE_PING,
   OP_CREATE_ACTOR,
   OP_FAILED,
   PROTOCOL_MISMATCH,
   PROTOCOL_VERSION,
} from '$shared/protocol.js';

/**
 * Live bridge state; `identified` is true only from an ok identify ack until the next disconnect, refusal or
 * reconnect.
 * @type {{ identified: boolean }}
 */
export const bridgeState = { identified: false };

/**
 * Re-sends the identify on the wired socket when connected and the endpointKind setting differs from the kind last
 * sent; null until `initFoundryBridge` wires a socket.
 * @type {(() => void) | null}
 */
let reidentifyActive = null;

/**
 * Re-identify the wired socket after the endpointKind setting changed. No-op when no socket is wired, the socket is
 * disconnected (the next connect identifies with the current kind) or the kind equals the one last sent.
 * @returns {void}
 */
export function reidentifyBridge() {
   reidentifyActive?.();
}

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

/**
 * Op-name to handler registry; new tools add one entry.
 * @type {Record<string, (params: object) => Promise<unknown>>}
 */
const OP_HANDLERS = {
   [OP_CREATE_ACTOR]: createActor,
};

/**
 * Wire the Foundry bridge onto the connection's socket: send the protocol v2 identify on each connect (acked by the
 * sidecar), track the identified state, answer BRIDGE_INVOKE requests by dispatching through the op registry, and ack
 * BRIDGE_PING liveness probes with `{ ok: true }`.
 * Reuses the single socket owned by the TerminalConnection (no second connection is opened).
 * @param {import('~/bridge/TerminalConnection.svelte.js').TerminalConnection} connection - The shared connection.
 * @returns {void}
 */
export function initFoundryBridge(connection) {
   connection.onSocket((socket) => {
      // Answer operation requests (registered once per socket; persists across reconnects).
      socket.on(BRIDGE_INVOKE, async ({ op, params }, ack) => {
         // Own-property lookup: inherited names such as `constructor` or `__proto__` must stay unknown ops.
         /** @type {((params: object) => Promise<unknown>) | undefined} The registered handler, if any. */
         const handler = Object.hasOwn(OP_HANDLERS, op) ? OP_HANDLERS[op] : undefined;
         if (!handler) {
            ack({ ok: false, error: { code: OP_FAILED, message: `Unknown op '${op}'.` } });
            return;
         }
         try {
            const result = await handler(params);
            ack({ ok: true, result });
         } catch (err) {
            ack({ ok: false, error: { code: OP_FAILED, message: err?.message ?? String(err) } });
         }
      });

      // Answer the sidecar's liveness probe, independent of identify state. The ack is the callback Socket.IO supplies
      // when the sidecar emitted with one; a missing or non-function ack is ignored.
      socket.on(BRIDGE_PING, (ack) => {
         if (typeof ack === 'function') {
            ack({ ok: true });
         }
      });

      /** @type {number} Token of the latest identify attempt or disconnect; an ack for any other token is stale. */
      let attempt = 0;
      /** @type {string | undefined} The kind carried by the latest identify emit. */
      let sentKind;

      /**
       * Identify as a bridge endpoint; the endpoint is usable only after an ok ack for this attempt.
       * @returns {void}
       */
      const identify = () => {
         bridgeState.identified = false;
         attempt += 1;
         /** @type {number} Token identifying this attempt. */
         const token = attempt;
         sentKind = game.settings.get('wiretap', 'endpointKind');
         socket.emit(
            BRIDGE_IDENTIFY,
            {
               protocolVersion: PROTOCOL_VERSION,
               userId: game.user.id,
               userName: game.user.name,
               isGM: game.user.isGM,
               kind: sentKind,
               dom: true,
            },
            (ack) => {
               // An ack from an earlier attempt or connection must not decide the state of a later one.
               if (token !== attempt) {
                  return;
               }
               if (ack?.ok === true) {
                  bridgeState.identified = true;
                  return;
               }
               bridgeState.identified = false;
               const code = ack?.error?.code ?? 'UNKNOWN';
               const message = ack?.error?.message ?? 'No reason given.';
               const hint = code === PROTOCOL_MISMATCH ? ' Reload Foundry to load the current Wiretap client.' : '';
               console.error(`Wiretap | bridge identify refused (${code}): ${message}${hint}`);
            },
         );
      };
      // Re-send the identify only when connected and the setting differs from the kind last sent.
      reidentifyActive = () => {
         if (socket.connected && game.settings.get('wiretap', 'endpointKind') !== sentKind) {
            identify();
         }
      };
      socket.on('connect', identify);
      socket.on('disconnect', () => {
         attempt += 1;
         bridgeState.identified = false;
      });
      if (socket.connected) {
         identify();
      }
   });
}
