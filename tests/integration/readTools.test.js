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

/**
 * Parse the issues of an MCP input-validation refusal, whose text is the error code and tool name followed by the
 * issues as JSON.
 * @param {{ content: { type: string, text?: string }[] }} result - The refused tool result.
 * @param {string} tool - The tool name the refusal must name.
 * @returns {Array<{ code: string, path: Array<string | number> }>} The validation issues.
 */
function issuesOf(result, tool) {
   /** @type {string} The prefix of every input-validation refusal. */
   const prefix = `MCP error -32602: Input validation error: Invalid arguments for tool ${tool}: `;
   /** @type {string} The refusal text. */
   const text = textOf(result);
   expect(text.startsWith(prefix)).toBe(true);
   return JSON.parse(text.slice(prefix.length));
}

/**
 * Build the export of a synthetic actor whose JSON is about 12 KB.
 * @returns {object} An export with one 12,000-character field.
 */
function bigExport() {
   return {
      uuid: 'Actor.MOCKACTOR0000001',
      name: 'MOCK_ACTOR',
      notes: 'n'.repeat(12000),
   };
}

describe('the core read tools over the bridge', () => {
   /** @type {ReturnType<typeof createHarness>} The harness of the running test. */
   let harness;

   afterEach(async () => {
      await harness.cleanup();
   });

   it('lists the read tools as read-only and the write tools as mutating; get_document declares maxBytes', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      await gm.register(shippedScripts());
      /** @type {{ client: import('@modelcontextprotocol/sdk/client/index.js').Client }} The connected MCP client. */
      const { client } = await harness.connectClient();
      await expect.poll(() => harness.toolNames(client), { timeout: 1000 }).toEqual([
         'backup_documents',
         'batch',
         'close_sheet',
         'create_documents',
         'create_pack',
         'delete_backup',
         'delete_documents',
         'delete_pack',
         'describe_schema',
         'draw_table',
         'execute_macro',
         'get_document',
         'list_backups',
         'list_document_types',
         'open_sheet',
         'read_handle',
         'replace_document',
         'restore_backup',
         'roll',
         'search_documents',
         'update_documents',
      ]);
      /** @type {{ tools: Array<{ name: string }> }} The tools the session lists. */
      const { tools } = await client.listTools();
      for (const name of [
         'close_sheet',
         'describe_schema',
         'get_document',
         'list_document_types',
         'open_sheet',
         'search_documents',
      ]) {
         expect(tools.find((tool) => tool.name === name).annotations).toMatchObject({ readOnlyHint: true });
      }
      for (const name of [
         'batch',
         'create_documents',
         'create_pack',
         'delete_documents',
         'delete_pack',
         'draw_table',
         'execute_macro',
         'replace_document',
         'roll',
         'update_documents',
      ]) {
         expect(tools.find((tool) => tool.name === name).annotations).toMatchObject({ readOnlyHint: false });
      }
      const get = tools.find((tool) => tool.name === 'get_document');
      expect(get.inputSchema.properties.maxBytes).toMatchObject({
         type: 'integer',
         maximum: 16000,
      });
   });

   it('sends the validated arguments to the client as a callTool op and returns its compact view', async () => {
      harness = createHarness();
      await harness.start();
      const view = {
         uuid: 'Actor.MOCKACTOR0000001',
         name: 'MOCK_ACTOR',
         type: 'npc',
      };
      const gm = await harness.connectGm({
         answer: () => ({
            ok: true,
            result: view,
         }),
      });
      await gm.register(shippedScripts());
      /** @type {{ client: import('@modelcontextprotocol/sdk/client/index.js').Client }} The connected MCP client. */
      const { client } = await harness.connectClient();
      const result = await client.callTool({
         name: 'get_document',
         arguments: {
            uuid: 'Actor.MOCKACTOR0000001',
            paths: ['system.hp'],
            ifChanged: 'abc',
         },
      });
      expect(JSON.parse(textOf(result))).toEqual(view);
      expect(gm.invokes[0].op).toBe(OP_CALL_TOOL);
      expect(gm.invokes[0].params).toEqual({
         name: 'get_document',
         arguments: {
            uuid: 'Actor.MOCKACTOR0000001',
            paths: ['system.hp'],
            ifChanged: 'abc',
         },
      });
   });

   it('refuses ifModifiedSince before the client is called', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      await gm.register(shippedScripts());
      /** @type {{ client: import('@modelcontextprotocol/sdk/client/index.js').Client }} The connected MCP client. */
      const { client } = await harness.connectClient();
      const refused = await client
         .callTool({
            name: 'get_document',
            arguments: {
               uuid: 'Actor.MOCKACTOR0000001',
               ifModifiedSince: 12,
            },
         })
         .catch((error) => error);
      expect(refused.isError).toBe(true);
      expect(gm.invokes).toHaveLength(0);
   });

   it('refuses a bad argument before the client is called', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm();
      await gm.register(shippedScripts());
      /** @type {{ client: import('@modelcontextprotocol/sdk/client/index.js').Client }} The connected MCP client. */
      const { client } = await harness.connectClient();
      const tooMany = await client
         .callTool({
            name: 'get_document',
            arguments: {
               uuid: 'Actor.MOCKACTOR0000001',
               // One past the item bound every shipped list schema declares.
               paths: Array.from({ length: 1001 }, (_, index) => `p${index}`),
            },
         })
         .catch((error) => error);
      expect(tooMany.isError).toBe(true);
      expect(issuesOf(tooMany, 'get_document')).toMatchObject([
         {
            code: 'too_big',
            path: ['paths'],
         },
      ]);
      const overCap = await client
         .callTool({
            name: 'get_document',
            arguments: {
               uuid: 'Actor.MOCKACTOR0000001',
               maxBytes: 16001,
            },
         })
         .catch((error) => error);
      expect(overCap.isError).toBe(true);
      expect(issuesOf(overCap, 'get_document')).toMatchObject([
         {
            code: 'too_big',
            path: ['maxBytes'],
         },
      ]);
      expect(gm.invokes).toHaveLength(0);
   });

   it('returns a handle for a full read over the default cap and inline with maxBytes 16000', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({
         answer: () => ({
            ok: true,
            result: bigExport(),
         }),
      });
      await gm.register(shippedScripts());
      /** @type {{ client: import('@modelcontextprotocol/sdk/client/index.js').Client }} The connected MCP client. */
      const { client } = await harness.connectClient();
      const atDefault = await client.callTool({
         name: 'get_document',
         arguments: {
            uuid: 'Actor.MOCKACTOR0000001',
            mode: 'full',
         },
      });
      const handle = JSON.parse(textOf(atDefault));
      expect(handle).toEqual({
         handle: expect.any(String),
         bytes: expect.any(Number),
         summary: expect.any(Object),
      });
      expect(new TextEncoder().encode(textOf(atDefault)).length).toBeLessThanOrEqual(256);
      const sliced = await client.callTool({
         name: 'read_handle',
         arguments: {
            handle: handle.handle,
            paths: ['name'],
         },
      });
      expect(textOf(sliced)).toContain('MOCK_ACTOR');
      const inline = await client.callTool({
         name: 'get_document',
         arguments: {
            uuid: 'Actor.MOCKACTOR0000001',
            mode: 'full',
            maxBytes: 16000,
         },
      });
      expect(JSON.parse(textOf(inline)).notes).toHaveLength(12000);
   });

   it('returns a client error such as DOC_EXCLUDED as <code>: <message>', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({
         answer: () => ({
            ok: false,
            error: {
               code: 'DOC_EXCLUDED',
               message: 'Settings in the wiretap namespace are not readable.',
            },
         }),
      });
      await gm.register(shippedScripts());
      /** @type {{ client: import('@modelcontextprotocol/sdk/client/index.js').Client }} The connected MCP client. */
      const { client } = await harness.connectClient();
      const result = await client.callTool({
         name: 'get_document',
         arguments: { uuid: 'Setting.MOCKSETTING00001' },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('DOC_EXCLUDED: Settings in the wiretap namespace are not readable.');
   });

   it('forwards search_documents and describe_schema arguments and refuses what their schemas bound', async () => {
      harness = createHarness();
      await harness.start();
      const gm = await harness.connectGm({
         answer: () => ({
            ok: true,
            result: {
               rows: [],
               total: 0,
            },
         }),
      });
      await gm.register(shippedScripts());
      /** @type {{ client: import('@modelcontextprotocol/sdk/client/index.js').Client }} The connected MCP client. */
      const { client } = await harness.connectClient();
      const result = await client.callTool({
         name: 'search_documents',
         arguments: {
            documentName: 'Actor',
            filters: Array.from({ length: 6 }, () => 'system.rarity=common'),
            fields: [`system.${'f'.repeat(65)}`],
            cursor: 'c'.repeat(513),
            limit: 150,
         },
      });
      expect(JSON.parse(textOf(result))).toEqual({
         rows: [],
         total: 0,
      });
      expect(gm.invokes[0].params).toEqual({
         name: 'search_documents',
         arguments: {
            documentName: 'Actor',
            filters: Array.from({ length: 6 }, () => 'system.rarity=common'),
            fields: [`system.${'f'.repeat(65)}`],
            cursor: 'c'.repeat(513),
            limit: 150,
         },
      });
      const before = gm.invokes.length;
      for (const [name, args, issue] of [
         [
            'search_documents',
            {
               documentName: 'Actor',
               limit: 0,
            },
            {
               code: 'too_small',
               path: ['limit'],
            },
         ],
         [
            'search_documents',
            {
               documentName: 'Actor',
               maxBytes: 16000,
            },
            {
               code: 'unrecognized_keys',
               path: [],
            },
         ],
         [
            'search_documents',
            {},
            {
               code: 'invalid_type',
               path: ['documentName'],
            },
         ],
         [
            'describe_schema',
            {
               documentName: 'Actor',
               path: 'p'.repeat(513),
            },
            {
               code: 'too_big',
               path: ['path'],
            },
         ],
         [
            'describe_schema',
            {},
            {
               code: 'invalid_type',
               path: ['documentName'],
            },
         ],
      ]) {
         const refused = await client.callTool({
            name,
            arguments: args,
         });
         expect(refused.isError, name).toBe(true);
         expect(issuesOf(refused, name), name).toMatchObject([issue]);
      }
      expect(gm.invokes).toHaveLength(before);
      const described = await client.callTool({
         name: 'describe_schema',
         arguments: {
            documentName: 'Actor',
            subtype: 'player',
            path: 'system.attributes',
         },
      });
      expect(described.isError).toBeUndefined();
      expect(gm.invokes.at(-1).params.arguments).toEqual({
         documentName: 'Actor',
         subtype: 'player',
         path: 'system.attributes',
      });
   });
});
