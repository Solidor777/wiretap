// @vitest-environment node
import http from 'node:http';
import { describe, it, expect } from 'vitest';
import { makeReadHandleHandler, startMcpServer } from '../../server/mcp.ts';
import { createHandleStore } from '../../server/handles.ts';

/**
 * Build a bridge that has no endpoint: no tools and no changes.
 * @returns {{ invokeTool: Function, tools: Function, subscribe: Function }} A bridge with no endpoint behind it.
 */
function idleBridge() {
   return {
      invokeTool: async () => undefined,
      tools: () => [],
      subscribe: () => () => undefined,
   };
}

describe('startMcpServer on an ephemeral port', () => {
   /**
    * Send a POST /mcp request with an explicit Host header.
    * @param {number} port - The port to connect to.
    * @param {string} host - The Host header value.
    * @returns {Promise<number>} The HTTP status code.
    */
   function post(port, host) {
      return new Promise((resolve, reject) => {
         /** @type {string} The JSON-RPC body. */
         const body = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
         });
         const req = http.request(
            {
               host: '127.0.0.1',
               port,
               path: '/mcp',
               method: 'POST',
               headers: {
                  Host: host,
                  'Content-Type': 'application/json',
                  Accept: 'application/json, text/event-stream',
                  'Content-Length': Buffer.byteLength(body),
               },
            },
            (res) => {
               res.resume();
               res.on('end', () => resolve(res.statusCode));
            },
         );
         req.on('error', reject);
         req.end(body);
      });
   }

   it('accepts the Host of the real bound port and refuses any other Host', async () => {
      const mcp = startMcpServer(idleBridge(), 0);
      try {
         await mcp.ready;
         /** @type {number} The ephemeral port the OS assigned. */
         const port = mcp.port();
         expect(port).toBeGreaterThan(0);
         expect(await post(port, `127.0.0.1:${port}`)).not.toBe(403);
         expect(await post(port, `localhost:${port}`)).not.toBe(403);
         expect(await post(port, '127.0.0.1:0')).toBe(403);
         expect(await post(port, 'evil.example')).toBe(403);
      } finally {
         mcp.close();
      }
   });
});

describe('makeReadHandleHandler', () => {
   /** @type {string} The owner key of the synthetic session. */
   const OWNER = 'owner-a';

   /**
    * Store a text and build a handler for the owner.
    * @param {string} text - The text to store.
    * @returns {{ handle: string, handler: Function, store: ReturnType<typeof createHandleStore> }} The pieces.
    */
   function setup(text) {
      /** @type {ReturnType<typeof createHandleStore>} The empty store the handler reads. */
      const store = createHandleStore();
      return {
         handle: store.put(OWNER, text).handle,
         handler: makeReadHandleHandler(store, OWNER),
         store,
      };
   }

   it('returns the window text and a footer with offset, length and total', async () => {
      const { handle, handler } = setup('hello world');
      const result = await handler({
         handle,
         offset: 6,
         length: 5,
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0]).toEqual({
         type: 'text',
         text: 'world',
      });
      expect(JSON.parse(result.content[1].text)).toEqual({
         offset: 6,
         length: 5,
         total: 11,
      });
   });

   it('keeps window and footer together within the 8,000-byte hard cap for a 100 KB result', async () => {
      const { handle, handler } = setup('€'.repeat(40_000));
      const result = await handler({ handle });
      const bytes = result.content.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0);
      expect(bytes).toBeLessThanOrEqual(8000);
      expect(bytes).toBeGreaterThan(7800);
   });

   it('sizes the window from a requested maxBytes less the footer reserve', async () => {
      const { handle, handler } = setup('a'.repeat(30_000));
      const wide = await handler({
         handle,
         maxBytes: 12_000,
      });
      expect(wide.content[0].text).toHaveLength(12_000 - 64);
      const narrow = await handler({
         handle,
         maxBytes: 164,
      });
      expect(narrow.content[0].text).toHaveLength(100);
   });

   it.each([
      1,
      64,
      127,
   ])('answers maxBytes %i, below the 128-byte minimum, with a bounded error', async (maxBytes) => {
      const { handle, handler } = setup('a');
      const result = await handler({
         handle,
         maxBytes,
      });
      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      expect(result.content[0].text.startsWith('HANDLE_WINDOW_TOO_SMALL: ')).toBe(true);
      expect(Buffer.byteLength(result.content[0].text, 'utf8')).toBeLessThanOrEqual(128);
   });

   it('serves a 64-byte window with its footer inside maxBytes 128, even for a truncated paths result', async () => {
      const { handle, handler } = setup(JSON.stringify({ big: 'x'.repeat(30_000) }));
      const plain = await handler({
         handle,
         maxBytes: 128,
      });
      expect(plain.isError).toBeFalsy();
      expect(plain.content[0].text).toHaveLength(64);
      const cut = await handler({
         handle,
         paths: ['big'],
         maxBytes: 128,
      });
      expect(cut.isError).toBeFalsy();
      expect(cut.content.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0)).toBeLessThanOrEqual(128);
   });

   it('flags a paths result that was cut at the window size in the footer', async () => {
      const { handle, handler } = setup(JSON.stringify({ big: 'x'.repeat(30_000) }));
      const result = await handler({
         handle,
         paths: ['big'],
      });
      expect(JSON.parse(result.content[1].text)).toEqual({
         offset: 0,
         length: 7936,
         total: 7936,
         truncated: true,
      });
   });

   it('resolves paths over the stored JSON', async () => {
      const { handle, handler } = setup(JSON.stringify({ name: 'MOCK_ACTOR' }));
      const result = await handler({
         handle,
         paths: ['name'],
      });
      expect(JSON.parse(result.content[0].text)).toEqual({
         values: { name: 'MOCK_ACTOR' },
         missing: [],
      });
   });

   it('maps a store failure to an isError result formatted <code>: <message>', async () => {
      const { handler } = setup('x');
      const result = await handler({ handle: 'AAAAAAAAAAAAAAAAAAAAAA' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('HANDLE_NOT_FOUND: Handle not found or expired.');
   });

   it('refuses a handle that belongs to another owner', async () => {
      const { handle, store } = setup('secret');
      const result = await makeReadHandleHandler(store, 'owner-b')({ handle });
      expect(result.isError).toBe(true);
      expect(result.content[0].text.startsWith('HANDLE_NOT_FOUND')).toBe(true);
   });
});
