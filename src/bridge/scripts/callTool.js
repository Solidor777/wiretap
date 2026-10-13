import { GATE_DENIED, OP_FAILED, TOOL_GONE } from '$shared/protocol.js';
import { getBudget } from '$shared/budgets.js';
import { cleanForLog } from '$shared/logText.js';
import { truncateUtf8, utf8Bytes } from '$shared/utf8.js';
import { requireGate } from '~/bridge/gates.js';
import { ERROR_MESSAGE_MAX_BYTES } from '~/bridge/scripts/core.js';
import { buildContext } from '~/bridge/scripts/ctx.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * How long a script handler may run before the call fails, in milliseconds. Below the sidecar's 10 s ack window, so
 * the agent receives this client's error instead of an `ENDPOINT_TIMEOUT`.
 * @type {number}
 */
export const SCRIPT_TIMEOUT_MS = 8000;

/**
 * The largest serialized result a call acks, in UTF-8 bytes. The Socket.IO server drops a message over its
 * `maxHttpBufferSize` of 1,000,000 bytes (the engine.io default; the sidecar does not change it), and an ack that
 * never arrives would surface as a timeout instead of an error.
 * @type {number}
 */
export const RESULT_WIRE_MAX_BYTES = 900_000;

/**
 * Longest caller-supplied script name echoed in an error, in UTF-8 bytes.
 * @type {number}
 */
const NAME_ECHO_MAX_BYTES = 48;

/**
 * The error code of a call refused because the client already runs the most script executions it allows.
 * @type {string}
 */
export const SCRIPT_BUSY = 'SCRIPT_BUSY';

/**
 * @typedef {object} CallToolOptions
 * @property {import('~/bridge/scripts/registry.js').ScriptRegistry} registry - The registry to look scripts up in.
 * @property {number} [timeoutMs] - The handler time limit; defaults to `SCRIPT_TIMEOUT_MS`.
 */

/**
 * Create the `callTool` op handler. A call finds the named script, enforces the script's declared gate from THIS
 * client's settings, validates the arguments against the script's own declared schema, builds the context and runs
 * the handler under a time limit. The order is fixed: a denied call learns nothing about its arguments. At most
 * `SCRIPT_CONCURRENCY_MAX` handlers run at once; a call beyond it is refused with `SCRIPT_BUSY`.
 * @param {CallToolOptions} options - The registry and time limit.
 * @returns {(params: unknown) => Promise<unknown>} The op handler: resolves with the plain-data result and rejects with
 * a `ScriptError` (its code is acked) or the handler's own error.
 */
export function createCallTool({ registry, timeoutMs = SCRIPT_TIMEOUT_MS }) {
   /** @type {number} The script executions running now, from the start of a handler until its call ends. */
   let running = 0;
   /**
    * Run a validated call: the handler under the time limit, then the result checked for the wire.
    * @param {import('~/bridge/scripts/registry.js').RegisteredScript} registered - The script.
    * @param {Record<string, unknown>} args - The validated arguments.
    * @returns {Promise<unknown>} The plain-data result.
    */
   async function run(registered, args) {
      /** @type {import('$shared/scripts.js').ScriptDefinition} The script's definition. */
      const definition = registered.definition;
      /** @type {import('~/bridge/scripts/registry.js').ScriptHandler} The code that runs the call. */
      const handler = registered.handler;
      /** @type {AbortController} Aborts the signal the handler sees. */
      const controller = new AbortController();
      /** @type {ReturnType<typeof setTimeout> | undefined} The time limit timer. */
      let timer;
      /** @type {Promise<never>} Rejects when the time limit passes. */
      const timeout = new Promise((resolve, reject) => {
         timer = setTimeout(() => {
            controller.abort();
            reject(
               new ScriptError(
                  'SCRIPT_TIMEOUT',
                  `The script did not finish in ${Math.round(timeoutMs / 1000)} s; the operation may still have ` +
                     'applied.',
               ),
            );
         }, timeoutMs);
      });
      /** @type {unknown} The handler's result. */
      let result;
      try {
         result = await Promise.race([
            Promise.resolve().then(() => handler(args, buildContext(definition, controller.signal))),
            timeout,
         ]);
      } finally {
         clearTimeout(timer);
      }
      /** @type {string | undefined} The result as JSON text; undefined for no value. */
      let text;
      try {
         text = JSON.stringify(result);
      } catch {
         throw new ScriptError('RESULT_INVALID', 'The script result could not be serialized.');
      }
      if (text === undefined) {
         return null;
      }
      if (utf8Bytes(text) > RESULT_WIRE_MAX_BYTES) {
         throw new ScriptError('RESULT_TOO_LARGE', `The script result is over ${RESULT_WIRE_MAX_BYTES} bytes.`);
      }
      return JSON.parse(text);
   }

   return async function callTool(params) {
      if (typeof params !== 'object' || params === null || typeof params.name !== 'string') {
         throw new ScriptError(OP_FAILED, 'callTool needs { name, arguments } with a string name.');
      }
      /** @type {import('~/bridge/scripts/registry.js').RegisteredScript | undefined} The script, if registered. */
      const registered = registry.get(params.name);
      if (registered === undefined) {
         throw new ScriptError(
            TOOL_GONE,
            truncateUtf8(
               `Tool '${cleanForLog(params.name, NAME_ECHO_MAX_BYTES)}' is not registered on this client.`,
               ERROR_MESSAGE_MAX_BYTES,
            ),
         );
      }
      /** @type {import('$shared/scripts.js').ScriptDefinition} The script's definition. */
      const definition = registered.definition;
      /** @type {import('$shared/schemaValidate.js').ArgumentValidator} The script's argument validator. */
      const validate = registered.validate;
      if (definition.gate !== undefined) {
         /** @type {ReturnType<typeof requireGate>} The denial, or null when open; an unreadable gate is closed. */
         const denial = requireGate(definition.gate);
         if (denial !== null) {
            throw new ScriptError(GATE_DENIED, denial.message);
         }
      }
      /** @type {ReturnType<typeof validate>} The verdict on the arguments. */
      const checked = validate(params.arguments ?? {});
      if (!checked.ok) {
         throw new ScriptError('ARGS_INVALID', checked.error);
      }
      if (running >= getBudget('SCRIPT_CONCURRENCY_MAX').value) {
         throw new ScriptError(SCRIPT_BUSY, 'The client is running too many scripts; retry shortly.');
      }
      running += 1;
      try {
         return await run(registered, checked.value);
      } finally {
         running -= 1;
      }
   };
}
