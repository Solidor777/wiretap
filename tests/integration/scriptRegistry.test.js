// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { OP_CALL_TOOL } from '../../shared/protocol.js';
import { SCRIPT_API_VERSION } from '../../shared/scripts.js';
import { createActorScript } from '../unit/scriptFixtures.js';
import { createHarness, entry } from './mcpHarness.js';

/**
 * Read the text of the first content item of a tool result.
 * @param {{ content: { type: string, text?: string }[] }} result - The tool result.
 * @returns {string} The text of that item.
 */
function textOf(result) {
   return result.content[0].text;
}

describe('scripts registered over the bridge', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   describe('create_actor through the registry', () => {
      it('lists only read_handle until a client registers scripts', async () => {
         harness = createHarness();
         await harness.start();
         const { client } = await harness.connectClient();
         expect(await harness.toolNames(client)).toEqual(['read_handle']);
      });

      it('lists create_actor once the client registers it, with no hard-coded handler behind it', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm();
         const { client } = await harness.connectClient();
         expect(await gm.register([createActorScript()])).toEqual({
            ok: true,
            accepted: 1,
            refused: 0,
         });
         await expect.poll(() => harness.toolNames(client), { timeout: 1000 }).toEqual([
            'create_actor',
            'read_handle',
         ]);
      });

      it('runs a create_actor call as a callTool op on the registering client and returns its result', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm({
            answer: () => ({
               ok: true,
               result: {
                  uuid: 'Actor.MOCKACTOR0000001',
                  name: 'MOCK_ACTOR',
                  type: 'npc',
               },
            }),
         });
         await gm.register([createActorScript()]);
         const { client } = await harness.connectClient();
         const result = await client.callTool({
            name: 'create_actor',
            arguments: { name: 'MOCK_ACTOR' },
         });
         expect(result.isError).toBeUndefined();
         expect(JSON.parse(textOf(result))).toEqual({
            uuid: 'Actor.MOCKACTOR0000001',
            name: 'MOCK_ACTOR',
            type: 'npc',
         });
         expect(gm.invokes).toHaveLength(1);
         expect(gm.invokes[0].op).toBe(OP_CALL_TOOL);
         expect(gm.invokes[0].params).toEqual({
            name: 'create_actor',
            arguments: { name: 'MOCK_ACTOR' },
         });
      });

      it('reports a client failure as an error result in <code>: <message> form', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm({
            answer: () => ({
               ok: false,
               error: {
                  code: 'OP_FAILED',
                  message: 'MOCK_FAILURE',
               },
            }),
         });
         await gm.register([createActorScript()]);
         const { client } = await harness.connectClient();
         const result = await client.callTool({
            name: 'create_actor',
            arguments: { name: 'MOCK_ACTOR' },
         });
         expect(result.isError).toBe(true);
         expect(textOf(result)).toBe('OP_FAILED: MOCK_FAILURE');
      });

      it('turns an acknowledgement over its 256-byte budget into a handle', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm({
            answer: () => ({
               ok: true,
               result: {
                  uuid: `Actor.${'U'.repeat(250)}`,
                  name: 'N'.repeat(256),
                  type: 'T'.repeat(256),
               },
            }),
         });
         await gm.register([createActorScript()]);
         const { client } = await harness.connectClient();
         const result = await client.callTool({
            name: 'create_actor',
            arguments: { name: 'MOCK_ACTOR' },
         });
         expect(JSON.parse(textOf(result))).toHaveProperty('handle');
         expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(256);
      });
   });

   describe('argument validation before sending', () => {
      it('refuses arguments that break the registered schema without reaching the client', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm();
         await gm.register([createActorScript()]);
         const { client } = await harness.connectClient();
         const missing = await client.callTool({
            name: 'create_actor',
            arguments: {},
         });
         expect(missing.isError).toBe(true);
         const wrongType = await client.callTool({
            name: 'create_actor',
            arguments: { name: 7 },
         });
         expect(wrongType.isError).toBe(true);
         expect(gm.invokes).toEqual([]);
      });

      it('strips an argument the schema does not declare before sending', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm();
         await gm.register([createActorScript()]);
         const { client } = await harness.connectClient();
         await client.callTool({
            name: 'create_actor',
            arguments: {
               name: 'MOCK_ACTOR',
               extra: 'x',
            },
         });
         expect(gm.invokes[0].params.arguments).toEqual({ name: 'MOCK_ACTOR' });
      });
   });

   describe('registry payload shape', () => {
      it('refuses the old plain array, clears the tools and acks OP_FAILED naming the shape', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm();
         await gm.register([entry('kept_tool')]);
         const ack = await gm.registerRaw([entry('kept_tool')]);
         expect(ack.ok).toBe(false);
         expect(ack.error.code).toBe('OP_FAILED');
         expect(ack.error.message).toContain('apiVersion');
         const { client } = await harness.connectClient();
         expect(await harness.toolNames(client)).toEqual(['read_handle']);
      });

      it('refuses another api version', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm();
         const ack = await gm.registerRaw({
            apiVersion: SCRIPT_API_VERSION + 1,
            scripts: [entry('some_tool')],
         });
         expect(ack.ok).toBe(false);
         expect(ack.error.message).toContain('apiVersion');
      });

      it('refuses a definition without mutates and keeps the others', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm();
         const unfinished = entry('no_mutates');
         delete unfinished.mutates;
         expect(await gm.register([
            unfinished,
            entry('fine_tool'),
         ])).toEqual({
            ok: true,
            accepted: 1,
            refused: 1,
         });
         const { client } = await harness.connectClient();
         expect(await harness.toolNames(client)).toEqual([
            'fine_tool',
            'read_handle',
         ]);
      });

      it('refuses a plugin-sized name on the shipped route', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm();
         expect(await gm.register([entry('x'.repeat(40))])).toEqual({
            ok: true,
            accepted: 0,
            refused: 1,
         });
      });

      it('refuses a script named like the built-in read_handle', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm();
         expect(await gm.register([entry('read_handle')])).toEqual({
            ok: true,
            accepted: 0,
            refused: 1,
         });
      });
   });

   describe('tool annotations', () => {
      it('lists readOnlyHint as the inverse of mutates and never claims the tool is non-destructive', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm();
         await gm.register([
            entry('reader_tool', { mutates: false }),
            entry('writer_tool', { mutates: true }),
         ]);
         const { client } = await harness.connectClient();
         const { tools } = await client.listTools();
         const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
         expect(byName.reader_tool.annotations).toEqual({ readOnlyHint: true });
         expect(byName.writer_tool.annotations).toEqual({ readOnlyHint: false });
      });

      it('changes the listing, with one notification, when only mutates changes', async () => {
         harness = createHarness();
         await harness.start();
         const gm = await harness.connectGm();
         await gm.register([entry('flip_tool', { mutates: false })]);
         const { client } = await harness.connectClient();
         await gm.register([entry('flip_tool', { mutates: true })]);
         await expect
            .poll(async () => (await client.listTools()).tools.find((tool) => tool.name === 'flip_tool').annotations, {
               timeout: 1000,
            })
            .toEqual({ readOnlyHint: false });
      });
   });

   describe('requires routing', () => {
      /**
       * Register one dom script on a client.
       * @param {{ register: Function }} gm - The fake GM client.
       * @returns {Promise<unknown>} The registry ack.
       */
      function registerDom(gm) {
         return gm.register([entry('measure_tool', { requires: 'dom' })]);
      }

      it('answers a dom script with only a human tab with a short error naming the agent kind', async () => {
         harness = createHarness();
         await harness.start();
         const human = await harness.connectGm({ kind: 'human' });
         await registerDom(human);
         const { client } = await harness.connectClient();
         const result = await client.callTool({
            name: 'measure_tool',
            arguments: { text: 'x' },
         });
         expect(result.isError).toBe(true);
         expect(textOf(result)).toContain('NO_ENDPOINT');
         expect(textOf(result)).toContain("'agent'");
         expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(256);
         expect(human.invokes).toEqual([]);
      });

      it('answers a dom script whose only agent endpoint is not DOM-capable with the same error', async () => {
         harness = createHarness();
         await harness.start();
         const agent = await harness.connectGm({
            kind: 'agent',
            dom: false,
         });
         await registerDom(agent);
         const { client } = await harness.connectClient();
         const result = await client.callTool({
            name: 'measure_tool',
            arguments: { text: 'x' },
         });
         expect(result.isError).toBe(true);
         expect(textOf(result)).toContain('NO_ENDPOINT');
         expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(256);
         expect(agent.invokes).toEqual([]);
      });

      it('runs a dom script on the human tab when the session is restricted to humans', async () => {
         harness = createHarness();
         await harness.start();
         const human = await harness.connectGm({ kind: 'human' });
         await registerDom(human);
         const { client } = await harness.connectClient('?endpoint=human');
         const result = await client.callTool({
            name: 'measure_tool',
            arguments: { text: 'x' },
         });
         expect(result.isError).toBeUndefined();
         expect(human.invokes).toHaveLength(1);
      });

      it('runs a dom script on the agent endpoint when both kinds are connected', async () => {
         harness = createHarness();
         await harness.start();
         const human = await harness.connectGm({ kind: 'human' });
         const agent = await harness.connectGm({ kind: 'agent' });
         await registerDom(human);
         await registerDom(agent);
         const { client } = await harness.connectClient();
         await client.callTool({
            name: 'measure_tool',
            arguments: { text: 'x' },
         });
         expect(agent.invokes).toHaveLength(1);
         expect(human.invokes).toEqual([]);
      });

      it('lets an api script fall back to the human tab', async () => {
         harness = createHarness();
         await harness.start();
         const human = await harness.connectGm({ kind: 'human' });
         await human.register([entry('read_tool', { requires: 'api' })]);
         const { client } = await harness.connectClient();
         const result = await client.callTool({
            name: 'read_tool',
            arguments: { text: 'x' },
         });
         expect(result.isError).toBeUndefined();
         expect(human.invokes).toHaveLength(1);
      });
   });
});
