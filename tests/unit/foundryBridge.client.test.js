import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initFoundryBridge } from '~/bridge/foundryBridge.js';
import { BRIDGE_INVOKE, GATE_DENIED, OP_CALL_TOOL, OP_FAILED } from '$shared/protocol.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import { createCallTool } from '~/bridge/scripts/callTool.js';
import { installWriteWorld } from './mockWriteWorld.js';

// The real callTool runs; each handler it builds is wrapped in a spy so a test can see the arguments the bridge passes.
vi.mock('~/bridge/scripts/callTool.js', async (importOriginal) => {
   /** @type {typeof import('~/bridge/scripts/callTool.js')} The real module. */
   const actual = await importOriginal();
   return {
      ...actual,
      createCallTool: vi.fn((options) => vi.fn(actual.createCallTool(options))),
   };
});

/**
 * Build a fake Socket.IO socket whose handlers can be fired.
 * @returns {object} The fake socket with `fire`.
 */
function makeFakeSocket() {
   const handlers = {};
   return {
      connected: false,
      on(event, fn) {
         (handlers[event] ??= []).push(fn);
      },
      emit() {},
      fire: (event, ...args) => Promise.all((handlers[event] ?? []).map((fn) => fn(...args))),
   };
}

/**
 * Invoke the callTool op on a bridge wired to a registry that holds the shipped scripts.
 * @param {object} params - The callTool params.
 * @returns {Promise<object>} The ack the client sent.
 */
async function callShipped(params) {
   const registry = createScriptRegistry({ log: () => {} });
   registerShippedScripts(registry);
   const socket = makeFakeSocket();
   initFoundryBridge(
      { onSocket: (listener) => listener(socket) },
      { scripts: registry },
   );
   const ack = vi.fn();
   await socket.fire(
      BRIDGE_INVOKE,
      {
         op: OP_CALL_TOOL,
         params,
         requestId: 'r1',
      },
      ack,
   );
   return ack.mock.calls[0][0];
}

/** @type {ReturnType<typeof installWriteWorld>} The mocked world. */
let world;

/** @type {Record<string, unknown>} Stored gate values keyed by gate name. */
let gates;

beforeEach(() => {
   world = installWriteWorld(vi.fn);
   gates = {};
   globalThis.game.user = {
      id: 'u1',
      name: 'Gamemaster',
      isGM: true,
   };
   globalThis.game.settings.get = (module, key) => gates[key];
});

afterEach(() => {
   for (const name of [
      'CONST',
      'CONFIG',
      'fromUuid',
      'game',
   ]) {
      delete globalThis[name];
   }
});

describe('op handler invocation', () => {
   it('calls an op handler with the params and { requestId, pieces }', async () => {
      const socket = makeFakeSocket();
      initFoundryBridge(
         { onSocket: (listener) => listener(socket) },
         { scripts: createScriptRegistry({ log: () => {} }) },
      );
      /** @type {import('vitest').Mock} The spied callTool handler the bridge registered. */
      const handler = vi.mocked(createCallTool).mock.results.at(-1).value;
      const params = {
         name: 'missing_script',
         arguments: {},
      };
      const first = socket.fire(
         BRIDGE_INVOKE,
         {
            op: OP_CALL_TOOL,
            params,
            requestId: 'r1',
         },
         vi.fn(),
      );
      // The handler runs before the listener's first await, so it can register a piece receiver in time.
      expect(handler).toHaveBeenCalledTimes(1);
      await first;
      await socket.fire(
         BRIDGE_INVOKE,
         {
            op: OP_CALL_TOOL,
            params,
            requestId: 'r2',
         },
         vi.fn(),
      );
      const [
         firstCall,
         secondCall,
      ] = handler.mock.calls;
      expect(firstCall[0]).toBe(params);
      expect(firstCall[1].requestId).toBe('r1');
      expect(Object.keys(firstCall[1]).sort()).toEqual([
         'pieces',
         'requestId',
      ]);
      expect(typeof firstCall[1].pieces.send).toBe('function');
      expect(typeof firstCall[1].pieces.end).toBe('function');
      expect(typeof firstCall[1].pieces.receive).toBe('function');
      expect(secondCall[1].requestId).toBe('r2');
      expect(secondCall[1].pieces).toBe(firstCall[1].pieces);
   });
});

describe('the write scripts through the client bridge', () => {
   it('acks the created document rows', async () => {
      const ack = await callShipped({
         name: 'create_documents',
         arguments: {
            documentName: 'Actor',
            data: ['{"name":"Bob","type":"npc"}'],
         },
      });
      expect(ack).toEqual({
         ok: true,
         result: [
            {
               uuid: expect.stringMatching(/^Actor\./),
               name: 'Bob',
               type: 'npc',
            },
         ],
      });
   });

   it('acks a Foundry failure as OP_FAILED with the world message', async () => {
      world.classes.Actor.createDocuments.mockImplementation(async () => {
         throw new Error('permission denied');
      });
      expect(
         await callShipped({
            name: 'create_documents',
            arguments: {
               documentName: 'Actor',
               data: ['{"name":"Bob","type":"npc"}'],
            },
         }),
      ).toEqual({
         ok: false,
         error: {
            code: OP_FAILED,
            message: 'permission denied',
         },
      });
   });

   it('acks a closed gate as GATE_DENIED and writes nothing', async () => {
      const ack = await callShipped({
         name: 'create_documents',
         arguments: {
            documentName: 'User',
            data: ['{"name":"Bob"}'],
         },
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe(GATE_DENIED);
      expect(world.calls).toEqual([]);
   });

   it('acks validation failures as VALIDATION_FAILED with at most 10 failures and the true count', async () => {
      const invalid = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`system.f${index}`, 'bad']));
      const ack = await callShipped({
         name: 'create_documents',
         arguments: {
            documentName: 'Actor',
            data: [JSON.stringify({ name: 'Bob', invalid })],
         },
      });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe('VALIDATION_FAILED');
      expect(ack.error.failures).toHaveLength(10);
      expect(ack.error.failureCount).toBe(30);
   });
});
