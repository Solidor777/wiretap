import { scriptCore } from '~/bridge/scripts/core.js';
import { shape } from '~/bridge/scripts/shape.js';

/**
 * @typedef {object} ScriptContext
 * @property {typeof scriptCore} core - The core operations; gated categories apply their gates inside.
 * @property {typeof shape} shape - Result shaping: compact view, projection, path slices and ack.
 * @property {AbortSignal} signal - Aborts when the call times out; a long handler should stop on it.
 * @property {(line: string) => void} log - Writes one line to the registry's log sink; never throws.
 * @property {{ document: Document }} [dom] - Present only for a script that declares `requires: 'dom'`.
 */

/**
 * Build the frozen execution context of one script call.
 * @param {import('$shared/scripts.js').ScriptDefinition} definition - The called script's definition.
 * @param {AbortSignal} signal - The call's abort signal.
 * @param {(line: string) => void} log - The registry's log sink.
 * @returns {Readonly<ScriptContext>} The context; `dom` exists only when the script requires the DOM.
 */
export function buildContext(definition, signal, log) {
   return Object.freeze({
      core: scriptCore,
      shape,
      signal,
      log,
      ...(definition.requires === 'dom' ? { dom: Object.freeze({ document: globalThis.document }) } : {}),
   });
}
