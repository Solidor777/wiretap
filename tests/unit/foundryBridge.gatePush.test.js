import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initFoundryBridge } from '~/bridge/foundryBridge.js';
import { readGateState } from '~/bridge/gates.js';
import { closedGateState, GATES } from '$shared/gates.js';
import { BRIDGE_GATE_STATE, BRIDGE_IDENTIFY, NOT_GM, OP_FAILED } from '$shared/protocol.js';

/**
 * Build a controllable fake Socket.IO socket that records emits and their ack callbacks.
 * @param {boolean} connected - Initial value of `socket.connected`.
 * @returns {object} A socket with `emitted` (recorded emits), `fire` (trigger handlers) and `connected`.
 */
function makeFakeSocket(connected) {
   const handlers = {};
   const socket = {
      connected,
      emitted: [],
      on(event, fn) {
         (handlers[event] ??= []).push(fn);
      },
      emit(event, payload, ack) {
         socket.emitted.push({ event, payload, ack });
      },
      fire: (event, ...args) => Promise.all((handlers[event] ?? []).map((fn) => fn(...args))),
   };
   return socket;
}

/**
 * Wire the bridge onto a fake socket through a fake connection.
 * @param {object} socket - The fake socket.
 * @returns {void}
 */
function wire(socket) {
   initFoundryBridge({ onSocket: (listener) => listener(socket) });
}

/** @type {Record<string, unknown>} World setting values keyed by setting name. */
let stored;

/** @type {boolean} Whether the fake user is a GM. */
let isGM;

/**
 * Store a gate value as the world setting and fire the matching Foundry setting hook with Foundry's argument order:
 * `createSetting(document, options, userId)`, `updateSetting(document, changes, options, userId)` and
 * `deleteSetting(document, options, userId)`.
 * @param {string} hook - The hook name: `createSetting`, `updateSetting` or `deleteSetting`.
 * @param {string} key - The full setting key, for example `wiretap.allowUserWrites`.
 * @param {unknown} value - The new stored value.
 * @param {string} [authorId] - The id of the user who made the change; defaults to the GM `gm1`.
 * @returns {void}
 */
function changeSetting(hook, key, value, authorId = 'gm1') {
   stored[key.replace(/^[^.]*\./, '')] = value;
   if (hook === 'updateSetting') {
      Hooks.call(hook, { key, value }, { value }, {}, authorId);
   } else {
      Hooks.call(hook, { key, value }, {}, authorId);
   }
}

/**
 * Gate-state emits recorded on a socket.
 * @param {object} socket - The fake socket.
 * @returns {object[]} The BRIDGE_GATE_STATE emits.
 */
function gateEmits(socket) {
   return socket.emitted.filter((entry) => entry.event === BRIDGE_GATE_STATE);
}

beforeEach(() => {
   stored = { endpointKind: 'human' };
   isGM = true;
   globalThis.game = {
      user: {
         id: 'u1',
         name: 'Gamemaster',
         get isGM() {
            return isGM;
         },
      },
      settings: { get: (module, key) => stored[key] },
      users: new Map([
         [
            'gm1',
            { isGM: true },
         ],
         [
            'player1',
            { isGM: false },
         ],
      ]),
   };
   vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
   delete globalThis.game;
   vi.restoreAllMocks();
});

describe('gate snapshot in the identify', () => {
   it('carries the fresh snapshot read from the settings', () => {
      stored.allowUserWrites = true;
      const socket = makeFakeSocket(true);
      wire(socket);
      const identify = socket.emitted.find((entry) => entry.event === BRIDGE_IDENTIFY);
      expect(identify.payload.gateState).toEqual(readGateState());
      expect(identify.payload.gateState.allowUserWrites).toBe(true);
   });

   it('re-reads the settings on every identify', () => {
      const socket = makeFakeSocket(false);
      wire(socket);
      socket.fire('connect');
      stored.allowFileUpload = true;
      socket.fire('connect');
      const identifies = socket.emitted.filter((entry) => entry.event === BRIDGE_IDENTIFY);
      expect(identifies[0].payload.gateState.allowFileUpload).toBe(false);
      expect(identifies[1].payload.gateState.allowFileUpload).toBe(true);
   });
});

describe('gate snapshot push on setting change', () => {
   it.each([
      'createSetting',
      'updateSetting',
      'deleteSetting',
   ])(
      'emits BRIDGE_GATE_STATE on %s of a gate key',
      (hook) => {
         const socket = makeFakeSocket(true);
         wire(socket);
         changeSetting(hook, 'wiretap.allowMacroExecution', true);
         const pushes = gateEmits(socket);
         expect(pushes).toHaveLength(1);
         expect(pushes[0].payload).toEqual({ ...closedGateState(), allowMacroExecution: true });
         expect(typeof pushes[0].ack).toBe('function');
      },
   );

   it('pushes every registry gate key, including the module list', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      for (const name of Object.keys(GATES)) {
         changeSetting('updateSetting', `wiretap.${name}`, name === 'allowedPluginModules' ? 'mod-a' : true);
      }
      expect(gateEmits(socket)).toHaveLength(Object.keys(GATES).length);
      expect(gateEmits(socket).at(-1).payload.allowedPluginModules).toEqual(['mod-a']);
   });

   it('pushes a sanitized snapshot when the stored value is hostile', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      changeSetting('updateSetting', 'wiretap.allowMacroExecution', 'true');
      expect(gateEmits(socket)[0].payload.allowMacroExecution).toBe(false);
   });

   it('ignores keys that are not Wiretap gates', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      const keys = [
         'wiretap.terminalTheme',
         'wiretap.endpointKind',
         'wiretap.constructor',
         'core.rollMode',
         'wiretap.',
      ];
      for (const key of keys) {
         changeSetting('updateSetting', key, 'x');
      }
      expect(gateEmits(socket)).toHaveLength(0);
   });

   it.each([
      'createSetting',
      'updateSetting',
      'deleteSetting',
   ])(
      'ignores a %s made by a user who is not a GM',
      (hook) => {
         const socket = makeFakeSocket(true);
         wire(socket);
         changeSetting(hook, 'wiretap.allowMacroExecution', true, 'player1');
         expect(gateEmits(socket)).toHaveLength(0);
      },
   );

   it('ignores a change whose author is unknown or missing', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      changeSetting('updateSetting', 'wiretap.allowMacroExecution', true, 'ghost');
      Hooks.call('updateSetting', { key: 'wiretap.allowMacroExecution' }, {}, {});
      expect(gateEmits(socket)).toHaveLength(0);
   });

   it('pushes a change made by another GM', () => {
      globalThis.game.users.set('gm2', { isGM: true });
      const socket = makeFakeSocket(true);
      wire(socket);
      changeSetting('updateSetting', 'wiretap.allowMacroExecution', true, 'gm2');
      expect(gateEmits(socket)).toHaveLength(1);
   });

   it('does not push from a non-GM client', () => {
      isGM = false;
      const socket = makeFakeSocket(true);
      wire(socket);
      changeSetting('updateSetting', 'wiretap.allowMacroExecution', true);
      expect(gateEmits(socket)).toHaveLength(0);
   });

   it('does not push while the socket is disconnected', () => {
      const socket = makeFakeSocket(false);
      wire(socket);
      changeSetting('updateSetting', 'wiretap.allowMacroExecution', true);
      expect(gateEmits(socket)).toHaveLength(0);
   });

   it('does not double-push when the bridge is wired twice', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      wire(socket);
      changeSetting('updateSetting', 'wiretap.allowMacroExecution', true);
      expect(gateEmits(socket)).toHaveLength(1);
   });

   it('does not throw into the hook when the hook document is malformed', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      expect(() => Hooks.call('updateSetting', null, {}, {}, 'u1')).not.toThrow();
      expect(() => Hooks.call('updateSetting', { key: 5 }, {}, {}, 'u1')).not.toThrow();
      expect(gateEmits(socket)).toHaveLength(0);
   });
});

describe('gate snapshot push ack', () => {
   it('logs a refusal with its code and message', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      changeSetting('updateSetting', 'wiretap.allowMacroExecution', true);
      gateEmits(socket)[0].ack({
         ok: false,
         error: {
            code: NOT_GM,
            message: 'Only an identified GM may set gates.',
         },
      });
      const logged = console.error.mock.calls.flat().join(' ');
      expect(logged).toContain('gate state refused');
      expect(logged).toContain(NOT_GM);
      expect(logged).toContain('Only an identified GM may set gates.');
   });

   it('logs an OP_FAILED refusal and a missing ack argument', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      changeSetting('updateSetting', 'wiretap.allowMacroExecution', true);
      gateEmits(socket)[0].ack({
         ok: false,
         error: {
            code: OP_FAILED,
            message: 'boom',
         },
      });
      gateEmits(socket)[0].ack(undefined);
      expect(console.error).toHaveBeenCalledTimes(2);
      expect(console.error.mock.calls[1].join(' ')).toContain('UNKNOWN');
   });

   it('stays silent on an ok ack', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      changeSetting('updateSetting', 'wiretap.allowMacroExecution', true);
      gateEmits(socket)[0].ack({ ok: true });
      expect(console.error).not.toHaveBeenCalled();
   });
});
