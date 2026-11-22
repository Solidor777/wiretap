// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OP_CALL_TOOL } from '../../shared/protocol.js';
import { createCallTool } from '../../src/bridge/scripts/callTool.js';
import { registerShippedScripts } from '../../src/bridge/scripts/index.js';
import { createScriptRegistry } from '../../src/bridge/scripts/registry.js';
import { installWriteWorld } from '../unit/mockWriteWorld.js';
import { shippedScripts } from '../unit/scriptFixtures.js';
import { createHarness } from './mcpHarness.js';

/** @type {string} The id of the compendium pack that holds the pack sources. */
const SOURCE_PACK_ID = 'world.mocksources';

/** @type {string} A 100,000-byte body; two adjacent repeats never occur in any other text of these tests. */
const LARGE_NOTES = 'MOCK_'.repeat(20000);

/**
 * The JSON text of every message the SDK client received and sent, recorded from the moment of `recordMessages`.
 * @typedef {{ received: string[], sent: string[] }} MessageLog
 */

/**
 * Read the text of the first content item of a tool result.
 * @param {{ content: { type: string, text?: string }[] }} result - The tool result.
 * @returns {string} The text of that item.
 */
function textOf(result) {
   return result.content[0].text;
}

/**
 * Record every message the SDK client's transport receives (`onmessage`) and sends (`send`) as JSON text, then hand
 * each to the original function.
 * @param {import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport} transport - The
 * connected transport; the SDK client set its `onmessage` while connecting.
 * @returns {MessageLog} The recorded messages, filled as they pass.
 */
function recordMessages(transport) {
   /** @type {MessageLog} The recorded messages. */
   const log = {
      received: [],
      sent: [],
   };
   /** @type {(message: object, extra?: object) => void} The SDK client's receiver. */
   const receive = transport.onmessage;
   /** @type {(message: object, options?: object) => Promise<void>} The transport's own sender. */
   const send = transport.send.bind(transport);
   transport.onmessage = (message, extra) => {
      log.received.push(JSON.stringify(message));
      receive(message, extra);
   };
   transport.send = (message, options) => {
      log.sent.push(JSON.stringify(message));
      return send(message, options);
   };
   return log;
}

describe('create_documents copies through the MCP server', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   /** @type {ReturnType<typeof installWriteWorld>} The mocked world the fake GM client's scripts act on. */
   let world;

   /** @type {(params: unknown) => Promise<unknown>} The real callTool handler over the shipped scripts. */
   let callTool;

   beforeEach(() => {
      /** @type {ReturnType<typeof createScriptRegistry>} A registry holding the shipped scripts. */
      const registry = createScriptRegistry({ log: () => {} });
      registerShippedScripts(registry);
      callTool = createCallTool({ registry });
      world = installWriteWorld(vi.fn);
   });

   afterEach(async () => {
      await harness.cleanup();
      for (const name of [
         'CONST',
         'CONFIG',
         'fromUuid',
         'game',
         'foundry',
      ]) {
         delete globalThis[name];
      }
   });

   /**
    * Start the harness and connect a fake GM client that runs the real script handlers against the mock world, and
    * an SDK client that lists `create_documents`.
    * @returns {Promise<{ gm: object, client: import('@modelcontextprotocol/sdk/client/index.js').Client,
    * transport: import('@modelcontextprotocol/sdk/client/streamableHttp.js').StreamableHTTPClientTransport }>} The
    * GM client, the SDK client and its transport.
    */
   async function connect() {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({
         answer: async (request) => {
            try {
               return {
                  ok: true,
                  result: await callTool(request.params),
               };
            } catch (error) {
               return {
                  ok: false,
                  error: {
                     code: error.code ?? 'OP_FAILED',
                     message: error.message,
                  },
               };
            }
         },
      });
      await gm.register(shippedScripts());
      const { client, transport } = await harness.connectClient();
      await expect.poll(() => harness.toolNames(client), { timeout: 1000 }).toContain('create_documents');
      return {
         gm,
         client,
         transport,
      };
   }

   /**
    * Add an Item to a compendium pack of the mock world, reachable by its `Compendium.<pack>.Item.<id>` uuid.
    * @param {Record<string, unknown>} data - The source data.
    * @returns {object} The pack document.
    */
   function addPackedItem(data) {
      /** @type {object} The document, held by the pack. */
      const document = world.add('Item', data, { pack: SOURCE_PACK_ID });
      /** @type {string} The uuid of a document inside a compendium pack. */
      const uuid = `Compendium.${SOURCE_PACK_ID}.Item.${document.id}`;
      Object.defineProperty(document, 'uuid', { value: uuid });
      world.byUuid.set(uuid, document);
      return document;
   }

   it('copies a 100 KB source without the body reaching the agent', async () => {
      /** @type {object} The source item, whose notes are the large body. */
      const source = world.add('Item', {
         name: 'MOCK_large',
         type: 'weapon',
         system: { notes: LARGE_NOTES },
      });
      /** @type {object} The actor that receives the copy. */
      const target = world.add('Actor', {
         name: 'MOCK_target',
         type: 'npc',
      });
      const { gm, client, transport } = await connect();
      /** @type {MessageLog} The messages of the copy call. */
      const log = recordMessages(transport);
      const result = await client.callTool({
         name: 'create_documents',
         arguments: {
            documentName: 'Item',
            parentUuid: target.uuid,
            fromUuids: [source.uuid],
         },
      });
      expect(result.isError).not.toBe(true);
      /** @type {Record<string, unknown>[]} The acknowledgement rows. */
      const rows = JSON.parse(textOf(result));
      expect(rows).toEqual([
         {
            uuid: expect.stringMatching(new RegExp(`^${target.uuid}\\.Item\\.`)),
            name: 'MOCK_large',
            type: 'weapon',
         },
      ]);
      expect(log.received.length).toBeGreaterThan(0);
      for (const text of log.received) {
         expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(5000);
         expect(text).not.toContain('MOCK_MOCK_');
      }
      expect(gm.invokes[0].params.arguments).toEqual({
         documentName: 'Item',
         parentUuid: target.uuid,
         fromUuids: [source.uuid],
      });
      /** @type {object[]} The items the target holds after the call. */
      const created = [...target.items.values()];
      expect(created).toHaveLength(1);
      expect(created[0].uuid).toBe(rows[0].uuid);
      expect(created[0]._source.system.notes).toBe(LARGE_NOTES);
   });

   it('builds an actor with its own items inline and compendium items by uuid in two tools/call requests', async () => {
      /** @type {object} The compendium item the actor receives by uuid. */
      const packed = addPackedItem({
         name: 'MOCK_packed',
         type: 'weapon',
      });
      const { gm, client, transport } = await connect();
      /** @type {MessageLog} The messages of the recipe. */
      const log = recordMessages(transport);
      /** @type {string} The actor with its own item and effect inline. */
      const actorText = JSON.stringify({
         name: 'MOCK_built',
         type: 'npc',
         items: [
            {
               name: 'MOCK_inline',
               type: 'weapon',
            },
         ],
         effects: [{ name: 'MOCK_effect' }],
      });
      const built = await client.callTool({
         name: 'create_documents',
         arguments: {
            documentName: 'Actor',
            data: [actorText],
         },
      });
      expect(built.isError).not.toBe(true);
      /** @type {Record<string, unknown>[]} The rows of the actor create. */
      const [actorRow] = JSON.parse(textOf(built));
      expect(actorRow).toMatchObject({
         name: 'MOCK_built',
         type: 'npc',
      });
      const copied = await client.callTool({
         name: 'create_documents',
         arguments: {
            documentName: 'Item',
            parentUuid: actorRow.uuid,
            fromUuids: [packed.uuid],
         },
      });
      expect(copied.isError).not.toBe(true);
      expect(JSON.parse(textOf(copied))).toEqual([
         {
            uuid: expect.stringMatching(new RegExp(`^${actorRow.uuid}\\.Item\\.`)),
            name: 'MOCK_packed',
            type: 'weapon',
         },
      ]);
      /** @type {object} The actor the first call created. */
      const actor = world.byUuid.get(actorRow.uuid);
      expect(actor._source.items.map((item) => item.name)).toEqual(['MOCK_inline']);
      expect(actor._source.effects.map((effect) => effect.name)).toEqual(['MOCK_effect']);
      expect([...actor.items.values()].map((item) => item.name)).toEqual(['MOCK_packed']);
      /** @type {object[]} The JSON-RPC requests the SDK client sent. */
      const requests = log.sent.map((text) => JSON.parse(text));
      expect(requests.filter((message) => message.method === 'tools/call')).toHaveLength(2);
      expect(gm.invokes.filter((request) => request.op === OP_CALL_TOOL)).toHaveLength(2);
   });

   it('returns a missing-source error as <code>: <message> and sends no document', async () => {
      /** @type {object} The actor that would receive the copy. */
      const target = world.add('Actor', {
         name: 'MOCK_target',
         type: 'npc',
      });
      /** @type {string} A uuid no document of the mock world holds. */
      const missing = 'Item.MOCKMISSING00001';
      const { client } = await connect();
      const result = await client.callTool({
         name: 'create_documents',
         arguments: {
            documentName: 'Item',
            parentUuid: target.uuid,
            fromUuids: [missing],
         },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^DOC_NOT_FOUND: /);
      expect(textOf(result)).toContain(missing);
      expect(world.calls).toEqual([]);
      expect(target.items.size).toBe(0);
   });
});
