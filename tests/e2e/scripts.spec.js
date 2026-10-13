import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { readSidecarGateState, recordGateSettings, restoreGateSettings } from './gates.js';
import { E2E_PREFIX, assertSettled, recordDocument, settleRegistry, teardownRecorded } from './registry.js';

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {import('node:child_process').ChildProcess | undefined} The e2e sidecar of this spec file. */
let sidecar;
test.beforeAll(async () => {
   sidecar = await startGateSidecar();
});
test.afterAll(async () => {
   await stopSidecar(sidecar);
});

/** @type {Client | undefined} The fake MCP client of the running test. */
let client;

/**
 * List the tool names the MCP session offers now.
 * @returns {Promise<string[]>} Tool names in listing order.
 */
async function toolNames() {
   return (await client.listTools()).tools.map((tool) => tool.name);
}

/**
 * Call a tool and return its first text item.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @returns {Promise<{ isError: boolean, text: string }>} Whether the call failed, and its text.
 */
async function callText(name, args) {
   const result = await client.callTool({
      name,
      arguments: args,
   });
   return {
      isError: result.isError === true,
      text: result.content[0].text,
   };
}

test.describe('wiretap registered scripts', () => {
   test.beforeEach(async ({ page }) => {
      await login(page);
      // A run that died mid-test left its prior values and documents recorded; restore them before recording new ones.
      await restoreGateSettings(page);
      await teardownRecorded(page);
      await recordGateSettings(page);
      await expect
         .poll(() => page.evaluate(() => game.modules.get('wiretap').api.bridge.identified), { timeout: POLL_MS })
         .toBe(true);
      // The MCP session opens after the page registered its scripts, as a real client's does.
      client = new Client({
         name: 'wiretap-e2e',
         version: '0.0.0',
      });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${E2E_MCP_PORT}/mcp`)));
   });

   test.afterEach(async ({ page }) => {
      await client?.close();
      client = undefined;
      // Anything the flows created and did not record is swept and fails the test, as does any leftover.
      const settled = await settleRegistry(page);
      await restoreGateSettings(page);
      assertSettled(settled);
   });

   test('lists create_actor beside read_handle and creates an actor in the live world', async ({ page }) => {
      await expect
         .poll(toolNames, { timeout: POLL_MS })
         .toEqual(expect.arrayContaining(['create_actor', 'read_handle']));
      const { tools } = await client.listTools();
      expect(tools.find((tool) => tool.name === 'create_actor').annotations).toMatchObject({ readOnlyHint: false });
      expect(tools.find((tool) => tool.name === 'read_handle').annotations?.readOnlyHint).not.toBe(false);

      const name = `${E2E_PREFIX}Actor ${Date.now()}`;
      const call = await callText('create_actor', { name });
      // The id is known only from the reply, so the record is written before anything else can fail.
      const reply = call.isError ? undefined : JSON.parse(call.text);
      if (reply) {
         await recordDocument(page, {
            documentName: 'Actor',
            id: reply.uuid.split('.').pop(),
            uuid: reply.uuid,
            createdBy: 'scripts.spec',
         });
      }
      expect(call.isError, call.text).toBe(false);
      expect(reply).toEqual({
         uuid: expect.stringMatching(/^Actor\.[A-Za-z0-9]{16}$/),
         name,
         type: expect.any(String),
      });
      expect(new TextEncoder().encode(call.text).length).toBeLessThanOrEqual(256);

      // The actor exists in the live world with the requested name and the acked type.
      const live = await page.evaluate(async (uuid) => {
         const actor = await fromUuid(uuid);
         return actor ? { name: actor.name, type: actor.type } : null;
      }, reply.uuid);
      expect(live).toEqual({
         name,
         type: reply.type,
      });
   });

   test('refuses invalid create_actor arguments without creating anything', async ({ page }) => {
      await expect.poll(toolNames, { timeout: POLL_MS }).toContain('create_actor');
      const before = await page.evaluate(() => game.actors.size);
      // A wrong type is refused by the sidecar's own schema check, before the call reaches the client; the client
      // validator is exercised by the 'runs the client argument validator' test below.
      const call = await callText('create_actor', { name: 5 });
      expect(call.isError).toBe(true);
      expect(await page.evaluate(() => game.actors.size)).toBe(before);
   });

   test('denies a gated script while its gate is closed and runs it once the gate is open', async ({ page }) => {
      await expect
         .poll(() => page.evaluate(() => game.modules.get('wiretap').api._probe?.scripts !== undefined), {
            timeout: POLL_MS,
         })
         .toBe(true);
      const outcomes = await page.evaluate(() => game.modules.get('wiretap').api._probe.scripts.registerE2e());
      expect(outcomes).toEqual([
         {
            ok: true,
            name: 'e2e_gated',
         },
         {
            ok: true,
            name: 'e2e_matrix',
         },
      ]);
      await expect.poll(toolNames, { timeout: POLL_MS }).toContain('e2e_gated');

      const denied = await callText('e2e_gated', {});
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('GATE_DENIED');
      expect(denied.text).toContain('allowMacroExecution');

      await page.evaluate(() => game.settings.set('wiretap', 'allowMacroExecution', true));
      await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({ allowMacroExecution: true });
      const allowed = await callText('e2e_gated', {});
      expect(allowed.isError, allowed.text).toBe(false);
      expect(JSON.parse(allowed.text)).toEqual({ ran: true });

      await restoreGateSettings(page);
      await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({ allowMacroExecution: false });
      const closedAgain = await callText('e2e_gated', {});
      expect(closedAgain.isError).toBe(true);
      expect(closedAgain.text).toContain('GATE_DENIED');
   });

   test('runs the client argument validator on arguments the sidecar accepted', async ({ page }) => {
      await expect
         .poll(() => page.evaluate(() => game.modules.get('wiretap').api._probe?.scripts !== undefined), {
            timeout: POLL_MS,
         })
         .toBe(true);
      await page.evaluate(() => game.modules.get('wiretap').api._probe.scripts.registerE2e());
      await expect.poll(toolNames, { timeout: POLL_MS }).toContain('e2e_matrix');
      /**
       * Build a matrix of booleans with the given number of rows, each of 1000 values.
       * @param {number} rows - The row count.
       * @returns {boolean[][]} The rows of `true` values.
       */
      const matrix = (rows) => Array.from({ length: rows }, () => Array.from({ length: 1000 }, () => true));

      // Within the client value bound of 10,000 values.
      const within = await callText('e2e_matrix', { rows: matrix(9) });
      expect(within.isError, within.text).toBe(false);
      expect(JSON.parse(within.text)).toEqual({ rows: 9 });

      // The sidecar's schema allows 1000 rows of 1000; the client refuses a tree of 11,000 values.
      const over = await callText('e2e_matrix', { rows: matrix(11) });
      expect(over.isError).toBe(true);
      expect(over.text).toContain('ARGS_INVALID');
      expect(over.text).toContain('too large');
   });
});
