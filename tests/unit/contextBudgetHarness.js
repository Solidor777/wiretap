/**
 * Shared support for the context-budget test and the manual calibration script: starts the real MCP server in-process
 * with the real bridge, lists its tools through the real SDK client, runs each tool's representative-result fixture
 * through the real result enforcer, and reports every budget breach. It is not a test file (vitest only collects
 * `*.test.js`) and is never part of a shipping build.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { io as ioClient } from 'socket.io-client';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createWiretapServer } from '../../server/server.ts';
import { startMcpServer } from '../../server/mcp.ts';
import { getBudget } from '../../shared/budgets.js';
import { BRIDGE_IDENTIFY, BRIDGE_INVOKE, BRIDGE_REGISTRY, PROTOCOL_VERSION } from '../../shared/protocol.js';
import { createActorScript, registryPayload, script } from './scriptFixtures.js';

/**
 * @typedef {object} GmAck
 * @property {boolean} ok - Whether the fake GM client reports success.
 * @property {unknown} [result] - The result of a successful operation.
 * @property {{ code: string, message: string }} [error] - The error of a failed operation.
 */

/**
 * @typedef {object} FixtureContext
 * @property {Client} client - The SDK client connected to the server under test.
 * @property {(ack: GmAck) => void} setGmAck - Sets the ack the fake GM client answers the next invocations with.
 */

/**
 * @typedef {object} FixtureCase
 * @property {string} label - What the case represents.
 * @property {string} budget - The `shared/budgets.js` constant the result must stay within.
 * @property {Function} run - Takes a FixtureContext, calls the tool through the client and resolves its result.
 */

/**
 * @typedef {object} BudgetReport
 * @property {string[]} failures - Hard-budget breaches and structural failures; any entry fails the test.
 * @property {string[]} warnings - Warn-budget breaches; reported only.
 * @property {object[]} listing - Per listed tool: name, nameChars, descriptionChars and definitionBytes.
 * @property {{ count: number, definitionBytes: number }} totals - The count and summed definition size of the listed
 * tools that are not test-local helpers; the tool-count and total-size budgets apply to these.
 * @property {{ count: number, definitionBytes: number }} helperTotals - The same for the test-local helper tools,
 * which are held to the per-tool budgets and fixtures only.
 * @property {object[]} fixtureRuns - Per fixture result: tool, label, budget, bytes and limit.
 */

/** @type {string} The module root. */
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @type {string} The directory a module-level skill set would ship in. No such directory exists yet, so the skill
 * scan finds nothing; it starts checking as soon as one appears.
 */
export const DEFAULT_SKILLS_ROOT = path.join(MODULE_ROOT, 'skills');

/** @type {string} The test-local tool that returns a synthetic document larger than the hard cap. */
export const HELPER_TOOL_NAME = 'mock_big_document';

/**
 * @type {RegExp} A tool reference in skill or instruction text. Matching rule: the literal prefix `mcp__wiretap__`,
 * then a name made of letters, digits and underscores in which hyphens may join such runs. A hyphen, period or other
 * punctuation at the end of the name belongs to the sentence, not to the name.
 */
const TOOL_MENTION_PATTERN = /mcp__wiretap__([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)/g;

/**
 * Reserve a free loopback TCP port by listening on port 0 and releasing it.
 * @returns {Promise<number>} A port that was free at probe time.
 */
function freePort() {
   return new Promise((resolve, reject) => {
      /** @type {import('node:net').Server} A throwaway server used to reserve a port. */
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
         /** @type {number} The port the OS assigned. */
         const { port } = probe.address();
         probe.close(() => resolve(port));
      });
   });
}

/**
 * Build the synthetic document the helper tool returns: 120 obviously fake embedded items, over 100 KB serialized.
 * @returns {object} An actor-shaped document with an `items` array.
 */
export function makeBigDocument() {
   return {
      name: 'MOCK_ACTOR',
      type: 'MOCK_TYPE',
      system: { hp: 7 },
      items: Array.from({ length: 120 }, (_, index) => ({
         _id: `MOCKID${index}`,
         name: `MOCK_ITEM_${index}`,
         system: { description: 'd'.repeat(800) },
      })),
   };
}

/**
 * Sum the UTF-8 bytes of every text item in a tool result.
 * @param {{ content: { type: string, text?: string }[] }} result - The tool result.
 * @returns {number} The byte total.
 */
export function textBytes(result) {
   return result.content.reduce((sum, item) => sum + (item.text === undefined ? 0 : Buffer.byteLength(item.text)), 0);
}

/**
 * Create the helper tool registration that returns the synthetic large document.
 * @returns {import('../../server/mcp.ts').ToolRegistration} The registration.
 */
function makeHelperTool() {
   return {
      name: HELPER_TOOL_NAME,
      description: 'Test-only tool returning a synthetic document over the result cap.',
      inputSchema: { unused: z.string().optional() },
      handler: async () => ({
         content: [
            {
               type: 'text',
               text: JSON.stringify(makeBigDocument()),
            },
         ],
      }),
   };
}

/**
 * Create a fixture for a tool that answers with a short text: one case within the acknowledgement budget.
 * @param {string} name - The tool name.
 * @returns {FixtureCase[]} The fixture cases.
 */
export function trivialFixture(name) {
   return [
      {
         label: 'short answer',
         budget: 'ACK_MAX_BYTES',
         run: ({ client }) => client.callTool({
            name,
            arguments: {},
         }),
      },
   ];
}

/**
 * Build a GM ack for a successful operation.
 * @param {unknown} result - The operation result.
 * @returns {GmAck} An ack that carries `result`.
 */
function okAck(result) {
   return {
      ok: true,
      result,
   };
}

/**
 * The representative-result fixtures, keyed by tool name. Every listed tool needs an entry; the data is synthetic.
 * @type {Record<string, FixtureCase[]>}
 */
export const FIXTURES = {
   create_actor: [
      {
         label: 'ack of a created actor',
         budget: 'ACK_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               uuid: 'Actor.MOCKACTOR0000001',
               name: 'MOCK_ACTOR_1',
               type: 'npc',
            }));
            return client.callTool({
               name: 'create_actor',
               arguments: { name: 'MOCK_ACTOR_1' },
            });
         },
      },
      {
         label: 'ack with every field at its 256-byte bound',
         budget: 'ACK_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck(okAck({
               uuid: `Actor.${'U'.repeat(250)}`,
               name: 'N'.repeat(256),
               type: 'T'.repeat(256),
            }));
            return client.callTool({
               name: 'create_actor',
               arguments: { name: 'MOCK_ACTOR_2' },
            });
         },
      },
      {
         label: 'failure with more failures than the error budget lists',
         budget: 'ERROR_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck({
               ok: false,
               error: {
                  code: 'OP_FAILED',
                  message: 'MOCK_FAILURE',
                  failures: Array.from({ length: 15 }, (_, index) => ({
                     path: `MOCK_PATH_${index}`,
                     message: 'MOCK_BAD_VALUE',
                  })),
                  failureCount: 15,
               },
            });
            return client.callTool({
               name: 'create_actor',
               arguments: { name: 'MOCK_ACTOR_4' },
            });
         },
      },
      {
         label: 'failure with an oversized message',
         budget: 'ERROR_MAX_BYTES',
         run: ({ client, setGmAck }) => {
            setGmAck({
               ok: false,
               error: {
                  code: 'OP_FAILED',
                  message: 'MOCK_FAILURE '.repeat(200),
               },
            });
            return client.callTool({
               name: 'create_actor',
               arguments: { name: 'MOCK_ACTOR_3' },
            });
         },
      },
   ],
   read_handle: [
      {
         label: 'window at the largest per-call cap',
         budget: 'RESULT_HARD_CAP_MAX_BYTES',
         run: async ({ client }) => {
            const big = await client.callTool({
               name: HELPER_TOOL_NAME,
               arguments: {},
            });
            return client.callTool({
               name: 'read_handle',
               arguments: {
                  handle: JSON.parse(big.content[0].text).handle,
                  maxBytes: getBudget('RESULT_HARD_CAP_MAX_BYTES').value,
               },
            });
         },
      },
      {
         label: 'default window of a stored result',
         budget: 'RESULT_HARD_CAP_DEFAULT_BYTES',
         run: async ({ client }) => {
            const big = await client.callTool({
               name: HELPER_TOOL_NAME,
               arguments: {},
            });
            return client.callTool({
               name: 'read_handle',
               arguments: { handle: JSON.parse(big.content[0].text).handle },
            });
         },
      },
      {
         label: 'paths window cut at the cap',
         budget: 'RESULT_HARD_CAP_DEFAULT_BYTES',
         run: async ({ client }) => {
            const big = await client.callTool({
               name: HELPER_TOOL_NAME,
               arguments: {},
            });
            return client.callTool({
               name: 'read_handle',
               arguments: {
                  handle: JSON.parse(big.content[0].text).handle,
                  paths: ['items'],
               },
            });
         },
      },
   ],
   [HELPER_TOOL_NAME]: [
      {
         label: 'result over the cap becomes a handle',
         budget: 'ACK_MAX_BYTES',
         run: ({ client }) => client.callTool({
            name: HELPER_TOOL_NAME,
            arguments: {},
         }),
      },
   ],
};

/**
 * Build the script definition of a synthetic tool a fake GM client registers through `bridge:registry`.
 * @param {string} name - The tool name.
 * @param {object} [overrides] - Fields replacing the defaults.
 * @returns {object} A definition a fake GM client can send in a registry event.
 */
export function registryEntry(name, overrides = {}) {
   return script(name, {
      description: `Synthetic registry tool ${name}.`,
      inputSchema: {
         type: 'object',
         properties: { text: { type: 'string' } },
      },
      ...overrides,
   });
}

/**
 * Start the sidecar bridge with a fake GM client, an MCP server and a connected SDK client. The server lists the
 * built-in `read_handle`, the test-local helper tool, `extraTools`, and the scripts the fake GM client registers: the
 * `create_actor` script and those in `registry` before the session starts, and later ones through the returned
 * `registerTools`.
 * @param {object} [options] - What to register.
 * @param {import('../../server/mcp.ts').ToolRegistration[]} [options.tools] - Tools registered after the helper tool.
 * @param {string} [options.instructions] - The server instructions text; the production text when absent.
 * @param {object[]} [options.registry] - Script definitions the fake GM client sends, beside `create_actor`, before the
 * SDK client connects.
 * @returns {Promise<{ client: Client, setGmAck: Function, registerTools: Function, nextToolListChange: Function,
 * close: Function }>} The client, the control for the fake GM client's answers, `registerTools(entries)` (sends a
 * registry of `create_actor` plus the entries and resolves with its ack, which counts `create_actor` too),
 * `nextToolListChange()` (resolves when the client receives its next
 * `notifications/tools/list_changed`, rejects after one second) and the teardown.
 */
export async function startHarness({ tools = [], instructions, registry } = {}) {
   /** @type {Array<() => unknown>} Teardown steps for what has been started, in start order. */
   const teardown = [];
   /**
    * Stop everything started so far, newest first; one failing step does not stop the others.
    * @returns {Promise<void>}
    */
   const close = async () => {
      for (const step of teardown.reverse()) {
         try {
            await step();
         } catch {
            // Best-effort: the remaining steps still run.
         }
      }
      teardown.length = 0;
   };
   try {
      /** @type {ReturnType<typeof createWiretapServer>} The sidecar providing the Socket.IO bridge. */
      const server = createWiretapServer(0, await freePort(), 'mcp-only');
      teardown.push(() => server.dispose());
      await server.ready;
      /** @type {GmAck} The ack the fake GM client answers invocations with. */
      let gmAck = okAck({});
      /** @type {import('socket.io-client').Socket} The fake GM client. */
      const gm = ioClient(`http://127.0.0.1:${server.io.httpServer.address().port}`);
      teardown.push(() => gm.close());
      gm.on(BRIDGE_INVOKE, (request, ack) => {
         ack(gmAck);
      });
      await new Promise((resolve) => gm.on('connect', resolve));
      await gm.emitWithAck(BRIDGE_IDENTIFY, {
         protocolVersion: PROTOCOL_VERSION,
         userId: 'u1',
         userName: 'GM',
         isGM: true,
         kind: 'human',
         dom: true,
      });
      await gm.emitWithAck(BRIDGE_REGISTRY, registryPayload([createActorScript(), ...(registry ?? [])]));
      /** @type {ReturnType<typeof startMcpServer>} The MCP server under test. */
      const mcp = startMcpServer(server.bridge, 0, {
         tools: [
            makeHelperTool(),
            ...tools,
         ],
         instructions,
         sessions: {
            listChangedQuietMs: 10,
            listChangedMaxWaitMs: 50,
         },
      });
      teardown.push(() => mcp.close());
      await mcp.ready;
      /** @type {Client} The real MCP SDK client. */
      const client = new Client({
         name: 'test',
         version: '0.0.0',
      });
      /** @type {Array<() => void>} Resolvers of the callers waiting for the next tool list change. */
      const waiters = [];
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
         for (const resolve of waiters.splice(0)) {
            resolve();
         }
      });
      teardown.push(() => client.close());
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${mcp.port()}/mcp`)));
      return {
         client,
         setGmAck: (ack) => {
            gmAck = ack;
         },
         registerTools: (entries) => gm.emitWithAck(
            BRIDGE_REGISTRY,
            registryPayload([createActorScript(), ...entries]),
         ),
         nextToolListChange: () => new Promise((resolve, reject) => {
            waiters.push(resolve);
            setTimeout(() => reject(new Error('no tools/list_changed within 1000 ms')), 1000).unref();
         }),
         close,
      };
   } catch (error) {
      await close();
      throw error;
   }
}

/**
 * List the distinct tool names that text refers to as `mcp__wiretap__<tool>`.
 * @param {string} text - Skill or instruction text.
 * @returns {string[]} The distinct tool names, in order of first mention.
 */
export function findToolMentions(text) {
   return [...new Set([...text.matchAll(TOOL_MENTION_PATTERN)].map((match) => match[1]))];
}

/**
 * Read the text of every Markdown file under a skills directory. A missing directory holds no skills.
 * @param {string} root - The skills directory.
 * @returns {{ file: string, text: string }[]} The files and their text.
 */
export function readSkillFiles(root) {
   if (!fs.existsSync(root)) {
      return [];
   }
   /** @type {{ file: string, text: string }[]} The files found so far. */
   const found = [];
   for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      /** @type {string} The entry's full path. */
      const full = path.join(root, entry.name);
      if (entry.isDirectory()) {
         found.push(...readSkillFiles(full));
      } else if (entry.name.endsWith('.md')) {
         found.push({
            file: full,
            text: fs.readFileSync(full, 'utf8'),
         });
      }
   }
   return found;
}

/**
 * Create a function that records a breach of a named budget as a failure when the budget is hard and as a warning when
 * it is warn.
 * @param {string[]} failures - Receives hard breaches.
 * @param {string[]} warnings - Receives warn breaches.
 * @returns {Function} A recorder taking (budgetName, actual, subject, what); it records nothing within the budget.
 */
function makeBreachRecorder(failures, warnings) {
   return (budgetName, actual, subject, what) => {
      /** @type {Readonly<import('../../shared/budgets.js').Budget>} The budget being checked. */
      const budget = getBudget(budgetName);
      if (actual <= budget.value) {
         return;
      }
      /** @type {string} The unit suffix; a count has none. */
      const unit = budget.unit === 'count' ? '' : ` ${budget.unit}`;
      /** @type {string} The breach text. */
      const message = `${subject}: ${what} is ${actual}${unit}, at most ${budget.value}${unit} (${budgetName})`;
      (budget.severity === 'hard' ? failures : warnings).push(message);
   };
}

/**
 * Measure a server and report every budget breach: per-tool name, definition and description sizes, the tool count and
 * total definition size, a fixture for every listed tool, each fixture result against its budget, and every tool
 * mentioned by the server instructions or a shipped skill.
 * @param {object} options - What to check.
 * @param {Client} options.client - The SDK client connected to the server under test.
 * @param {(ack: GmAck) => void} options.setGmAck - Sets the fake GM client's answer.
 * @param {Record<string, FixtureCase[]>} options.fixtures - The fixtures keyed by tool name.
 * @param {string} [options.skillsRoot] - The shipped skills directory; a missing directory holds no skills.
 * @param {string[]} [options.helperTools] - Test-local tools that are measured per tool but do not count toward the
 * tool-count and total-size budgets. Every other listed tool counts, including extra tools a test registers to
 * exercise a budget.
 * @returns {Promise<BudgetReport>} The measured breaches and sizes.
 */
export async function collectReport({
   client,
   setGmAck,
   fixtures,
   skillsRoot = DEFAULT_SKILLS_ROOT,
   helperTools = [HELPER_TOOL_NAME],
}) {
   /** @type {BudgetReport} The report being built. */
   const report = {
      failures: [],
      warnings: [],
      listing: [],
      totals: {
         count: 0,
         definitionBytes: 0,
      },
      helperTotals: {
         count: 0,
         definitionBytes: 0,
      },
      fixtureRuns: [],
   };
   /** @type {(budgetName: string, actual: number, subject: string, what: string) => void} Breach recorder. */
   const breach = makeBreachRecorder(report.failures, report.warnings);
   const { tools } = await client.listTools();
   for (const tool of tools) {
      /** @type {string} The label of this tool in messages. */
      const subject = `tool "${tool.name}"`;
      /** @type {number} The UTF-8 size of the listed definition. */
      const definitionBytes = Buffer.byteLength(JSON.stringify({
         name: tool.name,
         description: tool.description,
         inputSchema: tool.inputSchema,
      }));
      report.listing.push({
         name: tool.name,
         nameChars: tool.name.length,
         descriptionChars: tool.description.length,
         definitionBytes,
      });
      /** @type {{ count: number, definitionBytes: number }} The totals this tool adds to. */
      const totals = helperTools.includes(tool.name) ? report.helperTotals : report.totals;
      totals.count += 1;
      totals.definitionBytes += definitionBytes;
      breach('CORE_TOOL_NAME_MAX_CHARS', tool.name.length, subject, 'name');
      breach('DEFINITION_MAX_BYTES', definitionBytes, subject, 'definition');
      breach('DESCRIPTION_MAX_CHARS', tool.description.length, subject, 'description');
      breach('DESCRIPTION_TARGET_CHARS', tool.description.length, subject, 'description');
   }
   breach('ALWAYS_LISTED_TOOLS_MAX', report.totals.count, 'tool list', 'tool count');
   breach('ALL_DEFINITIONS_MAX_BYTES', report.totals.definitionBytes, 'tool list', 'total definition size');
   /** @type {FixtureContext} What the fixtures receive. */
   const context = {
      client,
      setGmAck,
   };
   for (const tool of tools) {
      /** @type {FixtureCase[] | undefined} This tool's fixture. */
      const cases = fixtures[tool.name];
      if (cases === undefined || cases.length === 0) {
         report.failures.push(`tool "${tool.name}": no representative-result fixture`);
         continue;
      }
      for (const fixtureCase of cases) {
         /** @type {string} The label of this case in messages. */
         const subject = `tool "${tool.name}" fixture "${fixtureCase.label}"`;
         try {
            /** @type {number} The size of the result the real enforcer path returned. */
            const bytes = textBytes(await fixtureCase.run(context));
            report.fixtureRuns.push({
               tool: tool.name,
               label: fixtureCase.label,
               budget: fixtureCase.budget,
               bytes,
               limit: getBudget(fixtureCase.budget).value,
            });
            breach(fixtureCase.budget, bytes, subject, 'result');
         } catch (error) {
            report.failures.push(`${subject}: threw ${error instanceof Error ? error.message : String(error)}`);
         }
      }
   }
   /** @type {Set<string>} The listed tool names. */
   const names = new Set(tools.map((tool) => tool.name));
   /** @type {string} The server instructions, empty when there are none. */
   const instructions = client.getInstructions() ?? '';
   breach('INSTRUCTIONS_MAX_CHARS', instructions.length, 'server instructions', 'length');
   /** @type {{ source: string, text: string }[]} Every text that may name tools. */
   const sources = [
      {
         source: 'server instructions',
         text: instructions,
      },
      ...readSkillFiles(skillsRoot).map((skill) => ({
         source: `skill ${path.relative(skillsRoot, skill.file)}`,
         text: skill.text,
      })),
   ];
   for (const { source, text } of sources) {
      for (const mention of findToolMentions(text)) {
         if (!names.has(mention)) {
            report.failures.push(`${source}: mentions unknown tool "${mention}"`);
         }
      }
   }
   return report;
}
