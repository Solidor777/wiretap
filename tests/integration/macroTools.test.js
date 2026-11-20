// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { closedGateState } from '../../shared/gates.js';
import { OP_CALL_TOOL } from '../../shared/protocol.js';
import { executeMacroDefinition } from '../../src/bridge/scripts/macroDefinitions.js';
import { shippedScripts } from '../unit/scriptFixtures.js';
import { createHarness } from './mcpHarness.js';

/** @type {{ uuid: string, actorUuid: string, tokenUuid: string }} Arguments naming a macro, an actor and a token. */
const ARGUMENTS = {
   uuid: 'Macro.MOCKMACRO0000001',
   actorUuid: 'Actor.MOCKACTOR0000001',
   tokenUuid: 'Scene.MOCKSCENE0000001.Token.MOCKTOKEN0000001',
};

/**
 * Read the text of the first content item of a tool result.
 * @param {{ content: { type: string, text?: string }[] }} result - The tool result.
 * @returns {string} The text of that item.
 */
function textOf(result) {
   return result.content[0].text;
}

describe('execute_macro over the bridge', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   /**
    * Start the harness with one fake GM client that registers the shipped scripts and `execute_macro`, and an MCP
    * client.
    * @returns {Promise<{ gm: Awaited<ReturnType<ReturnType<typeof createHarness>['connectGm']>>, client: object }>}
    * The fake client and the MCP client.
    */
   async function connect() {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({
         answer: () => ({
            ok: true,
            result: {
               type: 'script',
               value: 5,
            },
         }),
      });
      await gm.register([
         ...shippedScripts(),
         structuredClone(executeMacroDefinition),
      ]);
      const { client } = await harness.connectClient();
      return {
         gm,
         client,
      };
   }

   it(
      'refuses execute_macro with GATE_DENIED while the endpoint snapshot has the gate closed, sending nothing',
      async () => {
         const { gm, client } = await connect();
         await gm.pushGates(closedGateState());
         const result = await client.callTool({
            name: 'execute_macro',
            arguments: ARGUMENTS,
         });
         expect(result.isError).toBe(true);
         expect(textOf(result)).toMatch(/^GATE_DENIED: .*allowMacroExecution/);
         expect(gm.invokes).toHaveLength(0);
      },
   );

   it('forwards execute_macro once the endpoint pushes allowMacroExecution open', async () => {
      const { gm, client } = await connect();
      await gm.pushGates({
         ...closedGateState(),
         allowMacroExecution: true,
      });
      const result = await client.callTool({
         name: 'execute_macro',
         arguments: ARGUMENTS,
      });
      expect(JSON.parse(textOf(result))).toEqual({
         type: 'script',
         value: 5,
      });
      expect(gm.invokes.length).toBe(1);
      expect(gm.invokes[0].op).toBe(OP_CALL_TOOL);
      expect(gm.invokes[0].params.arguments).toEqual(ARGUMENTS);
   });

   it('refuses an undeclared argument before anything is sent', async () => {
      const { gm, client } = await connect();
      await gm.pushGates({
         ...closedGateState(),
         allowMacroExecution: true,
      });
      const refused = await client
         .callTool({
            name: 'execute_macro',
            arguments: {
               uuid: ARGUMENTS.uuid,
               actor: 'x',
            },
         })
         .catch((error) => error);
      expect(refused.isError).toBe(true);
      expect(gm.invokes).toHaveLength(0);
   });
});
