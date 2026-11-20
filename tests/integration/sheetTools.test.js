// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { OP_CALL_TOOL } from '../../shared/protocol.js';
import { closeSheetDefinition, openSheetDefinition } from '../../src/bridge/scripts/sheetDefinitions.js';
import { shippedScripts } from '../unit/scriptFixtures.js';
import { createHarness } from './mcpHarness.js';

/** @type {string} The uuid the calls name. */
const uuid = 'Actor.MOCKACTOR0000001';

/** @type {string} The connected user the calls name. */
const userId = 'MOCKPLAYER000001';

describe('open_sheet and close_sheet over the bridge', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   /**
    * Start the harness with one fake GM client that registers the shipped scripts and both sheet tools, and an MCP
    * client.
    * @returns {Promise<{ gm: Awaited<ReturnType<ReturnType<typeof createHarness>['connectGm']>>, client: object }>}
    * The fake client and the MCP client.
    */
   async function connect() {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({
         answer: (request) => ({
            ok: true,
            result: request.params.name === 'open_sheet'
               ? {
                  ok: true,
                  appId: 'MockSheet-Actor-MOCKACTOR0000001',
               }
               : {
                  ok: true,
                  closed: true,
               },
         }),
      });
      await gm.register([
         ...shippedScripts(),
         openSheetDefinition,
         closeSheetDefinition,
      ]);
      const { client } = await harness.connectClient();
      return {
         gm,
         client,
      };
   }

   it('lists open_sheet and close_sheet as read-only and forwards their arguments as a callTool op', async () => {
      const { gm, client } = await connect();
      const { tools } = await client.listTools();
      for (const name of [
         'open_sheet',
         'close_sheet',
      ]) {
         expect(tools.find((tool) => tool.name === name).annotations).toMatchObject({ readOnlyHint: true });
      }
      const opened = await client.callTool({
         name: 'open_sheet',
         arguments: {
            uuid,
            userId,
         },
      });
      expect(JSON.parse(opened.content[0].text)).toEqual({
         ok: true,
         appId: 'MockSheet-Actor-MOCKACTOR0000001',
      });
      await client.callTool({
         name: 'close_sheet',
         arguments: {
            uuid,
            userId,
         },
      });
      expect(gm.invokes[0].op).toBe(OP_CALL_TOOL);
      expect(gm.invokes[0].params).toEqual({
         name: 'open_sheet',
         arguments: {
            uuid,
            userId,
         },
      });
      expect(gm.invokes[1].params).toEqual({
         name: 'close_sheet',
         arguments: {
            uuid,
            userId,
         },
      });
   });

   it('refuses a userId over 16 characters on either tool before anything is sent', async () => {
      const { gm, client } = await connect();
      for (const name of [
         'open_sheet',
         'close_sheet',
      ]) {
         const refused = await client
            .callTool({
               name,
               arguments: {
                  uuid,
                  userId: 'M'.repeat(17),
               },
            })
            .catch((error) => error);
         expect(refused.isError, name).toBe(true);
      }
      expect(gm.invokes).toHaveLength(0);
   });

   it('refuses an undeclared argument before anything is sent', async () => {
      const { gm, client } = await connect();
      for (const name of [
         'open_sheet',
         'close_sheet',
      ]) {
         const refused = await client
            .callTool({
               name,
               arguments: {
                  uuid,
                  broadcast: true,
               },
            })
            .catch((error) => error);
         expect(refused.isError, name).toBe(true);
      }
      expect(gm.invokes).toHaveLength(0);
   });
});
