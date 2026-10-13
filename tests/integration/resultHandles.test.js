// @vitest-environment node
import net from 'node:net';
import { describe, it, expect, afterEach } from 'vitest';
import { io as ioClient } from 'socket.io-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { createWiretapServer } from '../../server/server.ts';
import { startMcpServer } from '../../server/mcp.ts';
import { sanitizeRegistry } from '../../server/toolRegistry.ts';
import { BRIDGE_IDENTIFY, BRIDGE_INVOKE, PROTOCOL_VERSION } from '../../shared/protocol.js';
import { createActorScript, registryPayload } from '../unit/scriptFixtures.js';

/** @type {string} The op of the test-only tool; the fake client is the only party that knows it. */
const OP_TEST_BIG = 'test:big-result';

/**
 * Reserve a free loopback TCP port by listening on port 0 and releasing it.
 * @returns {Promise<number>} A port that was free at probe time.
 */
function freePort() {
   return new Promise((resolve, reject) => {
      /** @type {import('node:net').Server} A throwaway server used to reserve a port. */
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
         /** @type {number} The port the OS assigned. */
         const { port } = probe.address();
         probe.close(() => resolve(port));
      });
   });
}

/**
 * Build the synthetic document the fake GM client returns: 120 obviously fake embedded items, over 100 KB serialized.
 * @returns {object} The document with 120 embedded items.
 */
function makeBigDocument() {
   return {
      name: 'MOCK_ACTOR',
      type: 'MOCK_TYPE',
      system: { hp: 7 },
      items: Array.from({ length: 120 }, (_, index) => ({
         _id: `MOCKID${index}`,
         name: `MOCK_ITEM_${index}`,
         system: { description: 'd'.repeat(800) },
      })),
   };
}

/**
 * Sum the UTF-8 bytes of every text item in a tool result.
 * @param {{ content: { text: string }[] }} result - The tool result.
 * @returns {number} The byte total.
 */
function textBytes(result) {
   return result.content.reduce((sum, item) => sum + Buffer.byteLength(item.text, 'utf8'), 0);
}

/**
 * A tool handler that returns the arguments it received followed by padding, 9,000 bytes in all.
 * @param {object} args - The validated arguments.
 * @returns {Promise<{ content: { type: 'text', text: string }[] }>} The echo result.
 */
async function echoArguments(args) {
   /** @type {string} The received arguments as JSON. */
   const echoed = JSON.stringify(args);
   return {
      content: [
         {
            type: 'text',
            text: echoed + '.'.repeat(9000 - echoed.length),
         },
      ],
   };
}

describe('large results become handles', () => {
   /** @type {ReturnType<typeof createWiretapServer> | undefined} The sidecar providing the Socket.IO bridge. */
   let server;
   /** @type {ReturnType<typeof startMcpServer> | undefined} The MCP server under test. */
   let mcp;
   /** @type {import('socket.io-client').Socket | undefined} The fake GM client. */
   let gm;
   /** @type {Client | undefined} The real MCP SDK client. */
   let client;

   afterEach(async () => {
      await client?.close();
      client = undefined;
      gm?.close();
      gm = undefined;
      mcp?.close();
      mcp = undefined;
      server?.dispose();
      server = undefined;
   });

   /**
    * Start the sidecar bridge, a fake GM client that answers the test op with the big document, an MCP server with a
    * test-local tool for that op, and an SDK client connected to it.
    * @returns {Promise<Client>} The connected client.
    */
   async function start() {
      server = createWiretapServer(0, await freePort(), 'mcp-only');
      await server.ready;
      gm = ioClient(`http://127.0.0.1:${server.io.httpServer.address().port}`);
      gm.on(BRIDGE_INVOKE, (request, ack) => {
         ack({
            ok: true,
            result: makeBigDocument(),
         });
      });
      await new Promise((resolve) => gm.on('connect', resolve));
      await gm.emitWithAck(BRIDGE_IDENTIFY, {
         protocolVersion: PROTOCOL_VERSION,
         userId: 'u1',
         userName: 'GM',
         isGM: true,
         kind: 'human',
         dom: true,
      });
      mcp = startMcpServer(server.bridge, 0, {
         tools: [
            {
               name: 'test_big_result',
               description: 'Test-only tool returning a synthetic large document.',
               inputSchema: { unused: z.string().optional() },
               handler: async () => {
                  return {
                     content: [
                        {
                           type: 'text',
                           text: JSON.stringify(await server.bridge.invoke(OP_TEST_BIG, {})),
                        },
                     ],
                  };
               },
            },
            {
               name: 'test_declares_max_bytes',
               description: 'Test-only tool that declares maxBytes and echoes the arguments it received.',
               inputSchema: { maxBytes: z.number().int().min(1).max(16000).optional() },
               handler: echoArguments,
            },
            {
               name: 'test_plain',
               description: 'Test-only tool that declares no maxBytes and echoes the arguments it received.',
               inputSchema: { unused: z.string().optional() },
               handler: echoArguments,
            },
         ],
      });
      await mcp.ready;
      client = new Client({
         name: 'test',
         version: '0.0.0',
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.port()}/mcp`)));
      return client;
   }

   it('returns a handle of at most 256 bytes for a 100 KB result', async () => {
      const mcpClient = await start();
      expect(Buffer.byteLength(JSON.stringify(makeBigDocument()))).toBeGreaterThan(100_000);
      const result = await mcpClient.callTool({
         name: 'test_big_result',
         arguments: {},
      });
      expect(result.isError).toBeFalsy();
      expect(textBytes(result)).toBeLessThanOrEqual(256);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.bytes).toBe(Buffer.byteLength(JSON.stringify(makeBigDocument())));
      expect(parsed.summary).toMatchObject({
         kind: 'object',
         name: 'MOCK_ACTOR',
         type: 'MOCK_TYPE',
      });
      expect(parsed.summary.counts.items).toBe(120);
   });

   it('serves read_handle slices within the hard cap and pages the whole result', async () => {
      const mcpClient = await start();
      const big = await mcpClient.callTool({
         name: 'test_big_result',
         arguments: {},
      });
      const { handle } = JSON.parse(big.content[0].text);
      /** @type {string} The original serialized document. */
      const original = JSON.stringify(makeBigDocument());
      /** @type {string} The reassembled text. */
      let joined = '';
      let offset = 0;
      while (offset < original.length) {
         const page = await mcpClient.callTool({
            name: 'read_handle',
            arguments: {
               handle,
               offset,
            },
         });
         expect(page.isError).toBeFalsy();
         expect(textBytes(page)).toBeLessThanOrEqual(8000);
         joined += page.content[0].text;
         offset += JSON.parse(page.content[1].text).length;
      }
      expect(joined).toBe(original);
   });

   it('resolves read_handle paths over the stored document', async () => {
      const mcpClient = await start();
      const big = await mcpClient.callTool({
         name: 'test_big_result',
         arguments: {},
      });
      const { handle } = JSON.parse(big.content[0].text);
      const slice = await mcpClient.callTool({
         name: 'read_handle',
         arguments: {
            handle,
            paths: [
               'name',
               'system.hp',
               'items.MOCKID5.name',
            ],
         },
      });
      expect(JSON.parse(slice.content[0].text)).toEqual({
         values: {
            name: 'MOCK_ACTOR',
            'system.hp': 7,
            'items.MOCKID5.name': 'MOCK_ITEM_5',
         },
         missing: [],
      });
   });

   it('cuts a read_handle paths result larger than the cap to one window and flags it truncated', async () => {
      const mcpClient = await start();
      const big = await mcpClient.callTool({
         name: 'test_big_result',
         arguments: {},
      });
      const { handle } = JSON.parse(big.content[0].text);
      const slice = await mcpClient.callTool({
         name: 'read_handle',
         arguments: {
            handle,
            paths: ['items'],
         },
      });
      expect(slice.isError).toBeFalsy();
      expect(textBytes(slice)).toBeLessThanOrEqual(8000);
      expect(JSON.parse(slice.content[1].text)).toEqual({
         offset: 0,
         length: 7936,
         total: 7936,
         truncated: true,
      });
   });

   it('answers an unknown handle with a short error', async () => {
      const mcpClient = await start();
      const result = await mcpClient.callTool({
         name: 'read_handle',
         arguments: { handle: 'AAAAAAAAAAAAAAAAAAAAAA' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe('HANDLE_NOT_FOUND: Handle not found or expired.');
   });

   it('lists read_handle inside the definition budgets', async () => {
      const mcpClient = await start();
      const { tools } = await mcpClient.listTools();
      const tool = tools.find((candidate) => candidate.name === 'read_handle');
      expect(tool).toBeDefined();
      expect(tool.name.length).toBeLessThanOrEqual(32);
      expect(tool.description.length).toBeLessThanOrEqual(160);
      const definition = JSON.stringify({
         name: tool.name,
         description: tool.description,
         inputSchema: tool.inputSchema,
      });
      expect(Buffer.byteLength(definition, 'utf8')).toBeLessThanOrEqual(800);
      expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
         'handle',
         'length',
         'maxBytes',
         'offset',
         'paths',
      ]);
   });

   it('delivers maxBytes to the handler of a tool that declares it, so a 9,000-byte result stays inline', async () => {
      const mcpClient = await start();
      const result = await mcpClient.callTool({
         name: 'test_declares_max_bytes',
         arguments: { maxBytes: 12000 },
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text.startsWith('{"maxBytes":12000}')).toBe(true);
      expect(textBytes(result)).toBe(9000);
   });

   it('strips maxBytes before a handler that does not declare it, so the 8,000-byte cap applies', async () => {
      const mcpClient = await start();
      const result = await mcpClient.callTool({
         name: 'test_plain',
         arguments: { maxBytes: 12000 },
      });
      const { handle } = JSON.parse(result.content[0].text);
      const stored = await mcpClient.callTool({
         name: 'read_handle',
         arguments: {
            handle,
            length: 20,
         },
      });
      expect(stored.content[0].text).toBe(`{}${'.'.repeat(18)}`);
   });

   it('delivers maxBytes to read_handle, which widens its window to the requested limit less the footer', async () => {
      const mcpClient = await start();
      const big = await mcpClient.callTool({
         name: 'test_big_result',
         arguments: {},
      });
      const { handle } = JSON.parse(big.content[0].text);
      const page = await mcpClient.callTool({
         name: 'read_handle',
         arguments: {
            handle,
            maxBytes: 12000,
         },
      });
      expect(page.isError).toBeFalsy();
      expect(page.content).toHaveLength(2);
      expect(Buffer.byteLength(page.content[0].text, 'utf8')).toBe(12000 - 64);
      expect(textBytes(page)).toBeLessThanOrEqual(12000);
      const narrow = await mcpClient.callTool({
         name: 'read_handle',
         arguments: {
            handle,
            maxBytes: 1000,
         },
      });
      expect(Buffer.byteLength(narrow.content[0].text, 'utf8')).toBe(1000 - 64);
   });

   it('refuses a read_handle maxBytes above 16,000 or below 128 at the schema', async () => {
      const mcpClient = await start();
      for (const maxBytes of [
         16001,
         127,
         64,
         1,
         0,
      ]) {
         const result = await mcpClient.callTool({
            name: 'read_handle',
            arguments: {
               handle: 'AAAAAAAAAAAAAAAAAAAAAA',
               maxBytes,
            },
         });
         expect(result.isError).toBe(true);
         expect(result.content[0].text).not.toContain('HANDLE_NOT_FOUND');
      }
   });

   it('serves read_handle with maxBytes 128 as a 64-byte window and a footer, never as a handle', async () => {
      const mcpClient = await start();
      const big = await mcpClient.callTool({
         name: 'test_big_result',
         arguments: {},
      });
      const { handle } = JSON.parse(big.content[0].text);
      for (const arguments_ of [
         { handle },
         {
            handle,
            paths: ['items'],
         },
      ]) {
         const result = await mcpClient.callTool({
            name: 'read_handle',
            arguments: {
               ...arguments_,
               maxBytes: 128,
            },
         });
         expect(result.isError).toBeFalsy();
         expect(result.content).toHaveLength(2);
         expect(result.content[0].text).toHaveLength(64);
         expect(textBytes(result)).toBeLessThanOrEqual(128);
      }
   });

   it('answers a registry tool failure that is not a BridgeError with the fixed text only', async () => {
      /** @type {import('../../server/toolRegistry.ts').RegistryTool[]} The create_actor script as sanitized. */
      const registered = sanitizeRegistry(registryPayload([createActorScript()]), () => undefined).tools;
      const failing = startMcpServer(
         {
            invokeTool: async () => {
               throw new Error('SECRET_INTERNAL_DETAIL');
            },
            tools: () => registered,
            subscribe: () => () => undefined,
         },
         0,
      );
      await failing.ready;
      const failingClient = new Client({
         name: 'test',
         version: '0.0.0',
      });
      try {
         await failingClient.connect(
            new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${failing.port()}/mcp`)),
         );
         const result = await failingClient.callTool({
            name: 'create_actor',
            arguments: { name: 'Bob' },
         });
         expect(result.isError).toBe(true);
         expect(result.content[0].text).toBe('Tool failed.');
      } finally {
         await failingClient.close();
         failing.close();
      }
   });
});
