// @vitest-environment node
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { OP_CALL_TOOL } from '../../shared/protocol.js';
import { script } from '../unit/scriptFixtures.js';
import { createHarness } from './mcpHarness.js';

describe('the user-interaction meta entry of a listed tool', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   /**
    * Start the harness, register scripts on one GM client and connect an SDK client once the last script is listed.
    * @param {object[]} scripts - The definitions the GM client registers.
    * @returns {Promise<{ gm: object, client: import('@modelcontextprotocol/sdk/client/index.js').Client,
    * listed: (name: string) => object }>} The GM client, the SDK client and a reader of one listed tool.
    */
   async function listWith(scripts) {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      await gm.register(scripts);
      const { client } = await harness.connectClient();
      await expect.poll(() => harness.toolNames(client), { timeout: 1000 }).toContain(scripts.at(-1).name);
      /** @type {{ tools: Array<{ name: string, _meta?: Record<string, unknown> }> }} The tools the session lists. */
      const { tools } = await client.listTools();
      return {
         gm,
         client,
         listed: (name) => tools.find((tool) => tool.name === name),
      };
   }

   it('lists a flagged tool with the meta entry and an unflagged tool without a _meta', async () => {
      const { listed } = await listWith([
         script('delete_pack', {
            mutates: true,
            requiresUserInteraction: true,
         }),
         script('plain_tool'),
      ]);
      expect(listed('delete_pack')._meta).toEqual({ 'anthropic/requiresUserInteraction': true });
      expect(listed('plain_tool')._meta).toBeUndefined();
   });

   it('lists delete_pack with the meta entry when the client registers it without the flag', async () => {
      const { listed } = await listWith([script('delete_pack', { mutates: true })]);
      expect(listed('delete_pack')._meta).toEqual({ 'anthropic/requiresUserInteraction': true });
   });

   it('lists the meta entry on a tool of another name that the client flags, and no other _meta key', async () => {
      const { listed } = await listWith([
         script('mark_x', {
            requiresUserInteraction: true,
            _meta: { 'x/evil': 1 },
            annotations: {
               readOnlyHint: false,
               destructiveHint: false,
            },
         }),
      ]);
      expect(Object.keys(listed('mark_x')._meta)).toEqual(['anthropic/requiresUserInteraction']);
      expect(listed('mark_x').annotations).toEqual({ readOnlyHint: true });
   });

   it('adds and removes the meta entry as a re-registered tool gains and loses the flag', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      const { client } = await harness.connectClient();
      /** @type {number} The tool list notifications received. */
      let notifications = 0;
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
         notifications += 1;
      });
      /**
       * Read the `_meta` of the listed tool.
       * @returns {Promise<Record<string, unknown> | undefined>} The listed `_meta`.
       */
      const listedMeta = async () => (await client.listTools()).tools.find((tool) => tool.name === 'toggle_x')._meta;
      await gm.register([script('toggle_x')]);
      await expect.poll(() => notifications, { timeout: 1000 }).toBe(1);
      expect(await listedMeta()).toBeUndefined();
      await gm.register([script('toggle_x', { requiresUserInteraction: true })]);
      await expect.poll(() => notifications, { timeout: 1000 }).toBe(2);
      expect(await listedMeta()).toEqual({ 'anthropic/requiresUserInteraction': true });
      await gm.register([script('toggle_x')]);
      await expect.poll(() => notifications, { timeout: 1000 }).toBe(3);
      expect(await listedMeta()).toBeUndefined();
   });

   it('forwards a call of the flagged tool to the client unchanged', async () => {
      const { gm, client } = await listWith([
         script('delete_pack', {
            mutates: true,
            requiresUserInteraction: true,
         }),
      ]);
      await client.callTool({
         name: 'delete_pack',
         arguments: { text: 'world.mock-pack' },
      });
      expect(gm.invokes[0].op).toBe(OP_CALL_TOOL);
      expect(gm.invokes[0].params).toEqual({
         name: 'delete_pack',
         arguments: { text: 'world.mock-pack' },
      });
   });
});
