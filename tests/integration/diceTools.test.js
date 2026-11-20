// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { OP_CALL_TOOL } from '../../shared/protocol.js';
import { drawTableDefinition, rollDefinition } from '../../src/bridge/scripts/diceDefinitions.js';
import { shippedScripts } from '../unit/scriptFixtures.js';
import { createHarness } from './mcpHarness.js';

/**
 * Read the text of the first content item of a tool result.
 * @param {{ content: { type: string, text?: string }[] }} result - The tool result.
 * @returns {string} The text of that item.
 */
function textOf(result) {
   return result.content[0].text;
}

describe('the dice tools over the bridge', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   it('lists roll and draw_table as mutating tools and forwards toChat', async () => {
      harness = createHarness();
      await harness.start();
      /** @type {{ total: number, formula: string, dice: Array<[number, number[]]> }} The roll the client answers. */
      const rolled = {
         total: 9,
         formula: '2d6',
         dice: [
            [
               6,
               [
                  4,
                  5,
               ],
            ],
         ],
      };
      const gm = await harness.connectGm({
         answer: () => ({
            ok: true,
            result: rolled,
         }),
      });
      await gm.register([
         ...shippedScripts(),
         rollDefinition,
         drawTableDefinition,
      ]);
      /** @type {{ client: import('@modelcontextprotocol/sdk/client/index.js').Client }} The connected MCP client. */
      const { client } = await harness.connectClient();
      await expect.poll(() => harness.toolNames(client), { timeout: 1000 }).toContain('draw_table');
      /** @type {{ tools: Array<{ name: string, annotations?: object }> }} The tools the session lists. */
      const { tools } = await client.listTools();
      for (const name of [
         'draw_table',
         'roll',
      ]) {
         expect(tools.find((tool) => tool.name === name).annotations).toMatchObject({ readOnlyHint: false });
      }
      const result = await client.callTool({
         name: 'roll',
         arguments: {
            formula: '2d6',
            toChat: true,
         },
      });
      expect(JSON.parse(textOf(result))).toEqual(rolled);
      expect(gm.invokes[0].op).toBe(OP_CALL_TOOL);
      expect(gm.invokes[0].params).toEqual({
         name: 'roll',
         arguments: {
            formula: '2d6',
            toChat: true,
         },
      });
      await client.callTool({
         name: 'draw_table',
         arguments: {
            uuid: 'RollTable.MOCKTABLE0000001',
            toChat: false,
         },
      });
      expect(gm.invokes[1].params).toEqual({
         name: 'draw_table',
         arguments: {
            uuid: 'RollTable.MOCKTABLE0000001',
            toChat: false,
         },
      });
   });

   it('refuses a formula over 256 characters before anything is sent', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      await gm.register([
         ...shippedScripts(),
         rollDefinition,
         drawTableDefinition,
      ]);
      /** @type {{ client: import('@modelcontextprotocol/sdk/client/index.js').Client }} The connected MCP client. */
      const { client } = await harness.connectClient();
      await expect.poll(() => harness.toolNames(client), { timeout: 1000 }).toContain('roll');
      const refused = await client.callTool({
         name: 'roll',
         arguments: { formula: '1'.repeat(257) },
      });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain('formula');
      expect(gm.invokes).toHaveLength(0);
   });
});
