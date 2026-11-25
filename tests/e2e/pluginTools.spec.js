import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { idOf } from './writeHelpers.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { recordGateSettings, restoreGateSettings } from './gates.js';
import { E2E_PREFIX, assertSettled, recordDocument, settleRegistry, teardownRecorded } from './registry.js';
import { e2eLog } from './log.js';
import { FIXTURE_TOOL_NAME, enableFixturePlugin, restoreFixturePlugin } from './pluginFixture.js';
import { FIXTURE_MODULE_ID, fixtureInstallDir } from './pluginFixtureInstall.js';

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
 * @type {boolean} Whether the fixture module was already enabled in the world's module configuration before the
 * test enabled it, which is what the fixture record stores as its `prior`.
 */
let enabledBefore = false;

/**
 * List the tool names the MCP session offers now.
 * @returns {Promise<string[]>} Tool names in listing order.
 */
async function toolNames() {
   return (await client.listTools()).tools.map((tool) => tool.name);
}

/**
 * Wait until the session lists a shipped tool, which shows the page's script list has reached the sidecar, and return
 * that listing. An empty listing lacks the fixture tool too, so a "not listed" check reads this listing instead.
 * @returns {Promise<string[]>} The first listing that holds `create_documents`.
 */
async function shippedListing() {
   /** @type {string[]} The most recent listing read by the poll. */
   let listed = [];
   await expect
      .poll(
         async () => {
            listed = await toolNames();
            return listed;
         },
         { timeout: POLL_MS },
      )
      .toContain('create_documents');
   return listed;
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

test.describe('wiretap plugin tools', () => {
   test.beforeEach(async ({ page }) => {
      await login(page);
      // A run that died mid-test left its prior values, module entry and documents recorded; restore them first.
      await restoreGateSettings(page);
      await restoreFixturePlugin(page);
      await teardownRecorded(page);
      await recordGateSettings(page);
      expect(
         await page.evaluate((id) => game.modules.get(id) !== undefined, FIXTURE_MODULE_ID),
         `the Foundry server started before the fixture module was installed at ${fixtureInstallDir()}; restart ` +
            'Foundry once so it finds the module',
      ).toBe(true);
      enabledBefore = await page.evaluate(
         (id) => game.settings.get('core', 'moduleConfiguration')[id] === true,
         FIXTURE_MODULE_ID,
      );
      await enableFixturePlugin(page);
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
      /** @type {Awaited<ReturnType<typeof settleRegistry>> | undefined} What the registry settle found. */
      let settled;
      try {
         await client?.close();
         client = undefined;
         // Anything the flow created and did not record is swept and fails the test, as does any leftover.
         settled = await settleRegistry(page);
         await restoreGateSettings(page);
      } finally {
         await restoreFixturePlugin(page);
      }
      assertSettled(settled);
   });

   test(
      'the fixture registers through the hook at ready, is listed only while allowed, runs ctx.core, and is gone ' +
         'after it is disabled',
      async ({ page }) => {
         /** @type {object} The fixture module's record of its hook call and registration outcome. */
         const state = await page.evaluate((id) => game.modules.get(id).api.state, FIXTURE_MODULE_ID);
         expect(state).toEqual({
            setupSeenAtHook: true,
            hookCalls: 1,
            apiVersion: 1,
            outcome: {
               ok: true,
               name: FIXTURE_TOOL_NAME,
            },
         });
         expect(await shippedListing()).not.toContain(FIXTURE_TOOL_NAME);

         await page.evaluate((id) => game.settings.set('wiretap', 'allowedPluginModules', id), FIXTURE_MODULE_ID);
         await expect.poll(toolNames, { timeout: POLL_MS }).toContain(FIXTURE_TOOL_NAME);

         /** @type {string} The actor name the fixture tool echoes and creates. */
         const text = `${E2E_PREFIX}Plugin ${Date.now()}`;
         /** @type {{ isError: boolean, text: string }} The fixture tool's call result. */
         const call = await callText(FIXTURE_TOOL_NAME, { text });
         // The id is known only from the reply, so the record is written before anything else can fail.
         /** @type {{ echo: string, created: { uuid: string }[] } | undefined} The parsed reply of a successful call. */
         const reply = call.isError ? undefined : JSON.parse(call.text);
         if (reply?.created?.[0]) {
            await recordDocument(page, {
               documentName: 'Actor',
               id: idOf(reply.created[0].uuid),
               uuid: reply.created[0].uuid,
               createdBy: 'pluginTools.spec',
            });
         }
         expect(call.isError, call.text).toBe(false);
         expect(reply).toEqual({
            echo: text,
            created: [
               {
                  uuid: expect.stringMatching(/^Actor\.[A-Za-z0-9]{16}$/),
                  name: text,
                  type: expect.any(String),
               },
            ],
         });
         expect(await page.evaluate(async (uuid) => (await fromUuid(uuid))?.name, reply.created[0].uuid)).toBe(text);

         if (enabledBefore) {
            e2eLog('the fixture module was enabled before the run, so it stays enabled; the disabled check is skipped');
            return;
         }
         // The module is disabled again; the gate stays open, so only the disabled module removes the tool.
         await restoreFixturePlugin(page);
         await page.reload();
         await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60_000 });
         await expect
            .poll(() => page.evaluate(() => game.modules.get('wiretap').api.bridge.identified), { timeout: POLL_MS })
            .toBe(true);
         expect(await shippedListing()).not.toContain(FIXTURE_TOOL_NAME);
      },
   );
});
