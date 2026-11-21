// @vitest-environment node
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { OP_CALL_TOOL } from '../../shared/protocol.js';
import { shippedScripts } from '../unit/scriptFixtures.js';
import { createHarness } from './mcpHarness.js';

/** @type {Record<string, true>} The one `_meta` entry the sidecar lists on a tool that asks the human first. */
const PROMPT_META = { 'anthropic/requiresUserInteraction': true };

/**
 * Read the text of the first content item of a tool result.
 * @param {{ content: { type: string, text?: string }[] }} result - The tool result.
 * @returns {string} The text of that item.
 */
function textOf(result) {
   return result.content[0].text;
}

describe('the pack tools over the bridge', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   /**
    * Start the harness, register the shipped scripts on one GM client and connect an SDK client once the pack tools
    * are listed.
    * @param {(request: object) => object} [answer] - Builds the GM client's ack of an invocation.
    * @returns {Promise<{ gm: object, client: import('@modelcontextprotocol/sdk/client/index.js').Client }>} The GM
    * client and the SDK client.
    */
   async function startWithShipped(answer) {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm(answer === undefined ? {} : { answer });
      await gm.register(shippedScripts());
      const { client } = await harness.connectClient();
      await expect.poll(() => harness.toolNames(client), { timeout: 1000 }).toContain('delete_pack');
      return {
         gm,
         client,
      };
   }

   /**
    * Read one listed tool.
    * @param {import('@modelcontextprotocol/sdk/client/index.js').Client} client - The SDK client.
    * @param {string} name - The tool name.
    * @returns {Promise<{ name: string, annotations?: object, _meta?: Record<string, unknown> }>} The listed tool.
    */
   async function listed(client, name) {
      return (await client.listTools()).tools.find((tool) => tool.name === name);
   }

   it('lists create_pack and delete_pack as mutating tools, ' +
      'and only delete_pack with the user-interaction meta', async () => {
      const { client } = await startWithShipped();
      /** @type {{ annotations?: object, _meta?: Record<string, unknown> }} The listed create_pack. */
      const createPack = await listed(client, 'create_pack');
      /** @type {{ annotations?: object, _meta?: Record<string, unknown> }} The listed delete_pack. */
      const deletePack = await listed(client, 'delete_pack');
      expect(createPack.annotations).toMatchObject({ readOnlyHint: false });
      expect(deletePack.annotations).toMatchObject({ readOnlyHint: false });
      expect(deletePack._meta).toEqual(PROMPT_META);
      expect(createPack._meta).toBeUndefined();
   });

   it('lists delete_pack with the meta entry when its client registers it without the flag', async () => {
      const { gm, client } = await startWithShipped();
      /** @type {number} The tool list notifications received. */
      let notifications = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
         notifications += 1;
      });
      /** @type {object[]} The shipped definitions with delete_pack's flag removed and its version changed. */
      const scripts = shippedScripts();
      /** @type {{ version: string, requiresUserInteraction?: boolean }} The delete_pack definition. */
      const deletePack = scripts.find((definition) => definition.name === 'delete_pack');
      delete deletePack.requiresUserInteraction;
      // A new version changes the tool's signature, so the session re-lists it and sends one list_changed.
      deletePack.version = '1.0.1';
      await gm.register(scripts);
      await expect.poll(() => notifications, { timeout: 1000 }).toBe(1);
      expect((await listed(client, 'delete_pack'))._meta).toEqual(PROMPT_META);
   });

   it('forwards create_pack arguments to the GM client as a callTool op ' +
      'and returns its ack within 256 bytes', async () => {
      /** @type {{ dryRun: true, id: string, label: string, type: string }} The preview row the client answers. */
      const preview = {
         dryRun: true,
         id: 'world.mock-pack-a',
         label: 'MOCK_PACK_A',
         type: 'Actor',
      };
      const { gm, client } = await startWithShipped(() => ({
         ok: true,
         result: preview,
      }));
      /** @type {{ label: string, type: string, name: string, dryRun: boolean }} The create_pack arguments. */
      const args = {
         label: 'MOCK_PACK_A',
         type: 'Actor',
         name: 'mock-pack-a',
         dryRun: true,
      };
      const result = await client.callTool({
         name: 'create_pack',
         arguments: args,
      });
      expect(gm.invokes[0].op).toBe(OP_CALL_TOOL);
      expect(gm.invokes[0].params).toEqual({
         name: 'create_pack',
         arguments: args,
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result))).toEqual(preview);
      expect(Buffer.byteLength(textOf(result), 'utf8')).toBeLessThanOrEqual(256);
   });

   it('forwards delete_pack the same way and passes dryRun through', async () => {
      /** @type {{ id: string, deleted: true }} The deletion ack the client answers. */
      const ack = {
         id: 'world.mock-pack-a',
         deleted: true,
      };
      const { gm, client } = await startWithShipped(() => ({
         ok: true,
         result: ack,
      }));
      /** @type {{ id: string, dryRun: boolean }} The delete_pack arguments. */
      const args = {
         id: 'world.mock-pack-a',
         dryRun: false,
      };
      const result = await client.callTool({
         name: 'delete_pack',
         arguments: args,
      });
      expect(gm.invokes[0].op).toBe(OP_CALL_TOOL);
      expect(gm.invokes[0].params).toEqual({
         name: 'delete_pack',
         arguments: args,
      });
      expect(result.isError).toBeFalsy();
      expect(JSON.parse(textOf(result))).toEqual(ack);
      expect(Buffer.byteLength(textOf(result), 'utf8')).toBeLessThanOrEqual(256);
   });

   it('refuses an undeclared argument, a missing id and an over-long field before anything is sent', async () => {
      const { gm, client } = await startWithShipped();
      /** @type {Array<{ name: string, arguments: object }>} The calls the listed schemas refuse. */
      const calls = [
         {
            name: 'delete_pack',
            arguments: {
               id: 'world.mock-pack-a',
               force: true,
            },
         },
         {
            name: 'delete_pack',
            arguments: {},
         },
         {
            name: 'create_pack',
            arguments: {
               label: '',
               type: 'Actor',
            },
         },
         {
            name: 'create_pack',
            arguments: {
               label: 'MOCK_PACK_A',
               type: 'Actor',
               name: 'a'.repeat(65),
            },
         },
         {
            name: 'create_pack',
            arguments: {
               label: 'a'.repeat(129),
               type: 'Actor',
            },
         },
      ];
      for (const call of calls) {
         expect((await client.callTool(call)).isError).toBe(true);
      }
      expect(gm.invokes).toHaveLength(0);
   });

   it('a GM client error code reaches the agent as <code>: <message>', async () => {
      const { client } = await startWithShipped(() => ({
         ok: false,
         error: {
            code: 'PACK_LOCKED',
            message: 'The pack is locked.',
         },
      }));
      const result = await client.callTool({
         name: 'delete_pack',
         arguments: { id: 'world.mock-pack-a' },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result).startsWith('PACK_LOCKED:')).toBe(true);
   });
});
