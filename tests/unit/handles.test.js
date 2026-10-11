// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi } from 'vitest';
import {
   boundedStringify,
   createHandleStore,
   HANDLE_ENTRY_OVERHEAD_BYTES,
   HANDLE_IDLE_MS,
   HANDLE_STORE_MAX_BYTES,
} from '../../server/handles.ts';

/** @type {string} The owner key of the first synthetic session. */
const OWNER_A = 'owner-a';

/** @type {string} The owner key of the second synthetic session. */
const OWNER_B = 'owner-b';

/** @type {string} The directory holding the server sources, resolved from this file rather than the cwd. */
const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server');

/**
 * Create a store with a controllable clock.
 * @param {object} [options] - Store options forwarded to `createHandleStore`.
 * @returns {{ store: ReturnType<typeof createHandleStore>, advance: (ms: number) => void }} The store and a mover.
 */
function makeStore(options = {}) {
   /** @type {number} The fake clock value in milliseconds. */
   let nowMs = 1000;
   return {
      store: createHandleStore({
         now: () => nowMs,
         ...options,
      }),
      advance: (ms) => {
         nowMs += ms;
      },
   };
}

/**
 * Store a value and return its handle, failing the test when the store refuses it.
 * @param {ReturnType<typeof createHandleStore>} store - The store that receives the text.
 * @param {string} owner - The owner key.
 * @param {string} text - The text to store.
 * @returns {string} The handle.
 */
function putOk(store, owner, text) {
   /** @type {ReturnType<ReturnType<typeof createHandleStore>['put']>} The put result. */
   const result = store.put(owner, text);
   expect(result.ok).toBe(true);
   return result.handle;
}

/**
 * The bytes the store accounts for one entry: the larger of its UTF-8 size and its UTF-16 memory size, plus overhead.
 * @param {string} text - The stored text.
 * @returns {number} The accounted bytes.
 */
function cost(text) {
   return Math.max(Buffer.byteLength(text, 'utf8'), 2 * text.length) + HANDLE_ENTRY_OVERHEAD_BYTES;
}

describe('defaults', () => {
   it('uses 64 MB total (1 MB = 1,000,000 bytes) and 30 minutes idle', () => {
      expect(HANDLE_STORE_MAX_BYTES).toBe(64_000_000);
      expect(HANDLE_IDLE_MS).toBe(30 * 60 * 1000);
      expect(HANDLE_ENTRY_OVERHEAD_BYTES).toBe(256);
   });

   it('measures idle time on a monotonic clock, not the wall clock', () => {
      /** @type {number} The wall-clock reading, which jumps one day on every call. */
      let wall = 0;
      const dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
         wall += 86_400_000;
         return wall;
      });
      try {
         const store = createHandleStore();
         const handle = putOk(store, OWNER_A, 'a');
         expect(store.slice(OWNER_A, handle).ok).toBe(true);
      } finally {
         dateSpy.mockRestore();
      }
   });

   it('reads performance.now() as the default clock', () => {
      /** @type {number} The monotonic reading the spy returns. */
      let monotonic = 5;
      const spy = vi.spyOn(performance, 'now').mockImplementation(() => monotonic);
      try {
         const store = createHandleStore({ idleMs: 1000 });
         const handle = putOk(store, OWNER_A, 'a');
         monotonic = 1004;
         expect(store.slice(OWNER_A, handle).ok).toBe(true);
         monotonic = 5000;
         expect(store.slice(OWNER_A, handle).ok).toBe(false);
      } finally {
         spy.mockRestore();
      }
   });
});

describe('put', () => {
   it('returns an opaque 22-character base64url id and the UTF-8 byte size', () => {
      const { store } = makeStore();
      const result = store.put(OWNER_A, 'é€');
      expect(result.ok).toBe(true);
      expect(result.handle).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(result.bytes).toBe(5);
   });

   it('never repeats an id', () => {
      const { store } = makeStore();
      const ids = new Set();
      for (let index = 0; index < 500; index++) {
         ids.add(putOk(store, OWNER_A, 'x'));
      }
      expect(ids.size).toBe(500);
   });

   it('accounts each entry as the larger of its UTF-8 and UTF-16 bytes plus 256 bytes of overhead', () => {
      const { store } = makeStore();
      putOk(store, OWNER_A, 'a');
      putOk(store, OWNER_A, '€€');
      putOk(store, OWNER_A, 'b'.repeat(1000));
      expect(store.stats()).toEqual({
         entries: 3,
         bytes: 2 + 256 + 6 + 256 + 2000 + 256,
      });
   });

   it('refuses a value larger than the whole store and keeps what is stored', () => {
      const kept = 'a'.repeat(60);
      const { store } = makeStore({ maxTotalBytes: 1000 });
      const keptHandle = putOk(store, OWNER_A, kept);
      const result = store.put(OWNER_A, 'b'.repeat(400));
      expect(cost('b'.repeat(400))).toBe(1056);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('HANDLE_TOO_LARGE');
      expect(Buffer.byteLength(result.error.message, 'utf8')).toBeLessThanOrEqual(128);
      expect(store.slice(OWNER_A, keptHandle).ok).toBe(true);
      expect(store.stats()).toEqual({
         entries: 1,
         bytes: cost(kept),
      });
   });

   it('accepts an entry of exactly 8,000,000 bytes and refuses 8,000,001 with HANDLE_TOO_LARGE', () => {
      const { store } = makeStore();
      const result = store.put(OWNER_A, 'a'.repeat(8_000_001));
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('HANDLE_TOO_LARGE');
      expect(Buffer.byteLength(result.error.message, 'utf8')).toBeLessThanOrEqual(128);
      expect(store.stats().entries).toBe(0);
      const exact = store.put(OWNER_A, 'a'.repeat(8_000_000));
      expect(exact.ok).toBe(true);
      expect(exact.bytes).toBe(8_000_000);
   });

   it('measures the entry cap in UTF-8 bytes, not characters', () => {
      const { store } = makeStore();
      expect(store.put(OWNER_A, '€'.repeat(2_666_667)).ok).toBe(false);
      expect(store.put(OWNER_A, '€'.repeat(2_666_666)).ok).toBe(true);
   });

   it('holds at most 1,024 handles and evicts the least recently used beyond that', () => {
      const { store } = makeStore();
      /** @type {string[]} The handles in storage order. */
      const handles = [];
      for (let index = 0; index < 1024; index++) {
         handles.push(putOk(store, OWNER_A, 'x'));
      }
      expect(store.stats().entries).toBe(1024);
      expect(store.slice(OWNER_A, handles[0]).ok).toBe(true);
      putOk(store, OWNER_A, 'y');
      expect(store.stats().entries).toBe(1024);
      expect(store.slice(OWNER_A, handles[0]).ok).toBe(true);
      expect(store.slice(OWNER_A, handles[1]).ok).toBe(false);
   });
});

describe('slice window', () => {
   it('returns the whole text with offset 0 and its length and total', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'hello world');
      expect(store.slice(OWNER_A, handle)).toEqual({
         ok: true,
         text: 'hello world',
         offset: 0,
         length: 11,
         total: 11,
      });
   });

   it('returns the requested offset and length', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'hello world');
      expect(
         store.slice(OWNER_A, handle, {
            offset: 6,
            length: 3,
         }),
      ).toEqual({
         ok: true,
         text: 'wor',
         offset: 6,
         length: 3,
         total: 11,
      });
   });

   it('clips a length past the end and returns empty text at offset == total', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'hello');
      expect(
         store.slice(OWNER_A, handle, {
            offset: 3,
            length: 100,
         }).text,
      ).toBe('lo');
      const atEnd = store.slice(OWNER_A, handle, { offset: 5 });
      expect(atEnd.ok).toBe(true);
      expect(atEnd.text).toBe('');
   });

   it.each([
      [
         'an offset past the end',
         { offset: 6 },
      ],
      [
         'a negative offset',
         { offset: -1 },
      ],
      [
         'a fractional offset',
         { offset: 1.5 },
      ],
      [
         'a zero length',
         { length: 0 },
      ],
      [
         'a fractional length',
         { length: 2.5 },
      ],
      [
         'a non-numeric offset',
         { offset: '1' },
      ],
   ])('refuses %s with HANDLE_BAD_RANGE', (_label, options) => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'hello');
      const result = store.slice(OWNER_A, handle, options);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('HANDLE_BAD_RANGE');
      expect(Buffer.byteLength(result.error.message, 'utf8')).toBeLessThanOrEqual(128);
   });

   it('bounds the returned text to maxBytes and reports the shorter length', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'a'.repeat(100_000));
      const result = store.slice(OWNER_A, handle, { maxBytes: 1000 });
      expect(result.ok).toBe(true);
      expect(Buffer.byteLength(result.text, 'utf8')).toBe(1000);
      expect(result.length).toBe(1000);
      expect(result.total).toBe(100_000);
   });

   it('bounds by UTF-8 bytes, not characters', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, '€'.repeat(5000));
      const result = store.slice(OWNER_A, handle, { maxBytes: 1000 });
      expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(1000);
      expect(result.length).toBe(333);
      expect(result.text).toBe('€'.repeat(333));
   });

   it('never ends a window inside a surrogate pair', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, '😀'.repeat(100));
      const result = store.slice(OWNER_A, handle, { maxBytes: 10 });
      expect(result.text).toBe('😀😀');
      expect(result.length).toBe(4);
   });

   it('ends a requested length before a pair it would split when the byte bound allows the pair', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, '😀😀');
      expect(
         store.slice(OWNER_A, handle, {
            length: 3,
            maxBytes: 100,
         }),
      ).toEqual({
         ok: true,
         text: '😀',
         offset: 0,
         length: 2,
         total: 4,
      });
   });

   it('returns the whole pair for length 1 at a high surrogate so the read makes progress', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'a😀b');
      expect(
         store.slice(OWNER_A, handle, {
            offset: 1,
            length: 1,
            maxBytes: 100,
         }),
      ).toEqual({
         ok: true,
         text: '😀',
         offset: 1,
         length: 2,
         total: 4,
      });
   });

   it('pages a surrogate-heavy text with length 1 without gaps, overlap or a stall', () => {
      const { store } = makeStore();
      /** @type {string} The stored text. */
      const text = 'a😀b😀😀c';
      const handle = putOk(store, OWNER_A, text);
      /** @type {string} The reassembled text. */
      let joined = '';
      let offset = 0;
      while (offset < text.length) {
         const result = store.slice(OWNER_A, handle, {
            offset,
            length: 1,
            maxBytes: 100,
         });
         expect(result.ok).toBe(true);
         expect(result.length).toBeGreaterThan(0);
         joined += result.text;
         offset += result.length;
      }
      expect(joined).toBe(text);
   });

   it.each([
      [
         'a pair that does not fit',
         '😀',
         3,
      ],
      [
         'a three-byte character that does not fit',
         '€',
         2,
      ],
      [
         'a zero byte bound',
         'a',
         0,
      ],
   ])('answers %s with HANDLE_WINDOW_TOO_SMALL', (_label, text, maxBytes) => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, text);
      const result = store.slice(OWNER_A, handle, { maxBytes });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('HANDLE_WINDOW_TOO_SMALL');
      expect(Buffer.byteLength(result.error.message, 'utf8')).toBeLessThanOrEqual(128);
   });

   it('answers length 1 at a pair that does not fit maxBytes with HANDLE_WINDOW_TOO_SMALL', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, '😀');
      const result = store.slice(OWNER_A, handle, {
         length: 1,
         maxBytes: 3,
      });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('HANDLE_WINDOW_TOO_SMALL');
   });

   it('returns empty text rather than an error at the end even when maxBytes is tiny', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, '😀');
      expect(
         store.slice(OWNER_A, handle, {
            offset: 2,
            maxBytes: 1,
         }).ok,
      ).toBe(true);
   });

   it('moves an offset that lands on a low surrogate back to the pair and reports the real offset', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'a😀b');
      expect(
         store.slice(OWNER_A, handle, {
            offset: 2,
            maxBytes: 100,
         }),
      ).toEqual({
         ok: true,
         text: '😀b',
         offset: 1,
         length: 3,
         total: 4,
      });
   });

   it('defaults the bound to the 8,000-byte hard cap', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'a'.repeat(20_000));
      expect(store.slice(OWNER_A, handle).text.length).toBe(8000);
   });

   it('never exceeds 16,000 bytes even when asked for more', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'a'.repeat(40_000));
      expect(store.slice(OWNER_A, handle, { maxBytes: 99_999 }).text.length).toBe(16_000);
   });

   it('pages a long text window by window without gaps or overlap', () => {
      const { store } = makeStore();
      /** @type {string} The stored text. */
      const text = Array.from({ length: 3000 }, (_, index) => `${index},`).join('');
      const handle = putOk(store, OWNER_A, text);
      /** @type {string} The reassembled text. */
      let joined = '';
      let offset = 0;
      while (offset < text.length) {
         const result = store.slice(OWNER_A, handle, {
            offset,
            maxBytes: 1000,
         });
         joined += result.text;
         offset += result.length;
      }
      expect(joined).toBe(text);
   });
});

describe('slice paths', () => {
   /** @type {string} A synthetic document export. */
   const EXPORT = JSON.stringify({
      name: 'MOCK_ACTOR',
      system: { hp: 7 },
      items: [
         {
            _id: 'AAA',
            name: 'MOCK_ITEM_1',
         },
         {
            _id: 'BBB',
            name: 'MOCK_ITEM_2',
         },
      ],
   });

   it('resolves the document path grammar over the stored JSON', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, EXPORT);
      const result = store.slice(OWNER_A, handle, {
         paths: [
            'system.hp',
            'items.*.name',
            'nope',
         ],
      });
      expect(result.ok).toBe(true);
      expect(result.truncated).toBeUndefined();
      expect(JSON.parse(result.text)).toEqual({
         values: {
            'system.hp': 7,
            'items.*.name': {
               AAA: 'MOCK_ITEM_1',
               BBB: 'MOCK_ITEM_2',
            },
         },
         missing: ['nope'],
      });
   });

   it('caps the paths result at maxBytes units, flags it truncated and serves it as one window', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, JSON.stringify({ big: 'x'.repeat(30_000) }));
      const first = store.slice(OWNER_A, handle, { paths: ['big'] });
      expect(first.ok).toBe(true);
      expect(first.truncated).toBe(true);
      expect(Buffer.byteLength(first.text, 'utf8')).toBeLessThanOrEqual(8000);
      expect(first.total).toBe(8000);
      expect(first.text.startsWith('{"values":{"big":"xxx')).toBe(true);
      const narrow = store.slice(OWNER_A, handle, {
         paths: ['big'],
         maxBytes: 500,
      });
      expect(narrow.total).toBe(500);
      expect(narrow.text.length).toBe(500);
   });

   it('serves the truncated prefix of the exact JSON.stringify output', () => {
      const { store } = makeStore();
      /** @type {object} A nested document with arrays, escapes and astral characters. */
      const document = {
         list: Array.from({ length: 400 }, (_, index) => ({
            id: index,
            label: `L"${index}"\n😀`,
            flag: index % 2 === 0,
            none: null,
         })),
      };
      const handle = putOk(store, OWNER_A, JSON.stringify(document));
      /** @type {string} The complete paths result. */
      const full = JSON.stringify({
         values: { list: document.list },
         missing: [],
      });
      const result = store.slice(OWNER_A, handle, {
         paths: ['list'],
         maxBytes: 3000,
      });
      expect(result.truncated).toBe(true);
      expect(full.startsWith(result.text)).toBe(true);
      expect(result.text.length).toBeGreaterThan(2000);
   });

   it('does not move the idle clock when the paths read fails', () => {
      const { store, advance } = makeStore({ idleMs: 100 });
      const handle = putOk(store, OWNER_A, EXPORT);
      advance(99);
      expect(store.slice(OWNER_A, handle, { paths: ['system.__proto__.x'] }).ok).toBe(false);
      advance(1);
      expect(store.slice(OWNER_A, handle).ok).toBe(false);
   });

   it('passes a grammar error through with its PATH_ code', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, EXPORT);
      const result = store.slice(OWNER_A, handle, { paths: ['system.__proto__.x'] });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('PATH_UNSAFE_SEGMENT');
   });

   it('refuses paths over text that is not JSON with HANDLE_NOT_JSON', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'Created actor "Bob"');
      const result = store.slice(OWNER_A, handle, { paths: ['name'] });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('HANDLE_NOT_JSON');
   });
});

describe('boundedStringify', () => {
   it.each([
      [
         'scalars and nesting',
         {
            a: [
               1,
               'two',
               null,
               true,
               { b: [] },
            ],
            c: {},
            d: -0.5,
         },
      ],
      [
         'escapes and astral characters',
         {
            text: 'quote " backslash \\ newline \n tab \t emoji 😀 euro €',
            'key with "quotes"': ['\u0001'],
         },
      ],
      [
         'an empty object',
         {},
      ],
      [
         'a bare string',
         'plain',
      ],
   ])('matches JSON.stringify exactly when the limit is not reached: %s', (_label, value) => {
      expect(boundedStringify(value, 1_000_000)).toEqual({
         text: JSON.stringify(value),
         truncated: false,
      });
   });

   it('returns exactly the first maxUnits units of the output and flags the cut', () => {
      /** @type {object} A document longer than the limit. */
      const value = { rows: Array.from({ length: 200 }, (_, index) => ({ n: index })) };
      /** @type {string} The full output. */
      const full = JSON.stringify(value);
      const result = boundedStringify(value, 100);
      expect(result.truncated).toBe(true);
      expect(result.text).toBe(full.slice(0, 100));
   });

   it('does not flag a result that is exactly the limit', () => {
      const result = boundedStringify(
         [
            1,
            2,
            3,
         ],
         7,
      );
      expect(result).toEqual({
         text: '[1,2,3]',
         truncated: false,
      });
   });

   it('stops visiting elements once the limit is reached', () => {
      /** @type {number} Indexed reads of the proxied array. */
      let reads = 0;
      /** @type {number[]} A very long array. */
      const long = Array.from({ length: 1_000_000 }, (_, index) => index);
      /** @type {number[]} The array that counts element reads. */
      const counted = new Proxy(long, {
         get(target, key) {
            if (typeof key === 'string' && /^\d+$/.test(key)) {
               reads += 1;
            }
            return target[key];
         },
      });
      const result = boundedStringify({ counted }, 200);
      expect(result.truncated).toBe(true);
      expect(reads).toBeLessThan(200);
   });

   it('does not recurse, so a deeply nested value cannot overflow the stack', () => {
      /** @type {unknown} A 200,000 level nest. */
      let nested = 1;
      for (let depth = 0; depth < 200_000; depth++) {
         nested = [nested];
      }
      const result = boundedStringify(nested, 1000);
      expect(result.truncated).toBe(true);
      expect(result.text).toBe('['.repeat(1000));
   });
});

describe('unknown handles and ownership', () => {
   it.each([
      [
         'an unknown id',
         'AAAAAAAAAAAAAAAAAAAAAA',
      ],
      [
         'an empty id',
         '',
      ],
      [
         'a non-string id',
         42,
      ],
   ])('answers %s with a short HANDLE_NOT_FOUND', (_label, handle) => {
      const { store } = makeStore();
      const result = store.slice(OWNER_A, handle);
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('HANDLE_NOT_FOUND');
      expect(Buffer.byteLength(result.error.message, 'utf8')).toBeLessThanOrEqual(128);
   });

   it('refuses a read by another owner with the same answer as an unknown id', () => {
      const { store } = makeStore();
      const handle = putOk(store, OWNER_A, 'secret');
      const foreign = store.slice(OWNER_B, handle);
      const unknown = store.slice(OWNER_B, 'AAAAAAAAAAAAAAAAAAAAAA');
      expect(foreign).toEqual(unknown);
      expect(foreign.ok).toBe(false);
      expect(store.slice(OWNER_A, handle).text).toBe('secret');
   });

   it('does not refresh the idle clock on a refused cross-owner read', () => {
      const { store, advance } = makeStore({ idleMs: 100 });
      const handle = putOk(store, OWNER_A, 'secret');
      advance(99);
      expect(store.slice(OWNER_B, handle).ok).toBe(false);
      advance(1);
      expect(store.slice(OWNER_A, handle).ok).toBe(false);
   });
});

describe('idle expiry', () => {
   it('keeps a handle one millisecond before the idle limit and drops it at the limit', () => {
      const { store, advance } = makeStore({ idleMs: 1000 });
      const alive = putOk(store, OWNER_A, 'a');
      const expiring = putOk(store, OWNER_A, 'b');
      advance(999);
      expect(store.slice(OWNER_A, alive).ok).toBe(true);
      advance(1);
      expect(store.slice(OWNER_A, expiring)).toMatchObject({
         ok: false,
         error: { code: 'HANDLE_NOT_FOUND' },
      });
   });

   it('refreshes the idle clock on every read', () => {
      const { store, advance } = makeStore({ idleMs: 1000 });
      const handle = putOk(store, OWNER_A, 'a');
      for (let step = 0; step < 5; step++) {
         advance(999);
         expect(store.slice(OWNER_A, handle).ok).toBe(true);
      }
      advance(1000);
      expect(store.slice(OWNER_A, handle).ok).toBe(false);
   });

   it.each([
      [
         'a negative offset',
         { offset: -1 },
      ],
      [
         'an offset past the end',
         { offset: 99 },
      ],
      [
         'a zero length',
         { length: 0 },
      ],
      [
         'a window too small for the next character',
         { maxBytes: 0 },
      ],
      [
         'an unreadable path',
         { paths: ['__proto__'] },
      ],
   ])('does not keep a handle alive through a read with %s', (_label, options) => {
      const { store, advance } = makeStore({ idleMs: 100 });
      const handle = putOk(store, OWNER_A, '{"a":1}');
      advance(99);
      expect(store.slice(OWNER_A, handle, options).ok).toBe(false);
      advance(1);
      expect(store.slice(OWNER_A, handle).ok).toBe(false);
   });

   it('does not keep a handle alive through a paths read over text that is not JSON', () => {
      const { store, advance } = makeStore({ idleMs: 100 });
      const handle = putOk(store, OWNER_A, 'plain');
      advance(99);
      expect(store.slice(OWNER_A, handle, { paths: ['a'] }).ok).toBe(false);
      advance(1);
      expect(store.slice(OWNER_A, handle).ok).toBe(false);
   });

   it('releases the memory of expired handles on the next put', () => {
      const { store, advance } = makeStore({ idleMs: 1000 });
      putOk(store, OWNER_A, 'a'.repeat(50));
      putOk(store, OWNER_B, 'b'.repeat(50));
      advance(1000);
      putOk(store, OWNER_A, 'c');
      expect(store.stats()).toEqual({
         entries: 1,
         bytes: cost('c'),
      });
   });

   it('keeps a recently read handle that sits after expired ones, so purging stops at the first live entry', () => {
      const { store, advance } = makeStore({ idleMs: 1000 });
      const first = putOk(store, OWNER_A, 'a');
      putOk(store, OWNER_A, 'b');
      putOk(store, OWNER_A, 'c');
      advance(600);
      expect(store.slice(OWNER_A, first).ok).toBe(true);
      advance(500);
      putOk(store, OWNER_A, 'd');
      expect(store.stats().entries).toBe(2);
      expect(store.slice(OWNER_A, first).ok).toBe(true);
   });

   it('expires after 30 minutes by default', () => {
      const { store, advance } = makeStore();
      const handle = putOk(store, OWNER_A, 'a');
      advance(30 * 60 * 1000 - 1);
      expect(store.slice(OWNER_A, handle).ok).toBe(true);
      advance(30 * 60 * 1000);
      expect(store.slice(OWNER_A, handle).ok).toBe(false);
   });
});

describe('size eviction', () => {
   /** @type {string} A 40-character text; the store capacities below are multiples of its accounted size. */
   const TEXT_A = 'a'.repeat(40);
   /** @type {string} The second 40-character text. */
   const TEXT_B = 'b'.repeat(40);
   /** @type {string} The third 40-character text. */
   const TEXT_C = 'c'.repeat(40);
   /** @type {string} The fourth 40-character text. */
   const TEXT_D = 'd'.repeat(40);
   /** @type {number} A capacity of exactly two such entries. */
   const TWO = 2 * cost(TEXT_A);

   it('evicts the least recently used handle until the new value fits', () => {
      const { store } = makeStore({ maxTotalBytes: TWO });
      const first = putOk(store, OWNER_A, TEXT_A);
      const second = putOk(store, OWNER_A, TEXT_B);
      putOk(store, OWNER_A, TEXT_C);
      expect(store.slice(OWNER_A, first).ok).toBe(false);
      expect(store.slice(OWNER_A, second).ok).toBe(true);
      expect(store.stats()).toEqual({
         entries: 2,
         bytes: TWO,
      });
   });

   it('counts a read as use, so the untouched handle is evicted instead', () => {
      const { store } = makeStore({ maxTotalBytes: TWO });
      const first = putOk(store, OWNER_A, TEXT_A);
      const second = putOk(store, OWNER_A, TEXT_B);
      expect(store.slice(OWNER_A, first).ok).toBe(true);
      putOk(store, OWNER_A, TEXT_C);
      expect(store.slice(OWNER_A, first).ok).toBe(true);
      expect(store.slice(OWNER_A, second).ok).toBe(false);
   });

   it('orders eviction by last use across several handles', () => {
      const { store } = makeStore({ maxTotalBytes: 3 * cost(TEXT_A) });
      const first = putOk(store, OWNER_A, TEXT_A);
      const second = putOk(store, OWNER_A, TEXT_B);
      const third = putOk(store, OWNER_A, TEXT_C);
      expect(store.slice(OWNER_A, second).ok).toBe(true);
      expect(store.slice(OWNER_A, first).ok).toBe(true);
      const fourth = putOk(store, OWNER_A, TEXT_D);
      expect(store.slice(OWNER_A, third).ok).toBe(false);
      const fifth = putOk(store, OWNER_A, 'e'.repeat(40));
      expect(store.slice(OWNER_A, second).ok).toBe(false);
      expect(store.slice(OWNER_A, first).ok).toBe(true);
      expect(store.slice(OWNER_A, fourth).ok).toBe(true);
      expect(store.slice(OWNER_A, fifth).ok).toBe(true);
   });

   it('accepts a value that exactly fills the store and evicts it for one that overflows by a byte', () => {
      const { store } = makeStore({ maxTotalBytes: cost(TEXT_A) });
      const exact = putOk(store, OWNER_A, TEXT_A);
      expect(store.slice(OWNER_A, exact).ok).toBe(true);
      putOk(store, OWNER_A, 'b');
      expect(store.slice(OWNER_A, exact).ok).toBe(false);
   });

   it("shares one total across owners: a put by one owner can evict another owner's oldest handle", () => {
      const { store } = makeStore({ maxTotalBytes: cost(TEXT_A) });
      const other = putOk(store, OWNER_B, TEXT_A);
      putOk(store, OWNER_A, TEXT_B);
      expect(store.slice(OWNER_B, other).ok).toBe(false);
   });
});

describe('memory only', () => {
   /** @type {RegExp} A quoted module specifier naming the file system, child processes or workers. */
   const FORBIDDEN_MODULE = /['"`](?:node:)?(?:fs|child_process|worker_threads|cluster)(?:\/[a-z]+)?['"`]/;
   /** @type {RegExp} A call that writes to, renames or deletes from the file system. */
   const FORBIDDEN_CALL = new RegExp(
      `\\b(?:${[
         'unlink',
         'unlinkSync',
         'rm',
         'rmSync',
         'rmdir',
         'rmdirSync',
         'writeFile',
         'writeFileSync',
         'appendFile',
         'appendFileSync',
         'truncate',
         'truncateSync',
         'rename',
         'renameSync',
      ].join('|')})\\s*\\(`,
   );

   it.each([
      'handles.ts',
      'resultBudget.ts',
      'utf8.ts',
   ])('%s imports no file-system module and calls no write or delete API', (file) => {
      /** @type {string} The module source. */
      const source = fs.readFileSync(path.join(SERVER_DIR, file), 'utf8');
      expect(source).not.toMatch(FORBIDDEN_MODULE);
      expect(source).not.toMatch(FORBIDDEN_CALL);
      expect(source).not.toMatch(/\brequire\s*\(|\bimport\s*\(/);
   });
});
