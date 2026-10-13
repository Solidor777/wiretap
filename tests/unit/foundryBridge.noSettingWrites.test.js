import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initFoundryBridge } from '~/bridge/foundryBridge.js';
import { BRIDGE_INVOKE, GATE_DENIED, OP_CALL_TOOL, OP_FAILED } from '$shared/protocol.js';
import { registerShippedScripts } from '~/bridge/scripts/index.js';
import { createScriptRegistry } from '~/bridge/scripts/registry.js';
import { installWriteWorld } from './mockWriteWorld.js';

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
      settings: {
         get: () => 'human',
         set: writeSpy,
      },
   };
});

afterEach(() => {
   delete globalThis.CONST;
   delete globalThis.CONFIG;
   delete globalThis.fromUuid;
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

   it('refuses a create_documents write of a wiretap Setting with the gate open, and writes nothing', async () => {
      const world = installWriteWorld(vi.fn);
      globalThis.game.settings.get = (module, key) => (key === 'allowSettingWrites' ? true : false);
      globalThis.game.settings.set = writeSpy;
      const socket = makeFakeSocket();
      initFoundryBridge({ onSocket: (listener) => listener(socket) }, { scripts: shippedRegistry() });
      const ack = vi.fn();
      await socket.fire(
         BRIDGE_INVOKE,
         {
            op: OP_CALL_TOOL,
            params: {
               name: 'create_documents',
               arguments: {
                  documentName: 'Setting',
                  data: ['{"key":"wiretap.allowMacroExecution","value":"true"}'],
               },
            },
         },
         ack,
      );
      expect(ack.mock.calls[0][0].ok).toBe(false);
      expect(ack.mock.calls[0][0].error.code).toBe(GATE_DENIED);
      expect(world.classes.Setting.createDocuments).not.toHaveBeenCalled();
      expect(writeSpy).not.toHaveBeenCalled();
   });

   it('refuses an update_documents write that renames a Setting into the wiretap namespace', async () => {
      const world = installWriteWorld(vi.fn);
      globalThis.game.settings.get = (module, key) => (key === 'allowSettingWrites' ? true : false);
      const setting = world.add('Setting', {
         key: 'mock.setting',
         value: '1',
      });
      const socket = makeFakeSocket();
      initFoundryBridge({ onSocket: (listener) => listener(socket) }, { scripts: shippedRegistry() });
      const ack = vi.fn();
      await socket.fire(
         BRIDGE_INVOKE,
         {
            op: OP_CALL_TOOL,
            params: {
               name: 'update_documents',
               arguments: {
                  updates: [
                     {
                        uuid: setting.uuid,
                        path: 'key',
                        value: '"wiretap.allowMacroExecution"',
                     },
                  ],
               },
            },
         },
         ack,
      );
      expect(ack.mock.calls[0][0].error.code).toBe(GATE_DENIED);
      expect(setting.update).not.toHaveBeenCalled();
   });
});
