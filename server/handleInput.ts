import { getBudget } from '../shared/budgets.js';
import { HANDLE_STORE_MAX_BYTES, type HandleError, type HandleStore, type ReadResult } from './handles.ts';

/**
 * A reference to a stored result inside a text argument: `handle:` and the 22-character id the store issued. A
 * definition lists the arguments (`handleArgs`) in which a text of this exact form is replaced, before the call
 * reaches the Foundry client, by the text the handle holds. The pattern is anchored, so a document that merely
 * contains such text is never taken for a reference.
 */
export const HANDLE_REFERENCE_PATTERN: RegExp = /^handle:[A-Za-z0-9_-]{22}$/;

/** The outcome of resolving the handle references of a call's arguments. */
export type HandleInputOutcome =
   | {
        ok: true;
        /** The arguments, with every reference replaced by the text it names. */
        args: Record<string, unknown>;
     }
   | {
        ok: false;
        error: HandleError;
     };

// The prefix of a reference, before the handle id.
const REFERENCE_PREFIX: string = 'handle:';

/**
 * Build a failed outcome.
 * @param {string} code - The error code.
 * @param {string} message - The message; it never carries stored text.
 * @returns {HandleInputOutcome} The failure.
 */
function failed(code: string, message: string): HandleInputOutcome {
   return {
      ok: false,
      error: {
         code,
         message,
      },
   };
}

/**
 * The refusal text of a call whose texts pass the per-call bound.
 * @param {number} totalMax - The bound, in bytes.
 * @returns {string} The message; it never carries stored text.
 */
function tooLargeMessage(totalMax: number): string {
   return `The data of one call may not pass ${totalMax} bytes in all, the most the handle store holds.`;
}

/**
 * Tell whether a stored text is one JSON object, the text of one document.
 * @param {string} text - The stored text.
 * @returns {boolean} True when it parses to a non-null, non-array object.
 */
function isDocumentText(text: string): boolean {
   try {
      // The parsed text.
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
   } catch {
      return false;
   }
}

/**
 * Replace the handle references in the text arguments a tool names with the texts the handles hold. The sidecar does
 * this before the call is sent to the Foundry client, so the client receives ordinary arguments and still judges them
 * (gates, write guard, validation) exactly as it judges inline ones; the handle store never leaves the sidecar.
 *
 * Only the owner session can resolve a handle; an unknown, expired or foreign handle is the same
 * `HANDLE_NOT_FOUND`. A text that is not one JSON object is refused (`HANDLE_NOT_DOCUMENT`): the arguments that take
 * handles carry the JSON text of one document each. A stored text of any size the store holds may be used (at most
 * `HANDLE_ENTRY_MAX_BYTES`); the client warns about a call past its best-practice data size. All the texts of the
 * named arguments, inline ones included, may not pass `HANDLE_STORE_MAX_BYTES` in all (`HANDLE_TOO_LARGE`): naming
 * every stored text once always fits, and the bound stops a call that repeats one reference from building an
 * argument far larger than the store in the sidecar's memory.
 * @param {HandleStore} store - The handle store of the sessions.
 * @param {string} ownerKey - The session that makes the call, the only owner whose handles it may use.
 * @param {Record<string, unknown>} args - The validated arguments; not changed.
 * @param {readonly string[]} handleArgs - The names of the arguments that may carry references.
 * @returns {HandleInputOutcome} The arguments with the references replaced, or the first failure.
 */
export function resolveHandleArgs(
   store: HandleStore,
   ownerKey: string,
   args: Record<string, unknown>,
   handleArgs: readonly string[],
): HandleInputOutcome {
   // The names that hold a text or a list of texts in this call, with whether the value was a list.
   const present: Array<{ name: string; list: boolean; texts: unknown[] }> = [];
   for (const name of handleArgs) {
      // The own value of the argument.
      const value: unknown = Object.hasOwn(args, name) ? args[name] : undefined;
      if (typeof value === 'string') {
         present.push({
            name,
            list: false,
            texts: [value],
         });
      } else if (Array.isArray(value)) {
         present.push({
            name,
            list: true,
            texts: value,
         });
      }
   }
   // Whether any text is a reference; a call with none is passed on as it is.
   const hasReference: boolean = present.some((entry) =>
      entry.texts.some((text) => typeof text === 'string' && HANDLE_REFERENCE_PATTERN.test(text)),
   );
   if (!hasReference) {
      return {
         ok: true,
         args,
      };
   }
   // The bytes all the texts of the named arguments may take in all.
   const totalMax: number = HANDLE_STORE_MAX_BYTES;
   // The largest stored text, so a read never refuses an entry the store holds.
   const entryMax: number = getBudget('HANDLE_ENTRY_MAX_BYTES').value;
   // The bytes the call's texts take so far.
   let total: number = 0;
   for (const entry of present) {
      for (const text of entry.texts) {
         if (typeof text === 'string' && !HANDLE_REFERENCE_PATTERN.test(text)) {
            total += Buffer.byteLength(text, 'utf8');
         }
      }
   }
   if (total > totalMax) {
      return failed('HANDLE_TOO_LARGE', tooLargeMessage(totalMax));
   }
   // The arguments being built.
   const resolved: Record<string, unknown> = { ...args };
   for (const entry of present) {
      // The texts of this argument after replacement.
      const texts: unknown[] = [];
      for (const text of entry.texts) {
         if (typeof text !== 'string' || !HANDLE_REFERENCE_PATTERN.test(text)) {
            texts.push(text);
            continue;
         }
         // The whole stored text.
         const read: ReadResult = store.read(ownerKey, text.slice(REFERENCE_PREFIX.length), entryMax);
         if (!read.ok) {
            return read;
         }
         total += read.bytes;
         if (total > totalMax) {
            return failed('HANDLE_TOO_LARGE', tooLargeMessage(totalMax));
         }
         if (!isDocumentText(read.text)) {
            return failed(
               'HANDLE_NOT_DOCUMENT',
               'The handle does not hold one JSON object. Use a handle from a full read of one document.',
            );
         }
         texts.push(read.text);
      }
      resolved[entry.name] = entry.list ? texts : texts[0];
   }
   return {
      ok: true,
      args: resolved,
   };
}
