import { getBudget } from '$shared/budgets.js';
import { compileSchema } from '$shared/schemaValidate.js';
import { RESERVED_SCRIPT_NAMES, definitionBytes, validateScriptDefinition } from '$shared/scripts.js';
import { cleanForLog } from '$shared/logText.js';

/**
 * @typedef {import('$shared/scripts.js').ScriptDefinition} ScriptDefinition
 */

/**
 * @typedef {import('$shared/schemaValidate.js').ArgumentValidator} ArgumentValidator
 */

/**
 * @callback ScriptHandler
 * @param {Record<string, unknown>} args - The validated arguments: a copy that holds only the declared properties.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The execution context of this call.
 * @returns {Promise<unknown> | unknown} The result, sent to the agent as JSON; it must be plain data.
 */

/**
 * @typedef {object} RegisteredScript
 * @property {Readonly<ScriptDefinition>} definition - The normalized definition, deeply copied from the registration.
 * @property {ScriptHandler} handler - The code that runs a call.
 * @property {ArgumentValidator} validate - The validator compiled from the definition's `inputSchema`.
 * @property {number} listedBytes - The bytes the sidecar lists for the definition (its listed form).
 */

/**
 * @typedef {{ ok: true, name: string } | { ok: false, reason: string }} RegistrationOutcome
 */

/**
 * @typedef {object} ScriptRegistry
 * @property {(definition: unknown, handler: unknown) => RegistrationOutcome} register - Validate and add a script;
 * refuses with a logged reason and never throws.
 * @property {(name: unknown) => RegisteredScript | undefined} get - Look a script up by exact name.
 * @property {() => ScriptDefinition[]} definitions - Fresh copies of every definition, in registration order.
 * @property {(listener: () => void) => () => void} subscribe - Call the listener after every accepted script; returns
 * the unsubscribe function.
 */

/**
 * A failure a script handler or the call dispatcher reports with its own error code. The code is acked to the agent;
 * any other error acks as `OP_FAILED`, so a thrown system error code never leaks as a protocol code.
 */
export class ScriptError extends Error {
   /**
    * Build an error that carries the code to ack.
    * @param {string} code - An unreserved code matching `/^[A-Z][A-Z0-9_]{0,63}$/`.
    * @param {string} message - The short failure text.
    */
   constructor(code, message) {
      super(message);
      this.name = 'ScriptError';
      /** @type {string} The code acked to the agent. */
      this.code = code;
   }
}

/**
 * Longest script label written to a log line, in UTF-8 bytes.
 * @type {number}
 */
const LOG_LABEL_BYTES = 48;

/**
 * Longest refusal reason written to a log line, in UTF-8 bytes.
 * @type {number}
 */
const LOG_REASON_BYTES = 200;

/**
 * Create a script registry: the shipped scripts a Foundry client offers to the sidecar. Registration applies the shared
 * definition validator (source `shipped`), the argument-schema subset the sidecar converts, and the tool-count and
 * total-definition-bytes budgets measured on the listed form the sidecar lists; the registry never keeps a reference to
 * the objects it was given.
 * @param {object} [options] - Optional settings of the registry.
 * @param {(line: string) => void} [options.log] - Receives one line per refusal or warning; defaults to `console.warn`.
 * @returns {ScriptRegistry} A new, empty registry.
 */
export function createScriptRegistry(options = {}) {
   /**
    * Receives each log line; a throwing sink is ignored.
    * @type {(line: string) => void}
    */
   const sink = options.log ?? ((line) => console.warn(line));

   /**
    * Write one line to the sink without ever throwing.
    * @param {string} line - One log line without a line break.
    * @returns {void}
    */
   function log(line) {
      try {
         sink(line);
      } catch {
         // A failing log sink must not turn a refusal into an exception.
      }
   }

   /** @type {Map<string, RegisteredScript>} The scripts by name, in registration order. */
   const scripts = new Map();

   /** @type {Set<() => void>} The change listeners. */
   const listeners = new Set();

   /**
    * Refuse a registration: log the reason and build the outcome.
    * @param {string} label - The script's label for the log line.
    * @param {string} reason - The short reason.
    * @returns {{ ok: false, reason: string }} The refusal.
    */
   function refuse(label, reason) {
      log(`Wiretap | script registry refused ${JSON.stringify(label)}: ${cleanForLog(reason, LOG_REASON_BYTES)}`);
      return {
         ok: false,
         reason,
      };
   }

   /**
    * Tell every listener the script set changed; a throwing listener is logged and does not stop the others.
    * @returns {void}
    */
   function notify() {
      for (const listener of [...listeners]) {
         try {
            listener();
         } catch (cause) {
            log(`Wiretap | script registry listener failed: ${cleanForLog(cause?.message, LOG_REASON_BYTES)}`);
         }
      }
   }

   return {
      register(definition, handler) {
         /** @type {string} The label used in log lines until the name is known to be valid. */
         let label = '<unnamed>';
         /** @type {string} The registered name once the script is accepted. */
         let registeredName = '';
         try {
            if (typeof definition === 'object' && definition !== null && typeof definition.name === 'string') {
               label = cleanForLog(definition.name, LOG_LABEL_BYTES);
            }
            /** @type {ReturnType<typeof validateScriptDefinition>} The shared validator's verdict. */
            const validated = validateScriptDefinition(definition, 'shipped');
            if (!validated.ok) {
               return refuse(label, validated.reason);
            }
            /** @type {ScriptDefinition} The normalized definition. */
            const normalized = structuredClone(validated.definition);
            if (normalized.requires === 'none') {
               return refuse(label, 'requires none scripts run on the sidecar; a client cannot register them');
            }
            if (typeof handler !== 'function') {
               return refuse(label, 'handler must be a function');
            }
            if (scripts.has(normalized.name)) {
               return refuse(label, 'name is already registered');
            }
            /** @type {number} The most scripts the always-listed budget leaves beside the sidecar built-ins. */
            const room = getBudget('ALWAYS_LISTED_TOOLS_MAX').value - RESERVED_SCRIPT_NAMES.length;
            if (scripts.size >= room) {
               return refuse(label, `the tool count budget allows at most ${room} scripts`);
            }
            /** @type {ReturnType<typeof compileSchema>} The compiled argument validator. */
            const compiled = compileSchema(normalized.inputSchema);
            if (!compiled.ok) {
               return refuse(label, `inputSchema: ${compiled.reason}`);
            }
            /** @type {number} The bytes the sidecar lists for this definition, which its context pays for. */
            const listed = definitionBytes(normalized.name, normalized.description, compiled.listed);
            /** @type {number} The most bytes one listed definition may take. */
            const definitionMax = getBudget('DEFINITION_MAX_BYTES').value;
            if (listed > definitionMax) {
               return refuse(label, `listed definition is ${listed} bytes, at most ${definitionMax} bytes`);
            }
            /** @type {number} The room kept for the sidecar's own definitions (one maximum-size definition each). */
            const reserved = RESERVED_SCRIPT_NAMES.length * definitionMax;
            /** @type {number} The listed bytes of the definitions already registered. */
            let used = 0;
            for (const registered of scripts.values()) {
               used += registered.listedBytes;
            }
            /** @type {number} The most bytes all definitions may take together. */
            const totalMax = getBudget('ALL_DEFINITIONS_MAX_BYTES').value;
            if (used + listed + reserved > totalMax) {
               return refuse(
                  label,
                  `all definitions together may take at most ${totalMax} bytes, ${reserved} of them kept for ` +
                     'the sidecar',
               );
            }
            for (const warning of validated.warnings) {
               log(
                  `Wiretap | script registry warning for ${JSON.stringify(label)}: ` +
                     cleanForLog(warning, LOG_REASON_BYTES),
               );
            }
            registeredName = normalized.name;
            scripts.set(normalized.name, {
               definition: Object.freeze(normalized),
               handler,
               validate: compiled.validate,
               listedBytes: listed,
            });
         } catch (cause) {
            return refuse(label, `the registration could not be processed (${cleanForLog(cause?.message, 80)})`);
         }
         notify();
         return {
            ok: true,
            name: registeredName,
         };
      },

      get(name) {
         return scripts.get(name);
      },

      definitions() {
         return [...scripts.values()].map((registered) => structuredClone(registered.definition));
      },

      subscribe(listener) {
         listeners.add(listener);
         return () => {
            listeners.delete(listener);
         };
      },
   };
}

/**
 * The client's script registry: the shipped scripts of this Foundry client. The bridge reads it to push
 * `bridge:registry` and the `callTool` op looks scripts up in it.
 * @type {ScriptRegistry}
 */
export const scriptRegistry = createScriptRegistry();

/**
 * Register a shipped script on the client registry. Refuses with a logged reason and never throws.
 * @param {unknown} definition - The script definition (see `shared/scripts.js`), without the handler.
 * @param {unknown} handler - The `ScriptHandler` that runs a call.
 * @returns {RegistrationOutcome} The outcome.
 */
export function registerScript(definition, handler) {
   return scriptRegistry.register(definition, handler);
}
