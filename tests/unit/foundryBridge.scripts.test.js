import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initFoundryBridge, bridgeState } from '~/bridge/foundryBridge.js';
import {
   BRIDGE_IDENTIFY,
   BRIDGE_INVOKE,
   BRIDGE_REGISTRY,
   GATE_DENIED,
   NOT_GM,
   OP_CALL_TOOL,
   OP_FAILED,
   TOOL_GONE,
} from '$shared/protocol.js';
import { SCRIPT_API_VERSION, parseRegistryPayload } from '$shared/scripts.js';
import { createScriptRegistry, ScriptError } from '~/bridge/scripts/registry.js';
import { script } from './scriptFixtures.js';

/**
 * Build a controllable fake Socket.IO socket that records emits and their ack callbacks.
 * @param {boolean} connected - Initial value of `socket.connected`.
 * @returns {object} The fake socket with `fire`, `emitted`, `registries` and `connected`.
 */
function makeFakeSocket(connected) {
   const handlers = {};
   const socket = {
      connected,
      emitted: [],
      get registries() {
         return socket.emitted.filter((entry) => entry.event === BRIDGE_REGISTRY);
      },
      on(event, fn) {
         (handlers[event] ??= []).push(fn);
      },
      emit(event, payload, ack) {
         socket.emitted.push({
            event,
            payload,
            ack,
         });
      },
      fire: (event, ...args) => Promise.all((handlers[event] ?? []).map((fn) => fn(...args))),
   };
   return socket;
}

/** @type {ReturnType<typeof createScriptRegistry>} The registry the bridge serves in a test. */
let registry;

/**
 * Wire the bridge onto a fake socket with the test registry.
 * @param {object} socket - The fake socket.
 * @returns {void}
 */
function wire(socket) {
   initFoundryBridge(
      { onSocket: (listener) => listener(socket) },
      { scripts: registry },
   );
}

/**
 * Answer the latest identify of a socket with an ok ack.
 * @param {object} socket - The fake socket.
 * @returns {void}
 */
function acceptIdentify(socket) {
   const identifies = socket.emitted.filter((entry) => entry.event === BRIDGE_IDENTIFY);
   identifies.at(-1).ack({ ok: true });
}

/** @type {Record<string, unknown>} The stored gate setting values the fake game returns. */
let stored;

beforeEach(() => {
   stored = {};
   bridgeState.identified = false;
   registry = createScriptRegistry({ log: () => {} });
   globalThis.game = {
      user: {
         id: 'u1',
         name: 'Gamemaster',
         isGM: true,
      },
      settings: {
         get: (module, key) => {
            if (key === 'endpointKind') {
               return 'human';
            }
            return Object.hasOwn(stored, key) ? stored[key] : key === 'allowedPluginModules' ? '' : false;
         },
      },
   };
   vi.spyOn(console, 'error').mockImplementation(() => {});
   vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
   delete globalThis.game;
   vi.restoreAllMocks();
});

describe('bridge:registry push', () => {
   it('sends the registry after an ok identify ack, as { apiVersion, scripts } with an ack callback', () => {
      registry.register(script('alpha'), async () => 'a');
      registry.register(script('beta', { mutates: true }), async () => 'b');
      const socket = makeFakeSocket(true);
      wire(socket);
      expect(socket.registries).toHaveLength(0);
      acceptIdentify(socket);
      expect(socket.registries).toHaveLength(1);
      const [sent] = socket.registries;
      expect(sent.payload).toEqual({
         apiVersion: SCRIPT_API_VERSION,
         scripts: [
            script('alpha'),
            script('beta', { mutates: true }),
         ],
      });
      expect(typeof sent.ack).toBe('function');
      expect(parseRegistryPayload(sent.payload).ok).toBe(true);
   });

   it('sends a payload with no handler or function on it', () => {
      registry.register(script('alpha'), async () => 'a');
      const socket = makeFakeSocket(true);
      wire(socket);
      acceptIdentify(socket);
      expect(JSON.parse(JSON.stringify(socket.registries[0].payload))).toEqual(socket.registries[0].payload);
   });

   it('sends an empty script list when nothing is registered', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      acceptIdentify(socket);
      expect(socket.registries[0].payload).toEqual({
         apiVersion: SCRIPT_API_VERSION,
         scripts: [],
      });
   });

   it('sends nothing before the identify is acked or when the identify is refused', () => {
      registry.register(script('alpha'), async () => 'a');
      const socket = makeFakeSocket(true);
      wire(socket);
      socket.emitted[0].ack({
         ok: false,
         error: {
            code: NOT_GM,
            message: 'no',
         },
      });
      expect(socket.registries).toHaveLength(0);
   });

   it('does not send for an identify ack of an earlier attempt', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      socket.fire('connect');
      socket.emitted[0].ack({ ok: true });
      expect(socket.registries).toHaveLength(0);
      socket.emitted[1].ack({ ok: true });
      expect(socket.registries).toHaveLength(1);
   });

   it('sends the full list again when a script registers while identified', async () => {
      registry.register(script('alpha'), async () => 'a');
      const socket = makeFakeSocket(true);
      wire(socket);
      acceptIdentify(socket);
      registry.register(script('beta'), async () => 'b');
      await Promise.resolve();
      expect(socket.registries).toHaveLength(2);
      expect(socket.registries[1].payload.scripts.map((definition) => definition.name)).toEqual([
         'alpha',
         'beta',
      ]);
   });

   it('sends one registry for the scripts registered in the same tick', async () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      acceptIdentify(socket);
      expect(socket.registries).toHaveLength(1);
      registry.register(script('alpha'), async () => 'a');
      registry.register(script('beta'), async () => 'b');
      registry.register(script('gamma'), async () => 'c');
      expect(socket.registries).toHaveLength(1);
      await Promise.resolve();
      expect(socket.registries).toHaveLength(2);
      expect(socket.registries[1].payload.scripts.map((definition) => definition.name)).toEqual([
         'alpha',
         'beta',
         'gamma',
      ]);
   });

   it('does not send a change before the identify ack, and the ack carries it', () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      registry.register(script('alpha'), async () => 'a');
      expect(socket.registries).toHaveLength(0);
      acceptIdentify(socket);
      expect(socket.registries).toHaveLength(1);
      expect(socket.registries[0].payload.scripts).toHaveLength(1);
   });

   it('does not send a change while the socket is disconnected', async () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      acceptIdentify(socket);
      socket.connected = false;
      socket.fire('disconnect');
      registry.register(script('alpha'), async () => 'a');
      await Promise.resolve();
      expect(socket.registries).toHaveLength(1);
   });

   it('does not emit while the socket reports itself disconnected, even before the disconnect event arrives', async () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      acceptIdentify(socket);
      socket.connected = false;
      registry.register(script('alpha'), async () => 'a');
      await Promise.resolve();
      expect(socket.registries).toHaveLength(1);
   });

   it('sends the registry again on reconnect once the new identify is acked', () => {
      registry.register(script('alpha'), async () => 'a');
      const socket = makeFakeSocket(true);
      wire(socket);
      acceptIdentify(socket);
      socket.connected = false;
      socket.fire('disconnect');
      socket.connected = true;
      socket.fire('connect');
      expect(socket.registries).toHaveLength(1);
      acceptIdentify(socket);
      expect(socket.registries).toHaveLength(2);
      expect(socket.registries[1].payload.scripts).toHaveLength(1);
   });

   it('does not send a refused registration', async () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      acceptIdentify(socket);
      registry.register(script('bad name'), async () => 'a');
      await Promise.resolve();
      expect(socket.registries).toHaveLength(1);
   });

   it('pushes a change once per wiring when the bridge is wired twice', async () => {
      const socket = makeFakeSocket(true);
      wire(socket);
      wire(socket);
      acceptIdentify(socket);
      const before = socket.registries.length;
      registry.register(script('alpha'), async () => 'a');
      await Promise.resolve();
      expect(socket.registries.length - before).toBe(1);
   });
});

describe('bridge:registry ack', () => {
   /**
    * Send the registry and answer it.
    * @param {object} answer - The sidecar's ack.
    * @returns {void}
    */
   function answerRegistry(answer) {
      registry.register(script('alpha'), async () => 'a');
      const socket = makeFakeSocket(true);
      wire(socket);
      acceptIdentify(socket);
      socket.registries[0].ack(answer);
   }

   it('stays quiet when every script was accepted', () => {
      answerRegistry({ ok: true, accepted: 1, refused: 0 });
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
   });

   it('logs the refused count when the sidecar refused entries', () => {
      answerRegistry({ ok: true, accepted: 0, refused: 1 });
      const logged = console.warn.mock.calls.flat().join(' ');
      expect(logged).toContain('refused 1');
      expect(logged).toContain('accepted 0');
   });

   it('logs the code and message of a failed registry', () => {
      answerRegistry({ ok: false, error: { code: OP_FAILED, message: 'apiVersion must be 1' } });
      const logged = console.error.mock.calls.flat().join(' ');
      expect(logged).toContain(OP_FAILED);
      expect(logged).toContain('apiVersion must be 1');
   });

   it('logs a registry refusal that carries no reason', () => {
      answerRegistry(undefined);
      expect(console.error.mock.calls.flat().join(' ')).toContain('UNKNOWN');
   });
});

describe('callTool op through the bridge', () => {
   /**
    * Invoke an op on a wired bridge.
    * @param {object} payload - The `{ op, params }` of the invocation.
    * @returns {Promise<object>} The ack the client sent.
    */
   async function invoke(payload) {
      const socket = makeFakeSocket(true);
      wire(socket);
      const ack = vi.fn();
      await socket.fire(BRIDGE_INVOKE, { ...payload, requestId: 'r1' }, ack);
      expect(ack).toHaveBeenCalledTimes(1);
      return ack.mock.calls[0][0];
   }

   it('acks the result of a registered script', async () => {
      registry.register(script('echo'), async (args) => ({ echoed: args.text }));
      expect(await invoke({ op: OP_CALL_TOOL, params: { name: 'echo', arguments: { text: 'hi' } } })).toEqual({
         ok: true,
         result: { echoed: 'hi' },
      });
   });

   it('acks a gate denial with GATE_DENIED and the denial text, and never runs the handler', async () => {
      const handler = vi.fn(async () => 'ran');
      registry.register(script('macro', { gate: 'allowMacroExecution' }), handler);
      const ack = await invoke({ op: OP_CALL_TOOL, params: { name: 'macro', arguments: { text: 'x' } } });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe(GATE_DENIED);
      expect(ack.error.message).toMatch(/allowMacroExecution/);
      expect(handler).not.toHaveBeenCalled();
   });

   it('acks invalid arguments with ARGS_INVALID', async () => {
      registry.register(script('echo'), async () => 'ran');
      const ack = await invoke({ op: OP_CALL_TOOL, params: { name: 'echo', arguments: { text: 1 } } });
      expect(ack).toEqual({
         ok: false,
         error: {
            code: 'ARGS_INVALID',
            message: 'text: expected a string',
         },
      });
   });

   it('acks an unregistered name with TOOL_GONE', async () => {
      const ack = await invoke({ op: OP_CALL_TOOL, params: { name: 'missing', arguments: {} } });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe(TOOL_GONE);
   });

   it('acks the code of a ScriptError and OP_FAILED for any other error', async () => {
      registry.register(script('coded'), async () => {
         throw new ScriptError('BAD_THING', 'a bad thing');
      });
      registry.register(script('plain'), async () => {
         const error = new Error('plain failure');
         error.code = 'ENOENT';
         throw error;
      });
      expect((await invoke({ op: OP_CALL_TOOL, params: { name: 'coded', arguments: { text: 'x' } } })).error).toEqual({
         code: 'BAD_THING',
         message: 'a bad thing',
      });
      expect((await invoke({ op: OP_CALL_TOOL, params: { name: 'plain', arguments: { text: 'x' } } })).error).toEqual({
         code: OP_FAILED,
         message: 'plain failure',
      });
   });

   it('bounds the error message to 256 bytes', async () => {
      registry.register(script('wordy'), async () => {
         throw new Error('é'.repeat(10_000));
      });
      const ack = await invoke({ op: OP_CALL_TOOL, params: { name: 'wordy', arguments: { text: 'x' } } });
      expect(new TextEncoder().encode(ack.error.message).length).toBeLessThanOrEqual(256);
      expect(ack.error.message.length).toBeGreaterThan(10);
   });

   it('acks a thrown non-error value with its text', async () => {
      registry.register(script('throws_text'), async () => {
         throw 'just text';
      });
      const ack = await invoke({ op: OP_CALL_TOOL, params: { name: 'throws_text', arguments: { text: 'x' } } });
      expect(ack.error).toEqual({
         code: OP_FAILED,
         message: 'just text',
      });
   });

   it('acks a throw whose text cannot be read', async () => {
      registry.register(script('hostile'), async () => {
         throw Object.create(null);
      });
      const ack = await invoke({ op: OP_CALL_TOOL, params: { name: 'hostile', arguments: { text: 'x' } } });
      expect(ack.ok).toBe(false);
      expect(ack.error.code).toBe(OP_FAILED);
      expect(typeof ack.error.message).toBe('string');
   });

   it('bounds the unknown-op message even for a hostile op name', async () => {
      const ack = await invoke({ op: `x${'y'.repeat(10_000)}`, params: {} });
      expect(new TextEncoder().encode(ack.error.message).length).toBeLessThanOrEqual(256);
   });
});
