// @vitest-environment node
import http from 'node:http';
import { describe, it, expect } from 'vitest';
import { makeCreateActorHandler, startMcpServer } from '../../server/mcp.ts';
import { BridgeError } from '../../server/endpoints.ts';
import { NO_ENDPOINT, OP_CREATE_ACTOR, OP_FAILED } from '$shared/protocol.js';

describe('makeCreateActorHandler', () => {
   it('returns success content containing the new actor uuid', async () => {
      const bridge = { invoke: async () => ({ uuid: 'Actor.abc', id: 'abc', name: 'Bob', type: 'npc' }) };
      const handler = makeCreateActorHandler(bridge);
      const result = await handler({ name: 'Bob', type: 'npc' });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Actor.abc');
      expect(result.content[0].text).toContain('Bob');
   });

   it('forwards name and type to the bridge as createActor params', async () => {
      let captured;
      const bridge = {
         invoke: async (op, params) => {
            captured = { op, params };
            return { uuid: 'Actor.x', name: 'Z', type: 'character' };
         },
      };
      const handler = makeCreateActorHandler(bridge);
      await handler({ name: 'Z' });
      expect(captured.op).toBe(OP_CREATE_ACTOR);
      expect(captured.params).toEqual({ name: 'Z', type: undefined });
   });

   it('forwards an explicit type to the bridge', async () => {
      let captured;
      const bridge = {
         invoke: async (op, params) => {
            captured = params;
            return { uuid: 'Actor.y', name: 'Z', type: 'character' };
         },
      };
      const handler = makeCreateActorHandler(bridge);
      await handler({ name: 'Z', type: 'character' });
      expect(captured).toEqual({ name: 'Z', type: 'character' });
   });

   it('maps a BridgeError to an isError result formatted <code>: <message>', async () => {
      const bridge = {
         invoke: async () => {
            throw new BridgeError(NO_ENDPOINT, 'No GM endpoint connected.');
         },
      };
      const handler = makeCreateActorHandler(bridge);
      const result = await handler({ name: 'Bob' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('NO_ENDPOINT: No GM endpoint connected.');
   });

   it('lists the failures and appends (+N more) when the BridgeError carries truncated failures', async () => {
      const failures = Array.from({ length: 10 }, (_, i) => ({ path: `p${i}`, message: 'm' }));
      const bridge = {
         invoke: async () => {
            throw new BridgeError(OP_FAILED, 'invalid', failures, 50);
         },
      };
      const result = await makeCreateActorHandler(bridge)({ name: 'Bob' });
      expect(result.content[0].text.startsWith('OP_FAILED: invalid\np0: m\np1: m')).toBe(true);
      expect(result.content[0].text.endsWith('p9: m (+40 more)')).toBe(true);
      expect(Buffer.byteLength(result.content[0].text, 'utf8')).toBeLessThanOrEqual(512);
   });

   it('bounds an actor result string to 256 bytes', async () => {
      const bridge = { invoke: async () => ({ uuid: 'Actor.x', name: 'n'.repeat(5000), type: 'npc' }) };
      const result = await makeCreateActorHandler(bridge)({ name: 'Bob' });
      expect(result.isError).toBeFalsy();
      expect(Buffer.byteLength(result.content[0].text, 'utf8')).toBeLessThan(256 + 128);
      expect(result.content[0].text).toContain('…');
   });

   it.each([
      ['undefined', undefined],
      ['null', null],
      ['a string', 'Actor.x'],
      ['an array', ['Actor.x']],
      ['an object without a uuid', { name: 'Bob', type: 'npc' }],
      ['an object with a numeric uuid', { uuid: 5, name: 'Bob', type: 'npc' }],
      ['an object without a name', { uuid: 'Actor.x', type: 'npc' }],
      ['an object with an object type', { uuid: 'Actor.x', name: 'Bob', type: {} }],
   ])('turns %s from a hostile ok:true ack into a short OP_FAILED result without throwing', async (_label, value) => {
      const bridge = { invoke: async () => value };
      const result = await makeCreateActorHandler(bridge)({ name: 'Bob' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text.startsWith(`${OP_FAILED}: `)).toBe(true);
      expect(Buffer.byteLength(result.content[0].text, 'utf8')).toBeLessThanOrEqual(128);
   });

   it('maps a non-BridgeError rejection to its message', async () => {
      const bridge = {
         invoke: async () => {
            throw new Error('boom');
         },
      };
      const result = await makeCreateActorHandler(bridge)({ name: 'Bob' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('boom');
   });
});

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
         const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
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
      const mcp = startMcpServer({ invoke: async () => undefined }, 0);
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
