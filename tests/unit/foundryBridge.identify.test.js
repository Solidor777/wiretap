import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initFoundryBridge, reidentifyBridge, bridgeState } from '~/bridge/foundryBridge.js';
import {
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   BRIDGE_PING,
   NOT_GM,
   OP_FAILED,
   PROTOCOL_MISMATCH,
   PROTOCOL_VERSION,
} from '$shared/protocol.js';
import { closedGateState } from '$shared/gates.js';

/**
 * Build a controllable fake Socket.IO socket that records emits and their ack callbacks.
 * @param {boolean} connected - Initial value of `socket.connected`.
 * @returns {object} The fake socket with `fire`, `emitted` and `connected`.
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

/** @type {string} The endpointKind setting value returned by the fake game. */
let kind;

beforeEach(() => {
   kind = 'human';
   bridgeState.identified = false;
   globalThis.game = {
      user: { id: 'u1', name: 'Gamemaster', isGM: true },
      settings: { get: (module, key) => (key === 'endpointKind' ? kind : undefined) },
   };
   vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
   delete globalThis.game;
   vi.restoreAllMocks();
});

describe('bridge identify', () => {
   it('emits the identify payload with an ack callback on connect', () => {
      const socket = makeFakeSocket(false);
      wire(socket);
      socket.fire('connect');
      expect(socket.emitted).toHaveLength(1);
      expect(socket.emitted[0].event).toBe(BRIDGE_IDENTIFY);
      expect(socket.emitted[0].payload).toEqual({
         protocolVersion: PROTOCOL_VERSION,
         userId: 'u1',
         userName: 'Gamemaster',
         isGM: true,
         kind: 'human',
         dom: true,
         gateState: closedGateState(),
      });
      expect(typeof socket.emitted[0].ack).toBe('function');
   });

   it('identifies immediately when the socket is already connected', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      expect(socket.emitted).toHaveLength(1);
   });

   it('takes kind from the endpointKind setting at identify time', () => {
      const socket = makeFakeSocket(false);
      wire(socket);
      kind = 'agent';
      socket.fire('connect');
      expect(socket.emitted[0].payload.kind).toBe('agent');
   });
});

describe('bridge identify ack and identified state', () => {
   it('goes false -> true after an ok ack -> false on disconnect', () => {
      const socket = makeFakeSocket(false);
      wire(socket);
      expect(bridgeState.identified).toBe(false);
      socket.connected = true;
      socket.fire('connect');
      expect(bridgeState.identified).toBe(false);
      socket.emitted[0].ack({ ok: true });
      expect(bridgeState.identified).toBe(true);
      socket.connected = false;
      socket.fire('disconnect');
      expect(bridgeState.identified).toBe(false);
   });

   it('stays false and logs the sidecar message on a PROTOCOL_MISMATCH refusal with a reload hint', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      socket.emitted[0].ack({ ok: false, error: { code: PROTOCOL_MISMATCH, message: 'protocol 2 required' } });
      expect(bridgeState.identified).toBe(false);
      const logged = console.error.mock.calls.flat().join(' ');
      expect(logged).toContain(PROTOCOL_MISMATCH);
      expect(logged).toContain('protocol 2 required');
      expect(logged).toMatch(/reload Foundry/i);
   });

   it('stays false and logs the sidecar message on a NOT_GM refusal without the reload hint', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      socket.emitted[0].ack({ ok: false, error: { code: NOT_GM, message: 'Only a GM client may register.' } });
      expect(bridgeState.identified).toBe(false);
      const logged = console.error.mock.calls.flat().join(' ');
      expect(logged).toContain(NOT_GM);
      expect(logged).toContain('Only a GM client may register.');
      expect(logged).not.toMatch(/reload Foundry/i);
   });

   it('clears identified when a refusal follows an earlier ok ack', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      socket.emitted[0].ack({ ok: true });
      expect(bridgeState.identified).toBe(true);
      socket.fire('connect');
      socket.emitted[1].ack({ ok: false, error: { code: NOT_GM, message: 'no' } });
      expect(bridgeState.identified).toBe(false);
   });

   it('ignores an ok ack that arrives after the socket disconnected', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      socket.connected = false;
      socket.fire('disconnect');
      socket.emitted[0].ack({ ok: true });
      expect(bridgeState.identified).toBe(false);
   });
});

describe('bridge identify attempt token', () => {
   it('ignores the ok ack of attempt 1 once attempt 2 was emitted', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      socket.fire('connect');
      expect(socket.emitted).toHaveLength(2);
      socket.emitted[0].ack({ ok: true });
      expect(bridgeState.identified).toBe(false);
      socket.emitted[1].ack({ ok: true });
      expect(bridgeState.identified).toBe(true);
   });

   it('ignores the refusal of attempt 1 once attempt 2 was emitted', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      socket.emitted[0].ack({ ok: true });
      socket.fire('connect');
      socket.emitted[1].ack({ ok: true });
      socket.emitted[0].ack({ ok: false, error: { code: NOT_GM, message: 'late' } });
      expect(bridgeState.identified).toBe(true);
      expect(console.error).not.toHaveBeenCalled();
   });

   it('ignores an ok ack from before a disconnect and reconnect', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      socket.connected = false;
      socket.fire('disconnect');
      socket.connected = true;
      socket.fire('connect');
      socket.emitted[0].ack({ ok: true });
      expect(bridgeState.identified).toBe(false);
   });
});

describe('bridge re-identify on endpointKind change', () => {
   it('emits a fresh identify with the new kind when connected and the kind changed', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      socket.emitted[0].ack({ ok: true });
      kind = 'agent';
      reidentifyBridge();
      expect(socket.emitted).toHaveLength(2);
      expect(socket.emitted[1].event).toBe(BRIDGE_IDENTIFY);
      expect(socket.emitted[1].payload.kind).toBe('agent');
      expect(bridgeState.identified).toBe(false);
   });

   it('does not re-identify when the kind is unchanged', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      reidentifyBridge();
      expect(socket.emitted).toHaveLength(1);
   });

   it('does not re-identify while the socket is disconnected', () => {
      const socket = makeFakeSocket(false);
      wire(socket);
      kind = 'agent';
      reidentifyBridge();
      expect(socket.emitted).toHaveLength(0);
      socket.connected = true;
      socket.fire('connect');
      expect(socket.emitted[0].payload.kind).toBe('agent');
   });

   it('does nothing before the bridge is wired', async () => {
      // The statically imported module was wired by earlier tests; a fresh module instance has never been wired.
      vi.resetModules();
      const fresh = await import('~/bridge/foundryBridge.js');
      const readSetting = vi.spyOn(globalThis.game.settings, 'get');
      expect(() => fresh.reidentifyBridge()).not.toThrow();
      expect(readSetting).not.toHaveBeenCalled();
   });
});

describe('bridge invoke ack shape', () => {
   afterEach(() => {
      delete globalThis.CONST;
      delete globalThis.Actor;
   });

   it('acks an unknown op with OP_FAILED and a message', async () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      const ack = vi.fn();
      await socket.fire(BRIDGE_INVOKE, { op: 'nope', params: {}, requestId: 'r1' }, ack);
      expect(ack).toHaveBeenCalledWith({ ok: false, error: { code: OP_FAILED, message: "Unknown op 'nope'." } });
   });

   it.each(['constructor', 'toString', 'hasOwnProperty', '__proto__'])(
      'acks the inherited name %s as an unknown op',
      async (op) => {
         const socket = makeFakeSocket(true);
         wire(socket);
         const ack = vi.fn();
         await socket.fire(BRIDGE_INVOKE, { op, params: {}, requestId: 'r0' }, ack);
         expect(ack).toHaveBeenCalledWith({ ok: false, error: { code: OP_FAILED, message: `Unknown op '${op}'.` } });
      },
   );

   it('acks a throwing handler with OP_FAILED and the error message', async () => {
      globalThis.CONST = { BASE_DOCUMENT_TYPE: 'base' };
      globalThis.Actor = {
         create: async () => {
            throw new Error('permission denied');
         },
      };
      globalThis.game.documentTypes = { Actor: ['base', 'character'] };
      const socket = makeFakeSocket(true);
      wire(socket);
      const ack = vi.fn();
      await socket.fire(BRIDGE_INVOKE, { op: 'createActor', params: { name: 'X' }, requestId: 'r2' }, ack);
      expect(ack).toHaveBeenCalledWith({ ok: false, error: { code: OP_FAILED, message: 'permission denied' } });
   });

   it('acks success as { ok: true, result }', async () => {
      globalThis.CONST = { BASE_DOCUMENT_TYPE: 'base' };
      globalThis.Actor = {
         create: async (data) => ({ uuid: 'Actor.1', id: '1', name: data.name, type: data.type }),
      };
      globalThis.game.documentTypes = { Actor: ['base', 'character'] };
      const socket = makeFakeSocket(true);
      wire(socket);
      const ack = vi.fn();
      await socket.fire(BRIDGE_INVOKE, { op: 'createActor', params: { name: 'X' }, requestId: 'r3' }, ack);
      expect(ack).toHaveBeenCalledWith({
         ok: true,
         result: { uuid: 'Actor.1', id: '1', name: 'X', type: 'character' },
      });
   });
});

describe('bridge ping', () => {
   it('acks { ok: true } while not identified and emits nothing', async () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      bridgeState.identified = false;
      const emittedBefore = socket.emitted.length;
      const ack = vi.fn();
      await socket.fire(BRIDGE_PING, ack);
      expect(ack).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledWith({ ok: true });
      expect(socket.emitted).toHaveLength(emittedBefore);
      expect(bridgeState.identified).toBe(false);
   });

   it('acks { ok: true } while identified without changing state', async () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      bridgeState.identified = true;
      const ack = vi.fn();
      await socket.fire(BRIDGE_PING, ack);
      expect(ack).toHaveBeenCalledWith({ ok: true });
      expect(bridgeState.identified).toBe(true);
   });

   it('tolerates an absent or non-function ack', async () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      await expect(socket.fire(BRIDGE_PING)).resolves.toBeDefined();
      await expect(socket.fire(BRIDGE_PING, 'not a function')).resolves.toBeDefined();
      await expect(socket.fire(BRIDGE_PING, { ok: true })).resolves.toBeDefined();
   });
});
