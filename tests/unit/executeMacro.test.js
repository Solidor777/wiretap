import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getBudget } from '$shared/budgets.js';
import { GATE_DENIED } from '$shared/protocol.js';
import { createCallTool, RESULT_WIRE_MAX_BYTES } from '~/bridge/scripts/callTool.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import { executeMacroDefinition } from '~/bridge/scripts/macroDefinitions.js';
import { executeMacroHandler } from '~/bridge/scripts/executeMacro.js';

/** @type {string} The uuid of the mocked Macro. */
const uuid = 'Macro.MOCKMACRO0000001';

/** @type {string} The uuid of the mocked Actor. */
const ACTOR_UUID = 'Actor.MOCKACTOR0000001';

/** @type {string} The uuid of the mocked Token. */
const TOKEN_UUID = 'Scene.MOCKSCENE0000001.Token.MOCKTOKEN0000001';

/** @type {string} The uuid of the mocked Item. */
const ITEM_UUID = 'Item.MOCKITEM00000001';

/** @type {{ name: string, arguments: { uuid: string } }} The `callTool` params that run the mocked Macro. */
const CALL = {
   name: 'execute_macro',
   arguments: { uuid },
};

/**
 * A stand-in for `foundry.abstract.Document`, so a macro can return a document.
 */
class MockDocument {
   /**
    * Build a document with a uuid.
    * @param {string} documentUuid - The uuid the macro's result is reported as.
    */
   constructor(documentUuid) {
      /** @type {string} The document's uuid. */
      this.uuid = documentUuid;
   }
}

/** @type {{ documentName: string, type: string, execute: import('vitest').Mock }} The mocked Macro. */
let macro;

/** @type {{ documentName: string, uuid: string }} The mocked Actor. */
let actor;

/** @type {{ documentName: string, uuid: string, object: object | null }} The mocked TokenDocument. */
let tokenDocument;

/** @type {{ alias: string }} The speaker `getSpeaker` returns. */
let speaker;

/** @type {import('vitest').Mock} The mocked `ChatMessage.implementation.getSpeaker`. */
let getSpeaker;

/** @type {Record<string, unknown>} The stored gate values keyed by gate name. */
let gates;

/** @type {object} The call context the handler receives. */
const ctx = {};

beforeEach(() => {
   macro = {
      documentName: 'Macro',
      type: 'script',
      execute: vi.fn(async () => undefined),
   };
   actor = {
      documentName: 'Actor',
      uuid: ACTOR_UUID,
   };
   tokenDocument = {
      documentName: 'Token',
      uuid: TOKEN_UUID,
      object: { placeable: 'MOCK_token' },
   };
   speaker = { alias: 'MOCK_speaker' };
   getSpeaker = vi.fn(() => speaker);
   gates = {};
   /** @type {Map<string, object>} The documents `fromUuid` resolves. */
   const documents = new Map([
      [
         uuid,
         macro,
      ],
      [
         ACTOR_UUID,
         actor,
      ],
      [
         TOKEN_UUID,
         tokenDocument,
      ],
      [
         ITEM_UUID,
         {
            documentName: 'Item',
            uuid: ITEM_UUID,
         },
      ],
   ]);
   globalThis.fromUuid = vi.fn(async (value) => documents.get(value) ?? null);
   globalThis.foundry = {
      abstract: { Document: MockDocument },
      documents: { ChatMessage: { implementation: { getSpeaker } } },
   };
   globalThis.game = {
      settings: {
         get: (module, key) => {
            if (key === 'allowedPluginModules') {
               return '';
            }
            return gates[key] ?? false;
         },
      },
   };
});

afterEach(() => {
   for (const name of [
      'fromUuid',
      'foundry',
      'game',
   ]) {
      delete globalThis[name];
   }
});

/**
 * Run a call and return what it threw.
 * @param {() => Promise<unknown>} call - The operation to attempt.
 * @returns {Promise<Error | null>} The rejection, or null when the call resolved.
 */
async function outcome(call) {
   try {
      await call();
   } catch (error) {
      return error;
   }
   return null;
}

describe('execute_macro definition', () => {
   it('declares the pinned name, gate, budget and arguments', () => {
      expect(executeMacroDefinition).toMatchObject({
         name: 'execute_macro',
         version: '1.0.0',
         requires: 'api',
         mutates: true,
         gate: 'allowMacroExecution',
         result: { budgetBytes: getBudget('RESULT_HARD_CAP_MAX_BYTES').value },
      });
      expect(executeMacroDefinition.description).toBe(
         'Run a Macro by uuid on this GM client and return its value; actorUuid and tokenUuid set its actor and ' +
            'token. Arbitrary code: needs allowMacroExecution.',
      );
      expect(executeMacroDefinition.description).toHaveLength(151);
      expect(executeMacroDefinition.inputSchema).toEqual({
         type: 'object',
         properties: {
            uuid: { type: 'string' },
            actorUuid: { type: 'string' },
            tokenUuid: { type: 'string' },
            timeoutMs: {
               type: 'integer',
               minimum: 1000,
               maximum: 300_000,
            },
         },
         required: ['uuid'],
         additionalProperties: false,
      });
   });

   it.each([
      [
         999,
         'timeoutMs: must be at least 1000',
      ],
      [
         300_001,
         'timeoutMs: must be at most 300000',
      ],
      [
         1500.5,
         'timeoutMs: expected an integer',
      ],
   ])('refuses timeoutMs %s through callTool before the macro runs', async (timeoutMs, message) => {
      const registry = createScriptRegistry({ log: () => {} });
      registry.register(executeMacroDefinition, executeMacroHandler);
      const callTool = createCallTool({ registry });
      gates.allowMacroExecution = true;
      const error = await outcome(() => callTool({
         name: 'execute_macro',
         arguments: {
            uuid,
            timeoutMs,
         },
      }));
      expect(error?.code).toBe('ARGS_INVALID');
      expect(error.message).toBe(message);
      expect(macro.execute).not.toHaveBeenCalled();
   });
});

describe('execute_macro time limit', () => {
   afterEach(() => {
      vi.useRealTimers();
   });

   /**
    * Start a call to a macro that never finishes and return its pending outcome.
    * @param {Record<string, unknown>} args - The call's arguments.
    * @returns {Promise<Error | null>} The call's rejection, or null when it resolved.
    */
   function hangingCall(args) {
      const registry = createScriptRegistry({ log: () => {} });
      registry.register(executeMacroDefinition, executeMacroHandler);
      const callTool = createCallTool({ registry });
      gates.allowMacroExecution = true;
      macro.execute.mockImplementation(() => new Promise(() => {}));
      return outcome(() => callTool({
         name: 'execute_macro',
         arguments: args,
      }));
   }

   it('runs under the call\'s timeoutMs', async () => {
      vi.useFakeTimers();
      /** @type {Promise<Error | null>} The pending call. */
      const pending = hangingCall({
         uuid,
         timeoutMs: 20_000,
      });
      /** @type {Error | null | undefined} The call's outcome once it settles. */
      let settled;
      pending.then((error) => {
         settled = error;
      });
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled?.code).toBe('SCRIPT_TIMEOUT');
      expect(settled.message).toContain('20 s');
   });

   it('runs under 8 s when timeoutMs is absent', async () => {
      vi.useFakeTimers();
      /** @type {Promise<Error | null>} The pending call. */
      const pending = hangingCall({ uuid });
      await vi.advanceTimersByTimeAsync(8000);
      expect((await pending)?.code).toBe('SCRIPT_TIMEOUT');
   });
});

describe('execute_macro gate', () => {
   it('is denied by callTool while allowMacroExecution is closed, and the macro does not run', async () => {
      const registry = createScriptRegistry({ log: () => {} });
      expect(registry.register(executeMacroDefinition, executeMacroHandler)).toEqual({
         ok: true,
         name: 'execute_macro',
      });
      const callTool = createCallTool({ registry });
      expect((await outcome(() => callTool(CALL)))?.code).toBe(GATE_DENIED);
      expect(macro.execute).not.toHaveBeenCalled();
   });

   it('runs the macro through callTool once allowMacroExecution is open', async () => {
      const registry = createScriptRegistry({ log: () => {} });
      registry.register(executeMacroDefinition, executeMacroHandler);
      const callTool = createCallTool({ registry });
      gates.allowMacroExecution = true;
      macro.execute.mockResolvedValue(5);
      await expect(callTool(CALL)).resolves.toEqual({
         type: 'script',
         value: 5,
      });
   });
});

describe('execute_macro results', () => {
   it('runs a script macro and returns its value', async () => {
      macro.execute.mockResolvedValue(5);
      await expect(executeMacroHandler({ uuid }, ctx)).resolves.toEqual({
         type: 'script',
         value: 5,
      });
   });

   it('returns null for a macro that returns nothing', async () => {
      await expect(executeMacroHandler({ uuid }, ctx)).resolves.toEqual({
         type: 'script',
         value: null,
      });
   });

   it('returns a plain copy of an object value', async () => {
      macro.execute.mockResolvedValue({
         total: 3,
         skipped: undefined,
         when: new Date(0),
      });
      await expect(executeMacroHandler({ uuid }, ctx)).resolves.toEqual({
         type: 'script',
         value: {
            total: 3,
            when: '1970-01-01T00:00:00.000Z',
         },
      });
   });

   it('returns a Document result as its uuid', async () => {
      macro.execute.mockResolvedValue(new MockDocument('Actor.MOCKACTOR0000002'));
      await expect(executeMacroHandler({ uuid }, ctx)).resolves.toEqual({
         type: 'script',
         value: 'Actor.MOCKACTOR0000002',
      });
   });

   it('returns null with unserializable true for a cyclic value', async () => {
      /** @type {Record<string, unknown>} A value that refers to itself. */
      const cyclic = { name: 'MOCK_cycle' };
      cyclic.self = cyclic;
      macro.execute.mockResolvedValue(cyclic);
      await expect(executeMacroHandler({ uuid }, ctx)).resolves.toEqual({
         type: 'script',
         value: null,
         unserializable: true,
      });
   });

   it.each([
      [
         'a BigInt',
         10n,
      ],
      [
         'a function',
         () => 1,
      ],
   ])('returns null with unserializable true for %s', async (label, value) => {
      macro.execute.mockResolvedValue(value);
      await expect(executeMacroHandler({ uuid }, ctx)).resolves.toEqual({
         type: 'script',
         value: null,
         unserializable: true,
      });
   });

   it('reports MACRO_FAILED with bounded text saying it may have partly run when the macro rejects', async () => {
      macro.execute.mockRejectedValue(new Error(`boom\n${'x'.repeat(10_000)}`));
      const error = await outcome(() => executeMacroHandler({ uuid }, ctx));
      expect(error?.code).toBe('MACRO_FAILED');
      expect(error.message).toMatch(/^The macro threw; it may have partly run: .*boom/);
      expect(error.message).not.toContain('\n');
      expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(256);
   });

   it('reports MACRO_FAILED with bounded text saying nothing ran when the command does not compile', async () => {
      macro.execute.mockImplementation(() => {
         throw new SyntaxError(`Unexpected token\n${'x'.repeat(10_000)}`);
      });
      const error = await outcome(() => executeMacroHandler({ uuid }, ctx));
      expect(error?.code).toBe('MACRO_FAILED');
      expect(error.message).toMatch(/^The macro did not compile; nothing ran: .*Unexpected token/);
      expect(error.message).not.toContain('\n');
      expect(new TextEncoder().encode(error.message).length).toBeLessThanOrEqual(256);
   });

   it('reports a value too large for the wire as a success with tooLarge and the value\'s size', async () => {
      /** @type {string} A value whose JSON, with its quotes, is one byte over the wire bound. */
      const huge = 'x'.repeat(RESULT_WIRE_MAX_BYTES - 1);
      macro.execute.mockResolvedValue(huge);
      await expect(executeMacroHandler({ uuid }, ctx)).resolves.toEqual({
         type: 'script',
         value: null,
         tooLarge: true,
         bytes: RESULT_WIRE_MAX_BYTES + 1,
      });
   });

   it('reports tooLarge when the value fits the bound but the whole result does not', async () => {
      /** @type {string} A value whose JSON is exactly the wire bound. */
      const edge = 'x'.repeat(RESULT_WIRE_MAX_BYTES - 2);
      macro.execute.mockResolvedValue(edge);
      await expect(executeMacroHandler({ uuid }, ctx)).resolves.toEqual({
         type: 'script',
         value: null,
         tooLarge: true,
         bytes: RESULT_WIRE_MAX_BYTES,
      });
   });

   it('returns the largest value that fits the wire bound', async () => {
      /** @type {number} The bytes of the result around the value: `{"type":"script","value":}`. */
      const envelope = JSON.stringify({
         type: 'script',
         value: null,
      }).length - 'null'.length;
      /** @type {string} A value whose result is exactly the wire bound. */
      const fits = 'x'.repeat(RESULT_WIRE_MAX_BYTES - envelope - 2);
      macro.execute.mockResolvedValue(fits);
      await expect(executeMacroHandler({ uuid }, ctx)).resolves.toEqual({
         type: 'script',
         value: fits,
      });
   });

   it('acks a too-large value through callTool as a success, not RESULT_TOO_LARGE', async () => {
      const registry = createScriptRegistry({ log: () => {} });
      registry.register(executeMacroDefinition, executeMacroHandler);
      const callTool = createCallTool({ registry });
      gates.allowMacroExecution = true;
      macro.execute.mockResolvedValue({ text: 'é'.repeat(RESULT_WIRE_MAX_BYTES) });
      await expect(callTool(CALL)).resolves.toEqual({
         type: 'script',
         value: null,
         tooLarge: true,
         bytes: 2 * RESULT_WIRE_MAX_BYTES + '{"text":""}'.length,
      });
   });

   it('returns the uuid of the message a chat macro creates', async () => {
      macro.type = 'chat';
      macro.execute.mockResolvedValue(new MockDocument('ChatMessage.MOCKMESSAGE00001'));
      await expect(executeMacroHandler({ uuid }, ctx)).resolves.toEqual({
         type: 'chat',
         value: 'ChatMessage.MOCKMESSAGE00001',
      });
   });
});

describe('execute_macro arguments', () => {
   it('refuses a document that is not a Macro with ARGS_INVALID', async () => {
      const error = await outcome(() => executeMacroHandler({ uuid: ACTOR_UUID }, ctx));
      expect(error?.code).toBe('ARGS_INVALID');
      expect(error.message).toBe(`uuid '${ACTOR_UUID}' is a document of type Actor, not a Macro.`);
      expect(macro.execute).not.toHaveBeenCalled();
   });

   it('refuses an unknown uuid with DOC_NOT_FOUND', async () => {
      const error = await outcome(() => executeMacroHandler({ uuid: 'Macro.MOCKMISSING00001' }, ctx));
      expect(error?.code).toBe('DOC_NOT_FOUND');
   });

   it('bounds and cleans a hostile uuid in the refusal', async () => {
      /** @type {string} A long uuid with a newline that resolves to an Actor. */
      const hostile = `Actor.\n${'y'.repeat(500)}`;
      globalThis.fromUuid = vi.fn(async () => actor);
      const error = await outcome(() => executeMacroHandler({ uuid: hostile }, ctx));
      expect(error?.code).toBe('ARGS_INVALID');
      expect(error.message).not.toContain('\n');
      expect(error.message).not.toContain('y'.repeat(65));
   });

   it('calls execute with no scope when neither actorUuid nor tokenUuid is given', async () => {
      await executeMacroHandler({ uuid }, ctx);
      expect(macro.execute).toHaveBeenCalledWith();
      expect(getSpeaker).not.toHaveBeenCalled();
   });

   it('passes the named actor and its speaker', async () => {
      await executeMacroHandler(
         {
            uuid,
            actorUuid: ACTOR_UUID,
         },
         ctx,
      );
      expect(getSpeaker).toHaveBeenCalledWith({
         actor,
         token: undefined,
      });
      expect(macro.execute).toHaveBeenCalledWith({
         speaker,
         actor,
         token: undefined,
      });
   });

   it('passes the named token as its placeable', async () => {
      await executeMacroHandler(
         {
            uuid,
            tokenUuid: TOKEN_UUID,
         },
         ctx,
      );
      expect(getSpeaker).toHaveBeenCalledWith({
         actor: undefined,
         token: tokenDocument.object,
      });
      expect(macro.execute).toHaveBeenCalledWith({
         speaker,
         actor: undefined,
         token: tokenDocument.object,
      });
   });

   it('passes both the named actor and the named token', async () => {
      await executeMacroHandler(
         {
            uuid,
            actorUuid: ACTOR_UUID,
            tokenUuid: TOKEN_UUID,
         },
         ctx,
      );
      expect(macro.execute).toHaveBeenCalledWith({
         speaker,
         actor,
         token: tokenDocument.object,
      });
   });

   it.each([
      [
         'actorUuid',
         ITEM_UUID,
         `actorUuid '${ITEM_UUID}' is a document of type Item, not an Actor.`,
      ],
      [
         'tokenUuid',
         ACTOR_UUID,
         `tokenUuid '${ACTOR_UUID}' is a document of type Actor, not a Token.`,
      ],
   ])('refuses %s naming a %s with ARGS_INVALID and does not run the macro', async (name, value, text) => {
      const error = await outcome(() => executeMacroHandler(
         {
            uuid,
            [name]: value,
         },
         ctx,
      ));
      expect(error?.code).toBe('ARGS_INVALID');
      expect(error.message).toBe(text);
      expect(macro.execute).not.toHaveBeenCalled();
   });

   it.each([
      'actorUuid',
      'tokenUuid',
   ])('refuses an unknown %s with DOC_NOT_FOUND and does not run the macro', async (name) => {
      const error = await outcome(() => executeMacroHandler(
         {
            uuid,
            [name]: 'Actor.MOCKMISSING00001',
         },
         ctx,
      ));
      expect(error?.code).toBe('DOC_NOT_FOUND');
      expect(macro.execute).not.toHaveBeenCalled();
   });

   it('refuses a token that is not on the viewed scene with ARGS_INVALID', async () => {
      tokenDocument.object = null;
      const error = await outcome(() => executeMacroHandler(
         {
            uuid,
            tokenUuid: TOKEN_UUID,
         },
         ctx,
      ));
      expect(error?.code).toBe('ARGS_INVALID');
      expect(error.message).toBe(
         `tokenUuid '${TOKEN_UUID}' is not on the scene this client views; a macro acts on a token placed on the ` +
            'canvas.',
      );
      expect(macro.execute).not.toHaveBeenCalled();
   });

   it('reports the first refusal in the order uuid, actorUuid, tokenUuid', async () => {
      tokenDocument.object = null;
      const error = await outcome(() => executeMacroHandler(
         {
            uuid,
            actorUuid: ITEM_UUID,
            tokenUuid: TOKEN_UUID,
         },
         ctx,
      ));
      expect(error.message).toContain('not an Actor');
   });
});
