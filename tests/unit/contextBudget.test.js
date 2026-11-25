// @vitest-environment node
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { z } from 'zod';
import { WIRETAP_INSTRUCTIONS } from '../../server/mcp.ts';
import { getBudget } from '../../shared/budgets.js';
import { RESERVED_SCRIPT_NAMES } from '../../shared/scripts.js';
import { shippedScripts } from './scriptFixtures.js';
import {
   FIXTURES,
   HELPER_TOOL_NAME,
   collectReport,
   findToolMentions,
   makeBigDocument,
   registryEntry,
   startHarness,
   textBytes,
   trivialFixture,
} from './contextBudgetHarness.js';

/**
 * A skills directory that does not exist, so a test of the listed totals is not also a test of the shipped
 * skill's tool mentions (the default-root tests below check those against the real tool list).
 * @type {string}
 */
const NO_SKILLS_ROOT = path.join(import.meta.dirname, '..', '..', 'test', 'tmp', 'no-such-skills');

/** @type {number} The scripts the fake GM client registers: every shipped script. */
const SHIPPED_COUNT = shippedScripts().length;

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
    * Start a harness with extra tools and report on it against the production fixtures plus extra ones. The fixtures
    * run only when asked: a full fixture run writes and reads about 20 backup files, which takes up to 2 s of a report
    * when every vitest worker is busy, and a test that checks only listings, skills or instructions needs none of it.
    * @param {import('../../server/mcp.ts').ToolRegistration[]} extraTools - Tools to register.
    * @param {Record<string, import('./contextBudgetHarness.js').FixtureCase[]>} [extraFixtures] - Their fixtures.
    * @param {string} [skillsRoot] - The skills directory to scan.
    * @param {string} [instructions] - The server instructions text.
    * @param {boolean | string[]} [runFixtures] - Which fixtures to run, as `collectReport` takes it. Default false.
    * @returns {Promise<import('./contextBudgetHarness.js').BudgetReport>} The measured breaches and sizes.
    */
   async function reportWith(extraTools, extraFixtures = {}, skillsRoot, instructions, runFixtures = false) {
      harness = await startHarness({
         tools: extraTools,
         instructions,
      });
      return collectReport({
         client: harness.client,
         setGmAck: harness.setGmAck,
         setGmHandler: harness.setGmHandler,
         fixtures: {
            ...FIXTURES,
            ...extraFixtures,
         },
         skillsRoot,
         runFixtures,
      });
   }

   it('keeps the listed production tools and their fixtures inside every budget', async () => {
      const report = await reportWith([], {}, undefined, undefined, true);
      for (const warning of report.warnings) {
         console.warn(`context budget warning | ${warning}`);
      }
      expect(report.failures).toEqual([]);
      expect(report.listing.map((tool) => tool.name).sort()).toEqual(
         [
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
            HELPER_TOOL_NAME,
            'list_backups',
            'list_document_types',
            'open_sheet',
            'read_handle',
            'replace_document',
            'restore_backup',
            'roll',
            'search_documents',
            'update_documents',
         ].sort(),
      );
      expect(report.totals.count).toBe(RESERVED_SCRIPT_NAMES.length + SHIPPED_COUNT);
      expect(report.helperTotals.count).toBe(1);
      expect(report.fixtureRuns.length).toBeGreaterThanOrEqual(8);
      // The one test that runs every production fixture: 40 tool calls through HTTP, Socket.IO and the fake GM, with
      // 20 backup files written and 18 headers read on disk. It takes 0.4 to 0.6 s alone and measured 1.7 to 4.2 s
      // inside a default-worker `npm test`, where those file writes and reads slow down far more than the tool calls
      // do, so the default 5 s limit leaves too little room.
   }, 10000);

   it('turns a create_documents ack over the batch budget into a handle within the ack budget', async () => {
      harness = await startHarness();
      harness.setGmAck({
         ok: true,
         result: Array.from({ length: 50 }, () => ({
            uuid: `Actor.${'U'.repeat(250)}`,
            name: 'N'.repeat(256),
            type: 'T'.repeat(256),
         })),
      });
      const result = await harness.client.callTool({
         name: 'create_documents',
         arguments: {
            documentName: 'Actor',
            data: ['{"name":"MOCK_ACTOR"}'],
         },
      });
      expect(textBytes(result)).toBeLessThanOrEqual(getBudget('ACK_MAX_BYTES').value);
      expect(JSON.parse(result.content[0].text)).toHaveProperty('handle');
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
      /** @type {{ handle: string }} The handle of the stored result. */
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

      it('does not count the helper tool toward the totals', async () => {
         /** @type {number} The test-local tools added beside the sidecar built-ins and the shipped scripts. */
         const fillers = 25;
         /** @type {Record<string, import('./contextBudgetHarness.js').FixtureCase[]>} Fixtures of the fillers. */
         const fixtures = {};
         const extra = Array.from({ length: fillers }, (_, index) => {
            const name = `test_filler_${index}`;
            fixtures[name] = trivialFixture(name);
            return makeTool(name, 'Short.');
         });
         const report = await reportWith(extra, fixtures, NO_SKILLS_ROOT);
         /** @type {number} Every tool the session lists except the helper. */
         const counted = RESERVED_SCRIPT_NAMES.length + fillers + SHIPPED_COUNT;
         expect(report.listing).toHaveLength(counted + 1);
         expect(report.totals.count).toBe(counted);
         expect(report.helperTotals.count).toBe(1);
         expect(report.failures).toEqual([]);
      });

      it('checks that every tool has a fixture without running any when fixtures are not run', async () => {
         /** @type {string[]} The tools whose fixture was run. */
         const ran = [];
         /** @type {Record<string, import('./contextBudgetHarness.js').FixtureCase[]>} Fixtures that record a run. */
         const recording = Object.fromEntries(Object.keys(FIXTURES).map((name) => [
            name,
            [
               {
                  label: 'recorded',
                  budget: 'ACK_MAX_BYTES',
                  run: () => {
                     ran.push(name);
                     throw new Error('the fixture ran');
                  },
               },
            ],
         ]));
         harness = await startHarness({ tools: [makeTool('test_no_fixture', 'Short.')] });
         const report = await collectReport({
            client: harness.client,
            setGmAck: harness.setGmAck,
            setGmHandler: harness.setGmHandler,
            fixtures: recording,
            runFixtures: false,
         });
         expect(report.failures).toEqual(['tool "test_no_fixture": no representative-result fixture']);
         expect(report.fixtureRuns).toEqual([]);
         expect(ran).toEqual([]);
         const named = await collectReport({
            client: harness.client,
            setGmAck: harness.setGmAck,
            setGmHandler: harness.setGmHandler,
            fixtures: recording,
            runFixtures: ['read_handle'],
         });
         expect(named.failures).toEqual([
            'tool "read_handle" fixture "recorded": threw the fixture ran',
            'tool "test_no_fixture": no representative-result fixture',
         ]);
         expect(ran).toEqual(['read_handle']);
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
            undefined,
            undefined,
            ['test_big_answer'],
         );
         expect(report.failures).toEqual([
            'tool "test_big_answer" fixture "short answer": result is 300 bytes, at most 256 bytes (ACK_MAX_BYTES)',
         ]);
      });
   });
   describe('tools registered by a Foundry client', () => {
      /**
       * Build the fixture of a registry tool: a short answer within the acknowledgement budget.
       * @param {string} name - The registry tool name.
       * @returns {import('./contextBudgetHarness.js').FixtureCase[]} The fixture cases.
       */
      function registryFixture(name) {
         return [
            {
               label: 'short answer',
               budget: 'ACK_MAX_BYTES',
               run: ({ client, setGmAck }) => {
                  setGmAck({
                     ok: true,
                     result: 'done',
                  });
                  return client.callTool({
                     name,
                     arguments: {},
                  });
               },
            },
            {
               label: 'result over the cap becomes a handle',
               budget: 'ACK_MAX_BYTES',
               run: ({ client, setGmAck }) => {
                  setGmAck({
                     ok: true,
                     result: makeBigDocument(),
                  });
                  return client.callTool({
                     name,
                     arguments: {},
                  });
               },
            },
         ];
      }

      /**
       * Report on the running harness with the production fixtures plus the given ones; as in `reportWith`, the
       * fixtures run only when asked.
       * @param {Record<string, import('./contextBudgetHarness.js').FixtureCase[]>} fixtures - Fixtures by tool name.
       * @param {boolean | string[]} [runFixtures] - Which fixtures to run, as `collectReport` takes it. Default false.
       * @returns {Promise<import('./contextBudgetHarness.js').BudgetReport>} The breaches and sizes measured on it.
       */
      function reportOn(fixtures, runFixtures = false) {
         return collectReport({
            client: harness.client,
            setGmAck: harness.setGmAck,
            setGmHandler: harness.setGmHandler,
            fixtures: {
               ...FIXTURES,
               ...fixtures,
            },
            runFixtures,
         });
      }

      it('counts a registered tool toward the tool list and holds its results to the budgets', async () => {
         harness = await startHarness({ registry: [registryEntry('registry_one')] });
         const report = await reportOn({ registry_one: registryFixture('registry_one') }, ['registry_one']);
         expect(report.failures).toEqual([]);
         expect(report.listing.map((tool) => tool.name)).toContain('registry_one');
         expect(report.totals.count).toBe(RESERVED_SCRIPT_NAMES.length + 1 + SHIPPED_COUNT);
         expect(report.fixtureRuns.filter((run) => run.tool === 'registry_one')).toHaveLength(2);
      });

      it('fails a registered tool that has no representative-result fixture', async () => {
         harness = await startHarness({ registry: [registryEntry('registry_one')] });
         const report = await reportOn({});
         expect(report.failures).toEqual(['tool "registry_one": no representative-result fixture']);
      });

      it('counts a tool registered after the session started once the client has been told', async () => {
         harness = await startHarness();
         expect((await reportOn({})).totals.count).toBe(RESERVED_SCRIPT_NAMES.length + SHIPPED_COUNT);
         const changed = harness.nextToolListChange();
         expect(await harness.registerTools([registryEntry('registry_late')])).toEqual({
            ok: true,
            accepted: SHIPPED_COUNT + 1,
            refused: 0,
         });
         await changed;
         const without = await reportOn({});
         expect(without.failures).toEqual(['tool "registry_late": no representative-result fixture']);
         expect(without.totals.count).toBe(RESERVED_SCRIPT_NAMES.length + 1 + SHIPPED_COUNT);
         const report = await reportOn({ registry_late: registryFixture('registry_late') }, ['registry_late']);
         expect(report.failures).toEqual([]);
      });

      it('fails a late tool whose result is over its budget', async () => {
         harness = await startHarness();
         const changed = harness.nextToolListChange();
         await harness.registerTools([registryEntry('registry_late', { result: { budgetBytes: 2000 } })]);
         await changed;
         const report = await reportOn({
            registry_late: [
               {
                  label: 'answer over the budget',
                  budget: 'ERROR_MAX_BYTES',
                  run: ({ client, setGmAck }) => {
                     setGmAck({
                        ok: true,
                        result: 'a'.repeat(1500),
                     });
                     return client.callTool({
                        name: 'registry_late',
                        arguments: {},
                     });
                  },
               },
            ],
         }, ['registry_late']);
         expect(report.failures).toEqual([
            'tool "registry_late" fixture "answer over the budget": ' +
               'result is 1500 bytes, at most 512 bytes (ERROR_MAX_BYTES)',
         ]);
      });

      it('lists every tool the endpoint registers', async () => {
         harness = await startHarness();
         /** @type {string[]} The names offered, 40 in all. */
         const names = Array.from({ length: 40 }, (_, index) => `registry_${index}`);
         const changed = harness.nextToolListChange();
         const ack = await harness.registerTools(names.map((name) => registryEntry(name)));
         await changed;
         expect(ack.accepted).toBe(40 + SHIPPED_COUNT);
         expect(ack.refused).toBe(0);
         /** @type {Record<string, import('./contextBudgetHarness.js').FixtureCase[]>} Fixtures of all 40 tools. */
         const fixtures = Object.fromEntries(names.map((name) => [
            name,
            registryFixture(name),
         ]));
         const report = await reportOn(fixtures, names);
         expect(report.failures).toEqual([]);
         expect(report.listing.map((tool) => tool.name)).toEqual(expect.arrayContaining(names));
      });

      it('refuses a definition over a budget at the registry, so it is never listed', async () => {
         harness = await startHarness();
         const ack = await harness.registerTools([
            registryEntry('registry_wide_name_that_is_over_thirty_two_characters'),
            registryEntry('registry_long', { description: 'd'.repeat(241) }),
            registryEntry('registry_fat', {
               inputSchema: {
                  type: 'object',
                  properties: Object.fromEntries(
                     Array.from({ length: 12 }, (_, index) => [
                        `field${index}`,
                        {
                           type: 'string',
                           description: 'x'.repeat(40),
                        },
                     ]),
                  ),
               },
            }),
         ]);
         expect(ack).toEqual({
            ok: true,
            accepted: SHIPPED_COUNT,
            refused: 3,
         });
         expect((await reportOn({})).totals.count).toBe(RESERVED_SCRIPT_NAMES.length + SHIPPED_COUNT);
      });
   });

   describe('server instructions', () => {
      it('sends the production instructions within the budget, naming only tools the server lists', async () => {
         harness = await startHarness();
         const instructions = harness.client.getInstructions();
         expect(instructions).toBe(WIRETAP_INSTRUCTIONS);
         expect(instructions.length).toBeGreaterThan(0);
         expect(instructions.length).toBeLessThanOrEqual(getBudget('INSTRUCTIONS_MAX_CHARS').value);
         /** @type {string[]} The tools the instructions point to. */
         const mentioned = findToolMentions(instructions);
         expect(mentioned).toEqual(['read_handle']);
         /** @type {string[]} The tools the server lists. */
         const listed = (await harness.client.listTools()).tools.map((tool) => tool.name);
         for (const name of mentioned) {
            expect(listed).toContain(name);
         }
         expect(instructions).toContain('tools/list_changed');
         // Every MCP client receives the instructions, and the Wiretap skill is installed by hand in only some, so
         // the text must not send the model looking for one.
         expect(instructions.toLowerCase()).not.toContain('skill');
      });

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
            name: 'create_documents',
            arguments: {
               documentName: 'Actor',
               data: ['{"name":"MOCK_ACTOR"}'],
            },
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

      it('accepts more paths than the best-practice size', async () => {
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
         const past = await harness.client.callTool({
            name: 'read_handle',
            arguments: {
               handle,
               paths: Array.from({ length: limit * 5 }, () => 'name'),
            },
         });
         expect(past.isError).toBeFalsy();
      });
   });
});
