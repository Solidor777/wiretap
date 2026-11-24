/**
 * The `bridge:registry` payload the client pushes, held within the sidecar's message bound. The sidecar's Socket.IO
 * server drops a message over its `maxHttpBufferSize` of 1,000,000 bytes (the engine.io default, which the sidecar
 * keeps), so an oversized push would leave the endpoint with no tools at all. The payload is held to
 * `REGISTRY_WIRE_MAX_BYTES`, the same margin below that bound that `RESULT_WIRE_MAX_BYTES` keeps for results.
 *
 * Only plugin definitions (those with an own `moduleId`) are left out, the most recently registered first: plugin
 * tools are unbounded in number and size, while the shipped definitions are each held to `DEFINITION_MAX_BYTES` and
 * together stay far below the bound, so the shipped tools always reach the sidecar.
 */
import { SCRIPT_API_VERSION } from '$shared/scripts.js';
import { utf8Bytes } from '$shared/utf8.js';

/**
 * The largest serialized registry payload the client pushes, in UTF-8 bytes. `SCHEMA_EXPANDED_NODES_MAX` of
 * `shared/schemaValidate.js` is sized against this bound.
 * @type {number}
 */
export const REGISTRY_WIRE_MAX_BYTES = 900_000;

/**
 * The sidecar's Socket.IO `maxHttpBufferSize`, in bytes, named in the log line of a left-out tool.
 * @type {number}
 */
const SOCKET_MESSAGE_MAX_BYTES = 1_000_000;

/**
 * Build the registry payload from the registered definitions, leaving out plugin definitions from the end of the list
 * until the serialized payload is at most `REGISTRY_WIRE_MAX_BYTES`. Each definition's JSON is measured once. Logs one
 * line per definition left out.
 * @param {import('$shared/scripts.js').ScriptDefinition[]} definitions - The definitions in registration order.
 * @param {(line: string) => void} log - Receives one line per definition left out.
 * @returns {import('$shared/scripts.js').ScriptRegistryPayload} The payload to emit.
 */
export function buildRegistryPayload(definitions, log) {
   /** @type {number[]} The UTF-8 bytes of each definition's JSON, by index. */
   const sizes = definitions.map((definition) => utf8Bytes(JSON.stringify(definition)));
   /** @type {boolean[]} Whether each definition stays in the payload, by index. */
   const kept = definitions.map(() => true);
   /** @type {number} The definitions kept so far. */
   let count = definitions.length;
   /**
    * @type {number} The payload's serialized size: the envelope, every kept definition and the commas between
    * them.
    */
   let total =
      utf8Bytes(
         JSON.stringify({
            apiVersion: SCRIPT_API_VERSION,
            scripts: [],
         }),
      ) +
      sizes.reduce((sum, size) => sum + size, 0) +
      Math.max(count - 1, 0);
   for (let index = definitions.length - 1; index >= 0 && total > REGISTRY_WIRE_MAX_BYTES; index -= 1) {
      if (!Object.hasOwn(definitions[index], 'moduleId')) {
         continue;
      }
      kept[index] = false;
      count -= 1;
      total -= sizes[index] + (count > 0 ? 1 : 0);
      log(
         `Wiretap | registry push left out plugin tool ${JSON.stringify(definitions[index].name)}: the registry ` +
            `message would exceed ${REGISTRY_WIRE_MAX_BYTES} bytes (the sidecar's Socket.IO message bound is ` +
            `${SOCKET_MESSAGE_MAX_BYTES} bytes)`,
      );
   }
   return {
      apiVersion: SCRIPT_API_VERSION,
      scripts: definitions.filter((definition, index) => kept[index]),
   };
}
