import {
   BRIDGE_GATE_STATE,
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   BRIDGE_PING,
   BRIDGE_REGISTRY,
   OP_CALL_TOOL,
   OP_FAILED,
   PROTOCOL_MISMATCH,
   PROTOCOL_VERSION,
} from '$shared/protocol.js';
import { cleanForLog, describeCause } from '$shared/logText.js';
import { SCRIPT_API_VERSION } from '$shared/scripts.js';
import { truncateUtf8 } from '$shared/utf8.js';
import { gateNameFromSettingKey, readGateState } from '~/bridge/gates.js';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import { ERROR_MESSAGE_MAX_BYTES } from '~/bridge/scripts/core.js';
import { ScriptError, scriptRegistry } from '~/bridge/scripts/registry.js';

/**
 * Live bridge state; `identified` is true only from an ok identify ack until the next disconnect, refusal or
 * reconnect.
 * @type {{ identified: boolean }}
 */
export const bridgeState = { identified: false };

/** @type {string[]} The hooks for a created (first change), updated or deleted (reset to default) Setting document. */
const SETTING_HOOKS = [
   'createSetting',
   'updateSetting',
   'deleteSetting',
];

/**
 * The gate-change listener currently registered on `SETTING_HOOKS`; null until `initFoundryBridge` wires a socket.
 * @type {((document: unknown, ...args: unknown[]) => void) | null}
 */
let gateHookListener = null;

/**
 * Register the listener on the setting hooks, replacing the one registered by an earlier wiring so a repeated wiring
 * never pushes twice.
 * @param {(document: unknown, ...args: unknown[]) => void} listener - Called with the changed Setting document and the
 * remaining hook arguments, the last of which is the id of the user who made the change.
 * @returns {void}
 */
function installGateHooks(listener) {
   for (const hook of SETTING_HOOKS) {
      if (gateHookListener) {
         Hooks.off(hook, gateHookListener);
      }
      Hooks.on(hook, listener);
   }
   gateHookListener = listener;
}

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
 * The unsubscribe function of the registry listener currently wired; null until `initFoundryBridge` wires a socket.
 * @type {(() => void) | null}
 */
let registryUnsubscribe = null;

/**
 * Build the text of an op failure: the thrown value's message, or its string form, bounded to the ack error budget.
 * @param {unknown} thrown - The value an op handler threw.
 * @returns {string} A message of at most `ERROR_MESSAGE_MAX_BYTES` bytes; never throws.
 */
function failureMessage(thrown) {
   /** @type {string} The unbounded text. */
   let text;
   try {
      text = typeof thrown?.message === 'string' ? thrown.message : String(thrown);
   } catch {
      text = 'The operation failed.';
   }
   return truncateUtf8(text, ERROR_MESSAGE_MAX_BYTES);
}

/**
 * Longest caller-supplied op name echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const OP_ECHO_MAX_BYTES = 48;

/**
 * Answer an invoke request when the sidecar supplied an ack callback. A missing ack is ignored and a throwing ack is
 * logged, so a reply never becomes an unhandled rejection.
 * @param {unknown} ack - The callback Socket.IO supplied, if any.
 * @param {object} value - The ack value.
 * @returns {void}
 */
function replyInvoke(ack, value) {
   if (typeof ack !== 'function') {
      return;
   }
   try {
      ack(value);
   } catch (cause) {
      console.error(`Wiretap | bridge invoke ack failed: ${describeCause(cause)}`);
   }
}

/**
 * Wire the Foundry bridge onto the connection's socket: send the identify (with the gate snapshot) on each connect
 * (acked by the sidecar), send the script registry after each ok identify ack and, once per task, whenever it changes,
 * push a fresh gate snapshot when a gate setting changes, track the identified state, answer BRIDGE_INVOKE requests by
 * dispatching through the op table, and ack BRIDGE_PING liveness probes with `{ ok: true }`.
 * Reuses the single socket owned by the TerminalConnection (no second connection is opened).
 * @param {import('~/bridge/TerminalConnection.svelte.js').TerminalConnection} connection - The shared connection.
 * @param {object} [options] - Wiring options.
 * @param {import('~/bridge/scripts/registry.js').ScriptRegistry} [options.scripts] - The script registry to serve;
 * defaults to the client's own.
 * @returns {void}
 */
export function initFoundryBridge(connection, { scripts = scriptRegistry } = {}) {
   /**
    * Op-name to handler table; new core ops add one entry.
    * @type {Record<string, (params: unknown) => Promise<unknown>>}
    */
   const opHandlers = {
      [OP_CALL_TOOL]: createCallTool({ registry: scripts }),
   };

   connection.onSocket((socket) => {
      // Answer operation requests (registered once per socket; persists across reconnects). The whole listener runs in
      // one try: a malformed request or a missing ack never becomes an unhandled rejection.
      socket.on(BRIDGE_INVOKE, async (request, ack) => {
         try {
            /** @type {unknown} The requested op name; undefined for a request that is not an object. */
            const op = typeof request === 'object' && request !== null ? request.op : undefined;
            // Own-property lookup: inherited names such as `constructor` or `__proto__` must stay unknown ops.
            /** @type {((params: unknown) => Promise<unknown>) | undefined} The registered handler, if any. */
            const handler = typeof op === 'string' && Object.hasOwn(opHandlers, op) ? opHandlers[op] : undefined;
            if (!handler) {
               replyInvoke(ack, {
                  ok: false,
                  error: {
                     code: OP_FAILED,
                     message: truncateUtf8(
                        `Unknown op '${cleanForLog(op, OP_ECHO_MAX_BYTES)}'.`,
                        ERROR_MESSAGE_MAX_BYTES,
                     ),
                  },
               });
               return;
            }
            try {
               replyInvoke(ack, {
                  ok: true,
                  result: await handler(request.params),
               });
            } catch (err) {
               replyInvoke(ack, {
                  ok: false,
                  error: {
                     code: err instanceof ScriptError ? err.code : OP_FAILED,
                     message: failureMessage(err),
                  },
               });
            }
         } catch (cause) {
            console.error(`Wiretap | bridge invoke failed: ${describeCause(cause)}`);
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

      /**
       * Send the complete script list to the sidecar, which replaces this endpoint's previous list with it. Only an
       * identified, connected endpoint sends: the sidecar refuses a registry from a socket it has not registered. The
       * payload holds definitions only; handlers never leave the client. The sidecar's ack reports how many entries it
       * accepted and refused (the reasons are in the sidecar log).
       * @returns {void}
       */
      const sendRegistry = () => {
         if (!bridgeState.identified || !socket.connected) {
            return;
         }
         socket.emit(
            BRIDGE_REGISTRY,
            {
               apiVersion: SCRIPT_API_VERSION,
               scripts: scripts.definitions(),
            },
            (ack) => {
               if (ack?.ok === true) {
                  if (ack.refused > 0) {
                     console.warn(
                        `Wiretap | bridge registry: the sidecar accepted ${ack.accepted} and refused ${ack.refused} ` +
                           'scripts; the sidecar log gives the reasons.',
                     );
                  }
                  return;
               }
               /** @type {string} The refusal code. */
               const code = ack?.error?.code ?? 'UNKNOWN';
               /** @type {string} The refusal reason. */
               const message = ack?.error?.message ?? 'No reason given.';
               console.error(`Wiretap | bridge registry refused (${code}): ${message}`);
            },
         );
      };
      /** @type {boolean} Whether a registry push is queued for the end of the current task. */
      let registryPushQueued = false;

      /**
       * Queue one registry push for the end of the current task, so scripts registered in the same task share one push:
       * the sidecar applies only a few registry pushes per second per socket.
       * @returns {void}
       */
      const queueRegistryPush = () => {
         if (registryPushQueued) {
            return;
         }
         registryPushQueued = true;
         queueMicrotask(() => {
            registryPushQueued = false;
            sendRegistry();
         });
      };
      registryUnsubscribe?.();
      registryUnsubscribe = scripts.subscribe(queueRegistryPush);
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
               gateState: readGateState(),
            },
            (ack) => {
               // An ack from an earlier attempt or connection must not decide the state of a later one.
               if (token !== attempt) {
                  return;
               }
               if (ack?.ok === true) {
                  bridgeState.identified = true;
                  sendRegistry();
                  return;
               }
               bridgeState.identified = false;
               /** @type {string} The refusal code. */
               const code = ack?.error?.code ?? 'UNKNOWN';
               /** @type {string} The refusal reason. */
               const message = ack?.error?.message ?? 'No reason given.';
               /** @type {string} The advice appended to a protocol mismatch. */
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

      /**
       * Push the fresh gate snapshot to the sidecar after a gate setting changed. Only a connected GM client pushes;
       * the sidecar accepts a snapshot only from an identified endpoint, and a refusal is logged. The identify carries
       * the snapshot read at (re)connect, so a change while disconnected needs no push. The setting document is already
       * in the world collection when the hook runs (the collection is updated before the hook is called), so
       * `readGateState` sees the new value, and the default after a delete. A change made by a user who is not a GM is
       * ignored: the author is the last hook argument for create, update and delete alike.
       * @param {{ key?: unknown } | null} document - The created, updated or deleted Setting document.
       * @param {...unknown} args - The remaining hook arguments; the last is the author's user id.
       * @returns {void}
       */
      const pushGateState = (document, ...args) => {
         if (!game.user.isGM || !socket.connected || gateNameFromSettingKey(document?.key) === null) {
            return;
         }
         if (game.users.get(args.at(-1))?.isGM !== true) {
            return;
         }
         socket.emit(BRIDGE_GATE_STATE, readGateState(), (ack) => {
            if (ack?.ok === true) {
               return;
            }
            /** @type {string} The refusal code. */
            const code = ack?.error?.code ?? 'UNKNOWN';
            /** @type {string} The refusal reason. */
            const message = ack?.error?.message ?? 'No reason given.';
            console.error(`Wiretap | bridge gate state refused (${code}): ${message}`);
         });
      };
      installGateHooks(pushGateState);

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
