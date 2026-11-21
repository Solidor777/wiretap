import { test, expect } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { login } from './fixtures.js';
import { createArguments, firstSubtype, idOf, patch } from './writeHelpers.js';
import { E2E_MCP_PORT } from './ports.js';
import { startGateSidecar, stopSidecar } from './sidecar.js';
import { readSidecarGateState, recordGateSettings, restoreGateSettings } from './gates.js';
import { E2E_PREFIX, assertSettled, recordDocument, settleRegistry, teardownRecorded } from './registry.js';

/** @type {number} The longest wait inside an already-loaded page or on the loopback sidecar, in milliseconds. */
const POLL_MS = 1000;

/** @type {number} The most bytes a script error may take. */
const ERROR_MAX_BYTES = 512;

/** @type {string} The gate that guards running macros and writing macro code. */
const GATE = 'allowMacroExecution';

/** @type {string} The `createdBy` value of every document this spec records. */
const CREATED_BY = 'macroTools.spec';

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

/**
 * Call a tool, require success and parse its JSON.
 * @param {string} name - The tool name.
 * @param {object} args - The arguments.
 * @returns {Promise<any>} The parsed result.
 */
async function callJson(name, args) {
   const call = await callText(name, args);
   expect(call.isError, `${name}: ${call.text}`).toBe(false);
   return JSON.parse(call.text);
}

/**
 * The raw UTF-8 byte length of a text.
 * @param {string} text - A tool reply's text.
 * @returns {number} Its byte length.
 */
function bytesOf(text) {
   return new TextEncoder().encode(text).length;
}

/**
 * Record a world document the flows created, so the teardown removes it.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {string} documentName - The document class.
 * @param {string} uuid - The document uuid.
 * @returns {Promise<void>} Resolves once the record is written.
 */
async function record(page, documentName, uuid) {
   await recordDocument(page, {
      documentName,
      id: idOf(uuid),
      uuid,
      createdBy: CREATED_BY,
   });
}

/**
 * Create a Macro in the page as the GM and record it at once.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @param {object} data - The Macro data; its name is given here.
 * @returns {Promise<string>} The Macro uuid.
 */
async function createMacro(page, data) {
   /** @type {string} The created Macro's id. */
   const id = await page.evaluate(async (macroData) => (await Macro.create(macroData)).id, {
      name: `${E2E_PREFIX}Macro ${Date.now()}`,
      ...data,
   });
   await record(page, 'Macro', `Macro.${id}`);
   return `Macro.${id}`;
}

/**
 * Open the macro gate on the GM page, and wait until both the page and the sidecar's snapshot hold it open; the
 * spec's afterEach restores it.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<void>} Resolves once the gate reads open in the page and in the sidecar.
 */
async function openGate(page) {
   await page.evaluate((name) => game.settings.set('wiretap', name, true), GATE);
   await expect.poll(() => page.evaluate((name) => game.settings.get('wiretap', name), GATE), { timeout: POLL_MS })
      .toBe(true);
   await expect.poll(readSidecarGateState, { timeout: POLL_MS }).toMatchObject({ [GATE]: true });
}

/**
 * Require the macro gate to be closed on the GM page, which the closed-gate tests depend on.
 * @param {import('@playwright/test').Page} page - The GM page.
 * @returns {Promise<void>} Resolves once the check passed.
 */
async function expectGateClosed(page) {
   expect(await page.evaluate((name) => game.settings.get('wiretap', name), GATE), `${GATE} must start closed`)
      .toBe(false);
}

/**
 * Require a reply to be a gate refusal naming the macro gate.
 * @param {{ isError: boolean, text: string }} reply - The tool reply.
 * @returns {void}
 */
function expectGateDenied(reply) {
   expect(reply.isError, reply.text).toBe(true);
   expect(reply.text).toContain('GATE_DENIED');
   expect(reply.text).toContain(GATE);
}

test.describe('wiretap macro tools', () => {
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
      await expect
         .poll(toolNames, { timeout: POLL_MS })
         .toEqual(expect.arrayContaining([
            'execute_macro',
            'create_documents',
            'update_documents',
         ]));
   });

   test.afterEach(async ({ page }) => {
      try {
         await client?.close();
         client = undefined;
      } finally {
         // Anything the flows created and did not record is swept and fails the test, as does any leftover.
         const settled = await settleRegistry(page);
         await restoreGateSettings(page);
         assertSettled(settled);
      }
   });

   test('creating a Macro with a command is denied while allowMacroExecution is closed', async ({ page }) => {
      await expectGateClosed(page);
      /** @type {string} The name of the Macro the call tries to create. */
      const name = `${E2E_PREFIX}Macro ${Date.now()}`;
      const denied = await callText('create_documents', createArguments('Macro', [{
         name,
         type: 'script',
         command: 'return 2 + 3;',
      }]));
      expectGateDenied(denied);
      expect(await page.evaluate((macroName) => game.macros.getName(macroName) === undefined, name)).toBe(true);
   });

   test('with the gate open, a created macro runs, and an updated command runs the new code', async ({ page }) => {
      await openGate(page);
      const [created] = await callJson('create_documents', createArguments('Macro', [{
         name: `${E2E_PREFIX}Macro ${Date.now()}`,
         type: 'script',
         command: 'return 2 + 3;',
      }]));
      await record(page, 'Macro', created.uuid);

      expect(await callJson('execute_macro', { uuid: created.uuid })).toEqual({
         type: 'script',
         value: 5,
      });

      await callJson('update_documents', { updates: [patch(created.uuid, 'command', 'return 7;')] });
      expect(await callJson('execute_macro', { uuid: created.uuid })).toEqual({
         type: 'script',
         value: 7,
      });
   });

   test('execute_macro is denied while the gate is closed and the macro does not run', async ({ page }) => {
      await expectGateClosed(page);
      /** @type {string} The uuid of a macro that marks a page global when it runs. */
      const uuid = await createMacro(page, {
         type: 'script',
         command: 'globalThis.wiretapE2eMacroRan = true;',
      });
      try {
         expectGateDenied(await callText('execute_macro', { uuid }));
         expect(await page.evaluate(() => globalThis.wiretapE2eMacroRan)).toBeUndefined();
      } finally {
         await page.evaluate(() => {
            delete globalThis.wiretapE2eMacroRan;
         });
      }
   });

   test('a macro that throws reports MACRO_FAILED within 512 bytes', async ({ page }) => {
      /** @type {string} An error message longer than the error limit, so the check fails when it is not cut. */
      const message = `${E2E_PREFIX}macro failure ${'x'.repeat(ERROR_MAX_BYTES)}`;
      /** @type {string} The uuid of a macro that throws while it runs. */
      const uuid = await createMacro(page, {
         type: 'script',
         command: `throw new Error('${message}');`,
      });
      await openGate(page);
      const failed = await callText('execute_macro', { uuid });
      expect(failed.isError, failed.text).toBe(true);
      expect(failed.text).toContain('MACRO_FAILED');
      expect(failed.text).toContain('The macro threw; it may have partly run');
      expect(failed.text).toContain(`${E2E_PREFIX}macro failure`);
      expect(bytesOf(failed.text)).toBeLessThanOrEqual(ERROR_MAX_BYTES);
   });

   test('changing a chat Macro to script is denied while the gate is closed', async ({ page }) => {
      await expectGateClosed(page);
      /** @type {string} The uuid of a chat macro created with no command. */
      const uuid = await createMacro(page, { type: 'chat' });
      expectGateDenied(await callText('update_documents', { updates: [patch(uuid, 'type', 'script')] }));
      expect(await page.evaluate((target) => fromUuidSync(target).type, uuid)).toBe('chat');
   });

   test('execute_macro passes actorUuid as actor and tokenUuid as the placed token', async ({ page }) => {
      expect(await page.evaluate(() => game.settings.get('core', 'noCanvas')), 'the GM page must have the canvas on')
         .toBe(false);
      /** @type {number} The timestamp that makes this test's names unique. */
      const stamp = Date.now();
      /** @type {string} The name of the actor the macro acts on. */
      const actorName = `${E2E_PREFIX}Macro Actor ${stamp}`;
      /** @type {string} The id of the actor the macro acts on. */
      const actorId = await page.evaluate(
         async ({ name, type }) => (await Actor.create({
            name,
            type,
         })).id,
         {
            name: actorName,
            type: await firstSubtype(page, 'Actor'),
         },
      );
      /** @type {string} The uuid the macro receives as `actorUuid`. */
      const actorUuid = `Actor.${actorId}`;
      await record(page, 'Actor', actorUuid);
      // Foundry activates a created scene when no scene is active (client/documents/scene.mjs,
      // `_preCreateOperation`), which would pull every user to it; an explicit `active: false` keeps it inactive.
      /** @type {string} The id of the scene that holds the token. */
      const sceneId = await page.evaluate(
         async (name) => (await Scene.create({
            name,
            active: false,
         })).id,
         `${E2E_PREFIX}Macro Scene ${stamp}`,
      );
      await record(page, 'Scene', `Scene.${sceneId}`);
      /** @type {string} The uuid of the actor's token on the recorded scene. */
      const tokenUuid = await page.evaluate(
         async ({ id, name, tokenActorId }) => {
            /** @type {TokenDocument[]} The created tokens. */
            const [token] = await game.scenes.get(id).createEmbeddedDocuments('Token', [{
               name,
               actorId: tokenActorId,
               x: 0,
               y: 0,
            }]);
            return token.uuid;
         },
         {
            id: sceneId,
            name: `${E2E_PREFIX}Token`,
            tokenActorId: actorId,
         },
      );
      /** @type {string} The uuid of a macro that returns the actor's name and the token's uuid it was given. */
      const uuid = await createMacro(page, {
         type: 'script',
         command: 'return [actor?.name ?? null, token?.document?.uuid ?? null];',
      });
      await openGate(page);

      expect(await callJson('execute_macro', {
         uuid,
         actorUuid,
      })).toEqual({
         type: 'script',
         value: [
            actorName,
            null,
         ],
      });

      expect(await page.evaluate(() => game.scenes.viewed?.id ?? null)).not.toBe(sceneId);
      const offScene = await callText('execute_macro', {
         uuid,
         tokenUuid,
      });
      expect(offScene.isError, offScene.text).toBe(true);
      expect(offScene.text).toContain('ARGS_INVALID');
      expect(offScene.text).toContain('not on the scene');

      const wrongClass = await callText('execute_macro', {
         uuid,
         tokenUuid: actorUuid,
      });
      expect(wrongClass.isError, wrongClass.text).toBe(true);
      expect(wrongClass.text).toContain('ARGS_INVALID');
      expect(wrongClass.text).toContain('is a document of type Actor, not a Token');

      /** @type {string | null} The scene the GM page viewed before; Scene#view changes only this client's view. */
      const viewedBefore = await page.evaluate(() => game.scenes.viewed?.id ?? null);
      try {
         await page.evaluate((id) => game.scenes.get(id).view(), sceneId);
         // With only a token named, Foundry gives the macro the token's own actor (client/documents/macro.mjs,
         // `#executeScript`); for an unlinked token that is the synthetic actor, which carries the token's name.
         /** @type {string} The name the macro should report when it gets only the token. */
         const tokenActorName = await page.evaluate((target) => fromUuidSync(target).actor.name, tokenUuid);
         expect(tokenActorName).toBe(`${E2E_PREFIX}Token`);
         expect(await callJson('execute_macro', {
            uuid,
            tokenUuid,
         })).toEqual({
            type: 'script',
            value: [
               tokenActorName,
               tokenUuid,
            ],
         });
      } finally {
         // With no scene viewed before, unviewing the recorded scene returns the client to its blank canvas.
         await page.evaluate(
            ({ before, recorded }) => (before === null
               ? game.scenes.get(recorded).unview()
               : game.scenes.get(before).view()),
            {
               before: viewedBefore,
               recorded: sceneId,
            },
         );
      }
   });
});
