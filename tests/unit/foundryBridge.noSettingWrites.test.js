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
      connected: true,
      on(event, fn) {
         (handlers[event] ??= []).push(fn);
      },
      emit() {},
      fire: (event, ...args) => Promise.all((handlers[event] ?? []).map((fn) => fn(...args))),
   };
}

/**
 * Build a script registry that holds the shipped scripts.
 * @returns {ReturnType<typeof createScriptRegistry>} A registry the shipped scripts registered on.
 */
function shippedRegistry() {
   const registry = createScriptRegistry({ log: () => {} });
   registerShippedScripts(registry);
   return registry;
}

/** @type {import('vitest').Mock} Spy on every settings write the fake game could perform. */
let writeSpy;

beforeEach(() => {
   writeSpy = vi.fn();
   globalThis.CONST = { BASE_DOCUMENT_TYPE: 'base' };
   globalThis.Actor = {
      create: vi.fn(async (data) => ({
         uuid: 'Actor.1',
         id: '1',
         name: data.name,
         type: data.type,
      })),
   };
   globalThis.Setting = {
      create: writeSpy,
      updateDocuments: writeSpy,
   };
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
      settings: {
         get: () => 'human',
         set: writeSpy,
      },
   };
});

afterEach(() => {
   delete globalThis.CONST;
   delete globalThis.Actor;
   delete globalThis.Setting;
   delete globalThis.game;
});

describe('bridge ops cannot write settings', () => {
   it.each([
      'setSetting',
      'set_setting',
      'updateSetting',
      'settings.set',
      'update_documents',
      'execute_macro',
   ])(
      'acks the op %s as unknown and writes nothing',
      async (op) => {
         const socket = makeFakeSocket();
         initFoundryBridge({ onSocket: (listener) => listener(socket) }, { scripts: shippedRegistry() });
         const ack = vi.fn();
         await socket.fire(
            BRIDGE_INVOKE,
            {
               op,
               params: {
                  key: 'wiretap.allowMacroExecution',
                  value: true,
               },
            },
            ack,
         );
         expect(ack).toHaveBeenCalledWith({ ok: false, error: { code: OP_FAILED, message: `Unknown op '${op}'.` } });
         expect(writeSpy).not.toHaveBeenCalled();
      },
   );

   it('passes only name and type from create_actor arguments to the world, never a setting key or value', async () => {
      const socket = makeFakeSocket();
      initFoundryBridge({ onSocket: (listener) => listener(socket) }, { scripts: shippedRegistry() });
      const ack = vi.fn();
      await socket.fire(
         BRIDGE_INVOKE,
         {
            op: OP_CALL_TOOL,
            params: {
               name: 'create_actor',
               arguments: {
                  name: 'X',
                  key: 'wiretap.allowMacroExecution',
                  value: true,
               },
            },
         },
         ack,
      );
      expect(ack).toHaveBeenCalledWith({
         ok: true,
         result: {
            uuid: 'Actor.1',
            name: 'X',
            type: 'character',
         },
      });
      expect(globalThis.Actor.create).toHaveBeenCalledWith({
         name: 'X',
         type: 'character',
      });
      expect(writeSpy).not.toHaveBeenCalled();
   });
});
