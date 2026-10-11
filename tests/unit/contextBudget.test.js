// @vitest-environment node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { getBudget } from '../../shared/budgets.js';
import {
   FIXTURES,
   HELPER_TOOL_NAME,
   collectReport,
   findToolMentions,
   makeBigDocument,
   startHarness,
   textBytes,
   trivialFixture,
} from './contextBudgetHarness.js';

/** @type {number} Counter that makes each scratch skills root unique within this process. */
let scratchCounter = 0;

/**
 * Build a test-local tool registration whose handler answers with a short text.
 * @param {string} name - The MCP tool name to register.
 * @param {string} description - The text the client lists for the tool.
 * @param {import('zod').ZodRawShape} [inputSchema] - The argument shape; every field must be optional.
 * @returns {import('../../server/mcp.ts').ToolRegistration} The registration.
 */
function makeTool(name, description, inputSchema = {}) {
   return {
      name,
      description,
      inputSchema,
      handler: async () => ({
         content: [
            {
               type: 'text',
               text: 'ok',
            },
         ],
      }),
   };
}

/**
 * Build an argument shape of optional string fields with long descriptions.
 * @param {number} fields - How many fields.
 * @param {number} descriptionChars - The description length of each field.
 * @returns {import('zod').ZodRawShape} Fields named field0, field1 and so on.
 */
function makeShape(fields, descriptionChars) {
   return Object.fromEntries(
      Array.from({ length: fields }, (_, index) => [
         `field${index}`,
         z.string().optional().describe('x'.repeat(descriptionChars)),
      ]),
   );
}

describe('context budgets of the real MCP server', () => {
   /** @type {Awaited<ReturnType<typeof startHarness>> | undefined} The running harness. */
   let harness;

   afterEach(async () => {
      await harness?.close();
      harness = undefined;
   });

   /**
    * Start a harness with extra tools and report on it against the production fixtures plus extra ones.
    * @param {import('../../server/mcp.ts').ToolRegistration[]} extraTools - Tools to register.
    * @param {Record<string, import('./contextBudgetHarness.js').FixtureCase[]>} [extraFixtures] - Their fixtures.
    * @param {string} [skillsRoot] - The skills directory to scan.
    * @param {string} [instructions] - The server instructions text.
    * @returns {Promise<import('./contextBudgetHarness.js').BudgetReport>} The measured breaches and sizes.
    */
   async function reportWith(extraTools, extraFixtures = {}, skillsRoot, instructions) {
      harness = await startHarness({
         tools: extraTools,
         instructions,
      });
      return collectReport({
         client: harness.client,
         setGmAck: harness.setGmAck,
         fixtures: {
            ...FIXTURES,
            ...extraFixtures,
         },
         skillsRoot,
      });
   }

   it('keeps the listed production tools and their fixtures inside every budget', async () => {
      const report = await reportWith([]);
      for (const warning of report.warnings) {
         console.warn(`context budget warning | ${warning}`);
      }
      expect(report.failures).toEqual([]);
      expect(report.listing.map((tool) => tool.name).sort()).toEqual([
         'create_actor',
         HELPER_TOOL_NAME,
         'read_handle',
      ]);
      expect(report.totals.count).toBe(2);
      expect(report.helperTotals.count).toBe(1);
      expect(report.fixtureRuns.length).toBeGreaterThanOrEqual(8);
   });

   it('keeps a create_actor ack at its bound inside the acknowledgement budget', async () => {
      harness = await startHarness();
      harness.setGmAck({
         ok: true,
         result: {
            uuid: `Actor.${'U'.repeat(250)}`,
            name: 'N'.repeat(256),
            type: 'T'.repeat(256),
         },
      });
      const result = await harness.client.callTool({
         name: 'create_actor',
         arguments: { name: 'MOCK_ACTOR' },
      });
      expect(textBytes(result)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
   });

   it('turns an over-cap result into a handle of at most 256 bytes and serves slices within the cap', async () => {
      harness = await startHarness();
      /** @type {string} The original serialized document. */
      const original = JSON.stringify(makeBigDocument());
      expect(Buffer.byteLength(original)).toBeGreaterThan(getBudget('RESULT_HARD_CAP_DEFAULT_BYTES').value);
      const big = await harness.client.callTool({
         name: HELPER_TOOL_NAME,
         arguments: {},
      });
      expect(textBytes(big)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
      const { handle } = JSON.parse(big.content[0].text);
      for (const offset of [
         0,
         5000,
         original.length - 10,
      ]) {
         const page = await harness.client.callTool({
            name: 'read_handle',
            arguments: {
               handle,
               offset,
            },
         });
         expect(page.isError).toBeFalsy();
         expect(textBytes(page)).toBeLessThanOrEqual(getBudget('RESULT_HARD_CAP_DEFAULT_BYTES').value);
         expect(page.content[0].text).toBe(original.slice(offset, offset + page.content[0].text.length));
      }
   });

   it('finds the tools a text mentions as mcp__wiretap__<tool>', () => {
      /** @type {string} Text that names one tool twice and another once. */
      const text = 'Use mcp__wiretap__read_handle, then mcp__wiretap__read_handle or mcp__wiretap__x1.';
      expect(findToolMentions(text)).toEqual([
         'read_handle',
         'x1',
      ]);
      expect(findToolMentions('read_handle without the prefix')).toEqual([]);
      expect(findToolMentions('mcp__wiretap__a-b_c1 and mcp__wiretap__read_handle-, mcp__wiretap__x.')).toEqual([
         'a-b_c1',
         'read_handle',
         'x',
      ]);
   });

   it('accepts a skills directory whose tool mentions all exist and none when the directory is absent', async () => {
      /** @type {string} A unique scratch root for this test. */
      const root = path.join('test', 'tmp', `contextBudget-${Date.now()}-${process.pid}-${(scratchCounter += 1)}`);
      expect(fs.existsSync(root)).toBe(false);
      fs.mkdirSync(path.join(root, 'wiretap'), { recursive: true });
      fs.writeFileSync(path.join(root, 'wiretap', 'SKILL.md'), 'Read big results with mcp__wiretap__read_handle.');
      expect((await reportWith([], {}, root)).failures).toEqual([]);
      await harness.close();
      harness = undefined;
      expect((await reportWith([], {}, path.join(root, 'absent'))).failures).toEqual([]);
   });

   it('fails when a shipped skill mentions a tool that is not listed', async () => {
      /** @type {string} A unique scratch root for this test. */
      const root = path.join('test', 'tmp', `contextBudget-${Date.now()}-${process.pid}-${(scratchCounter += 1)}`);
      expect(fs.existsSync(root)).toBe(false);
      fs.mkdirSync(path.join(root, 'wiretap'), { recursive: true });
      fs.writeFileSync(path.join(root, 'wiretap', 'SKILL.md'), 'Call mcp__wiretap__no_such_tool first.');
      const report = await reportWith([], {}, root);
      expect(report.failures).toEqual([
         `skill ${path.join('wiretap', 'SKILL.md')}: mentions unknown tool "no_such_tool"`,
      ]);
   });

   describe('fails on a deliberately oversized test-local registry', () => {
      it('fails a description over the hard maximum', async () => {
         const report = await reportWith(
            [makeTool('test_long_description', 'd'.repeat(241))],
            { test_long_description: trivialFixture('test_long_description') },
         );
         expect(report.failures).toEqual([
            'tool "test_long_description": description is 241 chars, at most 240 chars (DESCRIPTION_MAX_CHARS)',
         ]);
      });

      it('only warns for a description over the target and within the hard maximum', async () => {
         const report = await reportWith(
            [makeTool('test_warn_description', 'd'.repeat(161))],
            { test_warn_description: trivialFixture('test_warn_description') },
         );
         expect(report.failures).toEqual([]);
         expect(report.warnings).toEqual([
            'tool "test_warn_description": description is 161 chars, at most 160 chars (DESCRIPTION_TARGET_CHARS)',
         ]);
      });

      it('fails a name over the core name maximum', async () => {
         const name = 'n'.repeat(33);
         const report = await reportWith([makeTool(name, 'Short.')], { [name]: trivialFixture(name) });
         expect(report.failures).toEqual([
            `tool "${name}": name is 33 chars, at most 32 chars (CORE_TOOL_NAME_MAX_CHARS)`,
         ]);
      });

      it('fails a definition over the byte maximum through its schema', async () => {
         const report = await reportWith(
            [makeTool('test_big_schema', 'Short.', makeShape(12, 40))],
            { test_big_schema: trivialFixture('test_big_schema') },
         );
         expect(report.failures).toHaveLength(1);
         expect(report.failures[0]).toMatch(
            /^tool "test_big_schema": definition is \d+ bytes, at most 800 bytes \(DEFINITION_MAX_BYTES\)$/,
         );
      });

      it('fails a 31st tool', async () => {
         /** @type {number} The tools the module ships, which the helper tool does not add to. */
         const shipped = (await reportWith([])).totals.count;
         await harness.close();
         harness = undefined;
         /** @type {number} Fillers that bring the counted tools to one over the maximum. */
         const fillers = getBudget('ALWAYS_LISTED_TOOLS_MAX').value - shipped + 1;
         /** @type {Record<string, import('./contextBudgetHarness.js').FixtureCase[]>} Fixtures of the fillers. */
         const fixtures = {};
         const extra = Array.from({ length: fillers }, (_, index) => {
            const name = `test_filler_${index}`;
            fixtures[name] = trivialFixture(name);
            return makeTool(name, 'Short.');
         });
         const report = await reportWith(extra, fixtures);
         expect(report.totals.count).toBe(31);
         expect(report.failures).toEqual(['tool list: tool count is 31, at most 30 (ALWAYS_LISTED_TOOLS_MAX)']);
      });

      it('does not count the helper tool toward the tool count, but counts the tools under test', async () => {
         /** @type {number} The tools the module ships. */
         const shipped = (await reportWith([])).totals.count;
         await harness.close();
         harness = undefined;
         /** @type {number} Fillers that bring the counted tools exactly to the maximum. */
         const fillers = getBudget('ALWAYS_LISTED_TOOLS_MAX').value - shipped;
         /** @type {Record<string, import('./contextBudgetHarness.js').FixtureCase[]>} Fixtures of the fillers. */
         const fixtures = {};
         const extra = Array.from({ length: fillers }, (_, index) => {
            const name = `test_filler_${index}`;
            fixtures[name] = trivialFixture(name);
            return makeTool(name, 'Short.');
         });
         const report = await reportWith(extra, fixtures);
         expect(report.listing).toHaveLength(31);
         expect(report.totals.count).toBe(30);
         expect(report.helperTotals.count).toBe(1);
         expect(report.failures).toEqual([]);
      });

      it('fails when all definitions together exceed their total', async () => {
         /** @type {Record<string, import('./contextBudgetHarness.js').FixtureCase[]>} Fixtures of the tools. */
         const fixtures = {};
         const extra = Array.from({ length: 26 }, (_, index) => {
            const name = `test_total_${index}`;
            fixtures[name] = trivialFixture(name);
            return makeTool(name, 'd'.repeat(240), makeShape(3, 60));
         });
         const report = await reportWith(extra, fixtures);
         expect(report.failures).toHaveLength(1);
         expect(report.failures[0]).toMatch(
            /^tool list: total definition size is \d+ bytes, at most 16000 bytes \(ALL_DEFINITIONS_MAX_BYTES\)$/,
         );
      });

      it('fails a tool that has no representative-result fixture', async () => {
         const report = await reportWith([makeTool('test_no_fixture', 'Short.')]);
         expect(report.failures).toEqual(['tool "test_no_fixture": no representative-result fixture']);
      });

      it('fails a fixture result over its budget', async () => {
         const tool = makeTool('test_big_answer', 'Short.');
         tool.handler = async () => ({
            content: [
               {
                  type: 'text',
                  text: 'a'.repeat(300),
               },
            ],
         });
         const report = await reportWith(
            [tool],
            { test_big_answer: trivialFixture('test_big_answer') },
         );
         expect(report.failures).toEqual([
            'tool "test_big_answer" fixture "short answer": result is 300 bytes, at most 256 bytes (ACK_MAX_BYTES)',
         ]);
      });
   });
   describe('server instructions', () => {
      it('accepts instructions that name a listed tool', async () => {
         const report = await reportWith([], {}, undefined, 'Read stored results with mcp__wiretap__read_handle.');
         expect(report.failures).toEqual([]);
         expect(harness.client.getInstructions()).toBe('Read stored results with mcp__wiretap__read_handle.');
      });

      it('fails instructions that name a tool that is not listed', async () => {
         const report = await reportWith([], {}, undefined, 'Use mcp__wiretap__no_such_tool.');
         expect(report.failures).toEqual(['server instructions: mentions unknown tool "no_such_tool"']);
      });

      it('accepts instructions of exactly the maximum length and fails one character more', async () => {
         const limit = getBudget('INSTRUCTIONS_MAX_CHARS').value;
         expect((await reportWith([], {}, undefined, 'i'.repeat(limit))).failures).toEqual([]);
         await harness.close();
         harness = undefined;
         const report = await reportWith([], {}, undefined, 'i'.repeat(limit + 1));
         expect(report.failures).toEqual([
            'server instructions: length is 601 chars, at most 600 chars (INSTRUCTIONS_MAX_CHARS)',
         ]);
      });
   });

   it('stops the sidecar and rethrows when setup fails part-way', async () => {
      /** @type {import('vitest').MockInstance} Counts HTTP servers closed during the failed setup. */
      const closeSpy = vi.spyOn(http.Server.prototype, 'close');
      try {
         await expect(startHarness({ tools: 5 })).rejects.toThrow();
         expect(closeSpy).toHaveBeenCalled();
      } finally {
         closeSpy.mockRestore();
      }
   });

   describe('budgets of results and arguments', () => {
      /**
       * Store the synthetic large document and return its handle.
       * @returns {Promise<string>} The handle id the enforcer stored the document under.
       */
      async function mintHandle() {
         const big = await harness.client.callTool({
            name: HELPER_TOOL_NAME,
            arguments: {},
         });
         return JSON.parse(big.content[0].text).handle;
      }

      it('lists at most the failure budget of failures and counts the rest', async () => {
         harness = await startHarness();
         harness.setGmAck({
            ok: false,
            error: {
               code: 'OP_FAILED',
               message: 'MOCK_FAILURE',
               failures: Array.from({ length: 15 }, (_, index) => ({
                  path: `p${index}`,
                  message: 'bad',
               })),
               failureCount: 15,
            },
         });
         const result = await harness.client.callTool({
            name: 'create_actor',
            arguments: { name: 'MOCK_ACTOR' },
         });
         expect(result.isError).toBe(true);
         /** @type {string[]} The text lines after the first. */
         const lines = result.content[0].text.split('\n').slice(1);
         expect(lines).toHaveLength(getBudget('ERROR_MAX_FAILURES').value);
         expect(lines[lines.length - 1]).toBe('p9: bad (+5 more)');
         expect(textBytes(result)).toBeLessThanOrEqual(getBudget('ERROR_MAX_BYTES').value);
      });

      it('keeps a read_handle result inside the largest per-call cap', async () => {
         harness = await startHarness();
         const page = await harness.client.callTool({
            name: 'read_handle',
            arguments: {
               handle: await mintHandle(),
               maxBytes: getBudget('RESULT_HARD_CAP_MAX_BYTES').value,
            },
         });
         expect(page.isError).toBeFalsy();
         expect(textBytes(page)).toBeLessThanOrEqual(getBudget('RESULT_HARD_CAP_MAX_BYTES').value);
         expect(textBytes(page)).toBeGreaterThan(getBudget('RESULT_HARD_CAP_DEFAULT_BYTES').value);
      });

      it('accepts the maximum number of paths and rejects one more', async () => {
         harness = await startHarness();
         const handle = await mintHandle();
         const limit = getBudget('PATHS_PER_CALL_MAX').value;
         const accepted = await harness.client.callTool({
            name: 'read_handle',
            arguments: {
               handle,
               paths: Array.from({ length: limit }, () => 'name'),
            },
         });
         expect(accepted.isError).toBeFalsy();
         const rejected = await harness.client.callTool({
            name: 'read_handle',
            arguments: {
               handle,
               paths: Array.from({ length: limit + 1 }, () => 'name'),
            },
         });
         expect(rejected.isError).toBe(true);
         expect(rejected.content[0].text).not.toContain('HANDLE_');
      });
   });
});
