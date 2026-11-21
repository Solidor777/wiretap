/**
 * The shipped `execute_macro` script: runs a Macro as this GM client, optionally naming the Actor and the Token the
 * macro acts on, and returns its value. The `allowMacroExecution` gate is declared in `macroDefinitions.js` and judged
 * by the `callTool` dispatcher before this handler runs. Every argument is resolved and checked before the macro runs,
 * so a refusal never leaves a macro half run.
 */

import { cleanForLog, describeCause } from '$shared/logText.js';
import { utf8Bytes } from '$shared/utf8.js';
import { RESULT_WIRE_MAX_BYTES } from '~/bridge/scripts/callTool.js';
import { resolveDocument } from '~/bridge/scripts/canonical.js';
import { ScriptError } from '~/bridge/scripts/registry.js';

/**
 * Most UTF-8 bytes of a caller's uuid shown in a refusal.
 * @type {number}
 */
const SHOWN_MAX_BYTES = 64;

/**
 * Most UTF-8 bytes of a macro error's text in the `MACRO_FAILED` message. With the longer of the two prefixes (42
 * bytes) the message stays within the 256-byte bound.
 * @type {number}
 */
const CAUSE_MAX_BYTES = 200;

/**
 * @typedef {object} MacroResult
 * @property {'script' | 'chat'} type - The macro's type.
 * @property {unknown} value - The macro's value as plain JSON data: a Document as its uuid, nothing as null.
 * @property {true} [unserializable] - Set when the value could not be serialized; `value` is then null.
 * @property {true} [tooLarge] - Set when the result would not fit the wire bound; `value` is then null.
 * @property {number} [bytes] - With `tooLarge`, the UTF-8 bytes of the value's JSON text.
 */

/**
 * Resolve a uuid argument and check its document class.
 * @param {string} name - The argument's name, shown in the refusal.
 * @param {string} uuid - The caller's uuid.
 * @param {string} documentName - The document class the argument must name.
 * @param {string} article - The article that goes before the class name in the refusal (`a` or `an`).
 * @returns {Promise<object>} The resolved document.
 * @throws {ScriptError} `DOC_NOT_FOUND` when nothing matches, `ARGS_INVALID` for another class.
 */
async function resolveAs(name, uuid, documentName, article) {
   /** @type {{ documentName: string }} The resolved document. */
   const document = await resolveDocument({ uuid });
   if (document.documentName !== documentName) {
      /** @type {string} The caller's uuid, cleaned and bounded. */
      const shown = cleanForLog(uuid, SHOWN_MAX_BYTES);
      throw new ScriptError(
         'ARGS_INVALID',
         `${name} '${shown}' is a document of type ${document.documentName}, not ${article} ${documentName}.`,
      );
   }
   return document;
}

/**
 * Build the execution scope from the named actor and token: the speaker Foundry would compute for them, the Actor, and
 * the Token placeable.
 * @param {string | undefined} actorUuid - The uuid of the Actor the macro acts on.
 * @param {string | undefined} tokenUuid - The uuid of the Token the macro acts on.
 * @returns {Promise<{ speaker: object, actor: object | undefined, token: object | undefined }>} The
 * `Macro#execute` argument.
 * @throws {ScriptError} `DOC_NOT_FOUND` or `ARGS_INVALID` for an argument that names no fitting document.
 */
async function buildScope(actorUuid, tokenUuid) {
   /** @type {object | undefined} The Actor the macro acts on. */
   const actor = actorUuid === undefined ? undefined : await resolveAs('actorUuid', actorUuid, 'Actor', 'an');
   /** @type {object | undefined} The Token placeable the macro acts on. */
   let token;
   if (tokenUuid !== undefined) {
      /** @type {{ object: object | null }} The resolved token data, whose `object` is its canvas placeable. */
      const tokenDocument = await resolveAs('tokenUuid', tokenUuid, 'Token', 'a');
      // The placeable exists only while the token's scene is the one this client views.
      if (tokenDocument.object === null || tokenDocument.object === undefined) {
         throw new ScriptError(
            'ARGS_INVALID',
            `tokenUuid '${cleanForLog(tokenUuid, SHOWN_MAX_BYTES)}' is not on the scene this client views; a macro ` +
               'acts on a token placed on the canvas.',
         );
      }
      token = tokenDocument.object;
   }
   /** @type {object} The speaker a chat macro speaks as; Foundry computes the same one for a script macro. */
   const speaker = foundry.documents.ChatMessage.implementation.getSpeaker({
      actor,
      token,
   });
   return {
      speaker,
      actor,
      token,
   };
}

/**
 * Turn a macro's value into plain JSON data. A serialization failure, or a result too large for the wire bound the
 * `callTool` dispatcher enforces, is reported in the result, never as an error: the macro has already run, and a
 * failure would invite the agent to run it again.
 * @param {string} type - The macro's type.
 * @param {unknown} value - The value the macro returned.
 * @returns {MacroResult} The result.
 */
function shapeValue(type, value) {
   if (value instanceof foundry.abstract.Document) {
      return {
         type,
         value: value.uuid,
      };
   }
   if (value === undefined) {
      return {
         type,
         value: null,
      };
   }
   /** @type {string | undefined} The JSON text; undefined for a value JSON has no form for (a function, a symbol). */
   let text;
   try {
      text = JSON.stringify(value);
   } catch {
      // A cycle or a BigInt.
      text = undefined;
   }
   if (text === undefined) {
      return {
         type,
         value: null,
         unserializable: true,
      };
   }
   /** @type {number} The UTF-8 bytes of the value's JSON text. */
   const bytes = utf8Bytes(text);
   /** @type {number} The UTF-8 bytes of the result around the value: `{"type":"<type>","value":}`. */
   const envelope = utf8Bytes(JSON.stringify({
      type,
      value: null,
   })) - 'null'.length;
   if (envelope + bytes > RESULT_WIRE_MAX_BYTES) {
      return {
         type,
         value: null,
         tooLarge: true,
         bytes,
      };
   }
   return {
      type,
      value: JSON.parse(text),
   };
}

/**
 * Run the macro and return its value.
 * @param {{ uuid: string, actorUuid?: string, tokenUuid?: string, timeoutMs?: number }} args - The validated
 * arguments; `timeoutMs` is the `callTool` dispatcher's time limit, not read here.
 * @param {import('~/bridge/scripts/ctx.js').ScriptContext} ctx - The call context (unused: the macro runs with
 * Foundry's own context).
 * @returns {Promise<MacroResult>} The macro's type and value.
 * @throws {ScriptError} `DOC_NOT_FOUND` or `ARGS_INVALID` before the macro runs; `MACRO_FAILED` when it does not
 * compile or throws.
 */
export async function executeMacroHandler(args, ctx) {
   /** @type {{ type: string, execute: Function }} The Macro document to run. */
   const macro = await resolveAs('uuid', args.uuid, 'Macro', 'a');
   /** @type {boolean} Whether the caller names the actor or the token the macro acts on. */
   const scoped = args.actorUuid !== undefined || args.tokenUuid !== undefined;
   /** @type {Awaited<ReturnType<typeof buildScope>> | undefined} The scope, when one is named. */
   const scope = scoped ? await buildScope(args.actorUuid, args.tokenUuid) : undefined;
   /** @type {unknown} What `execute` returned: a promise of the value, or nothing. */
   let pending;
   try {
      // `Macro#execute` builds the command's function before calling it, so a command that does not compile throws
      // synchronously here and none of it ran (client/documents/macro.mjs, `#executeScript`).
      pending = scope === undefined ? macro.execute() : macro.execute(scope);
   } catch (error) {
      throw new ScriptError(
         'MACRO_FAILED',
         `The macro did not compile; nothing ran: ${describeCause(error, CAUSE_MAX_BYTES)}`,
      );
   }
   /** @type {unknown} The value the macro returned. */
   let value;
   try {
      // An error thrown while the command runs rejects the promise, after any part before it has run.
      value = await pending;
   } catch (error) {
      throw new ScriptError(
         'MACRO_FAILED',
         `The macro threw; it may have partly run: ${describeCause(error, CAUSE_MAX_BYTES)}`,
      );
   }
   return shapeValue(macro.type, value);
}
