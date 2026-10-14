// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { OP_CALL_TOOL } from '../../shared/protocol.js';
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

describe('replace_document, batch, actAs and idempotencyKey over the bridge', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   /**
    * Start the harness with one fake GM client and an MCP client.
    * @param {(request: object) => object} answer - How the fake GM client answers an invoke.
    * @returns {Promise<{ gm: Awaited<ReturnType<ReturnType<typeof createHarness>['connectGm']>>, client: object }>}
    * The fake client and the MCP client.
    */
   async function connect(answer) {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({ answer });
      await gm.register(shippedScripts());
      const { client } = await harness.connectClient();
      return {
         gm,
         client,
      };
   }

   it('sends replace_document arguments, actAs included, as a callTool op and returns the ack', async () => {
      const { gm, client } = await connect(() => ({
         ok: true,
         result: {
            uuid: 'Actor.MOCKACTOR0000001',
            changed: ['name'],
         },
      }));
      const result = await client.callTool({
         name: 'replace_document',
         arguments: {
            uuid: 'Actor.MOCKACTOR0000001',
            data: '{"name":"MOCK_X","type":"npc"}',
            actAs: 'MOCKUSER00000001',
         },
      });
      expect(JSON.parse(textOf(result))).toEqual({
         uuid: 'Actor.MOCKACTOR0000001',
         changed: ['name'],
      });
      expect(gm.invokes[0].op).toBe(OP_CALL_TOOL);
      expect(gm.invokes[0].params).toEqual({
         name: 'replace_document',
         arguments: {
            uuid: 'Actor.MOCKACTOR0000001',
            data: '{"name":"MOCK_X","type":"npc"}',
            actAs: 'MOCKUSER00000001',
         },
      });
   });

   it('sends batch arguments and returns the rows by kind', async () => {
      const ack = {
         created: [],
         updated: [],
         deleted: [{
            uuid: 'Actor.MOCKACTOR0000001',
            name: 'MOCK_ACTOR',
            type: 'npc',
         }],
      };
      const { gm, client } = await connect(() => ({
         ok: true,
         result: ack,
      }));
      const result = await client.callTool({
         name: 'batch',
         arguments: { deletes: ['Actor.MOCKACTOR0000001'] },
      });
      expect(JSON.parse(textOf(result))).toEqual(ack);
      expect(gm.invokes[0].params).toEqual({
         name: 'batch',
         arguments: { deletes: ['Actor.MOCKACTOR0000001'] },
      });
   });

   it('refuses an idempotencyKey over 64 characters before the client is called', async () => {
      const { gm, client } = await connect(() => ({
         ok: true,
         result: [],
      }));
      const refused = await client
         .callTool({
            name: 'create_documents',
            arguments: {
               documentName: 'Actor',
               data: ['{"name":"MOCK_A"}'],
               idempotencyKey: 'k'.repeat(65),
            },
         })
         .catch((error) => error);
      expect(refused.isError).toBe(true);
      expect(gm.invokes).toHaveLength(0);
   });

   it('shows the code and message of an ACT_AS_DENIED refusal', async () => {
      const { client } = await connect(() => ({
         ok: false,
         error: {
            code: 'ACT_AS_DENIED',
            message: "MOCK_player may not update 'MOCK_actor'; nothing was written (advisory actAs check).",
         },
      }));
      const result = await client.callTool({
         name: 'update_documents',
         arguments: {
            updates: [{
               uuid: 'Actor.MOCKACTOR0000001',
               path: 'name',
               value: '"MOCK_X"',
            }],
            actAs: 'MOCKPLAYER00001',
         },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/^ACT_AS_DENIED: MOCK_player may not update/);
   });

   it.each([
      'IDEMPOTENCY_CONFLICT',
      'WRITE_NOT_APPLIED',
   ])('shows %s as a code with its message', async (code) => {
      const { client } = await connect(() => ({
         ok: false,
         error: {
            code,
            message: 'MOCK_message',
         },
      }));
      const result = await client.callTool({
         name: 'batch',
         arguments: { deletes: ['Actor.MOCKACTOR0000001'] },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(`${code}: MOCK_message`);
   });
});

describe('undeclared keys in batch entries over the bridge', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   it('refuses a misspelled entry key before the client sees the call', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({
         answer: () => ({
            ok: true,
            result: { created: [] },
         }),
      });
      await gm.register(shippedScripts());
      const { client } = await harness.connectClient();
      for (const [list, entry] of [
         [
            'creates',
            {
               documentName: 'Item',
               data: '{"name":"MOCK_item"}',
               parent: 'Actor.MOCKACTOR0000001',
            },
         ],
         [
            'updates',
            {
               uuid: 'Actor.MOCKACTOR0000001',
               path: 'name',
               vlaue: '"MOCK_x"',
            },
         ],
      ]) {
         const before = gm.invokes.length;
         const result = await client.callTool({
            name: 'batch',
            arguments: { [list]: [entry] },
         });
         expect(result.isError, list).toBe(true);
         expect(gm.invokes.length, list).toBe(before);
      }
   });
});

describe('handle inputs over the bridge', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   /** @type {string} A document, as the JSON text a full read returns. */
   const DOCUMENT = JSON.stringify({
      name: 'MOCK_big_actor',
      type: 'npc',
      system: { notes: 'x'.repeat(20_000) },
   });

   /**
    * Start the harness; the fake GM client answers a full read with the document and anything else with an ack.
    * @returns {Promise<{ gm: object, client: object, handle: string }>} The fake client, the MCP client that read the
    * document and the handle that read stored.
    */
   async function connectWithHandle() {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({
         answer: (request) => ({
            ok: true,
            result: request.params.name === 'get_document' ? JSON.parse(DOCUMENT) : { ok: 'MOCK_ack' },
         }),
      });
      await gm.register(shippedScripts());
      const { client } = await harness.connectClient();
      const read = await client.callTool({
         name: 'get_document',
         arguments: {
            uuid: 'Actor.MOCKACTOR0000001',
            mode: 'full',
         },
      });
      return {
         gm,
         client,
         handle: JSON.parse(textOf(read)).handle,
      };
   }

   it('sends the stored document to the client in place of the reference, for create_documents', async () => {
      const { gm, client, handle } = await connectWithHandle();
      await client.callTool({
         name: 'create_documents',
         arguments: {
            documentName: 'Actor',
            data: [`handle:${handle}`],
         },
      });
      const sent = gm.invokes.at(-1).params;
      expect(sent.name).toBe('create_documents');
      expect(sent.arguments.data).toEqual([DOCUMENT]);
   });

   it('sends the stored document for replace_document, also on a dry run', async () => {
      const { gm, client, handle } = await connectWithHandle();
      await client.callTool({
         name: 'replace_document',
         arguments: {
            uuid: 'Actor.MOCKACTOR0000001',
            data: `handle:${handle}`,
            dryRun: true,
         },
      });
      const sent = gm.invokes.at(-1).params;
      expect(sent.arguments).toEqual({
         uuid: 'Actor.MOCKACTOR0000001',
         data: DOCUMENT,
         dryRun: true,
      });
   });

   it('refuses another session handle with HANDLE_NOT_FOUND and sends nothing', async () => {
      const { gm, handle } = await connectWithHandle();
      const second = await harness.connectClient();
      const before = gm.invokes.length;
      const refused = await second.client.callTool({
         name: 'create_documents',
         arguments: {
            documentName: 'Actor',
            data: [`handle:${handle}`],
         },
      });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toMatch(/^HANDLE_NOT_FOUND: /);
      expect(gm.invokes).toHaveLength(before);
   });

   it('refuses a handle that does not hold one document with HANDLE_NOT_DOCUMENT', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({
         answer: () => ({
            ok: true,
            result: ['x'.repeat(20_000)],
         }),
      });
      await gm.register(shippedScripts());
      const { client } = await harness.connectClient();
      const read = await client.callTool({
         name: 'search_documents',
         arguments: { documentName: 'Actor' },
      });
      const { handle } = JSON.parse(textOf(read));
      const before = gm.invokes.length;
      const refused = await client.callTool({
         name: 'create_documents',
         arguments: {
            documentName: 'Actor',
            data: [`handle:${handle}`],
         },
      });
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toMatch(/^HANDLE_NOT_DOCUMENT: /);
      expect(gm.invokes).toHaveLength(before);
   });
});
