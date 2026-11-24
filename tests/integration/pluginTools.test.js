// @vitest-environment node
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { closedGateState } from '../../shared/gates.js';
import { createHarness, entry } from './mcpHarness.js';

/** @type {object} A plugin tool of the module `my-mod`, as the client pushes it. */
const pluginEntry = entry('my-mod__echo', { moduleId: 'my-mod' });

/** @type {object} A closed gate snapshot that allows only the plugin tools of `my-mod`. */
const allow = {
   ...closedGateState(),
   allowedPluginModules: ['my-mod'],
};

/**
 * Count the tools/list_changed notifications an SDK client receives from now on.
 * @param {import('@modelcontextprotocol/sdk/client/index.js').Client} client - The SDK client.
 * @returns {() => number} A reader of the count.
 */
function countNotifications(client) {
   /** @type {number} The notifications received. */
   let count = 0;
   client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      count += 1;
   });
   return () => count;
}

/**
 * Wait a fixed time, for tests that check that nothing arrives.
 * @param {number} ms - The wait in milliseconds.
 * @returns {Promise<void>}
 */
function pause(ms) {
   return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('plugin tools through the sidecar', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   it('lists a plugin tool registered mid-session after one tools/list_changed and runs it', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      await gm.pushGates(allow);
      const { client } = await harness.connectClient();
      /** @type {() => number} The notification count reader. */
      const notifications = countNotifications(client);
      await gm.register([pluginEntry]);
      await expect.poll(() => notifications(), { timeout: 1000 }).toBe(1);
      expect(await harness.toolNames(client)).toContain('my-mod__echo');
      const result = await client.callTool({
         name: 'my-mod__echo',
         arguments: { text: 'hi' },
      });
      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toBe('done');
      expect(gm.invokes[0].params.name).toBe('my-mod__echo');
   });

   it('returns a handle for a plugin result over its 2000-byte budget', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({
         answer: () => ({
            ok: true,
            result: 'x'.repeat(5000),
         }),
      });
      await gm.pushGates(allow);
      await gm.register([
         entry('my-mod__echo', {
            moduleId: 'my-mod',
            result: { budgetBytes: 2000 },
         }),
      ]);
      const { client } = await harness.connectClient();
      await expect.poll(() => harness.toolNames(client), { timeout: 1000 }).toContain('my-mod__echo');
      const result = await client.callTool({
         name: 'my-mod__echo',
         arguments: { text: 'hi' },
      });
      expect(result.isError).toBeFalsy();
      /** @type {{ handle: string, bytes: number }} The handle summary the sidecar returns in place of the result. */
      const summary = JSON.parse(result.content[0].text);
      expect(summary).toMatchObject({
         handle: expect.any(String),
         bytes: expect.any(Number),
      });
      expect(summary.bytes).toBeGreaterThan(2000);
   });

   it('does not list a plugin tool of a module allowedPluginModules does not list', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      await gm.pushGates(closedGateState());
      /** @type {{ ok: boolean, accepted: number, refused: number }} The register ack. */
      const ack = await gm.register([
         pluginEntry,
         entry('plain'),
      ]);
      expect(ack).toMatchObject({
         ok: true,
         accepted: 2,
         refused: 0,
      });
      const { client } = await harness.connectClient();
      /** @type {string[]} The listed tool names. */
      const names = await harness.toolNames(client);
      expect(names).toContain('plain');
      expect(names).not.toContain('my-mod__echo');
   });

   it('refuses a call with GATE_DENIED and sends nothing ' +
      'when the module is removed before the list change', async () => {
      harness = createHarness();
      await harness.start({
         sessions: {
            listChangedQuietMs: 60_000,
            listChangedMaxWaitMs: 60_000,
         },
      });
      const gm = await harness.connectGm();
      await gm.pushGates(allow);
      await gm.register([pluginEntry]);
      const { client } = await harness.connectClient();
      expect(await harness.toolNames(client)).toContain('my-mod__echo');
      await gm.pushGates(closedGateState());
      const result = await client.callTool({
         name: 'my-mod__echo',
         arguments: { text: 'hi' },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('GATE_DENIED');
      expect(gm.invokes).toEqual([]);
   });

   it('follows a settings change: listed when the module is added, gone when it is removed', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      await gm.pushGates(closedGateState());
      await gm.register([pluginEntry]);
      const { client } = await harness.connectClient();
      /** @type {() => number} The notification count reader. */
      const notifications = countNotifications(client);
      expect(await harness.toolNames(client)).not.toContain('my-mod__echo');
      await gm.pushGates(allow);
      await expect.poll(() => notifications(), { timeout: 1000 }).toBe(1);
      expect(await harness.toolNames(client)).toContain('my-mod__echo');
      await gm.pushGates(closedGateState());
      await expect.poll(() => notifications(), { timeout: 1000 }).toBe(2);
      expect(await harness.toolNames(client)).not.toContain('my-mod__echo');
   });

   it('sends no tools/list_changed when a gate push changes only another gate', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      await gm.pushGates(allow);
      await gm.register([pluginEntry]);
      const { client } = await harness.connectClient();
      expect(await harness.toolNames(client)).toContain('my-mod__echo');
      /** @type {() => number} The notification count reader. */
      const notifications = countNotifications(client);
      await gm.pushGates({
         ...allow,
         allowDelete: true,
      });
      // The harness debounce ends at most 100 ms after a change, so a notification would arrive well inside 300 ms.
      await pause(300);
      expect(notifications()).toBe(0);
      expect(await harness.toolNames(client)).toContain('my-mod__echo');
   });

   it('lists many plugin and shipped tools together', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      await gm.pushGates(allow);
      /** @type {object[]} 100 plugin tools of `my-mod` and 5 shipped tools. */
      const scripts = [
         ...Array.from({ length: 100 }, (_, index) => entry(`my-mod__t${index}`, { moduleId: 'my-mod' })),
         ...Array.from({ length: 5 }, (_, index) => entry(`s${index}`)),
      ];
      expect(await gm.register(scripts)).toMatchObject({
         ok: true,
         accepted: 105,
         refused: 0,
      });
      const { client } = await harness.connectClient();
      // The 105 registered tools and the sidecar's 5 built-ins: read_handle and the four backup tools.
      expect(await harness.toolNames(client)).toHaveLength(110);
   });
});
