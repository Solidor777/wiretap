import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initFoundryBridge } from '~/bridge/foundryBridge.js';
import { BRIDGE_INVOKE, OP_CALL_TOOL, OP_FAILED } from '$shared/protocol.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';

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

beforeEach(() => {
   globalThis.CONST = { BASE_DOCUMENT_TYPE: 'base' };
   globalThis.game = {
      user: {
         id: 'u1',
         name: 'Gamemaster',
         isGM: true,
      },
      documentTypes: {
         Actor: [
            'base',
            'character',
         ],
      },
      settings: { get: () => false },
   };
});

afterEach(() => {
   delete globalThis.CONST;
   delete globalThis.game;
   delete globalThis.Actor;
});

describe('create_actor through the client bridge', () => {
   it('acks the created actor summary', async () => {
      globalThis.Actor = {
         create: async (data) => ({
            uuid: 'Actor.1',
            id: '1',
            name: data.name,
            type: data.type,
         }),
      };
      expect(await callShipped({ name: 'create_actor', arguments: { name: 'Bob' } })).toEqual({
         ok: true,
         result: {
            uuid: 'Actor.1',
            name: 'Bob',
            type: 'character',
         },
      });
   });

   it('acks an Actor.create failure as OP_FAILED with the world message', async () => {
      globalThis.Actor = {
         create: async () => {
            throw new Error('permission denied');
         },
      };
      expect(await callShipped({ name: 'create_actor', arguments: { name: 'Bob' } })).toEqual({
         ok: false,
         error: {
            code: OP_FAILED,
            message: 'permission denied',
         },
      });
   });

   it('acks a world with no concrete actor subtype as OP_FAILED', async () => {
      globalThis.game.documentTypes = { Actor: ['base'] };
      globalThis.Actor = { create: vi.fn() };
      const ack = await callShipped({ name: 'create_actor', arguments: { name: 'Bob' } });
      expect(ack.error.code).toBe(OP_FAILED);
      expect(ack.error.message).toMatch(/No concrete Actor subtypes/);
      expect(globalThis.Actor.create).not.toHaveBeenCalled();
   });
});
