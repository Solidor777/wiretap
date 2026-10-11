// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { BridgeError } from '../../server/endpoints.ts';
import { createHandleStore } from '../../server/handles.ts';
import { summarizeResult, withResultBudget } from '../../server/resultBudget.ts';

/** @type {string} The owner key used by the synthetic session. */
const OWNER = 'owner-a';

/**
 * Build a text tool result.
 * @param {string} text - The text of the single content item.
 * @returns {{ content: { type: 'text', text: string }[] }} The one-item text result.
 */
function textResult(text) {
   return {
      content: [
         {
            type: 'text',
            text,
         },
      ],
   };
}

/**
 * Wrap a handler that returns the given result and run it once.
 * @param {object} result - The result the handler returns.
 * @param {object} [args] - The tool arguments.
 * @param {object} [options] - Extra enforcer options (`budgetBytes`, `store`).
 * @returns {Promise<{ out: object, store: ReturnType<typeof createHandleStore> }>} The enforced result and the store.
 */
async function enforce(result, args = {}, options = {}) {
   /** @type {ReturnType<typeof createHandleStore>} The store receiving large results. */
   const store = options.store ?? createHandleStore();
   /** @type {Function} The wrapped handler. */
   const wrapped = withResultBudget(async () => result, {
      store,
      ownerKey: OWNER,
      budgetBytes: options.budgetBytes,
   });
   return {
      out: await wrapped(args),
      store,
   };
}

/**
 * Build a base64 PNG consisting of the signature and an IHDR chunk with the given size.
 * @param {number} width - The image width.
 * @param {number} height - The image height.
 * @returns {string} The base64 text.
 */
function pngHeader(width, height) {
   /** @type {Buffer} The 33 header bytes. */
   const bytes = Buffer.alloc(33);
   Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
   bytes.writeUInt32BE(13, 8);
   bytes.write('IHDR', 12, 'ascii');
   bytes.writeUInt32BE(width, 16);
   bytes.writeUInt32BE(height, 20);
   return bytes.toString('base64');
}

/**
 * A synthetic actor export with 120 obviously fake embedded items, serialized.
 * @returns {string} The JSON text, well over 8,000 bytes.
 */
function bigActorJson() {
   return JSON.stringify({
      name: 'MOCK_ACTOR',
      type: 'MOCK_TYPE',
      system: { note: 'x'.repeat(2000) },
      items: Array.from({ length: 120 }, (_, index) => ({
         _id: `MOCKID${index}`,
         name: `MOCK_ITEM_${index}`,
         system: { description: 'y'.repeat(800) },
      })),
   });
}

describe('threshold', () => {
   it.each([
      [
         'one under the cap',
         7999,
         false,
      ],
      [
         'exactly the cap',
         8000,
         false,
      ],
      [
         'one over the cap',
         8001,
         true,
      ],
   ])('treats text %s as %s: handle=%s', async (_label, size, expectHandle) => {
      const { out } = await enforce(textResult('a'.repeat(size)));
      if (expectHandle) {
         expect(JSON.parse(out.content[0].text)).toHaveProperty('handle');
      } else {
         expect(out.content[0].text).toBe('a'.repeat(size));
      }
   });

   it('measures UTF-8 bytes, not characters', async () => {
      const { out } = await enforce(textResult('€'.repeat(2667)));
      expect(JSON.parse(out.content[0].text).bytes).toBe(8001);
      const inline = await enforce(textResult('€'.repeat(2666)));
      expect(inline.out.content[0].text).toBe('€'.repeat(2666));
   });

   it.each([
      [
         'equal to a per-tool budget of 256',
         256,
         false,
      ],
      [
         'one over a per-tool budget of 256',
         257,
         true,
      ],
   ])('applies a per-tool budget: %s', async (_label, size, expectHandle) => {
      const { out } = await enforce(textResult('a'.repeat(size)), {}, { budgetBytes: 256 });
      expect(out.content[0].text.startsWith('{"handle"')).toBe(expectHandle);
   });

   it('keeps the smaller of the per-tool budget and the per-call maxBytes', async () => {
      const { out } = await enforce(textResult('a'.repeat(300)), { maxBytes: 1000 }, { budgetBytes: 256 });
      expect(out.content[0].text.startsWith('{"handle"')).toBe(true);
   });

   it.each([
      [
         'maxBytes 100: 100 bytes',
         100,
         100,
         false,
      ],
      [
         'maxBytes 100: 101 bytes',
         100,
         101,
         true,
      ],
      [
         'maxBytes 16000: 16000 bytes',
         16000,
         16000,
         false,
      ],
      [
         'maxBytes 16000: 16001 bytes',
         16000,
         16001,
         true,
      ],
      [
         'maxBytes 99999 clamps to 16000: 16001 bytes',
         99999,
         16001,
         true,
      ],
      [
         'maxBytes 99999 clamps to 16000: 16000 bytes',
         99999,
         16000,
         false,
      ],
   ])('honours a per-call %s', async (_label, maxBytes, size, expectHandle) => {
      const { out } = await enforce(textResult('a'.repeat(size)), { maxBytes });
      expect(out.content[0].text.startsWith('{"handle"')).toBe(expectHandle);
   });

   it.each([
      0,
      -5,
      1.5,
      '9000',
      Number.NaN,
      null,
      {},
   ])('ignores the invalid maxBytes %j and keeps 8,000', async (maxBytes) => {
      const inline = await enforce(textResult('a'.repeat(8000)), { maxBytes });
      expect(inline.out.content[0].text).toBe('a'.repeat(8000));
      const over = await enforce(textResult('a'.repeat(8001)), { maxBytes });
      expect(over.out.content[0].text.startsWith('{"handle"')).toBe(true);
   });

   it('measures every content item together and reports the stored bytes, items joined by one newline', async () => {
      const { out } = await enforce({
         content: [
            {
               type: 'text',
               text: 'a'.repeat(4000),
            },
            {
               type: 'text',
               text: 'b'.repeat(4001),
            },
         ],
      });
      expect(JSON.parse(out.content[0].text).bytes).toBe(8002);
   });

   it('counts structuredContent and drops it when it hands out a handle', async () => {
      const { out } = await enforce({
         content: [{
            type: 'text',
            text: 'ok',
         }],
         structuredContent: { big: 'z'.repeat(9000) },
      });
      expect(out.structuredContent).toBeUndefined();
      expect(out.content[0].text.startsWith('{"handle"')).toBe(true);
   });

   it('passes arguments and the extra argument to the wrapped handler', async () => {
      /** @type {unknown[]} The arguments the handler saw. */
      const seen = [];
      /** @type {Function} The wrapped handler. */
      const wrapped = withResultBudget(
         async (...received) => {
            seen.push(...received);
            return textResult('ok');
         },
         {
            store: createHandleStore(),
            ownerKey: OWNER,
         },
      );
      await wrapped({ a: 1 }, { sessionId: 's' });
      expect(seen).toEqual([
         { a: 1 },
         { sessionId: 's' },
      ]);
   });
});

describe('handle response', () => {
   it('is {handle, bytes, summary} within 256 bytes for a 100 KB result', async () => {
      /** @type {string} The 100 KB payload. */
      const payload = JSON.stringify({
         name: 'MOCK_ACTOR',
         type: 'MOCK_TYPE',
         items: Array.from({ length: 120 }, (_, index) => ({
            name: `MOCK_ITEM_${index}`,
            pad: 'p'.repeat(800),
         })),
      });
      expect(Buffer.byteLength(payload)).toBeGreaterThan(100_000);
      const { out, store } = await enforce(textResult(payload));
      expect(out.isError).toBeUndefined();
      expect(out.content).toHaveLength(1);
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(256);
      /** @type {{ handle: string, bytes: number, summary: object }} The parsed response. */
      const parsed = JSON.parse(out.content[0].text);
      expect(Object.keys(parsed)).toEqual([
         'handle',
         'bytes',
         'summary',
      ]);
      expect(parsed.bytes).toBe(Buffer.byteLength(payload));
      expect(store.slice(OWNER, parsed.handle, { maxBytes: 16000 }).total).toBe(payload.length);
   });

   it('stores the raw text so slices reproduce it', async () => {
      /** @type {string} The large serialized document stored by the enforcer. */
      const payload = bigActorJson();
      const { out, store } = await enforce(textResult(payload));
      /** @type {string} The handle. */
      const { handle } = JSON.parse(out.content[0].text);
      expect(
         store.slice(OWNER, handle, {
            offset: 100,
            length: 50,
         }).text,
      ).toBe(payload.slice(100, 150));
      expect(JSON.parse(store.slice(OWNER, handle, { paths: [
         'name',
         'items.MOCKID7.name',
      ] }).text).values).toEqual({
         name: 'MOCK_ACTOR',
         'items.MOCKID7.name': 'MOCK_ITEM_7',
      });
   });

   it('is readable only by the owner that produced it', async () => {
      const { out, store } = await enforce(textResult(bigActorJson()));
      /** @type {string} The handle. */
      const { handle } = JSON.parse(out.content[0].text);
      expect(store.slice('owner-b', handle).ok).toBe(false);
      expect(store.slice(OWNER, handle).ok).toBe(true);
   });

   it('keeps a valid image next to the handle text', async () => {
      const { out } = await enforce({
         content: [
            {
               type: 'text',
               text: 'a'.repeat(9000),
            },
            {
               type: 'image',
               data: pngHeader(800, 600),
               mimeType: 'image/png',
            },
         ],
      });
      expect(out.content).toHaveLength(2);
      expect(out.content[1].type).toBe('image');
   });

   it('refuses with a short error when the result is larger than the whole store', async () => {
      /** @type {ReturnType<typeof createHandleStore>} A store too small for the result. */
      const tiny = createHandleStore({ maxTotalBytes: 100 });
      const { out } = await enforce(textResult('a'.repeat(9000)), {}, { store: tiny });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.startsWith('HANDLE_TOO_LARGE: ')).toBe(true);
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(256);
   });
});

describe('summary', () => {
   it('lists top-level keys, array and object counts, name and type', () => {
      expect(summarizeResult(bigActorJson())).toEqual({
         kind: 'object',
         n: 4,
         keys: [
            'name',
            'type',
            'system',
            'items',
         ],
         counts: {
            system: 1,
            items: 120,
         },
         name: 'MOCK_ACTOR',
         type: 'MOCK_TYPE',
      });
   });

   it('is identical for identical input', () => {
      expect(summarizeResult(bigActorJson())).toEqual(summarizeResult(bigActorJson()));
   });

   it('describes an array by its length and plain text by its character count', () => {
      expect(summarizeResult(JSON.stringify([
         1,
         2,
         3,
      ]))).toEqual({
         kind: 'array',
         n: 3,
      });
      expect(summarizeResult('not json at all')).toEqual({
         kind: 'text',
         n: 15,
      });
      expect(summarizeResult('42')).toEqual({
         kind: 'text',
         n: 2,
      });
   });

   it('ignores name and type that are not strings', () => {
      expect(summarizeResult(JSON.stringify({
         name: 5,
         type: { a: 1 },
      }))).toEqual({
         kind: 'object',
         n: 2,
         keys: [
            'name',
            'type',
         ],
         counts: { type: 1 },
      });
   });

   it('keeps the whole handle response within 256 bytes for hostile keys, names and types', async () => {
      /** @type {Record<string, unknown>} A document with long keys and long strings. */
      const hostile = {
         name: 'n'.repeat(5000),
         type: 't'.repeat(5000),
      };
      for (let index = 0; index < 50; index++) {
         hostile[`${'k'.repeat(300)}${index}`] = Array.from({ length: index + 1 }, () => 0);
      }
      const { out } = await enforce(textResult(JSON.stringify(hostile)));
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(256);
      expect(JSON.parse(out.content[0].text).summary.kind).toBe('object');
   });

   it('keeps the response within 256 bytes for multi-byte key and name text', async () => {
      /** @type {Record<string, unknown>} A document with multi-byte keys and name. */
      const hostile = { name: '€'.repeat(5000) };
      for (let index = 0; index < 20; index++) {
         hostile[`€€€€${index}`] = [1];
      }
      const { out } = await enforce(textResult(JSON.stringify(hostile)));
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(256);
   });

   it('gives two runs over the same payload the same summary', async () => {
      const first = JSON.parse((await enforce(textResult(bigActorJson()))).out.content[0].text);
      const second = JSON.parse((await enforce(textResult(bigActorJson()))).out.content[0].text);
      expect(first.summary).toEqual(second.summary);
      expect(first.handle).not.toBe(second.handle);
   });
});

describe('errors', () => {
   it('caps an error result to 512 bytes and keeps isError', async () => {
      const { out } = await enforce({
         content: [{
            type: 'text',
            text: 'e'.repeat(5000),
         }],
         isError: true,
      });
      expect(out.isError).toBe(true);
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(512);
      expect(out.content[0].text.endsWith('…')).toBe(true);
   });

   it('leaves an error of exactly 512 bytes unchanged and caps 513', async () => {
      const exact = await enforce({
         content: [{
            type: 'text',
            text: 'e'.repeat(512),
         }],
         isError: true,
      });
      expect(exact.out.content[0].text).toBe('e'.repeat(512));
      const over = await enforce({
         content: [{
            type: 'text',
            text: 'e'.repeat(513),
         }],
         isError: true,
      });
      expect(Buffer.byteLength(over.out.content[0].text, 'utf8')).toBeLessThanOrEqual(512);
   });

   it('never turns an error into a handle', async () => {
      const { out, store } = await enforce({
         content: [{
            type: 'text',
            text: 'e'.repeat(20_000),
         }],
         isError: true,
      });
      expect(out.content[0].text.startsWith('{"handle"')).toBe(false);
      expect(store.stats().entries).toBe(0);
   });

   it('turns a thrown error into a capped error result', async () => {
      /** @type {Function} The wrapped handler. */
      const wrapped = withResultBudget(
         async () => {
            throw new Error('x'.repeat(5000));
         },
         {
            store: createHandleStore(),
            ownerKey: OWNER,
         },
      );
      const out = await wrapped({});
      expect(out.isError).toBe(true);
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(512);
   });
});

describe('images', () => {
   /**
    * Build an image content item.
    * @param {number} width - The image width in pixels.
    * @param {number} height - The image height in pixels.
    * @returns {object} The item.
    */
   function image(width, height) {
      return {
         type: 'image',
         data: pngHeader(width, height),
         mimeType: 'image/png',
      };
   }

   it('passes one image at the 1280 pixel side limit through unchanged', async () => {
      const result = { content: [image(1280, 720)] };
      expect((await enforce(result)).out).toEqual(result);
   });

   it('refuses an image whose longest side is 1281 pixels', async () => {
      const { out } = await enforce({ content: [image(1281, 100)] });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.startsWith('IMAGE_LIMIT: ')).toBe(true);
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(256);
   });

   it('refuses a tall image by its height', async () => {
      const { out } = await enforce({ content: [image(100, 1281)] });
      expect(out.isError).toBe(true);
   });

   it('refuses a second image in one result', async () => {
      const { out } = await enforce({ content: [
         image(10, 10),
         image(10, 10),
      ] });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.startsWith('IMAGE_LIMIT: ')).toBe(true);
   });

   it.each([
      [
         'an image that is not a PNG',
         {
            type: 'image',
            data: Buffer.from('GIF89a').toString('base64'),
            mimeType: 'image/gif',
         },
      ],
      [
         'an image with no data',
         {
            type: 'image',
            mimeType: 'image/png',
         },
      ],
      [
         'a truncated PNG',
         {
            type: 'image',
            data: Buffer.alloc(10).toString('base64'),
            mimeType: 'image/png',
         },
      ],
   ])('refuses %s because its size cannot be read', async (_label, item) => {
      const { out } = await enforce({ content: [item] });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.startsWith('IMAGE_LIMIT: ')).toBe(true);
   });

   it('drops the images from an error result', async () => {
      const { out } = await enforce({
         content: [
            {
               type: 'text',
               text: 'boom',
            },
            image(10, 10),
         ],
         isError: true,
      });
      expect(out.content).toEqual([{
         type: 'text',
         text: 'boom',
      }]);
   });
});

describe('image hardening', () => {
   /** @type {number} The largest accepted base64 payload in characters. */
   const MAX_CHARS = 1_000_000;

   /**
    * Build a PNG image item whose base64 text has an exact length: a valid header, then valid base64 padding text.
    * @param {number} chars - The base64 character count.
    * @returns {object} The image item.
    */
   function imageOfLength(chars) {
      /** @type {string} The 44-character base64 of a 33-byte header for an 800x600 PNG. */
      const header = pngHeader(800, 600);
      return {
         type: 'image',
         data: header + 'A'.repeat(chars - header.length),
         mimeType: 'image/png',
      };
   }

   it('accepts a payload of exactly 1,000,000 base64 characters', async () => {
      const result = { content: [imageOfLength(MAX_CHARS)] };
      expect((await enforce(result)).out).toEqual(result);
   });

   it('refuses a payload of 1,000,001 characters even though the header is a valid PNG', async () => {
      const { out } = await enforce({ content: [imageOfLength(MAX_CHARS + 1)] });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.startsWith('IMAGE_LIMIT: ')).toBe(true);
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(256);
   });

   it.each([
      [
         'a newline',
         '\n',
      ],
      [
         'a space',
         ' ',
      ],
      [
         'a URL-safe character',
         '-',
      ],
      [
         'a data URL prefix character',
         ':',
      ],
      [
         'padding in the middle',
         '=',
      ],
   ])('refuses base64 containing %s', async (_label, bad) => {
      /** @type {object} A valid image with one character swapped for the bad one. */
      const item = imageOfLength(100);
      item.data = item.data.slice(0, 60) + bad + item.data.slice(61);
      const { out } = await enforce({ content: [item] });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.startsWith('IMAGE_LIMIT: ')).toBe(true);
   });

   it('refuses whitespace added around an otherwise valid payload', async () => {
      const { out } = await enforce({
         content: [
            {
               type: 'image',
               data: `${pngHeader(10, 10)}\n`,
               mimeType: 'image/png',
            },
         ],
      });
      expect(out.isError).toBe(true);
   });

   it.each([
      [
         'image/jpeg',
         'image/jpeg',
      ],
      [
         'IMAGE/PNG',
         'IMAGE/PNG',
      ],
      [
         'a missing mimeType',
         undefined,
      ],
      [
         'a non-string mimeType',
         5,
      ],
   ])('refuses PNG bytes labelled %s', async (_label, mimeType) => {
      const { out } = await enforce({
         content: [
            {
               type: 'image',
               data: pngHeader(10, 10),
               mimeType,
            },
         ],
      });
      expect(out.isError).toBe(true);
      expect(out.content[0].text.startsWith('IMAGE_LIMIT: ')).toBe(true);
   });

   /**
    * Build a valid PNG item that also carries megabytes in fields the size measurement never reads.
    * @returns {object} The image item with `_meta`, `annotations` and an extra field.
    */
   function paddedImage() {
      return {
         type: 'image',
         data: pngHeader(10, 10),
         mimeType: 'image/png',
         _meta: { pad: 'p'.repeat(3_000_000) },
         annotations: { audience: ['user'], pad: 'q'.repeat(3_000_000) },
         extra: 'e'.repeat(3_000_000),
      };
   }

   it('rebuilds an image item as exactly type, data and mimeType on the inline path', async () => {
      const { out } = await enforce({ content: [paddedImage()] });
      expect(out.isError).toBeUndefined();
      expect(Object.keys(out.content[0])).toEqual([
         'type',
         'data',
         'mimeType',
      ]);
      expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThan(1000);
   });

   it('rebuilds the image item next to a handle response as well', async () => {
      const { out } = await enforce({
         content: [
            {
               type: 'text',
               text: 'a'.repeat(9000),
            },
            paddedImage(),
         ],
      });
      expect(out.content).toHaveLength(2);
      expect(Object.keys(out.content[1])).toEqual([
         'type',
         'data',
         'mimeType',
      ]);
      expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThan(1000);
   });

   it('refuses a non-string data field', async () => {
      const { out } = await enforce({
         content: [
            {
               type: 'image',
               data: 12345,
               mimeType: 'image/png',
            },
         ],
      });
      expect(out.isError).toBe(true);
   });
});

describe('the enforcer never fails open', () => {
   /** @type {string} The fixed message for a result the enforcer cannot read. */
   const INVALID = 'Tool returned an invalid result.';
   /** @type {string} The fixed message for a handler that threw something that is not a BridgeError. */
   const FAILED = 'Tool failed.';

   /**
    * Run the enforcer over a handler that returns a fixed value.
    * @param {unknown} value - What the handler returns.
    * @returns {Promise<object>} The enforced result.
    */
   async function enforceRaw(value) {
      /** @type {Function} The wrapped handler. */
      const wrapped = withResultBudget(async () => value, {
         store: createHandleStore(),
         ownerKey: OWNER,
      });
      return wrapped({});
   }

   /** @type {object} A structure that JSON.stringify cannot serialize. */
   const circular = {};
   circular.self = circular;

   it.each([
      [
         'null',
         null,
      ],
      [
         'undefined',
         undefined,
      ],
      [
         'a string',
         'text',
      ],
      [
         'an object with no content',
         {},
      ],
      [
         'content that is not an array',
         { content: 'x' },
      ],
      [
         'a null content item',
         { content: [null] },
      ],
      [
         'a content item with no type',
         { content: [{ text: 'x' }] },
      ],
      [
         'a text item with non-string text',
         {
            content: [
               {
                  type: 'text',
                  text: 5,
               },
            ],
         },
      ],
      [
         'a text item with no text',
         { content: [{ type: 'text' }] },
      ],
      [
         'an error result with non-string text',
         {
            content: [
               {
                  type: 'text',
                  text: {},
               },
            ],
            isError: true,
         },
      ],
      [
         'structured content that cannot be serialized',
         {
            content: [],
            structuredContent: circular,
         },
      ],
      [
         'another item that cannot be serialized',
         {
            content: [
               {
                  type: 'resource',
                  resource: { size: 10n },
               },
            ],
         },
      ],
   ])('answers %s with the fixed invalid-result error', async (_label, value) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
         const out = await enforceRaw(value);
         expect(out).toEqual({
            content: [
               {
                  type: 'text',
                  text: INVALID,
               },
            ],
            isError: true,
         });
         expect(warn).toHaveBeenCalledTimes(1);
      } finally {
         warn.mockRestore();
      }
   });

   it.each([
      [
         'a plain Error',
         new Error('internal path C:\\secret\\file.js failed'),
      ],
      [
         'a string',
         'raw string failure',
      ],
      [
         'null',
         null,
      ],
      [
         'an object whose toString throws',
         {
            toString() {
               throw new Error('no string form');
            },
         },
      ],
      [
         'an object with no prototype',
         Object.create(null),
      ],
   ])('answers a thrown %s with a fixed message and logs the cause server-side', async (_label, thrown) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
         /** @type {Function} The wrapped handler. */
         const wrapped = withResultBudget(
            async () => {
               throw thrown;
            },
            {
               store: createHandleStore(),
               ownerKey: OWNER,
            },
         );
         const out = await wrapped({});
         expect(out).toEqual({
            content: [
               {
                  type: 'text',
                  text: FAILED,
               },
            ],
            isError: true,
         });
         expect(warn).toHaveBeenCalledTimes(1);
      } finally {
         warn.mockRestore();
      }
   });

   it('logs the real message of a thrown Error, bounded in length', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
         /** @type {Function} The wrapped handler. */
         const wrapped = withResultBudget(
            async () => {
               throw new Error(`boom ${'x'.repeat(5000)}`);
            },
            {
               store: createHandleStore(),
               ownerKey: OWNER,
            },
         );
         await wrapped({});
         /** @type {string} The logged line. */
         const line = warn.mock.calls[0].join(' ');
         expect(line).toContain('boom');
         expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(700);
      } finally {
         warn.mockRestore();
      }
   });

   it('passes a thrown BridgeError to the caller as <code>: <message>, capped to 512 bytes', async () => {
      /** @type {Function} The wrapped handler. */
      const wrapped = withResultBudget(
         async () => {
            throw new BridgeError('OP_FAILED', 'Foundry rejected the name.');
         },
         {
            store: createHandleStore(),
            ownerKey: OWNER,
         },
      );
      const out = await wrapped({});
      expect(out.isError).toBe(true);
      expect(out.content[0].text).toBe('OP_FAILED: Foundry rejected the name.');
   });

   it('caps a long thrown BridgeError at 512 bytes and keeps its code', async () => {
      /** @type {Function} The wrapped handler. */
      const wrapped = withResultBudget(
         async () => {
            throw new BridgeError('OP_FAILED', 'm'.repeat(5000));
         },
         {
            store: createHandleStore(),
            ownerKey: OWNER,
         },
      );
      const out = await wrapped({});
      expect(out.content[0].text.startsWith('OP_FAILED: ')).toBe(true);
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(512);
   });

   it('writes no newline or control character from a thrown message to the log', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
         /** @type {Function} The wrapped handler. */
         const wrapped = withResultBudget(
            async () => {
               throw new Error('first\nWiretap sidecar | forged line\r\u0007\u001b[31m end\u2028x');
            },
            {
               store: createHandleStore(),
               ownerKey: OWNER,
            },
         );
         await wrapped({});
         expect(warn).toHaveBeenCalledTimes(1);
         /** @type {string} The logged line. */
         const line = warn.mock.calls[0].join(' ');
         expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
         expect(line).toContain('first');
         expect(line).toContain('forged line');
      } finally {
         warn.mockRestore();
      }
   });

   it('does not leak the text of an unexpected failure into the result', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
         /** @type {Function} The wrapped handler. */
         const wrapped = withResultBudget(
            async () => {
               throw new Error('SECRET_TOKEN_123');
            },
            {
               store: createHandleStore(),
               ownerKey: OWNER,
            },
         );
         expect(JSON.stringify(await wrapped({}))).not.toContain('SECRET_TOKEN_123');
      } finally {
         warn.mockRestore();
      }
   });

   it('answers a result whose field getter throws with the fixed invalid-result error', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
         const out = await enforceRaw({
            content: [
               {
                  type: 'text',
                  get text() {
                     throw new Error('getter exploded');
                  },
               },
            ],
         });
         expect(out.isError).toBe(true);
         expect(out.content[0].text).toBe(INVALID);
      } finally {
         warn.mockRestore();
      }
   });
});

describe('entry size cap', () => {
   it('answers a result over 8,000,000 bytes with HANDLE_TOO_LARGE inside the acknowledgement budget', async () => {
      const { out, store } = await enforce(textResult('a'.repeat(8_000_001)));
      expect(out.isError).toBe(true);
      expect(out.content[0].text.startsWith('HANDLE_TOO_LARGE: ')).toBe(true);
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(256);
      expect(store.stats().entries).toBe(0);
   });
});

describe('unmeasured fields are dropped', () => {
   /** @type {string} Three megabytes of padding. */
   const PAD = 'p'.repeat(3_000_000);

   it('rebuilds a text item as exactly type and text on the inline path', async () => {
      const { out } = await enforce({
         content: [
            {
               type: 'text',
               text: 'ok',
               _meta: { pad: PAD },
               annotations: { pad: PAD },
            },
         ],
      });
      expect(out).toEqual({
         content: [
            {
               type: 'text',
               text: 'ok',
            },
         ],
      });
      expect(Object.keys(out.content[0])).toEqual([
         'type',
         'text',
      ]);
   });

   it('returns only content, isError and structuredContent from the result on the inline path', async () => {
      const { out } = await enforce({
         content: [
            {
               type: 'text',
               text: 'ok',
            },
         ],
         structuredContent: { value: 1 },
         _meta: { pad: PAD },
         extra: PAD,
      });
      expect(Object.keys(out).sort()).toEqual([
         'content',
         'structuredContent',
      ]);
      expect(out.structuredContent).toEqual({ value: 1 });
      expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThan(1000);
   });

   it('drops top-level _meta and unknown fields from a result with only content', async () => {
      const { out } = await enforce({
         content: [
            {
               type: 'text',
               text: 'ok',
            },
         ],
         _meta: { pad: PAD },
      });
      expect(Object.keys(out)).toEqual(['content']);
   });

   it('drops the same fields from the handle response', async () => {
      const { out } = await enforce({
         content: [
            {
               type: 'text',
               text: 'a'.repeat(9000),
               _meta: { pad: PAD },
            },
         ],
         _meta: { pad: PAD },
      });
      expect(Object.keys(out)).toEqual(['content']);
      expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThan(1000);
   });
});

describe('stored form', () => {
   it('describes a multi-part result as text, since the joined parts are not one document', async () => {
      /** @type {string} The first part. */
      const first = JSON.stringify({ a: 'x'.repeat(5000) });
      const { out } = await enforce({
         content: [
            {
               type: 'text',
               text: first,
            },
            {
               type: 'text',
               text: JSON.stringify({ b: 'y'.repeat(5000) }),
            },
         ],
      });
      const parsed = JSON.parse(out.content[0].text);
      expect(parsed.summary.kind).toBe('text');
      expect(parsed.bytes).toBe(Buffer.byteLength(first) * 2 + 1);
   });

   it('describes a result with structured content as text and reports the stored bytes', async () => {
      const { out, store } = await enforce({
         content: [
            {
               type: 'text',
               text: 'ok',
            },
         ],
         structuredContent: { big: 'z'.repeat(9000) },
      });
      const parsed = JSON.parse(out.content[0].text);
      expect(parsed.summary.kind).toBe('text');
      expect(store.slice(OWNER, parsed.handle, { maxBytes: 16000 }).total).toBe(parsed.bytes);
   });

   it('keeps a single-text JSON result describable and readable by paths', async () => {
      const { out, store } = await enforce(textResult(bigActorJson()));
      const parsed = JSON.parse(out.content[0].text);
      expect(parsed.summary.kind).toBe('object');
      expect(parsed.bytes).toBe(Buffer.byteLength(bigActorJson()));
      expect(JSON.parse(store.slice(OWNER, parsed.handle, { paths: ['name'] }).text).values).toEqual({
         name: 'MOCK_ACTOR',
      });
   });
});

describe('summary key collisions', () => {
   it('skips keys that collide after truncation, counts them in omitted and keeps the counts correct', () => {
      /** @type {string} The shared 40-character prefix; truncation to 32 bytes cuts inside it. */
      const prefix = 'k'.repeat(40);
      const summary = summarizeResult(
         JSON.stringify({
            [`${prefix}1`]: [
               1,
               2,
               3,
            ],
            [`${prefix}2`]: [1],
            [`${prefix}3`]: {
               a: 1,
               b: 2,
            },
            z: [
               1,
               2,
            ],
         }),
      );
      expect(summary.kind).toBe('object');
      expect(summary.n).toBe(4);
      expect(summary.keys).toHaveLength(2);
      expect(summary.keys[1]).toBe('z');
      expect(summary.omitted).toBe(2);
      expect(Object.values(summary.counts)).toEqual([
         3,
         2,
      ]);
   });

   it('leaves omitted out when no key collides', () => {
      expect(summarizeResult(JSON.stringify({ a: [1] }))).not.toHaveProperty('omitted');
   });

   it('lists integer-like keys first, as JavaScript orders them', () => {
      const summary = summarizeResult('{"b":1,"2":1,"a":1,"1":1}');
      expect(summary.keys).toEqual([
         '1',
         '2',
         'b',
         'a',
      ]);
   });

   it('keeps the whole handle response within 256 bytes when many keys collide', async () => {
      /** @type {Record<string, unknown>} A document whose keys all share a long prefix. */
      const document = { pad: 'p'.repeat(9000) };
      for (let index = 0; index < 30; index++) {
         document[`${'k'.repeat(60)}${index}`] = [index];
      }
      const { out } = await enforce(textResult(JSON.stringify(document)));
      expect(Buffer.byteLength(out.content[0].text, 'utf8')).toBeLessThanOrEqual(256);
      expect(JSON.parse(out.content[0].text).summary.omitted).toBeGreaterThan(0);
   });
});
