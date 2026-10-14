// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { getBudget } from '../../shared/budgets.js';
import { SCHEMA_BOUND_MAX } from '../../shared/schemaValidate.js';
import { createHandleStore, HANDLE_IDLE_MS } from '../../server/handles.ts';
import { HANDLE_REFERENCE_PATTERN, resolveHandleArgs } from '../../server/handleInput.ts';

/** @type {string} The owner key of the session that stored the handles. */
const OWNER = 'owner-a';

/** @type {string} The owner key of another session. */
const OTHER = 'owner-b';

/**
 * Create a store with a controllable clock.
 * @returns {{ store: ReturnType<typeof createHandleStore>, advance: (ms: number) => void }} The store and a mover.
 */
function makeStore() {
   /** @type {number} The fake clock value in milliseconds. */
   let nowMs = 1000;
   return {
      store: createHandleStore({ now: () => nowMs }),
      advance: (ms) => {
         nowMs += ms;
      },
   };
}

/**
 * Store a text for the owner and return the reference to it.
 * @param {ReturnType<typeof createHandleStore>} store - The store that holds the text.
 * @param {string} text - The text to store.
 * @param {string} [owner] - The owner key.
 * @returns {string} The `handle:<id>` reference.
 * @throws {Error} When the store refuses the text.
 */
function reference(store, text, owner = OWNER) {
   const stored = store.put(owner, text);
   if (!stored.ok) {
      throw new Error(stored.error.message);
   }
   return `handle:${stored.handle}`;
}

/** @type {string} One document as JSON object text. */
const DOCUMENT = '{"name":"MOCK_actor","type":"npc"}';

describe('HANDLE_REFERENCE_PATTERN', () => {
   it('matches a reference to a handle id and nothing else', () => {
      const { store } = makeStore();
      expect(HANDLE_REFERENCE_PATTERN.test(reference(store, DOCUMENT))).toBe(true);
      for (const text of [
         DOCUMENT,
         'handle:short',
         'handle:',
         ` ${reference(store, DOCUMENT)}`,
         `${reference(store, DOCUMENT)} `,
         `${reference(store, DOCUMENT)}\n`,
         `x${reference(store, DOCUMENT)}`,
      ]) {
         expect(HANDLE_REFERENCE_PATTERN.test(text), text).toBe(false);
      }
   });
});

describe('resolveHandleArgs', () => {
   it('returns the arguments unchanged when the tool names no handle argument', () => {
      const { store } = makeStore();
      const args = { data: [reference(store, DOCUMENT)] };
      expect(resolveHandleArgs(store, OWNER, args, [])).toEqual({
         ok: true,
         args,
      });
   });

   it('replaces a reference inside a list with the stored text and keeps inline texts and other arguments', () => {
      const { store } = makeStore();
      const args = {
         documentName: 'Actor',
         data: [
            reference(store, DOCUMENT),
            '{"name":"MOCK_inline","type":"npc"}',
         ],
         dryRun: true,
      };
      const copy = structuredClone(args);
      expect(resolveHandleArgs(store, OWNER, args, ['data'])).toEqual({
         ok: true,
         args: {
            documentName: 'Actor',
            data: [
               DOCUMENT,
               '{"name":"MOCK_inline","type":"npc"}',
            ],
            dryRun: true,
         },
      });
      expect(args).toEqual(copy);
   });

   it('replaces a reference given as a single text', () => {
      const { store } = makeStore();
      const outcome = resolveHandleArgs(
         store,
         OWNER,
         {
            uuid: 'Actor.X',
            data: reference(store, DOCUMENT),
         },
         ['data'],
      );
      expect(outcome).toEqual({
         ok: true,
         args: {
            uuid: 'Actor.X',
            data: DOCUMENT,
         },
      });
   });

   it('leaves a reference in an argument the tool does not name, and text that only looks like one', () => {
      const { store } = makeStore();
      const ref = reference(store, DOCUMENT);
      const args = {
         parentUuid: ref,
         data: [
            'handle:short',
            `${ref} `,
         ],
      };
      expect(resolveHandleArgs(store, OWNER, args, ['data'])).toEqual({
         ok: true,
         args,
      });
   });

   it('resolves a live handle of the calling session', () => {
      const { store } = makeStore();
      const outcome = resolveHandleArgs(store, OWNER, { data: [reference(store, DOCUMENT)] }, ['data']);
      expect(outcome.ok).toBe(true);
      expect(outcome.args.data).toEqual([DOCUMENT]);
   });

   it('refuses the live handle of another session as not found, and does not read it', () => {
      const { store } = makeStore();
      const theirs = reference(store, DOCUMENT, OTHER);
      const outcome = resolveHandleArgs(store, OWNER, { data: [theirs] }, ['data']);
      expect(outcome.ok).toBe(false);
      expect(outcome.error.code).toBe('HANDLE_NOT_FOUND');
      // The owner still reads it: the refused read did not consume or move it.
      expect(resolveHandleArgs(store, OTHER, { data: [theirs] }, ['data']).ok).toBe(true);
   });

   it('refuses an unknown handle id as not found', () => {
      const { store } = makeStore();
      const unknown = `handle:${'A'.repeat(22)}`;
      const outcome = resolveHandleArgs(store, OWNER, { data: [unknown] }, ['data']);
      expect(outcome.ok).toBe(false);
      expect(outcome.error.code).toBe('HANDLE_NOT_FOUND');
   });

   it('refuses an expired handle of the calling session as not found', () => {
      const { store, advance } = makeStore();
      const mine = reference(store, DOCUMENT);
      advance(HANDLE_IDLE_MS + 1);
      const outcome = resolveHandleArgs(store, OWNER, { data: [mine] }, ['data']);
      expect(outcome.ok).toBe(false);
      expect(outcome.error.code).toBe('HANDLE_NOT_FOUND');
   });

   it('refuses a stored text over the per-argument bound without reading it', () => {
      const { store } = makeStore();
      const big = `{"name":"${'a'.repeat(SCHEMA_BOUND_MAX)}"}`;
      const outcome = resolveHandleArgs(store, OWNER, { data: [reference(store, big)] }, ['data']);
      expect(outcome.ok).toBe(false);
      expect(outcome.error.code).toBe('HANDLE_TOO_LARGE');
      expect(outcome.error.message).toContain(String(SCHEMA_BOUND_MAX));
   });

   it('refuses handles whose texts together pass the data bound', () => {
      const { store } = makeStore();
      /** @type {string} A document of about 90,000 bytes. */
      const big = `{"name":"${'a'.repeat(90_000)}"}`;
      /** @type {number} The data bound of one call. */
      const bound = getBudget('WRITE_DATA_MAX_BYTES').value;
      expect(bound).toBeLessThan(3 * big.length);
      const outcome = resolveHandleArgs(
         store,
         OWNER,
         {
            data: [
               reference(store, big),
               reference(store, big),
               reference(store, big),
            ],
         },
         ['data'],
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.error.code).toBe('HANDLE_TOO_LARGE');
      expect(outcome.error.message).toContain(String(bound));
   });

   it('counts inline texts against the same total', () => {
      const { store } = makeStore();
      /** @type {string} A document of about 90,000 bytes. */
      const big = `{"name":"${'a'.repeat(90_000)}"}`;
      const outcome = resolveHandleArgs(
         store,
         OWNER,
         {
            data: [
               big,
               big,
               reference(store, big),
            ],
         },
         ['data'],
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.error.code).toBe('HANDLE_TOO_LARGE');
   });

   it('refuses a stored text that is not one JSON object, with a code of its own', () => {
      const { store } = makeStore();
      for (const text of [
         '[{"name":"MOCK_a"}]',
         'not json',
         '"a string"',
         '42',
         'null',
         '',
      ]) {
         const outcome = resolveHandleArgs(store, OWNER, { data: [reference(store, text)] }, ['data']);
         expect(outcome.ok, text).toBe(false);
         expect(outcome.error.code, text).toBe('HANDLE_NOT_DOCUMENT');
      }
   });

   it('keeps every error within 256 bytes and free of the stored text', () => {
      const { store } = makeStore();
      const outcome = resolveHandleArgs(store, OWNER, { data: [reference(store, 'MOCK_secret_text')] }, ['data']);
      expect(outcome.ok).toBe(false);
      expect(new TextEncoder().encode(outcome.error.message).length).toBeLessThanOrEqual(256);
      expect(outcome.error.message).not.toContain('MOCK_secret_text');
   });

   it('reads each handle through a bounded whole-entry read', () => {
      const { store } = makeStore();
      const spy = vi.spyOn(store, 'read');
      resolveHandleArgs(store, OWNER, { data: [reference(store, DOCUMENT)] }, ['data']);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][2]).toBeLessThanOrEqual(SCHEMA_BOUND_MAX);
   });
});
